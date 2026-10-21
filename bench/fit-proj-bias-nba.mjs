// NBA classic projection bias: where Stokastic's pre-lock projection runs high/low vs actual DK points (ESPN box scores,
// data/nba-pbp; active-list DNPs count as 0, players missing from a cached box are left out). One row per player per
// slate, proj >= 5. Residual act - proj fit by OLS on pre-lock features, cross-fit on alternate dates, so every number is
// held out. Groups dropped backward while dropping costs under 0.005 held-out RMSE (the sim uses proj as a mean, so
// squared error / bias is the target; MAE reported too). Baselines: raw, a projTilt-style shrink proj*(proj/30)^e
// (model.mjs PROJ_TILT form, NBA has none set), and a projection-band ratio curve. Bucket terms kept only if they hold out.
//   node bench/fit-proj-bias-nba.mjs   -> data/reports/nba/proj-bias-nba.json + .txt
import fs from "node:fs";
import { loadRows, foldOf, ols, mean, bootCI, BUCKETS } from "./nba-player-rows.mjs";

const { rows: all, slates } = loadRows();
const R = all.filter(r => r.proj >= 5 && r.act != null), fold = foldOf(R);
const POS = ["SG", "SF", "PF", "C"], q = r => r.proj / 10;
const GROUPS = {
  pos: r => POS.map(p => r.pos === p ? 1 : 0),
  salary: r => [r.sal / 1000],
  value: r => [r.value - 5],
  own: r => [Math.log(r.pown + 1)],
  chalkRank: r => [Math.log(r.chalkRank + 1)],
  teamOwn: r => [Math.log(r.teamOwnOther + 1)],
  teamTotal: r => [r.teamProjRel - 1, r.oppProjRel - 1],
  price: r => [Math.max(-2, Math.min(2, r.priceChg))],
  missedPrev: r => [r.missedPrev ? 1 : 0],
  startedPrev: r => [r.startedPrev ? 1 : 0],
  minutes: r => [(r.l5Min ?? 20) / 36, r.l5Min == null ? 1 : 0],
  form: r => [r.l5Dk != null ? (r.proj - r.l5Dk) / 10 : 0],
  newbie: r => [r.gp < 5 ? 1 : 0],
  chalkN: r => [r.chalkN / 10],
  games: r => [r.games / 10],
};
const BUCKET = (bs, r) => bs.flatMap(b => r.bucket === b ? [1, q(r)] : [0, 0]);
const featFn = (groups, bucket) => r => [1, q(r), q(r) ** 2, ...groups.flatMap(g => GROUPS[g](r)), ...(bucket ? BUCKET(bucket, r) : [])];
const y = r => r.act - r.proj;
function crossPred(groups, { bucket = null, split = false } = {}) {
  const F = featFn(groups, bucket), X = R.map(F), out = new Array(R.length);
  for (const k of [0, 1]) for (const b of split ? BUCKETS : [null]) {
    const tr = [], te = []; R.forEach((r, i) => { if (b && r.bucket !== b) return; (fold(r) === k ? te : tr).push(i); });
    const beta = ols(tr.map(i => X[i]), tr.map(i => y(R[i])), 1e-4);
    for (const i of te) out[i] = Math.max(0, R[i].proj + X[i].reduce((s, v, j) => s + v * beta[j], 0));
  }
  return out;
}
const idx = f => R.map((r, i) => f(r) ? i : -1).filter(i => i >= 0), ALL = idx(() => true);
const mae = (I, p) => mean(I.map(i => Math.abs(R[i].act - p[i]))), rmse = (I, p) => Math.sqrt(mean(I.map(i => (R[i].act - p[i]) ** 2))), bias = (I, p) => mean(I.map(i => p[i] - R[i].act));
// projTilt shrink, exponent fit per fold on a grid (least squares)
function tiltPred() {
  const out = new Array(R.length), E = []; for (let e = -0.3; e <= 0.3001; e += 0.01) E.push(+e.toFixed(2)); const used = [];
  for (const k of [0, 1]) { const tr = idx(r => fold(r) !== k), f = e => r => r.proj * Math.pow(Math.max(3, r.proj) / 30, e);
    const best = E.map(e => [e, mean(tr.map(i => (R[i].act - f(e)(R[i])) ** 2))]).sort((a, b) => a[1] - b[1])[0][0]; used.push(best);
    R.forEach((r, i) => { if (fold(r) === k) out[i] = f(best)(r); }); }
  tiltPred.e = used; return out;
}
function curvePred() {
  const B = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 999], band = p => B.findIndex((x, i) => p >= x && p < B[i + 1]), out = new Array(R.length);
  for (const k of [0, 1]) { const s = B.map(() => [0, 0]); R.forEach(r => { if (fold(r) !== k) { const b = s[band(r.proj)]; b[0] += r.act; b[1] += r.proj; } }); R.forEach((r, i) => { if (fold(r) === k) { const b = s[band(r.proj)]; out[i] = r.proj * (b[1] ? b[0] / b[1] : 1); } }); }
  return out;
}
let groups = Object.keys(GROUPS), cur = rmse(ALL, crossPred(groups));
const elim = [{ step: "all groups", rmse: +cur.toFixed(4) }];
for (;;) {
  let best = null;
  for (const g of groups) { const m = rmse(ALL, crossPred(groups.filter(x => x !== g))); if (m <= cur + 0.005 && (!best || m < best.m)) best = { g, m }; }
  if (!best) break; groups = groups.filter(x => x !== best.g); cur = best.m; elim.push({ step: "drop " + best.g, rmse: +cur.toFixed(4) });
}
const keepCost = Object.fromEntries(groups.map(g => [g, +(rmse(ALL, crossPred(groups.filter(x => x !== g))) - cur).toFixed(4)]));
const raw = R.map(r => r.proj);
const V = { raw, "projTilt shrink": tiltPred(), "band curve": curvePred(), "proj-only (q,q^2)": crossPred([]), model: crossPred(groups),
  "model+small terms": crossPred(groups, { bucket: ["small"] }), "model+large terms": crossPred(groups, { bucket: ["large"] }), "model+small+large terms": crossPred(groups, { bucket: ["small", "large"] }), "per-bucket fits": crossPred(groups, { split: true }) };
