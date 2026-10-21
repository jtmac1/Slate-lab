// Tests the "export the Stokastic sim's top lineups, re-sim them in our sim" workflow (how the user used Blick's sim).
// Per classic contest: Stokastic candidates = the real field's unique lineups ranked by Stokastic sim ROI (sroi; the only
// Stokastic-ranked lineups the archive holds). Every candidate - those plus our generated pool - is simmed alone against
// our generated field (solo), then each strategy's K picks are scored in the REAL contest exactly like grade-loop-nfl.mjs
// (payout at the finish, split with the real copies; actROIown = as if you were one of those copies, no extra split). Rules = the loop filter (QB+2, bring-back, 4 chalk, <$600 left).
//   node bench/stok-resim-nfl.mjs [--from=2025-09-01] [--to=2026-12-31] [--k=20] [--pool=3000] [--iters=1000] [--shard=i/n] [--limit=N]
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { ownModel } from "../server/sources.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-12-31"), K = +arg("k", 20), POOL = +arg("pool", 3000), ITERS = +arg("iters", 1000), LIMIT = +arg("limit", 0), OUT = arg("out", "data/reports/stok-resim-nfl.json");
const [SI, SN] = (arg("shard", "0/1")).split("/").map(Number);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, se = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : null;
const NFL_DEF = { 1: 45, 2: 41, 3: 5, bring: 62 };

