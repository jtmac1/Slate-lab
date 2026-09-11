// Benchmark: MLB night slate 2026-09-10 against Stokastic's contest sim and the real
// 100-entry DraftKings contest 195475515 ($333, $30K pool, $10K to first).
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm, num } from "../src/engine/csv.mjs";
import { buildPool } from "../src/engine/formats.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { genField } from "../src/engine/field.mjs";
import { simulate, playerROI, stackROI } from "../src/engine/sim.mjs";
import { fitPayouts, parsePayoutTable, payoutSum } from "../src/engine/payouts.mjs";
import { matchLineups, sigOf, stackOf, assignSlots, projOf } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const DIR = path.resolve("data/mlb-2026-09-10");
const read = f => parseCSV(fs.readFileSync(path.join(DIR, f), "utf8"));
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "-";
const seed = +(process.argv[2] || 1), ITERS = +(process.argv[3] || 20000);

function spearman(a, b) {
  const rk = x => { const idx = x.map((v, i) => i).sort((i, j) => x[i] - x[j]); const r = new Array(x.length); let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && x[idx[j + 1]] === x[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg; i = j + 1; } return r; };
  const ra = rk(a), rb = rk(b), n = a.length, ma = (n + 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - ma) * (rb[i] - ma); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - ma) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
function dist(lus, P, f) { const d = {}; for (const l of lus) { const k = stackOf(l, P, f); d[k] = (d[k] || 0) + 1; } return Object.entries(d).sort((a, b) => b[1] - a[1]); }

/* ---------- pool ---------- */
const projRows = read("DK_MLB_Night_Data_Hub_Projections.csv");
const pool = buildPool(projRows[0], projRows.slice(1), "mlb_cl");
const P = pool.players, f = pool.format;
console.log(`POOL: ${P.length} players with projections, ${P.filter(p => p.own > 0).length} with ownership, teams ${pool.teams.join("/")}, games ${pool.games.join(" ")}, source "${pool.src}"`);

/* ---------- stack shares from Top Stacks ---------- */
const ts = read("DK_MLB_Night_Data_Hub_Topstacks.csv");
const share = {}; ts.slice(1).forEach(r => { share[r[0]] = num(r[5]) || 0; });
console.log("TOP STACK %:", JSON.stringify(share));

/* ---------- Stokastic field + sim results ---------- */
const genRows = read("DK_MLB_Night_Contest_Generator_Lineup.csv");
const gi = genRows[0].indexOf("P");
const stkField = matchLineups(genRows.slice(1).map(r => r.slice(gi, gi + 10)), P, f);
const simRows = read("DK_MLB_Night_Pre_Contest_Lineups.csv");
const si = simRows[0].indexOf("P");
const stkSim = matchLineups(simRows.slice(1).map(r => r.slice(si, si + 10)), P, f);
const stkROI = simRows.slice(1).map(r => num(r[0])), stkWin = simRows.slice(1).map(r => num(r[5])), stkCash = simRows.slice(1).map(r => num(r[7]));
console.log(`STOKASTIC: field ${stkField.lineups.length} lineups (missing names: ${JSON.stringify(stkField.missing)}), sim ${stkSim.lineups.length} lineups`);

/* ---------- real contest ---------- */
const st = read(fs.readdirSync(DIR).find(x => /^contest-standings.*\.csv$/.test(x)));
const actual = {}, drafted = {};
for (const r of st.slice(1)) { if (r[7]) { actual[nrm(r[7])] = num(r[10]); drafted[nrm(r[7])] = num(r[9]); } }
const posRe = /\b(P|C|1B|2B|3B|SS|OF)\s+/g;
const realRaw = st.slice(1).filter(r => /^\d+$/.test(String(r[0]).trim())).map(r => ({ rank: +r[0], name: r[2], pts: num(r[4]), lineup: r[5] }));
const byKey = {}; P.forEach((p, i) => { if (byKey[p.key] == null) byKey[p.key] = i; });
const real = [], realMissing = {};
for (const e of realRaw) {
  const names = e.lineup.split(posRe).map(s => s.trim()).filter(s => s && !/^(P|C|1B|2B|3B|SS|OF)$/.test(s));
  const ids = names.map(nm => byKey[nrm(nm)]);
  if (ids.some(x => x == null)) { names.forEach((nm, k) => { if (ids[k] == null) realMissing[nm] = (realMissing[nm] || 0) + 1; }); continue; }
  const lu = assignSlots(ids, P, f); if (!lu) { realMissing["<slots>"] = (realMissing["<slots>"] || 0) + 1; continue; }
  real.push({ ...e, lu });
}
console.log(`REAL: ${real.length} of ${realRaw.length} entries matched to the pool (missing: ${JSON.stringify(realMissing)})`);
const actualPts = lu => { let s = 0; for (const id of lu) { const a = actual[P[id].key]; if (a == null) return null; s += a; } return s; };
let chk = 0, chkN = 0; for (const e of real) { const a = actualPts(e.lu); if (a != null) { chkN++; if (Math.abs(a - e.pts) < 0.05) chk++; } }
console.log(`REAL: recomputed points match DK for ${chk}/${chkN} entries`);

