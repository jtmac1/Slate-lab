// Slate Lab hub server: serves the app from the repo root and gives every rebuilt tab its data.
//   node server/hub.mjs  (npm run hub)   http://localhost:8787, also reachable on the LAN for the phone
// Refresh pulls Stokastic (projections + ownership) for the chosen slate, Pinnacle lines, ESPN
// injuries, the DK lobby, and ingests any ETR/Blick CSV that landed in Downloads, then merges and
// snapshots everything. ETR and Blick cannot be fetched here (login / Discord), so they arrive as
// downloads: Downloads is read on every Refresh and the page has a drop zone. The nightly report
// chain runs from the Review tab (POST /api/nightly); there are no background timers. No
// dependencies, no credentials.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { stkSlates } from "../src/engine/stokastic.mjs";
import { pullStokastic, pullInjuries, hubData, slateDirs, slateMeta } from "./sources.mjs";
import { pullPinnacle } from "../bench/pull-pinnacle-nfl.mjs";
import { ingestPass } from "../bench/ingest.mjs";
import { loadEntries, importEntries, saveThesis, saveTag, loadGuide } from "./entries.mjs";
import { fourSourceSim } from "./foursim.mjs";
import { generateAndSim, loadGen } from "./gensim.mjs";
import { buildField, loadField, runSim, loadSimRun, stripField } from "./contestsim.mjs";
import { reviewLineups, reviewPortfolio, brainStatus, loadBrain } from "./brain.mjs";
import { contestsFor } from "./contests.mjs";
import { saveMerge, markBuilt, diff } from "./changes.mjs";
import { lateSwap } from "./lateswap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const PORT = +process.env.PORT || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".md": "text/markdown", ".txt": "text/plain" };
// $RECENT = 35 days ago at run time: the ownership curve and chalk exponent follow the current season's fields
const NIGHTLY = [["bench/pull-pinnacle-nfl.mjs"], ["bench/winners-nfl.mjs"], ["bench/source-scorecard-nfl.mjs"], ["bench/winners-profile-nfl.mjs", "2026-09-01"], ["bench/rulebook-nfl.mjs"], ["bench/fit-conc-nfl.mjs", "$RECENT"], ["bench/fit-own-error-nfl.mjs"],["bench/vendor-index.mjs"], ["bench/grade-entries-nfl.mjs"]];
const recent = () => new Date(Date.now() - 35 * 864e5).toLocaleString("sv-SE").slice(0, 10);
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((resolve, reject) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); req.on("error", reject); });
const safeDir = d => d && !/[\\/]/.test(d) && fs.existsSync(path.join("data", d)) ? d : null;
const run = (args, timeout = 300000) => new Promise((resolve, reject) => execFile(process.execPath, args, { cwd: ROOT, timeout, maxBuffer: 16e6 }, (err, out, errOut) => err ? reject(new Error((errOut || err.message).split("\n").slice(-3).join(" ").slice(0, 300))) : resolve(String(out).trim().split("\n").slice(-4).join("\n"))));
let refreshing = null, simming = false, nightlyRunning = false, lastIngest = { done: [], notes: [], at: null }, lastNightly = null;

