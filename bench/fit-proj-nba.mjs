// Backtest of the lab NBA projection (src/engine/nba-proj.mjs) vs Stokastic, 2025-26 classic slates, walk-forward: each date is
// projected only from ESPN box scores of earlier dates (2024-25 in data/nba-pbp/2024-25 as last season). Eval = player-slates
// Stokastic projected 5+ with a known result (DNP = 0), bench/nba-player-rows.mjs. FAIR = availability from the previous game only
// (P(play) by consecutive misses); ORACLE = who actually played (upper bound on what injury news is worth). Priors and parameters
// fitted on odd dates, everything reported on even dates; blend = w x Stokastic + (1 - w) x lab, w fitted on odd dates.
//   node bench/fit-proj-nba.mjs [--nofit]   -> data/reports/nba/proj-lab.json + .txt
import fs from "node:fs";
import { loadRows, nm, bucketOf, BUCKETS, mean, ols } from "./nba-player-rows.mjs";
import { loadGames } from "./nba-espn.mjs";
import { indexHistory, projectSlate, PROJ, espnTeam } from "../src/engine/nba-proj.mjs";

const OUT = "data/reports/nba"; fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), log = s => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const { rows: all } = loadRows();
const games = loadGames({ to: "2026-07-01" }), H = indexHistory(games);
const rows = all.filter(r => r.proj >= 5 && r.act != null);
const dates = [...new Set(rows.map(r => r.date))].sort(), fold = new Map(dates.map((d, i) => [d, i % 2])), odd = r => fold.get(r.date) === 1;
log(`${games.length} games, ${rows.length} eval rows, ${dates.length} dates`);

// per date: union of slate players, ESPN id, home teams, who played
const day = new Map();
const lastOf = n => nm(String(n).replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, "").split(" ").pop());
for (const d of dates) {
  const G = games.filter(g => g.date === d), home = new Set(G.map(g => g.home)), played = new Set(), roster = new Map();
  for (const g of G) for (const t in g.teams) for (const p of g.teams[t].players) { if (!p.dnp && p.min > 0) played.add(p.id); roster.set(t + "|" + nm(p.name), p.id); const lk = t + "|L" + lastOf(p.name); roster.set(lk, roster.has(lk) ? null : p.id); }
  day.set(d, { home, played, roster, stok: new Set(), P: new Map() });
}
let unmatched = 0;
for (const r of all.filter(r => fold.has(r.date))) {
  const D = day.get(r.date), t = espnTeam(r.team), k = nm(r.name); r.key = k; if (D.P.has(k)) continue;
  const id = D.roster.get(t + "|" + k) || D.roster.get(t + "|L" + lastOf(r.name)) || H.nameToId.get(k); if (!id && r.proj >= 5) unmatched++;
  D.P.set(k, { name: r.name, team: t, opp: espnTeam(r.opp), pos: r.posStr, sal: r.sal, id }); if (id) D.stok.add(id);
}
log(`unmatched eval players ${unmatched}`);

// run the model for every date; returns Map date|key -> {fair, oracle, ...}
function run(P, modes = ["fair", "oracle", "stok"]) {
  const res = new Map();
  for (const d of dates) { const D = day.get(d), inp = [...D.P.entries()];
    for (const mode of modes) {
      const out = projectSlate(H, d, inp.map(([, p]) => p), P, { home: D.home, played: mode === "oracle" ? D.played : mode === "stok" ? D.stok : null });
      out.forEach((o, i) => { if (i >= inp.length) return; const k = d + "|" + inp[i][0], x = res.get(k) || res.set(k, {}).get(k); x[mode] = o.projection; x[mode + "Min"] = o.minutes; x.miss = o.miss; x.gp = o.gp; x.pFull = o.projFull; });
      if (mode === "fair") for (const o of out.slice(inp.length)) (D.extra || (D.extra = [])).push(o);
    } }
  return res;
}
const maeOn = (P, R, mode = "fair") => { const res = run(P, [mode]); let s = 0; for (const r of R) s += Math.abs(res.get(r.date + "|" + r.key)[mode] - r.act); return s / R.length; };

