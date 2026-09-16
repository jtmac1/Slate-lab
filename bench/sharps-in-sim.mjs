// What does our sim see in the sharps' lineups? Sims every real entry of each pulled MLB contest
// and compares sharps / you / field on sim rank, then asks whether sharps beat the field
// within the same sim decile (edge the sim misses) and which lineup features carry realized
// ROI after controlling for sim decile.
//   node bench/sharps-in-sim.mjs [iters=4000] [filter] [you=jtmac1999]
import fs from "node:fs";
import { listContests, recover } from "./grade-all.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { stackOf } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { pctRank } from "../src/engine/select.mjs";

const ITERS = +(process.argv[2] || 4000), FILTER = process.argv[3] || "", YOU = process.argv[4] || "jtmac1999";
const SHARPS = new Set(JSON.parse(fs.readFileSync("data/reports/sharps-mlb.json", "utf8")));
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = x => (100 * x).toFixed(0) + "%";
const contests = listContests().filter(c => c.fkey === "mlb_cl" && c.json && (!FILTER || c.dir.includes(FILTER)));
const rows = [];
let t0 = Date.now();
for (const c of contests) {
  const rc = recover(c), { pool, entries, payouts } = rc, P = pool.players, f = pool.format, N = entries.length;
  const res = simulate({ pool, model: buildModel(pool, {}), field: [], lineups: entries.map(e => e.lu), payouts, entries: N, fee: 1, iters: ITERS, rng: mulberry32(1), fieldMode: true });
  const rMine = pctRank(res.rows.map(r => r.roi)), rStk = pctRank(entries.map(e => e.stkROI)), rProj = pctRank(entries.map(e => e.stkFP)), rOwn = pctRank(entries.map(e => e.own));
  const chalk = P.map((p, i) => i).filter(i => !P[i].isP).sort((a, b) => P[b].own - P[a].own).slice(0, 10), chalkSet = new Set(chalk);
  entries.forEach((e, i) => {
    const hitters = e.lu.filter(id => !P[id].isP), teams = new Set(hitters.map(id => P[id].team)).size;
    const shape = stackOf(e.lu, P, f), primary = +String(shape).split(/[^0-9]/)[0] || 0;
    rows.push({ c: c.dir, date: c.date, N, fee: c.fee, user: e.user, grp: SHARPS.has(e.user) ? "sharps" : e.user === YOU ? "you" : "field", rMine: rMine[i], rStk: rStk[i], rProj: rProj[i],
      own: e.own, rOwn: rOwn[i], dup: e.dupes > 0 ? 1 : 0, dupN: e.dupes, teams, shape, primary, salLeft: 50000 - e.sal, chalkN: e.lu.filter(id => chalkSet.has(id)).length,
      act: e.actROI, t10: e.finish <= Math.max(1, Math.round(N * 0.1)) ? 1 : 0, cash: payouts[entries.indexOf(e)] > 0 ? 1 : 0, simROI: res.rows[i].roi, simCash: res.rows[i].cash });
  });
  process.stderr.write(`${c.dir} N=${N} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
fs.writeFileSync("data/reports/sharps-in-sim.json", JSON.stringify(rows));

const G = ["sharps", "field", "you"], by = g => rows.filter(r => r.grp === g);
console.log(`${contests.length} contests, ${rows.length} entries: ` + G.map(g => `${g} ${by(g).length}`).join(", "));
console.log("\n=== where each group's lineups sit (entry-weighted means) ===");
console.log("group".padEnd(8) + "ourROI pct  StkROI pct  proj pct | in OUR top decile  in STK top decile | realized ROI  top10%  cash | dup%  ownsum  teams  salLeft  chalkN");
for (const g of G) { const r = by(g); console.log(g.padEnd(8) + pct(mean(r.map(x => x.rMine))).padEnd(12) + pct(mean(r.map(x => x.rStk))).padEnd(12) + pct(mean(r.map(x => x.rProj))).padEnd(9) + "| " + pct(mean(r.map(x => x.rMine >= 0.9 ? 1 : 0))).padEnd(19) + pct(mean(r.map(x => x.rStk >= 0.9 ? 1 : 0))).padEnd(18) + "| " + (mean(r.map(x => x.act)).toFixed(0) + "%").padEnd(14) + pct(mean(r.map(x => x.t10))).padEnd(8) + pct(mean(r.map(x => x.cash))).padEnd(5) + "| " + pct(mean(r.map(x => x.dup))).padEnd(6) + mean(r.map(x => x.own)).toFixed(0).padEnd(8) + mean(r.map(x => x.teams)).toFixed(1).padEnd(7) + mean(r.map(x => x.salLeft)).toFixed(0).padEnd(9) + mean(r.map(x => x.chalkN)).toFixed(1)); }

console.log("\n=== realized ROI by OUR sim decile: do sharps beat the field at the same sim rank? ===");
console.log("decile   sharps n  ROI     | field n   ROI     | you n   ROI     | sharps-field");
for (let d = 9; d >= 0; d--) {
  const inD = r => Math.min(9, Math.floor(r.rMine * 10)) === d, s = by("sharps").filter(inD), fl = by("field").filter(inD), y = by("you").filter(inD);
  console.log(`${d === 9 ? "top" : d === 0 ? "bottom" : String(d)}`.padEnd(9) + String(s.length).padEnd(10) + (mean(s.map(x => x.act)).toFixed(0) + "%").padEnd(8) + "| " + String(fl.length).padEnd(9) + (mean(fl.map(x => x.act)).toFixed(0) + "%").padEnd(8) + "| " + String(y.length).padEnd(7) + (y.length ? mean(y.map(x => x.act)).toFixed(0) + "%" : "-").padEnd(8) + "| " + (s.length ? (mean(s.map(x => x.act)) - mean(fl.map(x => x.act))).toFixed(0) + "pp" : "-"));
}

console.log("\n=== features vs realized ROI, controlling for sim decile (field entries; sharps share of each bin) ===");
const bins = { "dup: none": r => r.dupN === 0, "dup: 1+": r => r.dupN > 0, "teams: <=3": r => r.teams <= 3, "teams: 4": r => r.teams === 4, "teams: 5+": r => r.teams >= 5,
  "primary stack: 5": r => r.primary === 5, "primary stack: 4": r => r.primary === 4, "primary stack: <=3": r => r.primary <= 3,
  "salLeft: 0-200": r => r.salLeft <= 200, "salLeft: 201-600": r => r.salLeft > 200 && r.salLeft <= 600, "salLeft: 601+": r => r.salLeft > 600,
  "chalkN: 0-1": r => r.chalkN <= 1, "chalkN: 2-3": r => r.chalkN >= 2 && r.chalkN <= 3, "chalkN: 4+": r => r.chalkN >= 4,
  "ownsum: low third": r => r.rOwn < 0.333, "ownsum: mid third": r => r.rOwn >= 0.333 && r.rOwn < 0.667, "ownsum: top third": r => r.rOwn >= 0.667 };
// decile-adjusted ROI: each entry's actual ROI minus the field mean ROI of its sim decile in that contest
const key = r => r.c + "|" + Math.min(9, Math.floor(r.rMine * 10)), dm = {};
for (const r of rows) { (dm[key(r)] = dm[key(r)] || []).push(r.act); }
for (const r of rows) r.adj = r.act - mean(dm[key(r)]);
console.log("bin".padEnd(20) + "field n   ROI    adj ROI  | sharps n  ROI    adj ROI | you share");
for (const [b, pred] of Object.entries(bins)) {
  const fl = by("field").filter(pred), s = by("sharps").filter(pred), y = by("you").filter(pred);
  console.log(b.padEnd(20) + String(fl.length).padEnd(10) + (mean(fl.map(x => x.act)).toFixed(0) + "%").padEnd(7) + ((mean(fl.map(x => x.adj)) >= 0 ? "+" : "") + mean(fl.map(x => x.adj)).toFixed(1) + "pp").padEnd(9) + "| " + String(s.length).padEnd(10) + (mean(s.map(x => x.act)).toFixed(0) + "%").padEnd(7) + ((mean(s.map(x => x.adj)) >= 0 ? "+" : "") + mean(s.map(x => x.adj)).toFixed(1) + "pp").padEnd(8) + "| " + pct(y.length / (by("you").length || 1)));
}
console.log("\n=== sharps' realized ROI split by whether OUR sim liked the lineup ===");
for (const [lab, pred] of [["sim top half", r => r.rMine >= 0.5], ["sim bottom half", r => r.rMine < 0.5], ["Stk top half", r => r.rStk >= 0.5], ["Stk bottom half", r => r.rStk < 0.5]]) {
  const s = by("sharps").filter(pred), fl = by("field").filter(pred);
  console.log(lab.padEnd(18) + `sharps ${String(s.length).padEnd(6)} ${(mean(s.map(x => x.act)).toFixed(0) + "%").padEnd(7)} | field ${String(fl.length).padEnd(7)} ${mean(fl.map(x => x.act)).toFixed(0)}%`);
}