const table = I => Object.fromEntries(Object.entries(V).map(([k, p]) => [k, { mae: +mae(I, p).toFixed(3), rmse: +rmse(I, p).toFixed(3), bias: +bias(I, p).toFixed(3) }]));
const PB = [[5, 15], [15, 25], [25, 35], [35, 45], [45, 999]];
const cut = (name, f) => { const I = idx(f); return { name, slates: new Set(I.map(i => R[i].slate)).size, n: I.length, dnp: I.filter(i => R[i].dnp).length, all: table(I),
  byProj: PB.map(([lo, hi]) => { const J = I.filter(i => R[i].proj >= lo && R[i].proj < hi); return { band: `${lo}-${hi === 999 ? "+" : hi}`, n: J.length, rawBias: +bias(J, raw).toFixed(2), modelBias: +bias(J, V.model).toFixed(2), rawMae: +mae(J, raw).toFixed(2), modelMae: +mae(J, V.model).toFixed(2) }; }) }; };
const cuts = [cut("overall", () => true), ...BUCKETS.map(b => cut(b, r => r.bucket === b))];
for (const c of cuts) c.thin = c.slates < 30;
const BV = { "model+small+large terms": ["small", "large"], "model+small terms": ["small"], "model+large terms": ["large"], "per-bucket fits": BUCKETS };
const bucketOk = (v, own) => cuts.every(c => (c.name === "overall" || own.includes(c.name)) ? c.all[v].rmse < c.all.model.rmse && c.all[v].mae < c.all.model.mae : c.all[v].rmse < c.all.model.rmse + 0.01);
// the model is kept only if it beats raw on RMSE and MAE overall and in every bucket
const modelOk = cuts.every(c => c.all.model.rmse < c.all.raw.rmse && c.all.model.mae < c.all.raw.mae);
const pick = !modelOk ? "raw" : Object.keys(BV).find(v => bucketOk(v, BV[v])) || "model";
const ci = (v, I, f) => bootCI(I.map(i => ({ slate: R[i].slate, d: f(i, V[v]) - f(i, raw) })), r => r.d).map(x => +x.toFixed(3));
const ae = (i, p) => Math.abs(R[i].act - p[i]), se = (i, p) => (R[i].act - p[i]) ** 2;
for (const c of cuts) { const I = c.name === "overall" ? ALL : idx(r => r.bucket === c.name); c.ciVsRaw = { mae: ci("model", I, ae), mse: ci("model", I, se) }; }
const usesBucket = /terms$/.test(pick) ? BV[pick] : null, F = featFn(groups, usesBucket);
const NAMES = ["const", "proj/10", "(proj/10)^2", ...groups.flatMap(g => GROUPS[g](R[0]).map((_, i, a) => a.length > 1 ? `${g}${i}` : g)), ...(usesBucket ? usesBucket.flatMap(b => [b, b + "*proj/10"]) : [])];
const prodBeta = pick === "per-bucket fits" ? Object.fromEntries(BUCKETS.map(b => { const I = idx(r => r.bucket === b); return [b, ols(I.map(i => F(R[i])), I.map(i => y(R[i])), 1e-4).map(v => +v.toFixed(5))]; }))
  : ols(R.map(F), R.map(y), 1e-4).map(v => +v.toFixed(5));
