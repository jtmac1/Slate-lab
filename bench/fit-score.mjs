// Fit a single lineup score on what actually happened. Inputs are the sim's per-lineup features
// (from grade-all --rows=...): ROI / cash / top-10% / win percentiles, projection percentile,
// ownership, stack shape, chalk count, pitcher ownership, salary left. Target: finished in the
// contest's top 10%. Fit on one half of the window by date, grade the score on the other half
// against the gated default and plain Sim ROI (realized top-10% and top-3 ROI, Spearman vs
// finish), then swap halves. Prints the standardized coefficients so the score can be read.
//   node bench/fit-score.mjs data/reports/rows/mlb.p*.jsonl [--minfee=0] [--target=top10|cashed|roi]
import fs from "node:fs";
const args = process.argv.slice(2), files = args.filter(a => !a.startsWith("--")), flag = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const MINFEE = +(flag("minfee") || 0), TARGET = flag("target") || "top10";
const rows = []; for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line); if (r.fee >= MINFEE) rows.push(r); }
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pctRank = arr => { const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]); const out = new Array(arr.length); idx.forEach((i, k) => out[i] = arr.length > 1 ? k / (arr.length - 1) : 0.5); return out; };
// within-contest percentiles for the raw features so every contest is on the same scale
const byC = {}; for (const r of rows) (byC[r.c] = byC[r.c] || []).push(r);
for (const list of Object.values(byC)) for (const k of ["own", "pitMax", "chalkN", "salLeft", "win", "primary"]) { const p = pctRank(list.map(r => r[k])); list.forEach((r, i) => r["p_" + k] = p[i]); }
const FEATS = ["rROI", "rProj", "rCash", "rT10", "p_win", "p_own", "p_pitMax", "p_chalkN", "p_salLeft", "p_primary", "rProj2", "rROIxProj"];
const X = r => { r.rProj2 = r.rProj * r.rProj; r.rROIxProj = r.rROI * r.rProj; return FEATS.map(k => r[k]); };
const y = r => TARGET === "cashed" ? r.cashed : TARGET === "roi" ? (r.actROI > 0 ? 1 : 0) : r.top10;
const dates = [...new Set(rows.map(r => r.date))].sort(), mid = dates[Math.floor(dates.length / 2)];
console.log(`${rows.length} entries in ${Object.keys(byC).length} contests, ${dates.length} dates (split at ${mid}); target: ${TARGET}`);

function fitLogistic(train) {
  const n = train.length, d = FEATS.length, Xs = train.map(X), ys = train.map(y);
  const mu = FEATS.map((_, j) => mean(Xs.map(x => x[j]))), sd = FEATS.map((_, j) => Math.sqrt(mean(Xs.map(x => (x[j] - mu[j]) ** 2))) || 1);
  const Z = Xs.map(x => x.map((v, j) => (v - mu[j]) / sd[j]));
  let w = new Array(d).fill(0), b = Math.log(mean(ys) / (1 - mean(ys)));
  const lr = 0.5, l2 = 1e-4;
  for (let it = 0; it < 300; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j]; const p = 1 / (1 + Math.exp(-z)), e = p - ys[i]; gb += e; for (let j = 0; j < d; j++) gw[j] += e * Z[i][j]; }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]); b -= lr * gb / n;
  }
  return { w, b, mu, sd, score: r => { const x = X(r); let z = b; for (let j = 0; j < d; j++) z += w[j] * (x[j] - mu[j]) / sd[j]; return z; } };
}
const spearman = (a, b) => { const ra = pctRank(a), rb = pctRank(b), ma = mean(ra), mb = mean(rb); let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; } return num / Math.sqrt(da * db || 1); };
let seed = 9; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const ci = d => { const ms = []; for (let bb = 0; bb < 2000; bb++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]; ms.push(s / d.length); } ms.sort((p, q) => p - q); return [ms[50], ms[1949]]; };
// grade a scoring function contest by contest on a set of contests
function grade(list, scoreFn) {
  const out = [];
  for (const c of list) {
    const s = c.map(scoreFn), order = c.map((r, i) => i).sort((a, b) => s[b] - s[a]), k10 = Math.max(3, Math.round(c.length * 0.1));
    out.push({ real10: mean(order.slice(0, k10).map(i => c[i].actROI)), real3: mean(order.slice(0, 3).map(i => c[i].actROI)), sp: spearman(s, c.map(r => -r.finishPct)), cashHits: c[0].paid ? order.slice(0, c[0].paid).filter(i => c[i].cashed).length * c.length / (c[0].paid * c[0].paid) : 0 });
  }
  return out;
}
const RULES = { "ROI gated: top half proj (default)": r => r.rProj >= 0.5 ? r.roi : -1e9 + r.rProj, "Sim ROI": r => r.roi, "Stokastic ROI": r => r.stkROI };
for (const [fitHalf, testHalf] of [["A", "B"], ["B", "A"]]) {
  const inHalf = (r, h) => (r.date < mid) === (h === "A");
  const train = rows.filter(r => inHalf(r, fitHalf)), testC = Object.values(byC).filter(c => inHalf(c[0], testHalf));
  const m = fitLogistic(train);
  console.log(`\n=== fit on half ${fitHalf} (${train.length} entries), graded on half ${testHalf} (${testC.length} contests) ===`);
  console.log("standardized coefficients: " + FEATS.map((f, j) => `${f} ${m.w[j] >= 0 ? "+" : ""}${m.w[j].toFixed(2)}`).join(", "));
  const base = grade(testC, RULES["ROI gated: top half proj (default)"]);
  console.log("score".padEnd(38) + "top-10% ROI  top-3 ROI  Spearman(finish)  cash hits | diff top-10% vs default  95% CI");
  const show = (name, g) => { const d = g.map((x, i) => x.real10 - base[i].real10), [lo, hi] = ci(d); console.log(name.padEnd(38) + (mean(g.map(x => x.real10)).toFixed(0) + "%").padEnd(13) + (mean(g.map(x => x.real3)).toFixed(0) + "%").padEnd(11) + mean(g.map(x => x.sp)).toFixed(3).padEnd(18) + mean(g.map(x => x.cashHits)).toFixed(2).padEnd(10) + "| " + ((mean(d) >= 0 ? "+" : "") + mean(d).toFixed(0) + "pp").padEnd(24) + `[${lo.toFixed(0)}, ${hi.toFixed(0)}]`); };
  for (const [name, fn] of Object.entries(RULES)) show(name, grade(testC, fn));
  show(`fitted lineup score (${TARGET})`, grade(testC, m.score));
  // gate + fitted score: keep the projection floor, rank inside it by the fitted score
  show("fitted score, gated top half proj", grade(testC, r => r.rProj >= 0.5 ? m.score(r) : -1e9 + r.rProj));
}
