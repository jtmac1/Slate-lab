// What does a real MLB player-game look like against its projection, and how far is the lognormal
// draw from it? Joins the projections inside pulled contests to the per-game logs
// (bench/game-logs-mlb.mjs) and, per projection bucket, reports the bust rate, the quantiles of
// actual/projected, the big-game rates, and the same numbers from the model's own draw for the
// same players (sigmaFor + toScore, no correlation needed for marginals).
//   node bench/hitter-shape-mlb.mjs [--draws=200]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost, isPitcher } from "./post-store.mjs";
import { sigmaFor, toScore, SIGMA_DEF, BUST, bustProb } from "../src/engine/model.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const DRAWS = flag("draws") || 200, logDir = "data/logs/mlb", USEBUST = process.argv.includes("--bust"), HSIG = flag("hsig"), PSIG = flag("psig");
const SIG = Object.assign({}, SIGMA_DEF.mlb); if (HSIG != null) for (const k of ["C", "1B", "2B", "3B", "SS", "OF"]) SIG[k] = HSIG; if (PSIG != null) for (const k of ["P", "SP", "RP"]) SIG[k] = PSIG;
const noMid = n => n.replace(/\s+[A-Z]\.?\s+/, " ");
const proj = {};
for (const f of listPost("mlb")) {
  const j = readPost(f), c = j.contest; if (c.type !== "Classic" || !j.players?.length) continue;
  const d = proj[c.date] = proj[c.date] || {};
  for (const p of j.players) { if (!(p.proj > 0)) continue; const k = nrm(p.name) + "|" + String(p.team).toUpperCase(); if (!d[k] || d[k].proj < p.proj) d[k] = { proj: p.proj, isP: isPitcher(p.pos), pos: String(p.pos).split("/")[0] }; }
}
const rows = [];
for (const f of fs.readdirSync(logDir).filter(f => f.endsWith(".json"))) {
  const d = proj[f.replace(/\.json$/, "")]; if (!d) continue;
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) {
      const pr = d[nrm(p.name) + "|" + p.team] || d[nrm(noMid(p.name)) + "|" + p.team]; if (!pr || pr.isP !== p.isP) continue;
      if (p.isP ? !p.starter : !p.ord) continue;
      rows.push({ isP: p.isP, pos: pr.pos, proj: pr.proj, pts: Math.max(0, p.pts) });
    }
  }
}
const rng = mulberry32(7);
const q = (arr, f) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const stats = (xs, projs) => {
  const ratio = xs.map((x, i) => x / projs[i]);
  const rate = f => xs.filter((x, i) => f(x, projs[i])).length / xs.length;
  return { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / projs.reduce((a, b) => a + b, 0), p0: rate(x => x <= 0), p2: rate(x => x <= 2), q10: q(ratio, .1), q25: q(ratio, .25), q50: q(ratio, .5), q75: q(ratio, .75), q90: q(ratio, .9), q95: q(ratio, .95), q99: q(ratio, .99), big10: rate((x, m) => x >= m + 10), big20: rate((x, m) => x >= m + 20), big30: rate((x, m) => x >= m + 30) };
};
const fmt = s => `n ${String(s.n).padStart(5)} mean/proj ${s.mean.toFixed(2)} P(0) ${(100 * s.p0).toFixed(0).padStart(2)}% P(<=2) ${(100 * s.p2).toFixed(0).padStart(2)}% | q10 ${s.q10.toFixed(2)} q25 ${s.q25.toFixed(2)} q50 ${s.q50.toFixed(2)} q75 ${s.q75.toFixed(2)} q90 ${s.q90.toFixed(2)} q95 ${s.q95.toFixed(2)} q99 ${s.q99.toFixed(2)} | P(+10) ${(100 * s.big10).toFixed(1).padStart(4)}% P(+20) ${(100 * s.big20).toFixed(1).padStart(4)}% P(+30) ${(100 * s.big30).toFixed(1).padStart(4)}%`;
const buckets = [["hitters 3-5", r => !r.isP && r.proj >= 3 && r.proj < 5], ["hitters 5-7", r => !r.isP && r.proj >= 5 && r.proj < 7], ["hitters 7-9", r => !r.isP && r.proj >= 7 && r.proj < 9], ["hitters 9+", r => !r.isP && r.proj >= 9], ["pitchers 8-14", r => r.isP && r.proj >= 8 && r.proj < 14], ["pitchers 14-20", r => r.isP && r.proj >= 14 && r.proj < 20], ["pitchers 20+", r => r.isP && r.proj >= 20]];
console.log(`${rows.length} starter player-games joined to a projection\n`);
for (const [name, f] of buckets) {
  const rs = rows.filter(f); if (rs.length < 50) continue;
  const act = stats(rs.map(r => r.pts), rs.map(r => r.proj));
  const sim = [], sp = [];
  for (const r of rs) { const p = { proj: r.proj, pos: r.isP ? "SP" : r.pos, isP: r.isP }; const sg = sigmaFor(p, "mlb", undefined, SIG, true), p0 = USEBUST ? bustProb(p, BUST.mlb) : 0; for (let k = 0; k < DRAWS; k++) { sim.push(toScore(p, rng.gauss(), sg, undefined, 0, 0, p0)); sp.push(r.proj); } }
  const sm = stats(sim, sp);
  console.log(`== ${name}\n  actual ${fmt(act)}\n  model  ${fmt(sm)}`);
}
