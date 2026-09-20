// Contest generator: builds one realistic opponent lineup per contest entry.
import { eligible } from "./formats.mjs";
import { lineupOK, assignSlots, sigOf } from "./lineups.mjs";

// conc 1.0 and dupeCap on (2026-09-16, bench/grade-all.mjs --genfield over 155 pulled $50+ contests):
// real entries simmed against the generated field rank actual results better at conc 1.0 than at
// 1.25 (lineup Spearman 0.125 -> 0.151 on $200+, top-10% realized +4% -> +20%; 1.6 worse, 0.8 no
// better), and a field built on realized ownership ranks worse still - the sim's edge needs a
// projection-based field, not a chalkier one. The quota brings duplicates to the real 1-3%.
const DEF = {
  conc: 1.0, minSal: 49000, rounds: 3, boost: 1.0,
  sizes: { 5: 0.60, 4: 0.32, 3: 0.08 },          // primary MLB stack size (fitted to real high-dollar fields)
  secSizes: { 0: 0.05, 1: 0.20, 2: 0.40, 3: 0.30, 4: 0.05 },  // secondary MLB stack size
  oppPitcherPenalty: 0.15, stackTeams: null, sample: 2500,
  dupeCap: true    // MLB: hold exact-copy lineups to the real field's duplicate share (dupeTarget)
};
// How tough the opponents are depends on what the contest costs. Measured on 200 pulled college
// contests (bench/field-strength.mjs): against one fixed generator the real field runs 2.6 projected
// points WEAKER than it under $10 and 2.5 points STRONGER at $50, while its summed ownership swings
// from 12 points under to 18 points over. Cheap fields are soft and scattered, expensive fields are
// strong and chalky, and it stops moving above about $50 - a $1,000 college contest is no tougher
// than a $50 one. The two ends are fitted, the middle is interpolated on log price.
// Strength is the only field property that has ever improved how the sim PRICES a lineup. Matching
// the real field's ownership, its duplicate share and its stack shapes each failed.
const FEE_LO = 5, FEE_HI = 50, SIZE_LO = 200, SIZE_HI = 3000, SIZE_ADJ = 0;
export function fieldProfile(fee, fkey, fieldN) {
  if (fkey !== "cfb_cl") return null;   // measured for college only; other sports keep their defaults
  const f = Math.max(0.25, +fee || FEE_LO);
  const t = Math.max(0, Math.min(1, (Math.log10(f) - Math.log10(FEE_LO)) / (Math.log10(FEE_HI) - Math.log10(FEE_LO))));
  // skill: [share, candidate lineups considered]. A few heavy optimizers plus a larger semi-serious
  // class matches both the field's average strength and the top of it; sharpening everyone equally
  // matches the average and flattens the top, which is the half that wins tournaments.
  //
  // Field size looked like an obvious second axis and is not one. With the price curve applied the
  // real field still runs 0.75 projected points STRONGER than ours under 300 entries and 1.17 WEAKER
  // above 1500, summed ownership swinging 12 points across the same range, cleanly monotonic
  // (bench/field-strength.mjs --bysize over 200 contests). Correcting it made pricing worse:
  // per-contest error 11.1 -> 12.3 and the level -0.1% -> -0.9%. Most likely the sim already feels
  // field size directly - it scores a field of exactly N entries against a payout curve that scales
  // with N - so adjusting opponent strength by N again double counts it.
  // SIZE_ADJ is the strength of the correction and is 0 on purpose; raise it to regrade on new data.
  const N = +fieldN > 1 ? +fieldN : 0;
  const u = N ? Math.max(0, Math.min(1, (Math.log10(N) - Math.log10(SIZE_LO)) / (Math.log10(SIZE_HI) - Math.log10(SIZE_LO)))) : 0.5;
  const g = SIZE_ADJ * 2 * (0.5 - u);   // +1 for a small field, -1 for a large one, before damping
  const sc = Math.max(0, 1 + 0.45 * g);
  const skill = t > 0.02 ? [[0.05 * t * sc, 40], [0.25 * t * sc, 3]] : null;
  return { conc: 0.95 + 0.15 * t + 0.06 * g, minSal: Math.round(49000 + 350 * t + 60 * g), skill };
}

// Share of entries that duplicate another entry in real DK fields, by field size. MLB from 217
// pulled contests (2026-09-16: 2.1% under 300 entries, 1.3% at 300-1.5K, 3.1% at 1.5K-10K), where
// the generator left alone runs 2.5-4.5x that and the quota pulls it back down.
// College is a different world: 280 pulled contests (2026-09-19) duplicate at 12.4% / 15.6% / 27.3%,
// several times the baseball rate, because a college slate has far fewer lineups worth building.
// The baseball quota applied to college was cutting duplicates to a third of the real share.
const DUPE = { cfb: [0.124, 0.156, 0.273] };
export function dupeTarget(n, sport, floorOnly) {
  const d = DUPE[sport]; if (d) return n < 300 ? d[0] : n < 1500 ? d[1] : d[2];
  return floorOnly ? 0 : n < 300 ? 0.021 : n < 1500 ? 0.013 : 0.031;
}

