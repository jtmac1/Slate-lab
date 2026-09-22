// "Does this give us the best chance to win big?" - the one question neither existing bench answers.
//
// grade-all ranks REAL entries against each other. pick-from-field uses the right candidate set (the
// generated field, which is the actual workflow) but judges it on MEAN return, and tournament returns
// are so heavy-tailed that the mean flips sign between samples. oos-split uses the right objective
// (tier hit rate) but the wrong candidate set (buildLineups, the button that is not used).
//
// This one puts them together: candidates come OUT of the generated field, and the objective is how
// often the pick lands in the top 1/5/10/20% of the REAL contest field. Winning big is a tail event,
// so the measure has to be "how often do we reach the tail", not "what did we average".
//
// The control is a RANDOM lineup from the same generated field - not chance, because the generator
// already encodes projection and salary sense, and we want to isolate what Lineup Score adds on top.
//
// Scoring fix that matters: a player whose team played a final game but who has no log row did not
// record a stat, so he scores 0, which is correct. Only a player whose GAME is missing makes a
// contest unusable. The old blanket "15% of players missing" guard threw away 249 of 317 classic
// contests, almost all of it DST, which never existed in the logs at all.
//
//   node bench/win-big.mjs nfl_cl [--n=300] [--iters=2000] [--gate=50] [--split]
//     [--nflsig=QB:0.75,...] [--sigtilt=QB:-0.66,...] [--sigref=11.5] [--ctable=<file>]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { fieldProfile, genField } from "../src/engine/field.mjs";
import { buildModel, CSAME, COPP, MLBC, SIGMA_DEF } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { featurize } from "../src/engine/select.mjs";

const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "nfl_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ""; };
const LIM = flag("n") || 300, ITERS = flag("iters") || 2000, GATE = (flag("gate") ?? 50) / 100;
const SPLIT = process.argv.includes("--split");
const CONC = flag("conc") ?? 1.0, MINSAL = flag("minsal") ?? 49000;
const SEED = flag("seed") ?? 0;   // shifts both the field-generation and simulation streams, for a noise floor
const SPORT = FKEY.startsWith("cfb") ? "cfb" : "nfl";

const kvNum = s => Object.fromEntries(s.split(",").filter(Boolean).map(kv => { const [k, v] = kv.split(":"); return [k, +v]; }));
const SIGRAW = arg("nflsig"), TILTRAW = arg("sigtilt"), CTFILE = arg("ctable");
const MODEL_OPTS = {};
if (SIGRAW) MODEL_OPTS.sigmaDef = Object.assign({}, SIGMA_DEF[FKEY] || SIGMA_DEF[SPORT], kvNum(SIGRAW));
if (TILTRAW) MODEL_OPTS.sigmaTilt = TILTRAW.includes(":") ? kvNum(TILTRAW) : +TILTRAW;
if (flag("sigref") != null) MODEL_OPTS.sigmaTiltRef = flag("sigref");
if (CTFILE) { const t = JSON.parse(fs.readFileSync(CTFILE, "utf8"));
  MODEL_OPTS.tables = { CSAME: Object.assign({}, CSAME, t.CSAME || {}), COPP: Object.assign({}, COPP, t.COPP || {}), MLBC }; }

// actuals, plus the set of teams that actually finished a game on each date
const logDir = path.join("data/logs", SPORT), actByDate = {}, teamsByDate = {};
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(x => x.endsWith(".json")) : [])) {
  const date = f.replace(/\.json$/, ""), d = actByDate[date] = {}, t = teamsByDate[date] = new Set();
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const tm of g.teams || []) t.add(String(tm).toUpperCase());
    for (const p of g.players) { const k = nrm(p.name); if (!(k in d) || d[k] < p.pts) d[k] = p.pts; }
  }
}

const scoreOf = f => f.rProj >= 1 - GATE ? f.roi : -1e9 + f.rProj;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const TIERS = [0.01, 0.05, 0.10, 0.20];

