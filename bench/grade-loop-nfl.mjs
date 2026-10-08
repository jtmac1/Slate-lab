// Grades the pick loop end to end, the way the app is used: generate the field for a real contest
// from the projections at lock, simulate that pool against itself, rank it by sim ROI, take the
// top K, and score those K in the REAL contest (actual points recovered from the pulled lineups,
// payout at the finish they would have had, split with any real duplicates). Baselines: top K by
// projection, K random pool lineups, K random from the sim's top decile (the user's old habit),
// K from the 50-70th sim percentile (where the sharps sit), and the real field itself.
//   node bench/grade-loop-nfl.mjs [--from=2025-09-01] [--to=2026-12-31] [--k=20] [--pool=3000] [--iters=1000]
//                                 [--rawown] [--shard=i/n] [--limit=N] [--out=data/reports/loop-nfl.json]
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { ownModel } from "../server/sources.mjs";
import { classicFeatures, markObviousBringBack, rulesFor, gradePool } from "../src/engine/grade.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-12-31"), K = +arg("k", 20), POOL = +arg("pool", 3000), ITERS = +arg("iters", 1000), RAWOWN = process.argv.includes("--rawown"), LIMIT = +arg("limit", 0), OUT = arg("out", "data/reports/loop-nfl.json");
const [SI, SN] = (arg("shard", "0/1")).split("/").map(Number);
// --gen='{"conc":1.25,"skill":[[0.15,60],[0.35,5]]}' overrides the generator settings (default: the app's classic marquee)
const GEN = JSON.parse(arg("gen", "{}"));
// lineup grade (src/engine/grade.mjs) with the rule weights from --rules (a rulebook JSON; use a window that ends before the contests graded)
const RULEBOOK = JSON.parse(fs.readFileSync(arg("rules", "data/reports/rulebook-nfl.json"), "utf8")), GRADE_W = [0.3, 0.45, 0.6, 0.75];
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, se = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : null;
const NFL_DEF = { 1: 45, 2: 41, 3: 5, bring: 62 };

// actual points per player, solved from the real lineups (afp = sum of its players' points): ridge least squares
function recoverPoints(entries, nP) {
  const A = entries.filter(e => e.actFP > 0), cnt = new Float64Array(nP); for (const e of A) for (const i of e.lu) cnt[i]++;
  const idx = [], col = new Int32Array(nP).fill(-1); for (let i = 0; i < nP; i++) if (cnt[i] >= 2) { col[i] = idx.length; idx.push(i); }
  const m = idx.length; if (!m) return null;
  const XtX = Array.from({ length: m }, () => new Float64Array(m)), Xty = new Float64Array(m);
  for (const e of A) { const cs = e.lu.map(i => col[i]); if (cs.some(c => c < 0)) continue; for (const a of cs) { Xty[a] += e.actFP; for (const b of cs) XtX[a][b] += 1; } }
  for (let a = 0; a < m; a++) XtX[a][a] += 1e-3;
  // gauss-jordan
  const M = XtX.map((r, i) => { const row = Array.from(r); row.push(Xty[i]); return row; });
  for (let c = 0; c < m; c++) { let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = c; k <= m; k++) M[c][k] /= d; for (let r = 0; r < m; r++) if (r !== c && M[r][c]) { const f = M[r][c]; for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; } }
  const pts = new Float64Array(nP).fill(NaN); idx.forEach((i, a) => { pts[i] = M[a][m]; });
  // residual check on the lineups used
  const res = A.map(e => { const s = e.lu.reduce((t, i) => t + (isNaN(pts[i]) ? NaN : pts[i]), 0); return isNaN(s) ? null : Math.abs(s - e.actFP); }).filter(x => x != null);
  return { pts, solved: m, maxRes: res.length ? Math.max(...res) : null, meanRes: mean(res) };
}

