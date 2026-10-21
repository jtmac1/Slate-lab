// Actual DK points for NFL classic player-weeks (2026-10-15), for fitting the sim's player distributions on real results.
// Each QB/RB/WR/TE player-week in the pulled classic contests (from the biggest contest that had him: its projection and
// Lab own) is joined to nflverse weekly stats by team + name (first initial + last name as a fallback: Kenny / Kenneth).
// A player on that team's stat sheet that season with no row that week was inactive or never touched the ball: a real DK
// zero, kept (dropping those flatters cheap and low-owned players). DST isn't covered. Points recovered from real lineups
// can't stand in for this: every lineup has one QB and one DST, so the split between positions is unidentified.
import fs from "node:fs";
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";
import { parseCSV } from "../src/engine/csv.mjs";
import { ownModel } from "../server/sources.mjs";

// -> [{ date, test (date >= split), games, y, wk, team, opp, pos, proj, own, act }]
export function nflPlayerWeeks({ main = false, split = "2026-03-01" } = {}) {
  const MAIN = main, SPLIT = split;
  // actual DK points from nflverse weekly stats (PPR + DK's -1 INT / -1 fumble lost + 100/300-yard bonuses); DST not covered
  const nrm = x => String(x).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, ""), DK = { LA: "LAR" }, dk = t => DK[t] || t;
  const ACT = {}, SEEN = new Set(), ini_ = x => { const w = String(x).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z ]/g, "").trim().split(/\s+/); return w[0][0] + w[w.length - 1]; };   // first initial + last name: Kenny / Kenneth
  for (const y of [2025, 2026]) { const [h, ...rs] = parseCSV(fs.readFileSync(`data/nflverse/stats_player_week_${y}.csv`, "utf8")), ix = k => h.indexOf(k);
    for (const r of rs) { if (r[ix("season_type")] !== "REG") continue; const n = k => +r[ix(k)] || 0;
      const pts = n("fantasy_points_ppr") + n("passing_interceptions") + n("rushing_fumbles_lost") + n("receiving_fumbles_lost") + n("sack_fumbles_lost") + (n("passing_yards") >= 300 ? 3 : 0) + (n("rushing_yards") >= 100 ? 3 : 0) + (n("receiving_yards") >= 100 ? 3 : 0);
      const t = dk(r[ix("team")]), nm = nrm(r[ix("player_display_name")]), ini = ini_(r[ix("player_display_name")]);
      ACT[`${y}|${+r[ix("week")]}|${t}|${nm}`] = pts; ACT[`${y}|${+r[ix("week")]}|${t}|~${ini}`] = pts; SEEN.add(`${y}|${t}|${nm}`); SEEN.add(`${y}|${t}|~${ini}`); } }
  const sched = fs.readFileSync("data/nflverse/games.csv", "utf8").trim().split(/\r?\n/), H = sched[0].split(","), gx = k => H.indexOf(k);
  const games0 = sched.slice(1).map(l => l.split(",")).filter(c => +c[gx("season")] >= 2025 && c[gx("game_type")] === "REG");
  const weekOf = (date, team) => { const d0 = Date.parse(date); let best = null, bd = 1e18; for (const c of games0) { if (dk(c[gx("home_team")]) !== team && dk(c[gx("away_team")]) !== team) continue; const d = Date.parse(c[gx("gameday")]) - d0; if (d >= -864e5 && d <= 6 * 864e5 && d < bd) { bd = d; best = c; } } return best ? { y: +best[gx("season")], wk: +best[gx("week")] } : null; };   // the team's first game on or after the contest date
  // one row per player-week, from the biggest contest that had him (its Lab own); main-slate flag from that contest
  const cands = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.entries >= 300).sort((a, b) => b.entries - a.entries);
  const byPW = new Map(); let unmatched = 0, matched = 0, zeros = 0;
  for (const c of cands) {
    const j = readPost(c.json), PS = j.players.filter(p => /^(QB|RB|WR|TE)$/.test(p.pos) && p.sal > 0); if (PS.length < 20) continue;
    const games = new Set(j.players.filter(p => p.team && p.opp).map(p => [p.team, p.opp].sort().join("@"))).size; if (MAIN && games < 9) continue;
    const r = j.players.map(p => ({ pos: String(p.pos).split("/")[0], team: p.team, sal: p.sal, proj: p.proj, vown: 100 * (p.pown || 0) })); ownModel("classic")(r, { n: c.entries, fee: c.fee });
    j.players.forEach((p, i) => { if (!/^(QB|RB|WR|TE)$/.test(p.pos) || !(p.proj >= 3)) return; const w = weekOf(c.date, p.team); if (!w) return;
      const k = `${w.y}|${w.wk}|${p.team}|${nrm(p.name)}`; if (byPW.has(k)) return; const ki = `${w.y}|${w.wk}|${p.team}|~${ini_(p.name)}`; let act = ACT[k] ?? ACT[ki];
      // no stat row that week but on the team's stat sheet that season: inactive or no touches, a real DK zero
      if (act == null && (SEEN.has(`${w.y}|${p.team}|${nrm(p.name)}`) || SEEN.has(`${w.y}|${p.team}|~${ini_(p.name)}`))) { act = 0; zeros++; }
      if (act == null) { unmatched++; if (process.env.DBG && Math.random() < 0.05) console.error("UNM", k, p.pos, p.proj.toFixed(1)); return; } matched++;
      byPW.set(k, { date: c.date, test: c.date >= SPLIT, games, y: w.y, wk: w.wk, team: p.team, opp: p.opp, pos: p.pos, proj: p.proj, own: Math.max(0.3, r[i].labOwn ?? 100 * (p.pown || 0)), act }); });
  }
  const rows = [...byPW.values()];
  console.error(`matched ${matched} (${zeros} of them no stat row that week = 0 pts), unmatched ${unmatched}`);
  return rows;
}
