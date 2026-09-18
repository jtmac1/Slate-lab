// Projection sources head to head on one slate (ETR vs Stokastic vs ...): per player, how well
// each file's projection tracked actual DK points (bench/actuals-nfl.mjs or actuals-mlb.mjs must
// have run on the dir); then the part that pays - each file fed through the same engine against
// the slate's real pulled fields (gradeContest with opts.proj), lineup rank correlation and
// realized top-10% ROI.
//   node bench/proj-compare.mjs data/2026-09-13-nfl-main nfl_cl "ETR=DraftKings NFL DFS Projections -- Main Slate.csv" "Stokastic=DK_NFL_Main_Data_Hub_Projections.csv" [--iters=2000] [--maxentries=5000]
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { buildPool } from "../src/engine/formats.mjs";
import { listContests, gradeContest } from "./grade-all.mjs";
import { spearman } from "../src/engine/select.mjs";
const args = process.argv.slice(2), flags = args.filter(a => a.startsWith("--")), pos = args.filter(a => !a.startsWith("--"));
const [dir, fkey, ...srcArgs] = pos, ITERS = +((flags.find(a => a.startsWith("--iters=")) || "").slice(8) || 2000), MAXN = +((flags.find(a => a.startsWith("--maxentries=")) || "").slice(13) || 5000);
const date = (path.basename(dir).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
const sources = srcArgs.map(s => { const i = s.indexOf("="); return { label: s.slice(0, i), file: path.join(dir, s.slice(i + 1)) }; });
const A = parseCSV(fs.readFileSync(path.join(dir, "actuals.csv"), "utf8")), AH = A[0].map(h => h.toLowerCase()), aTeam = AH.indexOf("team"), aAct = AH.indexOf("actual"), aName = 0;
const act = {}; for (const r of A.slice(1)) if (r.length > aAct && r[aAct] !== "") act[nrm(r[aName]) + "|" + r[aTeam].toUpperCase()] = +r[aAct];
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
console.log(`${date} ${fkey}: ${Object.keys(act).length} players with actuals; sources: ${sources.map(s => s.label).join(", ")}`);
console.log("\n=== player projections vs actual DK points (players projected > 0 in each file) ===");
console.log("source".padEnd(12) + "n     Spearman  MAE    actual/proj  | top-20 by proj: mean actual  | Spearman among proj>=8");
for (const s of sources) {
  const rows = parseCSV(fs.readFileSync(s.file, "utf8")), pool = buildPool(rows[0], rows.slice(1), fkey), P = pool.players.filter(p => p.proj > 0);
  const pairs = P.map(p => ({ p: p.proj, a: act[p.key + "|" + String(p.team).toUpperCase()] ?? act[p.key.replace(/\s+[a-z]\.?\s+/, " ") + "|" + String(p.team).toUpperCase()] })).filter(x => x.a != null);
  const hi = pairs.filter(x => x.p >= 8), top = pairs.slice().sort((a, b) => b.p - a.p).slice(0, 20);
  console.log(s.label.padEnd(12) + String(pairs.length).padEnd(6) + spearman(pairs.map(x => x.p), pairs.map(x => x.a)).toFixed(3).padEnd(10) + mean(pairs.map(x => Math.abs(x.p - x.a))).toFixed(2).padEnd(7) + (mean(pairs.map(x => x.a)) / mean(pairs.map(x => x.p))).toFixed(3).padEnd(13) + "| " + mean(top.map(x => x.a)).toFixed(1).padEnd(29) + "| " + (hi.length >= 10 ? spearman(hi.map(x => x.p), hi.map(x => x.a)).toFixed(3) + ` (n=${hi.length})` : "-"));
}
const contests = listContests().filter(c => c.json && c.date === date && c.fkey === fkey && c.entries <= MAXN);
if (!contests.length) { console.log("\nno pulled contests for this slate"); process.exit(0); }
console.log(`\n=== same engine, each source's file, ${contests.length} real fields (${ITERS} draws) ===`);
console.log("source".padEnd(12) + "contests  lineup Spearman  player ROI  top-10% realized  gated-rule top-10%  cash hits  (Stokastic post-contest: Spearman / top-10%)");
for (const s of sources) {
  const rs = [];
  for (const c of contests) { const r = gradeContest(c, { iters: ITERS, proj: s.file }); if (r.src !== "projections") { console.log(`  ${s.label}: ${c.name.slice(0, 40)} could not be matched onto the file (${r.src}) - skipped`); continue; } rs.push(r); }
  if (!rs.length) continue;
  const g = rs.map(r => r.grades["ROI gated: top half proj"]);
  console.log(s.label.padEnd(12) + String(rs.length).padEnd(10) + mean(rs.map(r => r.sMine)).toFixed(3).padEnd(17) + mean(rs.map(r => r.pMine)).toFixed(3).padEnd(12) + (mean(rs.map(r => r.roiMine)).toFixed(0) + "%").padEnd(18) + (mean(g.map(x => x.real10)).toFixed(0) + "%").padEnd(20) + mean(rs.map(r => r.cashMine)).toFixed(1).padEnd(11) + `(${mean(rs.map(r => r.sStk)).toFixed(3)} / ${mean(rs.map(r => r.roiStk)).toFixed(0)}%)`);
}