function gradeOne(c) {
  const rc = loadPulled(c.json), pool = rc.pool, P = pool.players, f = pool.format, N = rc.entries.length;
  if (N < 300) return null;
  const rows = P.map(p => ({ pos: p.pos, team: p.team, sal: p.sal, proj: p.proj, vown: p.own })); ownModel("classic")(rows, { n: N, fee: c.fee });
  const gp = Object.assign({}, pool, { players: P.map((p, i) => Object.assign({}, p, { own: rows[i].labOwn ?? p.own, fown: rows[i].labOwn ?? p.own })) });
  const n = Math.min(POOL, N), t0 = Date.now();
  const field = genField(gp, n, { conc: 1.1, minSal: 48000, boost: 1.0, rounds: 3, nflStacks: NFL_DEF }, mulberry32(1)).field;
  // real contest: finish by actual points, copies by signature
  const realFP = rc.entries.map(e => e.actFP).sort((a, b) => b - a), sigs = {}, realBySig = {};
  for (const e of rc.entries) { const s = sigOf(e.lu, f); sigs[s] = (sigs[s] || 0) + 1; if (!realBySig[s]) realBySig[s] = e; }
  const rankOf = pts => { let lo = 0, hi = realFP.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (realFP[mid] > pts) lo = mid + 1; else hi = mid; } return lo + 1; };
  // points for generated lineups: a lineup the real field also holds scores exactly; otherwise sum the players' points, which
  // are recovered from the real lineups (one equation per lineup) the same way grade-loop does
  const pts = recoverPoints(rc.entries, P.length);
  if (!pts) return { dir: c.dir, skip: "points not recoverable" };
  const scoreLu = lu => { const r = realBySig[sigOf(lu, f)]; if (r) return r.actFP; let t = 0; for (const i of lu) { if (isNaN(pts[i])) return null; t += pts[i]; } return t; };
  // Stokastic candidates: unique real lineups by sroi
  const stok = Object.values(realBySig).sort((a, b) => b.stkROI - a.stkROI), U = stok.length;
  const stokTop = m => stok.slice(0, m).map(e => e.lu), stokBand = (lo, hi) => stok.slice(Math.floor(U * lo), Math.floor(U * hi)).map(e => e.lu);
  const S500 = stokTop(Math.min(500, U)), SMID = stokBand(0.1, 0.5).slice(0, 500);
  // sim every candidate once, alone against our generated field
  const cands = [], seen = new Map(), add = (lu, src) => { const s = sigOf(lu, f); if (seen.has(s)) { cands[seen.get(s)].src.add(src); return; } seen.set(s, cands.length); cands.push({ lu, src: new Set([src]) }); };
  for (const lu of field) add(lu, "gen"); S500.forEach((lu, i) => add(lu, i < 50 ? "s50" : "s500")); for (const lu of SMID) add(lu, "smid");
  const paySum = rc.payouts.reduce((s, x) => s + x, 0), first = rc.payouts[0] || paySum * 0.1, pay = fitPayouts(n, paySum * n / N, Math.max(first * n / N, paySum * n / N * 0.03), 20);
  const model = buildModel(gp, {}), res = simulate({ pool: gp, model, field, lineups: cands.map(x => x.lu), payouts: pay, entries: n, fee: 1, iters: ITERS, maxIters: ITERS * 2, rng: mulberry32(17), solo: true, calibrate: false });
  const GP = gp.players, shape = lu => { const qb = lu.map(i => GP[i]).find(p => p.pos === "QB"); const stackN = qb ? lu.filter(i => GP[i] !== qb && GP[i].team === qb.team && /^(WR|TE|RB)$/.test(GP[i].pos)).length : 0, bring = !!qb && lu.some(i => GP[i].team === qb.opp && GP[i].pos !== "DST"); return { stackN, bring, chalk: lu.filter(i => GP[i].own >= 20).length, left: f.cap - lu.reduce((s, i) => s + GP[i].sal, 0) }; };
  const stkOf = lu => { const r = realBySig[sigOf(lu, f)]; return r ? r.stkROI : null; };
  const C = res.rows.map((r, i) => { const p = scoreLu(r.lu); if (p == null) return null; const rank = rankOf(p), dup = sigs[sigOf(r.lu, f)] || 0, payout = rc.payouts[rank - 1] || 0;
    return Object.assign({ src: cands[i].src, roi: r.roi, dupN: r.dupN, lown: r.lu.reduce((t, j) => t + Math.log(Math.max(0.1, GP[j].own) / 100), 0), stk: stkOf(r.lu), proj: r.proj, rank, pct: 1 - (rank - 1) / N, top10: rank <= Math.ceil(N * 0.1), top1: rank <= Math.ceil(N * 0.01), actROI: 100 * (payout / (1 + dup) - 1), actROIown: 100 * (payout / Math.max(1, dup) - 1), dup }, shape(r.lu)); }).filter(Boolean);
  const rules = x => x.stackN >= 2 && x.bring && x.chalk >= 4 && x.left < 600, has = (...s) => x => s.some(k => x.src.has(k));
  const bySim = a => a.slice().sort((p, q) => b(q.roi) - b(p.roi)), byStk = a => a.slice().sort((p, q) => b(q.stk) - b(p.stk)), b = v => v ?? -1e9;
  const gen = C.filter(has("gen")), s50 = C.filter(has("s50")), s500 = C.filter(has("s50", "s500")), smid = C.filter(has("smid"));
  const q75 = (a => a[Math.floor(a.length * 0.75)])(C.map(x => x.lown).sort((p, q) => p - q)), lowOwn = x => x.lown < q75, noCopy = x => x.dupN === 0;
  const strategies = {
    "loop now: gen pool, rules + our sim": bySim(gen.filter(rules)).slice(0, K),
    "Stokastic top K (sroi)": byStk(s500).slice(0, K),
    "Stokastic top 50 -> our sim": bySim(s50).slice(0, K),
    "Stokastic top 50 -> rules + our sim": bySim(s50.filter(rules)).slice(0, K),
    "Stokastic top 500 -> our sim": bySim(s500).slice(0, K),
    "Stokastic top 500 -> rules + sroi": byStk(s500.filter(rules)).slice(0, K),
    "Stokastic top 500 -> rules + our sim": bySim(s500.filter(rules)).slice(0, K),
    "Stokastic 10-50th pct -> rules + our sim": bySim(smid.filter(rules)).slice(0, K),
    "gen + Stokastic 500 -> rules + our sim": bySim(C.filter(has("gen", "s50", "s500")).filter(rules)).slice(0, K),
    // dupe filters (pre-lock only): no copy in our generated field, or ownership product below the candidates' top quartile
    "Stokastic top 500 -> rules + our sim, no gen copy": bySim(s500.filter(rules).filter(noCopy)).slice(0, K),
    "Stokastic top 500 -> rules + our sim, own product < q75": bySim(s500.filter(rules).filter(lowOwn)).slice(0, K),
    "Stokastic top 500 -> rules + our sim, both": bySim(s500.filter(rules).filter(noCopy).filter(lowOwn)).slice(0, K),
    "gen + Stokastic 500 -> rules + our sim, no gen copy": bySim(C.filter(has("gen", "s50", "s500")).filter(rules).filter(noCopy)).slice(0, K),
    "gen + Stokastic 500 -> rules + our sim, both": bySim(C.filter(has("gen", "s50", "s500")).filter(rules).filter(noCopy).filter(lowOwn)).slice(0, K),
  };
  const agg = s => ({ k: s.length, actROI: mean(s.map(x => x.actROI)), actROIown: mean(s.map(x => x.actROIown)), pct: mean(s.map(x => x.pct)), top10: mean(s.map(x => +x.top10)), top1: mean(s.map(x => +x.top1)), dup: mean(s.map(x => x.dup)) });
  const out = { dir: c.dir, date: c.date, fee: c.fee, N, tier: c.tier, size: c.size, ms: Date.now() - t0, field: { actROI: mean(rc.entries.map(e => e.actROI)) }, by: {} };
  for (const [k, s] of Object.entries(strategies)) if (s.length >= Math.min(K, 5)) out.by[k] = agg(s);
  // does our sim re-rank the Stokastic top 500 toward real results? spearman (our sim vs actual pct) and (sroi vs actual pct)
  { const s5 = s500.filter(x => x.src.has("s50") || x.src.has("s500")); out.dupHit = { flagged: mean(s5.filter(x => !noCopy(x) || !lowOwn(x)).map(x => x.dup)), kept: mean(s5.filter(x => noCopy(x) && lowOwn(x)).map(x => x.dup)) }; }
  out.rhoOurs = spear(s500.map(x => x.roi), s500.map(x => x.pct)); out.rhoStk = spear(s500.map(x => x.stk), s500.map(x => x.pct)); out.rhoBoth = spear(s500.map(x => x.roi), s500.map(x => x.stk));
  return out;
}

