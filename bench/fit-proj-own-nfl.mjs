// Ownership-informed projections (2026-10-15, sim rewire item 1): does a player's ownership predict how he scores against
// his projection, beyond projection size and position? Fitted on 2025, checked on 2026, on real box-score points
// (bench/nfl-actuals.mjs). Answer: no - actual/proj is flat by Lab own in both seasons and the fitted curve doesn't help on
// 2026. (An earlier "chalk beats projection 1.07 vs 0.93" came from points recovered from lineups, which can't split
// points between positions.) --tails compares real 2x / 3x / bust rates with the sim's lognormal.
// The multiplier is a curve in log ownership, mult = exp(a + b * ln(own / 10)), fitted by weighted least squares on
// (actual - proj * mult) with each player weighted by 1 / proj.
//   node bench/fit-proj-own-nfl.mjs [--split=2026-03-01] [--main]   -> data/reports/proj-own-nfl.json
import fs from "node:fs";
import { nflPlayerWeeks } from "./nfl-actuals.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SPLIT = arg("split", "2026-03-01"), MAIN = process.argv.includes("--main");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;

  const rows = nflPlayerWeeks({ main: MAIN, split: SPLIT }); globalThis.__rows = rows;
  const tr = rows.filter(r => !r.test), te = rows.filter(r => r.test);
  console.log(`${rows.length} player-slates (${new Set(rows.map(r => r.date)).size} dates${MAIN ? ", main slates" : ""}): fit ${tr.length} (before ${SPLIT}), test ${te.length}`);
  const OB = [[0, 2], [2, 5], [5, 10], [10, 20], [20, 30], [30, 999]], ob = o => OB.findIndex(([a, b]) => o >= a && o < b), obL = i => OB[i][1] > 100 ? `${OB[i][0]}%+` : `${OB[i][0]}-${OB[i][1]}%`;
  const ratio = (rs, f = r => r.proj) => rs.reduce((s, r) => s + r.act, 0) / rs.reduce((s, r) => s + f(r), 0);
  const table = (title, rs, keyF, keys, f) => { console.log(`\n${title}`); for (const k of keys) { const g = rs.filter(r => keyF(r) === k); if (g.length < 40) continue; console.log(`  ${String(k).padEnd(10)} n ${String(g.length).padStart(5)}  act/proj ${ratio(g).toFixed(3)}${f ? `  adjusted ${ratio(g, f).toFixed(3)}` : ""}`); } };
  for (const [lab, rs] of [["2025", tr], ["2026", te]]) table(`Actual / projection by Lab own, ${lab}`, rs, r => obL(ob(r.own)), OB.map((_, i) => obL(i)));
  // is it projection size? ownership buckets within projection terciles; and by position
  const PT = [[3, 8], [8, 14], [14, 999]], pt = p => PT.findIndex(([a, b]) => p >= a && p < b);
  for (const t of [0, 1, 2]) table(`Within projection ${PT[t][0]}-${PT[t][1] > 100 ? "+" : PT[t][1]} (both seasons)`, rows.filter(r => pt(r.proj) === t), r => obL(ob(r.own)), OB.map((_, i) => obL(i)));
  for (const pos of ["QB", "RB", "WR", "TE"]) table(`${pos} (both seasons)`, rows.filter(r => r.pos === pos), r => obL(ob(r.own)), OB.map((_, i) => obL(i)));
  // fit mult = exp(a + b x), x = ln(own/10); Gauss-Newton on weighted squared error, weight 1/proj
  const fit = rs => { let a = 0, b = 0; for (let it = 0; it < 30; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0; for (const r of rs) { const x = Math.log(r.own / 10), m = Math.exp(a + b * x), y = r.proj * m, e = r.act - y, w = 1 / r.proj; g0 += w * e * y; g1 += w * e * y * x; h00 += w * y * y; h01 += w * y * y * x; h11 += w * y * y * x * x; } const det = h00 * h11 - h01 * h01; a += (h11 * g0 - h01 * g1) / det; b += (h00 * g1 - h01 * g0) / det; } return { a, b }; };
  const multOf = (F, own) => Math.exp(F.a + F.b * Math.log(Math.max(0.3, own) / 10));
  const mse = (rs, f) => mean(rs.map(r => (r.act - f(r)) ** 2));
  const F25 = fit(tr), F26 = fit(te), FALL = fit(rows);
  console.log(`\nfit 2025: mult = exp(${F25.a.toFixed(3)} + ${F25.b.toFixed(3)} ln(own/10))  -> 2% ${multOf(F25, 2).toFixed(3)}, 5% ${multOf(F25, 5).toFixed(3)}, 10% ${multOf(F25, 10).toFixed(3)}, 20% ${multOf(F25, 20).toFixed(3)}, 35% ${multOf(F25, 35).toFixed(3)}`);
  console.log(`fit 2026 alone: b ${F26.b.toFixed(3)} (a ${F26.a.toFixed(3)});  all: b ${FALL.b.toFixed(3)} (a ${FALL.a.toFixed(3)})`);
  // slope only (a re-centred to keep each slate's total projection): the level is a vendor-calibration question, the slope is the claim
  const slopeOnly = (F, rs) => { const byD = {}; for (const r of rs) (byD[r.date] ||= []).push(r); const out = new Map(); for (const g of Object.values(byD)) { const raw = g.map(r => r.proj * Math.exp(F.b * Math.log(r.own / 10))), k = g.reduce((s, r) => s + r.proj, 0) / raw.reduce((s, x) => s + x, 0); g.forEach((r, i) => out.set(r, raw[i] * k)); } return out; };
  const S26 = slopeOnly(F25, te);
  console.log(`\n2026 hold-out, mean squared error per player: Stokastic proj ${mse(te, r => r.proj).toFixed(2)} | x 2025 curve ${mse(te, r => r.proj * multOf(F25, r.own)).toFixed(2)} | slope only (slate total kept) ${mse(te, r => S26.get(r)).toFixed(2)}`);
  // clustered by date: per-date MSE gain of slope-only, t-stat
  const byD = {}; for (const r of te) (byD[r.date] ||= []).push(r); const gains = Object.values(byD).map(g => mse(g, r => r.proj) - mse(g, r => S26.get(r)));
  const gm = mean(gains), gs = Math.sqrt(mean(gains.map(x => (x - gm) ** 2)) / gains.length);
  console.log(`  slope-only gain per date ${gm.toFixed(2)} (t ${(gm / gs).toFixed(1)}, ${gains.filter(x => x > 0).length}/${gains.length} dates better)`);
  table("2026 by Lab own after the 2025 slope (slate total kept)", te, r => obL(ob(r.own)), OB.map((_, i) => obL(i)), r => S26.get(r));
  fs.mkdirSync("data/reports", { recursive: true });
  fs.writeFileSync("data/reports/proj-own-nfl.json", JSON.stringify({ built: new Date().toISOString(), split: SPLIT, main: MAIN, fit2025: F25, fit2026: F26, fitAll: FALL, n: { fit: tr.length, test: te.length } }, null, 1));

