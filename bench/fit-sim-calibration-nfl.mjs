// Fit the post-hoc recalibration of the sim's reported numbers (src/engine/sim.mjs CALIB) on one season and
// test it on another. Rows come from bench/grade-all.mjs --rows (every real entry simmed in its real contest).
//   ROI:   payout multiple x = 1 + roi/100 is shrunk toward the contest's average payout m (the rake level):
//          x' = m + s (x - m), s fitted by least squares on (actual - m) ~ (x - m), clustered by date for the CI
//   probs: p' = base (p / base)^b, b by maximum likelihood (base = the event's share of the field), per event
// Both are monotone, so the order of lineups inside a sim run never changes; only the levels do.
//   node bench/fit-sim-calibration-nfl.mjs --fit=2025 --test=2026 data/reports/cal/base.s0.jsonl ...
import fs from "node:fs";

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const FIT = arg("fit") || "2025", TEST = arg("test") || "2026", files = process.argv.slice(2).filter(a => !a.startsWith("--"));
const EV = { win: ["win", "won"], top1: ["t1", "top1"], top10: ["t10", "top10"], cash: ["cash", "cashed"] };
const byC = new Map();
for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line) continue; const r = JSON.parse(line); if (r.finish == null || r.t1 == null) continue; (byC.get(r.c) || byC.set(r.c, []).get(r.c)).push(r); }
const fmtOf = r => (r.fkey || "").includes("sd") ? "sd" : "cl";
const baseOf = (r, ev) => { const N = r.N || 1; return ev === "win" ? 1 / N : ev === "top1" ? Math.max(1, Math.round(N * 0.01)) / N : ev === "top10" ? Math.max(1, Math.round(N * 0.1)) / N : (r.paid || 0) / N; };
// contest-level average predicted payout (all entries are in the sim, so this is the rake level)
const rowsOf = (season, fmt) => { const out = []; for (const rs of byC.values()) { if (season !== "all" && rs[0].date.slice(0, 4) !== season || fmtOf(rs[0]) !== fmt) continue; const m = rs.reduce((s, r) => s + 1 + r.roi / 100, 0) / rs.length; for (const r of rs) out.push({ r, m }); } return out; };

function fitS(rows) { let sxy = 0, sxx = 0; for (const { r, m } of rows) { const x = 1 + r.roi / 100 - m, y = 1 + r.actROI / 100 - m; sxy += x * y; sxx += x * x; } return sxy / sxx; }
function bootS(rows, reps = 300) { const byD = {}; for (const q of rows) (byD[q.r.date] = byD[q.r.date] || { sxy: 0, sxx: 0 }); for (const { r, m } of rows) { const d = byD[r.date], x = 1 + r.roi / 100 - m, y = 1 + r.actROI / 100 - m; d.sxy += x * y; d.sxx += x * x; }
  const ds = Object.values(byD), out = []; let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let b = 0; b < reps; b++) { let a = 0, c = 0; for (let i = 0; i < ds.length; i++) { const d = ds[Math.floor(rnd() * ds.length)]; a += d.sxy; c += d.sxx; } out.push(a / c); } out.sort((x, y) => x - y); return [out[Math.floor(reps * 0.05)], out[Math.floor(reps * 0.95)]]; }
// log-likelihood of the outcomes under p' = base (p/base)^b, clipped
function ll(rows, ev, b) { const [pk, ak] = EV[ev]; let s = 0; for (const { r } of rows) { const base = baseOf(r, ev); if (!(base > 0)) continue; const p = Math.min(0.999, Math.max(1e-6, base * Math.pow(Math.max(1e-6, r[pk] / 100) / base, b))); s += r[ak] ? Math.log(p) : Math.log(1 - p); } return s; }
function fitB(rows, ev) { let best = 1, bl = -Infinity; for (let b = 0; b <= 1.5001; b += 0.02) { const v = ll(rows, ev, b); if (v > bl) { bl = v; best = b; } } return +best.toFixed(2); }
function brier(rows, ev, b) { const [pk, ak] = EV[ev]; let s = 0, n = 0; for (const { r } of rows) { const base = baseOf(r, ev); if (!(base > 0)) continue; const p = Math.min(1, base * Math.pow(Math.max(1e-6, r[pk] / 100) / base, b)); s += (p - r[ak]) ** 2; n++; } return s / n; }
function roiErr(rows, s) { let e0 = 0, e1 = 0; for (const { r, m } of rows) { const x = 1 + r.roi / 100, y = 1 + r.actROI / 100; e0 += (x - y) ** 2; e1 += (m + s * (x - m) - y) ** 2; } return [e0 / rows.length, e1 / rows.length]; }

const out = {};
for (const fmt of ["cl", "sd"]) {
  const tr = rowsOf(FIT, fmt), te = rowsOf(TEST, fmt);
  if (!tr.length) continue;
  const s = fitS(tr), ci = bootS(tr), sTest = te.length ? fitS(te) : null, [e0, e1] = te.length ? roiErr(te, s) : [0, 0];
  out[fmt] = { roiShrink: +s.toFixed(3) };
  console.log(`\n${fmt}: fit ${FIT} (${tr.length} entries) ROI shrink s = ${s.toFixed(3)} [90% ${ci[0].toFixed(3)}-${ci[1].toFixed(3)}] | ${TEST} own slope ${sTest == null ? "-" : sTest.toFixed(3)} | ${TEST} payout MSE raw ${e0.toFixed(3)} -> recalibrated ${e1.toFixed(3)}`);
  for (const ev of Object.keys(EV)) {
    const b = fitB(tr, ev), bTest = te.length ? fitB(te, ev) : null;
    const br0 = te.length ? brier(te, ev, 1) : 0, br1 = te.length ? brier(te, ev, b) : 0;
    out[fmt][ev] = b;
    console.log(`  ${ev.padEnd(6)} b = ${b.toFixed(2)} (fit on ${FIT}; ${TEST} alone would pick ${bTest == null ? "-" : bTest.toFixed(2)}) | ${TEST} Brier raw ${br0.toFixed(6)} -> recalibrated ${br1.toFixed(6)} (${(100 * (br1 / br0 - 1)).toFixed(2)}%)`);
  }
}
console.log("\nCALIB = " + JSON.stringify(out));