// salary priors (odd dates, played): minutes ~ a + b sal; DK/min ~ c_pos + d sal (minutes-weighted)
const train = rows.filter(odd), test = rows.filter(r => !odd(r));
const pg = pos => { const p = String(pos).split("/"); return p.includes("C") ? "C" : p.some(x => x === "PG" || x === "SG") ? "G" : "F"; };
const P = structuredClone(PROJ), FIT = !process.argv.includes("--nofit");
if (FIT) {
  const pl = train.filter(r => !r.dnp && r.min > 0);
  const [a, b] = ols(pl.map(r => [1, r.sal / 1000]), pl.map(r => r.min)); P.minPrior = { a: +a.toFixed(2), b: +b.toFixed(3) };
  for (const g of ["G", "F", "C"]) { const q = pl.filter(r => pg(r.posStr) === g); const [c, d] = ols(q.map(r => [1, r.sal / 1000]), q.map(r => r.act / r.min), 1e-6, q.map(r => r.min)); P.ratePrior[g] = [+c.toFixed(3), +d.toFixed(4)]; }
  log(`priors ${JSON.stringify({ minPrior: P.minPrior, ratePrior: P.ratePrior })}`);
  // P(play) by consecutive misses (odd dates, rotation players: full projection 15+)
  { const res = run({ ...P, PPLAY: [1, 1, 1, 1, 1] }, ["fair"]), c = [0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0];
    for (const d of dates.filter(d => fold.get(d) === 1)) { const D = day.get(d);
      for (const [k] of D.P) { const x = res.get(d + "|" + k); if (!x || x.pFull < 15) continue; const id = D.P.get(k).id; n[x.miss]++; if (D.played.has(id)) c[x.miss]++; }
      for (const o of D.extra || []) if (o.projFull >= 15) { n[o.miss]++; if (D.played.has(o.id)) c[o.miss]++; } }
    P.PPLAY = c.map((x, i) => i === 0 ? 1 : +(x / Math.max(1, n[i])).toFixed(2)); log(`P(play) by misses ${JSON.stringify(P.PPLAY)} n ${JSON.stringify(n)}`); }
  for (const d of dates) delete day.get(d).extra;
  // coordinate descent on held-in MAE, oracle availability (structure only; fair adds P(play))
  const GRID = { HM: [1.5, 2, 3, 5, 8, 12], HR: [3, 5, 8, 15, 25, 40], KM: [0.5, 1, 1.5, 3, 5], KR: [20, 40, 60, 100, 200], WS: [0.05, 0.1, 0.2, 0.35, 0.5, 1], S: [0, 2, 4, 6, 8],
    B2B: [0, 0.02, 0.04, 0.06], BL: [0, 0.004, 0.008, 0.015], OPP: [0, 0.25, 0.5, 0.75, 1], HT: [5, 10, 20], RET: [0, 0.5, 1] };
  let best = maeOn(P, train, "oracle"); log(`start train oracle MAE ${best.toFixed(4)}`);
  for (let pass = 0; pass < 2; pass++) { let moved = false;
    for (const k of Object.keys(GRID)) { const cur = P[k]; let bv = cur;
      for (const v of GRID[k]) { if (v === cur) continue; const m = maeOn({ ...P, [k]: v }, train, "oracle"); if (m < best - 1e-4) { best = m; bv = v; } }
      if (bv !== cur) { P[k] = bv; moved = true; } log(`pass ${pass} ${k}=${P[k]} train MAE ${best.toFixed(4)}`); }
    if (!moved) break; }
}
// sensitivity (train MAE) per parameter at the fit
const OFF = { S: 0, B2B: 0, BL: 0, OPP: 0, RET: 0, WS: 1 }, sens = {}, sensTest = {};
for (const [k, v0] of Object.entries(OFF)) { sens[k] = [[v0, +maeOn({ ...P, [k]: v0 }, train, "oracle").toFixed(4)], [P[k], +maeOn(P, train, "oracle").toFixed(4)]]; sensTest[k] = [[v0, +maeOn({ ...P, [k]: v0 }, test, "oracle").toFixed(4)], [P[k], +maeOn(P, test, "oracle").toFixed(4)]]; }
log(`sens ${JSON.stringify(sens)}`);

