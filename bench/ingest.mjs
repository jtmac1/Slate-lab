// Ingest vendor projection CSVs the moment they land in Downloads (or data/inbox): classify each file
// by its header, work out the slate from its teams and the latest Pinnacle snapshot's game dates, and
// copy it into data/<date>-nfl-<main|awayhome>/ under the name the scorecard and vendor-index expect.
// Sources: stokastic (Data Hub), etr (main or showdown layout), blick (GPP SCORE columns).
// Already-ingested files are remembered in data/inbox/ingested.json. The hub server runs ingestPass()
// every few seconds and on Refresh.
//   node bench/ingest.mjs            one pass over new files
//   node bench/ingest.mjs --watch    keep polling every 5 s (Ctrl+C to stop)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCSV } from "../src/engine/csv.mjs";

const DAYS = 14;
export const DIRS = [path.join(os.homedir(), "Downloads"), "data/inbox"];
const LEDGER = "data/inbox/ingested.json";
const TM = { LA: "LAR", WSH: "WAS", JAC: "JAX", LVR: "LV" };
const tm = t => { const a = String(t || "").toUpperCase().replace(/^@/, "").trim(); return TM[a] || a; };
const NFL_POS = /^(QB|RB|WR|TE|K|DST|D|DEF|FLEX|CPT)$/i;

