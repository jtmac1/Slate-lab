// Aggregate one or more `grade-all --field` outputs by field size: duplicates, ownership sum,
// salary, stack TVD, exposure gap, generated vs real.   node bench/fieldcheck-agg.mjs label=file ...
import fs from "node:fs";
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split("="), rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) { const m = line.match(/^(\S+)\s+(\d+)\s+([\d.]+)\s+(\d+)\/(\d+)\s+(\d+)\/(\d+)\s+(\d+)\/(\d+)\s+([\d.]+)/); if (m) rows.push({ N: +m[2], tvd: +m[3], dupReal: +m[4], dupGen: +m[5], salReal: +m[6], salGen: +m[7], ownReal: +m[8], ownGen: +m[9], gap: +m[10] }); }
  console.log(`\n=== ${label}: ${rows.length} contests ===`);
  console.log("field size   n    dupes% real/gen   ownsum real/gen   salary real/gen   stackTVD  expo gap");
  for (const [lab, lo, hi] of [["<300", 0, 300], ["300-1.5K", 300, 1500], ["1.5K-10K", 1500, 10000], ["all", 0, 1e9]]) { const r = rows.filter(x => x.N >= lo && x.N < hi); if (!r.length) continue; console.log(lab.padEnd(12) + String(r.length).padEnd(5) + (mean(r.map(x => 100 * x.dupReal / x.N)).toFixed(1) + "/" + mean(r.map(x => 100 * x.dupGen / x.N)).toFixed(1)).padEnd(19) + (mean(r.map(x => x.ownReal)).toFixed(0) + "/" + mean(r.map(x => x.ownGen)).toFixed(0)).padEnd(18) + (mean(r.map(x => x.salReal)).toFixed(0) + "/" + mean(r.map(x => x.salGen)).toFixed(0)).padEnd(18) + mean(r.map(x => x.tvd)).toFixed(3).padEnd(10) + mean(r.map(x => x.gap)).toFixed(2)); }
}
