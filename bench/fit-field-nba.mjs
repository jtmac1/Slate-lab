// Does the field generator reproduce real NBA classic fields? For each pulled 2025-26 NBA classic contest, generate a
// field of the same size from the contest's pre-lock pool (projection, salary, Stokastic projected ownership) and compare
// it with the real field: exposure by projected-ownership bucket (chalk), duplicate share, salary used, summed projected
// ownership, projected points (mean and 99th pct), team / game concentration, stars and punts per lineup.
//   node bench/fit-field-nba.mjs [--arch=base,c12] [--half=0|1] [--max=400] [--out=data/reports/nba/field-nba.json]
// --half: 0 = even-indexed contests (fit), 1 = odd (hold-out), by date order. Without it every contest is used.
import fs from "node:fs";
import path from "node:path";
import { loadPulled } from "./grade-all.mjs";
import { listPost, readPost } from "./post-store.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const HALF = arg("half") === "" ? null : +arg("half"), MAX = +arg("max") || 400, OUT = arg("out") || "data/reports/nba/field-nba.json";
const BASE = { conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 };
// candidate generator settings (all NBA-only); base = the old default, s497 = NBA_CL_FIELD (adopted 2026-10-21)
const ARCH = {
  base: {}, c13: { conc: 1.3 }, c15: { conc: 1.5 }, s495: { minSal: 49500 }, s497: { minSal: 49700 }, s498: { minSal: 49800 }, s499: { minSal: 49900 },
  c13s497: { conc: 1.3, minSal: 49700 }, c15s497: { conc: 1.5, minSal: 49700 }, c15s497d10: { conc: 1.5, minSal: 49700, dupeFloor: 0.10 }
};
const USE = (arg("arch") || "base,s497,c13,c15s497,c15s497d10").split(",").filter(a => ARCH[a]);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sizeOf = n => n < 300 ? "<300" : n < 1500 ? "300-1.5K" : "1.5K+", gamesOf = g => g <= 4 ? "g2-4" : g <= 7 ? "g5-7" : "g8+";
const BK = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 45], [45, 101]];

// one field's metrics; exposure in % of lineups
function metrics(L, P, f) {
  const N = L.length, sig = new Map(); for (const l of L) { const k = sigOf(l, f); sig.set(k, (sig.get(k) || 0) + 1); }
  let inDup = 0; for (const v of sig.values()) if (v > 1) inDup += v;
  const expo = new Float64Array(P.length); for (const l of L) for (const id of l) expo[id] += 100 / N;
  const sal = [], own = [], proj = [], maxT = [], maxG = [], games = [], stars = [], punts = [];
  for (const l of L) {
    let s = 0, o = 0, pj = 0, st = 0, pu = 0; const tc = {}, gc = {};
    for (const id of l) { const p = P[id]; s += p.sal; o += p.own; pj += p.proj; tc[p.team] = (tc[p.team] || 0) + 1; gc[p.gi] = (gc[p.gi] || 0) + 1; if (p.sal >= 9000) st++; if (p.sal <= 4000) pu++; }
    sal.push(s); own.push(o); proj.push(pj); maxT.push(Math.max(...Object.values(tc))); maxG.push(Math.max(...Object.values(gc))); games.push(Object.keys(gc).length); stars.push(st); punts.push(pu);
  }
  const sp = proj.slice().sort((a, b) => a - b), share = (a, fn) => 100 * a.filter(fn).length / N;
  return { N, dup: 100 * (N - sig.size) / N, inDup: 100 * inDup / N, sal: mean(sal), sal50: share(sal, x => x === 50000), salLo: share(sal, x => x < 49500), own: mean(own), proj: mean(proj), p99: sp[Math.min(N - 1, Math.floor(0.99 * N))],
    maxT: mean(maxT), t4: share(maxT, x => x >= 4), t5: share(maxT, x => x >= 5), maxG: mean(maxG), g5: share(maxG, x => x >= 5), games: mean(games), stars: mean(stars), punts: mean(punts), expo };
}
const KEYS = ["dup", "inDup", "sal", "sal50", "salLo", "own", "proj", "p99", "maxT", "t4", "t5", "maxG", "g5", "games", "stars", "punts"];

