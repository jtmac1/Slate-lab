// Compare selection rules against the default on saved per-contest grades (bench/grade-all.mjs --json=...).
// Paired bootstrap on the difference in realized top-10% ROI, by fee tier, field size and window half.
//   node bench/rules-by-tier.mjs data/reports/grade-mlb.json [rule filter]
import fs from "node:fs";
import { DEFAULT_RULE } from "../src/engine/select.mjs";

const rows = JSON.parse(fs.readFileSync(process.argv[2] || "data/reports/grade-mlb.json", "utf8")), FILTER = process.argv[3] || "";
const names = Object.keys(rows[0].grades).filter(n => n !== DEFAULT_RULE && (!FILTER || n.includes(FILTER)));
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function ci(diffs, B = 2000) {
  const ms = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)]; ms.push(s / diffs.length); }
  ms.sort((a, b) => a - b); return [ms[Math.floor(B * 0.025)], ms[Math.floor(B * 0.975)]];
}
const dates = rows.map(r => r.date).sort(), mid = dates[Math.floor(dates.length / 2)];
const groups = { all: () => true, "<$50": r => r.tier === "<$50", "$50-199": r => r.tier === "$50-199", "$200+": r => r.tier === "$200-599" || r.tier === "$600+",
  "<300": r => r.size === "<300", "300-1.5K": r => r.size === "300-1.5K", "1.5K+": r => r.size === "1.5K-10K" || r.size === "10K+", "first half": r => r.date < mid, "second half": r => r.date >= mid };
for (const [g, pred] of Object.entries(groups)) {
  const rs = rows.filter(pred); if (rs.length < 5) continue;
  const d = rs.map(r => r.grades[DEFAULT_RULE]);
  console.log(`\n=== ${g}: ${rs.length} contests | default "${DEFAULT_RULE}" top-10% mean ${mean(d.map(x => x.real10)).toFixed(0)}% median ${median(d.map(x => x.real10)).toFixed(0)}% | profitable ${d.filter(x => x.real10 > 0).length}`);
  console.log("  rule".padEnd(40) + "top10% mean  median  profitable  | diff vs default  95% CI      | spearman diff");
  for (const n of names) {
    const gr = rs.map(r => r.grades[n]), diffs = rs.map((r, i) => gr[i].real10 - d[i].real10), [lo, hi] = ci(diffs);
    const sd = mean(rs.map((r, i) => gr[i].spearman - d[i].spearman));
    console.log("  " + n.padEnd(38) + (mean(gr.map(x => x.real10)).toFixed(0) + "%").padEnd(13) + (median(gr.map(x => x.real10)).toFixed(0) + "%").padEnd(8) + String(gr.filter(x => x.real10 > 0).length).padEnd(12) + "| " + ((mean(diffs) >= 0 ? "+" : "") + mean(diffs).toFixed(0) + "pp").padEnd(17) + `[${lo.toFixed(0)}, ${hi.toFixed(0)}]`.padEnd(13) + "| " + (sd >= 0 ? "+" : "") + sd.toFixed(3));
  }
}
