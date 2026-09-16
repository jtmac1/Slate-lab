// Do chalk-heavy or stacked lineups score what they project? Lineup-level actual minus projected
// FP by chalk count (top-10 projected-owned hitters in the lineup), primary stack size and
// salary left, over pulled MLB contests. Mean residual = projection bias; SD = realized variance.
//   node bench/chalk-bias.mjs
import { listContests, loadPulled } from "./grade-all.mjs";
import { stackOf } from "../src/engine/lineups.mjs";
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1), sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const rows = []; const seen = new Set();
for (const c of listContests().filter(c => c.fkey === "mlb_cl" && c.json)) {
  const { pool, entries } = loadPulled(c.json), P = pool.players, f = pool.format;
  const chalk = new Set(P.map((p, i) => i).filter(i => !P[i].isP).sort((a, b) => P[b].own - P[a].own).slice(0, 10));
  for (const e of entries) {
    const k = c.date + "|" + e.lu.slice().sort().join(","); if (seen.has(k)) continue; seen.add(k);   // one row per distinct lineup per slate
    if (!e.stkFP) continue;
    rows.push({ resid: e.actFP - e.stkFP, ratio: e.actFP / e.stkFP, proj: e.stkFP, chalkN: e.lu.filter(id => chalk.has(id)).length, primary: +String(stackOf(e.lu, P, f)).split(/[^0-9]/)[0] || 0, salLeft: 50000 - e.sal, own: e.own });
  }
}
console.log(`${rows.length} distinct lineup-slates; overall actual/projected ${(mean(rows.map(r => r.ratio))).toFixed(3)}, mean residual ${mean(rows.map(r => r.resid)).toFixed(2)} FP, SD ${sd(rows.map(r => r.resid)).toFixed(1)}`);
const show = (title, bins) => { console.log(`\n=== ${title} ===`); console.log("bin".padEnd(14) + "n        proj    actual  act/proj  resid   SD resid  P(actual > proj+30)"); for (const [b, pred] of bins) { const rs = rows.filter(pred); if (!rs.length) continue; console.log(b.padEnd(14) + String(rs.length).padEnd(9) + mean(rs.map(r => r.proj)).toFixed(1).padEnd(8) + mean(rs.map(r => r.proj + r.resid)).toFixed(1).padEnd(8) + (mean(rs.map(r => r.proj + r.resid)) / mean(rs.map(r => r.proj))).toFixed(3).padEnd(10) + mean(rs.map(r => r.resid)).toFixed(2).padEnd(8) + sd(rs.map(r => r.resid)).toFixed(1).padEnd(10) + (100 * mean(rs.map(r => r.resid > 30 ? 1 : 0))).toFixed(1) + "%"); } };
show("chalk count (top-10 owned hitters)", [["0", r => r.chalkN === 0], ["1", r => r.chalkN === 1], ["2", r => r.chalkN === 2], ["3", r => r.chalkN === 3], ["4", r => r.chalkN === 4], ["5+", r => r.chalkN >= 5]]);
show("primary stack size", [["<=2", r => r.primary <= 2], ["3", r => r.primary === 3], ["4", r => r.primary === 4], ["5", r => r.primary === 5]]);
show("salary left", [["0-100", r => r.salLeft <= 100], ["101-300", r => r.salLeft > 100 && r.salLeft <= 300], ["301-600", r => r.salLeft > 300 && r.salLeft <= 600], ["601-1000", r => r.salLeft > 600 && r.salLeft <= 1000], ["1000+", r => r.salLeft > 1000]]);
