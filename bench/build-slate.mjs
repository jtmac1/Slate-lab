// Build what the app would build for a slate, in Node: Contest Generator field (Marquee archetype,
// measured MLB stack mix) simmed against itself with the current engine defaults, then the default
// gated selection. Writes the ranking and the top picks next to the projections file.
//   node bench/build-slate.mjs data/2026-09-16-mlb-early [entries=1000] [pctToFirst=10] [rake=15] [pick=20] [seed=1] [iters=5000]
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";
import { buildPool } from "../src/engine/formats.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate, playerROI } from "../src/engine/sim.mjs";
import { fitPayouts, paidCount } from "../src/engine/payouts.mjs";
import { featurize, selectScore, DEFAULT_RULE } from "../src/engine/select.mjs";
import { sigOf, salOf, projOf, ownSum, stackOf, stackTeams } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { mlbStackOpt } from "./grade-all.mjs";

const [dir, entriesArg = "1000", pctArg = "10", rakeArg = "15", pickArg = "20", seedArg = "1", itersArg = "5000"] = process.argv.slice(2);
const N = +entriesArg, PCT = +pctArg, RAKE = +rakeArg, PICK = +pickArg, SEED = +seedArg, ITERS = +itersArg;
const file = fs.readdirSync(dir).find(f => /Data_Hub_Projections\.csv$/i.test(f)) || fs.readdirSync(dir).find(f => /\.csv$/i.test(f));
const all = parseCSV(fs.readFileSync(path.join(dir, file), "utf8")), headers = all[0], rows = all.slice(1).filter(r => r.length > 1);
const pool = buildPool(headers, rows, "mlb_cl"), P = pool.players, f = pool.format;
const dkId = {}; const idCol = headers.findIndex(h => /^dk id$/i.test(h)); if (idCol >= 0) rows.forEach((r, i) => { const p = P.find(q => q.name === r[headers.findIndex(h => /^player$/i.test(h))]); if (p) dkId[p.i] = r[idCol]; });
console.log(`${file}: ${P.length} players (${P.filter(p => p.proj > 0).length} projected), ${pool.teams.length} teams, ${pool.games.length} games; source "${pool.src}"`);

