// Grade a bench/build-slate.mjs build against what happened (bench/actuals-mlb.mjs actuals.csv):
// where the picks finished inside the simulated field by actual points, what they would have paid
// under the build's payout table, and the same for the top-N by projection and by plain sim ROI.
//   node bench/compare-build.mjs data/2026-09-16-mlb-early [build-1000-seed1.json]
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
const dir = process.argv[2], bf = process.argv[3] || fs.readdirSync(dir).find(f => /^build-.*\.json$/.test(f));
const B = JSON.parse(fs.readFileSync(path.join(dir, bf), "utf8"));
const A = parseCSV(fs.readFileSync(path.join(dir, "actuals.csv"), "utf8")), H = A[0], ci = n => H.indexOf(n);
const act = {}, fin = {}, proj = {}; let notFinal = 0;
for (const r of A.slice(1)) { if (r.length < 7) continue; const k = nrm(r[ci("Player")]); if (r[ci("Actual")] !== "") { act[k] = +r[ci("Actual")]; proj[k] = +r[ci("Projection")]; if (r[ci("Final")] !== "1") notFinal++; } }
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const score = names => { let s = 0, miss = []; for (const n of names) { const v = act[nrm(n)]; if (v == null) miss.push(n); else s += v; } return { s, miss }; };
const F = B.field.map(r => Object.assign({ act: score(r.names) }, r));
const missing = new Set(F.flatMap(r => r.act.miss)); if (missing.size) console.log(`players with no actual yet: ${[...missing].slice(0, 12).join(", ")}${missing.size > 12 ? " ..." : ""}`);
const N = B.entries, poolUnits = N * (1 - B.rake / 100), pay = fitPayouts(N, poolUnits, poolUnits * B.pctToFirst / 100, 22);
const sorted = F.map((r, i) => i).sort((a, b) => F[b].act.s - F[a].act.s), rankOf = new Array(F.length); sorted.forEach((i, k) => rankOf[i] = k);
// ties and duplicates share ranks: payout = mean of payouts across the tied block
const payOf = i => { const s = F[i].act.s; let lo = rankOf[i], hi = rankOf[i]; while (lo > 0 && F[sorted[lo - 1]].act.s === s) lo--; while (hi < F.length - 1 && F[sorted[hi + 1]].act.s === s) hi++; let t = 0; for (let k = lo; k <= hi; k++) t += pay[k] || 0; return t / (hi - lo + 1); };
const byKey = names => F.findIndex(r => r.names.join("|") === names.join("|"));
const sets = { [`${B.rule} (top ${B.picks.length})`]: B.picks.map(p => byKey(p.names)), [`plain Sim ROI (top ${B.roiPicks.length})`]: B.roiPicks.map(p => byKey(p.names)),
  [`top ${B.picks.length} by projection`]: F.map((r, i) => i).sort((a, b) => F[b].proj - F[a].proj).slice(0, B.picks.length), "whole field": F.map((r, i) => i) };
