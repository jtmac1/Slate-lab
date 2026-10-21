// Matchup study v2 (2026-10-15, after "are we sure there isn't anything there?"). Three separate questions, walk-forward
// week by week over 2023-2026 with no look-ahead anywhere:
//   Q1 real?   does a defense's matchup (built only from earlier weeks) predict a player's DK points vs HIS OWN prior baseline?
//   Q2 priced? (2025-26 contests) does Stokastic's projection already move with the matchup, and does the matchup still
//              predict actual minus projection?
//   Q3 field?  (2025-26 contests) is ownership pushed by matchups beyond what projection/salary explain, and do good-matchup
//              players show up in top-1% lineups more or less often than their ownership (lift)?
// Matchup = defense x position (QB, RB, WR, TE; WR also by role WR1/WR2/WR3), for total DK points and split into volume
// (opportunities: dropbacks / carries + targets) and efficiency (DK points per opportunity), each relative to what the players
// it faced normally did. Player baselines use only their previous games (this season weight 1, last season 0.25).
//   node bench/matchup-study2-nfl.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import { parseCSV } from "../src/engine/csv.mjs";
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const NV = "data/nflverse", YEARS = [2023, 2024, 2025, 2026], LAST = 0.25;
const readCSV = f => { const b = fs.readFileSync(f), [h, ...rows] = parseCSV((f.endsWith(".gz") ? zlib.gunzipSync(b) : b).toString("utf8")); return rows.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const DK = { LA: "LAR", STL: "LAR", SD: "LAC", OAK: "LV" }, dk = t => DK[t] || t, nrm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
const slope = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, d = 0; for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); d += (x[i] - mx) ** 2; } return n / d; };

// ---------- player-games with DK points, from play-by-play ----------
const pos = {}, idByName = {};
for (const y of YEARS) for (const r of readCSV(`${NV}/roster_${y}.csv`)) if (r.gsis_id) { pos[r.gsis_id] = r.position; idByName[`${y}|${dk(r.team)}|${nrm(r.full_name)}`] = r.gsis_id; idByName[`${y}|*|${nrm(r.full_name)}`] ||= r.gsis_id; }
const PG = {};   // `${y}|${game}|${id}` -> stat line
const gameInfo = {};
for (const y of YEARS) for (const r of readCSV(`${NV}/play_by_play_${y}.csv.gz`)) {
  if (r.season_type !== "REG" || !r.posteam) continue;
  const off = dk(r.posteam), def = dk(r.defteam), g = r.game_id; gameInfo[g] = { y, wk: +r.week };
  const S = id => PG[`${y}|${g}|${id}`] ||= { y, wk: +r.week, game: g, id, off, def, py: 0, ptd: 0, int: 0, ry: 0, rtd: 0, rec: 0, cy: 0, ctd: 0, fum: 0, db: 0, car: 0, tgt: 0 };
  if (r.play_type === "pass" && r.passer_player_id) { const s = S(r.passer_player_id); s.db++; s.py += +r.passing_yards || 0; if (r.pass_touchdown === "1") s.ptd++; if (r.interception === "1") s.int++; }
  if (r.play_type === "pass" && r.receiver_player_id && r.sack !== "1") { const s = S(r.receiver_player_id); s.tgt++; if (r.complete_pass === "1") { s.rec++; s.cy += +r.receiving_yards || 0; if (r.pass_touchdown === "1") s.ctd++; } }
  if ((r.play_type === "run" || r.qb_scramble === "1") && r.rusher_player_id && r.qb_kneel !== "1") { const s = S(r.rusher_player_id); s.car++; s.ry += +r.rushing_yards || 0; if (r.rush_touchdown === "1") s.rtd++; }
  if (r.fumble_lost === "1" && r.fumbled_1_player_id) S(r.fumbled_1_player_id).fum++;
}
const dkPts = s => 0.04 * s.py + 4 * s.ptd - s.int + (s.py >= 300 ? 3 : 0) + 0.1 * s.ry + 6 * s.rtd + (s.ry >= 100 ? 3 : 0) + s.rec + 0.1 * s.cy + 6 * s.ctd + (s.cy >= 100 ? 3 : 0) - s.fum;
const P = Object.values(PG).map(s => { const p = pos[s.id] || ""; const POS = p === "QB" ? "QB" : /RB|FB/.test(p) ? "RB" : p === "TE" ? "TE" : p === "WR" ? "WR" : null; return POS ? Object.assign(s, { POS, pts: dkPts(s), opp: POS === "QB" ? s.db + s.car : s.car + s.tgt }) : null; })
  .filter(s => s && (s.POS === "QB" ? s.db >= 15 : s.opp >= 2)).sort((a, b) => a.y - b.y || a.wk - b.wk);
