// Build the NFL reference cache in data/nfl-ref from ESPN's public site API:
// players-<season>.json (name, team, pos, plus one row per team defense) and
// schedule-<date>.json (home/away per game) for each date given on the command line.
//   node bench/nfl-ref.mjs 2026-09-13 2026-09-14
import fs from "node:fs";
import path from "node:path";

const REF = "data/nfl-ref", API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const DK_ABBR = { WSH: "WAS" };   // ESPN abbreviations that differ from DraftKings
const DK_POS = { PK: "K", FB: "RB" };   // ESPN positions that differ from DraftKings
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const abbr = t => DK_ABBR[t.abbreviation] || t.abbreviation;

const dates = process.argv.slice(2);
const season = (dates[0] || new Date().toISOString().slice(0, 10)).slice(0, 4);
fs.mkdirSync(REF, { recursive: true });

const tj = await getJ(`${API}/teams?limit=40`);
const teams = tj.sports[0].leagues[0].teams.map(t => t.team);
const players = [];
for (const t of teams) {
  const rj = await getJ(`${API}/teams/${t.id}/roster`);
  for (const g of rj.athletes || []) for (const a of g.items) players.push({ name: a.fullName, team: abbr(t), pos: a.position ? DK_POS[a.position.abbreviation] || a.position.abbreviation : "" });
  players.push({ name: t.name, team: abbr(t), pos: "DST" });                 // "Seahawks"
  players.push({ name: t.displayName, team: abbr(t), pos: "DST" });          // "Seattle Seahawks"
}
fs.writeFileSync(path.join(REF, `players-${season}.json`), JSON.stringify(players));
console.log(`players-${season}.json: ${players.length} rows across ${teams.length} teams`);

for (const d of dates) {
  const sj = await getJ(`${API}/scoreboard?dates=${d.replace(/-/g, "")}`);
  const games = [];
  for (const e of sj.events || []) {
    const c = e.competitions[0], home = c.competitors.find(x => x.homeAway === "home"), away = c.competitors.find(x => x.homeAway === "away");
    games.push({ home: abbr(home.team), away: abbr(away.team), time: e.date, status: e.status.type.detail });
  }
  fs.writeFileSync(path.join(REF, `schedule-${d}.json`), JSON.stringify(games));
  console.log(`schedule-${d}.json: ${games.map(g => g.away + "@" + g.home).join(" ")}`);
}
