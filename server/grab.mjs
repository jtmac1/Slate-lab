// Files what the Slate Lab grabber bookmarklet (src/grab/grab.js) saved to Downloads, so ETR, Blick and the shows come in
// with no Claude run. Projection CSVs go through bench/ingest.mjs like any download; this handles the grabber's own
// slatelab-*.txt files (first line "#SLATELAB kind=... url=..."):
//   etr-table   the DvP / XFP / PROE widget address -> fetchEtrData, marked read on this week's slates
//   blick-cond  Blick conditional ownership -> saveBlickCond on the slate its teams belong to (+ the Lab stacks)
//   article     an ETR article or a YouTube transcript, word for word -> data/<slate>/reads/<id>.md (what the Brain reads),
//               matched to the Notes tab's report list by its title and marked read there
// Remembered in data/inbox/grabbed.json. Runs on Refresh and when a grab file is dropped on the hub (no timers).
import fs from "node:fs";
import path from "node:path";
import { DIRS, slateFor } from "../bench/ingest.mjs";
import { fetchEtrData, saveContestSelection } from "./etrdata.mjs";
import { saveBlickCond } from "./blickcond.mjs";
import { saveStacks } from "./stacks.mjs";
import { slateDirs, slateMeta } from "./sources.mjs";

const LEDGER = "data/inbox/grabbed.json", DAYS = 14, TEXT_CAP = 40000;
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const today = () => new Date().toLocaleString("sv-SE").slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// this week's NFL slate folders (today through the next 7 days), soonest first
const upcoming = () => slateDirs().filter(d => d.slice(0, 10) >= today() && d.slice(0, 10) <= addDays(today(), 7)).sort();
const norm = s => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");

export function parseGrab(text) {
  const s = String(text).replace(/^﻿/, ""), nl = s.indexOf("\n"), first = s.slice(0, nl < 0 ? s.length : nl);
  if (!first.startsWith("#SLATELAB ")) return null;
  const meta = Object.fromEntries(first.slice(10).split(" ").map(kv => { const i = kv.indexOf("="); return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)]; }));
  let body = nl < 0 ? "" : s.slice(nl + 1), title = "";
  const m = body.match(/^TITLE (.*)\n\n?/); if (m) { title = m[1].trim(); body = body.slice(m[0].length); }
  return { kind: meta.kind, url: meta.url || "", table: meta.table, source: meta.source, title, body: body.trim() };
}
// which report on the Notes tab list a title is, and which slate it belongs to
export function matchReport(title, reports, team, dirs) {
  const t = norm(title), sdDirs = dirs.filter(d => slateMeta(d).type === "SHOWDOWN"), mains = dirs.filter(d => slateMeta(d).type !== "SHOWDOWN");
  const sdFor = () => sdDirs.find(d => (slateMeta(d).games || []).some(g => String(g).split("@").every(a => t.includes(norm(team[a] || a)))));
  let id = null, sd = false;
  if (/showdown breakdown/.test(t)) { id = "sd-breakdown"; sd = true; }
  else if (/showdown sim analysis|sim analysis/.test(t) && /showdown/.test(t)) { id = "sd-sim"; sd = true; }
  else if (/night football|live show/.test(t) && sdFor()) { id = "sd-show"; sd = true; }
  else if (/game selection|contest selection/.test(t)) id = "contest-sel";
  else { const r = reports.find(x => x.menu && t.includes(norm(x.menu))); if (r) id = r.id; }
  const dir = sd ? sdFor() : (mains.find(d => /-main$/.test(d)) || mains[0]);
  return { id: id || "other-" + t.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50), known: !!id, dir: dir || null };
}
function markRead(dir, id, rec) {
  const f = path.join("data", dir, "etr-reads.json"), all = readJ(f) || {};
  all[id] = Object.assign({ status: "ok", at: new Date().toISOString() }, rec); fs.writeFileSync(f, JSON.stringify(all, null, 1));
}
export async function ingestGrabs({ reports = [], team = {}, files = [], weekOf = () => null } = {}) {
  fs.mkdirSync("data/inbox", { recursive: true });
  const ledger = readJ(LEDGER) || {}, cutoff = Date.now() - DAYS * 864e5, done = [], notes = [], cand = files.slice();
  for (const d of DIRS) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (/^slatelab-.*\.txt$/i.test(f)) cand.push(path.join(d, f));
  for (const file of cand) {
    const f = path.basename(file), st = fs.statSync(file), key = `${f}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (st.mtimeMs < cutoff || ledger[key]) continue;
    const g = parseGrab(fs.readFileSync(file, "utf8")); if (!g) { ledger[key] = { skipped: "not a grab file" }; continue; }
    try {
      if (g.kind === "etr-table") {
        const r = await fetchEtrData(g.table, g.body.split(/\s+/)[0]), dirs = upcoming();
        for (const d of dirs) markRead(d, g.table, { title: `${g.table.toUpperCase()} table (wk ${r.week}, ${r.rows} rows)`, url: g.url, note: "grabbed without Claude" });
        done.push(`${f}: ${g.table} wk ${r.week}, ${r.rows} rows`); ledger[key] = { kind: g.kind, at: new Date().toISOString() };
      } else if (g.kind === "blick-cond") {
        const P = (g.body.split("\n").find(l => l.startsWith("P ")) || "").slice(2), teams = new Set(P.split("^").map(x => x.split("~")[2]).filter(Boolean));
        const s = slateFor(teams), dir = s.dir.replace(/^data[\\/]/, ""); if (!fs.existsSync(s.dir)) throw new Error(`no slate folder for these teams yet (${s.dir}); Refresh the slate first`);
        const r = saveBlickCond(dir, g.body); try { saveStacks(dir); } catch {}
        done.push(`${f}: Blick conditional -> ${dir} (${r.rows} combos)`); ledger[key] = { kind: g.kind, dir, at: new Date().toISOString() };
      } else if (g.kind === "article") {
        const m = matchReport(g.title, reports, team, upcoming()); if (!m.dir) throw new Error("no slate this week to file it under; Refresh the slate first");
        const text = g.body.length > TEXT_CAP ? g.body.slice(0, TEXT_CAP) + "\n(cut for length)" : g.body, rd = path.join("data", m.dir, "reads");
        fs.mkdirSync(rd, { recursive: true });
        fs.writeFileSync(path.join(rd, m.id + ".md"), `# ${g.title}\n${g.source || "ETR"} | ${g.url}\n(full text, grabbed without Claude)\n\n${text}\n`);
        if (m.known) markRead(m.dir, m.id, { title: g.title, url: g.url, note: "grabbed without Claude (full text, not folded into the guide)" });
        if (m.id === "contest-sel") try { const w = weekOf(today()); if (w) saveContestSelection(text.slice(0, 6000), w); } catch {}
        done.push(`${f}: "${g.title}" -> ${m.dir}/reads/${m.id}.md${m.known ? "" : " (not on the report list)"}`); ledger[key] = { kind: g.kind, dir: m.dir, id: m.id, at: new Date().toISOString() };
      } else { ledger[key] = { skipped: "unknown kind " + g.kind }; notes.push(`${f}: unknown kind ${g.kind}`); }
    } catch (e) { notes.push(`${f}: ${e.message}`); }   // not in the ledger: tried again on the next Refresh
  }
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
  return { done, notes };
}