// Projected ownership under-calls chalk in real fields: on the 2026-09-11 Mega 8s, players
// projected 15-30% came in at 25% and those above 30% at 48%, while everyone under 15% landed
// on projection. Raising ownership to the power conc and rescaling each position group back
// to its roster mass reproduces that; the calibration rounds then aim at these targets.
function concTargets(P, conc, key, val) {
  const t = new Float64Array(P.length), raw = {}, mass = {};
  for (let i = 0; i < P.length; i++) { const g = key(P[i]), o = Math.max(0, val(P[i])) / 100; raw[g] = (raw[g] || 0) + o; t[i] = Math.pow(o, conc); mass[g] = (mass[g] || 0) + t[i]; }
  for (let i = 0; i < P.length; i++) { const g = key(P[i]); t[i] = mass[g] > 0 ? t[i] * raw[g] / mass[g] : 0; }
  return t;
}

export function genField(pool, n, opt, rng, log) {
  const o = Object.assign({}, DEF, opt || {});
  if (o.minSal >= pool.format.cap) o.minSal = pool.format.cap - 2000;
  if (pool.format.sport === "mlb") return genFieldMLB(pool, n, o, rng, log);
  if (pool.format.key === "nfl_cl" || pool.format.key === "cfb_cl") return genFieldNFL(pool, n, o, rng, log);
  return genFieldSlots(pool, n, o, rng, log);
}

