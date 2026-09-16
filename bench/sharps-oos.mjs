// Out-of-sample check of the sharps finding: pick sharps on one half of the window (by date),
// measure them on the other half, both directions. Reads data/reports/sharps-in-sim.json
// (bench/sharps-in-sim.mjs). Removes the survivorship bias of grading a roster on the same
// contests that selected it.
//   node bench/sharps-oos.mjs [minContests=15] [z=2.5] [minFee=1000]
import fs from "node:fs";
const MINC = +(process.argv[2] || 15), Z = +(process.argv[3] || 2.5), MINFEE = +(process.argv[4] || 1000);
const rows = JSON.parse(fs.readFileSync("data/reports/sharps-in-sim.json", "utf8"));
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1), pct = x => (100 * x).toFixed(0) + "%";
const dates = [...new Set(rows.map(r => r.date))].sort(), mid = dates[Math.floor(dates.length / 2)];
const half = r => r.date < mid ? "A" : "B";
function roster(h) {
  const U = {};
  for (const r of rows) { if (half(r) !== h || r.grp === "you") continue; const u = U[r.user] || (U[r.user] = { n: 0, t10: 0, fees: 0, ret: 0, cs: new Set() }); u.n++; u.t10 += r.t10; u.fees += r.fee; u.ret += r.fee * (1 + r.act / 100); u.cs.add(r.c); }
  return new Set(Object.entries(U).filter(([, u]) => u.cs.size >= MINC && u.fees >= MINFEE && u.ret > u.fees && (u.t10 / u.n - 0.1) / Math.sqrt(0.09 / u.n) >= Z).map(([k]) => k));
}
for (const [fit, test] of [["A", "B"], ["B", "A"]]) {
  const S = roster(fit), rs = rows.filter(r => half(r) === test), sh = rs.filter(r => S.has(r.user)), fl = rs.filter(r => !S.has(r.user) && r.grp !== "you"), you = rs.filter(r => r.grp === "you");
  const fitRows = rows.filter(r => half(r) === fit && S.has(r.user));
  console.log(`\n=== sharps picked on half ${fit} (${S.size} users, in-sample ROI ${mean(fitRows.map(r => r.act)).toFixed(0)}%, top-10% ${pct(mean(fitRows.map(r => r.t10)))}), measured on half ${test} (${[...new Set(rs.map(r => r.c))].length} contests) ===`);
  console.log("group".padEnd(8) + "entries  ROI     top10%  cash  | ourROI pct  in our top decile | dup%  teams  salLeft  chalkN");
  for (const [g, r] of [["sharps", sh], ["field", fl], ["you", you]]) if (r.length) console.log(g.padEnd(8) + String(r.length).padEnd(9) + (mean(r.map(x => x.act)).toFixed(0) + "%").padEnd(8) + pct(mean(r.map(x => x.t10))).padEnd(8) + pct(mean(r.map(x => x.cash))).padEnd(6) + "| " + pct(mean(r.map(x => x.rMine))).padEnd(12) + pct(mean(r.map(x => x.rMine >= 0.9 ? 1 : 0))).padEnd(18) + "| " + pct(mean(r.map(x => x.dup))).padEnd(6) + mean(r.map(x => x.teams)).toFixed(1).padEnd(7) + mean(r.map(x => x.salLeft)).toFixed(0).padEnd(9) + mean(r.map(x => x.chalkN)).toFixed(1));
  console.log("  by our sim decile (sharps ROI | field ROI | diff):");
  const line = [];
  for (let d = 9; d >= 0; d--) { const inD = r => Math.min(9, Math.floor(r.rMine * 10)) === d, s = sh.filter(inD), f = fl.filter(inD); line.push(`${d === 9 ? "top" : d}: ${s.length ? mean(s.map(x => x.act)).toFixed(0) + "%" : "-"} | ${mean(f.map(x => x.act)).toFixed(0)}% | ${s.length ? (mean(s.map(x => x.act)) - mean(f.map(x => x.act))).toFixed(0) + "pp (n=" + s.length + ")" : "-"}`); }
  console.log("  " + line.join("\n  "));
  const top = sh.filter(r => r.rMine >= 0.5), bot = sh.filter(r => r.rMine < 0.5);
  console.log(`  sharps' entries our sim liked (top half): ${top.length} at ${mean(top.map(x => x.act)).toFixed(0)}%; disliked (bottom half): ${bot.length} at ${mean(bot.map(x => x.act)).toFixed(0)}%`);
}
