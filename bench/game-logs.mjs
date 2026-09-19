// Per-game player logs with DraftKings points, for fitting the outcome model's correlations and
// spread from real results. Only games whose teams appear on a slate we already hold are fetched.
//   node bench/game-logs.mjs cfb [--par=6] [--force]
// Writes data/logs/<sport>/<date>.json: { date, games: [{ id, teams, final, players: [{name, team, pts, rec, ...}] }] }
// Scoring mirrors bench/actuals-cfb.mjs (full PPR, +3 at 100 rush/rec yards, no 300-yard pass bonus).
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
const SPORT = (process.argv[2] || "cfb").toLowerCase(), FORCE = process.argv.includes("--force");
const SHARD = ((process.argv.find(a => a.startsWith("--shard=")) || "").slice(8) || "").split("/").map(Number);
const PAR = +((process.argv.find(a => a.startsWith("--par=")) || "--par=6").slice(6));
const API = SPORT === "cfb" ? "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
  : "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const GROUPS = SPORT === "cfb" ? ["80", "81"] : [""];
const FKEY = SPORT === "cfb" ? "cfb_cl" : "nfl_cl";
const outDir = path.join("data/logs", SPORT); fs.mkdirSync(outDir, { recursive: true });
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u.slice(-60)}`); return r.json(); };
const n = s => +String(s ?? "").split("/")[0].split("-")[0] || 0;

// which dates, and which teams mattered on each: taken from the pulled contests we already hold
const byDate = {};
for (const c of listContests().filter(c => c.json && (c.fkey === FKEY || (SPORT === "nfl" && c.fkey === "nfl_sd")))) {
  const { pool } = loadPulled(c.json);
  const s = byDate[c.date] = byDate[c.date] || new Set();
  for (const t of pool.teams) s.add(String(t).toUpperCase());
}
let dates = Object.keys(byDate).sort();
if (SHARD.length === 2 && SHARD[1] > 1) dates = dates.filter((d, i) => i % SHARD[1] === SHARD[0]);
console.log(`${SPORT}: ${dates.length} dates from pulled contests (${dates[0]} .. ${dates[dates.length - 1]})`);

function playersFrom(sum) {
  const out = [];
  for (const t of (sum.boxscore || {}).players || []) {
    const team = String(t.team.abbreviation || "").toUpperCase(), cat = Object.fromEntries(t.statistics.map(s => [s.name, s]));
    const rec = {};   // one row per player, accumulating across categories
    const touch = (nm, f) => { const k = nrm(nm); const r = rec[k] || (rec[k] = { name: nm, team, pts: 0, pass: 0, rush: 0, rec: 0, recs: 0, tds: 0 }); f(r); };
    const each = (c, f) => { const s = cat[c]; if (!s) return; const L = s.labels; for (const a of s.athletes) f(a.athlete.displayName, Object.fromEntries(L.map((l, i) => [l, a.stats[i]]))); };
    each("passing", (nm, s) => touch(nm, r => { const y = n(s.YDS); r.pass = y; r.tds += n(s.TD); r.pts += 0.04 * y + 4 * n(s.TD) - n(s.INT); }));
    each("rushing", (nm, s) => touch(nm, r => { const y = n(s.YDS); r.rush = y; r.tds += n(s.TD); r.pts += 0.1 * y + 6 * n(s.TD) + (y >= 100 ? 3 : 0); }));
    each("receiving", (nm, s) => touch(nm, r => { const y = n(s.YDS); r.rec = y; r.recs = n(s.REC); r.tds += n(s.TD); r.pts += n(s.REC) + 0.1 * y + 6 * n(s.TD) + (y >= 100 ? 3 : 0); }));
    each("fumbles", (nm, s) => touch(nm, r => { r.pts -= n(s.LOST); }));
    each("kickReturns", (nm, s) => touch(nm, r => { r.pts += 6 * n(s.TD); }));
    each("puntReturns", (nm, s) => touch(nm, r => { r.pts += 6 * n(s.TD); }));
    for (const r of Object.values(rec)) { r.pts = +r.pts.toFixed(2); out.push(r); }
  }
  return out;
}

let done = 0, games = 0, skipped = 0; const t0 = Date.now();
async function doDate(date) {
  const file = path.join(outDir, date + ".json");
  if (fs.existsSync(file) && !FORCE) { skipped++; return; }
  const want = byDate[date];
  const boards = await Promise.all(GROUPS.map(g => getJ(`${API}/scoreboard?dates=${date.replace(/-/g, "")}${g ? "&groups=" + g : ""}&limit=200`).catch(() => ({ events: [] }))));
  const evs = [], seen = new Set();
  for (const b of boards) for (const e of b.events || []) {
    if (seen.has(e.id) || !(e.competitions && e.competitions[0])) continue; seen.add(e.id);
    const tt = (e.competitions[0].competitors || []).map(c => String((c.team || {}).abbreviation || "").toUpperCase());
    if (tt.some(x => want.has(x))) evs.push({ id: e.id, teams: tt });
  }
  const out = { date, games: [] };
  for (const e of evs) {
    try {
      const sum = await getJ(`${API}/summary?event=${e.id}`);
      const comp = ((sum.header || {}).competitions || [])[0]; if (!comp) continue;
      out.games.push({ id: e.id, teams: e.teams, final: /FINAL/.test(comp.status.type.name), players: playersFrom(sum) });
    } catch { /* a game without a box score is simply left out */ }
  }
  fs.writeFileSync(file, JSON.stringify(out));
  games += out.games.length; done++;
  if (done % 5 === 0) console.log(`  ${done}/${dates.length} dates, ${games} games, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
let next = 0;
await Promise.all(Array.from({ length: PAR }, async () => { while (next < dates.length) await doDate(dates[next++]); }));
console.log(`done: ${done} dates fetched (${skipped} already had), ${games} games -> ${outDir}`);