function gradeOne(c) {
  const rc = loadPulled(c.json), pool = rc.pool, P = pool.players, f = pool.format, N = rc.entries.length;
  if (N < 300) return null;
  const rec = recoverPoints(rc.entries, P.length); if (!rec || rec.meanRes > 0.5) return { dir: c.dir, skip: "points not recoverable" + (rec ? ` (mean residual ${rec.meanRes.toFixed(2)})` : "") };
  // ownership the field is built from: the player model (as the app does) or the raw projected ownership
  const rows = P.map(p => ({ pos: p.pos, team: p.team, sal: p.sal, proj: p.proj, vown: p.own })); if (!RAWOWN) ownModel("classic")(rows, { n: N, fee: c.fee });
  const gp = Object.assign({}, pool, { players: P.map((p, i) => Object.assign({}, p, { own: rows[i].labOwn ?? p.own, fown: rows[i].labOwn ?? p.own })) });
  const n = Math.min(POOL, N), t0 = Date.now();
  const field = genField(gp, n, Object.assign({ conc: 1.1, minSal: 48000, boost: 1.0, rounds: 3, nflStacks: NFL_DEF }, GEN), mulberry32(1)).field;
  // the pool against itself, paid like the real contest scaled to the pool size
  const paySum = rc.payouts.reduce((s, x) => s + x, 0), first = rc.payouts[0] || paySum * 0.1, pay = fitPayouts(n, paySum * n / N, Math.max(first * n / N, paySum * n / N * 0.03), 20);
  const model = buildModel(gp, {}), res = simulate({ pool: gp, model, field, lineups: field, payouts: pay, entries: n, fee: 1, iters: ITERS, maxIters: ITERS * 2, rng: mulberry32(17), fieldMode: true });
  // real-contest scoring
  const realFP = rc.entries.map(e => e.actFP).sort((a, b) => b - a), sigs = {}; for (const e of rc.entries) { const s = sigOf(e.lu, f); sigs[s] = (sigs[s] || 0) + 1; }
  const score = lu => { let t = 0; for (const i of lu) { if (isNaN(rec.pts[i])) return null; t += rec.pts[i]; } return t; };
  const rankOf = pts => { let lo = 0, hi = realFP.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (realFP[mid] > pts) lo = mid + 1; else hi = mid; } return lo + 1; };
  // construction of each pool lineup, on the model's ownership: QB stack size, bring-back, chalk count (20%+), salary left
  const GP = gp.players, shape = lu => { const qb = lu.map(i => GP[i]).find(p => p.pos === "QB"); const stackN = qb ? lu.filter(i => GP[i] !== qb && GP[i].team === qb.team && /^(WR|TE|RB)$/.test(GP[i].pos)).length : 0, bring = !!qb && lu.some(i => GP[i].team === qb.opp && GP[i].pos !== "DST"); return { stackN, bring, chalk: lu.filter(i => GP[i].own >= 20).length, left: f.cap - lu.reduce((s, i) => s + GP[i].sal, 0) }; };
  const cand = res.rows.map(r => { const pts = score(r.lu); if (pts == null) return null; const rank = rankOf(pts), dup = sigs[sigOf(r.lu, f)] || 0, payout = rc.payouts[rank - 1] || 0; return Object.assign({ lu: r.lu, roi: r.roi, proj: r.proj, pts, rank, pct: 1 - (rank - 1) / N, top10: rank <= Math.ceil(N * 0.1), top1: rank <= Math.ceil(N * 0.01), actROI: 100 * (payout / (1 + dup) - 1), actROIraw: 100 * (payout - 1), dup, dupN: r.dupN, own: r.own }, shape(r.lu)); }).filter(Boolean);
  if (cand.length < K * 3) return { dir: c.dir, skip: "too few scorable pool lineups" };
  const byROI = cand.slice().sort((a, b) => b.roi - a.roi), byProj = cand.slice().sort((a, b) => b.proj - a.proj), rng = mulberry32(99);
  const pick = (arr, k) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  const rules = x => x.stackN >= 2 && x.bring && x.chalk >= 4 && x.left < 600, rulesLite = x => x.stackN >= 1 && x.chalk >= 3 && x.left < 600;
  // the grade: sim ROI percentile + rulebook percentile (no slate guide exists for past contests), at several sim weights
  const games = new Set(GP.map(p => p.team)).size / 2, feats = markObviousBringBack(cand.map(x => classicFeatures(x.lu.map(i => GP[i]), f.cap)));
  const RL = rulesFor(RULEBOOK, { sd: false, fee: c.fee, games }), byGrade = {};
  for (const ws of GRADE_W) { const g = gradePool(cand.map((x, i) => ({ sim: x.roi, feats: feats[i] })), RL, { weights: { sim: ws, rules: 1 - ws, guide: 0 }, fee: c.fee }); byGrade[ws] = cand.map((x, i) => [x, g[i].grade]).sort((a, b) => b[1] - a[1]).map(z => z[0]); }
  const strategies = {
    ...Object.fromEntries(GRADE_W.map(ws => [`grade (sim ${ws} / rules ${+(1 - ws).toFixed(2)})`, byGrade[ws].slice(0, K)])),
    "rules + grade (sim 0.45)": byGrade[0.45].filter(rules).slice(0, K),
    "top K by sim ROI": byROI.slice(0, K),
    "sim ROI, no expected copies": byROI.filter(x => x.dupN <= 1).slice(0, K),
    "top K by projection": byProj.slice(0, K),
    "projection, no expected copies": byProj.filter(x => x.dupN <= 1).slice(0, K),
    "rules (QB+2, bring, 4 chalk) + proj": byProj.filter(rules).slice(0, K),
    "rules + sim ROI": byROI.filter(rules).slice(0, K),
    "rules lite (QB+1, 3 chalk) + proj": byProj.filter(rulesLite).slice(0, K),
    "random from sim top decile": pick(byROI.slice(0, Math.ceil(byROI.length * 0.1)), K),
    "sim 50-70th percentile": pick(byROI.slice(Math.floor(byROI.length * 0.3), Math.floor(byROI.length * 0.5)), K),
    "random pool lineup": pick(cand, K),
  };
  for (const k of Object.keys(strategies)) if (!strategies[k].length) delete strategies[k];
  const agg = s => ({ actROI: mean(s.map(x => x.actROI)), actROIraw: mean(s.map(x => x.actROIraw)), pct: mean(s.map(x => x.pct)), top10: mean(s.map(x => +x.top10)), top1: mean(s.map(x => +x.top1)), dup: mean(s.map(x => x.dup)), own: mean(s.map(x => x.own)) });
  const out = { dir: c.dir, date: c.date, fee: c.fee, N, n, tier: c.tier, size: c.size, solved: rec.solved, meanRes: +rec.meanRes.toFixed(3), ms: Date.now() - t0, field: { actROI: mean(rc.entries.map(e => e.actROI)), top10: 0.1 }, by: {} };
  for (const [k, s] of Object.entries(strategies)) out.by[k] = agg(s);
  // does sim ROI rank the pool's real results at all? spearman between sim ROI and actual pct over the pool
  const rk = a => { const o = a.map((v, i) => i).sort((x, y) => a[y] - a[x]), r = new Array(a.length); o.forEach((i, p) => { r[i] = p; }); return r; };
  const r1 = rk(cand.map(x => x.roi)), r2 = rk(cand.map(x => x.pts)), m1 = mean(r1), m2 = mean(r2); let num = 0, d1 = 0, d2 = 0; for (let i = 0; i < r1.length; i++) { num += (r1[i] - m1) * (r2[i] - m2); d1 += (r1[i] - m1) ** 2; d2 += (r2[i] - m2) ** 2; }
  out.spearman = +(num / Math.sqrt(d1 * d2)).toFixed(3);
  return out;
}

