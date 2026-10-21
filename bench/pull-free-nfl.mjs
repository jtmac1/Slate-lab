// Free 2026 inputs for the play-by-play game sim that nflverse doesn't carry (2026-10-14):
//   routes  - SumerSports' public player tables: WR / TE routes run, targets per route, YPRR, target share, aDOT; RB rushing
//             (rushes, yards after contact, success %) and target share - Sumer's free RB table has no routes.
//             Season to date; each pull is kept as a dated snapshot so per-week routes come from the differences.
//   coverage - Sharp Football Analysis' public team coverage table: man / zone / middle-closed / middle-open rate.
//   weather - Open-Meteo forecast (free, no key) at each stadium for the next N days of games in data/nflverse/games.csv:
//             temperature, wind, gusts, precipitation over the first three hours from kickoff; domes are marked, not fetched.
//   node bench/pull-free-nfl.mjs [routes] [coverage] [weather] [--days=8] [--slate=<dir> --games=SEA@DEN,... --date=YYYY-MM-DD]
//   (no names = all three). With --slate (user, 2026-10-14: only what's relevant to the slate), weather is fetched only for the
//   slate's games, and data/<dir>/free-inputs.json gets just the slate's teams: routes, coverage and weather. Sumer and Sharp are
//   one page each for the whole league, so that request can't be narrowed; the slate file is the filtered copy the sim reads.
// Files: data/free/sumer-<pos>-<date>.json, data/free/sharp-coverage-<date>.json, data/weather/nfl-<date>.json, data/<dir>/free-inputs.json
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const want = process.argv.slice(2).filter(x => !x.startsWith("--")), all = !want.length, DAYS = +arg("days", 8);
const today = new Date().toLocaleString("sv-SE", { timeZone: "America/Chicago" }).slice(0, 10);
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const SLATE = arg("slate", null), SLATE_DATE = arg("date", today), SLATE_GAMES = (arg("games", "") || "").split(",").filter(Boolean);
// every source's team codes -> DraftKings' (Sumer uses ARZ/BLT/CLV/HST, nflverse LA for the Rams, Sharp full names)
const DK = { ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU", LA: "LAR", JAC: "JAX", WSH: "WAS" };
const dk = t => DK[t] || t;
const NAMES = { "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB", "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
  "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS" };
const slateTeams = new Set(SLATE_GAMES.flatMap(g => g.split("@").map(dk)));
const latest = prefix => { try { const f = fs.readdirSync("data/free").filter(x => x.startsWith(prefix)).sort().pop(); return f ? JSON.parse(fs.readFileSync(path.join("data/free", f), "utf8")) : null; } catch { return null; } };
const text = h => h.replace(/<span class="inline md:hidden[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
const tables = h => [...h.matchAll(/<table[\s\S]*?<\/table>/g)].map(t => [...t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => text(c[1]))));
const num = v => { const x = parseFloat(String(v).replace(/[%,]/g, "")); return isNaN(x) ? null : x; };
const save = (dir, name, obj) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj, null, 1)); return f; };

async function routes() {
  for (const [pos, slug] of [["WR", "wide-receiver"], ["TE", "tight-end"], ["RB", "running-back"]]) {
    const h = await fetch(`https://sumersports.com/players/${slug}/?plays=1`, UA).then(r => { if (!r.ok) throw new Error(`Sumer ${slug} ${r.status}`); return r.text(); });
    const season = +((h.match(/(20\d\d) Season/) || [])[1] || 0), updated = (h.match(/Updated ([\d-]+ [\d:]+ [AP]M ET)/) || [])[1] || null;
    const T = tables(h).find(t => t[0] && /Routes Run|Rushes/i.test(t[0].join(" ")));   // the RB table has rushing, not routes
    if (!T) throw new Error(`Sumer ${slug}: no player table`);
    const head = T[0].map(x => x.replace(/\s+/g, " ")), rows = T.slice(1).filter(r => r.length >= head.length - 2).map(r => {
      const m = r[0].match(/^(\d+)\s+([A-Z]{2,3})\s+(.+)$/) || [null, null, null, r[0]], o = { pos, team: m[2] && dk(m[2]), player: m[3] };
      head.slice(1).forEach((k, i) => { o[k] = num(r[i + 1]); }); return o; });
    console.log(`routes ${pos}: ${rows.length} players, ${season} season, updated ${updated} -> ${save("data/free", `sumer-${pos.toLowerCase()}-${today}.json`, { source: `sumersports.com/players/${slug}`, season, updated, pulled: new Date().toISOString(), columns: head, rows })}`);
  }
}

