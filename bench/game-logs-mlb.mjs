// Per-game MLB player logs with DraftKings points and batting order, for fitting the outcome
// model's MLB correlations (bench/fit-corr-mlb.mjs) from real results. Every game on each date
// that appears in data/post/mlb is fetched from the MLB stats API box scores.
//   node bench/game-logs-mlb.mjs [--par=6] [--force]
// Writes data/logs/mlb/<date>.json: { date, games: [{ id, teams: [away, home], final,
//   players: [{ name, team, isP, ord, pts, played }] }] }
// Scoring mirrors bench/actuals-mlb.mjs (DK MLB classic). ord is the batting-order slot 1-9 for
// starters (0 for pitchers and subs).
import fs from "node:fs";
import path from "node:path";
import { listPost, readPost } from "./post-store.mjs";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const PAR = flag("par") || 6, FORCE = process.argv.includes("--force");
const outDir = path.join("data/logs", "mlb"); fs.mkdirSync(outDir, { recursive: true });
const dates = [...new Set(listPost("mlb").map(f => readPost(f).contest.date))].filter(Boolean).sort();
const getJ = async u => { for (let t = 0; t < 3; t++) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await new Promise(r => setTimeout(r, 800)); } throw new Error("fetch failed " + u); };
const ABBR = { CHW: "CWS", WAS: "WSH", OAK: "ATH", AZ: "ARI" };
const ab = t => { const a = (t.abbreviation || "").toUpperCase(); return ABBR[a] || a; };
const hitPts = s => 3 * ((s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0)) + 5 * (s.doubles || 0) + 8 * (s.triples || 0) + 10 * (s.homeRuns || 0) + 2 * (s.rbi || 0) + 2 * (s.runs || 0) + 2 * (s.baseOnBalls || 0) + 2 * (s.hitByPitch || 0) + 5 * (s.stolenBases || 0);
const ip = s => { const [w, f] = String(s.inningsPitched || "0").split("."); return +w + (+f || 0) / 3; };
const pitPts = s => 2.25 * ip(s) + 2 * (s.strikeOuts || 0) + 4 * (s.wins || 0) - 2 * (s.earnedRuns || 0) - 0.6 * (s.hits || 0) - 0.6 * (s.baseOnBalls || 0) - 0.6 * (s.hitByPitch || 0) + 2.5 * (s.completeGames || 0) + 2.5 * (s.shutouts || 0) + 5 * ((s.completeGames || 0) && (s.hits || 0) === 0 ? 1 : 0);

async function oneDate(date) {
  const file = path.join(outDir, date + ".json");
  if (!FORCE && fs.existsSync(file)) return "cached";
  const sched = await getJ(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team`);
  const games = [];
  for (const g of sched.dates[0]?.games || []) {
    const final = /Final|Completed|Game Over/.test(g.status.detailedState);
    if (!final) continue;
    const box = await getJ(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const players = [];
    for (const side of ["away", "home"]) {
      const t = box.teams[side], team = ab(t.team);
      for (const p of Object.values(t.players)) {
        const b = p.stats?.batting || {}, pi = p.stats?.pitching || {};
        const isP = (p.position?.abbreviation === "P") || (pi.inningsPitched != null && !b.atBats && !b.plateAppearances);
        const pts = isP ? pitPts(pi) : hitPts(b) + (pi.inningsPitched ? pitPts(pi) : 0);
        const played = isP ? pi.inningsPitched != null || (pi.battersFaced || 0) > 0 : (b.plateAppearances || 0) > 0;
        if (!played) continue;
        const bo = +(p.battingOrder || 0), ord = isP ? 0 : (bo % 100 === 0 ? bo / 100 : 0);   // 100..900 = starting slot; 101 etc. = substitute
        players.push({ name: p.person.fullName, team, isP, ord, pts: +pts.toFixed(2), starter: isP ? (pi.gamesStarted || 0) > 0 : ord > 0 });
      }
    }
    games.push({ id: g.gamePk, teams: [ab(g.teams.away.team), ab(g.teams.home.team)], final, players });
  }
  fs.writeFileSync(file, JSON.stringify({ date, games }));
  return games.length + " games";
}
let i = 0, done = 0;
await Promise.all(Array.from({ length: PAR }, async () => { while (i < dates.length) { const d = dates[i++]; try { const r = await oneDate(d); done++; console.log(`${d}: ${r}`); } catch (e) { console.log(`${d}: FAILED ${e.message}`); } } }));
console.log(`${done}/${dates.length} dates written to ${outDir}`);
