// Fit the MLB outcome model's correlation constants (model.mjs MLBC) from real results.
// Joins the projections inside each pulled MLB contest to the per-game logs (bench/game-logs-mlb.mjs),
// turns each player-game into a log-space residual against his projection, and measures the residual
// correlation for every pair type the engine distinguishes: same-team hitters (by batting-order
// distance, which fits hitSame + orderBonus), opposing hitters in the same game, hitter vs own
// pitcher, hitter vs opposing pitcher, and the two starting pitchers.
//   node bench/fit-corr-mlb.mjs [--minhit=3] [--minpit=8] [--out=data/reports/corr-mlb.json]
// The output drops into grade-all --ctable=<file> (its MLBC block is merged over the defaults).
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost, isPitcher } from "./post-store.mjs";
import { MLBC } from "../src/engine/model.mjs";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const MINHIT = +(flag("minhit") || 3), MINPIT = +(flag("minpit") || 8), OUT = flag("out") || "data/reports/corr-mlb.json";
const logDir = "data/logs/mlb";
const noMid = n => n.replace(/\s+[A-Z]\.?\s+/, " ");

// projections: date -> name|team -> { proj, isP }, the highest projection any contest that day carried
const proj = {};
for (const f of listPost("mlb")) {
  const j = readPost(f), c = j.contest; if (c.type !== "Classic" || !j.players?.length) continue;
  const d = proj[c.date] = proj[c.date] || {};
  for (const p of j.players) { if (!(p.proj > 0)) continue; const k = nrm(p.name) + "|" + String(p.team).toUpperCase(); if (!d[k] || d[k].proj < p.proj) d[k] = { proj: p.proj, isP: isPitcher(p.pos) }; }
}
const acc = {};
const bump = (b, x, y) => { const a = acc[b] || (acc[b] = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }); a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y; };
const corr = a => (a.sxy - a.sx * a.sy / a.n) / Math.sqrt(Math.max(1e-9, (a.sxx - a.sx * a.sx / a.n) * (a.syy - a.sy * a.sy / a.n)));
let games = 0, rowsN = 0, pairs = 0;
for (const f of fs.readdirSync(logDir).filter(f => f.endsWith(".json"))) {
  const date = f.replace(/\.json$/, ""), d = proj[date]; if (!d) continue;
  for (const g of JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")).games) {
    if (!g.final) continue;
    const rows = [];
    for (const p of g.players) {
      const pr = d[nrm(p.name) + "|" + p.team] || d[nrm(noMid(p.name)) + "|" + p.team]; if (!pr) continue;
      if (pr.isP !== p.isP) continue;
      if (p.isP ? (pr.proj < MINPIT || !p.starter) : (pr.proj < MINHIT || !p.ord)) continue;   // starting pitchers and starting hitters only
      rows.push({ team: p.team, isP: p.isP, ord: p.ord, z: Math.log((Math.max(0, p.pts) + 0.5) / (pr.proj + 0.5)) });
    }
    if (rows.length < 2) continue; games++; rowsN += rows.length;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j], same = a.team === b.team; pairs++;
      let key;
      if (a.isP && b.isP) key = same ? "pitchPitchSameTeam" : "pitchPitchSameGame";
      else if (a.isP || b.isP) key = same ? "hitOwnPitcher" : "hitOppPitcher";
      else if (same) { let dd = Math.abs(a.ord - b.ord); if (dd > 4) dd = 9 - dd; key = "hitSame d" + dd; }
      else key = "hitOppSameGame";
      bump(key, a.z, b.z);
    }
  }
}
console.log(`${games} final games, ${rowsN} player-games joined to a projection (hitters >= ${MINHIT}, starting pitchers >= ${MINPIT}), ${pairs} pairs\n`);
console.log("bucket".padEnd(22) + "n         fitted   current");
const fitted = {};
for (const [b, a] of Object.entries(acc).sort((x, y) => x[0].localeCompare(y[0]))) {
  const c = corr(a); fitted[b] = { n: a.n, r: +c.toFixed(3) };
  const cur = b.startsWith("hitSame d") ? MLBC.hitSame + MLBC.orderBonus * Math.max(0, (3 - +b.slice(9)) / 3) : MLBC[b];
  console.log(b.padEnd(22) + String(a.n).padEnd(10) + c.toFixed(3).padEnd(9) + (cur == null ? "-" : cur.toFixed(3)));
}
// hitSame(d) = hitSame + orderBonus * max(0, (3 - d) / 3): base from d >= 3, bonus from the d = 0..2 excess (pair-weighted)
const far = ["hitSame d3", "hitSame d4"].filter(k => fitted[k]), near = ["hitSame d1", "hitSame d2"].filter(k => fitted[k]);
const wmean = (keys, f) => { let s = 0, n = 0; for (const k of keys) { s += f(k) * fitted[k].n; n += fitted[k].n; } return n ? s / n : NaN; };
const hitSame = wmean(far, k => fitted[k].r);
const orderBonus = wmean(near, k => (fitted[k].r - hitSame) / Math.max(1e-9, (3 - +k.slice(9)) / 3));
const out = { MLBC: { hitSame: +hitSame.toFixed(3), orderBonus: +Math.max(0, orderBonus).toFixed(3), hitOppSameGame: fitted.hitOppSameGame?.r, hitOwnPitcher: fitted.hitOwnPitcher?.r, hitOppPitcher: fitted.hitOppPitcher?.r, pitchPitchSameGame: fitted.pitchPitchSameGame?.r } };
console.log("\nfitted MLBC:", JSON.stringify(out.MLBC), "\ncurrent MLBC:", JSON.stringify(MLBC));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ sport: "mlb", fitted: new Date().toISOString(), minHit: MINHIT, minPit: MINPIT, games, pairs, buckets: fitted, ...out }, null, 1));
console.log("wrote", OUT);