export function classify(file, H) {
  const h = H.map(x => x.trim().toLowerCase()), name = path.basename(file);
  if (/entry_manager|dkentries|contest-entry-history|pre_contest|data_hub_(lineup|player|stack|topstacks)|actuals|picks-|-proj\.csv$|^merged-/i.test(name)) return null;
  if (h[0] === "player" && h[1] === "salary" && h[2] === "position" && h[5] === "projection") return "stokastic";
  if (h.some(x => /gpp score/.test(x))) return "blick";
  if (h[0] === "player" && h[1] === "team" && h[3] === "position" && h[5] === "projection") return "etr";
  if (h[0] === "player" && h[1] === "pos" && h[2] === "team" && h.includes("cpt own")) return "etr";
  return "unknown";
}
const col = (h, ...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return h.findIndex(x => names.some(n => x.includes(n))); };
function teamsAndSport(H, rows) {
  const h = H.map(x => x.trim().toLowerCase()), cT = col(h, "team", "teamabbrev"), cP = col(h, "position", "pos", "roster position");
  const teams = new Set(), pos = new Set();
  for (const r of rows) { if (cT >= 0 && r[cT]) teams.add(tm(r[cT])); if (cP >= 0 && r[cP]) pos.add(String(r[cP]).toUpperCase().split("/")[0]); }
  const nfl = [...pos].filter(p => NFL_POS.test(p)).length, sport = pos.size === 0 ? "?" : nfl >= pos.size / 2 ? "nfl" : "other";
  return { teams, sport };
}
// latest Pinnacle snapshot -> game date (local) and away+home code per team
export function gameIndex() {
  const dir = "data/odds/nfl"; if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(f)).sort(); if (!files.length) return null;
  const snap = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8")), idx = {};
  for (const g of snap.games) { const date = new Date(g.start).toLocaleString("sv-SE").slice(0, 10); idx[g.home] = idx[g.away] = { date, code: g.away + g.home }; }
  return idx;
}
export function slateFor(teams) {
  const idx = gameIndex(), today = new Date().toLocaleString("sv-SE").slice(0, 10);
  if (teams.size <= 2 && teams.size > 0) {
    const g = idx && [...teams].map(t => idx[t]).find(Boolean);
    const code = g ? g.code : [...teams].join(""), date = g ? g.date : today;
    return { date, code, dir: `data/${date}-nfl-${code.toLowerCase()}`, kind: "showdown", guessed: !g };
  }
  const dates = {}; if (idx) for (const t of teams) if (idx[t]) dates[idx[t].date] = (dates[idx[t].date] || 0) + 1;
  const best = Object.entries(dates).sort((a, b) => b[1] - a[1])[0];
  const date = best ? best[0] : (() => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return d.toLocaleString("sv-SE").slice(0, 10); })();
  // a classic file belongs with the Stokastic classic folder already pulled for that date (Stokastic
  // names the Sunday slate "Main" or "Sun-Mon"); the one covering the most of the file's teams wins
  const existing = fs.existsSync("data") ? fs.readdirSync("data").filter(d => d.startsWith(date + "-nfl-") && !/-post$/.test(d)).map(d => { try { const m = JSON.parse(fs.readFileSync(path.join("data", d, "slate.json"), "utf8")); const gt = new Set((m.games || []).flatMap(g => g.split("@").map(tm))); return m.type === "CLASSIC" ? { d, code: m.type === "SHOWDOWN" ? m.name.replace(/\W+/g, "") : m.name, hit: [...teams].filter(t => gt.has(t)).length, n: gt.size } : null; } catch { return null; } }).filter(Boolean).sort((a, b) => b.hit - a.hit || b.n - a.n)[0] : null;
  if (existing && existing.hit >= Math.min(teams.size, existing.n) * 0.8) return { date, code: existing.code, dir: `data/${existing.d}`, kind: "main", guessed: false };
  return { date, code: "Main", dir: `data/${date}-nfl-main`, kind: "main", guessed: !best };
}
function destName(src, s, orig) {
  const tag = s.kind === "main" ? "main" : "showdown-" + s.code;
  if (src === "stokastic") return `DK_NFL_${s.code}_Data_Hub_Projections.csv`;
  if (src === "etr") return `ETR-${tag}-${s.date}.csv`;
  return /^nfl-/i.test(orig) ? orig : `nfl-${tag}-${s.date}.csv`;
}
// one pass; returns the list of files copied this pass
export function ingestPass(extraFiles = []) {
  fs.mkdirSync("data/inbox", { recursive: true });
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
  const cutoff = Date.now() - DAYS * 864e5, done = [], notes = [];
  const candidates = extraFiles.slice();
  for (const dir of DIRS) if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/\.csv$/i.test(f)) candidates.push(path.join(dir, f));
  for (const file of candidates) {
    const f = path.basename(file), st = fs.statSync(file), id = `${f}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (st.mtimeMs < cutoff || ledger[id]) continue;
    let all; try { all = parseCSV(fs.readFileSync(file, "utf8")); } catch (e) { ledger[id] = { skipped: "unreadable" }; continue; }
    if (!all.length || all.length < 3) { ledger[id] = { skipped: "empty" }; continue; }
    const H = all[0], rows = all.slice(1).filter(r => r.length > 2), src = classify(file, H);
    if (!src) { ledger[id] = { skipped: "not projections" }; continue; }
    if (src === "unknown") { ledger[id] = { skipped: "unknown layout" }; notes.push(`${f}: unknown layout (${H.slice(0, 6).join(",")})`); continue; }
    const { teams, sport } = teamsAndSport(H, rows);
    if (sport !== "nfl") { ledger[id] = { skipped: sport }; notes.push(`${f}: ${src} but not NFL, left alone`); continue; }
    const s = slateFor(teams), dest = path.join(s.dir, destName(src, s, f));
    fs.mkdirSync(s.dir, { recursive: true });
    if (fs.existsSync(dest)) { const prev = path.join(s.dir, "snapshots"); fs.mkdirSync(prev, { recursive: true }); fs.copyFileSync(dest, path.join(prev, `${path.basename(dest, ".csv")}_${new Date(fs.statSync(dest).mtimeMs).toLocaleString("sv-SE").slice(5, 16).replace(/[- :]/g, "")}.csv`)); }
    fs.copyFileSync(file, dest);
    ledger[id] = { src, dest, at: new Date().toISOString() };
    done.push({ file: f, src, dest, kind: s.kind, teams: teams.size, rows: rows.length, guessed: s.guessed });
  }
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
  return { done, notes };
}
if (process.argv[1] && /ingest\.mjs$/.test(process.argv[1])) {
  const report = r => { for (const d of r.done) console.log(`+ ${d.file} -> ${d.dest}  (${d.src}, ${d.kind}, ${d.teams} teams, ${d.rows} rows${d.guessed ? ", slate date guessed - no Pinnacle snapshot covers these teams" : ""})`); for (const n of r.notes) console.log("? " + n); };
  if (process.argv.includes("--watch")) { console.log(`watching ${DIRS.join(", ")} for projection CSVs...`); report(ingestPass()); setInterval(() => report(ingestPass()), 5000); }
  else { const r = ingestPass(); report(r); console.log(`${r.done.length} file(s) ingested`); }
}