/* ---------- NFL classic: QB-stack driven (QB+1 / QB+2 / QB+3, optional bring-back) ---------- */
function genFieldNFL(pool, n, o, rng, log) {
  const P = pool.players, f = pool.format, np = P.length, teams = pool.teams;
  const cfb = f.key === "cfb_cl";
  // stack shares: NFL defaults, or the CFB mix measured on 74 pulled DK fields (bench, 2026-09-18)
  // College stack shapes depend on how many games are on the slate: with two games everyone stacks
  // deep and brings back, with twelve most lineups are QB+1. Measured on 233k entries in 277 pulled
  // contests (bench, 2026-09-19). NFL classic keeps its single set.
  const ng = pool.games.length;
  // sec: the SECOND team block, off unless o.secStack asks for it. Real college lineups nearly always
  // carry one and the generator has no mechanism for it - it builds the quarterback stack and then
  // fills every other slot independently, which is why the pooled field check under-builds 4-3-1 by 8
  // points and 3-3-1-1 by 5 and over-builds scattered shapes by the same. Shares measured from 233k
  // real entries (bench/stack-second.mjs). Building the block closes most of that gap: stack shape
  // distance 0.220 -> 0.172, and duplicates rise on their own from 5.2% to 6.2% against a real 16.7%,
  // which is the right way to get them. It still does not ship. Graded on 280 contests against a
  // generated field it left rank correlation unmoved (0.251 -> 0.251, 0.444 -> 0.445) and pulled
  // top-decile realized ROI 30% -> 25%, negative in both window halves.
  // That is the third time a measurably more realistic field has failed to price lineups better,
  // after building the field on realized ownership and after forcing the real duplicate share. The
  // shape of the opponent field is evidently not what the sim's edge rests on. Reachable with --sec.
  const cfbSt = ng <= 2 ? { 1: 7, 2: 50, 3: 43, bring: 85, twoQB: 90, sec: { 1: 1, 2: 54, 3: 45 } }
    : ng <= 5 ? { 1: 23, 2: 54, 3: 20, bring: 59, twoQB: 89, sec: { 1: 9, 2: 72, 3: 19 } }
    : ng <= 9 ? { 1: 45, 2: 41, 3: 7, bring: 45, twoQB: 86, sec: { 1: 23, 2: 69, 3: 8 } }
    : { 1: 51, 2: 31, 3: 3, bring: 42, twoQB: 91, sec: { 1: 38, 2: 58, 3: 4 } };
  const st = Object.assign(cfb ? cfbSt : { 1: 45, 2: 25, 3: 5, bring: 25 }, o.nflStacks || {});
  const t = concTargets(P, o.conc, p => f.sport === "mlb" ? (p.isP ? "P" : "H") : p.pos, p => p.own), w = new Float64Array(np);
  for (let i = 0; i < np; i++) w[i] = Math.max(t[i], 0.0005);
  const qbs = P.filter(p => p.pos === "QB" && p.own > 0), byTeamPass = {}, byTeamAll = {};
  for (const p of P) { if (p.own <= 0 || p.isP) continue; if (p.pos === "WR" || p.pos === "TE" || p.pos === "RB") { (byTeamAll[p.team] = byTeamAll[p.team] || []).push(p); if (p.pos !== "RB") (byTeamPass[p.team] = byTeamPass[p.team] || []).push(p); } }
  const twoQbP = cfb ? Math.max(0, Math.min(100, st.twoQB)) / 100 : 0;
  const kTot = Math.max(0, st[1]) + Math.max(0, st[2]) + Math.max(0, st[3]);
  const wantK = { 0: Math.max(0, 100 - kTot), 1: st[1], 2: st[2], 3: st[3] }, kDist = Object.assign({}, wantK);
  let bringP = Math.max(0, Math.min(100, st.bring)) / 100; const wantBring = bringP;
  const need = cfb ? { QB: 1, RB: 2, WR: 3, FLEX: 1, SFLEX: 1 } : { QB: 1, RB: 2, WR: 3, TE: 1, DST: 1, FLEX: 1 };
  const cum = new Float64Array(np), pick = new Int32Array(np);
  const minCost = pos => { let m = Infinity; for (const p of P) if (p.own >= 0 && eligible(p, pos, f) && p.sal < m) m = p.sal; return m === Infinity ? 0 : m; };
  const minBy = Object.fromEntries(Object.keys(need).map(k => [k, minCost(k)]));
  const struct = { k: {}, bring: 0, n: 0 };
  function pickWeighted(list, used, mul) {
    let tot = 0, m = 0; for (const p of list) { if (used[p.i]) continue; const ww = w[p.i] * (mul ? mul(p) : 1); if (ww <= 0) continue; tot += ww; cum[m] = tot; pick[m] = p.i; m++; }
    return m ? pick[rng.pickCum(cum, m)] : -1;
  }
  // o.best with o.sharpFrac: a real field is a mixture, not one kind of entrant. Most entries are
  // casual, a minority come off optimizers, and that mixture is what gives the real field a fatter
  // right tail than ours - at matched player exposures its 99th percentile lineup projects 2.5
  // points higher than ours. o.sharpFrac of the entries keep the strongest of o.best candidates by
  // projected points; the rest are drawn as before. Applying it to every entry instead raises the
  // mean but flattens the tail, which is the wrong shape.
  // o.skill: how many candidate lineups each entrant considers, as [share, candidates] pairs, with
  // everyone else taking the first lineup they build. A real field holds three kinds of entrant, not
  // two, and the shape matters: sharpening every entry a little matches the field's average strength
  // but flattens its top, and the top is who wins. A small class of heavy optimizers alongside a
  // larger semi-serious class matches both, for a quarter of the cost of sharpening half the field.
  const skill = o.skill || (o.best > 1 ? [[o.sharpFrac == null ? 1 : o.sharpFrac, Math.round(o.best)]] : null);
  const pickSkill = () => { if (!skill) return 1; let u = rng();
    for (const [p, m] of skill) { if (u < p) return Math.max(1, Math.round(m)); u -= p; }
    return 1; };
  const anySkill = !!(skill && skill.some(s => s[1] > 1));
  function draw(count, cnt) {
    const out = []; let tries = 0; const max = count * 60 * (skill ? Math.max(...skill.map(s => s[1])) : 1);
    let hold = null, heldTries = 0, curM = 1;
    struct.k = {}; struct.bring = 0; struct.n = 0;
    while (out.length < count && tries < max) {
      tries++;
      const used = new Uint8Array(np), ids = [], left = Object.assign({}, need); let sal = 0;
      const k = pickFrom(kDist, rng, 3);
      const qb = pickWeighted(qbs, used); if (qb < 0) continue;
      used[qb] = 1; ids.push(qb); sal += P[qb].sal; left.QB = 0;
      const team = P[qb].team, opp = P[qb].opp; let bring = false;
      const take = p => { used[p.i] = 1; ids.push(p.i); sal += p.sal; const slot = left[p.pos] > 0 ? p.pos : (left.FLEX > 0 && eligible(p, "FLEX", f)) ? "FLEX" : "SFLEX"; if (left[slot] > 0) left[slot]--; };
      // CFB superflex: most real lineups carry a second quarterback
      if (cfb && rng() < twoQbP) { const q2 = pickWeighted(qbs, used, p => p.team === team ? 0 : 1); if (q2 >= 0) { used[q2] = 1; ids.push(q2); sal += P[q2].sal; left.SFLEX--; } }
      for (let j = 0; j < k; j++) { const id = pickWeighted(byTeamAll[team] || [], used, p => p.pos === "RB" ? 0.35 : 1); if (id < 0) break; take(P[id]); }
      if (k > 0 && rng() < bringP && byTeamAll[opp]) { const id = pickWeighted(byTeamAll[opp], used, p => p.pos === "RB" ? 0.4 : 1); if (id >= 0) { take(P[id]); bring = true; } }
      // second team block: extend the bring-back when there is one, otherwise open a block on
      // another team, chosen by how much projected ownership is sitting on it
      const slotsLeft = () => left.QB + left.RB + left.WR + (left.TE || 0) + (left.DST || 0) + left.FLEX + (left.SFLEX || 0);
      if (cfb && o.secStack && st.sec && slotsLeft() > 1) {
        const want = pickFrom(st.sec, rng, 3);
        let sTeam = bring ? opp : null, have = bring ? 1 : 0;
        if (!sTeam) {
          let tot = 0, m = 0;
          for (const tm of teams) {
            if (tm === team || !(byTeamAll[tm] || []).length) continue;
            let ww = 0; for (const p of byTeamAll[tm]) if (!used[p.i]) ww += Math.max(0, p.own);
            if (ww <= 0) continue; tot += ww; cum[m] = tot; pick[m] = teams.indexOf(tm); m++;
          }
          if (m) sTeam = teams[pick[rng.pickCum(cum, m)]];
        }
        if (sTeam) for (let j = have; j < want && slotsLeft() > 1; j++) {
          const id = pickWeighted(byTeamAll[sTeam] || [], used, p => p.pos === "RB" ? 0.5 : 1);
          if (id < 0) break; take(P[id]);
        }
      }
      // fill the rest slot by slot under the salary window
      let ok = true; const order = cfb ? ["RB", "WR", "FLEX", "SFLEX"] : ["RB", "WR", "TE", "DST", "FLEX"];
      let remaining = order.reduce((s, x) => s + left[x] * minBy[x], 0);
      for (const slot of order) {
        while (left[slot] > 0) {
          remaining -= minBy[slot];
          const hiB = f.cap - sal - remaining, isLast = remaining <= 0, loB = isLast ? o.minSal - sal : -Infinity;
          const id = pickWeighted(P, used, p => { if (p.own <= 0 && !(p.sal <= loB)) return 0; const okPos = eligible(p, slot, f); if (!okPos || p.sal > hiB || p.sal < loB) return 0; if (cfb && slot === "SFLEX" && p.pos === "QB") return 0.6; if (p.pos === "DST" && (p.team === opp || p.opp === team)) return 0.4; return 1; });
          if (id < 0) { ok = false; break; }
          used[id] = 1; ids.push(id); sal += P[id].sal; left[slot]--;
        }
        if (!ok) break;
      }
      if (!ok || ids.length !== f.slots.length || sal > f.cap || sal < o.minSal) continue;
      const lu = assignSlots(ids, P, f); if (!lu) continue;
      if (!lineupOK(lu, P, f, teams)) continue;
      if (anySkill) {
        if (!hold && heldTries === 0) curM = pickSkill();
        if (curM > 1) {
          const pv = lu.reduce((s, id) => s + (P[id].proj || 0), 0);
          if (!hold || pv > hold.pv) hold = { lu, pv };
          if (++heldTries < curM) continue;
          const win = hold; hold = null; heldTries = 0;
          out.push(win.lu); for (const id of win.lu) cnt[id]++;
          continue;
        }
        heldTries = 0;
      }
      out.push(lu); for (const id of lu) cnt[id]++;
      // record what actually landed, since the fill stage can add teammates on its own
      let kObs = 0, bObs = false;
      for (const id of lu) { const p = P[id]; if (id === qb || p.pos === "DST" || p.pos === "K") continue; if (p.team === team) kObs++; else if (p.team === opp) bObs = true; }
      kObs = Math.min(3, kObs);
      struct.k[kObs] = (struct.k[kObs] || 0) + 1; if (kObs && bObs) struct.bring++; struct.n++;
    }
    return out;
  }
  function calibrateStructure() {
    const n0 = struct.n || 1, wsum = Object.values(wantK).reduce((s, x) => s + Math.max(0, x), 0) || 1;
    for (const k in kDist) { const want = Math.max(0, wantK[k]) / wsum, got = (struct.k[k] || 0) / n0; kDist[k] *= Math.max(0.5, Math.min(2, Math.pow((want + 0.01) / (got + 0.01), 0.8))); }
    const stacked = n0 - (struct.k[0] || 0); if (stacked > 0) { const got = struct.bring / stacked; bringP = Math.max(0, Math.min(1, bringP * Math.max(0.5, Math.min(2, Math.pow((wantBring + 0.01) / (got + 0.01), 0.8))))); }
  }
  const lines = [];
  for (let r = 0; r < o.rounds; r++) {
    const cnt = new Float64Array(np), m = Math.min(n, o.sample), got = draw(m, cnt);
    if (!got.length) break;
    lines.push(`round ${r + 1}: ${got.length} trial lineups, mean ownership gap ${gap(t, cnt, got.length, np).toFixed(2)} pts`);
    calibrate(w, t, cnt, got.length, np); calibrateStructure();
  }
  const cnt = new Float64Array(np), field = draw(n, cnt);
  // A real field has every entry filled. If the salary window rejects too much (small slate,
  // stack-heavy mix), relax the floor in steps and top the field up rather than come up short.
  for (let relax = 0; field.length < n && relax < 4 && o.minSal > 40000; relax++) {
    o.minSal -= 500; const more = draw(n - field.length, cnt); for (const lu of more) field.push(lu);
    lines.push(`salary floor relaxed to ${o.minSal}: +${more.length} entries`);
  }
  const share = typeof o.dupeFloor === "number" ? o.dupeFloor : o.dupeFloor === true ? dupeTarget(field.length, f.sport, true) : 0;
  const made = share ? addDuplicates(field, P, f, rng, share, cnt, cnt) : 0;
  lines.push(`final: ${field.length} entries, mean ownership gap ${gap(t, cnt, field.length || 1, np).toFixed(2)} pts${made ? `, ${made} duplicates added to reach ${(100 * share).toFixed(1)}%` : ""}`);
  if (log) lines.forEach(log);
  return { field, expo: cnt, cC: new Float64Array(np), cF: cnt, log: lines };
}

