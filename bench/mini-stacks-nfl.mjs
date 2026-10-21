// Mini-stacks (user, 2026-10-15): besides the QB's game, does a lineup do better with 2-3 players from ONE other game, and
// which kind? Main slates (9+ games), classic archive, real ROI / top-10% / top-1%. Held fixed: the QB stack shape (QB+1 or QB+2
// with one bring-back, QB+2 with two). Mini-stack = the other game the lineup has the most players from (DST not counted):
//   none        every other player from a different game
//   2 same      two teammates (e.g. RB + WR) from one other game
//   2 split     one from each side of one other game (a mini game stack)
//   3+          three or more from one other game
// Also by the pair's positions (WR+WR, RB+WR, WR+TE, RB+RB...) and whether it includes that game's QB-less chalk.
//   node bench/mini-stacks-nfl.mjs
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const B = {}, add = (k, l) => { const b = B[k] ||= { n: 0, roi: 0, t1: 0, t10: 0 }; b.n++; b.roi += l.roi; b.t1 += l.t1; b.t10 += l.t10; };
let nC = 0;
for (const c of listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.entries >= 100)) {
  const j = readPost(c.json), P = {}; for (const p of j.players) P[p.id] = p; const N = j.lineups.length, fee = j.contest.fee;
  const games = new Set(j.players.filter(p => p.team && p.opp).map(p => [p.team, p.opp].sort().join("@"))).size; if (games < 9) continue; nC++;
  const yr = j.contest.date < "2026-06-01" ? "2025" : "2026", tier = fee >= 100 ? "$100+" : "<$100";
  for (const l of j.lineups) {
    const ps = l.ids.map(i => P[i]).filter(Boolean); if (ps.length < 9) continue; const qb = ps.find(p => p.pos === "QB"); if (!qb) continue;
    const st = Math.min(3, ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(p.pos)).length), bb = Math.min(2, ps.filter(p => p.team === qb.opp && p.pos !== "DST").length);
    const shape = `QB+${st} bb${bb}`; if (!["QB+1 bb1", "QB+2 bb1", "QB+2 bb2", "QB+1 bb0", "QB+2 bb0"].includes(shape)) continue;
    const qg = [qb.team, qb.opp].sort().join(), G = {}; for (const p of ps) { if (p.pos === "DST" || p.pos === "QB") continue; const g = [p.team, p.opp].sort().join(); if (g === qg) continue; (G[g] ||= []).push(p); }
    const top = Object.values(G).sort((a, b) => b.length - a.length)[0] || [];
    let kind = "none", pair = "";
    if (top.length >= 3) kind = "3+";
    else if (top.length === 2) { kind = top[0].team === top[1].team ? "2 same" : "2 split"; pair = top.map(p => p.pos).sort().join("+") + (kind === "2 same" ? " same" : " split"); }
    const L = { roi: l.aroi ?? -1, t1: l.fin <= N * 0.01 ? 1 : 0, t10: l.fin <= N * 0.1 ? 1 : 0 };
    for (const k of [`${shape}|${kind}`, `${shape} ${yr}|${kind}`, `${shape} ${tier}|${kind}`, `any ${yr}|${kind}`, `any|${kind}`]) add(k, L);
    if (pair && shape !== "QB+1 bb0" && shape !== "QB+2 bb0") { add(`pair|${pair}`, L); add(`pair ${yr}|${pair}`, L); }
  }
}
console.log(`${nC} main-slate classic contests (9+ games). Mini-stack = most players from one NON-QB game (DST excluded). Base top10 10%, top1 1%`);
const K = ["none", "2 same", "2 split", "3+"];
const show = (lab, pre) => { console.log(`\n${lab}`); let tot = 0; for (const k of K) tot += (B[`${pre}|${k}`] || { n: 0 }).n;
  for (const k of K) { const b = B[`${pre}|${k}`]; if (!b || b.n < 1500) continue; console.log(`  ${k.padEnd(8)} share ${(100 * b.n / tot).toFixed(1).padStart(5)}%  n ${String(b.n).padStart(8)}  ROI ${(100 * b.roi / b.n).toFixed(1).padStart(6)}%  top10 ${(100 * b.t10 / b.n).toFixed(1).padStart(5)}%  top1 ${(100 * b.t1 / b.n).toFixed(2).padStart(5)}%`); } };
show("All shapes", "any"); show("All shapes, 2025", "any 2025"); show("All shapes, 2026", "any 2026");
for (const s of ["QB+1 bb1", "QB+2 bb1", "QB+2 bb2", "QB+1 bb0", "QB+2 bb0"]) { show(`${s}`, s); show(`${s}, 2025`, `${s} 2025`); show(`${s}, 2026`, `${s} 2026`); show(`${s}, $100+`, `${s} $100+`); }
console.log("\nBy pair type (QB stacks with a bring-back only), all / 2025 / 2026 top1");
const pairs = Object.keys(B).filter(k => k.startsWith("pair|")).map(k => k.slice(5)).filter(p => B[`pair|${p}`].n >= 5000).sort((a, b) => B[`pair|${b}`].t1 / B[`pair|${b}`].n - B[`pair|${a}`].t1 / B[`pair|${a}`].n);
for (const p of pairs) { const a = B[`pair|${p}`], x = B[`pair 2025|${p}`], y = B[`pair 2026|${p}`]; const f = b => b && b.n >= 1000 ? (100 * b.t1 / b.n).toFixed(2) + "%" : "-";
  console.log(`  ${p.padEnd(14)} n ${String(a.n).padStart(7)}  ROI ${(100 * a.roi / a.n).toFixed(1).padStart(6)}%  top10 ${(100 * a.t10 / a.n).toFixed(1).padStart(5)}%  top1 ${f(a)} | 2025 ${f(x)} | 2026 ${f(y)}`); }
