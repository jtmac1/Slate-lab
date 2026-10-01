// Fit a zero-inflated lognormal to real MLB player-games: a bust mass at zero that shrinks with the
// projection, and the sigma of the non-zero part that reproduces its quantiles. Joins the projections
// inside pulled contests to the per-game logs (bench/game-logs-mlb.mjs).
//   node bench/fit-bust-mlb.mjs [--out=data/reports/bust-mlb.json]
// Output: { hit: { a, b, sigma }, pit: { a, b, sigma } } with P(bust) = min(0.6, a * (ref / proj)^b)
// (ref 6 for hitters, 15 for pitchers) and the non-zero part lognormal with sigma, mean-preserving.
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost, isPitcher } from "./post-store.mjs";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const OUT = flag("out") || "data/reports/bust-mlb.json", logDir = "data/logs/mlb";
const noMid = n => n.replace(/\s+[A-Z]\.?\s+/, " ");
const proj = {};
for (const f of listPost("mlb")) {
  const j = readPost(f), c = j.contest; if (c.type !== "Classic" || !j.players?.length) continue;
  const d = proj[c.date] = proj[c.date] || {};
  for (const p of j.players) { if (!(p.proj > 0)) continue; const k = nrm(p.name) + "|" + String(p.team).toUpperCase(); if (!d[k] || d[k].proj < p.proj) d[k] = { proj: p.proj, isP: isPitcher(p.pos) }; }
}
const rows = [];
for (const f of fs.readdirSync(logDir).filter(f => f.endsWith(".json"))) {
  const d = proj[f.replace(/\.json$/, "")]; if (!d) continue;
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) {
      const pr = d[nrm(p.name) + "|" + p.team] || d[nrm(noMid(p.name)) + "|" + p.team]; if (!pr || pr.isP !== p.isP) continue;
      if (p.isP ? !p.starter : !p.ord) continue;
      rows.push({ isP: p.isP, proj: pr.proj, pts: Math.max(0, p.pts) });
    }
  }
}
// standard normal quantile (Acklam), for lognormal quantiles
function qnorm(p) { const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239], b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1], c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]; const pl = 0.02425; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); } q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
const q = (arr, f) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const out = {};
for (const [grp, isP, ref, edges] of [["hit", false, 6, [3, 4, 5, 6, 7, 8, 9, 11, 99]], ["pit", true, 15, [8, 11, 14, 17, 20, 99]]]) {
  const rs = rows.filter(r => r.isP === isP && r.proj >= edges[0]);
  const pts = [];   // per-bucket bust rate for the power-law fit
  console.log(`== ${grp}: ${rs.length} player-games`);
  console.log("bucket    n     P(0)   nonzero: sigma that matches q50/q75/q90 (rms)");
  const fitSig = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const b = rs.filter(r => r.proj >= edges[i] && r.proj < edges[i + 1]); if (b.length < 80) continue;
    const p0 = b.filter(r => r.pts <= 0).length / b.length, mid = b.reduce((s, r) => s + r.proj, 0) / b.length;
    pts.push({ mid, p0, n: b.length });
    const nz = b.filter(r => r.pts > 0).map(r => r.pts / r.proj), mean = nz.reduce((s, x) => s + x, 0) / nz.length;
    let best = null;
    for (let s = 0.3; s <= 1.3; s += 0.01) { const med = mean * Math.exp(-s * s / 2); let e = 0; for (const f of [0.5, 0.75, 0.9]) { const model = med * Math.exp(s * qnorm(f)); e += Math.log(model / q(nz, f)) ** 2; } if (!best || e < best.e) best = { s, e }; }
    fitSig.push({ s: best.s, n: b.length });
    console.log(`${edges[i]}-${edges[i + 1] === 99 ? "+" : edges[i + 1]}`.padEnd(10) + String(b.length).padEnd(6) + (100 * p0).toFixed(0).padStart(3) + "%   sigma " + best.s.toFixed(2) + "  (rms " + Math.sqrt(best.e / 3).toFixed(3) + ")  nonzero mean/proj " + mean.toFixed(2));
  }
  // P(0) = a * (ref/proj)^b, weighted log-log regression
  let sx = 0, sy = 0, sxx = 0, sxy = 0, sw = 0;
  for (const p of pts) { if (p.p0 <= 0) continue; const x = Math.log(ref / p.mid), y = Math.log(p.p0), w = p.n; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; sw += w; }
  const bb = (sxy - sx * sy / sw) / (sxx - sx * sx / sw), aa = Math.exp((sy - bb * sx) / sw);
  const sig = fitSig.reduce((s, f) => s + f.s * f.n, 0) / fitSig.reduce((s, f) => s + f.n, 0);
  out[grp] = { a: +aa.toFixed(3), b: +bb.toFixed(3), ref, sigma: +sig.toFixed(2) };
  console.log(`fit: P(0) = ${aa.toFixed(3)} * (${ref}/proj)^${bb.toFixed(2)}, nonzero sigma ${sig.toFixed(2)} (pair-weighted)\n`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fitted: new Date().toISOString(), rows: rows.length, ...out }, null, 1));
console.log("wrote", OUT);
