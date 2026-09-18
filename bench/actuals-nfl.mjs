// Actual DraftKings NFL points for a slate from ESPN's public box scores, matched to the slate's
// projection file (Stokastic Data Hub NFL, ETR or Blick layout). Writes <dir>/actuals.csv.
//   node bench/actuals-nfl.mjs data/2026-09-17-nfl-detbuf [--validate]
// DK classic scoring; showdown captains are scaled by the grader, not here. Known approximations:
// 2-pt conversions and offensive fumble-recovery TDs come from the play text; DST points allowed
// subtracts 7 per opponent defensive/return TD.
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
const API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const dir = process.argv[2], VALIDATE = process.argv.includes("--validate");
const date = (path.basename(dir).match(/\d{4}-\d{2}-\d{2}/) || [])[0];
const projFile = fs.readdirSync(dir).find(f => /Projections\.csv$/i.test(f)) || fs.readdirSync(dir).find(f => /\.csv$/i.test(f) && !/actuals|DKEntries|picks/i.test(f));
const all = parseCSV(fs.readFileSync(path.join(dir, projFile), "utf8")), H = all[0].map(h => h.trim().toLowerCase()), rows = all.slice(1).filter(r => r.length > 3);
const col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return H.findIndex(h => names.some(n => h.includes(n))); };
const cName = col("player", "name"), cTeam = col("team", "teamabbrev"), cPos = col("position", "pos", "roster position"), cSal = col("salary", "flex $", "sal"), cProj = col("projection", "proj", "fpts"), cOwn = col("ownership %", "ownership", "own");
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const ABBR = { WSH: "WAS" };
const ab = t => { const a = String(t || "").toUpperCase(); return ABBR[a] || a; };
const teams = new Set(rows.map(r => ab(r[cTeam])));
const board = await getJ(`${API}/scoreboard?dates=${date.replace(/-/g, "")}`);
const games = (board.events || []).filter(e => e.competitions[0].competitors.some(c => teams.has(ab(c.team.abbreviation))));
const n = s => +String(s ?? "").split("/")[0].split("-")[0] || 0;
const act = {}, nick = {}, status = [];
const NAME_RE = /[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+/g;
for (const g of games) {
  const sum = await getJ(`${API}/summary?event=${g.id}`), comp = sum.header.competitions[0], final = /FINAL/.test(comp.status.type.name);
  status.push(`${comp.competitors.map(c => ab(c.team.abbreviation)).join("/")} ${comp.status.type.shortDetail}`);
  const score = {}; for (const c of comp.competitors) { score[ab(c.team.abbreviation)] = +c.score; nick[c.team.name.toLowerCase()] = ab(c.team.abbreviation); nick[c.team.displayName.toLowerCase()] = ab(c.team.abbreviation); }
  const pts = {}, add = (team, name, v) => { const k = nrm(name) + "|" + team; pts[k] = (pts[k] || 0) + v; };
  const dst = {}; for (const t of sum.boxscore.players) dst[ab(t.team.abbreviation)] = { sacks: 0, int: 0, fr: 0, td: 0, saf: 0, blk: 0, retTd: 0 };
  const opp = t => Object.keys(dst).find(x => x !== t);
  for (const t of sum.boxscore.players) {
    const team = ab(t.team.abbreviation), cat = Object.fromEntries(t.statistics.map(s => [s.name, s]));
    const each = (c, f) => { const s = cat[c]; if (!s) return; const L = s.labels; for (const a of s.athletes) { const st = Object.fromEntries(L.map((l, i) => [l, a.stats[i]])); f(a.athlete.displayName, st); } };
    each("passing", (nm, s) => { const y = n(s.YDS), td = n(s.TD), int = n(s.INT); add(team, nm, 0.04 * y + 4 * td - int + (y >= 300 ? 3 : 0)); dst[opp(team)].sacks += n(s.SACKS); dst[opp(team)].int += int; });
    each("rushing", (nm, s) => { const y = n(s.YDS); add(team, nm, 0.1 * y + 6 * n(s.TD) + (y >= 100 ? 3 : 0)); });
    each("receiving", (nm, s) => { const y = n(s.YDS); add(team, nm, n(s.REC) + 0.1 * y + 6 * n(s.TD) + (y >= 100 ? 3 : 0)); });
    each("fumbles", (nm, s) => { add(team, nm, -1 * n(s.LOST)); dst[opp(team)].fr += n(s.LOST); });
    each("kickReturns", (nm, s) => { add(team, nm, 6 * n(s.TD)); });
    each("puntReturns", (nm, s) => { add(team, nm, 6 * n(s.TD)); });
    each("kicking", (nm, s) => { add(team, nm, 1 * n(s.XP)); });   // FG distance points come from the scoring plays
    each("interceptions", (nm, s) => { dst[team].td += n(s.TD); });
  }
  for (const p of sum.scoringPlays || []) {
    const team = ab(p.team.abbreviation), txt = p.text || "", type = (p.type && p.type.text) || "", both = type + " " + txt;
    const fg = txt.match(/^(.+?) (\d+) Yd Field Goal/i); if (fg) { const d = +fg[2]; add(team, fg[1], 3 + (d >= 50 ? 2 : d >= 40 ? 1 : 0)); }
    if (/Two[- ]Point/i.test(both) && /Conversion/i.test(both)) { for (const m of txt.matchAll(/\(([^()]*?(?:Pass|Run|Rush)[^()]*?)\)/gi)) { for (const nm of m[1].match(NAME_RE) || []) add(team, nm, 2); } }
    if (/Fumble Return Touchdown|Fumble Recovery.*Touchdown|Blocked (Punt|Field Goal).*Touchdown|Kickoff Return Touchdown|Punt Return Touchdown/i.test(both)) { if (/Fumble|Blocked/i.test(both)) dst[team].td += 1; dst[team].retTd += 1; }
    if (/Interception Return Touchdown/i.test(both)) dst[team].retTd += 1;   // the TD itself is counted from the interceptions table
    if (/Safety/i.test(type)) dst[team].saf += 1;
    if (/Blocked/i.test(txt)) dst[team].blk += 1;
  }
  for (const team of Object.keys(dst)) {
    const o = opp(team), d = dst[team], pa = Math.max(0, (score[o] || 0) - 7 * (dst[o].retTd || 0));
    const paPts = pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4;
    act["DST|" + team] = { pts: +(d.sacks + 2 * d.int + 2 * d.fr + 6 * d.td + 2 * d.saf + 2 * d.blk + paPts).toFixed(2), final };
  }
  for (const [k, v] of Object.entries(pts)) act[k] = { pts: +v.toFixed(2), final };
}
console.log(`${date}: ${games.length} slate games - ${status.join(", ")}`);
const isDst = pos => /^(DST|D|DEF|D\/ST)$/i.test(String(pos || ""));
const lookup = (name, team, pos) => {
  if (isDst(pos)) return act["DST|" + team] || act["DST|" + (nick[String(name).toLowerCase()] || "")];
  const k = nrm(name); return act[k + "|" + team] || act[k.replace(/\s+[a-z]\.?\s+/, " ") + "|" + team] || (Object.entries(act).find(([kk]) => kk.startsWith(k + "|")) || [])[1];
};
const out = [["Player", "Team", "Position", "Salary", "Projection", "Ownership %", "Actual", "Final"].join(",")]; let matched = 0; const unmatched = [];
for (const r of rows) { const team = ab(r[cTeam]), a = lookup(r[cName], team, r[cPos]), proj = +r[cProj] || 0; if (a) matched++; else if (proj > 0) unmatched.push(r[cName]); out.push([r[cName], team, r[cPos], r[cSal], proj, cOwn >= 0 ? r[cOwn] : "", a ? a.pts : (proj > 0 && games.length ? 0 : ""), a ? (a.final ? 1 : 0) : ""].join(",")); }
fs.writeFileSync(path.join(dir, "actuals.csv"), out.join("\n") + "\n");
console.log(`matched ${matched}/${rows.length}; projected-but-unmatched (scored 0): ${unmatched.length}${unmatched.length ? " (" + unmatched.slice(0, 8).join(", ") + ")" : ""}; wrote ${path.join(dir, "actuals.csv")}`);
if (VALIDATE) {
  for (const c of listContests().filter(c => c.json && c.date === date && /nfl/.test(c.fkey) && c.entries <= 3000).slice(0, 4)) {
    const { pool, entries } = loadPulled(c.json), P = pool.players, mult = pool.format.mult; let k = 0, err = 0, big = 0; const worst = [];
    for (const e of entries.slice(0, 1500)) {
      let s = 0, ok = true;
      e.lu.forEach((id, q) => { const p = P[id], a = lookup(p.name, ab(p.team), p.pos); if (!a) ok = false; else s += (mult ? mult[q] : 1) * a.pts; });
      if (!ok) continue; k++; const d = s - e.actFP; err += Math.abs(d); if (Math.abs(d) > 1) { big++; if (worst.length < 3 && Math.abs(d) > 5) worst.push(`${d.toFixed(1)}: ${e.names.join(", ")}`); }
    }
    console.log(`validate ${c.name.slice(0, 50)} (${c.fkey}): ${k} lineups, mean |sum - actual| ${(err / (k || 1)).toFixed(2)}, off by >1: ${big}${worst.length ? "\n    " + worst.join("\n    ") : ""}`);
  }
}
