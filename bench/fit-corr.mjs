// Fit the outcome model's correlation tables from real results instead of hand-set numbers.
// Joins the projections inside each pulled contest to the per-game player logs (bench/game-logs.mjs),
// turns each player-game into a log-space residual against his projection, and measures the
// correlation of those residuals for every position pair, same team and opposing team.
//   node bench/fit-corr.mjs cfb [--minproj=5] [--out=data/reports/corr-cfb.json]
// The output drops straight into grade-all --ctable=<file> for grading against the hand-set tables.
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
const SPORT = (process.argv[2] || "cfb").toLowerCase();
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const MINPROJ = +(flag("minproj") || 5), OUT = flag("out") || `data/reports/corr-${SPORT}.json`;
const FKEY = SPORT === "cfb" ? "cfb_cl" : "nfl_cl", logDir = path.join("data/logs", SPORT);
const POSES = ["QB", "RB", "WR", "TE", "K", "DST"];
const ckey = (a, b) => { let i = POSES.indexOf(a), j = POSES.indexOf(b); if (i < 0) i = 99; if (j < 0) j = 99; return (i <= j ? a : b) + "|" + (i <= j ? b : a); };

// projections: one row per player per slate-date, from the contests we pulled
const proj = {};   // date -> key(name|team) -> { proj, pos }
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  const { pool } = loadPulled(c.json), d = proj[c.date] = proj[c.date] || {};
  for (const p of pool.players) { if (!(p.proj > 0)) continue; const k = p.key + "|" + String(p.team).toUpperCase(); if (!d[k] || d[k].proj < p.proj) d[k] = { proj: p.proj, pos: p.pos };
    const byN = d.__byName || (d.__byName = {}); (byN[p.key] = byN[p.key] || []).push({ proj: p.proj, pos: p.pos }); }
}
// actuals: one row per player per game
const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".json")) : [];
console.log(`${SPORT}: ${Object.keys(proj).length} dates with projections, ${logs.length} dates with game logs`);

const acc = {};   // bucket -> running sums for a Pearson correlation
const bump = (b, x, y) => { const a = acc[b] || (acc[b] = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }); a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y; };
const corr = a => { const c = (a.sxy - a.sx * a.sy / a.n) / Math.sqrt(Math.max(1e-9, (a.sxx - a.sx * a.sx / a.n) * (a.syy - a.sy * a.sy / a.n))); return c; };
let games = 0, pairs = 0, players = 0;
for (const f of logs) {
  const date = f.replace(/\.json$/, ""), d = proj[date]; if (!d) continue;
  const day = JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8"));
  for (const g of day.games) {
    if (!g.final) continue;
    // a player-game is usable when the slate carried a projection for him
    const rows = [];
    for (const p of g.players) {
      const nk = nrm(p.name), k = nk + "|" + String(p.team).toUpperCase();
      let pr = d[k];
      if (!pr) { const hits = (d.__byName || {})[nk]; if (hits && hits.length === 1) pr = hits[0]; }   // team codes differ between sources
      if (!pr || pr.proj < MINPROJ) continue;
      rows.push({ team: String(p.team).toUpperCase(), pos: pr.pos, z: Math.log((Math.max(0, p.pts) + 0.5) / (pr.proj + 0.5)) });
    }
    if (rows.length < 2) continue; games++; players += rows.length;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j], same = a.team === b.team;
      bump((same ? "S " : "O ") + ckey(a.pos, b.pos), a.z, b.z); pairs++;
    }
  }
}
console.log(`${games} final games, ${players} player-games with a projection >= ${MINPROJ}, ${pairs} pairs\n`);
console.log("bucket".padEnd(14) + "n        fitted   current  (same-team CSAME / opposing COPP in src/engine/model.mjs)");
const { CSAME, COPP } = await import("../src/engine/model.mjs");
const CS = {}, CO = {};
for (const [b, a] of Object.entries(acc).sort((x, y) => y[1].n - x[1].n)) {
  if (a.n < 200) continue;
  const same = b.startsWith("S "), key = b.slice(2), c = corr(a), cur = (same ? CSAME : COPP)[key];
  (same ? CS : CO)[key] = +c.toFixed(3);
  console.log(b.padEnd(14) + String(a.n).padEnd(9) + c.toFixed(3).padEnd(9) + (cur == null ? "-" : cur.toFixed(2)));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ sport: SPORT, fitted: new Date().toISOString(), minProj: MINPROJ, games, pairs, CSAME: CS, COPP: CO }, null, 1));
console.log(`\nwrote ${OUT} - grade it with: node bench/grade-all.mjs 3000 ${FKEY} --ctable=${OUT}`);
