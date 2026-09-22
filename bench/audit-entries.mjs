// Audit an entry file against the rulebook before uploading it.
//   node bench/audit-entries.mjs <entries.csv> <projections.csv> [format=mlb_cl]
//   node bench/audit-entries.mjs data/DKEntries-mlb-test.csv data/2026-09-22-mlb-main/DK_MLB_Main_Data_Hub_Projections.csv
// The entries file is the DraftKings entry export or the Stokastic Entry Manager export (same
// layout: Entry ID, Contest Name, Contest ID, Entry Fee, then "Name (id)" per slot). Rules come
// from rules/<format>.json when present.
import fs from "node:fs";
import { parseCSV } from "../src/engine/csv.mjs";
import { buildPool, FORMATS } from "../src/engine/formats.mjs";
import { parseEntries, auditPortfolio, auditReport } from "../src/engine/audit.mjs";

const [entriesFile, projFile, fkey = "mlb_cl"] = process.argv.slice(2);
if (!entriesFile || !projFile) { console.log("usage: node bench/audit-entries.mjs <entries.csv> <projections.csv> [mlb_cl|nfl_cl|nfl_sd]"); process.exit(1); }
const f = FORMATS[fkey]; if (!f) { console.log("unknown format " + fkey); process.exit(1); }
const pr = parseCSV(fs.readFileSync(projFile, "utf8"));
const pool = buildPool(pr[0], pr.slice(1), fkey);
for (const p of pool.players) if (p.fown == null) p.fown = p.own;
const rulesPath = `rules/${fkey}.json`;
const rules = fs.existsSync(rulesPath) ? JSON.parse(fs.readFileSync(rulesPath, "utf8")) : null;
const parsed = parseEntries(fs.readFileSync(entriesFile, "utf8"), f);
const a = auditPortfolio(parsed, pool.players, f, rules, null);
console.log(`${entriesFile} vs ${projFile} (${pool.players.length} players, rules: ${rules ? rules.rules.length : "none"})\n`);
console.log(auditReport(a, pool.players));