// final run + metrics
const res = run(P);
for (const r of rows) { const x = res.get(r.date + "|" + r.key); r.fair = x.fair; r.oracle = x.oracle; r.stokAv = x.stok; r.gpLab = x.gp; }
const fitW = (R, f) => { let bw = 0, bm = 1e9; for (let w = 0; w <= 1.0001; w += 0.01) { const m = mean(R.map(r => Math.abs(w * r.proj + (1 - w) * r[f] - r.act))); if (m < bm) { bm = m; bw = +w.toFixed(2); } } return bw; };
const W = { fair: fitW(train, "fair"), oracle: fitW(train, "oracle"), stok: fitW(train, "stokAv") };
for (const r of rows) { r.blendFair = W.fair * r.proj + (1 - W.fair) * r.fair; r.blendOracle = W.oracle * r.proj + (1 - W.oracle) * r.oracle; r.blendStok = W.stok * r.proj + (1 - W.stok) * r.stokAv; }
const SRC = { stok: "proj", lab: "fair", labStokAv: "stokAv", labOracle: "oracle", blend: "blendFair", blendStokAv: "blendStok", blendOracle: "blendOracle" };
const corr = (x, y) => { const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return a / Math.sqrt(b * c); };
const met = R => Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, { mae: +mean(R.map(r => Math.abs(r[f] - r.act))).toFixed(3), bias: +mean(R.map(r => r[f] - r.act)).toFixed(3), r: +corr(R.map(r => r[f]), R.map(r => r.act)).toFixed(3) }]));
// date-block bootstrap CI of MAE(blend) - MAE(stok)
const boot = (R, f, B = 2000) => { const by = new Map(); for (const r of R) { const a = by.get(r.date) || by.set(r.date, [0, 0]).get(r.date); a[0] += Math.abs(r[f] - r.act) - Math.abs(r.proj - r.act); a[1]++; }
  const G = [...by.values()]; let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, o = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < G.length; i++) { const g = G[Math.floor(rnd() * G.length)]; s += g[0]; n += g[1]; } o.push(s / n); }
  o.sort((a, b) => a - b); return [+o[Math.floor(0.025 * B)].toFixed(3), +o[Math.floor(0.975 * B)].toFixed(3)]; };
const tier = s => s < 5000 ? "<5K" : s < 7000 ? "5-7K" : s < 9000 ? "7-9K" : "9K+";
const early = r => r.date < "2025-11-20";
const groups = { all: () => true, ...Object.fromEntries(BUCKETS.map(b => [b, r => bucketOf(r.games) === b])), ...Object.fromEntries(["<5K", "5-7K", "7-9K", "9K+"].map(t => [t, r => tier(r.sal) === t])),
  "first month (<11/20)": early, "after 11/20": r => !early(r), "missed prev game": r => r.missedPrev, "played (no DNP)": r => !r.dnp, "lab <5 gp": r => r.gpLab < 5 };
const table = {}; for (const [g, f] of Object.entries(groups)) { const R = test.filter(f); if (R.length < 30) continue; table[g] = { n: R.length, ...met(R), ciBlendMinusStok: boot(R, "blendFair"), ciBlendStokMinusStok: boot(R, "blendStok"), ciBlendOracleMinusStok: boot(R, "blendOracle") }; }
const trainAll = met(train);
// linear blend a + b x Stokastic + c x lab (OLS on odd dates), held out
const lin = {}; for (const k of ["fair", "stokAv", "oracle"]) { const c = ols(train.map(r => [1, r.proj, r[k]]), train.map(r => r.act)), pr = r => c[0] + c[1] * r.proj + c[2] * r[k];
  for (const r of rows) r["lin_" + k] = pr(r); const tp = test.filter(r => !r.dnp);
  lin[k] = { coef: c.map(x => +x.toFixed(3)), mae: +mean(test.map(r => Math.abs(pr(r) - r.act))).toFixed(3), ci: boot(test, "lin_" + k), maePlayed: +mean(tp.map(r => Math.abs(pr(r) - r.act))).toFixed(3), ciPlayed: boot(tp, "lin_" + k) }; }
{ const c = ols(train.map(r => [1, r.proj]), train.map(r => r.act)); for (const r of rows) r.lin_stok = c[0] + c[1] * r.proj; lin.stokOnly = { coef: c.map(x => +x.toFixed(3)), mae: +mean(test.map(r => Math.abs(r.lin_stok - r.act))).toFixed(3), ci: boot(test, "lin_stok") }; }
// blend weight stability: fit on even, check on odd too
const W2 = { fair: fitW(test, "fair"), oracle: fitW(test, "oracle"), stok: fitW(test, "stokAv") };