const rows = [];
let idx = 0, skipGame = 0, skipSmall = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY).sort((a, b) => a.date.localeCompare(b.date))) {
  if (rows.length >= LIM) break;
  const A = actByDate[c.date], T = teamsByDate[c.date]; if (!A || !T) continue;
  const { pool, entries, payouts, paid } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 100 || !paid) { skipSmall++; continue; }
  const P = pool.players, N = entries.length;
  // a player is scoreable if his team finished a game; absent from the log then means zero, not unknown
  const unplayed = P.filter(p => !T.has(String(p.team).toUpperCase())).length;
  if (unplayed / P.length > 0.05) { skipGame++; continue; }

  const opt = Object.assign({ conc: CONC, minSal: MINSAL, boost: 1.0, rounds: 3 }, fieldProfile(c.fee, FKEY, N));
  const gen = genField(pool, N, opt, mulberry32(11 + idx + 1000 * SEED)).field;
  if (gen.length < 100) continue;
  const sc = lu => lu.reduce((s, id) => s + (A[P[id].key] || 0), 0);
  const act = gen.map(sc);

  const res = simulate({ pool, model: buildModel(pool, MODEL_OPTS), field: gen, lineups: gen, payouts,
    entries: N, fee: 1, iters: ITERS, rng: mulberry32(5 + idx + 1000 * SEED), fieldMode: true });
  const projOf = lu => lu.reduce((t, id) => t + (P[id].proj || 0), 0);
  const ownOf = lu => lu.reduce((t, id) => t + (P[id].own || 0), 0);
  const feats = featurize(res.rows.map((r, i) => ({ proj: projOf(gen[i]), roi: r.roi, cash: r.cash,
    t10: r.t10, avgRank: r.avgRank, own: ownOf(gen[i]) })));
  const rank = feats.map((f, i) => ({ i, s: scoreOf(f) })).sort((a, b) => b.s - a.s);

  // percentile inside the REAL field: 0 is first place
  const fieldScores = scored.map(e => e.actFP).sort((x, y) => y - x);
  const pct = s => { let r = 0; while (r < fieldScores.length && fieldScores[r] > s) r++; return r / fieldScores.length; };
  const k20 = Math.max(1, Math.round(rank.length * 0.2));
  // Control that matters most: the highest-PROJECTION generated lineup. If that matches Lineup
  // Score, the simulation is adding nothing over the projections it is fed, and the whole engine is
  // decoration. pick-from-field hinted at exactly this - projected points ranked generated lineups
  // better (0.113) than Lineup Score did (0.098).
  let bestProj = 0; for (let i = 1; i < gen.length; i++) if (projOf(gen[i]) > projOf(gen[bestProj])) bestProj = i;
  // Stokastic's own per-player simulated ROI rides along in every pulled contest and has never been
  // used to SELECT anything - only to grade real entries. Their sim beats ours head to head on these
  // contests (rank correlation 0.173 vs 0.117, paired by date t=-5.4), so the cheapest possible win
  // is to let their number pick a lineup out of OUR generated field and see if it does better.
  const stkOf = lu => lu.reduce((t, id) => t + (P[id].stkROI || 0), 0);
  const gateOK = new Set(rank.filter(x => feats[x.i].rProj >= 1 - GATE).map(x => x.i));
  let bestStk = 0, bestStkG = -1;
  for (let i = 1; i < gen.length; i++) if (stkOf(gen[i]) > stkOf(gen[bestStk])) bestStk = i;
  for (let i = 0; i < gen.length; i++) if (gateOK.has(i) && (bestStkG < 0 || stkOf(gen[i]) > stkOf(gen[bestStkG]))) bestStkG = i;
  if (bestStkG < 0) bestStkG = bestStk;
  rows.push({ date: c.date, fee: c.fee, N,
    top1: pct(act[rank[0].i]),
    proj1: pct(act[bestProj]),
    stk1: pct(act[bestStk]),
    stkg1: pct(act[bestStkG]),
    top3: rank.slice(0, 3).map(x => pct(act[x.i])),
    top20: rank.slice(0, k20).map(x => pct(act[x.i])),
    all: act.map(pct) });
  idx++;
}

console.log(`${rows.length} contests (${skipGame} skipped for unplayed games, ${skipSmall} too small), ${ITERS} draws, gate ${(100 * GATE).toFixed(0)}%`);
if (Object.keys(MODEL_OPTS).length) console.log(`model: ${SIGRAW ? "fitted sigma " : ""}${TILTRAW ? "+tilt " : ""}${CTFILE ? "+fitted correlations" : ""}`);
else console.log("model: shipped engine");
if (!rows.length) { console.log("nothing to report"); process.exit(0); }

