// Rebuild a pool, entries and payouts from Stokastic post-contest exports
// (Data_Hub_Lineup / Data_Hub_Player), which carry no projections or salaries per player.
import { parseCSV, nrm, num } from "./csv.mjs";
import { FORMATS } from "./formats.mjs";
import { assignSlots } from "./lineups.mjs";

// Ridge least squares over the lineup/player indicator matrix. mult weights each roster
// slot (showdown captain counts 1.5x toward points and salary).
export function solveLS(lineups, np, target, lambda = 0.05, mult) {
  const A = []; for (let i = 0; i < np; i++) A.push(new Float64Array(np));
  const b = new Float64Array(np), w = q => mult ? mult[q] : 1;
  lineups.forEach((lu, r) => { for (let q = 0; q < lu.length; q++) { const x = lu[q]; b[x] += w(q) * target[r]; for (let k = 0; k < lu.length; k++) A[x][lu[k]] += w(q) * w(k); } });
  for (let i = 0; i < np; i++) A[i][i] += lambda;
  const M = A.map((row, i) => ({ x: Float64Array.from(row), b: b[i] }));
  for (let c = 0; c < np; c++) {
    let piv = c; for (let r = c + 1; r < np; r++) if (Math.abs(M[r].x[c]) > Math.abs(M[piv].x[c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c].x[c] || 1e-12;
    for (let r = 0; r < np; r++) { if (r === c) continue; const fct = M[r].x[c] / d; if (!fct) continue; for (let k = c; k < np; k++) M[r].x[k] -= fct * M[c].x[k]; M[r].b -= fct * M[c].b; }
  }
  return Float64Array.from(M, (row, i) => row.b / (row.x[i] || 1e-12));
}

// A per-player value from lineup totals. The totals are exact sums, so players seen in
// enough distinct lineups are identified and plain least squares recovers them; players
// seen only alongside the same few others are not, and minimum-norm ridge hands them the
// pool average. So fit a prior (linear in log ownership, per position group, on players
// seen often) and refit deviations from it with a light ridge: identified players still
// come out exact, unidentified ones stay near the prior.
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
export function recoverStat(lus, np, target, mult, own, cnt, group, ridge = 0.5) {
  const raw = solveLS(lus, np, target, 0.05, mult), fit = {}, all = { xs: [], ys: [] };
  const key = i => group ? group[i] : "";
  for (let i = 0; i < np; i++) if (cnt[i] >= 30) { const g = fit[key(i)] || (fit[key(i)] = { xs: [], ys: [] }); const x = Math.log(own[i] + 0.2); g.xs.push(x); g.ys.push(raw[i]); all.xs.push(x); all.ys.push(raw[i]); }
  const line = g => {
    if (!g || g.xs.length < 5) return null;
    const mx = mean(g.xs), my = mean(g.ys); let sxy = 0, sxx = 0;
    for (let i = 0; i < g.xs.length; i++) { sxy += (g.xs[i] - mx) * (g.ys[i] - my); sxx += (g.xs[i] - mx) ** 2; }
    const b = sxx ? sxy / sxx : 0; return { a: my - b * mx, b };
  };
  const fallback = line(all) || { a: mean(all.ys.length ? all.ys : Array.from(raw)), b: 0 };
  const prior = new Float64Array(np);
  for (let i = 0; i < np; i++) { const l = line(fit[key(i)]) || fallback; prior[i] = l.a + l.b * Math.log(own[i] + 0.2); }
  const w = q => mult ? mult[q] : 1;
  const resid = target.map((t, r) => t - lus[r].reduce((s, id, q) => s + w(q) * prior[id], 0));
  const d = solveLS(lus, np, resid, ridge, mult);
  return prior.map((p, i) => p + d[i]);
}

// teamOf(name) -> {team, opp, pos?} or null. Returns {pool, entries, payouts, paid, unmatched}.
export function recoverContest(lineupCSV, playerCSV, teamOf, fkey = "mlb_cl") {
  const f = FORMATS[fkey];
  const L = parseCSV(lineupCSV).slice(1).map(r => ({ user: r[0], stkROI: num(r[1]), actROI: num(r[2]), stkFP: num(r[3]), actFP: num(r[4]), own: num(r[5]), finish: num(r[6]), dupes: num(r[7]), sal: num(r[8]), names: String(r[9] || "").split(",").map(s => s.trim()).filter(Boolean) }));
  const PL = parseCSV(playerCSV).slice(1).map(r => ({ name: r[0], pos: r[1], stk: num(r[2]), act: num(r[3]), own: num(r[4]) }));
  const P = [], byKey = {}, unmatched = [];
  for (const pl of PL) {
    const key = nrm(pl.name), slotPos = String(pl.pos || "").toUpperCase(), isCpt = slotPos === "CPT";
    // Showdown files list each player twice (CPT row, FLEX row); keep one player, CPT ownership aside.
    if (byKey[key] != null) { const q = P[byKey[key]]; if (isCpt) q.cown = pl.own || 0; else { q.own = pl.own || 0; q.fown = pl.own || 0; q.stkROI = pl.stk; q.actROI = pl.act; } continue; }
    const t = teamOf ? teamOf(pl.name) : null; if (!t) unmatched.push(pl.name);
    // CPT/FLEX are roster slots, not positions; the reference supplies the real one when it can.
    const posRaw = (isCpt || slotPos === "FLEX") && t && t.pos ? t.pos : slotPos;
    const plist = posRaw.split("/"), isP = f.sport === "mlb" ? (plist.includes("SP") || plist.includes("RP") || plist.includes("P")) : plist[0] === "DST";
    const p = { name: pl.name, key, pos: isP && f.sport === "mlb" ? "P" : plist[0], posList: isP && f.sport === "mlb" ? ["P"] : plist,
      team: t ? t.team : "", opp: t ? t.opp || "" : "", sal: 0, csal: 0, proj: 0, own: isCpt ? 0 : pl.own || 0, fown: isCpt ? 0 : pl.own || 0, cown: isCpt ? pl.own || 0 : 0, ceil: null, sd: null, ord: null, isP, stkROI: pl.stk, actROI: pl.act };
    byKey[p.key] = P.length; P.push(p);
  }
  const teams = [...new Set(P.map(p => p.team).filter(Boolean))].sort(), gmap = {}, games = [];
  P.forEach((p, i) => { const k = p.team && p.opp ? [p.team, p.opp].sort().join("@") : (p.team || "?"); if (gmap[k] == null) { gmap[k] = games.length; games.push(k); } p.i = i; p.gi = gmap[k]; p.ti = teams.indexOf(p.team); });
  const pool = { players: P, teams, games, src: "post-contest", format: f };
  const entries = [];
  for (const e of L) {
    const ids = e.names.map(nm => byKey[nrm(nm)]); if (ids.length !== f.slots.length || ids.some(x => x == null)) continue;
    const lu = assignSlots(ids, P, f); if (lu) entries.push(Object.assign({}, e, { lu }));
  }
  const lus = entries.map(e => e.lu), np = P.length;
  if (lus.length) {
    const cnt = new Float64Array(np); for (const lu of lus) for (const id of lu) cnt[id]++;
    const own = P.map(p => (p.own || 0) + (p.cown || 0)), group = P.map(p => f.sport === "mlb" ? (p.isP ? "P" : "H") : p.pos);
    const proj = recoverStat(lus, np, entries.map(e => e.stkFP), f.mult, own, cnt, group), sal = recoverStat(lus, np, entries.map(e => e.sal), f.mult, own, cnt, group), act = recoverStat(lus, np, entries.map(e => e.actFP), f.mult, own, cnt, group);
    P.forEach((p, i) => { p.proj = Math.max(0, proj[i]); p.sal = Math.max(2000, Math.round(sal[i] / 100) * 100); p.csal = p.sal * 1.5; p.act = act[i]; });
  }
  // Tied entries share a finish position, so rank by finish (then ROI) instead of indexing by finish.
  const N = entries.length, payouts = new Float64Array(N);
  const ranked = [...entries].sort((a, b) => a.finish - b.finish || b.actROI - a.actROI);
  ranked.forEach((e, i) => { if (e.actROI > -100) payouts[i] = 1 + e.actROI / 100; });
  const paid = payouts.filter(x => x > 0).length;
  return { pool, entries, payouts, paid, unmatched, rows: L.length };
}