console.error(`${P.length} player-games`);

// ---------- strict prior baselines and WR roles ----------
const hist = {};   // id -> list of earlier games
for (const s of P) {
  const H = hist[s.id] || [], w = h => h.y === s.y ? 1 : h.y === s.y - 1 ? LAST : 0;
  let W = 0, pts = 0, opp = 0; for (const h of H) { const k = w(h); W += k; pts += k * h.pts; opp += k * h.opp; }
  if (W >= 3) { s.base = pts / W; s.baseOpp = opp / W; }
  (hist[s.id] = H).push({ y: s.y, wk: s.wk, pts: s.pts, opp: s.opp, off: s.off });
}
{ const byTG = {}; for (const s of P) if (s.POS === "WR") (byTG[`${s.y}|${s.off}|${s.game}`] ||= []).push(s);
  for (const L of Object.values(byTG)) { L.sort((a, b) => (b.baseOpp || 0) - (a.baseOpp || 0)); L.forEach((s, i) => { s.role = i === 0 ? "WR1" : i === 1 ? "WR2" : "WR3"; }); } }
for (const s of P) if (!s.role) s.role = s.POS;

// ---------- defense matchups, walk-forward: from games before this week (this season 1, last season LAST) ----------
const DEFH = {};   // `${def}|${group}` -> list of { y, wk, exp, act, expO, actO }
const groups = s => s.POS === "WR" ? ["WR", s.role] : [s.POS];
for (const s of P) {
  if (s.base != null) {
    const mu = {}; for (const G of groups(s)) { const H = DEFH[`${s.def}|${G}`] || []; let W = 0, e = 0, a = 0, eo = 0, ao = 0, n = 0;
      for (const h of H) { const k = h.y === s.y && h.wk < s.wk ? 1 : h.y === s.y - 1 ? LAST : 0; if (!k) continue; W += k; e += k * h.exp; a += k * h.act; eo += k * h.expO; ao += k * h.actO; n++; }
      mu[G] = W >= 4 && e > 0 ? { tot: a / e - 1, vol: eo > 0 ? ao / eo - 1 : 0, eff: (a / Math.max(1e-9, ao)) / (e / Math.max(1e-9, eo)) - 1, w: W } : null; }
    s.m = mu[s.POS] || null; s.mRole = s.POS === "WR" ? mu[s.role] : s.m;
  }
  if (s.base != null) for (const G of groups(s)) (DEFH[`${s.def}|${G}`] ||= []).push({ y: s.y, wk: s.wk, exp: s.base, act: s.pts, expO: s.baseOpp, actO: s.opp });
}

