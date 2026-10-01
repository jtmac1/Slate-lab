// Live DraftKings points during the games, from ESPN's public box scores (same scoring as
// bench/actuals-nfl.mjs), plus which games have started. Used by late swap: started players are
// locked at their live points, the rest are still simulated.
import { nrm } from "../src/engine/csv.mjs";
const API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`ESPN ${r.status}`); return r.json(); };
const ABBR = { WSH: "WAS", JAC: "JAX", LA: "LAR" }, ab = t => { const a = String(t || "").toUpperCase(); return ABBR[a] || a; };
const n = s => +String(s ?? "").split("/")[0].split("-")[0] || 0;
const NAME_RE = /[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+/g;

// date: the slate date (local). Returns { games: [{away, home, state, detail, started, final}], byKey: {nrm(name)|TEAM: pts, DST|TEAM: pts}, at }
export async function liveActuals(date, teams) {
  const dates = [date, new Date(new Date(date + "T12:00:00").getTime() + 864e5).toISOString().slice(0, 10)];
  const games = [], byKey = {};
  for (const d of dates) {
    const board = await getJ(`${API}/scoreboard?dates=${d.replace(/-/g, "")}`);
    for (const e of board.events || []) {
      const comp = e.competitions[0], tm = comp.competitors.map(c => ab(c.team.abbreviation));
      if (teams && !tm.some(t => teams.has(t))) continue;
      const st = comp.status.type, started = st.state !== "pre", final = /FINAL/i.test(st.name) || st.state === "post";
      const home = comp.competitors.find(c => c.homeAway === "home"), away = comp.competitors.find(c => c.homeAway === "away");
      const g = { id: e.id, away: ab(away.team.abbreviation), home: ab(home.team.abbreviation), state: st.state, detail: st.shortDetail, started, final, start: e.date, score: { [ab(away.team.abbreviation)]: +away.score, [ab(home.team.abbreviation)]: +home.score } };
      games.push(g);
      if (!started) continue;
      const sum = await getJ(`${API}/summary?event=${e.id}`), dst = {}; for (const t of sum.boxscore.players || []) dst[ab(t.team.abbreviation)] = { sacks: 0, int: 0, fr: 0, td: 0, saf: 0, blk: 0, retTd: 0 };
      const opp = t => Object.keys(dst).find(x => x !== t), add = (team, name, v) => { const k = nrm(name) + "|" + team; byKey[k] = (byKey[k] || 0) + v; };
      for (const t of sum.boxscore.players || []) {
        const team = ab(t.team.abbreviation), cat = Object.fromEntries(t.statistics.map(s => [s.name, s]));
        const each = (c, f) => { const s = cat[c]; if (!s) return; const L = s.labels; for (const a of s.athletes) { const stt = Object.fromEntries(L.map((l, i) => [l, a.stats[i]])); f(a.athlete.displayName, stt); } };
        each("passing", (nm, s) => { const y = n(s.YDS), td = n(s.TD), int = n(s.INT); add(team, nm, 0.04 * y + 4 * td - int + (y >= 300 ? 3 : 0)); if (dst[opp(team)]) { dst[opp(team)].sacks += n(s.SACKS); dst[opp(team)].int += int; } });
        each("rushing", (nm, s) => { const y = n(s.YDS); add(team, nm, 0.1 * y + 6 * n(s.TD) + (y >= 100 ? 3 : 0)); });
        each("receiving", (nm, s) => { const y = n(s.YDS); add(team, nm, n(s.REC) + 0.1 * y + 6 * n(s.TD) + (y >= 100 ? 3 : 0)); });
        each("fumbles", (nm, s) => { add(team, nm, -1 * n(s.LOST)); if (dst[opp(team)]) dst[opp(team)].fr += n(s.LOST); });
        each("kickReturns", (nm, s) => add(team, nm, 6 * n(s.TD))); each("puntReturns", (nm, s) => add(team, nm, 6 * n(s.TD)));
        each("kicking", (nm, s) => add(team, nm, n(s.XP)));
        each("interceptions", (nm, s) => { dst[team].td += n(s.TD); });
      }
      for (const p of sum.scoringPlays || []) {
        const team = ab(p.team.abbreviation), txt = p.text || "", type = (p.type && p.type.text) || "", both = type + " " + txt;
        const fg = txt.match(/^(.+?) (\d+) Yd Field Goal/i); if (fg) { const d = +fg[2]; add(team, fg[1], 3 + (d >= 50 ? 2 : d >= 40 ? 1 : 0)); }
        if (/Two[- ]Point/i.test(both) && /Conversion/i.test(both)) for (const m of txt.matchAll(/\(([^()]*?(?:Pass|Run|Rush)[^()]*?)\)/gi)) for (const nm of m[1].match(NAME_RE) || []) add(team, nm, 2);
        if (dst[team]) { if (/Fumble Return Touchdown|Fumble Recovery.*Touchdown|Blocked (Punt|Field Goal).*Touchdown|Kickoff Return Touchdown|Punt Return Touchdown/i.test(both)) { if (/Fumble|Blocked/i.test(both)) dst[team].td += 1; dst[team].retTd += 1; }
          if (/Interception Return Touchdown/i.test(both)) dst[team].retTd += 1; if (/Safety/i.test(type)) dst[team].saf += 1; if (/Blocked/i.test(txt)) dst[team].blk += 1; }
      }
      for (const team of Object.keys(dst)) { const o = opp(team), d = dst[team], pa = Math.max(0, (g.score[o] || 0) - 7 * (dst[o]?.retTd || 0)); const paPts = pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4; byKey["DST|" + team] = +(d.sacks + 2 * d.int + 2 * d.fr + 6 * d.td + 2 * d.saf + 2 * d.blk + paPts).toFixed(2); }
    }
  }
  for (const k of Object.keys(byKey)) byKey[k] = +byKey[k].toFixed(2);
  return { games, byKey, at: new Date().toISOString() };
}
