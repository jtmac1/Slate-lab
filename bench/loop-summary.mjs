// Merges the sharded pick-loop grades (data/reports/loop-nfl-<i>.json) into data/reports/loop-nfl.json
// and prints the strategies overall, by season, by fee tier and by field size.
//   node bench/loop-summary.mjs [--in=data/reports/loop-nfl] [--out=data/reports/loop-nfl.json]
import fs from "node:fs";
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const IN = arg("in", "data/reports/loop-nfl"), OUT = arg("out", "data/reports/loop-nfl.json");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, se = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : null;
const files = fs.readdirSync("data/reports").filter(f => f.startsWith(IN.replace(/^data\/reports\//, "") + "-") && /-\d+\.json$/.test(f)).map(f => "data/reports/" + f);
const parts = files.map(f => JSON.parse(fs.readFileSync(f, "utf8"))), results = parts.flatMap(p => p.results).filter(r => !r.skip).sort((a, b) => a.date.localeCompare(b.date));
const summarize = all => { const s = {}; if (!all.length) return s; for (const k of [...new Set(all.flatMap(r => Object.keys(r.by)))]) { const rows = all.filter(r => r.by[k]), g = key => rows.map(r => r.by[k][key]); s[k] = { n: rows.length, actROI: +mean(g("actROI")).toFixed(1), se: +se(g("actROI")).toFixed(1), pct: +mean(g("pct")).toFixed(3), top10: +mean(g("top10")).toFixed(3), top1: +mean(g("top1")).toFixed(4), dup: +mean(g("dup")).toFixed(2), own: +mean(g("own")).toFixed(0) }; } s.field = { n: all.length, actROI: +mean(all.map(r => r.field.actROI)).toFixed(1), top10: 0.1, top1: 0.01 }; s.spearman = +mean(all.map(r => r.spearman)).toFixed(3); return s; };
const groups = { all: results, "2025": results.filter(r => r.date < "2026-06-01"), "2026": results.filter(r => r.date >= "2026-06-01") };
for (const t of [...new Set(results.map(r => r.tier))]) groups["fee " + t] = results.filter(r => r.tier === t);
for (const z of [...new Set(results.map(r => r.size))]) groups["field " + z] = results.filter(r => r.size === z);
const out = { built: new Date().toISOString(), args: parts[0]?.args, contests: results.length, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summarize(v)])), results };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const line = (k, v) => `  ${k.padEnd(30)} ROI ${String(v.actROI).padStart(6)}%${v.se != null ? ` ±${String(v.se).padStart(4)}` : "      "}  top10 ${(100 * v.top10).toFixed(1).padStart(5)}%  top1 ${(100 * v.top1).toFixed(2).padStart(5)}%${v.pct != null ? `  pct ${v.pct}  dupes ${v.dup}  own ${v.own}` : ""}`;
for (const [g, s] of Object.entries(out.groups)) { if (!s.field) continue; console.log(`\n${g}: ${s.field.n} contests, sim-vs-actual spearman ${s.spearman}`); for (const [k, v] of Object.entries(s)) if (v && v.n && k !== "field") console.log(line(k, v)); console.log(line("real field", s.field)); }
console.log(`\n-> ${OUT}`);
