// The builder is not meant to be played blind - the workflow is build candidates, simulate them
// against a generated field, play the ones the sim ranks highest. That is a different question from
// whether the average built lineup is any good, so this tests the whole loop: build, simulate, pick
// by the shipped rule, then score the picks with what actually happened inside the real field.
// Benchmarks: the same built lineups picked at random, and the real field's own average.
//   node bench/builder-workflow.mjs [cfb_cl] [--n=30] [--build=20] [--rand=3] [--iters=2000]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { buildLineups } from "../src/engine/build.mjs";
import { fieldProfile, genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { featurize, RULES } from "../src/engine/select.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 30, K = flag("build") || 20, RAND = flag("rand") ?? 3, ITERS = flag("iters") || 2000;
// --source=builder or --source=field: where the candidate lineups come from. The generator builds
// realistic entries and is the part that was actually fitted, so it is the obvious alternative.
const SOURCE = (process.argv.find(a=>a.startsWith("--source=")) || "--source=builder").slice(9);
const SPORT = FKEY.startsWith("cfb") ? "cfb" : "nfl";
const RULE = RULES["ROI gated: top half proj"];

const logDir = path.join("data/logs", SPORT), actByDate = {};
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [])) {
  const d = actByDate[f.replace(/\.json$/, "")] = {};
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) { const k = nrm(p.name); if (!(k in d) || d[k] < p.pts) d[k] = p.pts; }
  }
}
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const out = { pick1: [], pick3: [], rand1: [], all: [], field: [], cash1: [], cashAll: [], cashField: [], med1: [], medAll: [], pct: [] };
let used = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (used >= LIM) break;
  const A = actByDate[c.date]; if (!A) continue;
  const { pool, entries, payouts, paid } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 100 || !paid) continue;
  const P = pool.players, N = entries.length;
  const rng = mulberry32(1000 + used);
  const genOpt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 }, fieldProfile(c.fee, FKEY, N));
  let b;
  if (SOURCE === "field") {
    const cand = genField(pool, Math.max(K, 60), genOpt, mulberry32(555 + used)).field;
    b = { lineups: cand.slice(0, K) };
  } else b = buildLineups(pool, { n: K, obj: "blend", rand: RAND / 100, maxExp: 60, minSal: 0, minUniq: 1, stackSize: 0, force: [], exclude: [] }, rng);
  if (b.err || !b.lineups || b.lineups.length < 5) continue;
  let miss = 0, tot = 0;
  const score = lu => { let s = 0; for (const id of lu) { const v = A[P[id].key]; tot++; if (v == null) miss++; else s += v; } return s; };
  const act = b.lineups.map(score);
  if (miss / Math.max(1, tot) > 0.15) continue;

  // the sim the app would run: our candidates against a generated field of this contest's size
  const gen = genField(pool, N, genOpt, mulberry32(11 + used)).field;
  if (gen.length < 50) continue;
  const model = buildModel(pool, {});
  const res = simulate({ pool, model, field: gen, lineups: b.lineups, payouts, entries: N, fee: 1, iters: ITERS, rng: mulberry32(5 + used), fieldMode: false });
  const pj = lu => lu.reduce((t, id) => t + (P[id].proj || 0), 0), ow = lu => lu.reduce((t, id) => t + (P[id].own || 0), 0);
  const feats = featurize(res.rows.map((r, i) => ({ proj: pj(b.lineups[i]), roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: ow(b.lineups[i]) })));
  const rank = feats.map((f, i) => ({ i, s: RULE(f) })).sort((a, b2) => b2.s - a.s);

  const fieldScores = scored.map(e => e.actFP).sort((a, b2) => b2 - a);
  const roiOf = s => { let r = 0; while (r < fieldScores.length && fieldScores[r] > s) r++;
    return 100 * ((payouts[Math.min(payouts.length - 1, r)] || 0) - 1); };
  const med=a=>{const x=a.slice().sort((u,v)=>u-v);return x[Math.floor(x.length/2)];};
  out.cash1.push(roiOf(act[rank[0].i])>-100?1:0);
  out.cashAll.push(mean(act.map(v=>roiOf(v)>-100?1:0)));
  out.cashField.push(scored.filter(e=>e.actROI>-100).length/scored.length);
  out.med1.push(roiOf(act[rank[0].i])); out.medAll.push(med(act.map(roiOf)));
  { let r = 0; const sc = act[rank[0].i]; while (r < fieldScores.length && fieldScores[r] > sc) r++;
    out.pct.push(r / fieldScores.length); }
  out.pick1.push(roiOf(act[rank[0].i]));
  out.pick3.push(mean(rank.slice(0, 3).map(x => roiOf(act[x.i]))));
  out.rand1.push(mean(act.map(roiOf)));
  out.all.push(mean(act.map(roiOf)));
  out.field.push(mean(scored.map(e => e.actROI)));
  used++;
}
console.log(`${used} contests, source ${SOURCE}, ${K} lineups each at ${RAND}% randomness, ${ITERS} draws, picked by "ROI gated: top half proj"\n`);
console.log("what you played".padEnd(40) + "average return");
console.log("the sim's top pick".padEnd(40) + mean(out.pick1).toFixed(1) + "%");
console.log("the sim's top 3".padEnd(40) + mean(out.pick3).toFixed(1) + "%");
console.log("a built lineup at random".padEnd(40) + mean(out.rand1).toFixed(1) + "%");
console.log("the real field's own average".padEnd(40) + mean(out.field).toFixed(1) + "%");
console.log("");
console.log("cash rate, the sim s top pick".padEnd(40)+(100*mean(out.cash1)).toFixed(1)+"%");
console.log("cash rate, a built lineup".padEnd(40)+(100*mean(out.cashAll)).toFixed(1)+"%");
console.log("cash rate, the real field".padEnd(40)+(100*mean(out.cashField)).toFixed(1)+"%");
const sdv = a2 => { const mu = mean(a2); return Math.sqrt(mean(a2.map(x => (x - mu) ** 2)) * a2.length / (a2.length - 1)); };
const pair = (lab, arr) => { const d = arr.map((v, i) => v - out.field[i]), se = sdv(d) / Math.sqrt(d.length);
  console.log("  " + lab.padEnd(22) + mean(d).toFixed(1).padEnd(10) + "se " + se.toFixed(1).padEnd(8)
    + "95% [" + (mean(d) - 1.96 * se).toFixed(0) + ", " + (mean(d) + 1.96 * se).toFixed(0) + "]   ahead in " + d.filter(x => x > 0).length + "/" + d.length); };