// ---------- Q1: real? ----------
console.log("Q1  Does the matchup predict DK points vs the player's own prior baseline?  (walk-forward; weeks with 4+ prior defense games)");
console.log("    slope = how much of the matchup % shows up (0 = none, 1 = all of it); corr; best vs worst fifth of matchups (points vs baseline)");
const Q1 = (rows, key, lab) => { const R = rows.filter(s => s.base != null && s[key] && s.base > 0); if (R.length < 200) return;
  const x = R.map(s => s[key].tot), y = R.map(s => s.pts / s.base - 1), o = R.slice().sort((a, b) => a[key].tot - b[key].tot), n = Math.floor(o.length / 5);
  const q = i => mean(o.slice(i * n, (i + 1) * n).map(s => s.pts - s.base)), mt = i => mean(o.slice(i * n, (i + 1) * n).map(s => s[key].tot));
  const xv = R.map(s => s[key].vol), yv = R.map(s => s.baseOpp > 0 ? s.opp / s.baseOpp - 1 : 0), xe = R.map(s => s[key].eff), ye = R.map(s => s.opp > 0 && s.base > 0 ? (s.pts / s.opp) / (s.base / s.baseOpp) - 1 : 0);
  console.log(`  ${lab.padEnd(18)} n ${String(R.length).padStart(6)} | total slope ${slope(x, y).toFixed(2)} r ${corr(x, y).toFixed(3)} | worst fifth (${(100 * mt(0)).toFixed(0)}%) ${q(0).toFixed(2)} vs best (${(100 * mt(4)).toFixed(0)}%) ${q(4).toFixed(2)} pts | volume slope ${slope(xv, yv).toFixed(2)} r ${corr(xv, yv).toFixed(3)} | efficiency slope ${slope(xe, ye.map(v => Math.max(-1, Math.min(3, v)))).toFixed(2)}`); };
for (const per of [["2023-24", s => s.y <= 2024], ["2025", s => s.y === 2025], ["2026", s => s.y === 2026]]) {
  console.log(` ${per[0]}`);
  for (const POS of ["QB", "RB", "WR", "TE"]) Q1(P.filter(s => per[1](s) && s.POS === POS), "m", POS);
  for (const R of ["WR1", "WR2", "WR3"]) Q1(P.filter(s => per[1](s) && s.role === R), "mRole", `${R} (role matchup)`);
}

// ---------- Q2 + Q3 on the contest archive ----------
const contests = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.entries >= 100);
const sched = readCSV(`${NV}/games.csv`).filter(c => +c.season >= 2025 && c.game_type === "REG");
const gameFor = (date, team) => { const d0 = Date.parse(date); let best = null, bd = 1e18; for (const c of sched) { if (dk(c.home_team) !== team && dk(c.away_team) !== team) continue; const d = Date.parse(c.gameday) - d0; if (d >= -864e5 && d <= 6 * 864e5 && d < bd) { bd = d; best = c; } } return best; };   // the team's first game on or after the contest date (a Thursday game 3 days before a Sunday slate is last week's)
const pgIndex = {}; for (const s of P) pgIndex[`${s.game}|${s.id}`] = s;
const X = []; let nC = 0;
for (const c of contests) {
  const j = readPost(c.json), N = j.lineups.length, top = j.lineups.filter(l => l.fin <= Math.max(3, N * 0.01)), cnt = {}; for (const l of top) for (const id of l.ids) cnt[id] = (cnt[id] || 0) + 1; nC++;
  for (const p of j.players) { if (!/QB|RB|WR|TE/.test(p.pos) || !(p.proj > 0)) continue; const g = gameFor(j.contest.date, p.team); if (!g) continue; const y = +g.season;
    const id = idByName[`${y}|${p.team}|${nrm(p.name)}`] || idByName[`${y}|*|${nrm(p.name)}`], s = id && pgIndex[`${g.game_id}|${id}`]; if (!s || !s.m || s.base == null) continue;
    X.push({ y, team: p.team, gameday: g.gameday, contest: c.dir, POS: s.POS, role: s.role, m: s.m.tot, mRole: s.mRole ? s.mRole.tot : s.m.tot, proj: p.proj, sal: p.sal, own: p.pown, top1: (cnt[p.id] || 0) / top.length, base: s.base, pts: s.pts }); }
}
console.log(`\nQ2/Q3 on ${nC} contests: ${X.length} player-contest rows`);
console.log("Q2  Is it already priced?  corr(matchup, projection - baseline) > 0 means projections move with the matchup; then does it still predict actual - projection?");
for (const y of [2025, 2026]) for (const POS of ["QB", "RB", "WR", "TE"]) { const R = X.filter(x => x.y === y && x.POS === POS); if (R.length < 100) continue;
  console.log(`  ${y} ${POS} n ${String(R.length).padStart(5)} | proj moves with matchup r ${corr(R.map(x => x.m), R.map(x => x.proj - x.base)).toFixed(3)} | matchup vs actual-proj r ${corr(R.map(x => x.m), R.map(x => x.pts - x.proj)).toFixed(3)}`); }
