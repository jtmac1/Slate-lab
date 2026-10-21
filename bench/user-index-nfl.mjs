// Every DK user in the NFL classic archive with their entry count and top-10% finishes, for the contest picker
// (server/picker.mjs): a contest's entrants are "unknown" with fewer than 30 archive entries and "proven" at a
// 13%+ top-10% rate (bench/contest-picker-nfl.mjs backtest, 2026-10-14).
//   node bench/user-index-nfl.mjs  -> data/reports/user-index-nfl.json { built, contests, users: { name: [entries, top10] } }
import fs from "node:fs";
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const users = {}; let contests = 0;
for (const c of listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl")) {
  const j = readPost(c.json), N = j.lineups.length; if (N < 100) continue; contests++;
  for (const l of j.lineups) { const u = l.u.toLowerCase(), r = users[u] || (users[u] = [0, 0]); r[0]++; if (l.fin <= N * 0.1) r[1]++; }
}
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/user-index-nfl.json", JSON.stringify({ built: new Date().toISOString(), contests, users }));
console.log(`${Object.keys(users).length} users from ${contests} classic contests -> data/reports/user-index-nfl.json`);
