// Is the sim's ROI estimate right in LEVEL, not just in order? This is the test the ranking metrics
// cannot do, and the one a realistic opponent field has to pass.
//
// The logic: a contest's entries collectively return the prize pool, so their average realized ROI is
// fixed by the rake, around -15% to -40%. If our generated field were the real field, simming those
// same real entries against it would return that same average. However far off the sim lands is how
// badly the generated field misprices the competition - too easy a field reads as too much ROI.
//
//   node bench/calibration.mjs base=data/reports/rw-base.jsonl sec=data/reports/rw-sec.jsonl
import fs from "node:fs";

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const load = file => {
  const byC = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue; const r = JSON.parse(line);
    (byC[r.c] = byC[r.c] || []).push(r);
  }
  return byC;
};

const arms = process.argv.slice(2).map(a => { const [label, file] = a.split("="); return { label, byC: load(file) }; });
if (arms.length < 1) { console.error("usage: node bench/calibration.mjs label=rows.jsonl [label2=rows2.jsonl]"); process.exit(1); }
// only contests every arm produced, so the comparison is paired
const shared = Object.keys(arms[0].byC).filter(d => arms.every(a => a.byC[d] && a.byC[d].length === arms[0].byC[d].length));
console.log(`${shared.length} contests present in every arm, ${shared.reduce((s, d) => s + arms[0].byC[d].length, 0)} entries each\n`);

const fmt = v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
console.log("arm".padEnd(8) + "predicted".padEnd(12) + "actual".padEnd(12) + "gap".padEnd(12) + "|gap| per contest".padEnd(20) + "slope");
for (const a of arms) {
  const gaps = [], pred = [], act = [];
  let sxy = 0, sxx = 0, n = 0, mx = 0, my = 0;
  const allP = [], allA = [];
  for (const d of shared) {
    const rs = a.byC[d];
    const p = mean(rs.map(r => r.roi)), q = mean(rs.map(r => r.actROI));
    pred.push(p); act.push(q); gaps.push(Math.abs(p - q));
    for (const r of rs) { allP.push(r.roi); allA.push(r.actROI); }
  }
  // slope of realized on predicted, pooled and centred inside each contest so contest level drops out
  for (const d of shared) {
    const rs = a.byC[d], mp = mean(rs.map(r => r.roi)), ma = mean(rs.map(r => r.actROI));
    for (const r of rs) { const x = r.roi - mp, y = r.actROI - ma; sxy += x * y; sxx += x * x; n++; }
  }
  console.log(a.label.padEnd(8) + fmt(mean(pred)).padEnd(12) + fmt(mean(act)).padEnd(12) + fmt(mean(pred) - mean(act)).padEnd(12) + mean(gaps).toFixed(1).padEnd(20) + (sxx ? (sxy / sxx).toFixed(4) : "-"));
}

// where in the distribution the mispricing sits
console.log("\npredicted ROI decile -> what those entries actually returned");
console.log("decile".padEnd(9) + arms.map(a => (a.label + " pred").padEnd(13) + (a.label + " act").padEnd(13)).join(""));
for (let b = 0; b < 10; b++) {
  const cells = [];
  for (const a of arms) {
    const P = [], A = [];
    for (const d of shared) {
      const rs = a.byC[d].slice().sort((x, y) => x.roi - y.roi);
      const lo = Math.floor(rs.length * b / 10), hi = Math.floor(rs.length * (b + 1) / 10);
      for (let i = lo; i < hi; i++) { P.push(rs[i].roi); A.push(rs[i].actROI); }
    }
    cells.push(fmt(mean(P)).padEnd(13) + fmt(mean(A)).padEnd(13));
  }
  console.log((b === 9 ? "top 10%" : `${b * 10}-${b * 10 + 10}%`).padEnd(9) + cells.join(""));
}
