// ESPN NBA box-score cache shared by the lab projection (bench/proj-nba.mjs, bench/fit-proj-nba.mjs). Same trimmed + gzipped format
// as bench/backtest-lateswap-nba.mjs: data/nba-pbp/sb-<date>.json.gz (scoreboard) + g-<id>.json.gz (box + plays). 2024-25 (prior
// season for the early 2025-26 backtest) lives in data/nba-pbp/2024-25/ with box only, so the other NBA fits never see it.
//   node bench/nba-espn.mjs <from> <to> [--dir=data/nba-pbp] [--box-only]   -> fetch every final game in [from, to], 4 at a time
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const CACHE = "data/nba-pbp", PRIOR = "data/nba-pbp/2024-25";
const gzr = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8")), gzw = (f, o) => fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(o), { level: 6 }));
const get = async u => { for (let t = 0; t < 3; t++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(r => setTimeout(r, 1500)); } return null; };
const trimPlay = p => ({ t: p.type?.text || "", x: p.text || "", per: p.period?.number, clk: p.clock?.displayValue, sv: p.scoringPlay ? p.scoreValue : 0, h: p.homeScore, a: p.awayScore, ids: (p.participants || []).map(q => q.athlete?.id) });
const trimBox = b => (b?.players || []).map(t => { const s = t.statistics[0]; return { team: t.team.abbreviation, labels: s.labels || s.names,
  ath: (s.athletes || []).map(a => ({ id: a.athlete.id, name: a.athlete.displayName, starter: !!a.starter, dnp: !!a.didNotPlay || !a.stats?.length, stats: a.stats })) }; });
const addDay = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export async function fetchRange(from, to, { dir = CACHE, boxOnly = false, log = true } = {}) {
  fs.mkdirSync(dir, { recursive: true }); let nNew = 0;
  const dates = []; for (let d = from; d <= to; d = addDay(d, 1)) dates.push(d);
  for (const d of dates) {
    const sf = path.join(dir, `sb-${d}.json.gz`);
    let sb = fs.existsSync(sf) ? gzr(sf) : null;
    if (!sb || sb.some(e => !e.final)) { const r = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d.replace(/-/g, "")}`); if (!r) { console.log("scoreboard failed " + d); continue; }
      sb = (r.events || []).filter(e => !/preseason|all-star/i.test(e.season?.slug || "") && e.season?.type !== 1).map(e => ({ id: e.id, final: !!e.competitions[0].status.type.completed, teams: e.competitions[0].competitors.map(c => ({ abbr: c.team.abbreviation, ha: c.homeAway })) }));
      gzw(sf, sb); }
    const todo = sb.filter(e => e.final && !fs.existsSync(path.join(dir, `g-${e.id}.json.gz`)));
    for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(async e => {
      const s = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${e.id}`); if (!s?.boxscore?.players?.length) { console.log("no box " + e.id); return; }
      gzw(path.join(dir, `g-${e.id}.json.gz`), { id: e.id, date: d, teams: e.teams, box: trimBox(s.boxscore), plays: boxOnly ? [] : (s.plays || []).map(trimPlay) }); nNew++; }));
    if (log) process.stdout.write(`\r${d} new games ${nNew}   `);
  }
  if (log) console.log();
  return nNew;
}

// DK points from a box line
export const dk = s => { const tens = [s.pts, s.reb, s.ast, s.stl, s.blk].filter(x => x >= 10).length;
  return s.pts + 0.5 * s.tpm + 1.25 * s.reb + 1.5 * s.ast + 2 * s.stl + 2 * s.blk - 0.5 * s.to + (tens >= 2 ? 1.5 : 0) + (tens >= 3 ? 3 : 0); };
// all cached games (both dirs), date order, compact: { id, date, home, teams: { ABBR: { opp, pts, players: [{ id, name, starter, dnp, min, dk }] } } }
export function loadGames({ dirs = [PRIOR, CACHE], to = "9999" } = {}) {
  const out = [];
  for (const dir of dirs) { if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => /^g-.*\.json\.gz$/.test(f))) {
      const g = gzr(path.join(dir, f)); if (g.date >= to || g.box.length !== 2) continue;
      const T = {};
      for (const t of g.box) { const L = t.labels, players = [];
        for (const a of t.ath) { const o = a.dnp ? null : Object.fromEntries(L.map((l, i) => [l, a.stats[i]]));
          const s = o && { pts: +o.PTS || 0, tpm: +String(o["3PT"]).split("-")[0] || 0, reb: +o.REB || 0, ast: +o.AST || 0, to: +o.TO || 0, stl: +o.STL || 0, blk: +o.BLK || 0 };
          players.push({ id: a.athlete?.id || a.id, name: a.name, starter: a.starter, dnp: a.dnp || !(+o?.MIN > 0), min: o ? +o.MIN || 0 : 0, dk: s ? dk(s) : 0, pts: s ? s.pts : 0 }); }
        T[t.team] = { players, pts: players.reduce((a, p) => a + p.pts, 0) }; }
      const [A, B] = Object.keys(T); T[A].opp = B; T[B].opp = A;
      out.push({ id: g.id, date: g.date, home: g.teams.find(t => t.ha === "home")?.abbr, teams: T });
    } }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const [from, to] = process.argv.slice(2).filter(a => !a.startsWith("--")), dir = (process.argv.find(a => a.startsWith("--dir=")) || "").slice(6) || CACHE;
  if (!from || !to) { console.log("usage: node bench/nba-espn.mjs <from> <to> [--dir=...] [--box-only]"); process.exit(1); }
  await fetchRange(from, to, { dir, boxOnly: process.argv.includes("--box-only") });
}
