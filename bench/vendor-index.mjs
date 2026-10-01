// Which slate folders carry which vendor files? The projection blend and per-player tail work
// (Blick P(Expl)/P(Mega), ETR projections) can only be back-tested on slates where the files were
// saved before lock, so this lists coverage per slate and flags the gaps for the nightly report.
//   node bench/vendor-index.mjs            prints coverage, writes data/reports/vendor-index.json
// Expected files inside data/<date>-<sport>-<slate>/:
//   Stokastic  DK_<SPORT>_<Slate>_Data_Hub_Projections.csv   (bench/pull-projections.mjs)
//   Blick MLB  mlb-hitters-<date>.csv, mlb-pitchers-<date>.csv, mlb-stacks-<date>.csv
//   Blick NFL  nfl-main-slate-*.csv or nfl-*-showdown-*.csv
//   ETR        ETR-*.csv (NFL main saved under data/etr/<date>-nfl-main-dk.csv)
import fs from "node:fs";
import path from "node:path";
const rows = [];
for (const d of fs.readdirSync("data").filter(d => /^\d{4}-\d{2}-\d{2}-(mlb|nfl|cfb)-/.test(d)).sort()) {
  const files = fs.readdirSync(path.join("data", d)), date = d.slice(0, 10), sport = d.split("-")[3];
  const has = re => files.some(f => re.test(f)) || (sport === "nfl" && fs.existsSync("data/etr") && fs.readdirSync("data/etr").some(f => f.startsWith(date) && re.test(f)));
  rows.push({ slate: d, date, sport, stokastic: has(/Data_Hub_Projections\.csv$/i), blick: sport === "mlb" ? has(/^mlb-hitters-/) && has(/^mlb-pitchers-/) : has(/^nfl-.*\.csv$/i), etr: has(/^ETR-|-nfl-main-dk\.csv$/i), actuals: has(/^actuals\.csv$/) });
}
const pct = (k, f = r => true) => { const s = rows.filter(f); return s.length ? `${s.filter(r => r[k]).length}/${s.length}` : "-"; };
console.log("slate".padEnd(34) + "stokastic blick etr  actuals");
for (const r of rows) console.log(r.slate.padEnd(34) + (r.stokastic ? "yes" : "-").padEnd(10) + (r.blick ? "yes" : "-").padEnd(6) + (r.etr ? "yes" : "-").padEnd(5) + (r.actuals ? "yes" : "-"));
console.log(`\nMLB slates with Blick files: ${pct("blick", r => r.sport === "mlb")}   NFL: ${pct("blick", r => r.sport === "nfl")}   ETR (NFL): ${pct("etr", r => r.sport === "nfl")}`);
const missing = rows.filter(r => r.sport === "mlb" && !r.blick).slice(-5).map(r => r.slate);
if (missing.length) console.log("latest MLB slates missing Blick files: " + missing.join(", "));
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/vendor-index.json", JSON.stringify({ built: new Date().toISOString(), rows }, null, 1));
