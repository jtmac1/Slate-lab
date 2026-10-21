// Does the optimizer pick better lineups than the current loop, on REAL results? (2026-10-15) Per classic contest in the
// archive: the lock-time pool (projections, ownership through the player model, as grade-loop-nfl.mjs does), the generated
// field, the optimizer's 150 candidates (QB tilt from data/reports/qb-matchups-nfl.json history for that week, built from
// earlier weeks only), each simmed alone against the field; then K lineups per strategy scored in the real contest (actual
// points recovered from the pulled lineups, payout at the finish, split with real duplicates).
// Strategies: the current loop (generated pool, sharp rules + sim ROI); optimizer as built (random K); optimizer top K by sim
// ROI; optimizer top K by projection; optimizer without the QB tilt (random K).
//   node bench/opt-loop-nfl.mjs [--vendor] [--k=20] [--pool=3000] [--iters=1000] [--shard=i/n] [--limit=N] [--from=2025-09-01]
import fs from "node:fs";
import { listContests, loadPulled, matchToProjections } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { ownModel } from "../server/sources.mjs";
import { optimizeLineups } from "../src/engine/optimizer.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const K = +arg("k", 20), POOL = +arg("pool", 3000), ITERS = +arg("iters", 1000), LIMIT = +arg("limit", 0), FROM = arg("from", "2025-09-01"), OUT = arg("out", "data/reports/opt-loop-nfl.json");
const [SI, SN] = arg("shard", "0/1").split("/").map(Number);
// --vendor: the live sim path - each contest's recovered Stokastic pre-lock file (Std Dev, bench/stk-vendor-files.mjs) as the pool
const VENDOR = process.argv.includes("--vendor"), VMAP = VENDOR ? JSON.parse(fs.readFileSync("data/vendor/nfl_cl/map.json", "utf8")) : {};
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const NFL_DEF = { 1: 45, 2: 41, 3: 5, bring: 62 };
// --lean: skip the no-tilt optimizer and keep contests where the optimizer built nothing (gen-pool strategies still graded)
const LEAN = process.argv.includes("--lean");
const QM = JSON.parse(fs.readFileSync("data/reports/qb-matchups-nfl.json", "utf8")).history;
const sched = fs.readFileSync("data/nflverse/games.csv", "utf8").trim().split(/\r?\n/), H = sched[0].split(","), ix = k => H.indexOf(k);
const games = sched.slice(1).map(l => l.split(",")).filter(c => +c[ix("season")] >= 2025 && c[ix("game_type")] === "REG");
const DK = { LA: "LAR" }, dk = t => DK[t] || t;
const weekOf = (date, team) => { const d0 = Date.parse(date); let g = null, bd = 1e18; for (const c of games) { if (dk(c[ix("home_team")]) !== team && dk(c[ix("away_team")]) !== team) continue; const d = Date.parse(c[ix("gameday")]) - d0; if (d >= -864e5 && d <= 6 * 864e5 && d < bd) { bd = d; g = c; } } return g ? `${g[ix("season")]}|${+g[ix("week")]}` : null; };   // first game on or after the contest date

function recoverPoints(entries, nP) {
  const A = entries.filter(e => e.actFP > 0), cnt = new Float64Array(nP); for (const e of A) for (const i of e.lu) cnt[i]++;
  const idx = [], col = new Int32Array(nP).fill(-1); for (let i = 0; i < nP; i++) if (cnt[i] >= 2) { col[i] = idx.length; idx.push(i); }
  const m = idx.length; if (!m) return null; const M = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (const e of A) { const cs = e.lu.map(i => col[i]); if (cs.some(x => x < 0)) continue; for (const a of cs) { M[a][m] += e.actFP; for (const q of cs) M[a][q] += 1; } }
  for (let a = 0; a < m; a++) M[a][a] += 1e-3;
  for (let c = 0; c < m; c++) { let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = c; k <= m; k++) M[c][k] /= d; for (let r = 0; r < m; r++) if (r !== c && M[r][c]) { const g = M[r][c]; for (let k = c; k <= m; k++) M[r][k] -= g * M[c][k]; } }
  const pts = new Float64Array(nP).fill(NaN); idx.forEach((i, a) => { pts[i] = M[a][m]; });
  const res = A.map(e => { const s = e.lu.reduce((t, i) => t + pts[i], 0); return isNaN(s) ? null : Math.abs(s - e.actFP); }).filter(x => x != null);
  return mean(res) > 0.5 ? null : pts;
}

