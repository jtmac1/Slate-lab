// Showdown ownership by position: does the field play some positions more than the projections say? (Cody Main, 10/06:
// "why do people obsess over TEs on primetime slates?") Per real showdown contest, actual / projected ownership summed
// over the players of each position, FLEX and CPT separately; one ratio per game (contests of the same game averaged) so
// a game with many contests does not dominate. Fit on 2025 showdowns, checked on 2026: per-contest MAE of each player's
// ownership, projected as-is vs projected x the position multiplier (renormalised so FLEX still sums to the slate's FLEX
// total and CPT to its CPT total). Two fits: on the raw projection (what the field generator is fed) and on the projection
// after the showdown bucket curve (what the Data Hub shows as Lab own).
//   node bench/fit-own-pos-sd.mjs [--split=2026-03-01]   -> data/reports/own-pos-sd.json
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { ownCurve } from "../server/sources.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SPLIT = arg("split", "2026-03-01"), POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const curveF = ownCurve("showdown", "flex"), curveC = ownCurve("showdown", "cpt");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN, sd = a => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / Math.max(1, a.length - 1));

// per contest: players with a known position and their projected / actual FLEX and CPT ownership
const contests = [];
for (const c of listContests().filter(c => c.json && c.fkey === "nfl_sd" && c.entries >= 100)) {
  const rc = loadPulled(c.json), P = rc.pool.players.filter(p => POS.includes(p.pos));
  if (P.length < 8) continue;
  const game = c.date + "|" + [...new Set(rc.pool.players.map(p => p.team).filter(Boolean))].sort().join("@");
  contests.push({ key: c.key, date: c.date, game, fee: c.fee, N: c.entries, test: c.date >= SPLIT, P: P.map(p => ({ pos: p.pos, f: p.own || 0, fa: p.actOwn || 0, c: p.cown || 0, ca: p.actCown || 0 })) });
}
const unknown = (() => { let u = 0, t = 0; for (const c of listContests().filter(c => c.json && c.fkey === "nfl_sd" && c.entries >= 100).slice(0, 40)) { const P = loadPulled(c.json).pool.players; t += P.length; u += P.filter(p => !POS.includes(p.pos)).length; } return +(u / Math.max(1, t)).toFixed(3); })();

// multiplier per position: geometric mean over games of sum(actual)/sum(projected); t on the log ratios
function fit(train, slot, xf) {
  const byGame = {};
  for (const c of train) for (const p of c.P) {
    const proj = xf(slot === "flex" ? p.f : p.c), act = slot === "flex" ? p.fa : p.ca; if (!(proj > 0)) continue;
    const g = byGame[c.game] || (byGame[c.game] = {}), q = g[p.pos] || (g[p.pos] = { p: 0, a: 0 }); q.p += proj; q.a += act;
  }
  const out = {};
  for (const pos of POS) {
    const lr = Object.values(byGame).map(g => g[pos]).filter(q => q && q.p > 2).map(q => Math.log(Math.max(0.05, q.a / q.p)));
    const m = mean(lr), se = sd(lr) / Math.sqrt(lr.length);
    out[pos] = { mult: +Math.exp(m).toFixed(3), t: +(m / se).toFixed(2), games: lr.length };
  }
  return out;
}
// apply multipliers within a contest, renormalising each slot to its original total
function adjust(P, slot, xf, mult) {
  const raw = P.map(p => xf(slot === "flex" ? p.f : p.c)), adj = P.map((p, i) => raw[i] * (mult[p.pos] ? mult[p.pos].mult : 1));
  const s0 = raw.reduce((a, b) => a + b, 0), s1 = adj.reduce((a, b) => a + b, 0) || 1;
  return { raw, adj: adj.map(x => x * s0 / s1) };
}
function mae(test, slot, xf, mult, posOnly) {
  const before = [], after = [], byPos = {};
  for (const c of test) {
    const { raw, adj } = adjust(c.P, slot, xf, mult);
    let b = 0, a = 0, k = 0;
    c.P.forEach((p, i) => { const act = slot === "flex" ? p.fa : p.ca; if (raw[i] < 1 && act < 1) return; b += Math.abs(raw[i] - act); a += Math.abs(adj[i] - act); k++;
      const q = byPos[p.pos] || (byPos[p.pos] = { b: 0, a: 0, n: 0 }); q.b += Math.abs(raw[i] - act); q.a += Math.abs(adj[i] - act); q.n++; });
    if (k) { before.push(b / k); after.push(a / k); }
  }
  const d = before.map((x, i) => after[i] - x), t = mean(d) / (sd(d) / Math.sqrt(d.length));
  return { contests: before.length, before: +mean(before).toFixed(3), after: +mean(after).toFixed(3), diff: +mean(d).toFixed(3), t: +t.toFixed(2), better: d.filter(x => x < 0).length,
    byPos: Object.fromEntries(Object.entries(byPos).map(([k, q]) => [k, { before: +(q.b / q.n).toFixed(2), after: +(q.a / q.n).toFixed(2), n: q.n }])) };
}
const train = contests.filter(c => !c.test), test = contests.filter(c => c.test);
const out = { built: new Date().toISOString(), split: SPLIT, train: { contests: train.length, games: new Set(train.map(c => c.game)).size }, test: { contests: test.length, games: new Set(test.map(c => c.game)).size }, unknownPosShare: unknown, fits: {} };
const id = x => x;
for (const [name, slot, xf] of [["flexRaw", "flex", id], ["cptRaw", "cpt", id], ["flexCurve", "flex", curveF], ["cptCurve", "cpt", curveC]]) {
  const m = fit(train, slot, xf), m26 = fit(test, slot, xf), chk = mae(test, slot, xf, m);
  out.fits[name] = { train: m, test2026: m26, check2026: chk };
  console.log(`\n== ${name}: train ${train.length} contests / ${out.train.games} games, test ${test.length} / ${out.test.games}`);
  for (const pos of POS) console.log(`  ${pos.padEnd(4)} 2025 x${m[pos].mult} (t ${m[pos].t}, ${m[pos].games} g) | 2026 x${m26[pos].mult} (t ${m26[pos].t}, ${m26[pos].games} g)`);
  console.log(`  2026 MAE ${chk.before} -> ${chk.after} (diff ${chk.diff}, t ${chk.t}, better in ${chk.better}/${chk.contests}) ${JSON.stringify(chk.byPos)}`);
}
fs.writeFileSync("data/reports/own-pos-sd.json", JSON.stringify(out, null, 1));
console.log("\nunknown-position share:", unknown);
