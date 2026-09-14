// Rebuild a pool, entries and payouts from Stokastic post-contest exports
// (Data_Hub_Lineup / Data_Hub_Player), which carry no projections or salaries per player.
import { parseCSV, nrm, num } from "./csv.mjs";
import { FORMATS } from "./formats.mjs";
import { assignSlots } from "./lineups.mjs";

// Ridge least squares over the lineup/player indicator matrix.
export function solveLS(lineups, np, target, lambda = 0.05) {
  const A = []; for (let i = 0; i < np; i++) A.push(new Float64Array(np));
  const b = new Float64Array(np);
  lineups.forEach((lu, r) => { for (const x of lu) { b[x] += target[r]; for (const y of lu) A[x][y] += 1; } });
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

// teamOf(name) -> {team, opp} or null. Returns {pool, entries, payouts, paid, unmatched}.
export function recoverContest(lineupCSV, playerCSV, teamOf, fkey = "mlb_cl") {
  const f = FORMATS[fkey];
  const L = parseCSV(lineupCSV).slice(1).map(r => ({ user: r[0], stkROI: num(r[1]), actROI: num(r[2]), stkFP: num(r[3]), actFP: num(r[4]), own: num(r[5]), finish: num(r[6]), dupes: num(r[7]), sal: num(r[8]), names: String(r[9] || "").split(",").map(s => s.trim()).filter(Boolean) }));
  const PL = parseCSV(playerCSV).slice(1).map(r => ({ name: r[0], pos: r[1], stk: num(r[2]), act: num(r[3]), own: num(r[4]) }));
  const P = [], byKey = {}, unmatched = [];
  for (const pl of PL) {
    const t = teamOf ? teamOf(pl.name) : null; if (!t) unmatched.push(pl.name);
    const plist = String(pl.pos || "").split("/"), isP = f.sport === "mlb" ? (plist.includes("SP") || plist.includes("RP") || plist.includes("P")) : plist[0] === "DST";
    const p = { name: pl.name, key: nrm(pl.name), pos: isP && f.sport === "mlb" ? "P" : plist[0], posList: isP && f.sport === "mlb" ? ["P"] : plist,
      team: t ? t.team : "", opp: t ? t.opp || "" : "", sal: 0, csal: 0, proj: 0, own: pl.own || 0, fown: pl.own || 0, cown: 0, ceil: null, sd: null, ord: null, isP, stkROI: pl.stk, actROI: pl.act };
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
    const proj = solveLS(lus, np, entries.map(e => e.stkFP)), sal = solveLS(lus, np, entries.map(e => e.sal)), act = solveLS(lus, np, entries.map(e => e.actFP));
    P.forEach((p, i) => { p.proj = Math.max(0, proj[i]); p.sal = Math.max(2000, Math.round(sal[i] / 100) * 100); p.csal = p.sal * 1.5; p.act = act[i]; });
  }
  // Tied entries share a finish position, so rank by finish (then ROI) instead of indexing by finish.
  const N = entries.length, payouts = new Float64Array(N);
  const ranked = [...entries].sort((a, b) => a.finish - b.finish || b.actROI - a.actROI);
  ranked.forEach((e, i) => { if (e.actROI > -100) payouts[i] = 1 + e.actROI / 100; });
  const paid = payouts.filter(x => x > 0).length;
  return { pool, entries, payouts, paid, unmatched, rows: L.length };
}