async function coverage() {
  const h = await fetch("https://www.sharpfootballanalysis.com/stats-nfl/nfl-coverage-schemes/", UA).then(r => { if (!r.ok) throw new Error(`Sharp ${r.status}`); return r.text(); });
  const season = +((h.match(/(20\d\d) Season/) || [])[1] || 0), week = +((h.match(/Week (\d+)/) || [])[1] || 0);
  const T = tables(h).find(t => t[0] && /Man Rate/i.test(t[0].join(" ")));
  if (!T) throw new Error("Sharp: no coverage table");
  const rows = T.slice(1).filter(r => r.length === T[0].length).map(r => Object.assign({ team: NAMES[r[0]] || null }, Object.fromEntries(T[0].map((k, i) => [k, i ? num(r[i]) : r[i]]))));
  console.log(`coverage: ${rows.length} teams, ${season} through week ${week} -> ${save("data/free", `sharp-coverage-${today}.json`, { source: "sharpfootballanalysis.com/stats-nfl/nfl-coverage-schemes", season, week, pulled: new Date().toISOString(), rows })}`);
}

// home stadiums (2026) and the neutral sites in the schedule; roof comes from games.csv
const STADIUM = { ARI: [33.528, -112.263], ATL: [33.755, -84.401], BAL: [39.278, -76.623], BUF: [42.774, -78.787], CAR: [35.226, -80.853], CHI: [41.862, -87.617], CIN: [39.095, -84.516], CLE: [41.506, -81.700],
  DAL: [32.748, -97.093], DEN: [39.744, -105.020], DET: [42.340, -83.046], GB: [44.501, -88.062], HOU: [29.685, -95.411], IND: [39.760, -86.164], JAX: [30.324, -81.637], KC: [39.049, -94.484],
  LV: [36.091, -115.184], LA: [33.953, -118.339], LAC: [33.953, -118.339], MIA: [25.958, -80.239], MIN: [44.974, -93.258], NE: [42.091, -71.264], NO: [29.951, -90.081], NYG: [40.814, -74.074],
  NYJ: [40.814, -74.074], PHI: [39.901, -75.168], PIT: [40.447, -80.016], SF: [37.403, -121.970], SEA: [47.595, -122.332], TB: [27.976, -82.503], TEN: [36.166, -86.771], WAS: [38.908, -76.865] };
const NEUTRAL = { "Wembley Stadium": [51.556, -0.280], "Tottenham Hotspur Stadium": [51.604, -0.066], "Stade de France": [48.924, 2.360], "Olympiastadion": [52.515, 13.239], "Allianz Arena": [48.219, 11.625],
  "Estadio Santiago Bernabeu": [40.453, -3.688], "Croke Park": [53.361, -6.251], "Melbourne Cricket Ground": [-37.820, 144.983], "Maracana": [-22.912, -43.230], "Estadio Azteca": [19.303, -99.150] };

