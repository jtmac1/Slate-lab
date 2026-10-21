// Fit the post-hoc recalibration of the NBA classic sim's reported numbers (src/engine/sim.mjs CALIB.nba_cl), the way
// bench/fit-sim-calibration-nfl.mjs did NFL, but on one season: contests are split in two by date (first/second half of the
// dates, and odd/even dates), fitted on one half and tested on the other, both directions. Noise floor: the same fit on a
// second seed's sim of the same contests (--seed2=<files>). Rows from bench/grade-all.mjs --rows --fkey=nba_cl.
//   node bench/fit-sim-calibration-nba.mjs --json=data/reports/nba/calibration-nba.json --seed2=data/reports/nba/sc/D-s2.jsonl data/reports/nba/sc/D-s1.jsonl
import fs from "node:fs";

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const files = process.argv.slice(2).filter(a => !a.startsWith("--")), files2 = arg("seed2") ? arg("seed2").split(",") : [], JSON_OUT = arg("json"), UNTIL = arg("until") || "2026-08-01";
const EV = { win: ["win", "won"], top1: ["t1", "top1"], top10: ["t10", "top10"], cash: ["cash", "cashed"] };
const load = fs_ => { const byC = new Map(); for (const f of fs_) for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line) continue; const r = JSON.parse(line); if (r.finish == null || r.t1 == null || r.fkey !== "nba_cl" || r.date >= UNTIL) continue;
  const q = { c: r.c, date: r.date, N: r.N, games: r.games, paid: r.paid, roi: r.roi, actROI: r.actROI, win: r.win, t1: r.t1, t10: r.t10, cash: r.cash, won: r.won, top1: r.top1, top10: r.top10, cashed: r.cashed }; (byC.get(r.c) || byC.set(r.c, []).get(r.c)).push(q); } return byC; };
const C1 = load(files), C2 = files2.length ? load(files2) : null;
const keys = [...C1.keys()].filter(k => !C2 || C2.has(k)).sort();
const baseOf = (r, ev) => { const N = r.N || 1; return ev === "win" ? 1 / N : ev === "top1" ? Math.max(1, Math.round(N * 0.01)) / N : ev === "top10" ? Math.max(1, Math.round(N * 0.1)) / N : (r.paid || 0) / N; };
const rowsOf = (C, ks) => { const out = []; for (const k of ks) { const rs = C.get(k); const m = rs.reduce((s, r) => s + 1 + r.roi / 100, 0) / rs.length; for (const r of rs) out.push({ r, m }); } return out; };

function fitS(rows, pooled) { const byC = {}; for (const { r, m } of rows) { const d = byC[r.c] || (byC[r.c] = { sxy: 0, sxx: 0, n: 0 }), x = 1 + r.roi / 100 - m, y = 1 + r.actROI / 100 - m; d.sxy += x * y; d.sxx += x * x; d.n++; }
  let a = 0, b = 0; for (const d of Object.values(byC)) { a += pooled ? d.sxy : d.sxy / d.n; b += pooled ? d.sxx : d.sxx / d.n; } return a / b; }
function bootS(rows, reps = 300) { const byC = {}, byD = {}; for (const q of rows) (byC[q.r.c] = byC[q.r.c] || []).push(q);
  for (const qs of Object.values(byC)) { const d = byD[qs[0].r.date] || (byD[qs[0].r.date] = { sxy: 0, sxx: 0 }); for (const { r, m } of qs) { const x = 1 + r.roi / 100 - m, y = 1 + r.actROI / 100 - m; d.sxy += x * y / qs.length; d.sxx += x * x / qs.length; } }
  const ds = Object.values(byD), out = []; let seed = 5; const rnd = () => (seed = ((Math.imul(seed, 1103515245) + 12345) >>> 0) % 2147483648) / 2147483648;
  for (let b = 0; b < reps; b++) { let a = 0, c = 0; for (let i = 0; i < ds.length; i++) { const d = ds[Math.floor(rnd() * ds.length)]; a += d.sxy; c += d.sxx; } out.push(a / c); } out.sort((x, y) => x - y); return [+out[Math.floor(reps * 0.05)].toFixed(3), +out[Math.floor(reps * 0.95)].toFixed(3)]; }
