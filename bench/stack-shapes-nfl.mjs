// Stack shape by slate size (user, 2026-10-15: "QB+1 or QB+2 preferred for classic main; early/late could focus more; test
// no bring-back - if no bring-back, what does the winning lineup look like?"). Classic archive, every real lineup:
//   1. QB+0..3 teammates x 0/1/2 bring-backs: real ROI, top-10%, top-1%, by slate size (main 9+ games / mid 5-8 / small 2-4),
//      fee tier ($100+ vs under) and season.
//   2. Top-1% lineups WITHOUT a bring-back vs those WITH one: what they carry instead (QB stack size, a second team stack,
//      RB with his own DST, chalk count, ownership sum, salary left, QB salary/ownership).
//   node bench/stack-shapes-nfl.mjs
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const B = {}, add = (k, l) => { const b = B[k] ||= { n: 0, roi: 0, t1: 0, t10: 0 }; b.n++; b.roi += l.roi; b.t1 += l.t1; b.t10 += l.t10; };
const W = { with: [], without: [], fieldWith: [], fieldWithout: [] };
let nC = 0; const slates = {};
for (const c of listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.entries >= 100)) {
  const j = readPost(c.json), P = {}; for (const p of j.players) P[p.id] = p; const N = j.lineups.length, fee = j.contest.fee; nC++;
  const games = new Set(j.players.filter(p => p.team && p.opp).map(p => [p.team, p.opp].sort().join("@"))).size, sz = games >= 9 ? "main 9+" : games >= 5 ? "mid 5-8" : "small 2-4";
  slates[sz] = (slates[sz] || 0) + 1;
  const yr = j.contest.date < "2026-06-01" ? "2025" : "2026", tier = fee >= 100 ? "$100+" : "<$100";
  for (const l of j.lineups) {
    const ps = l.ids.map(i => P[i]).filter(Boolean); if (ps.length < 9) continue; const qb = ps.find(p => p.pos === "QB"); if (!qb) continue;
    const st = Math.min(3, ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(p.pos)).length), bb = Math.min(2, ps.filter(p => p.team === qb.opp && p.pos !== "DST").length);
    const L = { roi: l.aroi ?? -1, t1: l.fin <= N * 0.01 ? 1 : 0, t10: l.fin <= N * 0.1 ? 1 : 0 }, shape = `QB+${st} bb${bb}`;
    for (const k of [`${sz}|${shape}`, `${sz} ${tier}|${shape}`, `${sz} ${yr}|${shape}`]) add(k, L);
    // profile: what the lineup carries besides the QB stack (main slates, QB+1 or more)
    if (sz === "main 9+" && st >= 1) {
      const teams = {}; for (const p of ps) if (p !== qb && p.pos !== "DST" && p.team !== qb.team && p.team !== qb.opp) teams[p.team] = (teams[p.team] || 0) + 1;
      const games2 = {}; for (const p of ps) if (p.pos !== "DST" && p.team !== qb.team && p.team !== qb.opp) { const g = [p.team, p.opp].sort().join(); games2[g] = (games2[g] || 0) + 1; }
      const dst = ps.find(p => p.pos === "DST"), rbDst = dst && ps.some(p => p.pos === "RB" && p.team === dst.team), dstVsQB = dst && dst.opp === qb.team;
      const prof = { st, second: Math.max(0, ...Object.values(teams)), secondGame: Math.max(0, ...Object.values(games2)), rbDst: rbDst ? 1 : 0, chalk: ps.filter(p => p.pown >= 0.2).length, own: 100 * ps.reduce((s, p) => s + p.pown, 0), left: 50000 - l.sal, qbSal: qb.sal, qbOwn: 100 * qb.pown, low: ps.filter(p => p.pown < 0.05).length, dstOpp: dst && ps.some(p => p.team === dst.opp && p.pos !== "QB") ? 1 : 0 };
      if (L.t1) (bb ? W.with : W.without).push(prof);
      if (Math.random() < 0.05) (bb ? W.fieldWith : W.fieldWithout).push(prof);
    }
  }
}
console.log(`${nC} classic contests: ${Object.entries(slates).map(([k, v]) => `${k} games ${v}`).join(", ")}`);
const SH = ["QB+0 bb0", "QB+1 bb0", "QB+1 bb1", "QB+1 bb2", "QB+2 bb0", "QB+2 bb1", "QB+2 bb2", "QB+3 bb0", "QB+3 bb1", "QB+3 bb2"];
const table = (title, pre) => { console.log(`\n${title}   (ROI = real DK ROI per lineup; base top10 10%, top1 1%)`); let tot = 0; for (const s of SH) tot += (B[`${pre}|${s}`] || { n: 0 }).n;
  for (const s of SH) { const b = B[`${pre}|${s}`]; if (!b || b.n < 1500) continue; console.log(`  ${s.padEnd(9)} share ${(100 * b.n / tot).toFixed(1).padStart(5)}%  n ${String(b.n).padStart(8)}  ROI ${(100 * b.roi / b.n).toFixed(1).padStart(6)}%  top10 ${(100 * b.t10 / b.n).toFixed(1).padStart(5)}%  top1 ${(100 * b.t1 / b.n).toFixed(2).padStart(5)}%`); } };
for (const sz of ["main 9+", "mid 5-8", "small 2-4"]) { table(`${sz} games, all`, sz); table(`${sz} games, $100+`, `${sz} $100+`); table(`${sz} games, 2025`, `${sz} 2025`); table(`${sz} games, 2026`, `${sz} 2026`); }
const avg = (A, k) => A.length ? (A.reduce((s, x) => s + x[k], 0) / A.length) : NaN;
console.log("\nMain slates, top-1% lineups with vs without a bring-back (QB+1 or more), and the field for comparison");
console.log(`  ${"".padEnd(26)} ${"top1 w/ BB".padStart(11)} ${"top1 no BB".padStart(11)} ${"field w/ BB".padStart(12)} ${"field no BB".padStart(12)}`);
for (const [k, lab, f] of [["n", "lineups", null], ["st", "QB stack teammates", 2], ["second", "2nd team stack (max)", 2], ["secondGame", "2nd game stack (max)", 2], ["rbDst", "RB + own DST %", "%"], ["dstOpp", "DST vs a rostered player %", "%"], ["chalk", "players 20%+ owned", 2], ["low", "players under 5%", 2], ["own", "ownership sum", 0], ["left", "salary left", 0], ["qbSal", "QB salary", 0], ["qbOwn", "QB ownership", 1]]) {
  const v = A => k === "n" ? A.length : f === "%" ? (100 * avg(A, k)).toFixed(0) + "%" : avg(A, k).toFixed(f);
  console.log(`  ${lab.padEnd(26)} ${String(v(W.with)).padStart(11)} ${String(v(W.without)).padStart(11)} ${String(v(W.fieldWith)).padStart(12)} ${String(v(W.fieldWithout)).padStart(12)}`);
}
