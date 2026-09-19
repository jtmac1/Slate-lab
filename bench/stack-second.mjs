// How big is the SECOND team block in real lineups? The generator builds one quarterback stack and
// a bring-back and then fills every other slot independently, which is why the pooled field check
// shows it under-building 4-3-1 and 3-3-1-1 and over-building scattered shapes. This measures the
// distribution of the second largest team count in real entries, split by how many games are on the
// slate, which is the same split the primary stack shares already use.
//   node bench/stack-second.mjs [cfb_cl]
import { listContests, loadPulled } from "./grade-all.mjs";
const FKEY = process.argv[2] || "cfb_cl";

const buckets = [["<=2 games", 0, 2], ["3-5 games", 3, 5], ["6-9 games", 6, 9], ["10+ games", 10, 99]];
const acc = buckets.map(() => ({ n: 0, sec: {}, primary: {} }));
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  const { pool, entries } = loadPulled(c.json);
  const ng = pool.games.length, bi = buckets.findIndex(b => ng >= b[1] && ng <= b[2]);
  if (bi < 0) continue;
  const a = acc[bi], P = pool.players;
  for (const e of entries) {
    const tc = {};
    for (const id of e.lu) { const t = P[id].team; if (t) tc[t] = (tc[t] || 0) + 1; }
    const sorted = Object.values(tc).sort((x, y) => y - x);
    const p1 = sorted[0] || 0, p2 = sorted[1] || 0;
    a.n++; a.primary[p1] = (a.primary[p1] || 0) + 1; a.sec[p2] = (a.sec[p2] || 0) + 1;
  }
}
const pct = (t, k) => (100 * (t[k] || 0) / Object.values(t).reduce((x, y) => x + y, 0)).toFixed(1);
console.log("slate size".padEnd(12) + "entries".padEnd(10) + "second team block size, share of entries");
console.log("".padEnd(22) + [1, 2, 3, 4, 5].map(k => String(k).padEnd(8)).join(""));
for (let i = 0; i < buckets.length; i++) {
  const a = acc[i]; if (!a.n) continue;
  console.log(buckets[i][0].padEnd(12) + String(a.n).padEnd(10) + [1, 2, 3, 4, 5].map(k => (pct(a.sec, k) + "%").padEnd(8)).join(""));
}
console.log("\nfor reference, the largest team block:");
console.log("".padEnd(22) + [1, 2, 3, 4, 5].map(k => String(k).padEnd(8)).join(""));
for (let i = 0; i < buckets.length; i++) {
  const a = acc[i]; if (!a.n) continue;
  console.log(buckets[i][0].padEnd(12) + String(a.n).padEnd(10) + [1, 2, 3, 4, 5].map(k => (pct(a.primary, k) + "%").padEnd(8)).join(""));
}
