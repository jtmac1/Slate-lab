// Does the lineup builder earn anything? It makes greedy value lineups with randomness, exposure
// caps and uniqueness, which is a different job from the contest generator that models opponents.
// This scores its output the only way that settles it: build lineups on a real slate, score them
// with what the players actually did, rank them inside the REAL field of that contest, and pay them
// from that contest's real payout curve.
// Benchmarks are the field itself (its average return is the rake) and the real entries' own spread.
//   node bench/builder-value.mjs [cfb_cl] [--n=40] [--build=20] [--obj=blend] [--rand=18]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { buildLineups } from "../src/engine/build.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const str = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const LIM = flag("n") || 40, K = flag("build") || 20, OBJ = str("obj") || "blend", RAND = flag("rand") ?? 18;
const SPORT = FKEY.startsWith("cfb") ? "cfb" : "nfl";

const logDir = path.join("data/logs", SPORT);
const actByDate = {};
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [])) {
  const d = actByDate[f.replace(/\.json$/, "")] = {};
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) { const k = nrm(p.name); if (!(k in d) || d[k] < p.pts) d[k] = p.pts; }
  }
}
const rng = (s => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(7);
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const rows = { built: [], field: [], bestOf: [], cash: [], fieldCash: [] };
let used = 0, skipped = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (used >= LIM) break;
  const A = actByDate[c.date]; if (!A) { skipped++; continue; }
  const { pool, entries, payouts, paid } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 100 || !paid) { skipped++; continue; }
  const P = pool.players;
  const r = buildLineups(pool, { n: K, obj: OBJ, rand: RAND / 100, maxExp: 60, minSal: 0, minUniq: 1, stackSize: 0, force: [], exclude: [] }, rng);
  if (r.err || !r.lineups || r.lineups.length < 5) { skipped++; continue; }
  // score a lineup from what actually happened; skip the contest if the join is poor
  let miss = 0, tot = 0;
  const score = lu => { let s = 0; for (const id of lu) { const v = A[P[id].key]; tot++; if (v == null) miss++; else s += v; } return s; };
  const mine = r.lineups.map(score);
  if (miss / Math.max(1, tot) > 0.15) { skipped++; continue; }
  // rank each built lineup inside the real field and pay it from the real curve
  const fieldScores = scored.map(e => e.actFP).sort((a, b) => b - a);
  const roiOf = s => { let rank = 0; while (rank < fieldScores.length && fieldScores[rank] > s) rank++;
    const pay = payouts[Math.min(payouts.length - 1, rank)] || 0; return 100 * (pay - 1); };
  const roi = mine.map(roiOf);
  rows.built.push(mean(roi));
  rows.bestOf.push(roiOf(Math.max(...mine)));
  rows.cash.push(100 * roi.filter(x => x > -100).length / roi.length);
  rows.field.push(mean(scored.map(e => e.actROI)));
  rows.fieldCash.push(100 * scored.filter(e => e.actROI > -100).length / scored.length);
  used++;
}
console.log(`${used} contests (${skipped} skipped for missing results or a thin join), ${K} lineups built each, objective ${OBJ}, randomness ${RAND}%\n`);
console.log("measure".padEnd(38) + "built".padEnd(14) + "the real field");
console.log("average return per lineup".padEnd(38) + (mean(rows.built).toFixed(1) + "%").padEnd(14) + mean(rows.field).toFixed(1) + "%");
console.log("share of lineups that cashed".padEnd(38) + (mean(rows.cash).toFixed(1) + "%").padEnd(14) + mean(rows.fieldCash).toFixed(1) + "%");
console.log("best of the " + String(K).padEnd(3) + " built, per contest".padEnd(24) + (mean(rows.bestOf).toFixed(1) + "%"));
const beat = rows.built.filter((v, i) => v > rows.field[i]).length;
console.log(`\nbuilt beat the field average in ${beat} of ${used} contests`);