const contests = listPost("nba").map(json => { const c = readPost(json).contest; return { json, dir: path.basename(json).replace(/\.json(\.gz)?$/, ""), date: c.date, fee: c.fee, type: c.type }; }).filter(c => !/showdown/i.test(c.type)).sort((a, b) => (a.date + a.dir).localeCompare(b.date + b.dir));
const pick = contests.filter((c, i) => HALF == null || i % 2 === HALF).slice(0, MAX);
const per = [], acc = {};
const add = (k, m) => { const x = acc[k] = acc[k] || { n: 0 }; x.n++; for (const q of KEYS) x[q] = (x[q] || 0) + m[q]; };
const bAcc = {};
let t0 = Date.now();
for (const c of pick) {
  const rc = loadPulled(c.json), P = rc.pool.players, f = rc.pool.format, real = rc.entries.map(e => e.lu), N = real.length; if (N < 50) continue;
  const mr = metrics(real, P, f), size = sizeOf(N), gb = gamesOf(rc.pool.games.length), row = { dir: c.dir, date: c.date, fee: c.fee, N, games: rc.pool.games.length, real: Object.fromEntries(KEYS.map(k => [k, +mr[k].toFixed(2)])), gen: {} };
  for (const k of [size, gb, "all"]) add(`real|${k}`, mr);
  for (const a of USE) {
    const g = genField(rc.pool, N, Object.assign({}, BASE, ARCH[a]), mulberry32(1)).field, mg = metrics(g, P, f);
    let mae = 0, nm = 0, cg = 0, cr = 0;
    for (const p of P) { const er = mr.expo[p.i], eg = mg.expo[p.i]; if (p.own <= 0 && er <= 0) continue; mae += Math.abs(er - eg); nm++; if (p.own >= 20) { cg += eg; cr += er; }
      const b = BK.findIndex(([lo, hi]) => p.own >= lo && p.own < hi); if (b < 0) continue; for (const k of [size, gb, "all"]) { const x = bAcc[`${a}|${k}|${b}`] = bAcc[`${a}|${k}|${b}`] || { n: 0, proj: 0, gen: 0, real: 0 }; x.n++; x.proj += p.own; x.gen += eg; x.real += er; } }
    mg.mae = nm ? mae / nm : 0; mg.chalk = cr > 0 ? cg / cr : 1;
    for (const k of [size, gb, "all"]) { add(`${a}|${k}`, mg); const x = acc[`${a}|${k}`]; x.mae = (x.mae || 0) + mg.mae; x.chalkS = (x.chalkS || 0) + (cr > 0 ? cg : 0); x.chalkR = (x.chalkR || 0) + cr; }
    row.gen[a] = Object.fromEntries(KEYS.concat(["mae", "chalk"]).map(k => [k, +mg[k].toFixed(2)]));
  }
  per.push(row);
  if (per.length % 25 === 0) console.error(`${per.length}/${pick.length} contests, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
const agg = {}; for (const [k, x] of Object.entries(acc)) { agg[k] = { contests: x.n }; for (const q of KEYS) agg[k][q] = +(x[q] / x.n).toFixed(2); if (x.mae != null) { agg[k].mae = +(x.mae / x.n).toFixed(2); agg[k].chalk = +(x.chalkS / Math.max(1e-9, x.chalkR)).toFixed(3); } }
const buckets = {}; for (const [k, x] of Object.entries(bAcc)) { const [a, s, b] = k.split("|"); ((buckets[a] = buckets[a] || {})[s] = buckets[a][s] || [])[+b] = { bucket: BK[+b].join("-"), n: x.n, proj: +(x.proj / x.n).toFixed(1), gen: +(x.gen / x.n).toFixed(1), real: +(x.real / x.n).toFixed(1) }; }
const out = { built: new Date().toISOString(), half: HALF, contests: per.length, base: BASE, arch: Object.fromEntries(USE.map(a => [a, ARCH[a]])), agg, buckets, per };
fs.mkdirSync("data/reports/nba", { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`${per.length} NBA classic contests${HALF == null ? "" : ` (half ${HALF})`}, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${OUT}\n`);
const cols = ["contests", "dup", "inDup", "sal", "sal50", "salLo", "own", "proj", "p99", "maxT", "t4", "t5", "maxG", "g5", "games", "stars", "punts", "mae", "chalk"];
console.log("field|size".padEnd(22) + cols.map(c => c.padStart(8)).join(""));
for (const s of ["<300", "300-1.5K", "1.5K+", "g2-4", "g5-7", "g8+", "all"]) for (const a of ["real"].concat(USE)) { const r = agg[`${a}|${s}`]; if (r) console.log(`${a}|${s}`.padEnd(22) + cols.map(c => String(r[c] ?? "").padStart(8)).join("")); }
for (const s of ["all", "g2-4", "g5-7", "g8+"]) { console.log(`\nexposure by projected-ownership bucket (${s}): proj -> gen / real`);
  for (const a of USE) console.log(a.padEnd(12) + (buckets[a]?.[s] || []).filter(Boolean).map(b => `${b.bucket}%: ${b.proj}->${b.gen}/${b.real}`).join("  ")); }
