// NBA classic ownership error: where Stokastic's pre-lock projected ownership runs over/under real %drafted (pooled
// over each slate's classic contests, entries-weighted). actual+1 = (projected+1) x exp(pre-lock features), log-link IRLS,
// cross-fit on alternate dates (fit odd -> score even and back), so every number below is held out. Feature groups are
// dropped backward while dropping costs under 0.003 held-out MAE; slate-size (bucket) terms are tried last and kept only
// if they lower held-out MAE overall and in their own bucket. Production coefficients: same terms, all dates.
//   node bench/fit-own-error-nba.mjs   -> data/reports/nba/own-error-nba.json + .txt
import fs from "node:fs";
import { loadRows, foldOf, ols, mean, bootCI, BUCKETS } from "./nba-player-rows.mjs";

const { rows: all, slates } = loadRows();
const R = all.filter(r => r.pown >= 1 || r.aown >= 1), fold = foldOf(R);
const POS = ["SG", "SF", "PF", "C"];
const lp = r => Math.log(r.pown + 1);
const GROUPS = {
  pos: r => POS.map(p => r.pos === p ? 1 : 0),
  salary: r => [r.sal / 1000],
  value: r => [r.value - 5],
  chalkRank: r => [Math.log(r.chalkRank + 1)],
  teamOwn: r => [Math.log(r.teamOwnOther + 1)],
  teamTotal: r => [r.teamProjRel - 1, r.oppProjRel - 1],
  price: r => [Math.max(-2, Math.min(2, r.priceChg))],
  missedPrev: r => [r.missedPrev ? 1 : 0],
  startedPrev: r => [r.startedPrev ? 1 : 0],
  minutes: r => [(r.l5Min ?? 20) / 36],
  form: r => [r.l5Dk != null ? (r.proj - r.l5Dk) / 10 : 0],
  chalkN: r => [r.chalkN / 10],
  games: r => [r.games / 10],
  field: r => [Math.log10(r.entries)],
};
const BUCKET = (bs, r) => bs.flatMap(b => r.bucket === b ? [1, lp(r)] : [0, 0]);
const CLAMP = [0.4, 2.0];
const BANDS = [3, 7, 12, 20, 30, 45];
const featFn = (groups, bucket) => r => [1, lp(r), lp(r) ** 2, ...BANDS.map(b => r.pown >= b ? 1 : 0), ...groups.flatMap(g => GROUPS[g](r)), ...(bucket ? BUCKET(bucket, r) : [])];
// Poisson-style log-link fit (IRLS) with offset ln(pown+1): the multiplier is fit on the level of ownership, so it is mean-
// unbiased (an OLS on log ratios fits the geometric mean and misses chalk low)
function fit(X, rows) {
  let b = new Array(X[0].length).fill(0);
  for (let it = 0; it < 25; it++) {
    const mu = X.map((x, i) => (rows[i].pown + 1) * Math.exp(Math.max(-3, Math.min(3, x.reduce((s, v, k) => s + v * b[k], 0)))));
    const z = X.map((x, i) => x.reduce((s, v, k) => s + v * b[k], 0) + (rows[i].aown + 1 - mu[i]) / mu[i]);
    const nb = ols(X, z, 1e-4, mu), d = Math.max(...nb.map((v, k) => Math.abs(v - b[k]))); b = nb; if (d < 1e-6) break;
  }
  return b;
}
const apply = (b, x, r) => { const m = Math.min(CLAMP[1], Math.max(CLAMP[0], Math.exp(x.reduce((s, v, i) => s + v * b[i], 0)))); return Math.max(0, (r.pown + 1) * m - 1); };
// renormalize each slate to the projected total (ownership sums to 800%)
function renorm(rows, pred) {
  const t = new Map(); rows.forEach((r, i) => { const a = t.get(r.slate) || t.set(r.slate, [0, 0]).get(r.slate); a[0] += r.pown; a[1] += pred[i]; });
  return pred.map((p, i) => { const a = t.get(rows[i].slate); return a[1] > 0 ? p * a[0] / a[1] : p; });
}
// cross-fit held-out predictions; per-bucket separate fits when split
function crossPred(groups, { bucket = false, split = false, rn = false } = {}) {
  const F = featFn(groups, bucket), X = R.map(F), out = new Array(R.length);
  for (const k of [0, 1]) for (const b of split ? BUCKETS : [null]) {
    const tr = [], te = []; R.forEach((r, i) => { if (b && r.bucket !== b) return; (fold(r) === k ? te : tr).push(i); });
    const beta = fit(tr.map(i => X[i]), tr.map(i => R[i]));
    for (const i of te) out[i] = apply(beta, X[i], R[i]);
  }
  return rn ? renorm(R, out) : out;
}
const mae = (I, pred) => mean(I.map(i => Math.abs(R[i].aown - pred[i]))), bias = (I, pred) => mean(I.map(i => pred[i] - R[i].aown));
const idx = f => R.map((r, i) => f(r) ? i : -1).filter(i => i >= 0);
const ALL = idx(() => true), CH = idx(r => r.pown >= 15), raw = R.map(r => r.pown);
// bucket curve baseline (held out): ratio of means in projected-own bands
function curvePred() {
  const B = [0, 3, 7, 12, 20, 30, 45, 101], band = o => B.findIndex((x, i) => o >= x && o < B[i + 1]), out = new Array(R.length);
  for (const k of [0, 1]) { const s = B.map(() => [0, 0]); R.forEach(r => { if (fold(r) !== k) { const b = s[band(r.pown)]; b[0] += r.aown; b[1] += r.pown; } }); R.forEach((r, i) => { if (fold(r) === k) { const b = s[band(r.pown)]; out[i] = r.pown * (b[1] ? b[0] / b[1] : 1); } }); }
  return out;
}
// backward elimination on held-out MAE (all rows)
let groups = Object.keys(GROUPS), cur = mae(ALL, crossPred(groups));
const elim = [{ step: "all groups", mae: +cur.toFixed(4) }];
for (;;) {
  let best = null;
  for (const g of groups) { const m = mae(ALL, crossPred(groups.filter(x => x !== g))); if (m <= cur + 0.003 && (!best || m < best.m)) best = { g, m }; }
  if (!best) break; groups = groups.filter(x => x !== best.g); cur = best.m; elim.push({ step: "drop " + best.g, mae: +cur.toFixed(4) });
}
// marginal value of each kept group (held-out MAE when it is removed)
const keepCost = Object.fromEntries(groups.map(g => [g, +(mae(ALL, crossPred(groups.filter(x => x !== g))) - cur).toFixed(4)]));
const V = { raw, curve: curvePred(), model: crossPred(groups), "model+renorm": crossPred(groups, { rn: true }), "model+small terms": crossPred(groups, { bucket: ["small"] }), "model+large terms": crossPred(groups, { bucket: ["large"] }), "model+small+large terms": crossPred(groups, { bucket: ["small", "large"] }), "per-bucket fits": crossPred(groups, { split: true }) };
const table = sub => Object.fromEntries(Object.entries(V).map(([k, p]) => [k, { mae: +mae(sub, p).toFixed(3), bias: +bias(sub, p).toFixed(3) }]));
const cut = (name, f) => { const I = idx(f), C = I.filter(i => R[i].pown >= 15); return { name, slates: new Set(I.map(i => R[i].slate)).size, n: I.length, chalkN: C.length, all: table(I), chalk15: table(C) }; };
const cuts = [cut("overall", () => true), ...BUCKETS.map(b => cut(b, r => r.bucket === b))];
for (const c of cuts) c.thin = c.slates < 30;
// choose: bucket variants only if better overall and in every bucket than the plain model
// renorm: kept only if better on all rows and on chalk in every bucket. Bucket terms: kept only if they lower MAE (all and
// chalk) overall and in each bucket they name, and cost no other bucket more than 0.01
const better = (v, base) => cuts.every(c => c.all[v].mae < c.all[base].mae && c.chalk15[v].mae < c.chalk15[base].mae);
const bucketOk = (v, own) => cuts.every(c => (c.name === "overall" || own.includes(c.name)) ? c.all[v].mae < c.all.model.mae && c.chalk15[v].mae < c.chalk15.model.mae : c.all[v].mae < c.all.model.mae + 0.01 && c.chalk15[v].mae < c.chalk15.model.mae + 0.01);
const BV = { "model+small+large terms": ["small", "large"], "model+small terms": ["small"], "model+large terms": ["large"], "per-bucket fits": BUCKETS };
let pick = Object.keys(BV).find(v => bucketOk(v, BV[v])) || (better("model+renorm", "model") ? "model+renorm" : "model");
const ci = (v, I) => bootCI(I.map(i => ({ slate: R[i].slate, d: Math.abs(R[i].aown - V[v][i]) - Math.abs(R[i].aown - raw[i]) })), r => r.d).map(x => +x.toFixed(3));
for (const c of cuts) { const I = c.name === "overall" ? ALL : idx(r => r.bucket === c.name); c.ciVsRaw = { all: ci(pick, I), chalk15: ci(pick, I.filter(i => R[i].pown >= 15)) }; }
const usesBucket = /terms$/.test(pick) ? BV[pick] : null, usesSplit = pick === "per-bucket fits", rn = pick === "model+renorm";
const F = featFn(groups, usesBucket), NAMES = ["const", "ln(pown+1)", "ln(pown+1)^2", ...BANDS.map(b => "pown>=" + b), ...groups.flatMap(g => GROUPS[g](R[0]).map((_, i, a) => a.length > 1 ? `${g}${i}` : g)), ...(usesBucket ? usesBucket.flatMap(b => [b, b + "*lp"]) : [])];
const prodBeta = usesSplit ? Object.fromEntries(BUCKETS.map(b => { const I = idx(r => r.bucket === b); return [b, fit(I.map(i => F(R[i])), I.map(i => R[i])).map(v => +v.toFixed(5))]; }))
  : fit(R.map(F), R).map(v => +v.toFixed(5));
