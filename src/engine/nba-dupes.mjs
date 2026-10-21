// NBA classic duplicate risk (bench/fit-dupes-nba.mjs, 2026-10-21): expected number of OTHER identical entries for a lineup in a
// contest of N entries, a Poisson model fitted on 579 real 2025-26 NBA classic fields (copies = Stokastic "duplicates").
// Features, all known before lock: lx = log(N * product of projected ownership), gap = slate-best projection minus the lineup's,
// salary left, slate size (2-4 / 5-7 / 8+ games), log N, log fee. dupeAdjROI splits the payouts a lineup's finish would earn
// over 1 + copies places, using the sim's win / top-1% / top-10% / cash chances as the finish distribution.
// [1, lx, lx^2, lg = log1p(gap), salLeft/1K, small, medium, log N, log fee, lx*small, lx*medium, lg*small, lg*medium], fitted on all dates
// (held-out check with odd-date coefficients in data/reports/nba/dupes-nba.txt)
export const NBA_DUPE_COEF = [4.70064, 0.70436, 0.03313, -0.9617, -1.186, -1.45909, -0.61998, 0.06446, -0.13129, -0.16866, -0.0679, -0.00056, -0.16434];

export function dupeFeatures({ ownProd, proj, bestProj, sal, games, N, fee }) {
  const lx = Math.max(-14, Math.min(4, Math.log(Math.max(1e-12, N * ownProd)))), gap = Math.max(0, Math.min(40, bestProj - proj)), left = Math.max(0, Math.min(5, (50000 - sal) / 1000));
  const sm = games <= 4 ? 1 : 0, md = games >= 5 && games <= 7 ? 1 : 0, lg = Math.log1p(gap);
  return [1, lx, lx * lx, lg, left, sm, md, Math.log(Math.max(2, N)), Math.log(Math.max(0.25, fee || 20)), lx * sm, lx * md, lg * sm, lg * md];
}
export function expectedCopies(feat, coef = NBA_DUPE_COEF) { if (!coef) return 0; let z = 0; for (let k = 0; k < coef.length; k++) z += coef[k] * feat[k]; return Math.exp(Math.min(6, z)); }
// lineup ids -> features from a pool (P[id].own in %, proj, sal)
export function lineupDupeFeatures(lu, P, slate) {
  let op = 1, pj = 0, s = 0; for (const id of lu) { op *= Math.max(0.001, (P[id].own || 0) / 100); pj += P[id].proj || 0; s += P[id].sal || 0; }
  return dupeFeatures({ ownProd: op, proj: pj, bestProj: slate.bestProj, sal: s, games: slate.games, N: slate.N, fee: slate.fee });
}

// payout table (array by place, index 0 = 1st) -> helper for the mean of pay over places a..a+c split and averaged over a range
export function payoutSplitter(pay) {
  const n = pay.length, S = new Float64Array(n + 2), SS = new Float64Array(n + 2);
  for (let i = 1; i <= n + 1; i++) S[i] = S[i - 1] + (i <= n ? pay[i - 1] : 0);
  for (let i = 1; i <= n + 1; i++) SS[i] = SS[i - 1] + S[i];
  const Sx = i => i <= 0 ? 0 : i > n ? S[n] : S[i], SSx = i => i <= 0 ? 0 : i > n + 1 ? SS[n + 1] + (i - n - 1) * S[n] : SS[i];
  // mean over p in [a,b] of mean(pay[p..p+c]) for integer c
  const rangeInt = (a, b, c) => { if (b < a) return 0; return ((SSx(b + c) - SSx(a + c - 1)) - (SSx(b - 1) - SSx(a - 2))) / ((c + 1) * (b - a + 1)); };
  const range = (a, b, c) => { const lo = Math.floor(c), w = c - lo; return w > 0 ? (1 - w) * rangeInt(a, b, lo) + w * rangeInt(a, b, lo + 1) : rangeInt(a, b, lo); };
  return { n, range };
}
// row: { roi, win, t1, t10, cash } in %; returns ROI (%) with the expected copies splitting each finish's payout
export function dupeAdjROI(row, copies, split, N, fee) {
  if (!(copies > 0) || !(fee > 0)) return row.roi;
  const K1 = Math.max(1, Math.round(N * 0.01)), K10 = Math.max(K1, Math.round(N * 0.1)), paid = Math.max(1, split.n && countPaid(split, N));
  const w = row.win / 100, t1 = Math.max(w, row.t1 / 100), t10 = Math.max(t1, row.t10 / 100), cash = Math.max(t10, row.cash / 100);
  const segs = [[1, 1, w], [2, K1, t1 - w], [K1 + 1, K10, t10 - t1], [K10 + 1, Math.max(K10 + 1, paid), cash - t10]];
  let e0 = 0, e1 = 0; for (const [a, b, m] of segs) { if (!(m > 0) || b < a) continue; e0 += m * split.range(a, b, 0); e1 += m * split.range(a, b, copies); }
  return row.roi + 100 * (e1 - e0) / fee;
}
function countPaid(split, N) { if (split.paid != null) return split.paid; let lo = 1, hi = Math.min(N, split.n); while (lo < hi) { const m = (lo + hi + 1) >> 1; if (split.range(m, m, 0) > 0) lo = m; else hi = m - 1; } return split.paid = lo; }