console.log("Q3  Does the field chase matchups?  ownership vs matchup within the same value (proj per $1K) fifth; and top-1% lift (top-1% roster rate / ownership) by matchup fifth");
for (const POS of ["QB", "RB", "WR", "TE"]) {
  const R = X.filter(x => x.POS === POS && x.own > 0.005); if (R.length < 300) continue;
  // residual ownership after value: rank within value quintiles
  const v = R.map(x => x.proj / x.sal * 1000), vo = R.map((x, i) => i).sort((a, b) => v[a] - v[b]), vq = new Array(R.length); vo.forEach((i, k) => { vq[i] = Math.floor(5 * k / R.length); });
  const resid = R.map((x, i) => { const same = R.filter((_, k) => vq[k] === vq[i]); return Math.log(x.own) - mean(same.map(z => Math.log(z.own))); });
  const o = R.map((x, i) => i).sort((a, b) => R[a].m - R[b].m), n = Math.floor(o.length / 5), lift = ix => { const t = ix.reduce((s, i) => s + R[i].top1, 0), w = ix.reduce((s, i) => s + R[i].own, 0); return t / w; };
  console.log(`  ${POS} n ${String(R.length).padStart(5)} | extra ownership per matchup r ${corr(R.map(x => x.m), resid).toFixed(3)} | lift by matchup fifth worst->best: ${[0, 1, 2, 3, 4].map(q => lift(o.slice(q * n, (q + 1) * n)).toFixed(2)).join(" / ")}`);
}

// ---------- Q3b: controlled. Each player-week once (averaged over the contests it appeared in), lift by matchup fifth within
// ownership buckets (so chalk's own lift isn't credited to the matchup), and each season on its own ----------
{
  const PW = {}; for (const x of X) { const k = `${x.y}|${x.POS}|${x.contest.split("/").pop().slice(0, 10)}|${x.proj}|${x.sal}`; const a = PW[k] ||= Object.assign({ n: 0, ownS: 0, topS: 0 }, x); a.n++; a.ownS += x.own; a.topS += x.top1; }
  const U = Object.values(PW).map(a => Object.assign(a, { own: a.ownS / a.n, top1: a.topS / a.n })).filter(a => a.own > 0.005);
  const ownB = o => o < 0.05 ? 0 : o < 0.12 ? 1 : o < 0.25 ? 2 : 3, OWNL = ["<5%", "5-12%", "12-25%", "25%+"];
  console.log("\nQ3b  Controlled: each player-week once; lift (top-1% rate / ownership) for the worst vs best 40% of matchups INSIDE each ownership bucket");
  for (const POS of ["QB", "RB", "WR", "TE"]) for (const y of [2025, 2026, 0]) {
    const R = U.filter(a => a.POS === POS && (!y || a.y === y)); if (R.length < 80) continue;
    const parts = [0, 1, 2, 3].map(b => { const S = R.filter(a => ownB(a.own) === b).sort((p, q) => p.m - q.m); if (S.length < 20) return `${OWNL[b]}: -`; const k = Math.floor(S.length * 0.4), lo = S.slice(0, k), hi = S.slice(S.length - k), L = A => A.reduce((s, a) => s + a.top1, 0) / A.reduce((s, a) => s + a.own, 0); return `${OWNL[b]}: ${L(lo).toFixed(2)}->${L(hi).toFixed(2)} (${S.length})`; });
    // pooled: average of within-bucket hi/lo lift ratios weighted by bucket size
    let wsum = 0, rs = 0; for (const b of [0, 1, 2, 3]) { const S = R.filter(a => ownB(a.own) === b).sort((p, q) => p.m - q.m); if (S.length < 20) continue; const k = Math.floor(S.length * 0.4), lo = S.slice(0, k), hi = S.slice(S.length - k), L = A => A.reduce((s, a) => s + a.top1, 0) / A.reduce((s, a) => s + a.own, 0); if (L(lo) > 0) { rs += S.length * L(hi) / L(lo); wsum += S.length; } }
    console.log(`  ${POS} ${y || "both"} n ${String(R.length).padStart(5)} | best/worst matchup lift ratio ${wsum ? (rs / wsum).toFixed(2) : "-"} | ${parts.join("  ")}`);
  }
}