function logLoss(rows, ev, b) { let n = 0; for (const { r } of rows) if (baseOf(r, ev) > 0) n++; return -ll(rows, ev, b) / n; }
function ll(rows, ev, b) { const [pk, ak] = EV[ev]; let s = 0; for (const { r } of rows) { const base = baseOf(r, ev); if (!(base > 0)) continue; const p = Math.min(0.999, Math.max(1e-6, base * Math.pow(Math.max(1e-6, r[pk] / 100) / base, b))); s += r[ak] ? Math.log(p) : Math.log(1 - p); } return s; }
function fitB(rows, ev) { let best = 1, bl = -Infinity; for (let b = 0; b <= 1.5001; b += 0.02) { const v = ll(rows, ev, b); if (v > bl) { bl = v; best = b; } } return +best.toFixed(2); }
function brier(rows, ev, b) { const [pk, ak] = EV[ev]; let s = 0, n = 0; for (const { r } of rows) { const base = baseOf(r, ev); if (!(base > 0)) continue; const p = Math.min(1, base * Math.pow(Math.max(1e-6, r[pk] / 100) / base, b)); s += (p - r[ak]) ** 2; n++; } return s / n; }
const sum = (rows, f) => rows.reduce((s, q) => s + f(q), 0);
function roiErr(rows, s) { let e0 = 0, e1 = 0; for (const { r, m } of rows) { const x = 1 + r.roi / 100, y = 1 + r.actROI / 100; e0 += (x - y) ** 2; e1 += (m + s * (x - m) - y) ** 2; } return [e0 / rows.length, e1 / rows.length]; }
// the screen view: entries the sim calls top 10% by ROI in their contest, predicted vs realised ROI
function deciles(rows, s) { const byC = {}; for (const q of rows) (byC[q.r.c] = byC[q.r.c] || []).push(q); const X = new Float64Array(10), Y = new Float64Array(10), nc = Object.keys(byC).length;
  for (const qs of Object.values(byC)) { const srt = [...qs].sort((a, b) => b.r.roi - a.r.roi), n = srt.length; for (let d = 0; d < 10; d++) { const lo = Math.floor(n * d / 10), hi = Math.max(lo + 1, Math.floor(n * (d + 1) / 10)); let sx = 0, sy = 0; for (let i = lo; i < hi; i++) { sx += 1 + srt[i].r.roi / 100 - srt[i].m; sy += 1 + srt[i].r.actROI / 100 - srt[i].m; } X[d] += sx / (hi - lo) / nc; Y[d] += sy / (hi - lo) / nc; } }
  let e0 = 0, e1 = 0; for (let d = 0; d < 10; d++) { e0 += (X[d] - Y[d]) ** 2; e1 += (s * X[d] - Y[d]) ** 2; }
  return { predRaw: Array.from(X, x => +(100 * x).toFixed(1)), predCal: Array.from(X, x => +(100 * s * x).toFixed(1)), actual: Array.from(Y, y => +(100 * y).toFixed(1)), rmseRaw: +(100 * Math.sqrt(e0 / 10)).toFixed(2), rmseCal: +(100 * Math.sqrt(e1 / 10)).toFixed(2) }; }
function topDecile(rows, s) { const byC = {}; for (const q of rows) (byC[q.r.c] = byC[q.r.c] || []).push(q); let p0 = 0, p1 = 0, a = 0, n = 0;
  for (const qs of Object.values(byC)) { const top = [...qs].sort((x, y) => y.r.roi - x.r.roi).slice(0, Math.max(1, Math.round(qs.length * 0.1))); for (const { r, m } of top) { p0 += r.roi; p1 += (m + s * (1 + r.roi / 100 - m) - 1) * 100; a += r.actROI; n++; } }
  return { n, predRaw: +(p0 / n).toFixed(1), predCal: +(p1 / n).toFixed(1), actual: +(a / n).toFixed(1) }; }
const predAct = (rows0, ev, b) => { const [pk, ak] = EV[ev], rows = rows0.filter(({ r }) => baseOf(r, ev) > 0); return { pred: +(100 * sum(rows, ({ r }) => Math.min(1, baseOf(r, ev) * Math.pow(Math.max(1e-6, r[pk] / 100) / baseOf(r, ev), b))) / rows.length).toFixed(4), act: +(100 * sum(rows, ({ r }) => r[ak]) / rows.length).toFixed(4) }; };

function fitAll(rows) { const o = { roi: +fitS(rows).toFixed(3), roiCI: bootS(rows), roiPooledOLS: +fitS(rows, true).toFixed(3) }; for (const ev of Object.keys(EV)) o[ev] = fitB(rows, ev); return o; }
function test(tr, te, fit) { const [e0, e1] = roiErr(te, fit.roi), o = { roi: { ownSlope: +fitS(te).toFixed(3), mseRaw: +e0.toFixed(4), mseCal: +e1.toFixed(4), pct: +(100 * (e1 / e0 - 1)).toFixed(2), deciles: deciles(te, fit.roi), topDecile: topDecile(te, fit.roi) } };
  for (const ev of Object.keys(EV)) { const b0 = brier(te, ev, 1), b1 = brier(te, ev, fit[ev]); const l0 = logLoss(te, ev, 1), l1 = logLoss(te, ev, fit[ev]); o[ev] = { b: fit[ev], ownB: fitB(te, ev), brierPct: +(100 * (b1 / b0 - 1)).toFixed(3), logLossPct: +(100 * (l1 / l0 - 1)).toFixed(3), raw: predAct(te, ev, 1), cal: predAct(te, ev, fit[ev]) }; } return o; }

const dates = [...new Set(keys.map(k => C1.get(k)[0].date))].sort(), half = dates[Math.floor(dates.length / 2)];
const splits = { "date halves": [keys.filter(k => C1.get(k)[0].date < half), keys.filter(k => C1.get(k)[0].date >= half)],
  "odd/even dates": [keys.filter(k => dates.indexOf(C1.get(k)[0].date) % 2 === 0), keys.filter(k => dates.indexOf(C1.get(k)[0].date) % 2 === 1)] };