console.log("\nreturn minus the field average of the same contest");
pair("the sim top pick", out.pick1); pair("the sim top 3", out.pick3); pair("a built lineup", out.rand1);
const pairC = (lab, arr) => { const d = arr.map((v, i) => v - out.cashField[i]), se = sdv(d) / Math.sqrt(d.length);
  console.log("  " + lab.padEnd(22) + (100 * mean(d)).toFixed(1).padEnd(10) + "se " + (100 * se).toFixed(1).padEnd(8)
    + "t = " + (mean(d) / se).toFixed(1).padEnd(8) + "ahead in " + d.filter(x => x > 0).length + "/" + d.length); };
console.log("\ncash rate minus the field, in points");
pairC("the sim top pick", out.cash1); pairC("a built lineup", out.cashAll);
// Returns here are heavy tailed - the mean is carried by a handful of large finishes - so the
// normal interval above is optimistic. Bootstrap the paired difference instead, and report the
// median and the win rate, which do not depend on the tail behaving.
const boot = (arr, reps = 4000) => {
  const d = arr.map((v, i) => v - out.field[i]), n = d.length, ms = [];
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let r = 0; r < reps; r++) { let t = 0; for (let i = 0; i < n; i++) t += d[(rnd() * n) | 0]; ms.push(t / n); }
  ms.sort((x, y) => x - y);
  const med = dd => { const x = dd.slice().sort((u, v) => u - v); return x[Math.floor(x.length / 2)]; };
  return { lo: ms[Math.floor(reps * 0.025)], hi: ms[Math.floor(reps * 0.975)], mean: mean(d), med: med(d), win: d.filter(x => x > 0).length, n };
};
console.log("\nbootstrapped, 4000 resamples of the paired difference");
for (const [lab, arr] of [["the sim top pick", out.pick1], ["the sim top 3", out.pick3], ["a built lineup", out.rand1]]) {
  const r = boot(arr);
  console.log("  " + lab.padEnd(22) + "mean " + r.mean.toFixed(1).padEnd(9) + "95% [" + r.lo.toFixed(0) + ", " + r.hi.toFixed(0) + "]".padEnd(6)
    + "  median " + r.med.toFixed(1).padEnd(9) + "ahead " + r.win + "/" + r.n);
}
// How much of the edge is a handful of contests? Drop the biggest wins one at a time. If the mean
// goes negative after removing two or three, there is no edge - just a few lucky slates.
{
  const d = out.pick1.map((v, i) => v - out.field[i]).slice().sort((x, y) => y - x);
  const tot = d.reduce((x, y) => x + y, 0);
  console.log("\nhow concentrated is it - drop the best N contests of " + d.length);
  for (const k of [0, 1, 2, 3, 5, 10]) {
    const rest = d.slice(k), mu = rest.reduce((x, y) => x + y, 0) / rest.length;
    console.log("  drop " + String(k).padEnd(4) + "mean " + mu.toFixed(1).padEnd(10)
      + "the top " + (k || 1) + " contribute " + (100 * (tot - rest.reduce((x, y) => x + y, 0)) / Math.abs(tot)).toFixed(0) + "% of the total");
  }
}
// Dollar returns in a tournament are carried by a few huge finishes, so their mean is a poor
// estimator and dropping the best few unfairly guts any real GPP edge. The thing that GENERATES
// those finishes is reaching the top tiers more often than chance, and a hit rate is a count with
// honest binomial error bars. An average entry finishes top 1% one time in a hundred by definition,
// so that is the benchmark.
{
  const tiers = [[0.001, "top 0.1%"], [0.01, "top 1%"], [0.05, "top 5%"], [0.10, "top 10%"]];
  console.log("\nhow often the pick reaches each tier, over " + out.pct.length + " contests");
  console.log("  tier".padEnd(14) + "expected".padEnd(11) + "observed".padEnd(11) + "ratio".padEnd(9) + "z");
  for (const [q, lab] of tiers) {
    const hits = out.pct.filter(x => x <= q).length, n = out.pct.length, exp = q * n;
    const z = (hits - exp) / Math.sqrt(Math.max(1e-9, n * q * (1 - q)));
    console.log("  " + lab.padEnd(14) + exp.toFixed(1).padEnd(11) + String(hits).padEnd(11)
      + (exp > 0 ? (hits / exp).toFixed(1) + "x" : "-").padEnd(9) + z.toFixed(1));
  }
}
const beat = out.pick1.filter((v, i) => v > out.rand1[i]).length;
console.log(`\nthe sim's pick beat an average built lineup in ${beat} of ${used} contests`);
