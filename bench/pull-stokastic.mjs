// Pull Stokastic post-contest results straight from their API for the contests you entered.
// Contest ids are DraftKings contest keys, taken from the DK contest history export in
// data/dk-history. Each contest is saved once, compact and gzipped, as
// data/post/<sport>/<date>-<key>.json.gz (see post-store.mjs). Re-running skips what is saved.
//   node bench/pull-stokastic.mjs 2026-08-01                       one day
//   node bench/pull-stokastic.mjs 2026-08-01 2026-08-31 MLB        a range, one sport
//   node bench/pull-stokastic.mjs 2025-09-01 2026-02-28 NFL --island --max 20000
//   node bench/pull-stokastic.mjs --slate 35987 [--max N]     every contest Stokastic simulated on a slate (slate ids: bench/pull-projections.mjs)
// --island  NFL showdowns on stand-alone games only (Mon-Sat, or Sunday 7pm+ kickoffs)
// --max N   contests with more than N entries store players and stacks but not lineups
// --type T  only contests of this DK game type (Classic, Showdown)
// --minfee F  skip contests with an entry fee under F
// --skip-big  skip contests over --max entirely (no player table) instead of storing players only
// --par N     pull N contests at a time (default 1)
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";
import { compact, writePost, postFile } from "./post-store.mjs";

const API = "https://app-api-dfs-prod-main.azurewebsites.net/api/contests/";
const args = process.argv.slice(2), flags = args.filter(a => a.startsWith("--")), pos = args.filter(a => !a.startsWith("--"));
const [from, to = from, sportArg = ""] = pos;
const ISLAND = flags.includes("--island"), MAX = flags.includes("--max") ? +args[args.indexOf("--max") + 1] : Infinity, SLATE = flags.includes("--slate") ? args[args.indexOf("--slate") + 1] : null, TYPE = flags.includes("--type") ? args[args.indexOf("--type") + 1] : null, MINFEE = flags.includes("--minfee") ? +args[args.indexOf("--minfee") + 1] : 0, SKIPBIG = flags.includes("--skip-big"), PAR = flags.includes("--par") ? Math.max(1, +args[args.indexOf("--par") + 1] || 1) : 1;
if (!from && !SLATE) { console.error("usage: node bench/pull-stokastic.mjs <from> [to] [sport] [--island] [--max N]"); process.exit(1); }
const money = s => +String(s).replace(/[$,]/g, "") || 0, sleep = ms => new Promise(r => setTimeout(r, ms));
const weekday = d => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T12:00:00Z").getUTCDay()];

// contests entered, from the newest DK history file
const hist = fs.readdirSync("data/dk-history").filter(f => f.endsWith(".csv")).sort().pop();
const rows = SLATE ? [] : parseCSV(fs.readFileSync(path.join("data/dk-history", hist), "utf8")).slice(1);
const C = {};
for (const r of rows) {
  const sport = r[0], type = r[1], date = r[5].slice(0, 10), hour = +r[5].slice(11, 13), name = r[3].replace(/\s*\(\d+\/\d+\)$/, "");
  if (date < from || date > to || (sportArg && sport !== sportArg.toUpperCase()) || /Satellite/i.test(name)) continue;
  if (TYPE && type.toLowerCase() !== TYPE.toLowerCase()) continue;
  if (MINFEE && money(r[11]) < MINFEE) continue;
  if (ISLAND && !(sport === "NFL" && /Showdown/i.test(type) && (weekday(date) !== "Sun" || hour >= 19))) continue;
  const g = C[r[4]] || (C[r[4]] = { key: r[4], sport, type, date, lock: r[5].slice(11, 16), name, entries: +r[10], fee: money(r[11]), paid: +r[13], mine: [] });
  g.mine.push({ entry: r[2], place: +r[6], points: +r[7], won: money(r[8]) + money(r[9]) });
}
let list = Object.values(C).sort((a, b) => a.date.localeCompare(b.date) || b.fee - a.fee);
if (SLATE) {
  // every contest Stokastic simulated on the slate, entered or not (places paid unknown here: 0)
  const sc = await (await fetch(API + "getSimulatedContests?slateId=" + SLATE)).json();
  list = sc.filter(c => c.site === "DK" && !/Satellite/i.test(c.name)).map(c => ({ key: String(c.siteContestId), sport: c.sport, type: c.type === "SHOWDOWN" ? "Showdown" : "Classic", date: c.startTime.slice(0, 10), lock: c.startTime.slice(11, 16), name: c.name.trim(), entries: c.entryCount, fee: c.entryFee, paid: 0, maxEntries: c.maxPlayerEntries, mine: [] })).sort((a, b) => b.fee - a.fee);
}
console.log(SLATE ? `${list.length} contests Stokastic simulated on slate ${SLATE}` : `${list.length} contests entered ${from}${to !== from ? " to " + to : ""}${sportArg ? " (" + sportArg + ")" : ""}${ISLAND ? ", island games" : ""} in ${hist}`);

const get = async q => { const r = await fetch(API + q); if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 40)}`); return r.json(); };
let pulled = 0, skipped = 0, failed = 0, bytes = 0;
let skippedBig = 0;
async function pullOne(c) {
  const file = postFile(c);
  if (fs.existsSync(file) || fs.existsSync(file.replace(/.gz$/, ""))) { skipped++; return; }
  if (SKIPBIG && c.entries > MAX) { skippedBig++; return; }
  const t0 = Date.now();
  try {
    const common = `siteContestId=${c.key}&user=&currentPage=1&pageSize=150&contestType=PostContest`;
    const players = await get(`getRoiByPlayer?${common}&opponent=&sortBy=SIMROI&sortOrder=DESC&includeAllPLayers=true`);
    if (!Array.isArray(players) || !players.length) throw new Error("no players (not simulated?)");
    const stacks = await get(`getRoiByStack?${common}&includeAllStacks=true`);
    const big = c.entries > MAX, lineups = big ? [] : await get(`getRoiByLineup?${common}&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=true`);
    if (!big && (!Array.isArray(lineups) || !lineups.length)) throw new Error("no lineups (not simulated?)");
    writePost(file, compact({ contest: c, pulledAt: new Date().toISOString(), lineupsSkipped: big, lineups, players, stacks }));
    const sz = fs.statSync(file).size; bytes += sz; pulled++;
    console.log(`  ${c.date} ${c.sport} ${c.name.slice(0, 60).padEnd(60)} ${big ? "players only" : String(lineups.length).padStart(6) + " lineups"} ${String(players.length).padStart(4)} players  ${(sz / 1e6).toFixed(2)} MB  ${Date.now() - t0} ms`);
  } catch (e) { failed++; console.log(`  ${c.date} ${c.sport} ${c.name.slice(0, 60).padEnd(60)} FAILED: ${e.message}`); }
  await sleep(300);
}
let next = 0;
await Promise.all(Array.from({ length: PAR }, async () => { while (next < list.length) { const c = list[next++]; await pullOne(c); } }));
if (skippedBig) console.log(`skipped ${skippedBig} contests over ${MAX} entries (--skip-big)`);
console.log(`pulled ${pulled} (${(bytes / 1e6).toFixed(0)} MB), already had ${skipped}, failed ${failed}`);
