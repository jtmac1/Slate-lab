// Pre-contest sim: scores every contest entry and every one of your lineups on the same
// correlated outcome each iteration, then pays by rank.
import { drawScores, makeScratch } from "./model.mjs";
import { sigOf, salOf, ownSum, stackOf } from "./lineups.mjs";
import { paidCount } from "./payouts.mjs";

// a.iters is one checkpoint; with a.maxIters the sim keeps going in checkpoints until the
// top of the ROI ranking (top 5%, at least 20 lineups) overlaps 90% with the previous
// checkpoint, so results stop moving before it stops. Every row carries se, the standard
// error of its ROI in points.
export function simulate(a) {
  const { pool, model, field, lineups, payouts, entries, fee, rng } = a;
  const base = Math.max(1, a.iters || 5000), maxIters = Math.max(base, a.maxIters || base), fieldMode = !!a.fieldMode, onProgress = a.onProgress;
  const P = pool.players, f = pool.format, n = P.length, nl = lineups.length, mult = f.mult;
  const FS = fieldMode ? 0 : Math.max(1, Math.min(field.length, entries - nl));
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
  for (let i = 0; i < nl; i++) { const k = sigOf(lineups[i], f); fdup[i] = (sigF[k] || 0) + (sigL[k] || 1) - 1; }

  const sc = new Float64Array(n), all = new Float64Array(FS + nl), ms = new Float64Array(nl), scratch = makeScratch(model, pool);
  let anyTop1 = 0, iters = 0, prevTop = null;
  for (let it = 0; it < maxIters; it++) {
    drawScores(model, pool, rng, sc, scratch);
    for (let k = 0; k < FS; k++) { const l = fld[k]; let t = 0; for (let q = 0; q < l.length; q++) t += (mult ? mult[q] : 1) * sc[l[q]]; all[k] = t; }
    for (let k = 0; k < nl; k++) { const l = lineups[k]; let t = 0; for (let q = 0; q < l.length; q++) t += (mult ? mult[q] : 1) * sc[l[q]]; ms[k] = t; ptsum[k] += t; all[FS + k] = t; }
    all.sort();
    let hit = false;
    for (let k = 0; k < nl; k++) {
      const mine = ms[k];
      let lo = 0, hi = all.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] <= mine) lo = mid + 1; else hi = mid; }
      const above = all.length - lo, ties = fdup[k], rank = above + 1;
      ranksum[k] += rank;
      if (rank === 1) win[k] += 1 / (1 + ties);
      if (rank <= top1) { t1[k]++; hit = true; }
      if (rank <= top10) t10[k]++;
      if (rank <= paidN) cash[k]++;
      const cnt = 1 + ties, steps = Math.max(1, Math.round(cnt));
      let w = 0; for (let r = rank; r < rank + steps && r <= pay.length; r++) w += pay[r - 1];
      wsum[k] += w / cnt; wsq[k] += (w / cnt) * (w / cnt);
      if (ties >= 1) dupe[k]++;
    }
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
    prodMiss *= (1 - t1[k] / iters);
  }
  const tot = rows.reduce((s, r) => s + r.ev, 0);
  const obs = anyTop1 / iters * 100, indep = (1 - prodMiss) * 100;
  return { rows, obs, indep, lift: indep > 0 ? (obs / indep - 1) * 100 : null, pev: tot,
    proi: fee > 0 ? (tot / (fee * nl) - 1) * 100 : null, engine: model.type, FS, FE: entries, iters };
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
