// Parameter sweep on the 2026-09-10 MLB night slate: which sigma cap and stack
// correlation best reproduce Stokastic's ROI ranking and the actual contest.
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm, num } from "../src/engine/csv.mjs";
import { buildPool } from "../src/engine/formats.mjs";
import { buildModel, MLBC } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts, parsePayoutTable } from "../src/engine/payouts.mjs";
import { matchLineups, sigOf, assignSlots } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const DIR = path.resolve("data/mlb-2026-09-10");
const read = f => parseCSV(fs.readFileSync(path.join(DIR, f), "utf8"));
function spearman(a, b) {
  const rk = x => { const idx = x.map((v, i) => i).sort((i, j) => x[i] - x[j]); const r = new Array(x.length); let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && x[idx[j + 1]] === x[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg; i = j + 1; } return r; };
  const ra = rk(a), rb = rk(b), n = a.length, m = (n + 1) / 2; let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - m) * (rb[i] - m); saa += (ra[i] - m) ** 2; sbb += (rb[i] - m) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
const projRows = read("DK_MLB_Night_Data_Hub_Projections.csv");
const pool = buildPool(projRows[0], projRows.slice(1), "mlb_cl"); const P = pool.players, f = pool.format;
const genRows = read("DK_MLB_Night_Contest_Generator_Lineup.csv"), gi = genRows[0].indexOf("P");
const stkField = matchLineups(genRows.slice(1).map(r => r.slice(gi, gi + 10)), P, f).lineups;
const simRows = read("DK_MLB_Night_Pre_Contest_Lineups.csv"), si = simRows[0].indexOf("P");
const lus242 = matchLineups(simRows.slice(1).map(r => r.slice(si, si + 10)), P, f).lineups;
const stkROI = simRows.slice(1).map(r => num(r[0]));
const dupCount = {}; for (const l of stkField) { const k = sigOf(l, f); dupCount[k] = (dupCount[k] || 0) + 1; }
const extra = []; for (const l of lus242) { const k = sigOf(l, f); for (let d = 1; d < (dupCount[k] || 1); d++) extra.push(l); }
const st = read(fs.readdirSync(DIR).find(x => /^contest-standings.*\.csv$/.test(x)));
const actual = {}; for (const r of st.slice(1)) if (r[7]) actual[nrm(r[7])] = num(r[10]);
const byKey = {}; P.forEach((p, i) => { if (byKey[p.key] == null) byKey[p.key] = i; });
const posRe = /\b(P|C|1B|2B|3B|SS|OF)\s+/g;
const real = st.slice(1).filter(r => /^\d+$/.test(String(r[0]).trim())).map(r => {
  const names = r[5].split(posRe).map(s => s.trim()).filter(s => s && !/^(P|C|1B|2B|3B|SS|OF)$/.test(s));
  return { pts: num(r[4]), lu: assignSlots(names.map(nm => byKey[nrm(nm)]), P, f) }; }).filter(e => e.lu);
const actualPts = lu => { let s = 0; for (const id of lu) { const a = actual[P[id].key]; if (a == null) return null; s += a; } return s; };
const act242 = lus242.map(actualPts), ok242 = act242.map((v, i) => i).filter(i => act242[i] != null);
const pay250 = fitPayouts(250, 250 * 333 * 0.852, 250 * 333 * 0.852 * 0.35, 22);
const payReal = parsePayoutTable(`1st\n$10,000\n2nd\n$5,000\n3rd\n$2,500\n4th\n$1,500\n5th\n$1,000\n6th - 8th\n$800\n9th - 14th\n$600\n15th - 22nd\n$500`, 100);
const ITERS = +(process.argv[2] || 10000);
console.log("sigmaMax hitSame orderBonus hitOppPitcher | ROI-vs-Stokastic win-vs-Stk | ROI-vs-actual(242) | realROI-vs-actual realRank-vs-actual");
for (const sigmaMax of [0.4, 0.5, 0.6, 0.7])
  for (const hitSame of [0.0, 0.08, 0.15, 0.22])
    for (const hitOppPitcher of [-0.2, -0.1, 0.0]) {
      const tables = { MLBC: Object.assign({}, MLBC, { hitSame, hitOppPitcher }) };
      const model = buildModel(pool, { sigmaMax, tables });
      const A = simulate({ pool, model, field: [], lineups: lus242.concat(extra), payouts: pay250, entries: 250, fee: 333, iters: ITERS, rng: mulberry32(1), fieldMode: true });
      const myROI = A.rows.slice(0, 242).map(r => r.roi), myWin = A.rows.slice(0, 242).map(r => r.win);
      const B = simulate({ pool, model, field: [], lineups: real.map(e => e.lu), payouts: payReal, entries: 100, fee: 333, iters: ITERS, rng: mulberry32(1), fieldMode: true });
      console.log(`${sigmaMax.toFixed(2)}     ${hitSame.toFixed(2)}    ${MLBC.orderBonus.toFixed(2)}       ${hitOppPitcher.toFixed(2)}        | ${spearman(myROI, stkROI).toFixed(3)}  ${spearman(myWin, simRows.slice(1).map(r => num(r[5]))).toFixed(3)} | ${spearman(ok242.map(i => myROI[i]), ok242.map(i => act242[i])).toFixed(3)} | ${spearman(B.rows.map(r => r.roi), real.map(e => e.pts)).toFixed(3)}  ${spearman(B.rows.map(r => -r.avgRank), real.map(e => e.pts)).toFixed(3)}`);
    }
