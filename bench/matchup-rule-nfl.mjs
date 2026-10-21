// Backtest of the optimizer rule "at least N players per lineup with a matchup better than X%" (user, 2026-10-14, after
// Blick described it). Matchups are ours (bench/matchups-nfl.mjs method): defense x role pass-catching DK points per target
// vs each receiver's usual, computed for every contest week from games BEFORE that week only (2025 prior at weight W25 for
// 2026 weeks), then shrunk by the half-season predictive test. Each pass-catcher in a real contest lineup gets his matchup;
// lineups are grouped by how many players clear the threshold, and top-10% / top-1% rates compared - within lineups that hold
// the same number of pass-catchers, so "more WRs" doesn't pass for "more matchups". 2025 picks the variant, 2026 tests it.
// Rushing matchups are not in it (receiving only): RBs count through their targets.
//   node bench/matchup-rule-nfl.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import { parseCSV } from "../src/engine/csv.mjs";
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const NV = "data/nflverse", W25 = 0.25;
const readCSV = f => { const b = fs.readFileSync(f), [h, ...rows] = parseCSV((f.endsWith(".gz") ? zlib.gunzipSync(b) : b).toString("utf8")); return rows.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const DK = { LA: "LAR" }, dk = t => DK[t] || t, nrm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };

// ---------- targets, roles, observations over expected (same method as matchups-nfl.mjs) ----------
const pos = {}, idByName = {};
for (const y of [2025, 2026]) for (const r of readCSV(`${NV}/roster_${y}.csv`)) if (r.gsis_id) { pos[r.gsis_id] = r.position; idByName[`${y}|${dk(r.team)}|${nrm(r.full_name)}`] = r.gsis_id; idByName[`${y}|*|${nrm(r.full_name)}`] = r.gsis_id; }
const T = [];
for (const y of [2025, 2026]) for (const r of readCSV(`${NV}/play_by_play_${y}.csv.gz`)) {
  if (r.season_type !== "REG" || r.play_type !== "pass" || !r.receiver_player_id || r.sack === "1" || r.qb_scramble === "1") continue;
  const yds = r.complete_pass === "1" ? +r.yards_gained : 0;
  T.push({ y, wk: +r.week, game: r.game_id, off: dk(r.posteam), def: dk(r.defteam), id: r.receiver_player_id, fp: r.complete_pass === "1" ? 1 + 0.1 * yds + (r.touchdown === "1" && dk(r.td_team) === dk(r.posteam) ? 6 : 0) : 0 });
}
const byTG = {}; for (const t of T) (byTG[`${t.y}|${t.off}|${t.game}`] ||= { y: t.y, off: t.off, game: t.game, wk: t.wk, list: [] }).list.push(t);
const roleOf = {}, priorCnt = {};   // role in each team-game from prior target counts that season
for (const g of Object.values(byTG).sort((a, b) => a.y - b.y || a.wk - b.wk)) {
  const key = `${g.y}|${g.off}`, cnt = priorCnt[key] ||= {}, here = [...new Set(g.list.map(t => t.id))], rk = id => cnt[id] || 0;
  const wrs = here.filter(id => /WR/.test(pos[id] || "WR")).sort((a, b) => rk(b) - rk(a)), tes = here.filter(id => /TE/.test(pos[id] || "")).sort((a, b) => rk(b) - rk(a));
  for (const id of here) { const P = pos[id] || "WR"; roleOf[`${g.y}|${g.game}|${id}`] = /RB|FB/.test(P) ? "RB" : /TE/.test(P) ? (id === tes[0] ? "TE1" : "WR3") : id === wrs[0] ? "WR1" : id === wrs[1] ? "WR2" : "WR3"; }
  for (const t of g.list) cnt[t.id] = (cnt[t.id] || 0) + 1;
}
const ps = {}; for (const t of T) { const s = ps[`${t.y}|${t.id}`] ||= { n: 0, fp: 0 }; s.n++; s.fp += t.fp; }
const obs = [];
for (const g of Object.values(byTG)) for (const id of new Set(g.list.map(t => t.id))) {
  const s = ps[`${g.y}|${id}`], mine = g.list.filter(t => t.id === id), oN = s.n - mine.length; if (oN < 8) continue;
  obs.push({ y: g.y, wk: g.wk, def: g.list[0].def, role: roleOf[`${g.y}|${g.game}|${id}`], n: mine.length, fpt: mean(mine.map(t => t.fp)) - (s.fp - mine.reduce((a, t) => a + t.fp, 0)) / oN });
}
// shrinkage per role: 2025 half-season predictive r (as in matchups-nfl.mjs)
const ROLES = ["WR1", "WR2", "WR3", "TE1", "RB"], keep = {}, roleAvgFpt = {};
for (const R of ROLES) {
  const a = [], b = []; for (const d of new Set(obs.map(o => o.def))) { const f = rows => { let s = 0, w = 0; for (const r of rows) { s += r.n * r.fpt; w += r.n; } return w ? s / w : null; };
    const x = f(obs.filter(o => o.y === 2025 && o.def === d && o.role === R && o.wk <= 9)), z = f(obs.filter(o => o.y === 2025 && o.def === d && o.role === R && o.wk >= 10)); if (x != null && z != null) { a.push(x); b.push(z); } }
  keep[R] = Math.max(0, corr(a, b));
}
{ const tot = {}; for (const t of T) { const R = roleOf[`${t.y}|${t.game}|${t.id}`]; const s = tot[R] ||= [0, 0]; s[0] += t.fp; s[1]++; } for (const R of ROLES) roleAvgFpt[R] = tot[R][0] / tot[R][1]; }
console.log("shrink keep per role (2025 half-season r): " + ROLES.map(R => `${R} ${keep[R].toFixed(2)}`).join(", "));

