// Who wins consistently in the pulled contests, and how do they build? A user is "sharp" on
// volume and finish consistency (top-10% finish rate vs the field's 10%, z-score), not raw ROI,
// which one big hit can fake. Then compare construction: ownership sum, leverage (actual vs
// projected ownership of the players they use), stack shapes, salary, dupes, pitcher choice,
// entries per contest, and how often their lineups sit in Stokastic's top sim-ROI decile.
//   node bench/sharps.mjs [sport] [minContests] [you]
import fs from "node:fs";
import path from "node:path";

const sport = (process.argv[2] || "mlb").toLowerCase(), MINC = +(process.argv[3] || 30), YOU = process.argv[4] || "jtmac1999";
const dir = path.join("data/post", sport), files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0, pct = v => (100 * v).toFixed(0) + "%";
const stackKey = info => String(info || "").split("|").map(s => +s.trim().split(" ").pop()).filter(n => n >= 2).sort((a, b) => b - a).join("-") || "none";

const U = {}; const field = { n: 0, top10: 0, cash: 0, own: 0, lev: 0, sal: 0, dup: 0, simTop: 0, pitOwn: 0, stacks: {}, roi: 0 };
const add = (u, m) => { for (const k of ["n", "top10", "cash", "own", "lev", "sal", "dup", "simTop", "pitOwn", "roi"]) u[k] += m[k]; u.stacks[m.stack] = (u.stacks[m.stack] || 0) + 1; };
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), c = j.contest, N = j.lineups.length;
  const byId = {}; for (const p of j.players) byId[(String(p.exportableNameAndId).match(/\((\d+)\)/) || [])[1]] = p;
  const simRank = j.lineups.map((l, i) => i).sort((a, b) => j.lineups[b].simLineupRoi - j.lineups[a].simLineupRoi), simTopSet = new Set(simRank.slice(0, Math.ceil(N / 10)));
  const perUser = {};
  j.lineups.forEach((l, i) => {
    const ps = l.exportableLineup.split(",").map(s => byId[(s.match(/\((\d+)\)/) || [])[1]]).filter(Boolean);
    const lev = mean(ps.map(p => (p.overallOwnership || 0) - (p.projectedOwnership || 0))) * 100;   // + = played chalk that got chalkier
    const pit = ps.filter(p => /SP|RP/.test(p.position)), pitOwn = mean(pit.map(p => 100 * (p.overallOwnership || 0)));
    const m = { n: 1, top10: l.actualFinishPosition <= N / 10 ? 1 : 0, cash: l.actualLineupRoi > -1 ? 1 : 0, own: 100 * l.ownershipSum, lev, sal: l.salary, dup: l.duplicates > 0 ? 1 : 0, simTop: simTopSet.has(i) ? 1 : 0, pitOwn, stack: stackKey(l.stackInfo), roi: c.fee * (1 + (l.actualLineupRoi ?? -1)) };
    add(field, m);
    const u = U[l.user] || (U[l.user] = { user: l.user, n: 0, top10: 0, cash: 0, own: 0, lev: 0, sal: 0, dup: 0, simTop: 0, pitOwn: 0, roi: 0, fee: 0, stacks: {}, contests: new Set(), perContest: [] });
    add(u, m); u.fee += c.fee; u.contests.add(c.key); perUser[l.user] = (perUser[l.user] || 0) + 1;
  });
  for (const [user, k] of Object.entries(perUser)) U[user].perContest.push(k);
}
const users = Object.values(U).map(u => { const p = 0.1, z = (u.top10 / u.n - p) / Math.sqrt(p * (1 - p) / u.n); return Object.assign(u, { c: u.contests.size, z, roiPct: u.roi / u.fee - 1, epc: mean(u.perContest) }); });
const vol = users.filter(u => u.c >= MINC);
const sharps = vol.filter(u => u.z >= 2.5 && u.roiPct > 0).sort((a, b) => b.z - a.z);
const fish = vol.filter(u => u.z <= -2.5).sort((a, b) => a.z - b.z);
console.log(`${files.length} ${sport.toUpperCase()} contests, ${field.n} entries, ${users.length} users; ${vol.length} with ${MINC}+ contests; sharps (top-10% rate z>=2.5 and ROI>0): ${sharps.length}; fish (z<=-2.5): ${fish.length}`);

const prof = (list, label) => { const g = { n: 0, top10: 0, cash: 0, own: 0, lev: 0, sal: 0, dup: 0, simTop: 0, pitOwn: 0, roi: 0, stacks: {} }; let fee = 0; for (const u of list) { add(g, Object.assign({}, u, { stack: "x" })); for (const k in u.stacks) g.stacks[k] = (g.stacks[k] || 0) + u.stacks[k]; fee += u.fee; } delete g.stacks.x;
  const st = Object.entries(g.stacks).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${pct(v / g.n)}`).join(" ");
  return label.padEnd(22) + String(g.n).padStart(7) + pct(g.top10 / g.n).padStart(8) + pct(g.cash / g.n).padStart(7) + (fee ? pct(g.roi / fee - 1) : "").padStart(7) + (g.own / g.n).toFixed(0).padStart(7) + (g.lev / g.n).toFixed(2).padStart(7) + (g.sal / g.n).toFixed(0).padStart(7) + pct(g.dup / g.n).padStart(6) + pct(g.simTop / g.n).padStart(8) + (g.pitOwn / g.n).toFixed(0).padStart(7) + "   " + st; };
console.log("\n".padEnd(23) + "entries  top10%  cash%    ROI ownsum    lev salary  dup% simTop10 pitOwn   stacks");
console.log(prof([Object.assign({ fee: field.roi ? 0 : 0 }, field)].map(f => Object.assign(f, { fee: 0 })), "whole field").replace(/\s{7}/, "       "));
console.log(prof(sharps, `sharps (${sharps.length})`));
console.log(prof(fish, `fish (${fish.length})`));
const you = users.find(u => u.user === YOU); if (you) console.log(prof([you], YOU));

console.log(`\ntop sharps (${MINC}+ contests, sorted by finish z-score):`);
console.log("user".padEnd(18) + "contests entries  ent/ct  top10%  cash%    ROI  fees    ownsum    lev  dup% simTop10   main stacks");
for (const u of sharps.slice(0, 15)) console.log(u.user.slice(0, 17).padEnd(18) + String(u.c).padStart(8) + String(u.n).padStart(8) + u.epc.toFixed(1).padStart(8) + pct(u.top10 / u.n).padStart(8) + pct(u.cash / u.n).padStart(7) + pct(u.roiPct).padStart(7) + ("$" + (u.fee / 1000).toFixed(0) + "K").padStart(6) + (u.own / u.n).toFixed(0).padStart(8) + (u.lev / u.n).toFixed(2).padStart(7) + pct(u.dup / u.n).padStart(6) + pct(u.simTop / u.n).padStart(9) + "   " + Object.entries(u.stacks).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v / u.n)}`).join(" "));
console.log("\ncolumns: lev = actual minus projected ownership of the players used (per player, pts; + means they were on chalk that got chalkier); simTop10 = share of their lineups in Stokastic's top sim-ROI decile; pitOwn = actual ownership of their pitchers");
