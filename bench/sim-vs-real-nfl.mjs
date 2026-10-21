// Where does our sim disagree with reality? (2026-10-15, "the sim probably needs some rewiring"). Uses the saved per-lineup
// sim predictions for every real classic entry (data/reports/cal/*.jsonl from bench/grade-all.mjs --rows, 2026-10-06: each
// real lineup simmed in its real contest) and the archive's real finishes. Lineups are grouped by construction (QB stack
// shape, most players from one game, chalk count, ownership sum, salary left, mini-stack) and for each group we compare the
// sim's LIFT (group's predicted top-1% / top-10% / ROI vs all lineups in the same contests) with the REAL lift. The sim is
// known to be ~3x overconfident overall, so lifts, not levels, are compared: a group the sim lifts far more than reality
// says is what the sim over-rates, and points at the layer to fix (correlations -> deep stacks; field / splits -> chalk).
//   node bench/sim-vs-real-nfl.mjs [data/reports/cal/base.s0.jsonl ...]
import fs from "node:fs";
import readline from "node:readline";
import { readPost } from "./post-store.mjs";
import { listContests } from "./grade-all.mjs";

const files = process.argv.slice(2).filter(x => x.endsWith(".jsonl")); if (!files.length) for (const f of fs.readdirSync("data/reports/cal")) if (/^base\.s\d+\.jsonl$/.test(f)) files.push("data/reports/cal/" + f);
const byC = {};   // contest dir -> rows
for (const f of files) { const rl = readline.createInterface({ input: fs.createReadStream(f) }); for await (const line of rl) { if (!line.includes('"fkey":"nfl_cl"')) continue; const r = JSON.parse(line); (byC[r.c] ||= []).push(r); } }
console.error(`${Object.keys(byC).length} classic contests with sim rows`);
const files2 = new Map(listContests().filter(c => c.json && c.fkey === "nfl_cl").map(c => [c.dir, c.json]));
const GD = {}, addD = (d, k, x) => { const g = ((GD[k] ||= {})[d] ||= { n: 0, pT1: 0, aT1: 0, pROI: 0, aROI: 0 }); g.n++; g.pT1 += x.pT1; g.aT1 += x.aT1; g.pROI += x.pROI; g.aROI += x.aROI; };
const G = {}, add = (k, x) => { const g = G[k] ||= { n: 0, pT1: 0, aT1: 0, pT10: 0, aT10: 0, pROI: 0, aROI: 0 }; g.n++; g.pT1 += x.pT1; g.aT1 += x.aT1; g.pT10 += x.pT10; g.aT10 += x.aT10; g.pROI += x.pROI; g.aROI += x.aROI; };
let matched = 0, total = 0;
for (const [dir, rows] of Object.entries(byC)) {
  const jf = files2.get(dir); if (!jf) continue; const j = readPost(jf), P = {}; for (const p of j.players) P[p.id] = p;
  const games = new Set(j.players.filter(p => p.team && p.opp).map(p => [p.team, p.opp].sort().join("@"))).size; if (games < 9) continue;   // main slates
  const key = {}; for (const l of j.lineups) key[`${l.u}|${l.fin}`] = l;
  // per-contest means for lifts
  const X = [];
  for (const r of rows) { total++; const l = key[`${r.user}|${r.finish}`]; if (!l) continue; const ps = l.ids.map(i => P[i]).filter(Boolean); if (ps.length < 9) continue; const qb = ps.find(p => p.pos === "QB"); if (!qb) continue; matched++;
    const st = Math.min(3, ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(p.pos)).length), bb = Math.min(2, ps.filter(p => p.team === qb.opp && p.pos !== "DST").length);
    const gm = {}; for (const p of ps) if (p.pos !== "DST") { const g = [p.team, p.opp].sort().join(); gm[g] = (gm[g] || 0) + 1; } const cnts = Object.values(gm).sort((a, b) => b - a);
    const qg = [qb.team, qb.opp].sort().join(); let mini = 0; for (const [g, n] of Object.entries(gm)) if (g !== qg) mini = Math.max(mini, n);
    const chalk = ps.filter(p => p.pown >= 0.2).length, own = 100 * ps.reduce((s, p) => s + p.pown, 0), low = ps.filter(p => p.pown < 0.05).length;
    X.push({ shape: `QB+${st} bb${bb}`, maxG: Math.min(cnts[0], 6), mini: Math.min(mini, 3), chalk: Math.min(chalk, 6), ownB: own < 90 ? "<90" : own < 120 ? "90-120" : own < 150 ? "120-150" : own < 180 ? "150-180" : "180+", low: Math.min(low, 4), left: r.salLeft < 200 ? "<$200" : r.salLeft < 600 ? "$200-600" : "$600+",
      pT1: r.t1, aT1: r.top1 * 100, pT10: r.t10, aT10: r.top10 * 100, pROI: r.roi, aROI: Math.min(r.actROI, 2000) });   // real ROI capped at +2000% per lineup: one win shouldn't swing a group
  }
  if (!X.length) continue; const m = k => X.reduce((s, x) => s + x[k], 0) / X.length, base = { pT1: m("pT1") || 1e-9, aT1: m("aT1") || 1e-9, pT10: m("pT10") || 1e-9, aT10: m("aT10") || 1e-9, pROI: m("pROI"), aROI: m("aROI") };
  for (const x of X) { const rel = { pT1: x.pT1 / base.pT1, aT1: x.aT1 / base.aT1, pT10: x.pT10 / base.pT10, aT10: x.aT10 / base.aT10, pROI: x.pROI - base.pROI, aROI: x.aROI - base.aROI };
    for (const k of [`lowbb|${x.low >= 4 ? "4+low" : "<4low"} ${/bb0/.test(x.shape) ? "noBB" : "BB"}`, `shape|${x.shape}`, `maxG|${x.maxG}`, `mini|${x.mini}`, `chalk|${x.chalk}`, `own|${x.ownB}`, `low|${x.low}`, `left|${x.left}`]) { add(k, rel); addD(j.contest.date, k, rel); } }
}
console.log(`main-slate lineups matched ${matched} of ${total} classic sim rows. Lift = vs the average lineup in the same contest (1.00 = average; ROI as points above/below the contest average)`);
console.log("A group the sim lifts much more than reality is over-rated by the sim; less than reality, under-rated.");
const show = (title, prefix, order) => { console.log(`\n${title}`); console.log(`  ${"group".padEnd(12)} ${"lineups".padStart(9)} | top-1% lift sim / real | top-10% lift sim / real | ROI vs avg sim / real`);
  for (const k of order) { const g = G[`${prefix}|${k}`]; if (!g || g.n < 3000) continue; const f = v => (v / g.n).toFixed(2);
    console.log(`  ${String(k).padEnd(12)} ${String(g.n).padStart(9)} | ${f(g.pT1).padStart(6)} / ${f(g.aT1).padEnd(6)}${g.pT1 / g.aT1 > 1.3 ? " OVER" : g.pT1 / g.aT1 < 0.77 ? " UNDER" : "     "}  | ${f(g.pT10).padStart(6)} / ${f(g.aT10).padEnd(6)}       | ${(g.pROI / g.n).toFixed(0).padStart(5)} / ${(g.aROI / g.n).toFixed(0)}`); } };
