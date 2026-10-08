// Backtest: choosing a SET of N entries for a contest (src/engine/portfolio.mjs) vs the top N by grade or by sim ROI.
// Per real contest: generate the field the way the app does (current generator settings, ownership model / showdown
// position multipliers), sim the pool against itself keeping per-draw payouts, pick N lineups per strategy, and enter
// all N into the REAL standings together (actual points recovered from the pulled lineups; each pick ranks behind real
// entries and the set's other picks that scored more; payouts split with real copies). Contests are used whatever
// their real entry cap: what matters is the field and the payout curve. N must stay small vs the field (N <= N_field/50).
//   node bench/portfolio-loop-nfl.mjs --fmt=nfl_cl|nfl_sd [--from=2025-09-01] [--to=2026-02-28] [--ns=3,20] [--pool=3000]
//        [--iters=1000] [--cands=500] [--seed=1] [--minn=1000] [--shard=i/n] --out=file
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { ownModel, SD_POS_OWN, sdPosAdjust } from "../server/sources.mjs";
import { classicFeatures, showdownFeatures, markObviousBringBack, rulesFor, gradePool } from "../src/engine/grade.mjs";
import { selectPortfolio } from "../src/engine/portfolio.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FMT = arg("fmt", "nfl_cl"), FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-02-28"), NS = arg("ns", "3,20").split(",").map(Number);
const POOL = +arg("pool", 3000), ITERS = +arg("iters", 1000), CANDS = +arg("cands", 500), SEED = +arg("seed", 1), MINN = +arg("minn", 1000), OUT = arg("out");
const [SI, SN] = arg("shard", "0/1").split("/").map(Number);
const RULEBOOK = JSON.parse(fs.readFileSync(arg("rules", "data/reports/rulebook-nfl.json"), "utf8"));
const SD = FMT === "nfl_sd";
// the app's generator settings (server/contestsim.mjs ARCH / ARCH_SD / NFL_STACKS, 2026-10-07)
const ARCH = { low: { conc: 1.0, minSal: 48800, boost: 0.6, skill: [[0.10, 40], [0.30, 4]], dupeFloor: "auto" }, marquee: { conc: 1.0, minSal: 49000, boost: 1.0, skill: [[0.15, 60], [0.35, 5]], dupeFloor: "auto" }, high: { conc: 1.15, minSal: 49200, boost: 1.5, skill: [[0.20, 80], [0.40, 6]], dupeFloor: "auto" } };
const ARCH_SD = { low: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 47500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, marquee: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, high: { conc: { FLEX: 1.15, CPT: 1.0 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 } };
const NFL_STACKS = { low: { 1: 46, 2: 40, 3: 4, bring: 60 }, marquee: { 1: 45, 2: 41, 3: 5, bring: 62 }, high: { 1: 37, 2: 48, 3: 10, bring: 67 } };
const tierOf = (fee, N) => fee >= 100 && N <= 5000 ? "high" : N > 10000 || fee < 5 ? "low" : "marquee";
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

function recoverPoints(entries, nP, mult) {
  const A = entries.filter(e => e.actFP > 0), cnt = new Float64Array(nP); for (const e of A) for (const i of e.lu) cnt[i]++;
  const idx = [], col = new Int32Array(nP).fill(-1); for (let i = 0; i < nP; i++) if (cnt[i] >= 2) { col[i] = idx.length; idx.push(i); }
  const m = idx.length; if (!m) return null;
  const XtX = Array.from({ length: m }, () => new Float64Array(m)), Xty = new Float64Array(m);
  for (const e of A) { const cs = e.lu.map(i => col[i]); if (cs.some(c => c < 0)) continue; const w = e.lu.map((_, z) => mult ? mult[z] : 1); for (let a = 0; a < cs.length; a++) { Xty[cs[a]] += w[a] * e.actFP; for (let b = 0; b < cs.length; b++) XtX[cs[a]][cs[b]] += w[a] * w[b]; } }
  for (let a = 0; a < m; a++) XtX[a][a] += 1e-3;
  const M = XtX.map((r, i) => { const row = Array.from(r); row.push(Xty[i]); return row; });
  for (let c = 0; c < m; c++) { let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = c; k <= m; k++) M[c][k] /= d; for (let r = 0; r < m; r++) if (r !== c && M[r][c]) { const f = M[r][c]; for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; } }
  const pts = new Float64Array(nP).fill(NaN); idx.forEach((i, a) => { pts[i] = M[a][m]; });
  const res = A.map(e => { const s = e.lu.reduce((t, i, z) => t + (mult ? mult[z] : 1) * pts[i], 0); return isNaN(s) ? null : Math.abs(s - e.actFP); }).filter(x => x != null);
  return { pts, meanRes: mean(res) };
}

