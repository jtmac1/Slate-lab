// The actual workflow: run the Contest Generator, simulate the lineups it produced, and enter the
// ones Lineup Score ranks highest. Nothing had ever graded this. grade-all's default mode ranks real
// entries against each other and --genfield ranks real entries against a generated field; both rank
// REAL entries, so neither asks whether a lineup taken OUT of the generated field is any good.
//
// Here the generated field is both the opponent set and the candidate set, exactly as the app does
// it. Picks are scored with what the players actually did, ranked inside the REAL contest field, and
// paid from that contest's real payout curve.
// Benchmarks: a generated lineup picked at random, and the real field's own average, whose return is
// the rake by construction.
//   node bench/pick-from-field.mjs [cfb_cl] [--n=60] [--iters=2000] [--gate=50]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { fieldProfile, genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { featurize, spearman } from "../src/engine/select.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 60, ITERS = flag("iters") || 2000, GATE = (flag("gate") ?? 50) / 100;
const SPORT = FKEY.startsWith("cfb") ? "cfb" : "nfl";
// Lineup Score as the app computes it: simulated ROI, ranked only among lineups projecting in the
// top share of the field, everything below it pushed to the bottom.
const scoreOf = f => f.rProj >= 1 - GATE ? f.roi : -1e9 + f.rProj;

const logDir = path.join("data/logs", SPORT), actByDate = {};
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [])) {
  const d = actByDate[f.replace(/\.json$/, "")] = {};
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) { const k = nrm(p.name); if (!(k in d) || d[k] < p.pts) d[k] = p.pts; }
  }
}
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const O = { top1: [], top3: [], top20: [], any: [], field: [], c1: [], c3: [], c20: [], cAny: [], cField: [], rRoi: [], rScore: [], rProj: [], beat: 0, n: 0 };
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (O.n >= LIM) break;
  const A = actByDate[c.date]; if (!A) continue;
  const { pool, entries, payouts, paid } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 100 || !paid) continue;
  const P = pool.players, N = entries.length;
  const opt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 }, fieldProfile(c.fee, FKEY, N));
  const gen = genField(pool, N, opt, mulberry32(11 + O.n)).field;
  if (gen.length < 100) continue;
  let miss = 0, tot = 0;
  const score = lu => { let s = 0; for (const id of lu) { const v = A[P[id].key]; tot++; if (v == null) miss++; else s += v; } return s; };
  const act = gen.map(score);
  if (miss / Math.max(1, tot) > 0.15) continue;

  const model = buildModel(pool, {});
  const res = simulate({ pool, model, field: gen, lineups: gen, payouts, entries: N, fee: 1, iters: ITERS, rng: mulberry32(5 + O.n), fieldMode: true });
  const feats = featurize(gen, P, pool.format, res.rows);
  const rank = feats.map((f, i) => ({ i, s: scoreOf(f) })).sort((a, b) => b.s - a.s);

  const fieldScores = scored.map(e => e.actFP).sort((a, b) => b - a);
  const roiOf = s => { let r = 0; while (r < fieldScores.length && fieldScores[r] > s) r++;
    return 100 * ((payouts[Math.min(payouts.length - 1, r)] || 0) - 1); };
  const roiAt = idx => roiOf(act[idx]);
  const k20 = Math.max(1, Math.round(rank.length * 0.2));
  const t1 = roiAt(rank[0].i), t3 = mean(rank.slice(0, 3).map(x => roiAt(x.i)));
  const t20 = mean(rank.slice(0, k20).map(x => roiAt(x.i))), anyv = mean(act.map(roiOf));
  O.top1.push(t1); O.top3.push(t3); O.top20.push(t20); O.any.push(anyv);
  O.field.push(mean(scored.map(e => e.actROI)));
  O.c1.push(t1 > -100 ? 1 : 0); O.c3.push(mean(rank.slice(0, 3).map(x => roiAt(x.i) > -100 ? 1 : 0)));
  O.c20.push(mean(rank.slice(0, k20).map(x => roiAt(x.i) > -100 ? 1 : 0)));
  O.cAny.push(mean(act.map(v => roiOf(v) > -100 ? 1 : 0)));
  O.cField.push(scored.filter(e => e.actROI > -100).length / scored.length);
  // can the sim rank these lineups at all? correlate its own numbers with what they actually scored
  O.rRoi.push(spearman(feats.map(f => f.roi), act));
  O.rScore.push(spearman(feats.map(scoreOf), act));
  O.rProj.push(spearman(gen.map(l => l.reduce((s2, id) => s2 + (P[id].proj || 0), 0)), act));
  if (t20 > anyv) O.beat++;
  O.n++;
}
console.log(`${O.n} contests, the generated field simulated against itself, ${ITERS} draws, Lineup Score gate ${(100 * GATE).toFixed(0)}%\n`);
console.log("what you entered".padEnd(42) + "cash rate".padEnd(13) + "average return");
const row = (lab, cash, roi) => console.log(lab.padEnd(42) + ((100 * mean(cash)).toFixed(1) + "%").padEnd(13) + mean(roi).toFixed(1) + "%");
row("Lineup Score top 1", O.c1, O.top1);
row("Lineup Score top 3", O.c3, O.top3);
row("Lineup Score top 20%", O.c20, O.top20);
row("a generated lineup at random", O.cAny, O.any);
row("the real field's own average", O.cField, O.field);
console.log("\nhow well each ranks the generated lineups against what they actually scored");
console.log("  simulated ROI".padEnd(26) + mean(O.rRoi).toFixed(3));
console.log("  Lineup Score".padEnd(26) + mean(O.rScore).toFixed(3));
console.log("  projected points".padEnd(26) + mean(O.rProj).toFixed(3));
console.log(`\nthe top 20% by Lineup Score beat an average generated lineup in ${O.beat} of ${O.n} contests`);