const all = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.fee >= 20 && c.entries >= 300 && c.date >= FROM && c.date <= TO);
const mine = all.filter((c, i) => i % SN === SI).slice(0, LIMIT || undefined);
console.error(`${all.length} classic contests, shard ${SI}/${SN} -> ${mine.length}`);
const results = [];
for (const c of mine) { try { const r = gradeOne(c); if (r) { results.push(r); console.error(`${r.dir} ${r.skip ? "SKIP " + r.skip : `N ${r.N} pool ${r.n} spearman ${r.spearman} | sim top${K} ROI ${r.by["top K by sim ROI"].actROI.toFixed(0)}% top10 ${(100 * r.by["top K by sim ROI"].top10).toFixed(0)}% | proj ${r.by["top K by projection"].actROI.toFixed(0)}% | random ${r.by["random pool lineup"].actROI.toFixed(0)}% | field ${r.field.actROI.toFixed(0)}% | ${(r.ms / 1000).toFixed(1)}s`}`); } } catch (e) { console.error(`${c.dir} ERROR ${e.message}`); } }
const ok = results.filter(r => !r.skip);
const summary = {};
if (ok.length) for (const k of [...new Set(ok.flatMap(r => Object.keys(r.by)))]) { const rows = ok.filter(r => r.by[k]), g = key => rows.map(r => r.by[k][key]); summary[k] = { n: ok.length, actROI: +mean(g("actROI")).toFixed(1), se: +se(g("actROI")).toFixed(1), actROIraw: +mean(g("actROIraw")).toFixed(1), pct: +mean(g("pct")).toFixed(3), top10: +mean(g("top10")).toFixed(3), top1: +mean(g("top1")).toFixed(4), dup: +mean(g("dup")).toFixed(2), own: +mean(g("own")).toFixed(0) }; }
summary.field = { actROI: ok.length ? +mean(ok.map(r => r.field.actROI)).toFixed(1) : null, top10: 0.1, top1: 0.01 };
summary.spearman = ok.length ? +mean(ok.map(r => r.spearman)).toFixed(3) : null;
const out = { built: new Date().toISOString(), args: { FROM, TO, K, POOL, ITERS, RAWOWN, GEN, shard: `${SI}/${SN}` }, contests: ok.length, skipped: results.filter(r => r.skip).length, summary, results };
const file = SN > 1 ? OUT.replace(/\.json$/, `-${SI}.json`) : OUT; fs.mkdirSync("data/reports", { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\n${ok.length} contests graded (${results.length - ok.length} skipped) -> ${file}`);
for (const [k, v] of Object.entries(summary)) if (v && v.n) console.log(`${k.padEnd(30)} ROI ${String(v.actROI).padStart(6)}% ±${v.se}  (unsplit ${v.actROIraw}%)  pct ${v.pct}  top10 ${(100 * v.top10).toFixed(1)}%  top1 ${(100 * v.top1).toFixed(2)}%  real dupes ${v.dup}  own ${v.own}`);
console.log(`${"real field".padEnd(30)} ROI ${String(summary.field.actROI).padStart(6)}%        top10 10%  top1 1%   | sim ROI vs actual points over the pool: spearman ${summary.spearman}`);