// ---------- Q3c: QB and TE - is it just the Vegas team total? Matchup with the implied team total removed (residual of a
// linear fit), then the same within-ownership lift test; and the implied total's own lift for comparison ----------
{
  const imp = {}; for (const c of sched) { if (c.total_line === "" || c.spread_line === "") continue; const tot = +c.total_line, sp = +c.spread_line;   // spread_line > 0: home favored
    imp[`${c.season}|${dk(c.home_team)}|${c.gameday}`] = (tot + sp) / 2; imp[`${c.season}|${dk(c.away_team)}|${c.gameday}`] = (tot - sp) / 2; }
  const PW = {}; for (const x of X) { const k = `${x.y}|${x.POS}|${x.contest.split("/").pop().slice(0, 10)}|${x.proj}|${x.sal}`; const a = PW[k] ||= Object.assign({ n: 0, ownS: 0, topS: 0 }, x); a.n++; a.ownS += x.own; a.topS += x.top1; }
  const U = Object.values(PW).map(a => Object.assign(a, { own: a.ownS / a.n, top1: a.topS / a.n, it: imp[`${a.y}|${a.team}|${a.gameday}`] ?? null })).filter(a => a.own > 0.005);
  // attach implied team total via the archive player rows' team and date: rebuild from contests
  const teamOf = {}; for (const c of contests.slice(0, 0)) {}  // (team recovered below from X rows)
  const ownB = o => o < 0.05 ? 0 : o < 0.12 ? 1 : o < 0.25 ? 2 : 3;
  const liftRatio = (R, key) => { let wsum = 0, rs = 0; for (const b of [0, 1, 2, 3]) { const S = R.filter(a => ownB(a.own) === b && a[key] != null).sort((p, q) => p[key] - q[key]); if (S.length < 20) continue; const k = Math.floor(S.length * 0.4), L = A => A.reduce((s, a) => s + a.top1, 0) / A.reduce((s, a) => s + a.own, 0), lo = L(S.slice(0, k)), hi = L(S.slice(S.length - k)); if (lo > 0) { rs += S.length * hi / lo; wsum += S.length; } } return wsum ? rs / wsum : NaN; };
  console.log("\nQ3c  QB / TE: matchup with the Vegas implied team total taken out (same within-ownership lift ratio, best vs worst 40%)");
  for (const POS of ["QB", "TE"]) {
    const R = U.filter(a => a.POS === POS && a.it != null);
    if (R.length < 80) { console.log(`  ${POS}: implied totals not matched (${R.length})`); continue; }
    const mx = mean(R.map(a => a.it)), my = mean(R.map(a => a.m)), b = slope(R.map(a => a.it), R.map(a => a.m)); for (const a of R) a.mRes = a.m - (my + b * (a.it - mx));
    for (const y of [2025, 2026, 0]) { const S = R.filter(a => !y || a.y === y); if (S.length < 60) continue;
      console.log(`  ${POS} ${y || "both"} n ${String(S.length).padStart(4)} | corr(matchup, implied total) ${corr(S.map(a => a.m), S.map(a => a.it)).toFixed(2)} | lift ratio: matchup ${liftRatio(S, "m").toFixed(2)}, implied total ${liftRatio(S, "it").toFixed(2)}, matchup minus total ${liftRatio(S, "mRes").toFixed(2)}`); }
  }
}

