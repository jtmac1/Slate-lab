// Merge the per-contest JSON files from sharded grade-all runs into one.
//   node bench/merge-json.mjs out.json part0.json part1.json ...
import fs from "node:fs";
const [out, ...parts] = process.argv.slice(2), rows = [];
for (const f of parts) rows.push(...JSON.parse(fs.readFileSync(f, "utf8")));
fs.writeFileSync(out, JSON.stringify(rows)); console.log(`${out}: ${rows.length} contests from ${parts.length} files`);
