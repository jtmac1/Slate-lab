// Recover the Stokastic pre-lock projection file (with vendor Std Dev and captain ownership) for
// every pulled showdown contest, using data/stk-slates.json (bench/stk-slate-index.mjs) to find
// the slate by date and teams. Writes data/vendor/nfl_sd/<date>-<teams>.csv and map.json
// (contest key -> file). Grade with: node bench/grade-all.mjs 3000 nfl_sd --vendor ...
//   node bench/stk-vendor-files.mjs [fkey=nfl_sd]
import fs from "node:fs";
import path from "node:path";
import { listContests, loadPulled } from "./grade-all.mjs";
import { stkProjections, stkToCSV, stkEastern } from "../src/engine/stokastic.mjs";
const fkey = process.argv[2] || "nfl_sd", sport = fkey.startsWith("nfl") ? "NFL" : "MLB", wantType = fkey.endsWith("_sd") ? "SHOWDOWN" : "CLASSIC";
const idx = JSON.parse(fs.readFileSync("data/stk-slates.json", "utf8")), outDir = path.join("data/vendor", fkey), mapFile = path.join(outDir, "map.json");
fs.mkdirSync(outDir, { recursive: true });
const map = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
const slates = Object.entries(idx).filter(([, s]) => s.sport === sport && s.type === wantType && s.first).map(([id, s]) => ({ id: +id, teams: s.teams.join("|"), date: stkEastern(s.first).toLocaleString("sv-SE").slice(0, 10), first: s.first, updated: s.updated }));
console.log(`${slates.length} ${sport} ${wantType} slates in the index`);
let hit = 0, miss = 0, had = 0; const misses = [];
for (const c of listContests().filter(c => c.fkey === fkey && c.json)) {
  if (map[c.key]) { had++; continue; }
  const { pool } = loadPulled(c.json), teams = pool.teams.slice().sort().join("|");
  const cands = slates.filter(s => s.teams === teams && Math.abs(new Date(s.date) - new Date(c.date)) <= 864e5);
  if (!cands.length) { miss++; misses.push(`${c.date} ${teams}`); continue; }
  const s = cands.sort((a, b) => Math.abs(new Date(a.date) - new Date(c.date)) - Math.abs(new Date(b.date) - new Date(c.date)))[0];
  const file = path.join(outDir, `${c.date}-${teams.replace("|", "")}.csv`);
  if (!fs.existsSync(file)) { const proj = await stkProjections(s.id); fs.writeFileSync(file, stkToCSV(proj, sport)); }
  map[c.key] = { file, slateId: s.id, updated: s.updated }; hit++;
}
fs.writeFileSync(mapFile, JSON.stringify(map, null, 1));
console.log(`matched ${hit} new + ${had} existing contests to vendor files; ${miss} without a slate${misses.length ? " (" + [...new Set(misses)].slice(0, 8).join("; ") + ")" : ""}`);
