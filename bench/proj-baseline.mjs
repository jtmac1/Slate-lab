// Is there a second projection source for college? ETR does not cover it, so the only candidate is
// one we build: a player's own recent scoring out of the game logs. This asks whether such a
// baseline carries anything Stokastic's projection does not, by ranking each slate's players three
// ways against what they actually scored - the vendor, the baseline, and a blend of the two.
// Salary is included as a reference, since it is the market's own projection.
//   node bench/proj-baseline.mjs cfb [--minproj=5] [--half=0.5]
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { spearman } from "../src/engine/select.mjs";
const SPORT = (process.argv[2] || "cfb").toLowerCase();
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const MINPROJ = flag("minproj") ?? 5, HALF = flag("half") ?? 0.5;   // weight decay per game back
const FKEY = SPORT === "cfb" ? "cfb_cl" : "nfl_cl", logDir = path.join("data/logs", SPORT);

// every scored game, by date, keyed by player
const byDate = {};
for (const f of (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [])) {
  const date = f.replace(/\.json$/, ""), d = byDate[date] = {};
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    for (const p of g.players) { const k = nrm(p.name); if (!(k in d) || d[k] < p.pts) d[k] = p.pts; }
  }
}
const dates = Object.keys(byDate).sort();

// one projection row per player per slate-date, taking the largest pool that day
const slate = {};
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  const cur = slate[c.date];
  if (cur && cur.n >= (c.entries || 0)) continue;
  slate[c.date] = { n: c.entries || 0, json: c.json };
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const rows = { vendor: [], base: [], blend: [], sal: [] };
let used = 0, players = 0;
for (const date of dates) {
  const s = slate[date]; if (!s) continue;
  const prior = dates.filter(d => d < date);
  if (prior.length < 3) continue;
  const { pool } = loadPulled(s.json);
  const V = [], B = [], L = [], SA = [], A = [];
  for (const p of pool.players) {
    if (!(p.proj >= MINPROJ)) continue;
    const k = p.key;
    const act = byDate[date][k];
    if (act == null) continue;
    // the player's own recent scoring, most recent game weighted most
    let w = 0, sum = 0, seen = 0;
    for (let i = prior.length - 1; i >= 0 && seen < 8; i--) {
      const v = byDate[prior[i]][k]; if (v == null) continue;
      const ww = Math.pow(HALF, seen); sum += ww * v; w += ww; seen++;
    }
    if (seen < 2) continue;
    V.push(p.proj); B.push(sum / w); L.push(0); SA.push(p.sal || 0); A.push(act);
  }
  if (V.length < 25) continue;
  // blend on the same scale: z-score each, then average
  const z = a => { const m = mean(a), sd = Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1; return a.map(x => (x - m) / sd); };
  const zv = z(V), zb = z(B);
  for (let i = 0; i < L.length; i++) L[i] = 0.75 * zv[i] + 0.25 * zb[i];
  rows.vendor.push(spearman(V, A)); rows.base.push(spearman(B, A));
  rows.blend.push(spearman(L, A)); rows.sal.push(spearman(SA, A));
  used++; players += V.length;
}
console.log(`${used} slate-dates, ${players} player-games with at least two prior games\n`);
console.log("source".padEnd(34) + "rank correlation with actual");
console.log("Stokastic projection".padEnd(34) + mean(rows.vendor).toFixed(4));
console.log("recent scoring from our logs".padEnd(34) + mean(rows.base).toFixed(4));
console.log("salary (the market)".padEnd(34) + mean(rows.sal).toFixed(4));
console.log("blend, 75% vendor 25% baseline".padEnd(34) + mean(rows.blend).toFixed(4));
const wins = rows.blend.filter((v, i) => v > rows.vendor[i]).length;
console.log(`\nblend beat the vendor alone on ${wins} of ${used} slates`);