// Tails: how often players hit 2x / 3x their projection, real vs the sim's lognormal (SIGMA_DEF, mean-preserving, no bend),
// by position and projection size, and by ownership within projection (does the sim over-credit low-owned upside?)
if (process.argv.includes("--tails")) {
  const { SIGMA_DEF, pnorm } = await import("../src/engine/model.mjs");
  const all = [...(globalThis.__rows || [])];
  const pOver = (k, sg) => 1 - pnorm((Math.log(k) + sg * sg / 2) / sg);
  const PB = [[3, 6], [6, 10], [10, 15], [15, 99]];
  console.log("\nTails: real vs sim P(actual >= 2x proj) and >= 3x, plus P(<= 0.3x)");
  for (const pos of ["QB", "RB", "WR", "TE"]) for (const [lo, hi] of PB) { const g = all.filter(r => r.pos === pos && r.proj >= lo && r.proj < hi); if (g.length < 80) continue; const sg = SIGMA_DEF.nfl[pos], f = c => (100 * g.filter(c).length / g.length).toFixed(1);
    console.log(`  ${pos} proj ${String(lo).padStart(2)}-${hi > 50 ? "+ " : String(hi).padEnd(2)} n ${String(g.length).padStart(4)} | 2x real ${f(r => r.act >= 2 * r.proj).padStart(5)}% sim ${(100 * pOver(2, sg)).toFixed(1).padStart(5)}% | 3x real ${f(r => r.act >= 3 * r.proj).padStart(5)}% sim ${(100 * pOver(3, sg)).toFixed(1).padStart(5)}% | <=0.3x real ${f(r => r.act <= 0.3 * r.proj).padStart(5)}% sim ${(100 * (1 - pOver(0.3, sg))).toFixed(1).padStart(5)}%`); }
  console.log("\nSame, by Lab own (WR/TE/RB, projection 6-15)");
  for (const [lo, hi] of [[0, 2], [2, 5], [5, 10], [10, 99]]) { const g = all.filter(r => r.pos !== "QB" && r.proj >= 6 && r.proj < 15 && r.own >= lo && r.own < hi); const f = c => (100 * g.filter(c).length / g.length).toFixed(1);
    console.log(`  own ${String(lo).padStart(2)}-${hi > 50 ? "+ " : String(hi).padEnd(2)} n ${String(g.length).padStart(4)} | 2x ${f(r => r.act >= 2 * r.proj)}%  3x ${f(r => r.act >= 3 * r.proj)}%  <=0.3x ${f(r => r.act <= 0.3 * r.proj)}%  act/proj ${(g.reduce((s, r) => s + r.act, 0) / g.reduce((s, r) => s + r.proj, 0)).toFixed(3)}`); }
}
