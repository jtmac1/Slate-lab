// Pull Stokastic post-contest results straight from their API for the contests you entered.
// Contest ids are DraftKings contest keys, taken from the DK contest history export in
// data/dk-history. Each contest is saved once as data/post/<sport>/<date>-<key>.json holding
// the lineup, player and stack responses. Re-running skips what is already saved.
//   node bench/pull-stokastic.mjs 2026-08-01              one day
//   node bench/pull-stokastic.mjs 2026-08-01 2026-08-31   a range
//   node bench/pull-stokastic.mjs 2026-08-01 2026-08-31 MLB
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";

const API = "https://app-api-dfs-prod-main.azurewebsites.net/api/contests/";
const [from, to = from, sportArg = ""] = process.argv.slice(2);
if (!from) { console.error("usage: node bench/pull-stokastic.mjs <from> [to] [sport]"); process.exit(1); }
const money = s => +String(s).replace(/[$,]/g, "") || 0, sleep = ms => new Promise(r => setTimeout(r, ms));

// contests entered, from the newest DK history file
const hist = fs.readdirSync("data/dk-history").filter(f => f.endsWith(".csv")).sort().pop();
const rows = parseCSV(fs.readFileSync(path.join("data/dk-history", hist), "utf8")).slice(1);
const C = {};
for (const r of rows) {
  const sport = r[0], date = r[5].slice(0, 10), name = r[3].replace(/\s*\(\d+\/\d+\)$/, "");
  if (date < from || date > to || (sportArg && sport !== sportArg.toUpperCase()) || /Satellite/i.test(name)) continue;
  const g = C[r[4]] || (C[r[4]] = { key: r[4], sport, type: r[1], date, lock: r[5].slice(11, 16), name, entries: +r[10], fee: money(r[11]), paid: +r[13], mine: [] });
  g.mine.push({ entry: r[2], place: +r[6], points: +r[7], won: money(r[8]) + money(r[9]) });
}
const list = Object.values(C).sort((a, b) => a.date.localeCompare(b.date) || b.fee - a.fee);
console.log(`${list.length} contests entered ${from}${to !== from ? " to " + to : ""}${sportArg ? " (" + sportArg + ")" : ""} in ${hist}`);

const get = async q => { const r = await fetch(API + q); if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 40)}`); return r.json(); };
let pulled = 0, skipped = 0, failed = 0;
for (const c of list) {
  const dir = path.join("data/post", c.sport.toLowerCase()), file = path.join(dir, `${c.date}-${c.key}.json`);
  if (fs.existsSync(file)) { skipped++; continue; }
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  try {
    const common = `siteContestId=${c.key}&user=&currentPage=1&pageSize=150&contestType=PostContest`;
    const lineups = await get(`getRoiByLineup?${common}&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=true`);
    const players = await get(`getRoiByPlayer?${common}&opponent=&sortBy=SIMROI&sortOrder=DESC&includeAllPLayers=true`);
    const stacks = await get(`getRoiByStack?${common}&includeAllStacks=true`);
    if (!Array.isArray(lineups) || !lineups.length) throw new Error("no lineups (not simulated yet?)");
    fs.writeFileSync(file, JSON.stringify({ contest: c, pulledAt: new Date().toISOString(), lineups, players, stacks }));
    pulled++;
    console.log(`  ${c.date} ${c.sport} ${c.name.slice(0, 60).padEnd(60)} ${String(lineups.length).padStart(6)} lineups ${String(players.length).padStart(4)} players  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB  ${Date.now() - t0} ms`);
  } catch (e) { failed++; console.log(`  ${c.date} ${c.sport} ${c.name.slice(0, 60).padEnd(60)} FAILED: ${e.message}`); }
  await sleep(400);
}
console.log(`pulled ${pulled}, already had ${skipped}, failed ${failed}`);
