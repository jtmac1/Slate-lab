// Slate guides for NFL classic sub-slates (Early Only, Afternoon Only, Afternoon Turbo, Primetime, Sun-Mon, Thu-Mon):
// a sub-slate has no guide of its own; it reads the week's Main slate guide filtered to its games, plus the showdown
// guides of any of its games that aren't on the Main slate (the prime-time games). Computed on every load, so it follows
// the Main slate as more ETR reports are read there. A sub-slate that has its own slate-guide.json uses that instead.
import fs from "node:fs";
import path from "node:path";

const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const NICK = { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" };
const BY_NICK = Object.fromEntries(Object.entries(NICK).map(([a, n]) => [n.toLowerCase(), a]));
const ab = t => { t = String(t || "").toUpperCase().replace(/^@/, ""); return t === "LA" ? "LAR" : t === "WSH" ? "WAS" : t; };
const meta = dir => readJ(path.join("data", dir, "slate.json")) || {};
const teamsOf = games => new Set((games || []).flatMap(g => String(g).split("@").map(ab)));

// player -> team from the folder's ETR file (classic or showdown layout)
function teamMap(dir) {
  const m = new Map(), d = path.join("data", dir); let files = []; try { files = fs.readdirSync(d); } catch { return m; }
  const f = files.find(x => /^ETR.*\.csv$/i.test(x)); if (!f) return m;
  const lines = fs.readFileSync(path.join(d, f), "utf8").split(/\r?\n/).filter(Boolean);
  const split = l => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
  const h = split(lines[0]).map(x => x.trim().toLowerCase()), ni = h.indexOf("player"), ti = h.indexOf("team");
  for (const l of lines.slice(1)) { const r = split(l); if (r[ni]) m.set(r[ni].trim(), ab(r[ti])); }
  return m;
}
const near = (a, b, days) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * 864e5;

export function subGuide(dir) {
  const M = meta(dir); if (M.type !== "CLASSIC" || /-main$/.test(dir) || !/nfl/i.test(dir)) return null;
  const date = dir.slice(0, 10), mine = teamsOf(M.games); if (!mine.size) return null;
  let dirs = []; try { dirs = fs.readdirSync("data").filter(x => /^\d{4}-\d\d-\d\d-nfl-/.test(x) && x !== dir && near(x.slice(0, 10), date, 4)); } catch { return null; }
  const main = dirs.filter(x => /-main$/.test(x) && fs.existsSync(path.join("data", x, "slate-guide.json"))).sort((a, b) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(date)) - Math.abs(Date.parse(b.slice(0, 10)) - Date.parse(date)))[0];
  const mainTeams = main ? teamsOf(meta(main).games) : new Set();
  // showdown folders for games on this slate but not on the Main slate
  const sds = dirs.filter(x => { const m = meta(x); return m.type === "SHOWDOWN" && fs.existsSync(path.join("data", x, "slate-guide.json")) && (m.games || []).every(g => String(g).split("@").every(t => mine.has(ab(t)) && !mainTeams.has(ab(t)))); });
  if (!main && !sds.length) return null;
  const out = { slate: dir, derived: true, from: [main, ...sds].filter(Boolean), sources: [], theses: [], stances: {}, notes: [] };
  out.environment = `Derived from ${[main, ...sds].filter(Boolean).join(" + ")}: only this slate's ${M.games.length} games (${M.games.join(", ")}).`;
  const onSlate = (name, tm) => { const t = tm.get(name) || BY_NICK[String(name).toLowerCase()]; return t ? mine.has(t) : null; };
  for (const src of out.from) {
    const g = readJ(path.join("data", src, "slate-guide.json")), tm = teamMap(src), sd = src !== main; if (!g) continue;
    for (const s of g.sources || []) if (!out.sources.some(x => x.name === s.name)) out.sources.push(s);
    for (const t of g.theses || []) {
      const games = (t.games || []).filter(x => String(x).split("@").every(tt => mine.has(ab(tt))));
      const players = (t.players || []).filter(p => onSlate(p, tm) !== false);
      if ((t.games || []).length ? games.length : players.length >= 2) out.theses.push(Object.assign({}, t, { games: games.length ? games : t.games || [], players }));
    }
    for (const [p, v] of Object.entries(g.stances || {})) if (onSlate(p, tm) === true && !out.stances[p]) out.stances[p] = sd ? Object.assign({}, v, { source: `${v.source} (${meta(src).name || src} showdown guide)` }) : v;
    // notes: keep the ones about this slate's teams, or about no team at all
    const offNick = Object.entries(NICK).filter(([a]) => !mine.has(a)).map(([, n]) => n), onNick = [...mine].map(a => NICK[a]).filter(Boolean);
    for (const n of g.notes || []) { const s = String(n); const on = onNick.some(x => s.includes(x)) || [...tm.keys()].some(p => onSlate(p, tm) && s.includes(p)); const off = offNick.some(x => s.includes(x)); if (on || !off) out.notes.push(sd ? `${meta(src).name || src}: ${s}` : s); }
  }
  return out;
}
