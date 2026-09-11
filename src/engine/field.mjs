// Contest generator: builds one realistic opponent lineup per contest entry.
import { eligible } from "./formats.mjs";
import { lineupOK, assignSlots } from "./lineups.mjs";

const DEF = {
  conc: 1.25, minSal: 47500, rounds: 3, boost: 1.0,
  sizes: { 5: 0.40, 4: 0.35, 3: 0.25 },          // primary MLB stack size
  secSizes: { 0: 0.15, 1: 0.15, 2: 0.30, 3: 0.30, 4: 0.10 },  // secondary MLB stack size
  oppPitcherPenalty: 0.15, stackTeams: null, sample: 2500
};

export function genField(pool, n, opt, rng, log) {
  const o = Object.assign({}, DEF, opt || {});
  if (o.minSal >= pool.format.cap) o.minSal = pool.format.cap - 2000;
  return pool.format.sport === "mlb" ? genFieldMLB(pool, n, o, rng, log) : genFieldSlots(pool, n, o, rng, log);
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
  const t = new Float64Array(np), w = new Float64Array(np);
  for (let i = 0; i < np; i++) { t[i] = Math.max(0, P[i].own) / 100; w[i] = Math.pow(Math.max(t[i], 0.0005), o.conc); }
  const hitters = P.filter(p => !p.isP && p.own > 0);
  const pitchers = P.filter(p => p.isP && p.own > 0);
  const byTeam = {};
  for (const p of hitters) (byTeam[p.team] = byTeam[p.team] || []).push(p);
  for (const tm in byTeam) byTeam[tm].sort((a, b) => (a.ord || 99) - (b.ord || 99));
  // Primary-stack team shares: given, or from hitter ownership mass.
  let share = {};
  if (o.stackTeams) share = Object.assign({}, o.stackTeams);
  else for (const tm in byTeam) share[tm] = Math.pow(byTeam[tm].reduce((s, p) => s + p.own, 0), 1.5);
  const minHit = Math.min(...hitters.map(p => p.sal)), minPit = Math.min(...pitchers.map(p => p.sal));
  const cum = new Float64Array(np), pick = new Int32Array(np);

  function pickTeam(exclude) {
    const ks = Object.keys(share).filter(k => k !== exclude && byTeam[k]); let tot = 0;
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
  function draw(count, cnt) {
    const out = []; let tries = 0; const max = count * 60;
    while (out.length < count && tries < max) {
      tries++;
      const used = new Uint8Array(np), tc = {}, ids = [];
      let sal = 0;
      const T1 = pickTeam(null), s1 = Math.min(pickFrom(o.sizes, rng, 5), byTeam[T1].length);
      for (const p of pickWindow(byTeam[T1], s1)) { used[p.i] = 1; ids.push(p.i); sal += p.sal; }
      tc[T1] = s1;
      let s2 = pickFrom(o.secSizes, rng, Math.min(4, 8 - s1)), T2 = null;
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
      out.push(lu); for (const id of lu) cnt[id]++;
    }
    return out;
  }
  const lines = [];
  for (let r = 0; r < o.rounds; r++) {
    const cnt = new Float64Array(np), m = Math.min(n, o.sample), got = draw(m, cnt);
    if (!got.length) break;
    lines.push(`round ${r + 1}: ${got.length} trial lineups, mean ownership gap ${gap(t, cnt, got.length, np).toFixed(2)} pts`);
    calibrate(w, t, cnt, got.length, np);
  }
  const cnt = new Float64Array(np), field = draw(n, cnt);
  lines.push(`final: ${field.length} entries, mean ownership gap ${gap(t, cnt, field.length || 1, np).toFixed(2)} pts`);
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
function genFieldSlots(pool, n, o, rng, log) {
  const P = pool.players, f = pool.format, np = P.length, ns = f.slots.length, teams = pool.teams;
  const el = [], cheap = [];
  for (let s = 0; s < ns; s++) {
    const list = []; let mn = Infinity;
    for (let i = 0; i < np; i++) { if (!eligible(P[i], f.slots[s], f)) continue; list.push(i); const c = (f.mult && s === 0) ? P[i].csal : P[i].sal; if (c < mn) mn = c; }
    el.push(list); cheap.push(mn === Infinity ? 0 : mn);
  }
  const suf = new Float64Array(ns + 1); for (let s = ns - 1; s >= 0; s--) suf[s] = suf[s + 1] + cheap[s];
  const tC = new Float64Array(np), tF = new Float64Array(np), wC = new Float64Array(np), wF = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    tC[i] = f.mult ? Math.max(0, P[i].cown) / 100 : 0;
    tF[i] = Math.max(0, f.mult ? P[i].fown : P[i].own) / 100;
    wC[i] = Math.pow(Math.max(tC[i], 0.0005), o.conc); wF[i] = Math.pow(Math.max(tF[i], 0.0005), o.conc);
  }
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