function pickFrom(dist, rng, cap) {
  const ks = Object.keys(dist).map(Number).filter(k => cap == null || k <= cap);
  let tot = 0; for (const k of ks) tot += dist[k];
  if (!tot) return ks.length ? Math.min(...ks) : 0;
  let t = rng() * tot;
  for (const k of ks) { t -= dist[k]; if (t <= 0) return k; }
  return ks[ks.length - 1];
}

function calibrate(w, t, cnt, made, np, mult) {
  for (let i = 0; i < np; i++) {
    const a = cnt[i] / made, g = Math.pow((t[i] + 0.003) / (a + 0.003), 0.7);
    w[i] *= Math.max(0.4, Math.min(2.5, g));
  }
}
function gap(t, cnt, made, np) {
  let s = 0, k = 0;
  for (let i = 0; i < np; i++) { if (t[i] <= 0 && cnt[i] === 0) continue; s += Math.abs(cnt[i] / made - t[i]) * 100; k++; }
  return k ? s / k : 0;
}

/* ---------- MLB classic: stack-driven ---------- */
function genFieldMLB(pool, n, o, rng, log) {
  const P = pool.players, f = pool.format, np = P.length, teams = pool.teams;
  const t = concTargets(P, o.conc, p => f.sport === "mlb" ? (p.isP ? "P" : "H") : p.pos, p => p.own), w = new Float64Array(np);
  for (let i = 0; i < np; i++) w[i] = Math.max(t[i], 0.0005);
  const hitters = P.filter(p => !p.isP && p.own > 0);
  const pitchers = P.filter(p => p.isP && p.own > 0);
  const byTeam = {};
  for (const p of hitters) (byTeam[p.team] = byTeam[p.team] || []).push(p);
  // Batting order when the projections carry it; otherwise ownership stands in for it so
  // stack windows still group a team's most-played bats rather than whoever sits next in the file.
  for (const tm in byTeam) byTeam[tm].sort((a, b) => (a.ord || 99) - (b.ord || 99) || b.own - a.own);
  // Primary-stack team shares: given, or from hitter ownership mass.
  let share = {};
  if (o.stackTeams) share = Object.assign({}, o.stackTeams);
  else for (const tm in byTeam) share[tm] = Math.pow(byTeam[tm].reduce((s, p) => s + p.own, 0), 1.5);
  const minHit = Math.min(...hitters.map(p => p.sal)), minPit = Math.min(...pitchers.map(p => p.sal));
  const cum = new Float64Array(np), pick = new Int32Array(np);

  function pickTeam(exclude) {
    let ks = Object.keys(share).filter(k => k !== exclude && byTeam[k]);
    if (!ks.length) { ks = Object.keys(byTeam).filter(k => k !== exclude); ks.forEach(k => { if (share[k] == null) share[k] = byTeam[k].reduce((s, p) => s + p.own, 0) || 1; }); }
    let tot = 0;
    for (const k of ks) tot += share[k];
    let x = rng() * tot;
    for (const k of ks) { x -= share[k]; if (x <= 0) return k; }
    return ks[ks.length - 1];
  }
  function pickWindow(list, size) {
    const m = list.length; if (size >= m) return list.slice();
    let tot = 0; const ws = [];
    for (let k = 0; k < m; k++) { let s = 0; for (let j = 0; j < size; j++) s += w[list[(k + j) % m].i]; ws.push(s); tot += s; }
    let x = rng() * tot, k = 0;
    for (; k < m; k++) { x -= ws[k]; if (x <= 0) break; }
    if (k >= m) k = m - 1;
    const out = []; for (let j = 0; j < size; j++) out.push(list[(k + j) % m]);
    return out;
  }
  // structure targets (fraction of lineups by primary size, and secondary size given primary)
  const wantSizes = Object.assign({}, o.sizes), wantSec = {};
  for (const k in (o.secBy || {})) wantSec[k] = Object.assign({}, o.secBy[k]);
  let sizes = Object.assign({}, o.sizes), secBy = o.secBy ? JSON.parse(JSON.stringify(o.secBy)) : null;
  const struct = {};
  function draw(count, cnt, dd) {
    const out = []; let tries = 0; const max = count * 150;
    for (const k in struct) delete struct[k];
    while (out.length < count && tries < max) {
      tries++;
      const used = new Uint8Array(np), tc = {}, ids = [];
      let sal = 0;
      const T1 = pickTeam(null), s1 = Math.min(pickFrom(sizes, rng, 5), byTeam[T1].length);
      for (const p of pickWindow(byTeam[T1], s1)) { used[p.i] = 1; ids.push(p.i); sal += p.sal; }
      tc[T1] = s1;
      const secDist = (secBy && secBy[s1]) || o.secSizes;
      let s2 = pickFrom(secDist, rng, Math.min(4, 8 - s1)), T2 = null;
      if (s2 > 0) { T2 = pickTeam(T1); s2 = Math.min(s2, byTeam[T2].length); for (const p of pickWindow(byTeam[T2], s2)) { used[p.i] = 1; ids.push(p.i); sal += p.sal; } tc[T2] = s2; }
      const stacked = { [T1]: 1 }; if (T2) stacked[T2] = 1;
      // two pitchers, avoiding the ones facing our stacks
      for (let k = 0; k < 2; k++) {
        let tot = 0, m = 0;
        for (const p of pitchers) { if (used[p.i]) continue; let ww = w[p.i]; if (stacked[p.opp]) ww *= o.oppPitcherPenalty; if (ww <= 0) continue; tot += ww; cum[m] = tot; pick[m] = p.i; m++; }
        if (!m) { ids.length = 0; break; }
        const id = pick[rng.pickCum(cum, m)]; used[id] = 1; ids.push(id); sal += P[id].sal;
      }
      if (ids.length < s1 + s2 + 2) continue;
      const pitchOpp = {}; for (const id of ids) if (P[id].isP && P[id].opp) pitchOpp[P[id].opp] = 1;
      // fill the remaining hitter slots under the salary window
      let left = 8 - s1 - s2, ok = true;
      while (left > 0) {
        const hiB = f.cap - sal - (left - 1) * minHit, loB = left === 1 ? o.minSal - sal : -Infinity;
        let tot = 0, m = 0;
        for (const p of hitters) {
          if (used[p.i] || (tc[p.team] || 0) >= f.maxHitPerTeam) continue;
          if (p.sal > hiB || p.sal < loB) continue;
          let ww = w[p.i]; if (pitchOpp[p.team]) ww *= o.oppPitcherPenalty;
          if (ww <= 0) continue; tot += ww; cum[m] = tot; pick[m] = p.i; m++;
        }
        if (!m) { ok = false; break; }
        const id = pick[rng.pickCum(cum, m)]; used[id] = 1; ids.push(id); sal += P[id].sal; tc[P[id].team] = (tc[P[id].team] || 0) + 1; left--;
      }
      if (!ok || sal > f.cap || sal < o.minSal) continue;
      const lu = assignSlots(ids, P, f); if (!lu) continue;
      if (!lineupOK(lu, P, f, teams)) continue;
      // duplicate quota (final draws only): a copy beyond the real share is thrown back
      if (dd) { const sg = sigOf(lu, f); if (dd.sigs.has(sg)) { if (dd.dupes >= dd.allow) continue; dd.dupes++; } else dd.sigs.add(sg); }
      out.push(lu); for (const id of lu) cnt[id]++;
      const sk = s1 + "|" + (T2 ? s2 : 0); struct[sk] = (struct[sk] || 0) + 1;
    }
    return out;
  }
  // nudge structure weights so the built field matches the requested stack mix despite salary rejections
  function calibrateStructure(made) {
    const norm = d => { let s = 0; for (const k in d) s += Math.max(0, d[k]); return s || 1; };
    const ws = norm(wantSizes), got1 = {};
    for (const k in struct) { const s1 = k.split("|")[0]; got1[s1] = (got1[s1] || 0) + struct[k]; }
    for (const s1 in sizes) { const want = wantSizes[s1] / ws, got = (got1[s1] || 0) / made; sizes[s1] *= Math.max(0.5, Math.min(2, Math.pow((want + 0.01) / (got + 0.01), 0.8))); }
    if (!secBy) return;
    for (const s1 in secBy) { const w2 = norm(wantSec[s1] || {}), tot = got1[s1] || 0; if (!tot) continue;
      for (const s2 in secBy[s1]) { const want = (wantSec[s1][s2] || 0) / w2, got = (struct[s1 + "|" + (s2 === "0" ? 0 : s2)] || 0) / tot; secBy[s1][s2] *= Math.max(0.5, Math.min(2, Math.pow((want + 0.01) / (got + 0.01), 0.8))); } }
  }
  const lines = [];
  for (let r = 0; r < o.rounds; r++) {
    const cnt = new Float64Array(np), m = Math.min(n, o.sample), got = draw(m, cnt);
    if (!got.length) break;
    lines.push(`round ${r + 1}: ${got.length} trial lineups, mean ownership gap ${gap(t, cnt, got.length, np).toFixed(2)} pts`);
    calibrate(w, t, cnt, got.length, np); calibrateStructure(got.length);
  }
  const dd = o.dupeCap ? { sigs: new Set(), dupes: 0, allow: Math.round(n * (typeof o.dupeCap === "number" ? o.dupeCap : dupeTarget(n, pool.format.sport))) } : null;
  const cnt = new Float64Array(np), field = draw(n, cnt, dd);
  // A real field has every entry filled. If the salary window rejects too much (small slate,
  // stack-heavy mix), relax the floor in steps and top the field up rather than come up short.
  for (let relax = 0; field.length < n && relax < 4 && o.minSal > 40000; relax++) {
    o.minSal -= 500; const more = draw(n - field.length, cnt, dd); for (const lu of more) field.push(lu);
    lines.push(`salary floor relaxed to ${o.minSal}: +${more.length} entries`);
  }
  lines.push(`final: ${field.length} entries, mean ownership gap ${gap(t, cnt, field.length || 1, np).toFixed(2)} pts${dd ? `, ${dd.dupes} duplicate entries (quota ${dd.allow})` : ""}`);
  if (log) lines.forEach(log);
  return { field, expo: cnt, cC: new Float64Array(np), cF: cnt, log: lines };
}

