// Spread of the log residual by position and projection size, from the joined game logs and the
// projections inside the pulled contests. Fits sigma = a * proj^b per position, which is the shape
// SIGMA_DEF and SIGMA_TILT in src/engine/model.mjs encode.
//   node bench/fit-sigma.mjs cfb [--minproj=5]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
const SPORT = (process.argv[2] || "cfb").toLowerCase();
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const MINPROJ = flag("minproj") ?? 5;
const REF = flag("ref") ?? 11.5;
const FKEY = SPORT === "cfb" ? "cfb_cl" : "nfl_cl", logDir = path.join("data/logs", SPORT);
// CFB pools are QB/RB/WR only. NFL adds TE, K and DST, and those were never in this fit, which is
// why SIGMA_DEF.nfl carried hand-set values for them.
const POSITIONS = SPORT === "cfb" ? ["QB", "RB", "WR"] : ["QB", "RB", "WR", "TE", "K", "DST"];

const proj = {};
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  const { pool } = loadPulled(c.json), d = proj[c.date] = proj[c.date] || {};
  for (const p of pool.players) { if (!(p.proj > 0)) continue; const k = p.key + "|" + String(p.team).toUpperCase();
    if (!d[k] || d[k].proj < p.proj) d[k] = { proj: p.proj, pos: p.pos };
    const byN = d.__byName || (d.__byName = {}); (byN[p.key] = byN[p.key] || []).push({ proj: p.proj, pos: p.pos }); }
}
const rows = [];
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [])) {
  const date = f.replace(/\.json$/, ""), d = proj[date]; if (!d) continue;
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) {
      const nk = nrm(p.name); let pr = d[nk + "|" + String(p.team).toUpperCase()];
      if (!pr) { const h = (d.__byName || {})[nk]; if (h && h.length === 1) pr = h[0]; }
      if (!pr || pr.proj < MINPROJ) continue;
      rows.push({ pos: pr.pos, proj: pr.proj, z: Math.log((Math.max(0, p.pts) + 0.5) / (pr.proj + 0.5)) });
    }
  }
}
const sd = a => { if (a.length < 2) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, y) => s + (y - m) ** 2, 0) / (a.length - 1)); };
console.log(`${rows.length} player-games with a projection >= ${MINPROJ}\n`);
const TIERS = [[5, 10], [10, 15], [15, 20], [20, 99]];
console.log("pos   " + TIERS.map(t => `${t[0]}-${t[1] === 99 ? "+" : t[1]}`.padEnd(14)).join("") + "fitted sigma = a * proj^b");
const byPos = {};
for (const r of rows) (byPos[r.pos] = byPos[r.pos] || []).push(r);
for (const pos of POSITIONS) {
  const rs = byPos[pos] || []; if (!rs.length) continue;
  const pts = [], cells = [];
  for (const [lo, hi] of TIERS) {
    const g = rs.filter(r => r.proj >= lo && r.proj < hi), s = sd(g.map(r => r.z));
    cells.push(`${isNaN(s) ? "-" : s.toFixed(3)} (${g.length})`.padEnd(14));
    if (g.length >= 60 && !isNaN(s)) pts.push([Math.log(g.reduce((a, r) => a + r.proj, 0) / g.length), Math.log(s)]);
  }
  // least squares on log sigma against log projection
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0; for (const p of pts) { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) ** 2; }
  const b = sxy / sxx, a = Math.exp(my - b * mx);
  if (pts.length < 2) { console.log(pos.padEnd(6) + cells.join("") + "too few tiers to fit"); continue; }
  console.log(pos.padEnd(6) + cells.join("") + `a ${a.toFixed(3)}  b ${b.toFixed(3)}   sigma at ${REF} proj: ${(a * Math.pow(REF, b)).toFixed(3)}`);
}
