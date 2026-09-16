// Who wins consistently in the pulled contests, and how do they build? A user is "sharp" on
// volume and finish consistency (top-10% finish rate vs the field's 10%, z-score), not raw ROI,
// which one big hit can fake. Then compare construction: ownership sum, leverage (actual vs
// projected ownership of the players they use), stack shapes, salary, dupes, pitcher choice,
// entries per contest, and how often their lineups sit in Stokastic's top sim-ROI decile.
//   node bench/sharps.mjs [sport] [minContests] [you] [from]
import { listPost, readPost, isPitcher, dateOf } from "./post-store.mjs";

const sport = (process.argv[2] || "mlb").toLowerCase(), MINC = +(process.argv[3] || 30), YOU = process.argv[4] || "jtmac1999", FROM = process.argv[5] || "";
const files = listPost(sport, f => !FROM || f.slice(0, 10) >= FROM);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0, pct = v => (100 * v).toFixed(0) + "%";
export const stackKey = info => String(info || "").split("|").map(s => +s.trim().split(" ").pop()).filter(n => n >= 2).sort((a, b) => b - a).join("-") || "none";

const U = {}; const field = { n: 0, top10: 0, cash: 0, own: 0, lev: 0, sal: 0, dup: 0, simTop: 0, pitOwn: 0, stacks: {}, roi: 0 };
const add = (u, m) => { for (const k of ["n", "top10", "cash", "own", "lev", "sal", "dup", "simTop", "pitOwn", "roi"]) u[k] += m[k]; u.stacks[m.stack] = (u.stacks[m.stack] || 0) + 1; };
let nContests = 0;
for (const f of files) {
  const j = readPost(f); if (!j.lineups.length) continue; nContests++;
  const c = j.contest, N = j.lineups.length, byId = {}; for (const p of j.players) byId[p.id] = p;
  const simRank = j.lineups.map((l, i) => i).sort((a, b) => (j.lineups[b].sroi ?? -9) - (j.lineups[a].sroi ?? -9)), simTopSet = new Set(simRank.slice(0, Math.ceil(N / 10)));
  const perUser = {};
  j.lineups.forEach((l, i) => {
    const ps = l.ids.map(id => byId[id]).filter(Boolean);
    const lev = mean(ps.map(p => p.aown - p.pown)) * 100, pit = ps.filter(p => isPitcher(p.pos)), pitOwn = mean(pit.map(p => 100 * p.aown));
    const m = { n: 1, top10: l.fin != null && l.fin <= N / 10 ? 1 : 0, cash: (l.aroi ?? -1) > -1 ? 1 : 0, own: 100 * (l.own || 0), lev, sal: l.sal, dup: l.dup > 0 ? 1 : 0, simTop: simTopSet.has(i) ? 1 : 0, pitOwn, stack: stackKey(l.stack), roi: c.fee * (1 + (l.aroi ?? -1)) };
    add(field, m);
    const u = U[l.u] || (U[l.u] = { user: l.u, n: 0, top10: 0, cash: 0, own: 0, lev: 0, sal: 0, dup: 0, simTop: 0, pitOwn: 0, roi: 0, fee: 0, stacks: {}, contests: new Set(), perContest: [] });
    add(u, m); u.fee += c.fee; u.contests.add(c.key); perUser[l.u] = (perUser[l.u] || 0) + 1;
  });
  for (const [user, k] of Object.entries(perUser)) U[user].perContest.push(k);
}
const users = Object.values(U).map(u => { const p = 0.1, z = (u.top10 / u.n - p) / Math.sqrt(p * (1 - p) / u.n); return Object.assign(u, { c: u.contests.size, z, roiPct: u.roi / u.fee - 1, epc: mean(u.perContest) }); });
const MINFEE = +(process.argv[6] || 2000);   // real money over the window, not $1 grinders
const vol = users.filter(u => u.c >= MINC && u.fee >= MINFEE);
const sharps = vol.filter(u => u.z >= 2.5 && u.roiPct > 0).sort((a, b) => b.z - a.z);
const fish = vol.filter(u => u.z <= -2.5).sort((a, b) => a.z - b.z);
console.log(`${nContests} ${sport.toUpperCase()} contests, ${field.n} entries, ${users.length} users; ${vol.length} with ${MINC}+ contests; sharps (top-10% rate z>=2.5 and ROI>0): ${sharps.length}; fish (z<=-2.5): ${fish.length}`);

const prof = (list, label, fee) => { const g = { n: 0, top10: 0, cash: 0, own: 0, lev: 0, sal: 0, dup: 0, simTop: 0, pitOwn: 0, roi: 0, stacks: {} }; for (const u of list) { add(g, Object.assign({}, u, { stack: "x" })); for (const k in u.stacks) g.stacks[k] = (g.stacks[k] || 0) + u.stacks[k]; } delete g.stacks.x;
  const st = Object.entries(g.stacks).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${pct(v / g.n)}`).join(" ");
  return label.padEnd(22) + String(g.n).padStart(7) + pct(g.top10 / g.n).padStart(8) + pct(g.cash / g.n).padStart(7) + (fee ? pct(g.roi / fee - 1) : "").padStart(7) + (g.own / g.n).toFixed(0).padStart(7) + (g.lev / g.n).toFixed(2).padStart(7) + (g.sal / g.n).toFixed(0).padStart(7) + pct(g.dup / g.n).padStart(6) + pct(g.simTop / g.n).padStart(8) + (g.pitOwn / g.n).toFixed(0).padStart(7) + "   " + st; };
console.log("\n".padEnd(23) + "entries  top10%  cash%    ROI ownsum    lev salary  dup% simTop10 pitOwn   stacks");
console.log(prof([field], "whole field", 0));
console.log(prof(sharps, `sharps (${sharps.length})`, sharps.reduce((s, u) => s + u.fee, 0)));
console.log(prof(fish, `fish (${fish.length})`, fish.reduce((s, u) => s + u.fee, 0)));
const you = users.find(u => u.user === YOU); if (you) console.log(prof([you], YOU, you.fee));

console.log(`\ntop sharps (${MINC}+ contests, sorted by finish z-score):`);
console.log("user".padEnd(18) + "contests entries  ent/ct  top10%  cash%    ROI  fees    ownsum    lev  dup% simTop10   main stacks");
for (const u of sharps.slice(0, 15)) console.log(u.user.slice(0, 17).padEnd(18) + String(u.c).padStart(8) + String(u.n).padStart(8) + u.epc.toFixed(1).padStart(8) + pct(u.top10 / u.n).padStart(8) + pct(u.cash / u.n).padStart(7) + pct(u.roiPct).padStart(7) + ("$" + (u.fee / 1000).toFixed(0) + "K").padStart(6) + (u.own / u.n).toFixed(0).padStart(8) + (u.lev / u.n).toFixed(2).padStart(7) + pct(u.dup / u.n).padStart(6) + pct(u.simTop / u.n).padStart(9) + "   " + Object.entries(u.stacks).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v / u.n)}`).join(" "));
console.log("\ncolumns: lev = actual minus projected ownership of the players used (per player, pts; + means they were on chalk that got chalkier); simTop10 = share of their lineups in Stokastic's top sim-ROI decile; pitOwn = actual ownership of their pitchers (NFL: n/a)");