const all = rowsOf(C1, keys), report = { contests: keys.length, entries: all.length, dates: dates.length, from: dates[0], to: dates[dates.length - 1], split: half, full: fitAll(all), splits: {} };
console.log(`${keys.length} NBA classic contests, ${all.length} entries, ${dates.length} dates (${dates[0]} - ${dates[dates.length - 1]})`);
console.log(`all data: ROI shrink ${report.full.roi} [90% ${report.full.roiCI.join("-")}] | b win ${report.full.win} top1 ${report.full.top1} top10 ${report.full.top10} cash ${report.full.cash}`);
if (C2) { const all2 = rowsOf(C2, keys); report.seed2 = fitAll(all2); console.log(`seed 2:   ROI shrink ${report.seed2.roi} [90% ${report.seed2.roiCI.join("-")}] | b win ${report.seed2.win} top1 ${report.seed2.top1} top10 ${report.seed2.top10} cash ${report.seed2.cash}`); }
// groups by field size and by slate size (games): each group's own fit on both seeds, its two date halves, and the top decile under the all-data fit
const groups = { size: [["<400", q => q.N < 400], ["400-999", q => q.N >= 400 && q.N < 1000], ["1000+", q => q.N >= 1000]], slate: [["2-4 games", q => q.games <= 4], ["5-7 games", q => q.games >= 5 && q.games <= 7], ["8+ games", q => q.games >= 8]] };
for (const [g, list] of Object.entries(groups)) { report["by_" + g] = {}; for (const [lab, f] of list) { const ks = keys.filter(k => f(C1.get(k)[0])), rs = rowsOf(C1, ks), rs2 = C2 ? rowsOf(C2, ks) : null, h1 = ks.filter(k => C1.get(k)[0].date < half), h2 = ks.filter(k => C1.get(k)[0].date >= half);
  const o = report["by_" + g][lab] = { contests: ks.length, roi: +fitS(rs).toFixed(3), roiCI: bootS(rs), roiSeed2: rs2 ? +fitS(rs2).toFixed(3) : null, roiHalves: [+fitS(rowsOf(C1, h1)).toFixed(3), +fitS(rowsOf(C1, h2)).toFixed(3)], win: fitB(rs, "win"), winSeed2: rs2 ? fitB(rs2, "win") : null, top1: fitB(rs, "top1"), topDecileAtFull: topDecile(rs, report.full.roi), winLogLossAtFull: +(100 * (logLoss(rs, "win", report.full.win) / logLoss(rs, "win", 1) - 1)).toFixed(3) };
  console.log(`  ${lab.padEnd(9)} ${String(ks.length).padStart(3)} contests: ROI shrink ${o.roi} [90% ${o.roiCI.join("-")}] seed 2 ${o.roiSeed2} halves ${o.roiHalves.join(" / ")} | top decile raw ${o.topDecileAtFull.predRaw}% cal ${o.topDecileAtFull.predCal}% actual ${o.topDecileAtFull.actual}% | win b ${o.win} / ${o.winSeed2}, log loss at full fit ${o.winLogLossAtFull}% | top1 b ${o.top1}`); } }
for (const [name, [a, b]] of Object.entries(splits)) for (const [lab, trK, teK] of [["A->B", a, b], ["B->A", b, a]]) {
  const tr = rowsOf(C1, trK), te = rowsOf(C1, teK), fit = fitAll(tr), t = test(tr, te, fit);
  (report.splits[name] = report.splits[name] || {})[lab] = { fitContests: trK.length, testContests: teK.length, fit, test: t };
  console.log(`\n${name} ${lab}: fit ${trK.length} contests -> test ${teK.length}`);
  console.log(`  ROI shrink ${fit.roi} [90% ${fit.roiCI.join("-")}] (pooled OLS ${fit.roiPooledOLS}; test half alone ${t.roi.ownSlope}) | test decile RMSE ${t.roi.deciles.rmseRaw} -> ${t.roi.deciles.rmseCal} pts | test payout MSE ${t.roi.mseRaw} -> ${t.roi.mseCal} (${t.roi.pct}%) | sim top-10% entries: raw ${t.roi.topDecile.predRaw}% cal ${t.roi.topDecile.predCal}% actual ${t.roi.topDecile.actual}%`);
  for (const ev of Object.keys(EV)) console.log(`  ${ev.padEnd(6)} b ${t[ev].b} (test alone ${t[ev].ownB}) | log loss ${t[ev].logLossPct}% Brier ${t[ev].brierPct}% | predicted raw ${t[ev].raw.pred}% cal ${t[ev].cal.pred}% actual ${t[ev].raw.act}%`);
}
console.log("\nCALIB.nba_cl (all data) = " + JSON.stringify({ roi: report.full.roi, win: report.full.win, t1: report.full.top1, t10: report.full.top10, cash: report.full.cash }));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
