// Pre-contest sim: scores every contest entry and every one of your lineups on the same
// correlated outcome each iteration, then pays by rank.
import { drawScores, makeScratch } from "./model.mjs";
import { sigOf, salOf, ownSum, stackOf } from "./lineups.mjs";
import { paidCount } from "./payouts.mjs";

// Reported NFL numbers are recalibrated to what real contests return (bench/sim-calibration-nfl.mjs and
// bench/fit-sim-calibration-nfl.mjs, 2026-10-06): every real entry of 946 contests (486 classic, 460 showdown,
// 2025-26, fields up to 6,000) simmed in its real contest. The ORDER of lineups is right (rank correlation with
// actual ~0.12) but the levels are overconfident: realised payout moved 0.36x the predicted gap from the rake
// level in classic and 0.57x in showdown, top-1% chances 0.36x / 0.42x on the log-ratio scale, and win chances
// carry almost no information (fitted 0.00-0.04). Wider sigma (x1.3) cut rank correlation 0.129 -> 0.053 without
// fixing it, and scaling correlations x0.6 / x1.4 changed nothing, so the fix is a monotone rescale of the
// reported numbers: ROI toward the contest's rake level (x' = m + s(x - m), payout multiples), probabilities as
// base * (p/base)^b. Order inside a run never changes. Values held out-of-sample in both directions (fit 2025 ->
// 2026 and back); classic top-10% and cash were already calibrated (b ~1, changing them hurt) so they stay.
// raw numbers stay on each row as r.raw; a.calibrate === false turns it off (the benches measure raw).
export const CALIB = {
  nfl_cl: { roi: 0.36, win: 0.05, t1: 0.36 },
  nfl_sd: { roi: 0.57, win: 0.05, t1: 0.42, t10: 0.6, cash: 0.8 }
};