// matchup for (season, week, defense, role) from games before that week: raw and kept, as % of the role's average DK pts per target
const cache = {};
function matchup(y, wk, def, R) {
  const k = `${y}|${wk}|${def}|${R}`; if (cache[k]) return cache[k];
  let s = 0, w = 0, g = 0; for (const o of obs) { if (o.def !== def || o.role !== R) continue; const wt = o.y === y && o.wk < wk ? 1 : o.y === y - 1 ? W25 : 0; if (!wt) continue; s += wt * o.n * o.fpt; w += wt * o.n; g += wt; }
  const raw = w ? s / w : 0, kk = keep[R], rel = kk > 0 && g > 0 ? (g / 8 * kk) / (1 + (g / 8 - 1) * kk) : 0;
  return cache[k] = { raw: raw / roleAvgFpt[R], kept: raw * Math.min(1, Math.max(0, rel)) / roleAvgFpt[R], games: g };
}

// ---------- contest week for a date ----------
const sched = readCSV(`${NV}/games.csv`).filter(c => (c.season === "2025" || c.season === "2026") && c.game_type === "REG");
const weekOf = (date, team) => { const d0 = Date.parse(date); let g = null, bd = 1e18; for (const c of sched) { if (dk(c.home_team) !== team && dk(c.away_team) !== team) continue; const d = Date.parse(c.gameday) - d0; if (d >= -864e5 && d <= 6 * 864e5 && d < bd) { bd = d; g = c; } } return g ? { y: +g.season, wk: +g.week } : null; };   // first game on or after the contest date