/* ---------- model ---------- */
let t0 = Date.now();
const model = buildModel(pool);
console.log(`MODEL: ${model.type}, ${P.length} players, built in ${Date.now() - t0} ms`);

/* ---------- 1. field generator vs Stokastic field vs real field ---------- */
console.log("\n=== FIELD GENERATOR ===");
t0 = Date.now();
const mine250 = genField(pool, 250, { stackTeams: share, minSal: 48000, rounds: 3 }, mulberry32(seed), l => console.log("  " + l));
console.log(`generated 250 in ${Date.now() - t0} ms; unique ${new Set(mine250.field.map(l => sigOf(l, f))).size}`);
const mine100 = genField(pool, 100, { stackTeams: share, minSal: 48000, rounds: 3 }, mulberry32(seed + 7));
const show = (label, lus) => console.log(`  ${label.padEnd(18)} ` + dist(lus, P, f).slice(0, 7).map(([k, v]) => `${k}:${pct(v, lus.length)}`).join("  "));
show("mine (250)", mine250.field); show("stokastic (250)", stkField.lineups); show("real (100)", real.map(e => e.lu)); show("mine (100)", mine100.field);
// exposure vs real %Drafted and vs Stokastic projected ownership
const expoRows = P.filter(p => p.own > 0 || drafted[p.key]).map(p => ({ name: p.name, proj: p.own, real: drafted[p.key] || 0,
  mine: mine100.expo[p.i] / mine100.field.length * 100, stk: stkField.lineups.reduce((s, l) => s + (l.includes(p.i) ? 1 : 0), 0) / stkField.lineups.length * 100 }));
const mad = (k1, k2) => (expoRows.reduce((s, r) => s + Math.abs(r[k1] - r[k2]), 0) / expoRows.length).toFixed(2);
console.log(`  exposure gap (mean abs pts): mine vs projected own ${mad("mine", "proj")} | stokastic field vs projected ${mad("stk", "proj")} | projected vs REAL drafted ${mad("proj", "real")} | mine vs REAL ${mad("mine", "real")} | stokastic vs REAL ${mad("stk", "real")}`);
console.log("  biggest projected-vs-real misses: " + expoRows.slice().sort((a, b) => Math.abs(b.proj - b.real) - Math.abs(a.proj - a.real)).slice(0, 6).map(r => `${r.name} proj ${r.proj.toFixed(0)} real ${r.real.toFixed(0)}`).join("; "));

/* ---------- 2. replicate Stokastic's sim: their 242 lineups, pool 250, 35% to first ---------- */
console.log("\n=== SIM vs STOKASTIC (their 242 lineups as the whole 250-entry field) ===");
const fee = 333, FE250 = 250, pool250 = FE250 * fee * 0.852, pay250 = fitPayouts(FE250, pool250, pool250 * 0.35, 22);
// weight duplicates like their field: each unique lineup once plus the 8 dupes
const dupCount = {}; for (const l of stkField.lineups) { const k = sigOf(l, f); dupCount[k] = (dupCount[k] || 0) + 1; }
const lus242 = stkSim.lineups, extra = [];
for (const l of lus242) { const k = sigOf(l, f); for (let d = 1; d < (dupCount[k] || 1); d++) extra.push(l); }
t0 = Date.now();
const resA = simulate({ pool, model, field: [], lineups: lus242.concat(extra), payouts: pay250, entries: FE250, fee, iters: ITERS, rng: mulberry32(seed), fieldMode: true });
console.log(`simulated ${ITERS} iterations in ${Date.now() - t0} ms; avg ROI mine ${resA.proi.toFixed(1)}% vs stokastic ${(stkROI.reduce((a, b) => a + b, 0) / stkROI.length).toFixed(1)}%`);
const myROI = resA.rows.slice(0, lus242.length).map(r => r.roi), myWin = resA.rows.slice(0, lus242.length).map(r => r.win), myCash = resA.rows.slice(0, lus242.length).map(r => r.cash);
console.log(`  Spearman vs Stokastic: ROI ${spearman(myROI, stkROI).toFixed(3)} | win% ${spearman(myWin, stkWin).toFixed(3)} | cash% ${spearman(myCash, stkCash).toFixed(3)}`);
const topK = (arr, k) => arr.map((v, i) => i).sort((a, b) => arr[b] - arr[a]).slice(0, k);
for (const k of [10, 25, 50]) { const a = new Set(topK(myROI, k)); console.log(`  top-${k} by ROI overlap: ${topK(stkROI, k).filter(i => a.has(i)).length}/${k}`); }
const projPts = lus242.map(l => projOf(l, P, f));
console.log(`  baseline Spearman of plain projection vs Stokastic ROI: ${spearman(projPts, stkROI).toFixed(3)}`);
// player ROI
const pr = read("DK_MLB_Night_Pre_Contest_Player.csv").slice(1).map(r => ({ key: nrm(r[0]), roi: num(r[5]) }));
const myPR = playerROI(resA, P, f); const prMap = {}; myPR.forEach(r => prMap[P[r.id].key] = r.roi);
const paired = pr.filter(r => prMap[r.key] != null);
console.log(`  player ROI Spearman (${paired.length} players): ${spearman(paired.map(r => prMap[r.key]), paired.map(r => r.roi)).toFixed(3)}`);
console.log("  their top 5: " + pr.slice(0, 5).map(r => r.key).join(", "));
console.log("  my top 5:    " + myPR.slice(0, 5).map(r => r.name.toLowerCase()).join(", "));
// stack ROI
const sr = read("DK_MLB_Night_Pre_Contest_Stack.csv").slice(1);
const mySR = stackROI(resA, P); const srMap = {}; mySR.forEach(r => srMap[r.team + "|" + r.size] = r);
console.log("  stack ROI (theirs / mine):");
for (const r of sr) for (const [sz, ci] of [[3, 3], [4, 5], [5, 7]]) { const m = srMap[r[0] + "|" + sz]; console.log(`    ${r[0]} ${sz}-stack  n=${r[ci - 1]}  theirs ${r[ci]}  mine ${m ? m.roi.toFixed(1) + "% (n=" + m.n + ")" : "-"}`); }

