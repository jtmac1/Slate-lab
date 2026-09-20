// The experiment everything else has been missing: choose on one half of the archive, test once on
// the other. Nothing today was out of sample, and many configurations were tried, which is exactly
// how a five-contest tail becomes a finding.
//
// Objective is the tier hit rate, not ROI and not rank correlation. Reaching the paying tiers more
// often than a comparable lineup IS the edge in a tournament; dollar means are too heavy-tailed to
// steer by. The control throughout is the SAME built lineups picked at random, never bare chance,
// since an optimizer beats chance on projection signal alone.
//
//   node bench/oos-split.mjs [cfb_cl] [--build=20] [--rand=3] [--iters=1500]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { buildLineups } from "../src/engine/build.mjs";
import { fieldProfile, genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { featurize } from "../src/engine/select.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const K = flag("build") || 20, RAND = flag("rand") ?? 3, ITERS = flag("iters") || 1500;
const SPORT = FKEY.startsWith("cfb") ? "cfb" : "nfl";

// the candidate rules, scored on features of the simulated candidates
const CANDIDATES = {
  "sim ROI, gated to top half projection": f => f.rProj >= 0.5 ? f.roi : -1e9 + f.rProj,
  "sim ROI, gated to top third":           f => f.rProj >= 0.667 ? f.roi : -1e9 + f.rProj,
  "sim ROI, ungated":                      f => f.roi,
  "chance of a top 10% finish":            f => f.t10,
  "chance of a top 10%, gated":            f => f.rProj >= 0.5 ? f.t10 : -1e9 + f.rProj,
  "projected points":                      f => f.proj,
  "half top-10% chance, half ROI":         f => 0.5 * f.rT10 + 0.5 * f.rROI
};

const logDir = path.join("data/logs", SPORT), actByDate = {};
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(x => x.endsWith(".json")) : [])) {
  const d = actByDate[f.replace(/\.json$/, "")] = {};
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) { const k = nrm(p.name); if (!(k in d) || d[k] < p.pts) d[k] = p.pts; }
  }
}

// one pass over the archive: for every usable contest, the finish percentile of every built lineup
// and of the pick each rule would have made
const rows = [];
let idx = 0;
for (const c of listContests().filter(x => x.json && x.fkey === FKEY).sort((a, b) => a.date.localeCompare(b.date))) {
  const A = actByDate[c.date]; if (!A) continue;
  const { pool, entries, payouts, paid } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 100 || !paid) continue;
  const P = pool.players, N = entries.length;
  const b = buildLineups(pool, { n: K, obj: "blend", rand: RAND / 100, maxExp: 60, minSal: 0, minUniq: 1, stackSize: 0, force: [], exclude: [] }, mulberry32(1000 + idx));
  if (b.err || !b.lineups || b.lineups.length < 5) continue;
  let miss = 0, tot = 0;
  const score = lu => { let s = 0; for (const id of lu) { const v = A[P[id].key]; tot++; if (v == null) miss++; else s += v; } return s; };
  const act = b.lineups.map(score);
  if (miss / Math.max(1, tot) > 0.15) continue;
  const genOpt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 }, fieldProfile(c.fee, FKEY, N));
  const gen = genField(pool, N, genOpt, mulberry32(11 + idx)).field;
  if (gen.length < 50) continue;
  const res = simulate({ pool, model: buildModel(pool, {}), field: gen, lineups: b.lineups, payouts, entries: N, fee: 1, iters: ITERS, rng: mulberry32(5 + idx), fieldMode: false });
  const pj = lu => lu.reduce((t, id) => t + (P[id].proj || 0), 0), ow = lu => lu.reduce((t, id) => t + (P[id].own || 0), 0);
  const feats = featurize(res.rows.map((r, i) => ({ proj: pj(b.lineups[i]), roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: ow(b.lineups[i]) })));
  const fieldScores = scored.map(e => e.actFP).sort((x, y) => y - x);
  const pctOf = s => { let r = 0; while (r < fieldScores.length && fieldScores[r] > s) r++; return r / fieldScores.length; };
  const all = act.map(pctOf);
  const picks = {};
  for (const [name, fn] of Object.entries(CANDIDATES)) {
    let best = 0, bv = -Infinity;
    feats.forEach((f, i) => { const s = fn(f); if (s > bv) { bv = s; best = i; } });
    picks[name] = all[best];
  }
  rows.push({ date: c.date, all, picks });
  idx++;
}
rows.sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(rows.length / 2), early = rows.slice(0, cut), late = rows.slice(cut);
console.log(`${rows.length} usable contests: ${early.length} to choose on (${early[0].date} to ${early[early.length - 1].date}), ${late.length} held out (${late[0].date} to ${late[late.length - 1].date})\n`);

// hit rate of a rule against the base rate of the same built lineups
const TIER = 0.10;
const rate = (set, name) => set.filter(r => r.picks[name] <= TIER).length / set.length;
const base = set => { let h = 0, n = 0; for (const r of set) for (const v of r.all) { n++; if (v <= TIER) h++; } return h / n; };
const zOf = (set, name) => { const n = set.length, p = base(set), h = set.filter(r => r.picks[name] <= TIER).length;
  return (h - n * p) / Math.sqrt(Math.max(1e-9, n * p * (1 - p))); };

console.log("choosing on the early half, by how often the pick reaches the top 10%");
console.log("  rule".padEnd(42) + "hit rate".padEnd(12) + "base".padEnd(10) + "ratio".padEnd(9) + "z");
const ranked = Object.keys(CANDIDATES).map(n => ({ n, r: rate(early, n), z: zOf(early, n) })).sort((a, b) => b.r - a.r);
for (const x of ranked) console.log("  " + x.n.padEnd(42) + (100 * x.r).toFixed(1).padEnd(12) + (100 * base(early)).toFixed(1).padEnd(10) + (x.r / base(early)).toFixed(2).padEnd(9) + x.z.toFixed(1));

const chosen = ranked[0].n;
console.log(`\nchosen: ${chosen}\n`);
console.log("held-out half, this rule only, no further choices");
console.log("  tier".padEnd(12) + "hit rate".padEnd(12) + "base".padEnd(10) + "ratio".padEnd(9) + "z");
for (const q of [0.01, 0.05, 0.10, 0.20]) {
  const n = late.length, h = late.filter(r => r.picks[chosen] <= q).length;
  let bh = 0, bn = 0; for (const r of late) for (const v of r.all) { bn++; if (v <= q) bh++; }
  const p = bh / bn, z = (h - n * p) / Math.sqrt(Math.max(1e-9, n * p * (1 - p)));
  console.log("  " + ("top " + (100 * q).toFixed(0) + "%").padEnd(12) + (100 * h / n).toFixed(1).padEnd(12) + (100 * p).toFixed(1).padEnd(10) + (p > 0 ? (h / n / p).toFixed(2) : "-").padEnd(9) + z.toFixed(1));
}
