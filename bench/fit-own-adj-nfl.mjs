// NFL classic ownership inputs: where is the field heavier or lighter than projected, after the own-error model
// (server/sources.mjs ownModel)? Per real classic contest, actual vs projected ownership by position, salary tier,
// projected-ownership bucket and contest tier (high = $100+ and <=1,000 entries, low = >10,000, marquee = the rest).
// Fits two small corrections on top of the model on 2025 and checks them on 2026: position x salary-tier multipliers,
// and a chalk curve (multiplier by modelled-ownership bucket, per contest tier). Every variant is renormalised to the
// contest's 900% total before scoring. Per-contest MAE and the chalk error (mean abs error over the 10 highest
// projected players); t is clustered by slate date (contests on one date share player outcomes).
//   node bench/fit-own-adj-nfl.mjs [--split=2026-03-01] [--minfee=1]   -> data/reports/own-adj-nfl.json
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
import { ownModel } from "../server/sources.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SPLIT = arg("split", "2026-03-01"), MINFEE = +arg("minfee", 1);
const POS = ["QB", "RB", "WR", "TE", "DST"], SAL = s => s < 4500 ? "lo" : s < 6500 ? "mid" : "hi";
const BUCKETS = [0, 2, 5, 10, 20, 30, 45], bucketOf = o => { let b = 0; for (let i = 0; i < BUCKETS.length; i++) if (o >= BUCKETS[i]) b = i; return b; };
const tierOf = c => c.fee >= 100 && c.entries <= 1000 ? "high" : c.entries > 10000 ? "low" : "marquee";
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN, sd = a => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / Math.max(1, a.length - 1));
const model = ownModel("classic");

// contests: one row per player with projected (vendor) own, model own and actual own
const contests = [];
for (const file of listPost("nfl")) {
  const j = readPost(file), c = j.contest || {};
  if (/showdown/i.test(c.type || c.name || "") || !(c.entries >= 100) || !(c.fee >= MINFEE) || !j.players || j.players.length < 40) continue;
  const rows = j.players.filter(p => POS.includes(String(p.pos).split("/")[0]) && p.sal > 0).map(p => ({ name: p.name, pos: String(p.pos).split("/")[0], team: p.team, sal: p.sal, proj: p.proj, vown: 100 * (p.pown || 0), act: 100 * (p.aown || 0) }));
  if (rows.length < 40) continue;
  model(rows, { n: c.entries, fee: c.fee, chalkCurve: false });
  const wired = rows.map(r => ({ ...r })); model(wired, { n: c.entries, fee: c.fee });
  contests.push({ key: c.key, date: c.date, fee: c.fee, N: c.entries, tier: tierOf(c), test: c.date >= SPLIT, P: rows.map((r, i) => ({ pos: r.pos, sal: SAL(r.sal), v: r.vown, m: r.labOwn ?? r.vown, w: wired[i].labOwn ?? wired[i].vown, a: r.act })) });
}
const train = contests.filter(c => !c.test), test = contests.filter(c => c.test);

// renormalise a vector to the contest total (900 for classic) so a correction can't win by inflating everyone
const norm = (x, tot = 900) => { const s = x.reduce((a, b) => a + b, 0) || 1; return x.map(v => v * tot / s); };