function gradeOne(c) {
  const rc = loadPulled(c.json), pool = rc.pool, P = pool.players, f = pool.format, N = rc.entries.length, mult = f.mult;
  const ns = NS.filter(k => k * 50 <= N); if (!ns.length) return null;
  const rec = recoverPoints(rc.entries, P.length, mult); if (!rec || rec.meanRes > 0.5) return { dir: c.dir, skip: "points not recoverable" };
  const tier = tierOf(c.fee, N);
  let gp;
  if (SD) {
    const own = sdPosAdjust(P.map(p => ({ pos: p.pos, own: p.own || 0 })), SD_POS_OWN.raw.flex), cown = sdPosAdjust(P.map(p => ({ pos: p.pos, own: p.cown || 0 })), SD_POS_OWN.raw.cpt);
    gp = Object.assign({}, pool, { players: P.map((p, i) => Object.assign({}, p, { own: own[i], fown: own[i], cown: cown[i] })) });
  } else {
    const rows = P.map(p => ({ pos: p.pos, team: p.team, sal: p.sal, proj: p.proj, vown: p.own }));
    if (!(N > 10000)) ownModel("classic")(rows, { n: N, fee: c.fee });
    gp = Object.assign({}, pool, { players: P.map((p, i) => Object.assign({}, p, { own: rows[i].labOwn ?? p.own, fown: rows[i].labOwn ?? p.own })) });
  }
  const n = Math.min(POOL, N), t0 = Date.now();
  const opt = SD ? Object.assign({ rounds: 3 }, ARCH_SD[tier]) : Object.assign({ rounds: 3, nflStacks: NFL_STACKS[tier] }, ARCH[tier]);
  const field = genField(gp, n, opt, mulberry32(SEED)).field;
  const paySum = rc.payouts.reduce((s, x) => s + x, 0), first = rc.payouts[0] || paySum * 0.1, pay = fitPayouts(n, paySum * n / N, Math.max(first * n / N, paySum * n / N * 0.03), 20);
  const model = buildModel(gp, {}), res = simulate({ pool: gp, model, field, lineups: field, payouts: pay, entries: n, fee: 1, iters: ITERS, maxIters: ITERS, rng: mulberry32(16 + SEED), fieldMode: true, keep: true, calibrate: false });
  // real-contest scoring
  const realFP = rc.entries.map(e => e.actFP).sort((a, b) => b - a), sigs = {}; for (const e of rc.entries) { const s = sigOf(e.lu, f); sigs[s] = (sigs[s] || 0) + 1; }
  const score = lu => { let t = 0; for (let z = 0; z < lu.length; z++) { const v = rec.pts[lu[z]]; if (isNaN(v)) return null; t += (mult ? mult[z] : 1) * v; } return t; };
  const realAbove = pts => { let lo = 0, hi = realFP.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (realFP[mid] > pts) lo = mid + 1; else hi = mid; } return lo; };
  // unique scorable pool lineups; candidates for the set = top CANDS by sim ROI
  const seen = new Set(), cand = [];
  res.rows.forEach((r, k) => { const s = sigOf(r.lu, f); if (seen.has(s)) return; seen.add(s); const pts = score(r.lu); if (pts == null) return; cand.push({ k, lu: r.lu, roi: r.roi, pts, sig: s }); });
  if (cand.length < Math.max(...ns) * 3) return { dir: c.dir, skip: "too few scorable pool lineups" };
  const byROI = cand.slice().sort((a, b) => b.roi - a.roi), top = byROI.slice(0, Math.max(CANDS, Math.max(...ns) * 3)), byK = new Map(cand.map(x => [x.k, x]));
  // grade (sim ROI percentile + rulebook, no guide) as the app ranks
  const GP = gp.players, mk = (id, z) => ({ name: GP[id].name, pos: GP[id].pos, team: GP[id].team, opp: GP[id].opp, sal: SD && z === 0 ? (GP[id].csal || GP[id].sal * 1.5) : GP[id].sal, own: SD && z === 0 ? GP[id].cown : GP[id].own, cptOwn: GP[id].cown });
  let byGrade;
  if (SD) { const feats = cand.map(x => showdownFeatures(x.lu.map(mk), f.cap)), RL = rulesFor(RULEBOOK, { sd: true, fee: c.fee, games: 1 }); const G = gradePool(cand.map((x, i) => ({ sim: x.roi, feats: feats[i] })), RL, { weights: { sim: 0.45, rules: 0.55, guide: 0 }, fee: c.fee, sd: true }); byGrade = cand.map((x, i) => [x, G[i].grade]).sort((a, b) => b[1] - a[1]).map(z => z[0]); }
  else { const games = new Set(GP.map(p => p.team)).size / 2, feats = markObviousBringBack(cand.map(x => classicFeatures(x.lu.map(i => GP[i]), f.cap))), RL = rulesFor(RULEBOOK, { sd: false, fee: c.fee, games }); const G = gradePool(cand.map((x, i) => ({ sim: x.roi, feats: feats[i] })), RL, { weights: { sim: 0.36, rules: 0.44, guide: 0 }, fee: c.fee }); byGrade = cand.map((x, i) => [x, G[i].grade]).sort((a, b) => b[1] - a[1]).map(z => z[0]); }
  const lineups = res.rows.map(r => r.lu), maxShare = SD ? 4 : 6, topKs = top.map(x => x.k);
  // the same greedy objectives over the grade's top candidates (grade first, then a set on top of it)
  const gradeTopKs = byGrade.slice(0, Math.max(CANDS, Math.max(...ns) * 3)).map(x => x.k);
  const scoreSet = set => {
    const pts = set.map(x => x.pts), out = { roi: 0, top1: 0, top10: 0, any1: 0, best: 0 };
    let paid = 0;
    set.forEach((x, j) => {
      const own = pts.filter((p, i) => i !== j && p > x.pts).length, rank = realAbove(x.pts) + own + 1, dup = sigs[x.sig] || 0;
      let w = 0; for (let r = rank; r <= rank + dup && r <= rc.payouts.length; r++) w += rc.payouts[r - 1]; w /= 1 + dup;
      paid += w; if (rank <= Math.ceil(N * 0.01)) out.top1++; if (rank <= Math.ceil(N * 0.1)) out.top10++;
      out.best = Math.max(out.best, 1 - (rank - 1) / N);
    });
    out.roi = 100 * (paid / set.length - 1); out.any1 = out.top1 > 0 ? 1 : 0; out.top1 /= set.length; out.top10 /= set.length;
    return out;
  };
  const out = { dir: c.dir, date: c.date, fee: c.fee, N, n, tier, name: c.name, ms: 0, by: {} };
  for (const k of ns) {
    const sets = {
      "top N by sim ROI": byROI.slice(0, k),
      "top N by grade": byGrade.slice(0, k),
      "set: E[max payout]": selectPortfolio({ kept: res.kept, cands: topKs, n: k, objective: "max", lineups }).map(p => byK.get(p.k)),
      "set: P(any top 1%)": selectPortfolio({ kept: res.kept, cands: topKs, n: k, objective: "cov", lineups }).map(p => byK.get(p.k)),
      "sim ROI, overlap cap": selectPortfolio({ kept: res.kept, cands: topKs, n: k, objective: "evdiv", lineups, maxShare }).map(p => byK.get(p.k)),
      "grade top, set: E[max]": selectPortfolio({ kept: res.kept, cands: gradeTopKs.slice(0, Math.max(k * 3, 60)), n: k, objective: "max", lineups }).map(p => byK.get(p.k)),
    };
    out.by[k] = {}; for (const [name, s] of Object.entries(sets)) if (s.length === k) out.by[k][name] = scoreSet(s);
  }
  out.ms = Date.now() - t0;
  return out;
}

const all = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === FMT && c.entries >= MINN && c.date >= FROM && c.date <= TO);
const mine = all.filter((c, i) => i % SN === SI);
console.error(`${all.length} ${FMT} contests ${FROM}..${TO}, shard ${SI}/${SN} -> ${mine.length}`);
const results = [];
for (const c of mine) {
  try { const r = gradeOne(c); if (!r) continue; results.push(r); console.error(`${r.dir} ${r.skip ? "SKIP " + r.skip : `${r.tier} N ${r.N} ${r.ms}ms ` + Object.entries(r.by).map(([k, v]) => `n${k}: roi ${v["top N by sim ROI"]?.roi.toFixed(0)} / max ${v["set: E[max payout]"]?.roi.toFixed(0)}`).join(" ")}`); }
  catch (e) { console.error(c.dir, "ERR", e.message); }
}
fs.writeFileSync(OUT, JSON.stringify({ args: { FMT, FROM, TO, NS, POOL, ITERS, CANDS, SEED, shard: `${SI}/${SN}` }, results }, null, 1));
console.log(`${results.filter(r => !r.skip).length} graded -> ${OUT}`);
