// NFL factor loadings from real box scores (2026-10-15, sim rewire item 2). On big NFL pools the sim ties players together
// with three shared normals per player (model.mjs LOAD.nfl [game, team, opponent]): two players' correlation is
// g1 g2 + t1 t2 + o1 o2 for teammates and g1 g2 + t1 o2 + o1 t2 for opponents. The sim-vs-real check (bench/sim-vs-real-nfl.mjs,
// bootstrap by slate) says it over-rates QB stacks with no bring-back and under-rates bring-backs: too much same-team,
// too little game. This measures what real games say. Each QB/RB/WR/TE player-week (bench/nfl-actuals.mjs) becomes a
// normal score of log(actual / projection) ranked within position (busts handled by rank), then the correlation of those
// scores is measured for every position pair, same team and opposing team, over players projected 5+. Loadings for
// QB/RB/WR/TE are fitted to the 2025 pair correlations (weighted by pair count), checked on 2026 against the current table.
// DST isn't in the box scores, so its loadings stay as they are.
// --target=tail fits to joint upside instead (both players in their top 15%, as a lift over independent), converted to the
// rho a normal copula needs to reproduce it: DFS pays on blow-ups together, and real ones exceed what plain correlation implies.
//   node bench/fit-load-nfl.mjs [--minproj=5] [--target=tail]   -> data/reports/load-nfl[-tail].json ({ nfl: {...} } for grade-all --load=)
import fs from "node:fs";
import { nflPlayerWeeks } from "./nfl-actuals.mjs";
import { LOAD, qnorm } from "../src/engine/model.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MINP = +arg("minproj", 5), POS = ["QB", "RB", "WR", "TE"], FITA = arg("fit", "2025"), FIT = FITA === "all" ? 0 : +FITA, CHK = FIT === 2026 ? 2025 : 2026;   // --fit=2026: the reverse check; --fit=all: both seasons (check is then in-sample)
const rows = nflPlayerWeeks({}).filter(r => r.proj >= MINP && r.team && r.opp);
// normal score of the log residual, ranked within position and season
for (const y of [2025, 2026]) for (const pos of POS) { const g = rows.filter(r => r.y === y && r.pos === pos).map(r => ({ r, v: Math.log((r.act + 0.5) / r.proj) })).sort((a, b) => a.v - b.v); g.forEach((x, i) => { x.r.z = qnorm((i + 0.5) / g.length); }); }
const key = (a, b, rel) => { const [p, q] = POS.indexOf(a.pos) <= POS.indexOf(b.pos) ? [a.pos, b.pos] : [b.pos, a.pos]; return `${rel}|${p}|${q}`; };
function pairCorr(rs) {
  const byG = {}; for (const r of rs) (byG[`${r.y}|${r.wk}|${[r.team, r.opp].sort().join("@")}`] ||= []).push(r);
  const S = {}; for (const g of Object.values(byG)) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) { const a = g[i], b = g[j], rel = a.team === b.team ? "same" : "opp"; const s = S[key(a, b, rel)] ||= { n: 0, xy: 0, x: 0, y: 0, xx: 0, yy: 0 }; s.n++; s.xy += a.z * b.z; s.x += a.z; s.y += b.z; s.xx += a.z * a.z; s.yy += b.z * b.z; }
  const out = {}; for (const [k, s] of Object.entries(S)) { const c = (s.xy / s.n - (s.x / s.n) * (s.y / s.n)) / Math.sqrt((s.xx / s.n - (s.x / s.n) ** 2) * (s.yy / s.n - (s.y / s.n) ** 2)); out[k] = { n: s.n, r: c }; } return out;
}
const implied = (L, k) => { const [rel, p, q] = k.split("|"), a = L[p], b = L[q]; return rel === "same" ? a[0] * b[0] + a[1] * b[1] + a[2] * b[2] : a[0] * b[0] + a[1] * b[2] + a[2] * b[1]; };
const inFit = r => !FIT || r.y === FIT, tr = pairCorr(rows.filter(inFit)), te = pairCorr(rows.filter(r => r.y === CHK));
// joint upside: P(both in their top 15%) / independent 2.25%, real (2025+2026) vs what a normal copula gives at each table's rho
const zq = 1.0364, biv = rho => { let h = 0; const N = 200000; const rnd = mulberry32(3); for (let i = 0; i < N; i++) { const a = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()), b = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()), x = a, y = rho * a + Math.sqrt(1 - rho * rho) * b; if (x > zq && y > zq) h++; } return h / N / 0.0225; };
const byG = {}; for (const r of rows) (byG[`${r.y}|${r.wk}|${[r.team, r.opp].sort().join("@")}`] ||= []).push(r);
const T = {}; for (const g of Object.values(byG)) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) { const a = g[i], b = g[j], k = key(a, b, a.team === b.team ? "same" : "opp"); const t = T[k] ||= { n: 0, h: 0 }; t.n++; if (a.z > zq && b.z > zq) t.h++; }
// the rho at which a normal copula gives each pair type's real joint-upside lift (bisection), per season
const tailOf = y => { const T = {}; for (const g of Object.values(byG)) { if (y != null && g[0].y !== y) continue; for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) { const a = g[i], b = g[j], k = key(a, b, a.team === b.team ? "same" : "opp"); const t = T[k] ||= { n: 0, h: 0 }; t.n++; if (a.z > zq && b.z > zq) t.h++; } } return T; };
const bivMemo = new Map(), bivR = rho => { const k = Math.round(rho * 200); if (!bivMemo.has(k)) bivMemo.set(k, biv(k / 200)); return bivMemo.get(k); };
const rhoFor = lift => { let lo = -0.6, hi = 0.9; for (let it = 0; it < 12; it++) { const m = (lo + hi) / 2; if (bivR(m) < lift) lo = m; else hi = m; } return (lo + hi) / 2; };
const asTarget = T => Object.fromEntries(Object.entries(T).filter(([, t]) => t.n >= 40).map(([k, t]) => [k, { n: t.n, r: rhoFor(t.h / t.n / 0.0225), lift: t.h / t.n / 0.0225 }]));
const TAIL = arg("target", "corr") === "tail", T25 = tailOf(FIT || null), T26 = tailOf(CHK);   // fit season, check season
const trT = TAIL ? asTarget(T25) : tr, teT = TAIL ? asTarget(T26) : te;
const err = (L, P) => { let e = 0, w = 0; for (const [k, s] of Object.entries(P)) { if (s.n < 40) continue; e += s.n * (s.r - implied(L, k)) ** 2; w += s.n; } return e / w; };
// fit: coordinate search from zero (start at the current table and it stalls in a corner),, keep g^2 + t^2 + o^2 <= 0.95 (each player keeps some of his own noise)
let L = Object.fromEntries(POS.map(p => [p, [0.1, 0.3, 0]])), best = err(L, trT);
const grid = Array.from({ length: 81 }, (_, i) => -0.4 + i * 0.0125), gridG = grid.filter(v => v >= 0);   // game loading kept >= 0: DST's loadings assume it
for (let sweep = 0; sweep < 8; sweep++) for (const p of POS) for (let d = 0; d < 3; d++) for (const v of d === 0 ? gridG : grid) { const M = Object.assign({}, L, { [p]: L[p].slice() }); M[p][d] = v; if (M[p][0] ** 2 + M[p][1] ** 2 + M[p][2] ** 2 > 0.95) continue; const e = err(M, trT); if (e < best) { best = e; L = M; } }
console.log(`${rows.length} player-weeks projected ${MINP}+ (2025 fit, 2026 check). Pair correlation of log(actual/projection) normal scores`);
console.log(`  ${"pair".padEnd(14)} ${"2025 n".padStart(7)} ${"real".padStart(6)} | ${"2026 n".padStart(7)} ${"real".padStart(6)} | current model | fitted`);
const ks = [...new Set([...Object.keys(tr), ...Object.keys(te)])].sort();
for (const k of ks) { const a = tr[k], b = te[k]; if (!a || a.n < 40) continue; console.log(`  ${k.padEnd(14)} ${String(a.n).padStart(7)} ${a.r.toFixed(3).padStart(6)} | ${String(b?.n ?? 0).padStart(7)} ${(b ? b.r.toFixed(3) : "-").padStart(6)} | ${implied(LOAD.nfl, k).toFixed(3).padStart(13)} | ${implied(L, k).toFixed(3).padStart(6)}`); }
console.log(`\nweighted squared error vs real pair correlations: 2025 current ${err(LOAD.nfl, tr).toFixed(5)} fitted ${err(L, tr).toFixed(5)} | 2026 current ${err(LOAD.nfl, te).toFixed(5)} fitted ${err(L, te).toFixed(5)}`);
console.log(`\njoint upside (both top 15%), lift over independent: real 2025 | real 2026 | current model | fitted${TAIL ? "   (fit target: the rho reproducing each 2025 lift)" : ""}`);
for (const k of ks) { const a = T25[k], b = T26[k]; if (!a || a.n < 40) continue; console.log(`  ${k.padEnd(14)} ${(a.h / a.n / 0.0225).toFixed(2).padStart(5)} | ${(b && b.n >= 40 ? (b.h / b.n / 0.0225).toFixed(2) : "-").padStart(5)} | ${bivR(implied(LOAD.nfl, k)).toFixed(2).padStart(13)} | ${bivR(implied(L, k)).toFixed(2).padStart(6)}`); }
if (TAIL) console.log(`weighted squared error vs the tail-implied rho: 2025 current ${err(LOAD.nfl, trT).toFixed(5)} fitted ${err(L, trT).toFixed(5)} | 2026 current ${err(LOAD.nfl, teT).toFixed(5)} fitted ${err(L, teT).toFixed(5)}`);
console.log("loadings [game, team, opponent]:"); for (const p of POS) console.log(`  ${p}  current ${JSON.stringify(LOAD.nfl[p])}  fitted ${JSON.stringify(L[p].map(x => +x.toFixed(3)))}`);
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync(`data/reports/load-nfl${TAIL ? "-tail" : ""}${FITA === "2025" ? "" : "-fit" + FITA}.json`, JSON.stringify({ nfl: Object.assign({}, LOAD.nfl, Object.fromEntries(POS.map(p => [p, L[p].map(x => +x.toFixed(3))]))) }, null, 1));
// pairwise table for small pools (model.mjs CSAME / COPP, used at <= 220 players: showdown and small slates), from the same
// target: each pair type's rho, where it has 200+ pairs; the rest keep the hand-set values. -> grade-all --ctable=<file>
const CT = { CSAME: {}, COPP: {} }; for (const [k, t] of Object.entries(trT)) { if (t.n < 200) continue; const [rel, p, q] = k.split("|"); CT[rel === "same" ? "CSAME" : "COPP"][p + "|" + q] = +t.r.toFixed(3); }
fs.writeFileSync(`data/reports/corr-nfl${TAIL ? "-tail" : ""}${FITA === "2025" ? "" : "-fit" + FITA}.json`, JSON.stringify(CT, null, 1));
console.log("pairwise table (small pools):", JSON.stringify(CT));
