// Actual DraftKings college-football points from ESPN's public box scores. DK CFB rosters have no
// kicker or defense, so only the offensive lines matter. Whether receptions score is settled by
// --validate, which compares lineup sums against the actual FP in the pulled contests.
//   node bench/actuals-cfb.mjs 2026-09-18 [data/2026-09-18-cfb-main] [--validate] [--ppr=1|0.5|0]
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listContests, loadPulled } from "./grade-all.mjs";
const API = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const args = process.argv.slice(2), flags = args.filter(a => a.startsWith("--")), pos = args.filter(a => !a.startsWith("--"));
// DK college scoring, settled by --validate against pulled lineup totals on 2026-09-12 and 09-05:
// full PPR, +3 for 100 rushing or receiving yards, and NO 300-yard passing bonus (adding it triples
// the mean lineup error). --b300 and --no100 are left in so the test can be repeated.
const B300 = flags.includes("--b300") ? 3 : 0, B100 = flags.includes("--no100") ? 0 : 3;
const VALIDATE = flags.includes("--validate"), PPR = +((flags.find(a => a.startsWith("--ppr=")) || "--ppr=1").slice(6));
const date = (pos.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || (pos[0] || "").match(/\d{4}-\d{2}-\d{2}/)?.[0]);
const dir = pos.find(a => a.includes("/") || a.includes("\\"));
if (!date) { console.error("usage: node bench/actuals-cfb.mjs <date> [dir] [--validate] [--ppr=1]"); process.exit(1); }
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const n = s => +String(s ?? "").split("/")[0].split("-")[0] || 0;
const NAME_RE = /[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+/g;

// every game on the date, FBS (group 80) and FCS (81) - DK slates sometimes carry an FCS opponent
const boards = await Promise.all(["80", "81"].map(g => getJ(`${API}/scoreboard?dates=${date.replace(/-/g, "")}&groups=${g}&limit=200`).catch(() => ({ events: [] }))));
const games = [], seenG = new Set();
for (const b of boards) for (const e of b.events || []) if (!seenG.has(e.id)) { seenG.add(e.id); games.push(e); }
const act = {}, status = [];
for (const g of games) {
  const sum = await getJ(`${API}/summary?event=${g.id}`), comp = sum.header.competitions[0], final = /FINAL/.test(comp.status.type.name);
  status.push(`${comp.competitors.map(c => c.team.abbreviation).join("/")} ${comp.status.type.shortDetail}`);
  const pts = {}, add = (team, name, v) => { const k = nrm(name) + "|" + team.toUpperCase(); pts[k] = (pts[k] || 0) + v; };
  for (const t of (sum.boxscore || {}).players || []) {
    const team = t.team.abbreviation, cat = Object.fromEntries(t.statistics.map(s => [s.name, s]));
    const each = (c, f) => { const s = cat[c]; if (!s) return; const L = s.labels; for (const a of s.athletes) f(a.athlete.displayName, Object.fromEntries(L.map((l, i) => [l, a.stats[i]]))); };
    each("passing", (nm, s) => { const y = n(s.YDS); add(team, nm, 0.04 * y + 4 * n(s.TD) - n(s.INT) + (y >= 300 ? B300 : 0)); });
    each("rushing", (nm, s) => { const y = n(s.YDS); add(team, nm, 0.1 * y + 6 * n(s.TD) + (y >= 100 ? B100 : 0)); });
    each("receiving", (nm, s) => { const y = n(s.YDS); add(team, nm, PPR * n(s.REC) + 0.1 * y + 6 * n(s.TD) + (y >= 100 ? B100 : 0)); });
    each("fumbles", (nm, s) => add(team, nm, -1 * n(s.LOST)));
    each("kickReturns", (nm, s) => add(team, nm, 6 * n(s.TD)));
    each("puntReturns", (nm, s) => add(team, nm, 6 * n(s.TD)));
  }
  for (const p of sum.scoringPlays || []) {
    const team = p.team.abbreviation, txt = p.text || "";
    if (/Two[- ]Point|2[- ]?Pt/i.test(txt) && /Conversion|GOOD|SUCCE/i.test(txt)) for (const nm of txt.match(NAME_RE) || []) add(team, nm, 2);
  }
  for (const [k, v] of Object.entries(pts)) act[k] = { pts: +v.toFixed(2), final };
}
console.log(`${date}: ${games.length} games, ${Object.keys(act).length} players scored (${PPR} per reception)${status.length ? "\n  " + status.slice(0, 14).join(", ") : ""}`);

// team codes differ between Stokastic and ESPN, so a name with no team match falls back to the name
// alone - but only when that name belongs to exactly one team that day; 80 games repeat plenty of names.
const byName = {}; for (const kk of Object.keys(act)) { const nm = kk.split("|")[0]; (byName[nm] = byName[nm] || []).push(kk); }
const lookup = (name, team) => {
  const T = String(team || "").toUpperCase();
  for (const k of [nrm(name), nrm(name).replace(/\s+[a-z]\.?\s+/, " "), nrm(name).replace(/\s+(jr|sr|ii|iii|iv)$/, "")]) {
    if (act[k + "|" + T]) return act[k + "|" + T];
    const hits = byName[k];
    if (hits && hits.length === 1) return act[hits[0]];
  }
  return null;
};

if (dir && fs.existsSync(dir)) {
  const projFile = fs.readdirSync(dir).find(f => /Projections\.csv$/i.test(f));
  if (projFile) {
    const all = parseCSV(fs.readFileSync(path.join(dir, projFile), "utf8")), H = all[0].map(h => h.trim().toLowerCase()), rows = all.slice(1).filter(r => r.length > 3);
    const col = (...names) => { for (const nm of names) { const i = H.indexOf(nm); if (i >= 0) return i; } return H.findIndex(h => names.some(nm => h.includes(nm))); };
    const cName = col("player", "name"), cTeam = col("team"), cPos = col("position", "pos"), cSal = col("salary"), cProj = col("projection", "proj"), cOwn = col("ownership %", "ownership");
    const out = [["Player", "Team", "Position", "Salary", "Projection", "Ownership %", "Actual", "Final"].join(",")]; let matched = 0; const miss = [];
    for (const r of rows) { const a = lookup(r[cName], r[cTeam]), proj = +r[cProj] || 0; if (a) matched++; else if (proj > 0) miss.push(r[cName]);
      out.push([r[cName], r[cTeam], r[cPos], r[cSal], proj, cOwn >= 0 ? r[cOwn] : "", a ? a.pts : (proj > 0 ? 0 : ""), a ? (a.final ? 1 : 0) : ""].join(",")); }
    fs.writeFileSync(path.join(dir, "actuals.csv"), out.join("\n") + "\n");
    console.log(`matched ${matched}/${rows.length}; projected-but-unmatched (scored 0): ${miss.length}${miss.length ? " (" + miss.slice(0, 8).join(", ") + ")" : ""}; wrote ${path.join(dir, "actuals.csv")}`);
  }
}
if (VALIDATE) {
  for (const c of listContests().filter(c => c.json && c.date === date && c.fkey === "cfb_cl").slice(0, 4)) {
    const { pool, entries } = loadPulled(c.json), P = pool.players;
    if (!entries.some(e => e.actFP > 0)) { console.log(`validate ${c.name.slice(0, 46)}: skipped, Stokastic never scored it (every entry 0 FP)`); continue; }
    let k = 0, err = 0, big = 0; const worst = [];
    for (const e of entries.slice(0, 1500)) {
      let s = 0, ok = true;
      for (const id of e.lu) { const p = P[id], a = lookup(p.name, p.team); if (!a) ok = false; else s += a.pts; }
      if (!ok) continue; k++; const d = s - e.actFP; err += Math.abs(d); if (Math.abs(d) > 1) { big++; if (worst.length < 2 && Math.abs(d) > 3) worst.push(`${d.toFixed(1)}: ${e.names.join(", ")}`); }
    }
    console.log(`validate ${c.name.slice(0, 46)}: ${k} lineups, mean |sum - actual| ${(err / (k || 1)).toFixed(2)}, off by >1: ${big}${worst.length ? "\n    " + worst.join("\n    ") : ""}`);
  }
}
