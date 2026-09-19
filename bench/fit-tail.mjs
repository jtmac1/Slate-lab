// How fat is the real upper tail? Joins the game logs to the projections inside the pulled contests,
// turns each player-game into the z it would have needed under our own sigma, and compares the
// observed upper quantiles against the standard normal the draw assumes. The gap is what TAIL in
// src/engine/model.mjs has to make up, and fitting it here rather than to the winning score keeps
// the bend inside what college football actually produces.
//   node bench/fit-tail.mjs cfb [--minproj=5]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { sigmaFor, SIGMA_DEF, SIGMA_TILT, SIGMA_TILT_REF, bendZ } from "../src/engine/model.mjs";
const SPORT = (process.argv[2] || "cfb").toLowerCase();
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const MINPROJ = flag("minproj") ?? 5;
const FKEY = SPORT === "cfb" ? "cfb_cl" : "nfl_cl", logDir = path.join("data/logs", SPORT);

const proj = {};
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  const { pool } = loadPulled(c.json), d = proj[c.date] = proj[c.date] || {};
  for (const p of pool.players) { if (!(p.proj > 0)) continue; const k = p.key + "|" + String(p.team).toUpperCase();
    if (!d[k] || d[k].proj < p.proj) d[k] = p;
    const byN = d.__byName || (d.__byName = {}); (byN[p.key] = byN[p.key] || []).push(p); }
}
const zs = [];
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [])) {
  const date = f.replace(/\.json$/, ""), d = proj[date]; if (!d) continue;
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const pl of g.players) {
      const nk = nrm(pl.name); let p = d[nk + "|" + String(pl.team).toUpperCase()];
      if (!p) { const h = (d.__byName || {})[nk]; if (h && h.length === 1) p = h[0]; }
      if (!p || !(p.proj >= MINPROJ)) continue;
      const sg = sigmaFor(p, SPORT, undefined, SIGMA_DEF[SPORT], false, SIGMA_TILT[SPORT], SIGMA_TILT_REF[SPORT]);
      if (!(sg > 0)) continue;
      // the z this outcome implies under our own mean-preserving lognormal
      zs.push((Math.log(Math.max(0.5, pl.pts) / p.proj) + sg * sg / 2) / sg);
    }
  }
}
zs.sort((a, b) => a - b);
const n = zs.length;
// the standard normal quantile, Acklam's inverse
function invNorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) return -invNorm(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
console.log(`${n} player-games with a projection >= ${MINPROJ}\n`);
console.log("percentile".padEnd(13) + "normal z".padEnd(12) + "observed z".padEnd(13) + "gap");
const PS = [0.5, 0.75, 0.9, 0.95, 0.99, 0.995, 0.999];
const obs = {};
for (const p of PS) {
  const o = zs[Math.min(n - 1, Math.floor(n * p))], e = invNorm(p);
  obs[p] = o;
  console.log((100 * p + "%").padEnd(13) + e.toFixed(3).padEnd(12) + o.toFixed(3).padEnd(13) + (o - e >= 0 ? "+" : "") + (o - e).toFixed(3));
}
// pick the bend that matches the observed upper quantiles best
let best = null;
for (let c = 0.5; c <= 2.51; c += 0.1) {
  for (let a = 0; a <= 0.61; a += 0.02) {
    let err = 0;
    for (const p of [0.95, 0.99, 0.995, 0.999]) { const e = bendZ(invNorm(p), c, a); err += (e - obs[p]) ** 2; }
    if (!best || err < best.err) best = { c: +c.toFixed(2), a: +a.toFixed(2), err };
  }
}
console.log(`\nbest fit over the 95th to 99.9th percentiles: c ${best.c}, a ${best.a} (rms ${Math.sqrt(best.err / 4).toFixed(3)})`);
console.log("that bend maps: " + [0.95, 0.99, 0.999].map(p => `${100 * p}% ${invNorm(p).toFixed(2)}->${bendZ(invNorm(p), best.c, best.a).toFixed(2)} (real ${obs[p].toFixed(2)})`).join(", "));