// Contest Generator, Marquee archetype (conc 1.0, minSal 49000, boost 1.0, 3 rounds), measured stack mix
const opt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 }, mlbStackOpt());
let t0 = Date.now();
const g = genField(pool, N, opt, mulberry32(SEED));
const field = g.field, sig = {}; for (const l of field) { const k = sigOf(l, f); sig[k] = (sig[k] || 0) + 1; }
console.log(`field: ${field.length} entries, ${Object.keys(sig).length} unique, seed ${SEED}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// payouts as the app's default table: rake and % to first, 22% paid
const poolUnits = N * (1 - RAKE / 100), pay = fitPayouts(N, poolUnits, poolUnits * PCT / 100, 22);
t0 = Date.now();
const model = buildModel(pool, {});
const res = simulate({ pool, model, field: [], lineups: field, payouts: pay, entries: N, fee: 1, iters: ITERS, maxIters: ITERS * 4, rng: mulberry32(SEED), fieldMode: true });
console.log(`sim: ${res.iters} draws, ${paidCount(pay)} paid, ${PCT}% to first, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

res.rows.forEach(r => { r.sal = salOf(r.lu, P, f); r.projFP = projOf(r.lu, P, f); r.own = ownSum(r.lu, P, f); r.dupN = sig[sigOf(r.lu, f)] - 1; r.stack = stackOf(r.lu, P, f); r.teams = stackTeams(r.lu, P, f).filter(x => x[1] >= 2).map(x => x[0] + x[1]).join(" "); });
const feats = featurize(res.rows.map(r => ({ proj: r.projFP, roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: r.own, dupN: r.dupN })));
const score = selectScore(feats, 50);
res.rows.forEach((r, i) => { r.score = score[i]; r.rProj = feats[i].rProj; });
const byScore = res.rows.map((r, i) => i).sort((a, b) => res.rows[b].score - res.rows[a].score);
const byROI = res.rows.map((r, i) => i).sort((a, b) => res.rows[b].roi - res.rows[a].roi);
// distinct picks: skip a lineup that duplicates one already picked
const pick = (order, n) => { const out = [], seen = new Set(); for (const i of order) { const k = sigOf(res.rows[i].lu, f); if (seen.has(k)) continue; seen.add(k); out.push(i); if (out.length >= n) break; } return out; };
const picks = pick(byScore, PICK), roiPicks = pick(byROI, PICK);
const names = lu => lu.map(id => P[id].name), teamsOf = lu => lu.map(id => P[id].team), line = (i, k) => { const r = res.rows[i]; return `${String(k + 1).padStart(2)}  ROI ${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(0)}%${r.se ? " ±" + r.se.toFixed(0) : ""}  proj ${r.projFP.toFixed(1)} (pct ${(100 * r.rProj).toFixed(0)})  own ${r.own.toFixed(0)}  sal ${r.sal}  dup ${r.dupN}  ${r.stack.padEnd(6)} ${r.teams.padEnd(14)} ${names(r.lu).join(", ")}`; };
console.log(`\n=== ${DEFAULT_RULE}: top ${PICK} (distinct) ===`); picks.forEach((i, k) => console.log(line(i, k)));
console.log(`\n=== plain Sim ROI: top ${Math.min(5, PICK)} ===`); roiPicks.slice(0, 5).forEach((i, k) => console.log(line(i, k)));
const pr = playerROI(res, P, f).filter(p => p.exp >= 1);
console.log(`\n=== player ROI (field exposure >= 1%) top 15 ===`); pr.slice(0, 15).forEach(p => console.log(`  ${p.name.padEnd(24)} ${p.pos.padEnd(6)} ${p.team.padEnd(4)} exp ${p.exp.toFixed(1).padStart(5)}%  proj own ${(P[p.id].own || 0).toFixed(1).padStart(5)}%  ROI ${p.roi >= 0 ? "+" : ""}${p.roi.toFixed(0)}%`));
console.log(`\n=== player ROI bottom 8 ===`); pr.slice(-8).forEach(p => console.log(`  ${p.name.padEnd(24)} ${p.pos.padEnd(6)} ${p.team.padEnd(4)} exp ${p.exp.toFixed(1).padStart(5)}%  proj own ${(P[p.id].own || 0).toFixed(1).padStart(5)}%  ROI ${p.roi.toFixed(0)}%`));

const out = { built: new Date().toISOString(), file, entries: N, pctToFirst: PCT, rake: RAKE, seed: SEED, iters: res.iters, model: "hitSame 0.22 / hitter sigma 0.70", rule: DEFAULT_RULE,
  picks: picks.map((i, k) => ({ rank: k + 1, ...pickRow(i) })), roiPicks: roiPicks.map((i, k) => ({ rank: k + 1, ...pickRow(i) })),
  playerROI: pr.map(p => ({ name: p.name, pos: p.pos, team: p.team, exp: +p.exp.toFixed(2), projOwn: +(P[p.id].own || 0).toFixed(2), roi: +p.roi.toFixed(1) })),
  field: res.rows.map(r => ({ names: names(r.lu), teams: teamsOf(r.lu), ids: r.lu.map(id => dkId[id] || null), roi: +r.roi.toFixed(1), cash: +r.cash.toFixed(3), t10: +r.t10.toFixed(3), proj: +r.projFP.toFixed(2), own: +r.own.toFixed(1), sal: r.sal, dup: r.dupN, stack: r.stack, score: r.score > -1e8 ? +r.score.toFixed(1) : null })) };
function pickRow(i) { const r = res.rows[i]; return { roi: +r.roi.toFixed(1), se: r.se != null ? +r.se.toFixed(1) : null, cash: +r.cash.toFixed(3), t10: +r.t10.toFixed(3), proj: +r.projFP.toFixed(2), projPct: +(100 * r.rProj).toFixed(0), own: +r.own.toFixed(1), sal: r.sal, dup: r.dupN, stack: r.stack, teams: r.teams, names: names(r.lu), playerTeams: teamsOf(r.lu), ids: r.lu.map(id => dkId[id] || null) }; }
const outFile = path.join(dir, `build-${N}-seed${SEED}.json`); fs.writeFileSync(outFile, JSON.stringify(out));
const csv = [["Rank", "Sim ROI", "Score", "Proj FP", "OwnSum", "Salary", "Dupes", "Stack"].concat(f.slots).join(",")].concat(picks.map((i, k) => { const r = res.rows[i]; return [k + 1, r.roi.toFixed(1) + "%", r.score.toFixed(1), r.projFP.toFixed(2), r.own.toFixed(1), r.sal, r.dupN, r.stack].concat(names(r.lu)).join(","); }));
fs.writeFileSync(path.join(dir, `picks-${N}-seed${SEED}.csv`), csv.join("\n") + "\n");
console.log(`\nwrote ${outFile} and picks-${N}-seed${SEED}.csv`);
