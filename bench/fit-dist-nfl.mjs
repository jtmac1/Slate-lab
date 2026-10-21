// NFL player score distributions by projection size (2026-10-15, sim rewire). The sim draws every NFL player from a
// lognormal with one sigma per position (SIGMA_DEF.nfl), the same at a 4-point and a 20-point projection. Real box scores
// (bench/nfl-actuals.mjs) say otherwise: cheap players bust to ~0 far more often (proj 3-6: 25-30% under 0.3x vs the sim's
// 2-6%) and also hit 3x more often, while studs (15+) never hit 3x and hit 2x less than the sim draws. Fits, per position,
// the shape model.mjs can already draw: a zero-inflated lognormal (bust p0 = min(max, a * (ref / proj)^b), model.mjs
// bustProb) with sigma tilted by projection (sigma = s * (proj / ref)^e, model.mjs sigmaFor tilt). The mean stays the
// projection. Fitted by likelihood on 2025 (a score at or under 0.5 counts as "bust or the lognormal's bottom"), scored on
// 2026 against the current flat model and against the tilt alone. Prints the tail table per variant.
//   node bench/fit-dist-nfl.mjs [--split=2026-03-01]   -> data/reports/dist-nfl.json
import fs from "node:fs";
import { nflPlayerWeeks } from "./nfl-actuals.mjs";
import { SIGMA_DEF, pnorm } from "../src/engine/model.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SPLIT = arg("split", "2026-03-01"), LOW = 0.5, MAXB = 0.6;
const POS = ["QB", "RB", "WR", "TE"], REF = { QB: 18, RB: 11, WR: 10, TE: 7 };
const rows = nflPlayerWeeks({ split: SPLIT }), tr = rows.filter(r => !r.test), te = rows.filter(r => r.test);
console.log(`${rows.length} player-weeks (all classic slates): fit ${tr.length} before ${SPLIT}, test ${te.length}`);

const sigOf = (P, pos, proj) => Math.min(1.2, P.s * Math.pow(Math.max(3, proj) / REF[pos], P.e));
const p0Of = (P, pos, proj) => P.a > 0 ? Math.min(MAXB, P.a * Math.pow(REF[pos] / Math.max(3, proj), P.b)) : 0;
// log-likelihood of one score: point mass at 0 (p0) + lognormal with mean proj / (1 - p0)
function ll(P, pos, r) {
  const sg = sigOf(P, pos, r.proj), p0 = p0Of(P, pos, r.proj), m = r.proj / (1 - p0), mu = Math.log(m) - sg * sg / 2;
  if (r.act <= LOW) return Math.log(Math.max(1e-12, p0 + (1 - p0) * pnorm((Math.log(LOW) - mu) / sg)));
  const z = (Math.log(r.act) - mu) / sg; return Math.log(Math.max(1e-300, (1 - p0) * Math.exp(-z * z / 2) / (r.act * sg * Math.sqrt(2 * Math.PI))));
}
const tot = (P, pos, rs) => { let s = 0; for (const r of rs) s += ll(P, pos, r); return s; };
// coordinate search over a grid, a few sweeps
function fit(pos, rs, free) {
  let P = { s: SIGMA_DEF.nfl[pos], e: 0, a: 0, b: 1 }, best = tot(P, pos, rs);
  const G = { s: Array.from({ length: 36 }, (_, i) => 0.25 + i * 0.025), e: Array.from({ length: 41 }, (_, i) => -1 + i * 0.03), a: Array.from({ length: 41 }, (_, i) => i * 0.01), b: Array.from({ length: 31 }, (_, i) => i * 0.1) };
  for (let sweep = 0; sweep < 6; sweep++) for (const k of free) for (const v of G[k]) { const Q = Object.assign({}, P, { [k]: v }), L = tot(Q, pos, rs); if (L > best) { best = L; P = Q; } }
  return P;
}
const V = {}, out = {};
for (const pos of POS) {
  const a = tr.filter(r => r.pos === pos), b = te.filter(r => r.pos === pos);
  const flat = { s: SIGMA_DEF.nfl[pos], e: 0, a: 0, b: 1 }, flatS = fit(pos, a, ["s"]), tilt = fit(pos, a, ["s", "e"]), bust = fit(pos, a, ["s", "e", "a", "b"]);
  V[pos] = { "current (flat)": flat, "flat, refit sigma": flatS, "tilt": tilt, "bust + tilt": bust };
  out[pos] = { tilt, bust, ref: REF[pos] };
  console.log(`\n${pos}  fit n ${a.length}, test n ${b.length}   mean log-likelihood per player on 2026 (higher is better), 2025 in brackets`);
  for (const [k, P] of Object.entries(V[pos])) console.log(`  ${k.padEnd(18)} ${(tot(P, pos, b) / b.length).toFixed(4)}  [${(tot(P, pos, a) / a.length).toFixed(4)}]   s ${P.s.toFixed(3)} e ${P.e.toFixed(2)}${P.a ? ` bust a ${P.a.toFixed(2)} b ${P.b.toFixed(1)} -> p0 at ${Math.round(REF[pos] / 2)} pts ${(100 * p0Of(P, pos, REF[pos] / 2)).toFixed(0)}%, ${REF[pos]} pts ${(100 * p0Of(P, pos, REF[pos])).toFixed(0)}%, ${REF[pos] * 1.6} pts ${(100 * p0Of(P, pos, REF[pos] * 1.6)).toFixed(0)}%` : ""}`);
}
// tail table on 2026: real vs each variant (analytic)
const pOver = (P, pos, proj, k) => { const sg = sigOf(P, pos, proj), p0 = p0Of(P, pos, proj), mu = Math.log(proj / (1 - p0)) - sg * sg / 2; return (1 - p0) * (1 - pnorm((Math.log(k * proj) - mu) / sg)); };
console.log(`\n2026 tails: real | current | tilt | bust + tilt     (2x, 3x, <=0.3x of projection)`);
for (const pos of POS) for (const [lo, hi] of [[3, 7], [7, 12], [12, 18], [18, 99]]) {
  const g = te.filter(r => r.pos === pos && r.proj >= lo && r.proj < hi); if (g.length < 60) continue;
  const real = k => 100 * g.filter(r => r.act >= k * r.proj).length / g.length, realLo = 100 * g.filter(r => r.act <= 0.3 * r.proj).length / g.length;
  const mod = (P, k) => 100 * g.reduce((s, r) => s + pOver(P, pos, r.proj, k), 0) / g.length, modLo = P => 100 * g.reduce((s, r) => s + 1 - pOver(P, pos, r.proj, 0.3), 0) / g.length;
  const cell = (f) => ["current (flat)", "tilt", "bust + tilt"].map(k => f(V[pos][k]).toFixed(1).padStart(5)).join(" ");
  console.log(`  ${pos} ${String(lo).padStart(2)}-${hi > 50 ? "+ " : String(hi).padEnd(2)} n ${String(g.length).padStart(4)} | 2x ${real(2).toFixed(1).padStart(5)} |${cell(P => mod(P, 2))} | 3x ${real(3).toFixed(1).padStart(5)} |${cell(P => mod(P, 3))} | bust ${realLo.toFixed(1).padStart(5)} |${cell(modLo)}`);
}
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/dist-nfl.json", JSON.stringify({ built: new Date().toISOString(), split: SPLIT, low: LOW, maxBust: MAXB, fit: out }, null, 1));