const fmt = (x, w = 8) => String(x).padStart(w), K = Object.keys(SRC);
let txt = `NBA lab projection (minutes x DK pts/min, box scores only) vs Stokastic, 2025-26 classic, walk-forward. Built 2026-10-21.\n`;
txt += `${games.length} ESPN games (2024-25 + 2025-26), ${rows.length} player-slates (Stokastic proj 5+, DNP = 0), ${dates.length} dates; fit on odd dates (${train.length}), HELD OUT even dates (${test.length}).\n`;
txt += `Availability: lab = FAIR, previous game only (P(play) by consecutive team games missed ${JSON.stringify(P.PPLAY)}); labStokAv = plays iff Stokastic projects him > 0 at lock\n  (pre-lock news, usable live); labOracle = knows who played (not his minutes). Never the game's own minutes or starter flag.\n`;
txt += `Blend = w x Stokastic + (1-w) x lab, w fit on odd dates: fair ${W.fair}, stokAv ${W.stok}, oracle ${W.oracle} (fit on even dates instead: ${W2.fair} / ${W2.stok} / ${W2.oracle}).\n`;
txt += `Params ${JSON.stringify(P)}\n(full fit 2026-10-21 picked B2B 0 and BL 0.004; BL did not hold out (held-out MAE 7.8085 vs 7.8070 off), so both ship at 0.)\n\nHELD OUT (even dates) MAE. CI = 95% date-block bootstrap of MAE(blend) - MAE(Stokastic), negative = blend better.\n`;
txt += `${"group".padEnd(21)}${fmt("n", 6)}${K.map(k => fmt(k, 12)).join("")}   blend-stok        blendStokAv-stok  blendOracle-stok\n`;
for (const [g, t] of Object.entries(table)) txt += `${g.padEnd(21)}${fmt(t.n, 6)}${K.map(k => fmt(t[k].mae.toFixed(3), 12)).join("")}   ${("[" + t.ciBlendMinusStok.join(",") + "]").padEnd(18)}${("[" + t.ciBlendStokMinusStok.join(",") + "]").padEnd(18)}[${t.ciBlendOracleMinusStok.join(",")}]\n`;
txt += `\nHELD OUT bias (pred - actual) / r\n`;
for (const [g, t] of Object.entries(table)) txt += `${g.padEnd(21)}${fmt(t.n, 6)}${K.map(k => fmt(t[k].bias.toFixed(2) + "/" + t[k].r.toFixed(2), 12)).join("")}\n`;
txt += `\nLinear blend a + b x Stokastic + c x lab (OLS, odd dates), held-out MAE [CI vs raw Stokastic]:\n${Object.entries(lin).map(([k, v]) => `  ${k.padEnd(9)} coef ${v.coef.join(" / ")}  MAE ${v.mae} [${v.ci}]${v.ciPlayed ? `  | played only ${v.maePlayed} [${v.ciPlayed}]` : ""}`).join("\n")}\n`;
txt += `\nTrain (odd) MAE: ${Object.entries(trainAll).map(([k, v]) => `${k} ${v.mae}`).join(", ")}\n`;
txt += `Sensitivity, oracle-availability MAE with the term off vs fitted: train ${JSON.stringify(sens)}\n  held out ${JSON.stringify(sensTest)}\n`;
fs.writeFileSync(`${OUT}/proj-lab.txt`, txt);
fs.writeFileSync(`${OUT}/proj-lab.json`, JSON.stringify({ built: "2026-10-21", params: P, blendW: W, blendWEvenFit: W2, heldOut: table, linearBlend: lin, train: trainAll, sensitivity: { train: sens, test: sensTest }, n: { games: games.length, rows: rows.length, dates: dates.length, unmatched } }, null, 1));
console.log(txt);