function gradeOne(c) {
  let rc = loadPulled(c.json); if (VENDOR) { const m = VMAP[c.key] && matchToProjections(rc, VMAP[c.key].file, c.fkey); if (!m) return { dir: c.dir, skip: "no vendor file" }; rc = Object.assign({}, rc, { pool: m.pool, entries: m.entries }); }
  const pool = rc.pool, P = pool.players, f = pool.format, N = rc.entries.length; if (N < 300) return null;
  const pts = recoverPoints(rc.entries, P.length); if (!pts) return { dir: c.dir, skip: "points not recoverable" };
  const rows = P.map(p => ({ pos: p.pos, team: p.team, sal: p.sal, proj: p.proj, vown: p.own })); ownModel("classic")(rows, { n: N, fee: c.fee });
  // Lab own under 800% total (122 of 363 recovered pools come in under 700%) collapses the generator: use the vendor number there
  const labTot = rows.reduce((s, r) => s + (r.labOwn || 0), 0), useLab = labTot >= 800;
  const gp = Object.assign({}, pool, { players: P.map((p, i) => Object.assign({}, p, useLab ? { own: rows[i].labOwn ?? p.own, fown: rows[i].labOwn ?? p.own } : {})) });
  const n = Math.min(POOL, N), t0 = Date.now();
  const field = genField(gp, n, { conc: 1.1, minSal: 48000, boost: 1.0, rounds: 3, nflStacks: NFL_DEF }, mulberry32(1)).field;
  const wk = weekOf(c.date, P.find(p => p.team)?.team), qbm = (wk && QM[wk]) || {};
  const OPT0 = LEAN ? [] : optimizeLineups(gp, { n: 150, qbTilt: 0 }, mulberry32(5)).lineups;
  const OPTQ = optimizeLineups(gp, { n: 150, qbMatchups: qbm }, mulberry32(5)).lineups;
  if (!OPTQ.length && !LEAN) return { dir: c.dir, skip: "optimizer built nothing" };
  // everything simmed alone against the generated field
  const paySum = rc.payouts.reduce((s, x) => s + x, 0), first = rc.payouts[0] || paySum * 0.1, pay = fitPayouts(n, paySum * n / N, Math.max(first * n / N, paySum * n / N * 0.03), 20);
  const cands = [], seen = new Map(), add = (lu, src) => { const s = sigOf(lu, f); if (seen.has(s)) { cands[seen.get(s)].src.add(src); return; } seen.set(s, cands.length); cands.push({ lu, src: new Set([src]) }); };
  for (const lu of field) add(lu, "gen"); for (const lu of OPTQ) add(lu, "opt"); for (const lu of OPT0) add(lu, "opt0");
  const model = buildModel(gp, {}), res = simulate({ pool: gp, model, field, lineups: cands.map(x => x.lu), payouts: pay, entries: n, fee: 1, iters: ITERS, maxIters: ITERS * 2, rng: mulberry32(17), solo: true, calibrate: false });
  const realFP = rc.entries.map(e => e.actFP).sort((a, b) => b - a), sigs = {}; for (const e of rc.entries) { const s = sigOf(e.lu, f); sigs[s] = (sigs[s] || 0) + 1; }
  const rankOf = x => { let lo = 0, hi = realFP.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (realFP[mid] > x) lo = mid + 1; else hi = mid; } return lo + 1; };
  const GP = gp.players, shape = lu => { const qb = lu.map(i => GP[i]).find(p => p.pos === "QB"); const stackN = qb ? lu.filter(i => GP[i] !== qb && GP[i].team === qb.team && /^(WR|TE|RB)$/.test(GP[i].pos)).length : 0, bring = !!qb && lu.some(i => GP[i].team === qb.opp && GP[i].pos !== "DST"); const gc = {}; for (const i of lu) if (GP[i].pos !== "DST" && GP[i].opp) { const g = [GP[i].team, GP[i].opp].sort().join("@"); gc[g] = (gc[g] || 0) + 1; } const g1 = Object.entries(gc).sort((a, b) => b[1] - a[1])[0] || ["", 0];
    return { game: g1[0], gameMax: g1[1], ownSum: lu.reduce((s, i) => s + GP[i].own, 0), ids: lu, qbm: qb ? (qbm[qb.opp] ?? 0) : 0, qbKey: qb ? qb.name + "|" + qb.team : "", stackN, bring, chalk: lu.filter(i => GP[i].own >= 20).length, left: f.cap - lu.reduce((s, i) => s + GP[i].sal, 0) }; };
  const C = res.rows.map((r, i) => { let t = 0; for (const j of r.lu) { if (isNaN(pts[j])) return null; t += pts[j]; } const rank = rankOf(t), dup = sigs[sigOf(r.lu, f)] || 0, payout = rc.payouts[rank - 1] || 0;
    return Object.assign({ src: cands[i].src, roi: r.roi, proj: r.proj, top10: rank <= Math.ceil(N * 0.1), top1: rank <= Math.ceil(N * 0.01), actROI: 100 * (payout / (1 + dup) - 1), dup }, shape(r.lu)); }).filter(Boolean);
  const rng = mulberry32(99), pick = (arr, k) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  const rules = x => x.stackN >= 2 && x.bring && x.chalk >= 4 && x.left < 600, of = s => C.filter(x => x.src.has(s)), bySim = a => a.slice().sort((p, q) => q.roi - p.roi), byProj = a => a.slice().sort((p, q) => q.proj - p.proj);
  // QB matchup cut within the slate: rank the QBs the rules pool uses by their defense's matchup; drop the worst 40% / keep the best half
  const qbVals = [...new Map(of("gen").filter(rules).map(x => [x.qbKey, x.qbm])).values()].sort((a, b) => a - b);
  const qAt = q => qbVals.length ? qbVals[Math.min(qbVals.length - 1, Math.floor(q * qbVals.length))] : 0;
  const notWorst = x => qbVals.length < 3 || x.qbm >= qAt(0.4), topHalf = x => qbVals.length < 2 || x.qbm >= qAt(0.5);
  const tilt = w => a => a.slice().sort((p, q) => (q.roi + w * 100 * q.qbm) - (p.roi + w * 100 * p.qbm));   // w ROI points per +1% matchup
  const merged = C.filter(x => x.src.has("gen") || x.src.has("opt")).filter(rules);
  // sharp shape (DFSDB proven winners, same-contest: field-level ownership, a little salary left, QB+2 + bring-back, one game loaded,
  // the sim's upper-middle rather than its top). Sim percentile and pool ownership are within the generated pool.
  const GEN = bySim(of("gen")); GEN.forEach((x, i) => { x.simPct = 100 * (1 - i / GEN.length); });
  const ownAvg = mean(GEN.map(x => x.ownSum));
  const sharp = x => x.stackN >= 2 && x.bring && x.gameMax >= 4 && x.left >= 50 && x.left <= 300 && x.ownSum <= ownAvg + 15;
  const rules3 = x => x.stackN >= 2 && x.bring && x.chalk >= 3 && x.left < 600, noChalk = x => x.stackN >= 2 && x.bring && x.left < 600;
  const sharpPool = GEN.filter(sharp);
  // 5-entry portfolio: greedy by sim ROI, each new entry a different QB and main game, sharing at most 4 players with any pick
  const spread = (a, k) => { const out = []; for (const x of a) { if (out.length >= k) break; if (out.some(y => y.qbKey === x.qbKey || y.game === x.game || y.ids.filter(i => x.ids.includes(i)).length > 4)) continue; out.push(x); } return out; };
  const P5 = { "loop top 5": bySim(of("gen").filter(rules)).slice(0, 5), "loop spread 5": spread(bySim(of("gen").filter(rules)), 5), "sharp top 5": sharpPool.slice(0, 5), "sharp spread 5": spread(sharpPool, 5), "sharp no-top15 spread 5": spread(sharpPool.filter(x => x.simPct <= 85), 5), "loop chalk3 spread 5": spread(bySim(of("gen").filter(rules3)), 5) };
  const S = {
    "sharp shape + sim ROI": sharpPool.slice(0, K),
    "sharp shape, skip sim top 15%": sharpPool.filter(x => x.simPct <= 85).slice(0, K),
    "sharp shape, sim 50-80th random": pick(sharpPool.filter(x => x.simPct >= 50 && x.simPct <= 80), K),
    "loop rules, chalk 3+": bySim(of("gen").filter(rules3)).slice(0, K),
    // TwoGun (10/17, 192 classic lineups same-contest): stacks + bring-back + spends the cap, below-field own; his low-chalk lineups hit as often
    "loop rules, no chalk min": bySim(of("gen").filter(noChalk)).slice(0, K),
    "loop rules, no chalk min, $200 or less left": bySim(of("gen").filter(x => noChalk(x) && x.left <= 200)).slice(0, K),
    "loop rules, chalk 3+, $200 or less left": bySim(of("gen").filter(x => rules3(x) && x.left <= 200)).slice(0, K),
    "TwoGun shape: QB+2+BB, game 4+, <=$200 left, own <= pool avg": bySim(of("gen").filter(x => noChalk(x) && x.gameMax >= 4 && x.left <= 200 && x.ownSum <= ownAvg)).slice(0, K),
    "loop rules, skip sim top 15%": bySim(of("gen").filter(rules).filter(x => x.simPct <= 85)).slice(0, K),
    "loop now: gen pool, rules + sim ROI": bySim(of("gen").filter(rules)).slice(0, K),
    "loop + QB not in slate's worst 40% matchups": bySim(of("gen").filter(rules).filter(notWorst)).slice(0, K),
    "loop + QB in slate's best half of matchups": bySim(of("gen").filter(rules).filter(topHalf)).slice(0, K),
    "loop, sim ROI + 0.5 x QB matchup %": tilt(0.5)(of("gen").filter(rules)).slice(0, K),
    "loop, sim ROI + 2 x QB matchup %": tilt(2)(of("gen").filter(rules)).slice(0, K),
    "merged pool, rules + sim ROI": bySim(merged).slice(0, K),
    "merged pool + QB not worst 40%": bySim(merged.filter(notWorst)).slice(0, K),
    "optimizer (QB tilt), random K": pick(of("opt"), K),
    "optimizer (QB tilt), top K by sim ROI": bySim(of("opt")).slice(0, K),
    "optimizer (QB tilt), top K by projection": byProj(of("opt")).slice(0, K),
    "optimizer, no QB tilt, random K": pick(of("opt0"), K),
    "random generated lineup": pick(of("gen"), K),
    "optimizer, loop rules + sim ROI": bySim(of("opt").filter(rules)).slice(0, K),
    "optimizer QB+2 + bring-back only, sim ROI": bySim(of("opt").filter(x => x.stackN >= 2 && x.bring)).slice(0, K),
  };
  const pf = {}; for (const [k, s] of Object.entries(P5)) if (s.length) pf[k] = { n: s.length, any1: +s.some(x => x.top1), any10: +s.some(x => x.top10), roi: mean(s.map(x => x.actROI)), qbs: new Set(s.map(x => x.qbKey)).size };
  const out = { pf, useLab, genN: GEN.length, dir: c.dir, date: c.date, fee: c.fee, N, nQB: qbVals.length, ms: Date.now() - t0, field: mean(rc.entries.map(e => e.actROI)), by: {} };
  for (const [k, s] of Object.entries(S)) if (s.length >= 5) out.by[k] = { actROI: mean(s.map(x => x.actROI)), top10: mean(s.map(x => +x.top10)), top1: mean(s.map(x => +x.top1)), dup: mean(s.map(x => x.dup)), qbm: mean(s.map(x => x.qbm)), own: mean(s.map(x => x.ownSum)), left: mean(s.map(x => x.left)), simPct: mean(s.map(x => x.simPct ?? NaN)), gameMax: mean(s.map(x => x.gameMax)), n: s.length };
  return out;
}

const all = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.fee >= 20 && c.entries >= 300 && c.date >= FROM);
const mine = all.filter((c, i) => i % SN === SI).slice(0, LIMIT || undefined);
console.error(`${all.length} contests, shard ${SI}/${SN} -> ${mine.length}`);
const results = [];
for (const c of mine) { try { const r = gradeOne(c); if (r) { results.push(r); console.error(`${c.dir} ${r.skip || `${(r.ms / 1000).toFixed(1)}s`}`); } } catch (e) { console.error(`${c.dir} ERROR ${e.message}`); } }
const file = SN > 1 ? OUT.replace(/\.json$/, `-${SI}.json`) : OUT; fs.mkdirSync("data/reports", { recursive: true }); fs.writeFileSync(file, JSON.stringify({ built: new Date().toISOString(), K, results }, null, 1));
console.log(`${results.filter(r => !r.skip).length} graded -> ${file}`);
