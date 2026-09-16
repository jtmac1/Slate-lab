// Paired comparison of two grade-all --json runs (e.g. default model vs a calibration candidate)
// on the same contests: rank correlation with actual, player ROI, realized top-10% ROI, and the
// default selection rule, with paired bootstrap 95% CIs, overall and by fee tier / field size.
//   node bench/compare-grades.mjs data/reports/grade-mlb-default.json data/reports/grade-mlb-cand30.json
import fs from "node:fs";
import { DEFAULT_RULE } from "../src/engine/select.mjs";
const A = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), B = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const FKEY = process.argv[4] || "mlb_cl";   // compare one format at a time: model flags are per sport
const bByDir = Object.fromEntries(B.map(r => [r.dir, r])), pairs = A.filter(a => bByDir[a.dir] && a.fkey === FKEY).map(a => [a, bByDir[a.dir]]);
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const ci = (d, B = 2000) => { const ms = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]; ms.push(s / d.length); } ms.sort((x, y) => x - y); return [ms[Math.floor(B * 0.025)], ms[Math.floor(B * 0.975)]]; };
const metrics = { "lineup ROI Spearman": r => r.sMine, "player ROI Spearman": r => r.pMine, "top-10% realized ROI": r => r.roiMine, "cash hits (top-paid)": r => r.cashMine, [`rule "${DEFAULT_RULE}" top-10%`]: r => r.grades[DEFAULT_RULE].real10, [`rule "${DEFAULT_RULE}" Spearman`]: r => r.grades[DEFAULT_RULE].spearman, "Sim ROI rule top-10%": r => r.grades["Sim ROI"].real10, "agreement with Stokastic": r => r.agree };
const dates = A.map(r => r.date).sort(), mid = dates[Math.floor(dates.length / 2)];
const groups = { all: () => true, "first half": r => r.date < mid, "second half": r => r.date >= mid, "<$50": r => r.tier === "<$50", "$50-199": r => r.tier === "$50-199", "$200+": r => r.tier === "$200-599" || r.tier === "$600+", "<300": r => r.size === "<300", "300-1.5K": r => r.size === "300-1.5K", "1.5K+": r => r.size === "1.5K-10K" || r.size === "10K+" };
console.log(`${pairs.length} paired contests. A = ${process.argv[2]}  B = ${process.argv[3]}`);
for (const [g, pred] of Object.entries(groups)) {
  const ps = pairs.filter(([a]) => pred(a)); if (ps.length < 5) continue;
  console.log(`\n=== ${g}: ${ps.length} contests ===`);
  console.log("metric".padEnd(42) + "A        B        B-A      95% CI            B wins");
  for (const [m, f] of Object.entries(metrics)) {
    const va = ps.map(([a]) => f(a)), vb = ps.map(([, b]) => f(b)), d = vb.map((x, i) => x - va[i]), [lo, hi] = ci(d), pctm = m.includes("ROI") && !m.includes("Spearman");
    const fmt = x => pctm ? x.toFixed(0) + "%" : x.toFixed(3), sig = lo > 0 ? " +" : hi < 0 ? " -" : "";
    console.log(m.padEnd(42) + fmt(mean(va)).padEnd(9) + fmt(mean(vb)).padEnd(9) + ((mean(d) >= 0 ? "+" : "") + fmt(mean(d))).padEnd(9) + `[${fmt(lo)}, ${fmt(hi)}]${sig}`.padEnd(18) + `${d.filter(x => x > 0).length}/${d.filter(x => x !== 0).length}`);
  }
}