// multiplier tables, fit as the geometric mean over slate dates of sum(actual)/sum(base) per cell; t on the log ratios
function fitCells(cs, cellOf, base) {
  const byDate = {};
  for (const c of cs) { const b = norm(c.P.map(base)); c.P.forEach((p, i) => { const k = cellOf(p, c, b[i]); if (k == null) return; const g = byDate[c.date] || (byDate[c.date] = {}), q = g[k] || (g[k] = { p: 0, a: 0 }); q.p += b[i]; q.a += p.a; }); }
  const keys = new Set(Object.values(byDate).flatMap(g => Object.keys(g))), out = {};
  for (const k of keys) {
    const lr = Object.values(byDate).map(g => g[k]).filter(q => q && q.p > 3).map(q => Math.log(Math.max(0.05, q.a / q.p)));
    if (lr.length < 4) continue;
    const m = mean(lr), se = sd(lr) / Math.sqrt(lr.length);
    out[k] = { mult: +Math.exp(m).toFixed(3), t: +(m / se).toFixed(2), dates: lr.length };
  }
  return out;
}
// shrink: keep a cell only when its train t is strong; halve the log effect otherwise toward 1
const shrink = (tab, tMin = 2.5) => Object.fromEntries(Object.entries(tab).map(([k, v]) => [k, Math.abs(v.t) >= tMin ? v.mult : +Math.exp(Math.log(v.mult) * Math.min(1, Math.abs(v.t) / tMin) * 0.5).toFixed(3)]));

function score(cs, f) {
  const per = [];
  for (const c of cs) {
    const x = norm(c.P.map((p, i) => f(p, c, i))), act = c.P.map(p => p.a);
    let s = 0, k = 0; c.P.forEach((p, i) => { if (x[i] < 0.5 && act[i] < 0.5) return; s += Math.abs(x[i] - act[i]); k++; });
    const top = c.P.map((p, i) => i).sort((a, b) => x[b] - x[a]).slice(0, 10), chalk = mean(top.map(i => Math.abs(x[i] - act[i]))), bias = mean(top.map(i => act[i] - x[i]));
    per.push({ date: c.date, tier: c.tier, mae: s / Math.max(1, k), chalk, bias });
  }
  return per;
}
function compare(a, b, field) {
  const byDate = {}; a.forEach((r, i) => { (byDate[r.date] = byDate[r.date] || []).push(b[i][field] - r[field]); });
  const d = Object.values(byDate).map(mean), t = mean(d) / (sd(d) / Math.sqrt(d.length));
  return { a: +mean(a.map(r => r[field])).toFixed(3), b: +mean(b.map(r => r[field])).toFixed(3), diff: +mean(d).toFixed(3), tDate: +t.toFixed(2), dates: d.length, betterDates: d.filter(x => x < 0).length };
}

// fits on 2025 (train), applied on top of the model own
const baseM = p => p.m;
const posSal = fitCells(train, p => p.pos + "|" + p.sal, baseM), posSalS = shrink(posSal);
const chalkByTier = fitCells(train, (p, c, b) => c.tier + "|" + bucketOf(b), baseM), chalkS = shrink(chalkByTier);
const chalkAll = fitCells(train, (p, c, b) => "all|" + bucketOf(b), baseM), chalkAllS = shrink(chalkAll);
const vendorPosSal = fitCells(train, p => p.pos + "|" + p.sal, p => p.v), vendorPosSalS = shrink(vendorPosSal);

const variants = {
  vendor: (p) => p.v,
  model: (p) => p.m,
  vendorPosSal: (p) => p.v * (vendorPosSalS[p.pos + "|" + p.sal] ?? 1),
  modelPosSal: (p) => p.m * (posSalS[p.pos + "|" + p.sal] ?? 1),
  modelChalkAll: (p, c) => { const b = bucketOf(p.m * 900 / (c._sm || (c._sm = c.P.reduce((s, q) => s + q.m, 0)))); return p.m * (chalkAllS["all|" + b] ?? 1); },
  modelChalkTier: (p, c) => { const b = bucketOf(p.m * 900 / (c._sm || (c._sm = c.P.reduce((s, q) => s + q.m, 0)))); return p.m * (chalkS[c.tier + "|" + b] ?? 1); },
  wired: (p) => p.w, // the shipped ownModel (model + CLASSIC_CHALK); must match modelChalkAll
  modelBoth: (p, c) => { const b = bucketOf(p.m * 900 / (c._sm || (c._sm = c.P.reduce((s, q) => s + q.m, 0)))); return p.m * (posSalS[p.pos + "|" + p.sal] ?? 1) * (chalkS[c.tier + "|" + b] ?? 1); },
};
const out = { split: SPLIT, contests: { train: train.length, test: test.length, trainDates: new Set(train.map(c => c.date)).size, testDates: new Set(test.map(c => c.date)).size },
  fits: { posSal, chalkByTier, chalkAll, vendorPosSal }, applied: { posSal: posSalS, chalkByTier: chalkS, chalkAll: chalkAllS }, results: {} };