console.log(`${path.basename(dir)}: ${B.entries}-entry field, ${B.pctToFirst}% to first, model ${B.model}${notFinal ? `  [${notFinal} players from games NOT final]` : ""}`);
console.log(`field: mean actual ${mean(F.map(r => r.act.s)).toFixed(1)} FP (projected ${mean(F.map(r => r.proj)).toFixed(1)}), cash line ${F[sorted[Math.round(N * 0.22) - 1]].act.s.toFixed(1)}, top score ${F[sorted[0]].act.s.toFixed(1)}`);
console.log("\nselection".padEnd(38) + "n    actual FP  proj FP  mean pct  top-10%  cashed  ROI");
for (const [lab, idx] of Object.entries(sets)) { const ok = idx.filter(i => i >= 0); const pct = ok.map(i => 1 - rankOf[i] / (F.length - 1)), roi = 100 * (mean(ok.map(payOf)) - 1); console.log(lab.padEnd(38) + String(ok.length).padEnd(5) + mean(ok.map(i => F[i].act.s)).toFixed(1).padEnd(11) + mean(ok.map(i => F[i].proj)).toFixed(1).padEnd(9) + (100 * mean(pct)).toFixed(0).padStart(5) + "%    " + ok.filter(i => rankOf[i] < N * 0.1).length.toString().padEnd(9) + ok.filter(i => payOf(i) > 0).length.toString().padEnd(8) + (roi >= 0 ? "+" : "") + roi.toFixed(0) + "%"); }
console.log(`\n${B.rule}: each pick`);
B.picks.forEach((p, k) => { const i = byKey(p.names); if (i < 0) return; console.log(`${String(k + 1).padStart(2)}  sim ROI ${p.roi >= 0 ? "+" : ""}${p.roi.toFixed(0)}%  actual ${F[i].act.s.toFixed(1).padStart(6)} (proj ${p.proj.toFixed(1)})  finish ${String(rankOf[i] + 1).padStart(4)}/${N}  paid ${payOf(i) ? (100 * (payOf(i) - 1)).toFixed(0) + "%" : "-"}  ${p.stack.padEnd(7)} ${p.teams}`); });
// players: sim ROI vs actual minus projection
const pr = B.playerROI.filter(p => act[nrm(p.name)] != null).map(p => Object.assign({ res: act[nrm(p.name)] - proj[nrm(p.name)] }, p));
const top = pr.slice(0, 15), bot = pr.slice(-15);
console.log(`\nplayer ROI: top 15 by sim ROI beat projection by ${mean(top.map(p => p.res)).toFixed(2)} FP on average; bottom 15 by ${mean(bot.map(p => p.res)).toFixed(2)} FP; all ${pr.length}: ${mean(pr.map(p => p.res)).toFixed(2)}`);
const sp = (x, y) => { const rk = a => { const idx = a.map((v, i) => i).sort((p, q) => a[p] - a[q]); const r = []; idx.forEach((i, k) => r[i] = k); return r; }; const rx = rk(x), ry = rk(y), n = x.length, mx = mean(rx), my = mean(ry); let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return num / Math.sqrt(dx * dy || 1); };
console.log(`rank correlation: sim player ROI vs actual-minus-projection ${sp(pr.map(p => p.roi), pr.map(p => p.res)).toFixed(3)}; projected ownership vs residual ${sp(pr.map(p => p.projOwn), pr.map(p => p.res)).toFixed(3)}`);

// the user's own entries (my-entries.json next to the build): finish inside this simulated field
const mf = path.join(dir, "my-entries.json");
if (fs.existsSync(mf)) {
  const M = JSON.parse(fs.readFileSync(mf, "utf8")), key = a => a.slice().sort().join("|");
  console.log(`\nyour entries (${M.user}) graded inside this ${N}-entry simulated field:`);
  for (const e of M.entries) {
    if (e.build && e.build !== bf) continue;
    const i = F.findIndex(r => key(r.names) === key(e.names)), sc = score(e.names);
    const finish = i >= 0 ? rankOf[i] + 1 : sorted.filter(j => F[j].act.s > sc.s).length + 1, paid = i >= 0 ? payOf(i) : (pay[finish - 1] || 0);
    const pickNo = B.picks.findIndex(p => key(p.names) === key(e.names)) + 1;
    console.log(`  ${e.contest}: actual ${sc.s.toFixed(1)} FP, finish ${finish}/${N} in the simulated field, paid ${paid ? (100 * (paid - 1)).toFixed(0) + "%" : "-"}${i >= 0 ? `; sim ROI ${F[i].roi >= 0 ? "+" : ""}${F[i].roi}%` : "; not in simulated field"}${pickNo ? `; identical to the sim's pick #${pickNo}` : ""}${sc.miss.length ? `; missing actuals: ${sc.miss.join(", ")}` : ""}`);
  }
}