/* ---------- 3. reality: the real 100-entry contest ---------- */
console.log("\n=== REALITY: real 100-entry contest, real payouts ===");
const payReal = parsePayoutTable(`1st\n$10,000\n2nd\n$5,000\n3rd\n$2,500\n4th\n$1,500\n5th\n$1,000\n6th - 8th\n$800\n9th - 14th\n$600\n15th - 22nd\n$500`, 100);
console.log(`payout table sums to $${payoutSum(payReal).toLocaleString()} over ${payReal.filter(x => x > 0).length} places`);
const realLus = real.map(e => e.lu);
const resB = simulate({ pool, model, field: [], lineups: realLus, payouts: payReal, entries: 100, fee, iters: ITERS, rng: mulberry32(seed), fieldMode: true });
const realPts = real.map(e => e.pts), simROI = resB.rows.map(r => r.roi), simProj = realLus.map(l => projOf(l, P, f)), simRank = resB.rows.map(r => -r.avgRank);
console.log(`  Spearman vs ACTUAL points over ${real.length} real entries: sim ROI ${spearman(simROI, realPts).toFixed(3)} | sim avg rank ${spearman(simRank, realPts).toFixed(3)} | plain projection ${spearman(simProj, realPts).toFixed(3)}`);
const order = resB.rows.map((r, i) => i).sort((a, b) => resB.rows[b].roi - resB.rows[a].roi);
const winnerIdx = real.findIndex(e => e.rank === 1);
console.log(`  actual winner (${real[winnerIdx].name}, ${real[winnerIdx].pts} pts) was my sim's #${order.indexOf(winnerIdx) + 1} of ${real.length} by ROI, avg sim rank ${resB.rows[winnerIdx].avgRank.toFixed(1)}`);
const top5 = order.slice(0, 5).map(i => `#${real[i].rank} (${real[i].pts})`);
console.log(`  my top-5 by ROI actually finished: ${top5.join(", ")}`);
const cashed = new Set(real.filter(e => e.rank <= 22).map(e => e.rank));
console.log(`  of my top-22 by sim ROI, ${order.slice(0, 22).filter(i => cashed.has(real[i].rank)).length} actually cashed (random would be ~4.8)`);

/* ---------- 4. Stokastic's 242 and my field against actual scores ---------- */
console.log("\n=== BOTH SIMS vs ACTUAL on Stokastic's 242 lineups ===");
const act242 = lus242.map(actualPts);
const ok242 = act242.map((v, i) => i).filter(i => act242[i] != null);
console.log(`  ${ok242.length} of 242 lineups fully scorable from the contest's player table`);
console.log(`  Spearman vs actual points: Stokastic ROI ${spearman(ok242.map(i => stkROI[i]), ok242.map(i => act242[i])).toFixed(3)} | my ROI ${spearman(ok242.map(i => myROI[i]), ok242.map(i => act242[i])).toFixed(3)} | projection ${spearman(ok242.map(i => projPts[i]), ok242.map(i => act242[i])).toFixed(3)}`);
const best = ok242.slice().sort((a, b) => act242[b] - act242[a]).slice(0, 5);
console.log("  best actual among the 242: " + best.map(i => `${act242[i].toFixed(1)} pts (stk rank ${topK(stkROI, 242).indexOf(i) + 1}, mine ${topK(myROI, 242).indexOf(i) + 1})`).join("; "));