// bootstrap by slate date: 90% interval of (sim top-1% lift - real top-1% lift) and of the real lift
const boot = (k, B = 2000) => { const D = Object.values(GD[k] || {}); if (D.length < 5) return null; let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gaps = [], reals = []; for (let b = 0; b < B; b++) { let n = 0, p = 0, a = 0; for (let i = 0; i < D.length; i++) { const d = D[Math.floor(rnd() * D.length)]; n += d.n; p += d.pT1; a += d.aT1; } gaps.push((p - a) / n); reals.push(a / n); }
  const q = (v, x) => v.sort((u, w) => u - w)[Math.floor(x * v.length)]; return { dates: D.length, gap: [q(gaps, 0.05), q(gaps, 0.95)], real: [q(reals, 0.05), q(reals, 0.95)] }; };
console.log("\nBootstrap by slate date (90% intervals): sim minus real top-1% lift, and the real lift");
for (const k of ["shape|QB+2 bb0", "shape|QB+3 bb0", "shape|QB+1 bb0", "shape|QB+2 bb1", "shape|QB+3 bb1", "shape|QB+2 bb2", "chalk|0", "chalk|2", "chalk|3", "chalk|4", "chalk|5", "low|0", "low|3", "low|4", "own|150-180", "own|<90", "lowbb|4+low BB", "lowbb|4+low noBB", "lowbb|<4low BB", "lowbb|<4low noBB"]) { const b = boot(k); if (b) console.log("  " + k.padEnd(16) + " dates " + String(b.dates).padStart(3) + "  gap " + b.gap.map(x => x.toFixed(2)).join(" .. ").padEnd(14) + "  real lift " + b.real.map(x => x.toFixed(2)).join(" .. ")); }
show("QB stack shape", "shape", ["QB+0 bb0", "QB+1 bb0", "QB+1 bb1", "QB+1 bb2", "QB+2 bb0", "QB+2 bb1", "QB+2 bb2", "QB+3 bb0", "QB+3 bb1", "QB+3 bb2"]);
show("Most players from one game", "maxG", [2, 3, 4, 5, 6]);
show("Mini-stack (most from a non-QB game)", "mini", [1, 2, 3]);
show("Players 20%+ owned", "chalk", [0, 1, 2, 3, 4, 5, 6]);
show("Ownership sum", "own", ["<90", "90-120", "120-150", "150-180", "180+"]);
show("Players under 5% owned", "low", [0, 1, 2, 3, 4]);
show("Salary left", "left", ["<$200", "$200-600", "$600+"]);