// a.iters is one checkpoint; with a.maxIters the sim keeps going in checkpoints until the
// top of the ROI ranking (top 5%, at least 20 lineups) overlaps 90% with the previous
// checkpoint, so results stop moving before it stops. Every row carries se, the standard
// error of its ROI in points.
export function simulate(a) {
  const { pool, model, field, lineups, payouts, entries, fee, rng } = a;
  const base = Math.max(1, a.iters || 5000), maxIters = Math.max(base, a.maxIters || base), fieldMode = !!a.fieldMode, solo = !!a.solo && !fieldMode, onProgress = a.onProgress;
  const P = pool.players, f = pool.format, n = P.length, nl = lineups.length, mult = f.mult;
  // solo: each lineup is entered alone against the contest field (the field holds every entry; a lineup drawn from it finds its
  // own copy there, which is not a duplicate); otherwise the lineups join the field together, or ARE the contest (fieldMode)
  const FS = fieldMode ? 0 : solo ? Math.min(field.length, entries) : Math.max(1, Math.min(field.length, entries - nl));
  const fld = field.slice(0, FS);
  const pay = payouts, paidN = paidCount(pay);
  const top1 = Math.max(1, Math.round(entries * 0.01)), top10 = Math.max(1, Math.round(entries * 0.10));
  const topK = nl <= 20 ? Math.max(3, Math.ceil(nl / 2)) : Math.max(20, Math.round(nl * 0.05));   // small sets: is the top half settled?
  const topSet = () => new Set(Array.from(wsum.keys()).sort((x, y) => wsum[y] - wsum[x]).slice(0, topK));

  const win = new Float64Array(nl), t1 = new Float64Array(nl), t10 = new Float64Array(nl), cash = new Float64Array(nl),
    wsum = new Float64Array(nl), wsq = new Float64Array(nl), dupe = new Float64Array(nl), ptsum = new Float64Array(nl), ranksum = new Float64Array(nl);
  const sigF = {}, sigL = {}, fdup = new Float64Array(nl);
  for (const l of fld) { const k = sigOf(l, f); sigF[k] = (sigF[k] || 0) + 1; }
  for (const l of lineups) { const k = sigOf(l, f); sigL[k] = (sigL[k] || 0) + 1; }
  for (let i = 0; i < nl; i++) { const k = sigOf(lineups[i], f); fdup[i] = solo ? Math.max(0, (sigF[k] || 0) - (sigF[k] ? 1 : 0)) : (sigF[k] || 0) + (sigL[k] || 1) - 1; }

  const sc = new Float64Array(n), all = new Float64Array(solo ? FS : FS + nl), ms = new Float64Array(nl), scratch = makeScratch(model, pool);
  // story: the average score of every player in the draws where each lineup finishes top 1%
  const story = !!a.story, meanSc = story ? new Float64Array(n) : null, winSc = story ? new Float64Array(nl * n) : null, winN = story ? new Float64Array(nl) : null;
  // keep: per-iteration payout (fee units, split with copies) and top-1% flag of every lineup, for choosing a SET of
  // entries (src/engine/portfolio.mjs); onIter(it, scores) sees each draw's player scores (game-script labels)
  const keep = !!a.keep, payM = keep ? new Float32Array(nl * maxIters) : null, t1M = keep ? new Uint8Array(nl * maxIters) : null, onIter = a.onIter;
  let anyTop1 = 0, iters = 0, prevTop = null;
  for (let it = 0; it < maxIters; it++) {
    drawScores(model, pool, rng, sc, scratch);
    if (story) for (let j = 0; j < n; j++) meanSc[j] += sc[j];
    for (let k = 0; k < FS; k++) { const l = fld[k]; let t = 0; for (let q = 0; q < l.length; q++) t += (mult ? mult[q] : 1) * sc[l[q]]; all[k] = t; }
    for (let k = 0; k < nl; k++) { const l = lineups[k]; let t = 0; for (let q = 0; q < l.length; q++) t += (mult ? mult[q] : 1) * sc[l[q]]; ms[k] = t; ptsum[k] += t; if (!solo) all[FS + k] = t; }
    all.sort();
    let hit = false;
    for (let k = 0; k < nl; k++) {
      const mine = ms[k];
      let lo = 0, hi = all.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] <= mine) lo = mid + 1; else hi = mid; }
      const above = all.length - lo, ties = fdup[k], rank = above + 1;
      ranksum[k] += rank;
      if (rank === 1) win[k] += 1 / (1 + ties);
      if (rank <= top1) { t1[k]++; hit = true; if (story) { winN[k]++; const o = k * n; for (let j = 0; j < n; j++) winSc[o + j] += sc[j]; } }
      if (rank <= top10) t10[k]++;
      if (rank <= paidN) cash[k]++;
      const cnt = 1 + ties, steps = Math.max(1, Math.round(cnt));
      let w = 0; for (let r = rank; r < rank + steps && r <= pay.length; r++) w += pay[r - 1];
      wsum[k] += w / cnt; wsq[k] += (w / cnt) * (w / cnt);
      if (ties >= 1) dupe[k]++;
      if (keep) { payM[k * maxIters + it] = w / cnt; if (rank <= top1) t1M[k * maxIters + it] = 1; }
    }
    if (onIter) onIter(it, sc);
    if (hit) anyTop1++;
    iters = it + 1;
    if (onProgress && (it % 200 === 199 || iters === maxIters)) onProgress(iters, maxIters);
    if (iters % base === 0 && iters < maxIters) {
      const top = topSet();
      if (prevTop) { let same = 0; for (const x of top) if (prevTop.has(x)) same++; if (same >= 0.9 * topK) break; }
      prevTop = top;
    }
  }
  const rows = []; let prodMiss = 1;
  for (let k = 0; k < nl; k++) {
    const ev = wsum[k] / iters, sd = Math.sqrt(Math.max(0, wsq[k] / iters - ev * ev));
    rows.push({ i: k, lu: lineups[k], proj: ptsum[k] / iters, avgRank: ranksum[k] / iters,
      win: win[k] / iters * 100, t1: t1[k] / iters * 100, t10: t10[k] / iters * 100, cash: cash[k] / iters * 100,
      dupe: dupe[k] / iters * 100, dupN: fdup[k], own: ownSum(lineups[k], P, f), sal: salOf(lineups[k], P, f),
      stack: stackOf(lineups[k], P, f), ev, roi: fee > 0 ? (ev / fee - 1) * 100 : null, se: fee > 0 ? sd / Math.sqrt(iters) / fee * 100 : null });
    if (story) {
      // per player: score in this lineup's winning draws relative to its usual score
      const o = k * n, m = new Float64Array(n);
      for (let j = 0; j < n; j++) m[j] = winN[k] && meanSc[j] > 0 ? (winSc[o + j] / winN[k]) / (meanSc[j] / iters) : 1;
      rows[k].story = { wins: winN[k], mult: Array.from(m) };
    }
    prodMiss *= (1 - t1[k] / iters);
  }
  const cal = a.calibrate === false ? null : CALIB[f.key];
  if (cal && fee > 0) {
    const m = pay.reduce((s, x) => s + x, 0) / (entries * fee), base = { win: 1 / entries, t1: top1 / entries, t10: top10 / entries, cash: paidN / entries };
    for (const r of rows) {
      r.raw = { roi: r.roi, win: r.win, t1: r.t1, t10: r.t10, cash: r.cash };
      const x = m + cal.roi * (r.ev / fee - m);
      r.ev = x * fee; r.roi = (x - 1) * 100; if (r.se != null) r.se *= cal.roi;
      for (const k of ["win", "t1", "t10", "cash"]) { const b = cal[k]; if (b == null || b === 1 || !(base[k] > 0)) continue; r[k] = Math.min(1, base[k] * Math.pow(Math.max(1e-9, r[k] / 100) / base[k], b)) * 100; }
    }
  }
  const tot = rows.reduce((s, r) => s + r.ev, 0);
  const obs = anyTop1 / iters * 100, indep = (1 - prodMiss) * 100;
  return { rows, obs, indep, lift: indep > 0 ? (obs / indep - 1) * 100 : null, pev: tot,
    proi: fee > 0 ? (tot / (fee * nl) - 1) * 100 : null, engine: model.type, FS, FE: entries, iters,
    kept: keep ? { pay: payM, t1: t1M, stride: maxIters, iters } : null };
}