const out = { built: new Date().toISOString(), slates, rows: R.length, rowFilter: "projected or actual own >= 1%", target: "aown+1 = (pown+1)*exp(x.b), Poisson IRLS, own in %", folds: "alternate dates", clamp: CLAMP,
  pick, renorm: rn, groups, featureNames: NAMES, featureMeans: F(R[0]).map((_, k) => +mean(R.map(r => F(r)[k])).toFixed(4)), keepCost, elimination: elim, prodBeta, cuts };
fs.mkdirSync("data/reports/nba", { recursive: true });
fs.writeFileSync("data/reports/nba/own-error-nba.json", JSON.stringify(out, null, 1));
const L = [`NBA classic ownership error, ${slates} slates (${R.length} player-slates with own >= 1%), held out on alternate dates`, `kept groups: ${groups.join(", ")} | pick: ${pick}`, `marginal held-out MAE cost of dropping each kept group: ${JSON.stringify(keepCost)}`, ""];
for (const c of cuts) {
  L.push(`${c.name}${c.thin ? " (THIN)" : ""}: ${c.slates} slates, ${c.n} rows, ${c.chalkN} chalk 15%+ | ${pick} - raw MAE diff 95% CI all [${c.ciVsRaw.all}] chalk [${c.ciVsRaw.chalk15}]`);
  L.push(`  ${"variant".padEnd(24)} ${"MAE all".padStart(8)} ${"bias".padStart(7)} ${"MAE 15%+".padStart(9)} ${"bias".padStart(7)}`);
  for (const v of Object.keys(V)) L.push(`  ${v.padEnd(24)} ${c.all[v].mae.toFixed(3).padStart(8)} ${c.all[v].bias.toFixed(3).padStart(7)} ${c.chalk15[v].mae.toFixed(3).padStart(9)} ${c.chalk15[v].bias.toFixed(3).padStart(7)}`);
}
L.push("", "production coefficients (all dates):"); if (!usesSplit) NAMES.forEach((n, i) => L.push(`  ${n.padEnd(16)} ${prodBeta[i] > 0 ? "+" : ""}${prodBeta[i]}`)); else L.push(JSON.stringify(prodBeta));
fs.writeFileSync("data/reports/nba/own-error-nba.txt", L.join("\n") + "\n");
console.log(L.join("\n"));