// ---------- Q3d: bootstrap by slate date (whole weeks resampled) for the QB lift ratio, matchup minus team total ----------
{
  const imp = {}; for (const c of sched) { if (c.total_line === "" || c.spread_line === "") continue; const tot = +c.total_line, sp = +c.spread_line; imp[`${c.season}|${dk(c.home_team)}|${c.gameday}`] = (tot + sp) / 2; imp[`${c.season}|${dk(c.away_team)}|${c.gameday}`] = (tot - sp) / 2; }
  const PW = {}; for (const x of X) { if (x.POS !== "QB") continue; const k = `${x.y}|${x.contest.split("/").pop().slice(0, 10)}|${x.proj}|${x.sal}`; const a = PW[k] ||= Object.assign({ n: 0, ownS: 0, topS: 0, date: x.contest.split("/").pop().slice(0, 10) }, x); a.n++; a.ownS += x.own; a.topS += x.top1; }
  const R = Object.values(PW).map(a => Object.assign(a, { own: a.ownS / a.n, top1: a.topS / a.n, it: imp[`${a.y}|${a.team}|${a.gameday}`] ?? null })).filter(a => a.own > 0.005 && a.it != null);
  const mx = mean(R.map(a => a.it)), my = mean(R.map(a => a.m)), b = slope(R.map(a => a.it), R.map(a => a.m)); for (const a of R) a.mRes = a.m - (my + b * (a.it - mx));
  const ownB = o => o < 0.05 ? 0 : o < 0.12 ? 1 : o < 0.25 ? 2 : 3;
  const ratio = S0 => { let wsum = 0, rs = 0; for (const bk of [0, 1, 2]) { const S = S0.filter(a => ownB(a.own) === bk).sort((p, q) => p.mRes - q.mRes); if (S.length < 15) continue; const k = Math.floor(S.length * 0.4), L = A => A.reduce((s, a) => s + a.top1, 0) / A.reduce((s, a) => s + a.own, 0), lo = L(S.slice(0, k)), hi = L(S.slice(S.length - k)); if (lo > 0) { rs += S.length * hi / lo; wsum += S.length; } } return wsum ? rs / wsum : NaN; };
  const dates = [...new Set(R.map(a => a.date))], byDate = {}; for (const a of R) (byDate[a.date] ||= []).push(a);
  let seed = 7; const rnd = () => { seed = ((Math.imul(seed, 1103515245) + 12345) >>> 0) % 2147483648; return seed / 2147483648; };
  const B = []; for (let i = 0; i < 1000; i++) { const S = []; for (let k = 0; k < dates.length; k++) S.push(...byDate[dates[Math.floor(rnd() * dates.length)]]); const r = ratio(S); if (isFinite(r)) B.push(r); }
  B.sort((x, y) => x - y);
  console.log(`\nQ3d  QB matchup (minus team total) lift ratio, bootstrap over ${dates.length} slate dates: ${ratio(R).toFixed(2)}, 90% interval ${B[Math.floor(B.length * 0.05)].toFixed(2)} - ${B[Math.floor(B.length * 0.95)].toFixed(2)}, share of resamples above 1: ${(100 * B.filter(x => x > 1).length / B.length).toFixed(0)}%`);
}

// ---------- this week: QB matchup for every defense, from games before the week (same method as Q1/Q3) ----------
{
  const y = 2026, wk = +(process.env.WEEK || 6), D = {};
  for (const [k, H] of Object.entries(DEFH)) { const [def, G] = k.split("|"); if (G !== "QB") continue; let W = 0, e = 0, a = 0;
    for (const h of H) { const w = h.y === y && h.wk < wk ? 1 : h.y === y - 1 ? LAST : 0; if (!w) continue; W += w; e += w * h.exp; a += w * h.act; }
    if (W >= 4 && e > 0) D[def] = { m: a / e - 1, W }; }
  const rank = Object.entries(D).sort((p, q) => q[1].m - p[1].m);
  console.log(`\nWeek ${wk} QB matchups (defense's QB points allowed vs those QBs' usual; + = softer). Top 40% = the side that won:`);
  rank.forEach(([def, v], i) => { if (["DEN", "SEA"].includes(def) || i < 5 || i >= rank.length - 3) console.log(`  ${String(i + 1).padStart(2)}. ${def.padEnd(4)} ${(v.m >= 0 ? "+" : "") + (100 * v.m).toFixed(1)}%  (${v.W.toFixed(1)} weighted games)${["DEN", "SEA"].includes(def) ? "  <--" : ""}`); });
}