export function playerROI(res, P, f) {
  const agg = {};
  for (const r of res.rows) r.lu.forEach((id, j) => {
    const a = agg[id] || (agg[id] = { id, n: 0, roi: 0, win: 0, cpt: 0 });
    a.n++; a.roi += r.roi == null ? 0 : r.roi; a.win += r.win; if (f.mult && j === 0) a.cpt++;
  });
  return Object.values(agg).map(a => ({ id: a.id, name: P[a.id].name, team: P[a.id].team, pos: P[a.id].pos,
    n: a.n, exp: a.n / res.rows.length * 100, own: P[a.id].own, roi: a.roi / a.n, win: a.win, cpt: a.cpt }))
    .sort((a, b) => b.roi - a.roi);
}

// MLB stack ROI by team and stack size (3, 4, 5 hitters from one team).
export function stackROI(res, P) {
  const agg = {};
  for (const r of res.rows) {
    const tc = {};
    for (const id of r.lu) { const p = P[id]; if (p.isP) continue; tc[p.team] = (tc[p.team] || 0) + 1; }
    for (const tm in tc) { const s = tc[tm]; if (s < 3) continue; const k = tm + "|" + s; const a = agg[k] || (agg[k] = { team: tm, size: s, n: 0, roi: 0 }); a.n++; a.roi += r.roi || 0; }
  }
  return Object.values(agg).map(a => ({ team: a.team, size: a.size, n: a.n, roi: a.roi / a.n })).sort((a, b) => a.team.localeCompare(b.team) || a.size - b.size);
}
