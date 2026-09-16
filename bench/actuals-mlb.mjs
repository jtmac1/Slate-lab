// Actual DraftKings MLB points for a slate from the MLB stats API (box scores), matched to the
// slate's projections file. Writes <dir>/actuals.csv (Player, Team, Pos, Salary, Proj, Own, Actual).
//   node bench/actuals-mlb.mjs data/2026-09-16-mlb-early            (date from the dir name; games from slate.json or the file's teams)
//   node bench/actuals-mlb.mjs data/2026-09-11-mlb-main --validate  (also checks lineup sums against pulled contests' actual FP)
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const dir = process.argv[2], VALIDATE = process.argv.includes("--validate");
const date = (path.basename(dir).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
const all = parseCSV(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => /Projections\.csv$/i.test(f))), "utf8")), H = all[0].map(h => h.trim()), rows = all.slice(1).filter(r => r.length > 1);
const col = n => H.findIndex(h => h.toLowerCase() === n.toLowerCase());
const cName = col("Player"), cTeam = col("Team"), cPos = col("Position"), cSal = col("Salary"), cProj = col("Projection"), cOwn = col("Ownership %");
const teams = new Set(rows.map(r => r[cTeam]));
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const sched = await getJ(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team`);
const ABBR = { CWS: "CWS", CHW: "CWS", WSH: "WSH", WAS: "WSH", ATH: "ATH", OAK: "ATH", SD: "SD", SF: "SF", TB: "TB", KC: "KC", AZ: "ARI", ARI: "ARI" };
const ab = t => { const a = (t.abbreviation || "").toUpperCase(); return ABBR[a] || a; };
const games = (sched.dates[0]?.games || []).filter(g => teams.has(ab(g.teams.home.team)) || teams.has(ab(g.teams.away.team)));
// DK MLB classic scoring
const hitPts = s => 3 * ((s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0)) + 5 * (s.doubles || 0) + 8 * (s.triples || 0) + 10 * (s.homeRuns || 0) + 2 * (s.rbi || 0) + 2 * (s.runs || 0) + 2 * (s.baseOnBalls || 0) + 2 * (s.hitByPitch || 0) + 5 * (s.stolenBases || 0);
const ip = s => { const [w, f] = String(s.inningsPitched || "0").split("."); return +w + (+f || 0) / 3; };
const pitPts = s => 2.25 * ip(s) + 2 * (s.strikeOuts || 0) + 4 * (s.wins || 0) - 2 * (s.earnedRuns || 0) - 0.6 * (s.hits || 0) - 0.6 * (s.baseOnBalls || 0) - 0.6 * (s.hitByPitch || 0) + 2.5 * (s.completeGames || 0) + 2.5 * (s.shutouts || 0) + 5 * ((s.completeGames || 0) && (s.hits || 0) === 0 ? 1 : 0);
const act = {}, status = [];
for (const g of games) {
  const box = await getJ(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
  status.push(`${ab(g.teams.away.team)}@${ab(g.teams.home.team)} ${g.status.detailedState}`);
  for (const side of ["away", "home"]) { const t = box.teams[side]; for (const p of Object.values(t.players)) {
    const nm = nrm(p.person.fullName), b = p.stats?.batting || {}, pi = p.stats?.pitching || {};
    const isP = (p.position?.abbreviation === "P") || (pi.inningsPitched != null && !b.atBats && !b.plateAppearances);
    const pts = isP ? pitPts(pi) : hitPts(b) + (pi.inningsPitched ? pitPts(pi) : 0);
    const played = isP ? pi.inningsPitched != null || (pi.battersFaced || 0) > 0 : (b.plateAppearances || 0) > 0;
    const rec = { pts: +pts.toFixed(2), played, isP, team: ab(t.team), final: /Final|Completed|Game Over/.test(g.status.detailedState) };
    act[nm + "|" + ab(t.team)] = rec; if (!act[nm] || act[nm].dup) { act[nm] = Object.assign({}, rec, { dup: !!act[nm] }); } else act[nm] = Object.assign({}, act[nm], { dup: true });
  } }
}
console.log(`${date}: ${games.length} slate games - ${status.join(", ")}`);
const out = [["Player", "Team", "Position", "Salary", "Projection", "Ownership %", "Actual", "Played", "Final"].join(",")]; let matched = 0, unmatched = [];
const noMid = n => n.replace(/\s+[A-Z]\.?\s+/, " ");   // "Josh H. Smith" -> "Josh Smith": the stats API drops middle initials
const lookup = (name, team) => { for (const nm of [name, noMid(name)]) { const k = nrm(nm); if (act[k + "|" + team]) return act[k + "|" + team]; if (act[k] && !act[k].dup) return act[k]; } return null; };
for (const r of rows) { const a = lookup(r[cName], r[cTeam]); if (a) matched++; else if (+r[cProj] > 0) unmatched.push(r[cName]); out.push([r[cName], r[cTeam], r[cPos], r[cSal], r[cProj], (+r[cOwn]).toFixed(2), a ? a.pts : "", a ? (a.played ? 1 : 0) : "", a ? (a.final ? 1 : 0) : ""].join(",")); }
fs.writeFileSync(path.join(dir, "actuals.csv"), out.join("\n") + "\n");
console.log(`matched ${matched}/${rows.length} players; projected-but-unmatched: ${unmatched.length}${unmatched.length ? " (" + unmatched.slice(0, 8).join(", ") + ")" : ""}; wrote ${path.join(dir, "actuals.csv")}`);
if (VALIDATE) {
  for (const file of listPost("mlb", f => f.startsWith(date))) {
    const j = readPost(file), byId = {}; for (const p of j.players) byId[p.id] = p;
    let n = 0, err = 0, big = 0;
    for (const l of j.lineups.slice(0, 3000)) { if (l.afp == null) continue; const pts = l.ids.map(id => { const p = byId[id]; return p ? (act[nrm(p.name) + "|" + p.team] || (act[nrm(p.name)] && !act[nrm(p.name)].dup ? act[nrm(p.name)] : null)) : null; }); if (pts.some(x => !x)) continue; const s = pts.reduce((a, x) => a + x.pts, 0); n++; err += Math.abs(s - l.afp); if (Math.abs(s - l.afp) > 1) big++; }
    console.log(`validate ${path.basename(file)}: ${n} lineups, mean |sum - actual FP| ${(err / (n || 1)).toFixed(2)}, off by >1: ${big}`);
  }
}
