// Does the field get sharper as the entry fee rises? For every pulled contest, compare each
// player's actual ownership with his projection, his value (projection per $1K), what
// Stokastic projected his ownership to be, and how lineups holding him actually did.
// Averages by fee tier and by field size, with contest counts so thin cells are obvious.
//   node bench/ownership-by-tier.mjs [sport]
import fs from "node:fs";
import path from "node:path";
import { spearman } from "../src/engine/select.mjs";

const sport = (process.argv[2] || "mlb").toLowerCase(), dir = path.join("data/post", sport);
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort() : [];
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const tier = fee => fee < 10 ? "<$10" : fee < 50 ? "$10-49" : fee < 200 ? "$50-199" : fee < 600 ? "$200-599" : "$600+";
const size = n => n < 300 ? "<300" : n < 1500 ? "300-1.5K" : n < 10000 ? "1.5K-10K" : "10K+";

const rows = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), c = j.contest;
  const P = j.players.filter(p => p.overallOwnership > 0 && p.projection > 0 && p.salary > 0);
  if (P.length < 20) continue;
  const own = P.map(p => 100 * p.overallOwnership), proj = P.map(p => p.projection), val = P.map(p => 1000 * p.projection / p.salary), pown = P.map(p => 100 * p.projectedOwnership), roi = P.map(p => p.actualPlayerRoi);
  const sorted = own.slice().sort((a, b) => b - a), mass = own.reduce((s, x) => s + x, 0);
  const chalk = P.filter(p => p.projectedOwnership > 0).sort((a, b) => b.projectedOwnership - a.projectedOwnership).slice(0, 10);
  rows.push({ key: c.key, date: c.date, name: c.name, fee: c.fee, entries: c.entries, tier: tier(c.fee), size: size(c.entries), n: P.length,
    ownProj: spearman(own, proj), ownVal: spearman(own, val), ownPown: spearman(own, pown), ownRoi: spearman(own, roi), pownRoi: spearman(pown, roi),
    top10: 100 * sorted.slice(0, 10).reduce((s, x) => s + x, 0) / mass, maxOwn: sorted[0],
    chalkMult: mean(chalk.map(p => p.overallOwnership / p.projectedOwnership)) });
}
console.log(`${rows.length} ${sport.toUpperCase()} contests with player data`);
const cols = [["ownProj", "own~proj"], ["ownVal", "own~value"], ["ownPown", "own~projOwn"], ["ownRoi", "own~actROI"], ["pownRoi", "projOwn~actROI"], ["top10", "top10 share%"], ["maxOwn", "max own%"], ["chalkMult", "chalk act/proj"]];
const table = (title, key, order) => {
  const g = {}; for (const r of rows) (g[r[key]] = g[r[key]] || []).push(r);
  console.log(`\n${title}`); console.log("group".padEnd(12) + "contests " + cols.map(([, l]) => l.padStart(15)).join(""));
  for (const k of order.filter(k => g[k])) console.log(k.padEnd(12) + String(g[k].length).padEnd(9) + cols.map(([c]) => mean(g[k].map(r => r[c])).toFixed(c === "top10" || c === "maxOwn" ? 1 : 2).padStart(15)).join(""));
};
table("by entry fee (Spearman rank correlations across players; higher = field follows it more)", "tier", ["<$10", "$10-49", "$50-199", "$200-599", "$600+"]);
table("by field size", "size", ["<300", "300-1.5K", "1.5K-10K", "10K+"]);
console.log("\ncolumns: own~proj = actual ownership vs projection; own~value = vs projection per $1K; own~projOwn = how predictable the field was;");
console.log("own~actROI = did the field's favourites pay (actual ROI of lineups holding the player); projOwn~actROI = same for Stokastic's projected ownership;");
console.log("top10 share = ownership mass in the 10 most-owned players; chalk act/proj = actual over projected ownership for the 10 chalkiest projected players.");