/* ---------- NFL: slot-driven with stack pull ---------- */
function stackMul(p, st, boost, sport) {
  if (!boost) return 1;
  if (sport === "nfl") {
    if (p.pos === "QB") return st.pass[p.team] ? 1 + boost : (st.qb[p.opp] ? 1 + 0.4 * boost : 1);
    if (p.pos === "WR" || p.pos === "TE") return st.qb[p.team] ? 1 + boost : (st.qb[p.opp] ? 1 + 0.45 * boost : 1);
    if (p.pos === "RB") return st.qb[p.team] ? 1 + 0.2 * boost : 1;
    if (p.pos === "DST") return (st.qb[p.opp] || st.pass[p.opp]) ? Math.max(0.15, 1 - 0.6 * boost) : 1;
  }
  return 1;
}
// Real fields duplicate far more than a generator does, because the same few lineups occur to many
// people at once. The football path has no natural source of that, so copies are added on purpose:
// entries chosen at random are replaced by copies of existing lineups, with the chalkiest lineups
// most likely to be copied, until the duplicate share matches the real one for that field size.
// Off unless o.dupeFloor asks for it, because matching reality here made the sim worse. It closed
// the gap exactly as intended (college generated 5.2% -> 16.1% against a real 16.7%, every field
// size within 1.3 points, with stack shape, salary and exposure accuracy untouched), but graded on
// 280 CFB contests against a generated field it cost lineup rank correlation 0.251 -> 0.249 and
// player 0.444 -> 0.442, both significant and both halves, with realized money flat to slightly
// down. It is the same lesson as building the field on realized ownership: a field that copies
// reality more closely is not the same thing as a field that ranks lineups better. Reachable with
// --dupefloor for regrading on new data.
function addDuplicates(field, P, f, rng, share, cC, cF) {
  const n = field.length, want = Math.round(n * share);
  if (!(want > 0) || n < 4) return 0;
  const seen = new Set(); let have = 0;
  for (const lu of field) { const sg = sigOf(lu, f); if (seen.has(sg)) have++; else seen.add(sg); }
  let need = want - have; if (need <= 0) return 0;
  // chalk weight: a lineup's summed projected ownership, the same thing that makes people collide
  const own = field.map(lu => { let s = 0; for (let z = 0; z < lu.length; z++) { const p = P[lu[z]]; s += (f.mult && z === 0 ? (p.cown ?? p.own) : p.own) || 0; } return s; });
  const cum = new Float64Array(n); let tot = 0;
  for (let i = 0; i < n; i++) { tot += Math.pow(Math.max(0.01, own[i]), 3); cum[i] = tot; }
  const dec = (lu) => lu.forEach((id, z) => { if (f.mult && z === 0) cC[id]--; else cF[id]--; });
  const inc = (lu) => lu.forEach((id, z) => { if (f.mult && z === 0) cC[id]++; else cF[id]++; });
  let made = 0;
  for (let guard = 0; need > 0 && guard < n * 4; guard++) {
    const src = rng.pickCum(cum, n), dst = Math.floor(rng() * n);
    if (dst === src) continue;
    if (sigOf(field[dst], f) === sigOf(field[src], f)) continue;   // already a copy of the source
    dec(field[dst]); field[dst] = field[src].slice(); inc(field[dst]);
    need--; made++;
  }
  return made;
}