function spear(a, c) { const rk = v => { const o = v.map((_, i) => i).sort((x, y) => v[y] - v[x]), r = new Array(v.length); o.forEach((i, p) => { r[i] = p; }); return r; }; const r1 = rk(a), r2 = rk(c), m1 = mean(r1), m2 = mean(r2); let num = 0, d1 = 0, d2 = 0; for (let i = 0; i < r1.length; i++) { num += (r1[i] - m1) * (r2[i] - m2); d1 += (r1[i] - m1) ** 2; d2 += (r2[i] - m2) ** 2; } return d1 && d2 ? num / Math.sqrt(d1 * d2) : 0; }

// actual points per player from the real lineups: ridge least squares (as in grade-loop-nfl.mjs)
function recoverPoints(entries, nP) {
  const A = entries.filter(e => e.actFP > 0), cnt = new Float64Array(nP); for (const e of A) for (const i of e.lu) cnt[i]++;
  const idx = [], col = new Int32Array(nP).fill(-1); for (let i = 0; i < nP; i++) if (cnt[i] >= 2) { col[i] = idx.length; idx.push(i); }
  const m = idx.length; if (!m) return null;
  const M = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (const e of A) { const cs = e.lu.map(i => col[i]); if (cs.some(x => x < 0)) continue; for (const a of cs) { M[a][m] += e.actFP; for (const q of cs) M[a][q] += 1; } }
  for (let a = 0; a < m; a++) M[a][a] += 1e-3;
  for (let c = 0; c < m; c++) { let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = c; k <= m; k++) M[c][k] /= d; for (let r = 0; r < m; r++) if (r !== c && M[r][c]) { const g = M[r][c]; for (let k = c; k <= m; k++) M[r][k] -= g * M[c][k]; } }
  const pts = new Float64Array(nP).fill(NaN); idx.forEach((i, a) => { pts[i] = M[a][m]; });
  const resid = A.map(e => { const s = e.lu.reduce((t, i) => t + pts[i], 0); return isNaN(s) ? null : Math.abs(s - e.actFP); }).filter(x => x != null);
  return mean(resid) > 0.5 ? null : pts;
}

const all = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.fee >= 20 && c.entries >= 300 && c.date >= FROM && c.date <= TO);
const mine = all.filter((c, i) => i % SN === SI).slice(0, LIMIT || undefined);
console.error(`${all.length} classic contests, shard ${SI}/${SN} -> ${mine.length}`);
const results = [];
for (const c of mine) { try { const r = gradeOne(c); if (r) { results.push(r); console.error(`${r.dir} ${r.skip ? "SKIP " + r.skip : `N ${r.N} ${(r.ms / 1000).toFixed(1)}s`}`); } } catch (e) { console.error(`${c.dir} ERROR ${e.message}`); } }
const file = SN > 1 ? OUT.replace(/\.json$/, `-${SI}.json`) : OUT; fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync(file, JSON.stringify({ built: new Date().toISOString(), args: { FROM, TO, K, POOL, ITERS }, results }, null, 1));
console.log(`${results.filter(r => !r.skip).length} graded -> ${file}`);
export { mean, se };