// hit rate = share of contests where the pick reached the tier. The control is a random generated
// lineup, measured as the average share of generated lineups that reached it.
const report = (label, set) => {
  console.log(`\n${label}  (${set.length} contests)`);
  // every column is a PER-LINEUP rate so it is comparable to the random-generated control. A
  // "best of 3" number would be a max over three draws and would beat a per-lineup base rate even
  // with no skill at all, so best-of-k is reported separately against its own matched control.
  console.log("  tier".padEnd(10) + "top-1 pick".padEnd(14) + "top 3 avg".padEnd(13)
    + "top 20%".padEnd(12) + "max proj".padEnd(12) + "stk sum".padEnd(11) + "stk gated".padEnd(12) + "random gen".padEnd(13) + "lift".padEnd(8) + "z");
  for (const q of TIERS) {
    const h1 = set.filter(r => r.top1 <= q).length / set.length;
    const h3 = mean(set.map(r => r.top3.filter(v => v <= q).length / r.top3.length));
    const h20 = mean(set.map(r => r.top20.filter(v => v <= q).length / r.top20.length));
    const base = mean(set.map(r => r.all.filter(v => v <= q).length / r.all.length));
    const n = set.length, hits = set.filter(r => r.top1 <= q).length;
    const z = base > 0 ? (hits - n * base) / Math.sqrt(Math.max(1e-9, n * base * (1 - base))) : 0;
    const hp = set.filter(r => r.proj1 <= q).length / set.length;
    const hs = set.filter(r => r.stk1 <= q).length / set.length;
    const hsg = set.filter(r => r.stkg1 <= q).length / set.length;
    console.log("  " + `top ${(100 * q).toFixed(0)}%`.padEnd(8)
      + `${(100 * h1).toFixed(1)}%`.padEnd(14) + `${(100 * h3).toFixed(1)}%`.padEnd(13)
      + `${(100 * h20).toFixed(1)}%`.padEnd(12) + `${(100 * hp).toFixed(1)}%`.padEnd(12) + `${(100 * hs).toFixed(1)}%`.padEnd(11) + `${(100 * hsg).toFixed(1)}%`.padEnd(12)
      + `${(100 * base).toFixed(1)}%`.padEnd(13)
      + (base > 0 ? (h1 / base).toFixed(2) + "x" : "-").padEnd(8) + z.toFixed(1));
  }
  // THE test of whether the simulation earns its keep. Lineup Score against simply taking the
  // highest-projection lineup out of the same generated field, paired per contest and clustered by
  // date. If this is a coin flip, sigma, correlations and the Monte Carlo are decoration on top of
  // the projections, and the honest description of the engine is an optimiser with extra steps.
  {
    const ds = [...new Set(set.map(r => r.date))];
    console.log("  -- Lineup Score vs the highest-PROJECTION generated lineup (paired, by date) --");
    for (const q of TIERS) {
      const per = ds.map(d => { const g = set.filter(r => r.date === d);
        return g.filter(r => r.top1 <= q).length / g.length - g.filter(r => r.proj1 <= q).length / g.length; });
      const mu = mean(per), s = per.length > 1 ? Math.sqrt(per.reduce((a, x) => a + (x - mu) ** 2, 0) / (per.length - 1)) : NaN;
      const t = mu / (s / Math.sqrt(per.length));
      console.log("  " + `top ${(100 * q).toFixed(0)}%`.padEnd(8) + `sim minus proj ${(100 * mu).toFixed(1)} pts`.padEnd(26)
        + `t ${t.toFixed(2)}`.padEnd(10) + (Math.abs(t) < 2 ? "coin flip - sim adds nothing" : mu > 0 ? "sim genuinely better" : "PROJECTION BEATS THE SIM"));
    }
  }
  // Contests on the same date share one slate and one set of player outcomes, so they are NOT
  // independent trials. Treating 239 contests as 239 draws inflates z by roughly sqrt(per-date
  // count). Aggregate to the date, then test the per-date excess over that date's own base rate.
  const dates = [...new Set(set.map(r => r.date))];
  console.log(`  -- clustered by slate date (${dates.length} dates, not ${set.length} contests) --`);
  for (const q of TIERS) {
    const per = dates.map(d => { const g = set.filter(r => r.date === d);
      return g.filter(r => r.top1 <= q).length / g.length - mean(g.map(r => r.all.filter(v => v <= q).length / r.all.length)); });
    const mu = mean(per), s = per.length > 1 ? Math.sqrt(per.reduce((a, x) => a + (x - mu) ** 2, 0) / (per.length - 1)) : NaN;
    const se = s / Math.sqrt(per.length), t = mu / se;
    console.log("  " + `top ${(100 * q).toFixed(0)}%`.padEnd(8) + `excess ${(100 * mu).toFixed(1)} pts`.padEnd(18)
      + `se ${(100 * se).toFixed(1)}`.padEnd(10) + `t ${t.toFixed(2)}`.padEnd(10)
      + (Math.abs(t) >= 2 ? "holds" : "NOT significant once clustered"));
  }
  // Multi-entry is how tournaments are actually won, so ask the matched question: entering the top
  // K by Lineup Score, how often does AT LEAST ONE reach the tier, against K random generated ones?
  console.log("  -- best of K entries, each against a matched best-of-K random control --");
  for (const K of [3, 20]) {
    const line = [];
    for (const q of TIERS) {
      const picks = set.map(r => (K === 3 ? r.top3 : r.top20).slice(0, K));
      const hit = mean(picks.map(p => p.some(v => v <= q) ? 1 : 0));
      // P(at least one of K random generated reaches the tier), from that contest's own base rate
      const ctl = mean(set.map(r => { const b = r.all.filter(v => v <= q).length / r.all.length;
        return 1 - Math.pow(1 - b, Math.min(K, r.all.length)); }));
      line.push(`top ${(100 * q).toFixed(0)}%: ${(100 * hit).toFixed(0)}% vs ${(100 * ctl).toFixed(0)}%`);
    }
    console.log(`  K=${String(K).padEnd(3)} ` + line.join("   "));
  }
};
report("ALL CONTESTS", rows);

