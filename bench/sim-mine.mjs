// Sim your own lineups inside the same contest field build-slate makes (same generator, seed and payouts), so they rank
// against the field like-for-like. Lineups are given by name in DK slot order.
//   node bench/sim-mine.mjs data/2026-10-10-cfb-main 600 33 10 "Name1|Name2|...|Name8" ["...another"]
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";
import { buildPool } from "../src/engine/formats.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { ownSum, sigOf } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const [dir, nArg = "600", pctArg = "20", rakeArg = "10", ...mine] = process.argv.slice(2);
const N = +nArg, PCT = +pctArg, RAKE = +rakeArg, SEED = 1, ITERS = 10000;
const file = fs.readdirSync(dir).find(f => /Data_Hub_Projections\.csv$/i.test(f));
const all = parseCSV(fs.readFileSync(path.join(dir, file), "utf8")), headers = all[0], rows = all.slice(1).filter(r => r.length > 1);
const FKEY = /-cfb-/.test(path.basename(dir)) ? "cfb_cl" : "nfl_cl";
const pool = buildPool(headers, rows, FKEY), P = pool.players, f = pool.format;
const opt = { conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3, nflStacks: FKEY === "cfb_cl" ? { 1: 43, 2: 32, 3: 8, bring: 50 } : { 1: 45, 2: 25, 3: 5, bring: 25 } };
const field = genField(pool, N, opt, mulberry32(SEED)).field;
const nm = s => String(s).toLowerCase().replace(/[.'’]/g, "").trim();
const mineLu = mine.map(s => s.split("|").map(n => { const i = P.findIndex(p => nm(p.name) === nm(n)); if (i < 0) throw new Error("not on slate: " + n); return i; }));
const lineups = field.concat(mineLu), pay = fitPayouts(N, N * (1 - RAKE / 100), N * (1 - RAKE / 100) * PCT / 100, 22);
const res = simulate({ pool, model: buildModel(pool, {}), field: [], lineups, payouts: pay, entries: N, fee: 1, iters: ITERS, maxIters: ITERS * 4, rng: mulberry32(SEED), fieldMode: true });
const order = res.rows.map((r, i) => i).sort((a, b) => res.rows[b].roi - res.rows[a].roi), rankOf = new Map(order.map((i, k) => [i, k + 1]));
const fieldSig = new Set(field.map(l => sigOf(l, f)));
mineLu.forEach((lu, k) => { const i = field.length + k, r = res.rows[i];
  console.log(`lineup ${k + 1}: Lab ROI ${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(0)}% ±${(r.se || 0).toFixed(0)} | rank ${rankOf.get(i)} of ${lineups.length} (top ${(100 * rankOf.get(i) / lineups.length).toFixed(0)}%) | cash ${r.cash.toFixed(1)}% top-10% ${r.t10.toFixed(1)}% win ${(r.win ?? 0).toFixed(2)}% | own ${ownSum(lu, P, f).toFixed(0)}%${fieldSig.has(sigOf(lu, f)) ? " | DUPLICATED in the field" : ""}`); });
const top = order.slice(0, 1).map(i => res.rows[i]); console.log(`field best: Lab ROI +${top[0].roi.toFixed(0)}% | median field ROI ${res.rows[order[Math.floor(order.length / 2)]].roi.toFixed(0)}%`);