const out = { built: new Date().toISOString(), slates, rows: R.length, rowFilter: "proj >= 5, box score found (DNP = 0)", target: "act - proj (DK points)", folds: "alternate dates", tiltExponentByFold: tiltPred.e,
  pick, groups, featureNames: NAMES, keepCost, elimination: elim, prodBeta, cuts };
fs.mkdirSync("data/reports/nba", { recursive: true });
fs.writeFileSync("data/reports/nba/proj-bias-nba.json", JSON.stringify(out, null, 1));
const L = [`NBA classic projection bias, ${slates} slates (${R.length} player-slates, proj >= 5), held out on alternate dates`, `kept groups: ${groups.join(", ")} | pick: ${pick} | projTilt exponent fit per fold: ${tiltPred.e}`, `marginal held-out RMSE cost of dropping each kept group: ${JSON.stringify(keepCost)}`, ""];
for (const c of cuts) {
  L.push(`${c.name}${c.thin ? " (THIN)" : ""}: ${c.slates} slates, ${c.n} rows (${c.dnp} DNP) | model - raw 95% CI: MAE [${c.ciVsRaw.mae}] MSE [${c.ciVsRaw.mse}]`);
  L.push(`  ${"variant".padEnd(24)} ${"MAE".padStart(7)} ${"RMSE".padStart(7)} ${"bias".padStart(7)}`);
  for (const v of Object.keys(V)) L.push(`  ${v.padEnd(24)} ${c.all[v].mae.toFixed(3).padStart(7)} ${c.all[v].rmse.toFixed(3).padStart(7)} ${c.all[v].bias.toFixed(3).padStart(7)}`);
  L.push(`  by proj band (bias = pred - act): ` + c.byProj.map(b => `${b.band} n${b.n} raw ${b.rawBias} model ${b.modelBias}`).join(" | "));
}
L.push("", "production coefficients (all dates), additive points:"); if (pick !== "per-bucket fits") NAMES.forEach((n, i) => L.push(`  ${n.padEnd(16)} ${prodBeta[i] > 0 ? "+" : ""}${prodBeta[i]}`)); else L.push(JSON.stringify(prodBeta));
fs.writeFileSync("data/reports/nba/proj-bias-nba.txt", L.join("\n") + "\n");
console.log(L.join("\n"));