// Does the edge survive where it will actually be used? The archive is mostly $100-499 in fields
// under 10k, while the entry history is overwhelmingly sub-$25 in fields above 10k. We cannot test
// the real population without re-pulling the big contests with lineups, but we can at least ask
// whether the lift is flat across the fee and size range we DO hold, or trends with them.
const STRATA = [
  ["fee under $25", r => r.fee > 0 && r.fee < 25],
  ["fee $25-99", r => r.fee >= 25 && r.fee < 100],
  ["fee $100+", r => r.fee >= 100],
  ["field under 1k", r => r.N < 1000],
  ["field 1k-10k", r => r.N >= 1000 && r.N < 10000],
  ["field 10k+", r => r.N >= 10000]
];
console.log("\n=== does the lift hold across the range we hold? (top 10% tier) ===");
console.log("  stratum".padEnd(20) + "n".padEnd(7) + "top-1 pick".padEnd(13) + "random gen".padEnd(13) + "lift".padEnd(8) + "z");
for (const [label, fn] of STRATA) {
  const s = rows.filter(fn); if (s.length < 10) { console.log("  " + label.padEnd(18) + `${s.length} (too few)`); continue; }
  const q = 0.10, hits = s.filter(r => r.top1 <= q).length, h = hits / s.length;
  const base = mean(s.map(r => r.all.filter(v => v <= q).length / r.all.length));
  const z = base > 0 ? (hits - s.length * base) / Math.sqrt(Math.max(1e-9, s.length * base * (1 - base))) : 0;
  console.log("  " + label.padEnd(18) + String(s.length).padEnd(7) + `${(100 * h).toFixed(1)}%`.padEnd(13)
    + `${(100 * base).toFixed(1)}%`.padEnd(13) + (base > 0 ? (h / base).toFixed(2) + "x" : "-").padEnd(8) + z.toFixed(1));
}

if (SPLIT) {
  const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const cut = Math.floor(sorted.length / 2);
  report(`EARLY HALF (${sorted[0].date} .. ${sorted[cut - 1].date})`, sorted.slice(0, cut));
  report(`HELD OUT   (${sorted[cut].date} .. ${sorted[sorted.length - 1].date})`, sorted.slice(cut));
}
console.log();