async function refresh(q) {
  const steps = [], step = async (name, fn) => { const t = Date.now(); try { const info = await fn(); steps.push({ name, ok: true, ms: Date.now() - t, info }); return info; } catch (e) { steps.push({ name, ok: false, ms: Date.now() - t, error: e.message }); return null; } };
  let dir = q.dir || null;
  if (q.slateId && q.date) { const r = await step("stokastic", () => pullStokastic(q.date, q.slateId, "NFL")); if (r) dir = r.dir; }
  await step("pinnacle", () => pullPinnacle().then(r => ({ stamp: r.stamp, games: r.games, props: r.props, projected: r.projected })));
  await step("ingest", () => { const r = ingestPass(); lastIngest = Object.assign(r, { at: new Date().toISOString() }); return { copied: r.done.map(d => `${d.src}: ${d.file} -> ${d.dest}`), notes: r.notes }; });
  await step("injuries", pullInjuries);
  await step("lobby", () => run(["bench/dk-contests.mjs", "NFL"], 60000).then(() => { const j = JSON.parse(fs.readFileSync("data/dk-lobby/nfl.json", "utf8")); return { contests: j.contests.length, fetched: j.fetched }; }));
  if (!dir) { const dirs = slateDirs(); dir = dirs[0] || null; }
  const hub = dir ? await step("merge", () => { const h = hubData(dir); saveMerge(dir, h); return h; }) : null;
  return { steps, hub };
}
// "Pull ETR + Blick" (user-approved 2026-10-03): a one-shot headless Claude Code run (claude -p --chrome) with the job in
// bench/pull-vendors.prompt.md, allowed only the Chrome tools, writes under data/, and curl to this server. It posts its own
// progress to /api/pull-status; when it exits, its final line (or the failure) becomes the status if it didn't post one.
const PULL_MODEL = process.env.SLATELAB_PULL_MODEL || "claude-sonnet-5";
function pullStatus(patch) { const sf = "data/requests/status.json"; const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}; fs.writeFileSync(sf, JSON.stringify(Object.assign(cur, patch, { updated: new Date().toISOString() }))); return cur; }
function startPull(r) {
  const meta = slateMeta(r.dir), sd = meta.type === "SHOWDOWN", wk = (() => { const m = fs.readdirSync(path.join("data", r.dir)).join(" ").match(/(\d{4})wk(\d\d)/); return m ? m[1] + "wk" + m[2] : `${meta.date.slice(0, 4)}wk00`; })();
  const etrMain = `Open https://establishtherun.com/draftkings-fanduel-yahoo-projections/ and wait 4 seconds. The DraftKings table is the FIRST AG Grid on the page; read every row from React in one step (no scrolling):
     const el=document.querySelectorAll('.ag-root-wrapper')[0]; const fk=Object.keys(el).find(k=>k.startsWith('__reactFiber')); let f=el[fk]; while(f&&!(f.memoizedProps&&Array.isArray(f.memoizedProps.rowData))) f=f.return;
     const D=f.memoizedProps.rowData.filter(o=>o.projection>=2||o.largeOwnership>0);
     window.__C=['player,team,opponent,position,salary,projection,floor,ceiling,largeOwnership,smallOwnership'].concat(D.map(o=>[String(o.player).includes(',')?'"'+o.player+'"':o.player,o.team,o.opponent,o.position,o.salary,o.projection,o.floor,o.ceiling,o.largeOwnership,o.smallOwnership].join(','))).join('\\n');
     'rows '+D.length+' chars '+window.__C.length+' | '+((document.body.innerText.match(/DraftKings NFL DFS Projections[^\\n]*\\n[^\\n]*/)||[''])[0])
   Read window.__C in 950-character slices with browser_batch, join exactly, and Write data/${r.dir}/ETR-main-${meta.date}.csv .`;
  const etrSd = `Open https://establishtherun.com/draftkings-showdown-and-fanduel-single-game-projections/?site=DK and use get_page_text. It lists all player names first, then 10 fields per player (Pos, Team, Salary, Proj, Ceiling, Total Own, CPT Own, CPT Salary, CPT Proj, Slate); zip them in order, keep only this game (${meta.games.join(" ")}), strip $ , %, and Write data/${r.dir}/ETR-showdown-${meta.games.join("").replace("@", "")}-${meta.date}.csv with header Player,Pos,Team,Salary,Proj,Ceiling,Total Own,CPT Own,CPT Salary,CPT Proj .`;
  const vars = { DIR: r.dir, TYPE: meta.type, DATE: meta.date, SLATEID: String(meta.slateId || ""), GAMES: meta.games.join(" "), ETR_STEPS: sd ? etrSd : etrMain,
    BLICK_URL: sd ? "https://blickanalytics.com/nfl/showdown-ownership-gpp" : "https://blickanalytics.com/nfl/ownership-gpp", BLICK_NEXT: sd ? "%2Fnfl%2Fshowdown-ownership-gpp" : "%2Fnfl%2Fownership-gpp",
    BLICK_FILE: sd ? `nfl-${meta.games.join("-").replace("@", "-").toLowerCase()}-showdown-${wk}.csv` : `nfl-main-${wk}.csv` };
  const prompt = fs.readFileSync("bench/pull-vendors.prompt.md", "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
  const args = ["-p", "--chrome", "--model", PULL_MODEL, "--output-format", "json", "--allowedTools", "mcp__claude-in-chrome", "Edit(data/**)", "Write(data/**)", "Read", "Bash(curl:*)", "--", prompt];
  pullStatus({ status: "working", message: "Claude started" });
  const child = execFile("claude", args, { cwd: ROOT, timeout: 15 * 60000, maxBuffer: 32e6, windowsHide: true }, (err, out) => {
    let result = null; try { result = JSON.parse(String(out)); } catch {}
    const cur = pullStatus({});
    if (cur.status === "done" || cur.status === "error") return pullStatus({ cost: result && result.total_cost_usd, ms: result && result.duration_ms });
    if (err && !result) return pullStatus({ status: "error", message: "Claude run failed: " + String(err.message).split("\n")[0].slice(0, 200) });
    pullStatus({ status: result && !result.is_error ? "done" : "error", message: String(result && result.result || "finished without a report").split("\n").pop().slice(0, 300), cost: result && result.total_cost_usd, ms: result && result.duration_ms });
  });
  pullStatus({ pid: child.pid });
}
async function nightly() {
  if (nightlyRunning) return { running: true }; nightlyRunning = true;
  const log = [], t0 = Date.now();
  try { for (const a of NIGHTLY) { const t = Date.now(); try { const out = await run(a.map(x => x === "$RECENT" ? recent() : x), 900000); log.push({ script: a[0], ok: true, ms: Date.now() - t, out }); } catch (e) { log.push({ script: a[0], ok: false, ms: Date.now() - t, error: e.message }); } } }
  finally { nightlyRunning = false; }
  lastNightly = { at: new Date().toISOString(), ms: Date.now() - t0, log };
  fs.mkdirSync("data/reports", { recursive: true }); fs.appendFileSync("data/reports/log.txt", `---- hub nightly ${lastNightly.at} ----\n` + log.map(l => `${l.ok ? "ok  " : "FAIL"} ${l.script} ${(l.ms / 1000).toFixed(0)}s ${l.ok ? l.out.split("\n").pop() : l.error}`).join("\n") + "\n");
  return lastNightly;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, d = u.searchParams.get("dir");
  try {
    if (p === "/api/slates") return json(res, 200, await stkSlates("NFL", u.searchParams.get("date")));
    if (p === "/api/dirs") return json(res, 200, slateDirs().map(slateMeta));
    if (p === "/api/hub") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, hubData(d)); }
    if (p === "/api/ingest") return json(res, 200, lastIngest);
    if (p === "/api/status") return json(res, 200, { lastNightly, nightlyRunning, refreshing: !!refreshing, simming, now: new Date().toISOString() });
    if (p === "/api/refresh" && req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); if (refreshing) return json(res, 409, { error: "refresh already running" }); refreshing = refresh(q); try { return json(res, 200, await refreshing); } finally { refreshing = null; } }
    if (p === "/api/upload" && req.method === "POST") { const name = path.basename(u.searchParams.get("name") || "upload.csv").replace(/[^\w.@ -]/g, "_"); fs.mkdirSync("data/inbox", { recursive: true }); const f = path.join("data/inbox", name); fs.writeFileSync(f, await body(req)); const r = ingestPass([f]); lastIngest = Object.assign(r, { at: new Date().toISOString() }); return json(res, 200, r); }
    if (p === "/api/entries") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const E = req.method === "POST" ? importEntries(d, (await body(req)).toString("utf8"), u.searchParams.get("name") || "") : loadEntries(d); return json(res, 200, Object.assign(E, { guide: loadGuide(d) })); }
    if (p === "/api/guide") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, loadGuide(d) || {}); }
    if (p === "/api/sim" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, fourSourceSim(d)); } finally { simming = false; } }
    if (p === "/api/field") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, buildField(d, JSON.parse((await body(req)).toString("utf8") || "{}"))); } finally { simming = false; } } return json(res, 200, stripField(loadField(d))); }
    if (p === "/api/simrun") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, runSim(d, JSON.parse((await body(req)).toString("utf8") || "{}"))); } finally { simming = false; } } return json(res, 200, loadSimRun(d) || { rows: [] }); }
    // "Pull ETR + Blick": the site files a request (data/requests/requests.log, one JSON line each); an open Claude session
    // watching that file pulls the CSVs through the user's logged-in Chrome, ingests them, refreshes, and reports progress back
    // through POST /api/pull-status. GET returns the latest request with its status.
    if (p === "/api/pull-request") { const rq = "data/requests", sf = path.join(rq, "status.json"); fs.mkdirSync(rq, { recursive: true }); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); if (!safeDir(q.dir)) return json(res, 400, { error: "dir" }); const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}; if (/pending|working/.test(cur.status) && Date.now() - Date.parse(cur.at) < 20 * 60000) return json(res, 409, Object.assign({ error: "a pull is already running" }, cur)); const r = { id: Date.now().toString(36), dir: q.dir, sources: q.sources || ["etr", "blick"], at: new Date().toISOString(), status: "pending", message: "starting Claude" }; fs.appendFileSync(path.join(rq, "requests.log"), JSON.stringify(r) + "\n"); fs.writeFileSync(sf, JSON.stringify(r)); startPull(r); return json(res, 200, r); } return json(res, 200, fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : { status: "none" }); }
    if (p === "/api/pull-status" && req.method === "POST") { const sf = path.join("data/requests", "status.json"); const q = JSON.parse((await body(req)).toString("utf8") || "{}"); const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}; const r = Object.assign(cur, q, { updated: new Date().toISOString() }); fs.mkdirSync("data/requests", { recursive: true }); fs.writeFileSync(sf, JSON.stringify(r)); return json(res, 200, r); }
    // Entry Manager plan: which lineups go into which contests for the slate (data/<slate>/entry-plan.json); graded after the slate
    if (p === "/api/plan") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const f = path.join("data", d, "entry-plan.json"); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); q.savedAt = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(q, null, 1)); return json(res, 200, q); } return json(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { contests: [] }); }
    if (p === "/api/brain") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); try { return json(res, 200, q.portfolio ? await reviewPortfolio(d, q.sigs || []) : await reviewLineups(d, q.sigs || [], { max: q.max })); } catch (e) { return json(res, 500, { error: e.message }); } } return json(res, 200, Object.assign(brainStatus(d), { reviews: loadBrain(d).reviews || {} })); }
    if (p === "/api/gen") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { const cfg = JSON.parse((await body(req)).toString("utf8") || "{}"); return json(res, 200, generateAndSim(d, cfg)); } finally { simming = false; } } return json(res, 200, loadGen(d) || { rows: [] }); }
    if (p === "/api/lateswap" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, await lateSwap(d)); } finally { simming = false; } }
    if (p === "/api/thesis" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const q = JSON.parse((await body(req)).toString("utf8") || "{}"); return json(res, 200, saveThesis(d, q.entryId, q.thesis)); }
    if (p === "/api/tag" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const q = JSON.parse((await body(req)).toString("utf8") || "{}"); return json(res, 200, saveTag(d, q.entryId, q.tag)); }
    if (p === "/api/contests") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, contestsFor(slateMeta(d), { draftGroup: u.searchParams.get("group") })); }
    if (p === "/api/changes") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, diff(d, hubData(d))); }
    if (p === "/api/built" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); markBuilt(d, hubData(d)); return json(res, 200, { ok: true }); }
    if (p === "/api/notes") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const f = path.join("data", d, "notes.md"); if (req.method === "POST") { fs.writeFileSync(f, (await body(req)).toString("utf8")); return json(res, 200, { ok: true }); } const imgDir = path.join("data", d, "notes"); return json(res, 200, { text: fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "", images: fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter(x => /\.(png|jpe?g|gif|webp)$/i.test(x)).map(x => `data/${d}/notes/${x}`) : [] }); }
    if (p === "/api/notes-image" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const name = path.basename(u.searchParams.get("name") || "image.png").replace(/[^\w.-]/g, "_"); const imgDir = path.join("data", d, "notes"); fs.mkdirSync(imgDir, { recursive: true }); fs.writeFileSync(path.join(imgDir, name), await body(req)); return json(res, 200, { path: `data/${d}/notes/${name}` }); }
    if (p === "/api/ledger") { const f = "data/reports/entries-ledger-nfl.json"; return json(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { ledger: [], entries: 0 }); }
    if (p === "/api/grade" && req.method === "POST") { const out = await run(["bench/grade-entries-nfl.mjs"], 600000); const f = "data/reports/entries-ledger-nfl.json"; return json(res, 200, Object.assign({ out }, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {})); }
    if (p === "/api/nightly" && req.method === "POST") return json(res, 200, await nightly());
    if (p === "/api/winners-profile") { const f = "data/reports/winners-profile-nfl.json"; return json(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null); }
    // static
    let file = decodeURIComponent(p === "/" ? "/hub.html" : p);
    const abs = path.normalize(path.join(ROOT, file)); if (!abs.startsWith(ROOT)) return json(res, 403, { error: "path" });
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(abs).pipe(res);
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, "0.0.0.0", () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal);
  console.log(`Slate Lab hub: http://localhost:${PORT}${lan ? `  (phone on this wifi: http://${lan.address}:${PORT})` : ""}`);
  // No background timers (2026-10-01, user's call): Downloads are read on Refresh and on drop, the
  // nightly chain runs from the Review tab's button, lines re-pull on Refresh. Bring a timer back
  // only once a week of use shows it is missed.
  console.log(`Downloads are read on Refresh; nightly reports run from the Review tab`);
});
