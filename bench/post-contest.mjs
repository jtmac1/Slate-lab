// Cross-slate benchmark from Stokastic post-contest exports (Lineup / Player / PlayerExp).
// Each folder under data/ with those three files is one contest. Teams and opponents come
// from the MLB stats API cache in data/mlb-ref. Projections, salaries and actual points per
// player are recovered from the lineup sums by least squares.
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm, num } from "../src/engine/csv.mjs";
import { FORMATS } from "../src/engine/formats.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { genField } from "../src/engine/field.mjs";
import { simulate, playerROI } from "../src/engine/sim.mjs";
import { sigOf, stackOf, assignSlots } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const ITERS = +(process.argv[2] || 10000), SEED = 1;
const REF = "data/mlb-ref";
const mlbPlayers = JSON.parse(fs.readFileSync(path.join(REF, "players-2026.json"), "utf8"));
const refByKey = {}, refByLoose = {};
const loose = s => nrm(s).split(" ").filter(w => w.length > 1).join(" ");
for (const p of mlbPlayers) { refByKey[nrm(p.name)] = p; refByLoose[loose(p.name)] = p; }
function lookup(name) { return refByKey[nrm(name)] || refByLoose[loose(name)] || null; }

function spearman(a, b) {
  const rk = x => { const idx = x.map((v, i) => i).sort((i, j) => x[i] - x[j]); const r = new Array(x.length); let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && x[idx[j + 1]] === x[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg; i = j + 1; } return r; };
  const ra = rk(a), rb = rk(b), n = a.length, m = (n + 1) / 2; let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - m) * (rb[i] - m); saa += (ra[i] - m) ** 2; sbb += (rb[i] - m) ** 2; }
  return sbb && saa ? sab / Math.sqrt(saa * sbb) : 0;
}
// Ridge least squares: lineups x players indicator matrix, target per lineup.
function solve(lineups, np, target, lambda) {
  const AtA = []; for (let i = 0; i < np; i++) AtA.push(new Float64Array(np));
  const Atb = new Float64Array(np);
  lineups.forEach((lu, r) => { for (const a of lu) { Atb[a] += target[r]; for (const b of lu) AtA[a][b] += 1; } });
  for (let i = 0; i < np; i++) AtA[i][i] += lambda;
  // Gaussian elimination with partial pivoting
  const M = AtA.map((row, i) => { const x = Float64Array.from(row); return { x, b: Atb[i] }; });
  for (let c = 0; c < np; c++) {
    let piv = c; for (let r = c + 1; r < np; r++) if (Math.abs(M[r].x[c]) > Math.abs(M[piv].x[c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c].x[c] || 1e-12;
    for (let r = 0; r < np; r++) { if (r === c) continue; const fct = M[r].x[c] / d; if (!fct) continue; for (let k = c; k < np; k++) M[r].x[k] -= fct * M[c].x[k]; M[r].b -= fct * M[c].b; }
  }
  return Float64Array.from(M, (row, i) => row.b / (row.x[i] || 1e-12));
}
const topOf = (arr, k) => arr.map((v, i) => i).sort((a, b) => arr[b] - arr[a]).slice(0, k);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const dist = (lus, P, f) => { const d = {}; for (const l of lus) { const k = stackOf(l, P, f); d[k] = (d[k] || 0) + 1; } return Object.entries(d).sort((a, b) => b[1] - a[1]); };

const dirs = fs.readdirSync("data").filter(d => fs.existsSync(path.join("data", d, "DK_MLB_Night_Data_Hub_Lineup.csv"))).sort();
const summary = [];
for (const dir of dirs) {
  const D = path.join("data", dir), read = f => parseCSV(fs.readFileSync(path.join(D, f), "utf8"));
  const date = (dir.match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
  const sched = fs.existsSync(path.join(REF, `schedule-${date}.json`)) ? JSON.parse(fs.readFileSync(path.join(REF, `schedule-${date}.json`), "utf8")) : [];
  const opp = {}; for (const g of sched) { opp[g.home] = g.away; opp[g.away] = g.home; }
  const L = read("DK_MLB_Night_Data_Hub_Lineup.csv").slice(1).map(r => ({ user: r[0], stkROI: num(r[1]), actROI: num(r[2]), stkFP: num(r[3]), actFP: num(r[4]), own: num(r[5]), finish: num(r[6]), dupes: num(r[7]), sal: num(r[8]), names: r[9].split(",").map(s => s.trim()) }));
  const PL = read("DK_MLB_Night_Data_Hub_Player.csv").slice(1).map(r => ({ name: r[0], pos: r[1], stk: num(r[2]), act: num(r[3]), own: num(r[4]) }));
  // pool from the player file
  const P = [], byKey = {};
  let unmatched = [];
  PL.forEach(pl => {
    const ref = lookup(pl.name), team = ref ? ref.team : "";
    if (!ref) unmatched.push(pl.name);
    const plist = pl.pos.split("/"), isP = plist.includes("SP") || plist.includes("RP") || plist.includes("P");
    const p = { name: pl.name, key: nrm(pl.name), pos: isP ? "P" : plist[0], posList: isP ? ["P"] : plist, team, opp: opp[team] || "", sal: 0, csal: 0,
      proj: 0, own: pl.own, fown: pl.own, cown: 0, ceil: null, sd: null, ord: null, isP, stkROI: pl.stk, actROI: pl.act };
    byKey[p.key] = P.length; P.push(p);
  });
  const teams = [...new Set(P.map(p => p.team).filter(Boolean))].sort();
  const gmap = {}, games = [];
  P.forEach((p, i) => { const k = p.team && p.opp ? [p.team, p.opp].sort().join("@") : (p.team || "?"); if (gmap[k] == null) { gmap[k] = games.length; games.push(k); } p.i = i; p.gi = gmap[k]; p.ti = teams.indexOf(p.team); });
  const f = FORMATS.mlb_cl, pool = { players: P, teams, games, src: "post-contest", format: f };
  // entries -> lineups
  const entries = [], missNames = {};
  for (const e of L) {
    const ids = e.names.map(nm => byKey[nrm(nm)]);
    if (ids.some(x => x == null)) { e.names.forEach((nm, k) => { if (ids[k] == null) missNames[nm] = 1; }); continue; }
    const lu = assignSlots(ids, P, f); if (!lu) continue;
    entries.push({ ...e, lu });
  }
  const N = entries.length, lus = entries.map(e => e.lu);
  // recover projections, salaries, actual points
  const proj = solve(lus, P.length, entries.map(e => e.stkFP), 0.05), sal = solve(lus, P.length, entries.map(e => e.sal), 0.05), act = solve(lus, P.length, entries.map(e => e.actFP), 0.05);
  P.forEach((p, i) => { p.proj = Math.max(0, proj[i]); p.sal = Math.max(2000, Math.round(sal[i] / 100) * 100); p.act = act[i]; });
  const resid = Math.sqrt(mean(entries.map(e => (e.stkFP - e.lu.reduce((s, id) => s + P[id].proj, 0)) ** 2)));
  // payouts in units of the entry fee, from actual ROI by finish
  const pay = new Float64Array(N); for (const e of entries) if (e.finish >= 1 && e.finish <= N && e.actROI > -100) pay[e.finish - 1] = 1 + e.actROI / 100;
  const paid = pay.filter(x => x > 0).length, poolUnits = pay.reduce((s, x) => s + x, 0);
  console.log(`\n=== ${dir} ===`);
  console.log(`  ${N} entries (${L.length} rows), ${P.length} players, ${teams.length} teams, ${games.length} games; unmatched to MLB ref: ${unmatched.length}${unmatched.length ? " (" + unmatched.slice(0, 4).join(", ") + ")" : ""}; names not in player file: ${Object.keys(missNames).length}`);
  console.log(`  payouts: ${paid} paid of ${N}, pool ${poolUnits.toFixed(0)}x fee (rake ${(100 * (1 - poolUnits / N)).toFixed(1)}%), first ${pay[0].toFixed(0)}x; projection recovery residual ${resid.toFixed(2)} FP per lineup`);
  // Stokastic baseline
  const actFP = entries.map(e => e.actFP), stk = entries.map(e => e.stkROI), stkFP = entries.map(e => e.stkFP);
  const model = buildModel(pool), t0 = Date.now();
  const res = simulate({ pool, model, field: [], lineups: lus, payouts: pay, entries: N, fee: 1, iters: ITERS, rng: mulberry32(SEED), fieldMode: true });
  const mine = res.rows.map(r => r.roi), mineRank = res.rows.map(r => -r.avgRank);
  const cashSet = new Set(entries.map((e, i) => e.finish <= paid ? i : -1).filter(i => i >= 0));
  const k = Math.max(5, Math.round(N * 0.1));
  const realized = idx => mean(idx.map(i => entries[i].actROI));
  const fieldAvg = mean(entries.map(e => e.actROI));
  const row = { slate: dir.replace(/-mlb-main-|mlb-/, " "), N, paid,
    sStk: spearman(stk, actFP), sMine: spearman(mine, actFP), sProj: spearman(stkFP, actFP), sRank: spearman(mineRank, actFP), agree: spearman(mine, stk),
    cashStk: topOf(stk, paid).filter(i => cashSet.has(i)).length, cashMine: topOf(mine, paid).filter(i => cashSet.has(i)).length, cashRand: paid * paid / N,
    roiStk: realized(topOf(stk, k)), roiMine: realized(topOf(mine, k)), roiField: fieldAvg, k,
    pStk: spearman(P.filter(p => p.own > 0).map(p => p.stkROI), P.filter(p => p.own > 0).map(p => p.actROI)) };
  const myPR = playerROI(res, P, f); const prm = {}; myPR.forEach(r => prm[r.id] = r.roi);
  const pp = P.filter(p => p.own > 0 && prm[p.i] != null);
  row.pMine = spearman(pp.map(p => prm[p.i]), pp.map(p => p.actROI)); row.pAgree = spearman(pp.map(p => prm[p.i]), pp.map(p => p.stkROI));
  console.log(`  sim ${ITERS} iters in ${Date.now() - t0} ms | Spearman vs actual: Stokastic ROI ${row.sStk.toFixed(3)}, mine ${row.sMine.toFixed(3)}, projection ${row.sProj.toFixed(3)} | Stokastic-vs-me ${row.agree.toFixed(3)}`);
  console.log(`  top-${paid} by ROI that cashed: Stokastic ${row.cashStk}, mine ${row.cashMine}, random ${row.cashRand.toFixed(1)} | realized ROI of top-${k}: Stokastic ${row.roiStk.toFixed(0)}%, mine ${row.roiMine.toFixed(0)}%, whole field ${fieldAvg.toFixed(0)}%`);
  console.log(`  player ROI vs actual: Stokastic ${row.pStk.toFixed(3)}, mine ${row.pMine.toFixed(3)} (agree ${row.pAgree.toFixed(3)})`);
  // generator: same ownership targets as the real field, compare structure
  const gen = genField(pool, N, { rounds: 3 }, mulberry32(SEED));
  const show = (label, arr) => `${label}: ` + arr.slice(0, 6).map(([kk, v]) => `${kk} ${(100 * v / N).toFixed(0)}%`).join(", ");
  const dupReal = N - new Set(lus.map(l => sigOf(l, f))).size, dupMine = gen.field.length - new Set(gen.field.map(l => sigOf(l, f))).size;
  console.log(`  ${show("real stacks", dist(lus, P, f))}`);
  console.log(`  ${show("mine stacks", dist(gen.field, P, f))} | dupes real ${dupReal}, mine ${dupMine} | avg salary real ${mean(entries.map(e => e.sal)).toFixed(0)}, mine ${mean(gen.field.map(l => l.reduce((s, id) => s + P[id].sal, 0))).toFixed(0)}`);
  summary.push(row);
}
console.log("\n=== SUMMARY (Spearman vs actual points; cashed = of top-paid picks; realized = avg actual ROI of top 10% picks) ===");
console.log("slate".padEnd(34) + "N    paid  StkROI  MyROI  Proj   Agree | cash Stk/Me/rand | realized Stk / Me / field | playerROI Stk/Me");
for (const r of summary) console.log(r.slate.padEnd(34) + String(r.N).padEnd(5) + String(r.paid).padEnd(6) + r.sStk.toFixed(3).padEnd(8) + r.sMine.toFixed(3).padEnd(7) + r.sProj.toFixed(3).padEnd(7) + r.agree.toFixed(3).padEnd(6) + " | " + `${r.cashStk}/${r.cashMine}/${r.cashRand.toFixed(1)}`.padEnd(17) + " | " + `${r.roiStk.toFixed(0)}% / ${r.roiMine.toFixed(0)}% / ${r.roiField.toFixed(0)}%`.padEnd(26) + " | " + `${r.pStk.toFixed(2)}/${r.pMine.toFixed(2)}`);
const avg = k => mean(summary.map(r => r[k]));
console.log("AVERAGE".padEnd(34) + "".padEnd(11) + avg("sStk").toFixed(3).padEnd(8) + avg("sMine").toFixed(3).padEnd(7) + avg("sProj").toFixed(3).padEnd(7) + avg("agree").toFixed(3).padEnd(6) + " | " + `${avg("cashStk").toFixed(1)}/${avg("cashMine").toFixed(1)}/${avg("cashRand").toFixed(1)}`.padEnd(17) + " | " + `${avg("roiStk").toFixed(0)}% / ${avg("roiMine").toFixed(0)}% / ${avg("roiField").toFixed(0)}%`.padEnd(26) + " | " + `${avg("pStk").toFixed(2)}/${avg("pMine").toFixed(2)}`);

/* ---------- selection scores: which way of ranking lineups picks winners? ---------- */
// Re-run each slate collecting per-lineup features, then score fixed candidate rules.
const CAND = {
  "projection":          f => f.proj,
  "sim ROI":             f => f.roi,
  "sim cash %":          f => f.cash,
  "sim top 10 %":        f => f.t10,
  "sim avg rank":        f => -f.avgRank,
  "proj + ROI 50/50":    f => 0.5 * f.rProj + 0.5 * f.rROI,
  "proj + ROI 70/30":    f => 0.7 * f.rProj + 0.3 * f.rROI,
  "proj + top10 50/50":  f => 0.5 * f.rProj + 0.5 * f.rT10,
  "proj + leverage":     f => 0.7 * f.rProj + 0.3 * f.rLowOwn,
  "ROI, top-half proj":  f => f.rProj >= 0.5 ? f.roi : -1e9,
  "ROI, top-third proj": f => f.rProj >= 0.667 ? f.roi : -1e9,
  "cash + ROI 50/50":    f => 0.5 * f.rCash + 0.5 * f.rROI,
  "Stokastic ROI":       f => f.stkROI
};
const pctRank = arr => { const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]); const r = new Array(arr.length); idx.forEach((i, k) => r[i] = arr.length > 1 ? k / (arr.length - 1) : 0.5); return r; };
const SEL = {}; for (const c in CAND) SEL[c] = { sp: [], cash: [], real10: [], real3: [] };
for (const dir of dirs) {
  const D = path.join("data", dir), read = f => parseCSV(fs.readFileSync(path.join(D, f), "utf8"));
  const date = (dir.match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
  const sched = fs.existsSync(path.join(REF, `schedule-${date}.json`)) ? JSON.parse(fs.readFileSync(path.join(REF, `schedule-${date}.json`), "utf8")) : [];
  const opp = {}; for (const g of sched) { opp[g.home] = g.away; opp[g.away] = g.home; }
  const L = read("DK_MLB_Night_Data_Hub_Lineup.csv").slice(1).map(r => ({ stkROI: num(r[1]), actROI: num(r[2]), stkFP: num(r[3]), actFP: num(r[4]), own: num(r[5]), finish: num(r[6]), names: r[9].split(",").map(s => s.trim()) }));
  const PL = read("DK_MLB_Night_Data_Hub_Player.csv").slice(1).map(r => ({ name: r[0], pos: r[1], own: num(r[4]) }));
  const P = [], byKey = {};
  PL.forEach(pl => { const ref = lookup(pl.name), team = ref ? ref.team : ""; const plist = pl.pos.split("/"), isP = plist.includes("SP") || plist.includes("RP");
    const p = { name: pl.name, key: nrm(pl.name), pos: isP ? "P" : plist[0], posList: isP ? ["P"] : plist, team, opp: opp[team] || "", sal: 0, csal: 0, proj: 0, own: pl.own, fown: pl.own, cown: 0, ceil: null, sd: null, ord: null, isP };
    byKey[p.key] = P.length; P.push(p); });
  const teams = [...new Set(P.map(p => p.team).filter(Boolean))].sort(), gmap = {}, games = [];
  P.forEach((p, i) => { const k = p.team && p.opp ? [p.team, p.opp].sort().join("@") : (p.team || "?"); if (gmap[k] == null) { gmap[k] = games.length; games.push(k); } p.i = i; p.gi = gmap[k]; p.ti = teams.indexOf(p.team); });
  const f = FORMATS.mlb_cl, pool = { players: P, teams, games, src: "post-contest", format: f };
  const entries = []; for (const e of L) { const ids = e.names.map(nm => byKey[nrm(nm)]); if (ids.some(x => x == null)) continue; const lu = assignSlots(ids, P, f); if (lu) entries.push({ ...e, lu }); }
  const N = entries.length, lus = entries.map(e => e.lu);
  const proj = solve(lus, P.length, entries.map(e => e.stkFP), 0.05); P.forEach((p, i) => { p.proj = Math.max(0, proj[i]); });
  const pay = new Float64Array(N); for (const e of entries) if (e.finish >= 1 && e.finish <= N && e.actROI > -100) pay[e.finish - 1] = 1 + e.actROI / 100;
  const paid = pay.filter(x => x > 0).length;
  const res = simulate({ pool, model: buildModel(pool), field: [], lineups: lus, payouts: pay, entries: N, fee: 1, iters: ITERS, rng: mulberry32(SEED), fieldMode: true });
  const feats = entries.map((e, i) => ({ proj: e.stkFP, roi: res.rows[i].roi, cash: res.rows[i].cash, t10: res.rows[i].t10, avgRank: res.rows[i].avgRank, own: e.own, stkROI: e.stkROI }));
  const rProj = pctRank(feats.map(x => x.proj)), rROI = pctRank(feats.map(x => x.roi)), rT10 = pctRank(feats.map(x => x.t10)), rCash = pctRank(feats.map(x => x.cash)), rLowOwn = pctRank(feats.map(x => -x.own));
  feats.forEach((x, i) => { x.rProj = rProj[i]; x.rROI = rROI[i]; x.rT10 = rT10[i]; x.rCash = rCash[i]; x.rLowOwn = rLowOwn[i]; });
  const actFP = entries.map(e => e.actFP), cashSet = new Set(entries.map((e, i) => e.finish <= paid ? i : -1).filter(i => i >= 0));
  const k10 = Math.max(5, Math.round(N * 0.1));
  for (const c in CAND) {
    const s = feats.map(CAND[c]); const top = topOf(s, N);
    SEL[c].sp.push(spearman(s, actFP));
    SEL[c].cash.push(top.slice(0, paid).filter(i => cashSet.has(i)).length / paid * N / paid);   // cash hits relative to random expectation
    SEL[c].real10.push(mean(top.slice(0, k10).map(i => entries[i].actROI)));
    SEL[c].real3.push(mean(top.slice(0, 3).map(i => entries[i].actROI)));
  }
}
console.log("\n=== SELECTION RULES across " + dirs.length + " contests (higher is better everywhere) ===");
console.log("rule".padEnd(24) + "Spearman vs actual   cash hits vs random   realized ROI top 10%   realized ROI top 3   slates with top-3 profit");
for (const c in CAND) {
  const s = SEL[c];
  console.log(c.padEnd(24) + mean(s.sp).toFixed(3).padEnd(21) + (mean(s.cash)).toFixed(2).padEnd(22) + (mean(s.real10).toFixed(0) + "%").padEnd(23) + (mean(s.real3).toFixed(0) + "%").padEnd(21) + s.real3.filter(x => x > 0).length + "/" + s.real3.length);
}