async function weather() {
  const L = fs.readFileSync("data/nflverse/games.csv", "utf8").trim().split(/\r?\n/), H = L[0].split(","), ix = k => H.indexOf(k);
  const end = new Date(Date.parse(today) + DAYS * 864e5).toISOString().slice(0, 10);
  // a slate: only its games (matched by teams within the slate's week, so Thu-Mon slates work); otherwise the next N days
  const from = SLATE ? SLATE_DATE : today, to = SLATE ? new Date(Date.parse(SLATE_DATE) + 6 * 864e5).toISOString().slice(0, 10) : end;
  const games = L.slice(1).map(l => l.split(",")).filter(c => c[ix("gameday")] >= from && c[ix("gameday")] <= to && c[ix("game_type")] === "REG" && (!SLATE || SLATE_GAMES.includes(`${dk(c[ix("away_team")])}@${dk(c[ix("home_team")])}`)));
  const out = [];
  for (const c of games) {
    const g = { game_id: c[ix("game_id")], away: dk(c[ix("away_team")]), home: dk(c[ix("home_team")]), gameday: c[ix("gameday")], kickoffET: c[ix("gametime")], roof: c[ix("roof")].replace(/"/g, "") || null, stadium: c[ix("stadium")] };
    const at = c[ix("location")] === "Neutral" ? Object.entries(NEUTRAL).find(([k]) => g.stadium.includes(k))?.[1] : STADIUM[g.home === "LAR" ? "LA" : g.home];
    if (/dome|closed/.test(g.roof || "")) { out.push(Object.assign(g, { indoor: true })); continue; }
    if (!at) { out.push(Object.assign(g, { note: "no coordinates for " + g.stadium })); continue; }
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${at[0]}&longitude=${at[1]}&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&start_date=${g.gameday}&end_date=${g.gameday}`;
    try {
      const j = await fetch(u).then(r => r.json()), h0 = +g.kickoffET.slice(0, 2), hrs = [0, 1, 2].map(k => h0 + k).filter(h => h < 24), pick = k => hrs.map(h => j.hourly[k][h]).filter(v => v != null);
      const avg = a => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : null;
      out.push(Object.assign(g, { indoor: !g.roof ? null : false, tempF: avg(pick("temperature_2m")), windMph: avg(pick("wind_speed_10m")), gustMph: Math.max(...pick("wind_gusts_10m")), precipIn: +pick("precipitation").reduce((s, x) => s + x, 0).toFixed(2), precipProb: Math.max(...pick("precipitation_probability")), roofUnknown: !g.roof || undefined }));
    } catch (e) { out.push(Object.assign(g, { error: e.message })); }
  }
  for (const g of out) console.log(`  ${g.gameday} ${g.away}@${g.home} ${g.indoor ? "indoor" : g.tempF != null ? `${g.tempF}F wind ${g.windMph} (gust ${g.gustMph}) mph, precip ${g.precipIn}in ${g.precipProb}%${g.roofUnknown ? " (retractable roof: open/closed unknown)" : ""}` : g.note || g.error}`);
  const W = { pulled: new Date().toISOString(), source: "open-meteo.com forecast", slate: SLATE, games: out };
  if (SLATE) { lastWeather = W; console.log(`weather: ${out.length} of ${SLATE_GAMES.length} slate games`); }
  else console.log(`weather: ${out.length} games -> ${save("data/weather", `nfl-${today}.json`, W)}`);
}
let lastWeather = null;

// the slate's copy: only its teams, from the newest routes / coverage pulls and this run's weather
function slateFile() {
  const R = ["wr", "te", "rb"].map(p => latest(`sumer-${p}-`)).filter(Boolean), C = latest("sharp-coverage-");
  const out = { built: new Date().toISOString(), slate: SLATE, games: SLATE_GAMES, teams: [...slateTeams],
    routes: { pulled: R.map(r => r.pulled).sort().pop() || null, rows: R.flatMap(r => r.rows.filter(x => slateTeams.has(x.team))) },
    coverage: C ? { pulled: C.pulled, season: C.season, week: C.week, rows: C.rows.filter(x => slateTeams.has(x.team)) } : null,
    weather: lastWeather };
  const missing = [...slateTeams].filter(t => !out.routes.rows.some(x => x.team === t) || !(out.coverage && out.coverage.rows.some(x => x.team === t)));
  console.log(`slate ${SLATE}: ${out.teams.length} teams, ${out.routes.rows.length} route rows, ${out.coverage ? out.coverage.rows.length : 0} coverage rows, ${lastWeather ? lastWeather.games.length : 0} weather${missing.length ? " - missing " + missing.join(" ") : ""} -> ${save(path.join("data", SLATE), "free-inputs.json", out)}`);
}

for (const [k, f] of [["routes", routes], ["coverage", coverage], ["weather", weather]]) if (all || want.includes(k)) { try { await f(); } catch (e) { console.error(`${k} FAILED: ${e.message}`); process.exitCode = 1; } }
if (SLATE) { if (!SLATE_GAMES.length) { console.error("--slate needs --games"); process.exitCode = 1; } else slateFile(); }