for (const [name, set] of [["test2026", test], ["train2025", train]]) {
  const sc = Object.fromEntries(Object.entries(variants).map(([k, f]) => [k, score(set, f)]));
  out.results[name] = {};
  for (const k of Object.keys(variants)) out.results[name][k] = { mae: +mean(sc[k].map(r => r.mae)).toFixed(3), chalk: +mean(sc[k].map(r => r.chalk)).toFixed(3), chalkBias: +mean(sc[k].map(r => r.bias)).toFixed(3),
    byTier: Object.fromEntries(["high", "marquee", "low"].map(t => { const r = sc[k].filter(x => x.tier === t); return [t, { n: r.length, mae: +mean(r.map(x => x.mae)).toFixed(3), chalk: +mean(r.map(x => x.chalk)).toFixed(3), bias: +mean(r.map(x => x.bias)).toFixed(3) }]; })) };
  out.results[name].wiredVsVendorByTier = Object.fromEntries(["high", "marquee", "low"].map(t => { const ix = sc.vendor.map((r, i) => r.tier === t ? i : -1).filter(i => i >= 0), pick = (k) => ix.map(i => sc[k][i]); return [t, { mae: compare(pick("vendor"), pick("wired"), "mae"), chalk: compare(pick("vendor"), pick("wired"), "chalk") }]; }));
  out.results[name].vsModel = Object.fromEntries(Object.keys(variants).filter(k => k !== "model").map(k => [k, { mae: compare(sc.model, sc[k], "mae"), chalk: compare(sc.model, sc[k], "chalk") }]));
}
// descriptive: actual/projected by position, salary tier, bucket and tier (vendor and model), all seasons
const desc = {};
for (const [lab, base] of [["vendor", p => p.v], ["model", baseM]]) desc[lab] = {
  byPos: fitCells(contests, p => p.pos, base), bySal: fitCells(contests, p => p.sal, base),
  byBucket: fitCells(contests, (p, c, b) => "b" + BUCKETS[bucketOf(b)], base), byTierBucket: fitCells(contests, (p, c, b) => c.tier + "|b" + BUCKETS[bucketOf(b)], base) };
out.describe = desc;
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/own-adj-nfl.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ contests: out.contests }, null));
for (const name of ["test2026", "train2025"]) { console.log("\n" + name); for (const [k, v] of Object.entries(out.results[name])) if (k !== "vsModel" && k !== "wiredVsVendorByTier") console.log(k.padEnd(15), "MAE", v.mae, "chalk", v.chalk, "bias", v.chalkBias, "|", Object.entries(v.byTier).map(([t, x]) => `${t} n${x.n} ${x.mae}/${x.chalk}/${x.bias}`).join("  "));
  for (const [t, v] of Object.entries(out.results[name].wiredVsVendorByTier)) console.log("  wired vs vendor", t.padEnd(8), "MAE", JSON.stringify(v.mae), "chalk", JSON.stringify(v.chalk));
  for (const [k, v] of Object.entries(out.results[name].vsModel)) console.log("  vs model", k.padEnd(14), "MAE", JSON.stringify(v.mae), "chalk", JSON.stringify(v.chalk)); }
console.log("\nposSal fit", JSON.stringify(posSal));
console.log("chalk by tier fit", JSON.stringify(chalkByTier));
console.log("describe vendor byPos", JSON.stringify(desc.vendor.byPos), "bySal", JSON.stringify(desc.vendor.bySal));
console.log("describe model byPos", JSON.stringify(desc.model.byPos), "bySal", JSON.stringify(desc.model.bySal));
console.log("describe model byTierBucket", JSON.stringify(desc.model.byTierBucket));
