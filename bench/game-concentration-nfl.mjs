// How many players from one game? (user, 2026-10-15: "double check you truly want 5 in a single game"). Classic archive,
// every real lineup: most players from any one game (DST excluded), with real ROI (DK payout at the finish, duplicates already
// split by DK) and top-10% / top-1% rates; by season, fee tier, field size, and within the same QB stack + bring-back shape so
// "5 from one game" isn't just "QB+3 with bring-backs" in disguise. Also: is a second mini-stack (2+ from another game) better?
//   node bench/game-concentration-nfl.mjs
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const B = {}, add = (k, l) => { const b = B[k] ||= { n: 0, roi: 0, roiC: 0, t1: 0, t10: 0, contests: new Set() }; b.n++; b.roi += l.roi; b.roiC += Math.min(l.roi, 20); b.t1 += l.t1; b.t10 += l.t10; b.contests.add(l.c); };
let nC = 0;
for (const c of listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.entries >= 100)) {
  const j = readPost(c.json), P = {}; for (const p of j.players) P[p.id] = p; const N = j.lineups.length, fee = j.contest.fee; nC++;
  const yr = j.contest.date < "2026-06-01" ? "2025" : "2026", tier = fee >= 100 ? "$100+" : "$5-99", size = N < 1500 ? "<1.5K" : N < 10000 ? "1.5-10K" : "10K+";
  for (const l of j.lineups) {
    const ps = l.ids.map(i => P[i]).filter(Boolean); if (ps.length < 9) continue; const qb = ps.find(p => p.pos === "QB"); if (!qb) continue;
    const gm = {}; for (const p of ps) if (p.pos !== "DST") { const g = [p.team, p.opp].sort().join(); gm[g] = (gm[g] || 0) + 1; }
    const counts = Object.values(gm).sort((a, b) => b - a), mx = Math.min(counts[0], 7), second = counts[1] || 0;
    const st = Math.min(3, ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(p.pos)).length), bb = Math.min(2, ps.filter(p => p.team === qb.opp && p.pos !== "DST").length);
    const L = { roi: l.aroi ?? -1, t1: l.fin <= N * 0.01 ? 1 : 0, t10: l.fin <= N * 0.1 ? 1 : 0, c: c.dir };
    for (const k of [`all|${mx}`, `${yr}|${mx}`, `${tier}|${mx}`, `${tier} ${yr}|${mx}`, `size ${size}|${mx}`, `shape QB+${st} bb${bb}|${mx}`, `second|${mx}|${Math.min(second, 3)}`]) add(k, L);
  }
}
console.log(`${nC} classic contests. Most players from one game (DST excluded): ROI = real DK ROI per lineup (duplicates split); capped = each lineup capped at +2000%`);
const show = (title, prefix) => { console.log(`\n${title}`); for (let m = 2; m <= 7; m++) { const b = B[`${prefix}|${m}`]; if (!b || b.n < 2000) continue;
  console.log(`  ${m}${m === 7 ? "+" : " "} from one game  n ${String(b.n).padStart(8)}  ROI ${(100 * b.roi / b.n).toFixed(1).padStart(6)}%  capped ${(100 * b.roiC / b.n).toFixed(1).padStart(6)}%  top10 ${(100 * b.t10 / b.n).toFixed(1).padStart(5)}%  top1 ${(100 * b.t1 / b.n).toFixed(2).padStart(5)}%`); } };
show("All", "all"); show("2025", "2025"); show("2026", "2026"); show("$100+", "$100+"); show("$100+ 2025", "$100+ 2025"); show("$100+ 2026", "$100+ 2026"); show("$5-99", "$5-99");
show("Field under 1,500", "size <1.5K"); show("Field 1,500-10K", "size 1.5-10K"); show("Field 10K+", "size 10K+");
for (const s of ["QB+1 bb1", "QB+2 bb0", "QB+2 bb1", "QB+2 bb2", "QB+3 bb1", "QB+3 bb2"]) show(`Within shape ${s} (does adding more from the game beyond the stack help?)`, `shape ${s}`);
console.log("\nSecond mini-stack: rows = most from one game, then 2nd game count (0-1 / 2 / 3+)");
for (let m = 3; m <= 6; m++) { const parts = [1, 2, 3].map(s => { const b = s === 1 ? (() => { const a = B[`second|${m}|0`], b2 = B[`second|${m}|1`]; if (!a && !b2) return null; const z = { n: 0, roi: 0, roiC: 0, t1: 0, t10: 0 }; for (const x of [a, b2]) if (x) for (const k of ["n", "roi", "roiC", "t1", "t10"]) z[k] += x[k]; return z; })() : B[`second|${m}|${s}`];
  return b && b.n >= 2000 ? `${s === 1 ? "0-1" : s === 3 ? "3+" : s}: ROI ${(100 * b.roi / b.n).toFixed(1)}% capped ${(100 * b.roiC / b.n).toFixed(1)}% top1 ${(100 * b.t1 / b.n).toFixed(2)}% (${b.n})` : `${s === 1 ? "0-1" : s === 3 ? "3+" : s}: -`; });
  console.log(`  ${m} from one game | ${parts.join("  |  ")}`); }
