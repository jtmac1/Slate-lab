// Pinnacle NFL lines from the public guest feed (no account): every game's spread, total, moneyline
// and team totals, plus every player prop, saved as a timestamped snapshot. The feed only serves the
// current week, so the archive starts at the first pull (2026-10-01) and grows one file per run.
//   node bench/pull-pinnacle-nfl.mjs        -> data/odds/nfl/<YYYY-MM-DD-HHMM>.json and -proj.csv
// Team for each prop comes from data/nfl-ref/players-2026.json and is checked against the game's two
// teams; a player missing from the reference keeps team "" and is dropped by the projection step.
// The hub server calls pullPinnacle() on Refresh.
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { marketProj, writeProj } from "./market-proj-nfl.mjs";

const BASE = "https://guest.api.arcadia.pinnacle.com/0.1/leagues/889";
const KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";   // Pinnacle's guest key, the one their own site sends
const getJ = async u => { const r = await fetch(u, { headers: { "X-API-Key": KEY, Accept: "application/json" } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

export const ABBR = { "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB", "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG", "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS" };
const UNITS = { "Passing Yards": "passYds", "Rushing Yards": "rushYds", "Receiving Yards": "recYds", "Receptions": "rec", "Touchdown Passes": "passTD", "Interceptions": "int", "Touchdowns": "td", "Field Goals": "fg", "Pass Attempts": "passAtt", "Pass Completions": "passCmp", "Rush Attempts": "rushAtt" };

const pad = n => String(n).padStart(2, "0");
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

export async function pullPinnacle() {
  const REF = new Map();
  try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p); } catch {}
  const [matchups, markets] = await Promise.all([getJ(`${BASE}/matchups`), getJ(`${BASE}/markets/straight`)]);
  const mk = new Map(); for (const m of markets) { const a = mk.get(m.matchupId) || []; a.push(m); mk.set(m.matchupId, a); }
  const games = [], gameOf = new Map();
  for (const m of matchups.filter(m => m.type === "matchup" && !m.parentId)) {
    const home = m.participants.find(p => p.alignment === "home"), away = m.participants.find(p => p.alignment === "away");
    if (!home || !away) continue;
    const g = { id: m.id, home: ABBR[home.name] || home.name, away: ABBR[away.name] || away.name, start: m.startTime, spread: null, total: null, ttHome: null, ttAway: null, mlHome: null, mlAway: null };
    for (const x of (mk.get(m.id) || []).filter(x => x.period === 0 && !x.isAlternate)) {
      const by = d => x.prices.find(p => p.designation === d) || {};
      if (x.type === "spread") g.spread = by("home").points;
      else if (x.type === "total") g.total = by("over").points;
      else if (x.type === "team_total") g[x.side === "home" ? "ttHome" : "ttAway"] = by("over").points;
      else if (x.type === "moneyline") { g.mlHome = by("home").price; g.mlAway = by("away").price; }
    }
    games.push(g); gameOf.set(m.id, g);
  }
  const props = []; let noTeam = 0, noPrice = 0;
  for (const m of matchups.filter(m => m.type === "special" && m.special && m.special.category === "Player Props" && UNITS[m.units])) {
    const g = gameOf.get(m.parentId); if (!g) continue;
    const x = (mk.get(m.id) || [])[0]; if (!x || !x.prices) { noPrice++; continue; }
    const side = nm => { const pt = m.participants.find(p => p.name === nm); const pr = pt && x.prices.find(q => q.participantId === pt.id); return pr || {}; };
    const over = side("Over"), under = side("Under"); if (over.points == null) { noPrice++; continue; }
    const name = m.special.description.replace(/ Total .*$/, "").trim(), ref = REF.get(nrm(name));
    let team = ref ? ref.team : "", pos = ref ? ref.pos : "";
    if (team && team !== g.home && team !== g.away) team = "";   // reference is stale for this player
    if (!team) noTeam++;
    props.push({ name, team, pos, game: g.id, stat: UNITS[m.units], line: over.points, over: over.price, under: under.price });
  }
  const snap = { pulledAt: new Date().toISOString(), source: "pinnacle", games, props };
  const dir = "data/odds/nfl", st = stamp(new Date());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${st}.json`), JSON.stringify(snap));
  const rows = marketProj(snap);
  writeProj(rows, path.join(dir, `${st}-proj.csv`));
  return { stamp: st, games: games.length, props: props.length, players: new Set(props.map(p => p.name)).size, noTeam, noPrice, projected: rows.length, file: path.join(dir, `${st}.json`), gameList: games };
}

if (process.argv[1] && /pull-pinnacle-nfl\.mjs$/.test(process.argv[1])) {
  const r = await pullPinnacle();
  console.log(`${r.stamp}: ${r.games} games, ${r.props} props (${r.players} players, ${r.noTeam} without team, ${r.noPrice} unpriced), ${r.projected} projected players -> ${r.file}`);
  for (const g of r.gameList) console.log(`  ${g.away}@${g.home} ${g.start.slice(0, 16)}Z spread ${g.spread} total ${g.total} tt ${g.ttAway}/${g.ttHome}`);
}
