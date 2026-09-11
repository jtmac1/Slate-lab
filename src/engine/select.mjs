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
  "Proj + leverage":            f => 0.7 * f.rProj + 0.3 * f.rLowOwn
};
export const DEFAULT_RULE = "ROI gated: top half proj";

// Attach percentile ranks so rules can mix scales.
export function featurize(rows) {
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
