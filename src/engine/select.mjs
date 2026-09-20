// Selection scoring and post-contest grading of selection rules.

export function pctRank(arr) {
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
  const r = new Array(arr.length); idx.forEach((i, k) => { r[i] = arr.length > 1 ? k / (arr.length - 1) : 0.5; });
  return r;
}

// Fixed candidate rules. Each takes a feature row {proj, roi, cash, t10, avgRank, own, stkROI?, r*}.
export const RULES = {
  "Projection":                 f => f.proj,
  "Sim ROI":                    f => f.roi,
  "Sim cash %":                 f => f.cash,
  "Sim top 10 %":               f => f.t10,
  "Sim avg rank":               f => -f.avgRank,
  "Proj + ROI 50/50":           f => 0.5 * f.rProj + 0.5 * f.rROI,
  "Proj + ROI 70/30":           f => 0.7 * f.rProj + 0.3 * f.rROI,
  "Cash + ROI 50/50":           f => 0.5 * f.rCash + 0.5 * f.rROI,
  "ROI gated: top half proj":   f => f.rProj >= 0.5 ? f.roi : -1e9 + f.rProj,
  "ROI gated: top third proj":  f => f.rProj >= 0.667 ? f.roi : -1e9 + f.rProj,
  "Proj + leverage":            f => 0.7 * f.rProj + 0.3 * f.rLowOwn,
  // Gate sweep over 280 contests on the current engine. Realized top-decile ROI runs 39% ungated,
  // 39/40/40/39% from the 80% gate down to 40%, then falls away: 36% at a third, 35% at a quarter,
  // 31% at 15%. Rank correlation climbs the whole way (0.229 -> 0.297) and cash hits climb with it
  // (1.32 -> 1.40), which is the chalk trap - a tighter gate ranks finishes better and earns less.
  // So the gate has a wide plateau from roughly 40% to 80% and a cliff below 40%. The shipped 50%
  // sits in the middle of the plateau, and the differences across it are inside the run-to-run swing
  // on that metric (22.7 points), so there is nothing to gain by moving it and real money to lose by
  // tightening it. Kept as graded rules so the shape is re-checkable rather than rediscovered.
  "ROI gated: top 80%":         f => f.rProj >= 0.2 ? f.roi : -1e9 + f.rProj,
  "ROI gated: top 65%":         f => f.rProj >= 0.35 ? f.roi : -1e9 + f.rProj,
  "ROI gated: top 40%":         f => f.rProj >= 0.6 ? f.roi : -1e9 + f.rProj,
  "ROI gated: top 25%":         f => f.rProj >= 0.75 ? f.roi : -1e9 + f.rProj,
  "ROI gated: top 15%":         f => f.rProj >= 0.85 ? f.roi : -1e9 + f.rProj
};
export const DEFAULT_RULE = "ROI gated: top half proj";

// Attach percentile ranks so rules can mix scales.
// Takes ONE argument: the simulation rows, each carrying proj/roi/cash/t10/own. Called with the
// lineups instead - featurize(lineups, players, format, rows) reads plausibly and is wrong - every
// field comes back undefined, every rank ties, and rules silently score nothing. That cost two
// wrong conclusions before the giveaway showed up: a rank correlation of exactly 0.000 at three
// different draw counts, where real Monte Carlo noise would have moved. Hence the guard.
export function featurize(rows) {
  if (arguments.length !== 1) throw new TypeError(`featurize takes the simulation rows only, got ${arguments.length} arguments`);
  if (!Array.isArray(rows)) throw new TypeError("featurize needs an array of rows");
  if (rows.length && typeof rows[0].roi !== "number" && typeof rows[0].proj !== "number")
    throw new TypeError("featurize rows need numeric proj/roi - these look like lineups, not rows");
  const rProj = pctRank(rows.map(r => r.proj)), rROI = pctRank(rows.map(r => r.roi ?? 0)), rCash = pctRank(rows.map(r => r.cash)),
    rT10 = pctRank(rows.map(r => r.t10)), rLowOwn = pctRank(rows.map(r => -(r.own || 0)));
  return rows.map((r, i) => Object.assign({}, r, { rProj: rProj[i], rROI: rROI[i], rCash: rCash[i], rT10: rT10[i], rLowOwn: rLowOwn[i] }));
}

// Composite score used by the Select tab: ROI, but only for lineups above a projection floor.
export function selectScore(feats, gatePct) {
  const g = Math.max(0, Math.min(1, (gatePct ?? 50) / 100));
  return feats.map(f => f.rProj >= g ? f.roi : -1e9 + f.rProj);
}

export function spearman(a, b) {
  const rk = x => { const idx = x.map((v, i) => i).sort((i, j) => x[i] - x[j]); const r = new Array(x.length); let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && x[idx[j + 1]] === x[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg; i = j + 1; } return r; };
  const ra = rk(a), rb = rk(b), n = a.length, m = (n + 1) / 2; let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - m) * (rb[i] - m); saa += (ra[i] - m) ** 2; sbb += (rb[i] - m) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const topOf = (arr, k) => arr.map((v, i) => i).sort((a, b) => arr[b] - arr[a]).slice(0, k);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// Grade every rule on one finished contest. feats need actFP, actROI, finish; paid = places paid.
export function gradeRules(feats, paid, extraRules) {
  const rules = Object.assign({}, RULES, extraRules || {});
  const N = feats.length, actFP = feats.map(f => f.actFP), cashSet = new Set(feats.map((f, i) => f.finish <= paid ? i : -1).filter(i => i >= 0));
  const k10 = Math.max(3, Math.round(N * 0.1)), out = {};
  for (const name in rules) {
    const s = feats.map(rules[name]), top = topOf(s, N);
    out[name] = { spearman: spearman(s, actFP), cashHits: paid ? top.slice(0, paid).filter(i => cashSet.has(i)).length * N / (paid * paid) : 0,
      real10: mean(top.slice(0, k10).map(i => feats[i].actROI)), real3: mean(top.slice(0, 3).map(i => feats[i].actROI)) };
  }
  return out;
}