function genFieldSlots(pool, n, o, rng, log) {
  const P = pool.players, f = pool.format, np = P.length, ns = f.slots.length, teams = pool.teams;
  const el = [], cheap = [];
  for (let s = 0; s < ns; s++) {
    const list = []; let mn = Infinity;
    for (let i = 0; i < np; i++) { if (!eligible(P[i], f.slots[s], f)) continue; list.push(i); const c = (f.mult && s === 0) ? P[i].csal : P[i].sal; if (c < mn) mn = c; }
    el.push(list); cheap.push(mn === Infinity ? 0 : mn);
  }
  const suf = new Float64Array(ns + 1); for (let s = ns - 1; s >= 0; s--) suf[s] = suf[s + 1] + cheap[s];
  const tC = f.mult ? concTargets(P, o.conc, () => "CPT", p => p.cown) : new Float64Array(np);
  const tF = concTargets(P, o.conc, p => f.mult ? "FLEX" : p.pos, p => f.mult ? p.fown : p.own), wC = new Float64Array(np), wF = new Float64Array(np);
  for (let i = 0; i < np; i++) { wC[i] = Math.max(tC[i], 0.0005); wF[i] = Math.max(tF[i], 0.0005); }
  const cum = new Float64Array(np), pick = new Int32Array(np);
  function draw(count, cC, cF) {
    const out = []; let tries = 0; const max = count * 40;
    while (out.length < count && tries < max) {
      tries++;
      const used = new Uint8Array(np), tc = {}, lu = [], st = { qb: {}, pass: {} };
      let sal = 0, ok = true;
      for (let s = 0; s < ns; s++) {
        const isC = f.mult && s === 0, last = s === ns - 1;
        const hiB = f.cap - sal - suf[s + 1], loB = last ? o.minSal - sal : -Infinity;
        let tot = 0, m = 0;
        for (const id of el[s]) {
          if (used[id]) continue;
          const p = P[id], cost = isC ? p.csal : p.sal;
          if (cost > hiB || cost < loB) continue;
          if (f.maxHitPerTeam && !p.isP && (tc[p.team] || 0) >= f.maxHitPerTeam) continue;
          const ww = (isC ? wC[id] : wF[id]) * stackMul(p, st, o.boost, f.sport);
          if (ww <= 0) continue; tot += ww; cum[m] = tot; pick[m] = id; m++;
        }
        if (!m) { ok = false; break; }
        const ch = pick[rng.pickCum(cum, m)], cp = P[ch];
        used[ch] = 1; lu.push(ch); sal += isC ? cp.csal : cp.sal;
        if (cp.pos === "QB") st.qb[cp.team] = 1; if (cp.pos === "WR" || cp.pos === "TE") st.pass[cp.team] = 1;
        if (!cp.isP) tc[cp.team] = (tc[cp.team] || 0) + 1;
      }
      if (!ok || sal > f.cap || sal < o.minSal) continue;
      if (!lineupOK(lu, P, f, teams)) continue;
      out.push(lu);
      lu.forEach((id, z) => { if (f.mult && z === 0) cC[id]++; else cF[id]++; });
    }
    return out;
  }
  const lines = [];
  for (let r = 0; r < o.rounds; r++) {
    const cC = new Float64Array(np), cF = new Float64Array(np), m = Math.min(n, o.sample), got = draw(m, cC, cF);
    if (!got.length) break;
    lines.push(`round ${r + 1}: ${got.length} trial lineups, mean ownership gap ${(gap(tF, cF, got.length, np) + (f.mult ? gap(tC, cC, got.length, np) : 0)).toFixed(2)} pts`);
    calibrate(wF, tF, cF, got.length, np); if (f.mult) calibrate(wC, tC, cC, got.length, np);
  }
  const cC = new Float64Array(np), cF = new Float64Array(np), field = draw(n, cC, cF);
  const expo = new Float64Array(np); for (let i = 0; i < np; i++) expo[i] = cC[i] + cF[i];
  lines.push(`final: ${field.length} entries, mean ownership gap ${gap(tF, cF, field.length || 1, np).toFixed(2)} pts`);
  if (log) lines.forEach(log);
  return { field, expo, cC, cF, log: lines };
}