// ---------- lineups ----------
const contests = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.entries >= 100);
const VARIANTS = [["kept >= +3%", m => m.kept >= 0.03, "all"], ["kept >= +5%", m => m.kept >= 0.05, "all"], ["kept >= +3%, predictive roles only", m => m.kept >= 0.03, "pred"], ["raw >= +10% (unshrunk)", m => m.raw >= 0.10, "all"], ["raw >= +20% (unshrunk)", m => m.raw >= 0.20, "all"]];
const PRED = new Set(ROLES.filter(R => keep[R] >= 0.15));
console.log(`predictive roles (keep >= 0.15): ${[...PRED].join(", ")}`);
const PL = {}; const res = {}; let used = 0, skipped = 0, unmatched = 0, matched = 0;
for (const c of contests) {
  const j = readPost(c.json), P = {}; for (const p of j.players) P[p.id] = p;
  const anyTeam = j.players.find(p => p.team)?.team, wkInfo = anyTeam && weekOf(j.contest.date, anyTeam); if (!wkInfo || (wkInfo.y === 2025 && wkInfo.wk < 4)) { skipped++; continue; }
  // each pass-catcher's matchup this week
  const M = {};
  for (const p of j.players) { if (!/WR|TE|RB/.test(p.pos)) continue;
    const id = idByName[`${wkInfo.y}|${p.team}|${nrm(p.name)}`] || idByName[`${wkInfo.y}|*|${nrm(p.name)}`]; if (!id) { unmatched++; continue; } matched++;
    // his role: latest team-game role before this week, else by position
    let R = null; for (let w = wkInfo.wk - 1; w >= 1 && !R; w--) { const tg = Object.values(byTG).find(g => g.y === wkInfo.y && g.off === p.team && g.wk === w); if (tg) R = roleOf[`${wkInfo.y}|${tg.game}|${id}`] || null; }
    R = R || (/TE/.test(p.pos) ? "TE1" : /RB/.test(p.pos) ? "RB" : "WR3");
    M[p.id] = Object.assign({ role: R }, matchup(wkInfo.y, wkInfo.wk, p.opp, R));
    PL[`${wkInfo.y}|${wkInfo.wk}|${id}`] ||= { y: wkInfo.y, wk: wkInfo.wk, id, role: R, proj: p.proj, kept: M[p.id].kept, raw: M[p.id].raw }; }
  const N = j.lineups.length; used++;
  for (const l of j.lineups) {
    const pc = l.ids.map(i => M[i]).filter(Boolean), k = pc.length, t1 = l.fin <= N * 0.01, t10 = l.fin <= N * 0.1;
    for (const [name, f, scope] of VARIANTS) { const good = pc.filter(m => f(m) && (scope === "all" || PRED.has(m.role))).length, b = Math.min(good, 3);
      const key = `${wkInfo.y}|${name}|${Math.min(k, 7)}|${b}`, r = res[key] ||= { n: 0, t1: 0, t10: 0 }; r.n++; r.t1 += t1; r.t10 += t10; }
  }
}
console.log(`${used} contests (${skipped} skipped: week < 4 of 2025 or no schedule match); pass-catcher name match ${matched}/${matched + unmatched}`);
// within each pass-catcher count, rate by good-matchup count; then average across counts weighted by lineups
for (const y of [2025, 2026]) {
  console.log(`\n${y}: top-10% / top-1% rate by number of good-matchup players (within the same number of pass-catchers; base 10% / 1%)`);
  for (const [name] of VARIANTS) {
    const cells = [0, 1, 2, 3].map(b => { let n = 0, t1 = 0, t10 = 0; for (let k = 3; k <= 7; k++) { const r = res[`${y}|${name}|${k}|${b}`]; if (!r) continue; n += r.n; t1 += r.t1; t10 += r.t10; } return { n, t1, t10 }; });
    console.log(`  ${name.padEnd(36)} ${cells.map((c, b) => `${b}${b === 3 ? "+" : ""}: ${c.n ? (100 * c.t10 / c.n).toFixed(1) : "-"}% / ${c.n ? (100 * c.t1 / c.n).toFixed(2) : "-"}% (${c.n})`).join("   ")}`);
  }
}

// ---------- player level: does the matchup predict actual DK points minus Stokastic's projection? ----------
const act = {}; for (const y of [2025, 2026]) for (const r of readCSV(`${NV}/stats_player_week_${y}.csv`)) if (r.season_type === "REG") {
  const ry = +r.rushing_yards || 0, cy = +r.receiving_yards || 0; act[`${y}|${r.week}|${r.player_id}`] = +r.fantasy_points_ppr + (ry >= 100 ? 3 : 0) + (cy >= 100 ? 3 : 0); }
const L = Object.values(PL).filter(x => act[`${x.y}|${x.wk}|${x.id}`] != null && x.proj > 0).map(x => Object.assign(x, { resid: act[`${x.y}|${x.wk}|${x.id}`] - x.proj }));
console.log(`
Player level: ${L.length} player-weeks; residual = actual DK pts - Stokastic projection`);
for (const y of [2025, 2026]) for (const R of ["all", ...ROLES]) { const S = L.filter(x => x.y === y && (R === "all" || x.role === R)); if (S.length < 50) continue;
  const q = (k) => { const o = S.slice().sort((a, b) => a[k] - b[k]), n = Math.floor(o.length / 5); return [0, 4].map(i => mean(o.slice(i * n, (i + 1) * n).map(x => x.resid))); };
  const [kl, kh] = q("kept"), [rl, rh] = q("raw");
  console.log(`  ${y} ${R.padEnd(4)} n ${String(S.length).padStart(5)} | corr kept ${corr(S.map(x => x.kept), S.map(x => x.resid)).toFixed(3)} raw ${corr(S.map(x => x.raw), S.map(x => x.resid)).toFixed(3)} | worst vs best fifth by raw matchup: ${rl.toFixed(2)} vs ${rh.toFixed(2)} pts`); }
