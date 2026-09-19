// What is ownership worth to the sim, and would knowing it exactly be worth more?
// For every real entry in the pulled contests: the sim's ROI estimate, the entry's projected
// ownership sum, and its realized ownership sum. Everything is ranked inside its own contest so
// contests of different size and payout shape pool. Blend weights are fitted on one half of the
// window and spent on the other, both directions.
//
// The answer depends entirely on what you ask it to predict, which is the point of this script:
//   - against FINISHING POSITION, ownership beats the whole sim on its own, and blending it in
//     lifts the sim by about a third out of sample. Chalk finishes mid-pack very reliably.
//   - against MONEY, ownership alone loses (top-decile realized ROI -8.6% against the sim's +39.3%)
//     and the fitted blend weight is exactly zero in both directions. Top-heavy payouts do not care
//     how reliably you finish 400th.
// And realized ownership is worth no more than projected ownership: 0.2844 against 0.2843 on the
// finish target, with the realized-minus-projected miss contributing nothing out of sample. The
// vendor's ownership numbers are already accurate enough that the leftover carries no signal.
//   node bench/leverage.mjs data/reports/rows-cfb.jsonl [cfb_cl]
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";

const FILE = process.argv[2] || "data/reports/rows-cfb.jsonl";
const FKEY = process.argv[3] || "cfb_cl";
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const byC = {}; for (const r of rows) (byC[r.c] = byC[r.c] || []).push(r);
const idx = Object.fromEntries(listContests().filter(c => c.json && c.fkey === FKEY).map(c => [c.dir, c]));

const rank = a => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++;
    const m = (i + j) / 2; for (let k = i; k <= j; k++) r[o[k][1]] = m; i = j + 1; }
  return r.map(v => a.length > 1 ? v / (a.length - 1) : 0.5); };
const corr = (xs, ys) => { const n = xs.length; if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN; };
const mean = a => { const v = a.filter(x => !isNaN(x)); return v.reduce((x, y) => x + y, 0) / (v.length || 1); };

const sets = [];
for (const [dir, rs] of Object.entries(byC)) {
  const c = idx[dir]; if (!c || rs.length < 20) continue;
  const { pool, entries } = loadPulled(c.json);
  if (entries.length !== rs.length) continue;
  const P = pool.players;
  if (!P.some(p => p.actOwn != null) || !rs.some(r => r.actROI > -100)) continue;
  const ownReal = entries.map(e => e.lu.reduce((s, id) => s + (P[id].actOwn || 0), 0));
  sets.push({ dir, date: c.date, n: rs.length,
    sim: rank(rs.map(r => r.roi)),
    good: rank(rs.map(r => -r.finishPct)),
    projOwn: rank(rs.map(r => r.own)),
    realOwn: rank(ownReal),
    miss: rank(ownReal.map((v, i) => v - rs[i].own)),
    act: rs.map(r => r.actROI), top10: rs.map(r => r.top10), cashed: rs.map(r => r.cashed) });
}
sets.sort((a, b) => a.date.localeCompare(b.date));
const half = Math.floor(sets.length / 2), halves = [[0, half], [half, sets.length]];
console.log(`${sets.length} contests, ${sets.reduce((s, x) => s + x.n, 0)} real entries\n`);

console.log("--- ranking the finishing position ---");
console.log("sim ROI alone                : " + mean(sets.map(s => corr(s.sim, s.good))).toFixed(4));
console.log("projected ownership alone    : " + mean(sets.map(s => corr(s.projOwn, s.good))).toFixed(4));
console.log("realized ownership alone     : " + mean(sets.map(s => corr(s.realOwn, s.good))).toFixed(4));
console.log("realized-minus-projected     : " + mean(sets.map(s => corr(s.miss, s.good))).toFixed(4));
const fitR = (ss, key) => { let best = 0, bv = -9;
  for (let w = -1.5; w <= 1.5001; w += 0.05) { const v = mean(ss.map(s => corr(s.sim.map((x, i) => x + w * s[key][i]), s.good))); if (v > bv) { bv = v; best = w; } }
  return best; };
for (const key of ["projOwn", "realOwn", "miss"]) {
  for (let h = 0; h < 2; h++) {
    const fit = sets.slice(...halves[1 - h]), test = sets.slice(...halves[h]), w = fitR(fit, key);
    const base = mean(test.map(s => corr(s.sim, s.good)));
    const blend = mean(test.map(s => corr(s.sim.map((x, i) => x + w * s[key][i]), s.good)));
    console.log(`  sim + ${key.padEnd(8)} fit ${1 - h === 0 ? "1st" : "2nd"} -> test ${h === 0 ? "1st" : "2nd"}: weight ${w.toFixed(2)}  ${base.toFixed(4)} -> ${blend.toFixed(4)}  (${(blend - base >= 0 ? "+" : "") + (blend - base).toFixed(4)})`);
  }
}

console.log("\n--- what the top decile of picks actually returned ---");
const decile = (s, score) => {
  const k = Math.max(1, Math.round(s.act.length * 0.1));
  const ord = score.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, k).map(x => x[1]);
  return { roi: mean(ord.map(i => s.act[i])), t10: mean(ord.map(i => s.top10[i])), cash: mean(ord.map(i => s.cashed[i])) };
};
const scoreOf = (s, w, key) => s.sim.map((x, i) => x + w * s[key][i]);
for (const key of ["projOwn", "realOwn"]) {
  for (let h = 0; h < 2; h++) {
    const fit = sets.slice(...halves[1 - h]), test = sets.slice(...halves[h]);
    let bw = 0, bv = -1e9;
    for (let w = 0; w <= 2.0001; w += 0.1) { const v = mean(fit.map(s => decile(s, scoreOf(s, w, key)).roi)); if (v > bv) { bv = v; bw = w; } }
    const base = mean(test.map(s => decile(s, s.sim).roi)), blend = mean(test.map(s => decile(s, scoreOf(s, bw, key)).roi));
    console.log(`  sim + ${key.padEnd(8)} fit ${1 - h === 0 ? "1st" : "2nd"} -> test ${h === 0 ? "1st" : "2nd"}: weight ${bw.toFixed(1)}  ROI ${base.toFixed(1)}% -> ${blend.toFixed(1)}%`);
  }
}
const show = (lab, f) => { const d = sets.map(f); console.log(`  ${lab.padEnd(24)} ROI ${mean(d.map(x => x.roi)).toFixed(1)}%, finished top 10% ${(100 * mean(d.map(x => x.t10))).toFixed(1)}%, cashed ${(100 * mean(d.map(x => x.cash))).toFixed(1)}%`); };
console.log("");
show("ownership alone, no sim", s => decile(s, s.projOwn));
show("sim alone", s => decile(s, s.sim));
