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
import { loadEntries, importEntries, saveThesis, saveTag, loadGuide, parseReads, loadMyReads } from "./entries.mjs";
import { saveLikes, loadLikes } from "./likes.mjs";
import { saveStacks, loadStacks } from "./stacks.mjs";
import { saveBlickCond } from "./blickcond.mjs";
import { fourSourceSim } from "./foursim.mjs";
import { generateAndSim, loadGen } from "./gensim.mjs";
import { buildField, loadField, runSim, loadSimRun, stripField } from "./contestsim.mjs";
import { reviewByRules, loadRules } from "./rulesbrain.mjs";
import { reviewLineups, reviewPortfolio, brainStatus, loadBrain, manualRequest, manualAnswer, pickUpAnswer } from "./brain.mjs";
import { contestsFor } from "./contests.mjs";
import { saveMerge, markBuilt, diff } from "./changes.mjs";
import { lateSwap } from "./lateswap.mjs";
import { fetchEtrData, saveContestSelection, slateData } from "./etrdata.mjs";
import { ingestGrabs } from "./grab.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const PORT = +process.env.PORT || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".md": "text/plain; charset=utf-8", ".txt": "text/plain" };
// $RECENT = 35 days ago at run time: the ownership curve and chalk exponent follow the current season's fields
const NIGHTLY = [["bench/pull-pinnacle-nfl.mjs"], ["bench/winners-nfl.mjs"], ["bench/source-scorecard-nfl.mjs"], ["bench/winners-profile-nfl.mjs", "2026-09-01"], ["bench/rulebook-nfl.mjs"], ["bench/fit-conc-nfl.mjs", "$RECENT"], ["bench/fit-own-error-nfl.mjs"],["bench/vendor-index.mjs"], ["bench/grade-entries-nfl.mjs"]];
const recent = () => new Date(Date.now() - 35 * 864e5).toLocaleString("sv-SE").slice(0, 10);
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((resolve, reject) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); req.on("error", reject); });
const safeDir = d => d && !/[\\/]/.test(d) && fs.existsSync(path.join("data", d)) ? d : null;
const run = (args, timeout = 300000) => new Promise((resolve, reject) => execFile(process.execPath, args, { cwd: ROOT, timeout, maxBuffer: 16e6 }, (err, out, errOut) => err ? reject(new Error((errOut || err.message).split("\n").slice(-3).join(" ").slice(0, 300))) : resolve(String(out).trim().split("\n").slice(-4).join("\n"))));
let refreshing = null, simming = false, nightlyRunning = false, lastIngest = { done: [], notes: [], at: null }, lastNightly = null;

const grabPass = (files = []) => ingestGrabs({ reports: ETR_REPORTS, team: TEAM, files, weekOf: nflWeek });
async function refresh(q) {
  const steps = [], step = async (name, fn) => { const t = Date.now(); try { const info = await fn(); steps.push({ name, ok: true, ms: Date.now() - t, info }); return info; } catch (e) { steps.push({ name, ok: false, ms: Date.now() - t, error: e.message }); return null; } };
  let dir = q.dir || null;
  if (q.slateId && q.date) { const r = await step("stokastic", () => pullStokastic(q.date, q.slateId, "NFL")); if (r) dir = r.dir; }
  await step("pinnacle", () => pullPinnacle().then(r => ({ stamp: r.stamp, games: r.games, props: r.props, projected: r.projected })));
  await step("ingest", () => { const r = ingestPass(); lastIngest = Object.assign(r, { at: new Date().toISOString() }); return { copied: r.done.map(d => `${d.src}: ${d.file} -> ${d.dest}`), notes: r.notes }; });
  // the grabber bookmarklet's files (ETR articles, shows, data tables, Blick conditional): the no-Claude pull
  await step("grabs", () => grabPass());
  await step("injuries", pullInjuries);
  await step("lobby", () => run(["bench/dk-contests.mjs", "NFL"], 60000).then(() => { const j = JSON.parse(fs.readFileSync("data/dk-lobby/nfl.json", "utf8")); return { contests: j.contests.length, fetched: j.fetched }; }));
  if (!dir) { const dirs = slateDirs(); dir = dirs[0] || null; }
  const hub = dir ? await step("merge", () => { const h = hubData(dir); saveMerge(dir, h); return h; }) : null;
  // Lab likes (server/likes.mjs) refresh with the numbers when the slate has a guide or ETR data tables
  if (hub && /nfl/.test(dir) && (fs.existsSync(path.join("data", dir, "slate-guide.json")) || slateData(dir))) await step("likes", () => { const L = saveLikes(dir); return { picks: Object.values(L.picks).flat().length, fades: L.fades.length }; });
  // Lab stacks (server/stacks.mjs) need the slate's generated field + sim; skipped until the Simulator has run
  if (hub && /nfl/.test(dir) && fs.existsSync(path.join("data", dir, "simrun.json")) && fs.existsSync(path.join("data", dir, "field.json"))) await step("stacks", () => { const S = saveStacks(dir); return { top: (S.top || S.pairs || []).length, blick: !!S.blick }; });
  return { steps, hub };
}
// "Pull ETR + Blick" (user-approved 2026-10-03): a one-shot headless Claude Code run (claude -p --chrome) with the job in
// bench/pull-vendors.prompt.md, allowed only the Chrome tools, writes under data/, and curl to this server. It posts its own
// progress to /api/pull-status; when it exits, its final line (or the failure) becomes the status if it didn't post one.
const PULL_MODEL = process.env.SLATELAB_PULL_MODEL || "claude-sonnet-5";
// the ETR reports the Notes tab lists (menu = the start of its link text in ETR's NFL menu, or the YouTube title).
// fmt: c = classic slates, s = showdown slates, cs = both (weekly articles that also cover the TNF/SNF/MNF games; checked
// 2026-10-03: Matchups covers every game, OL/DL, Snaps and Pace, Rundown, Strength and the Leone lists touch them;
// Top Plays, GPP Leverage, Cheap WR, Game Scores and the two weekly shows are main-slate only)
const ETR_REPORTS = [
  { id: "sd-breakdown", fmt: "s", name: "Showdown Breakdown (this game)", sd: "breakdown" },
  { id: "sd-sim", fmt: "s", name: "DraftKings Showdown Sim Analysis", sd: "sim" },
  { id: "sd-show", fmt: "s", name: "Prime-time live show (this game)", sd: "show", video: true },
  // weekly shows (show = the start of its link text on ETR's show-links page, /in-season-weekly-show-schedule/; each links an
  // ETR page with the YouTube video embedded, unlisted, so a channel search misses it. Added 2026-10-09 at the user's ask:
  // Projections Context, Leone's Lineup Build, Wake and Rake (Sunday 10 a.m. ET; the cheat sheet follows it) and the DFS
  // Tournament Review of last week's slate. Not the Last-Minute Livestream; Macro vs. Micro is FanDuel-only; Man vs. Machine
  // was dropped 10/10 as season-long rankings (user: no season-long content; Matchups and the like are facts only)
  { id: "million", fmt: "c", name: "Establish The Million", show: "Establish The Million: Week", video: true },
  { id: "show", fmt: "c", name: "Establish The Show", show: "Establish The Show: Week", video: true },
  { id: "proj-context", fmt: "c", name: "Projections Context Show", show: "Projections Context Show: Week", video: true },
  { id: "lineup-build", fmt: "c", name: "Leone DFS Lineup Build Show (Sat night)", show: "Leone DFS Lineup Build Show: Week", video: true },
  { id: "wake-rake", fmt: "c", name: "Wake and Rake (Sun 10 a.m. ET)", show: "Wake and Rake: Week", video: true },
  { id: "tourney-review", fmt: "c", name: "DFS Tournament Review (last week)", show: "DFS Tournament Review: Week", video: true, lastWeek: true },
  { id: "update-log", fmt: "cs", name: "Silva's Update Log", menu: "Silva's Update Log: Week" },
  { id: "top-plays", fmt: "c", name: "DFS Top Plays", menu: "DFS Top Plays" },
  { id: "gpp-leverage", fmt: "c", name: "GPP Leverage", menu: "GPP Leverage" },
  { id: "matchups", fmt: "cs", name: "Silva's Matchups", menu: "Evan Silva's Matchups" },
  { id: "cheap-wr", fmt: "c", name: "Cheap WR Volume", menu: "ETR's Cheap WR Volume" },
  { id: "ol-dl", fmt: "cs", name: "OL vs. DL Mismatches", menu: "OL vs. DL Mismatches" },
  { id: "snaps-pace", fmt: "cs", name: "Snaps and Pace", menu: "Snaps and Pace" },
  { id: "rundown", fmt: "cs", name: "The Rundown", menu: "The Rundown" },
  { id: "strength", fmt: "cs", name: "Strength in Numbers", menu: "Strength in Numbers" },
  { id: "game-scores", fmt: "c", name: "GPP Game Scores", menu: "GPP Game Scores" },
  { id: "cash-review", fmt: "c", name: "Levitan's Cash Review (last week)", menu: "Levitan: Cash Review" },
  { id: "leone-wrte", fmt: "cs", name: "Buy Leone Model: WR/TE", menu: "Buy Leone Model: WR/TE" },
  { id: "leone-rb", fmt: "cs", name: "Buy Leone Model: RB", menu: "Buy Leone Model: RB" },
  // ETR data tables (user-approved 2026-10-06): the job posts each table's cdn iframe src to /api/etr-data and the hub
  // fetches and parses it into data/etr-data/<yyyy>-wk<nn>/; attached to every guide on load as guide.data (server/etrdata.mjs)
  { id: "dvp", fmt: "cs", name: "Defense vs. Position (data table)", data: "dvp", page: "/establish-the-run-nfl-dvp/" },
  { id: "xfp", fmt: "cs", name: "Expected Fantasy Points (data table)", data: "xfp", page: "/expected-vs-actual-fantasy-points/" },
  { id: "proe", fmt: "cs", name: "Pass Rate Over Expectation (data table)", data: "proe", page: "/pass-rate-over-expectation/" },
  { id: "contest-sel", fmt: "c", name: "Levitan's DK Contest Selection", page: "/levitans-dfs-game-selection-which-contests-to-play/", evergreen: true },
  { id: "blick", fmt: "cs", name: "Blick slate thoughts (your upload, optional)", upload: true },
];
const reportsFor = dir => { const sd = slateMeta(dir).type === "SHOWDOWN"; return ETR_REPORTS.filter(x => x.fmt.includes(sd ? "s" : "c")); };
// NFL week from the date when no Blick file names it (2026 season: week 1 is the week of Tue 2026-09-08)
const nflWeek = date => Math.max(1, Math.floor((Date.parse(date + "T12:00:00Z") - Date.parse("2026-09-08T00:00:00Z")) / 864e5 / 7) + 1);
const TEAM = { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", LA: "Rams", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" };
// which reports have been read into this slate's guide: data/<slate>/etr-reads.json {id: {status: "ok"|"failed", at, title, url, note}}
const readsFile = dir => path.join("data", dir, "etr-reads.json");
const loadReads = dir => { try { return JSON.parse(fs.readFileSync(readsFile(dir), "utf8")); } catch { return {}; } };
function pullStatus(patch) { const sf = "data/requests/status.json"; const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}; fs.writeFileSync(sf, JSON.stringify(Object.assign(cur, patch, { updated: new Date().toISOString() }))); return cur; }
function startPull(r) {
  const meta = slateMeta(r.dir), sd = meta.type === "SHOWDOWN", wk = (() => { const m = fs.readdirSync(path.join("data", r.dir)).join(" ").match(/(\d{4})wk(0[1-9]|[1-9]\d)/); return m ? m[1] + "wk" + m[2] : `${meta.date.slice(0, 4)}wk${String(nflWeek(meta.date)).padStart(2, "0")}`; })();   // no week-named file yet: the NFL week from the date (was wk00)
  const etrMain = `Open https://establishtherun.com/draftkings-fanduel-yahoo-projections/ and wait 4 seconds. The DraftKings table is the FIRST AG Grid on the page; read every row from React in one step (no scrolling):
     const el=document.querySelectorAll('.ag-root-wrapper')[0]; const fk=Object.keys(el).find(k=>k.startsWith('__reactFiber')); let f=el[fk]; while(f&&!(f.memoizedProps&&Array.isArray(f.memoizedProps.rowData))) f=f.return;
     const D=f.memoizedProps.rowData.filter(o=>o.projection>=2||o.largeOwnership>0);
     window.__C=['player,team,opponent,position,salary,projection,floor,ceiling,largeOwnership,smallOwnership'].concat(D.map(o=>[String(o.player).includes(',')?'"'+o.player+'"':o.player,o.team,o.opponent,o.position,o.salary,o.projection,o.floor,o.ceiling,o.largeOwnership,o.smallOwnership].join(','))).join('\\n');
     'rows '+D.length+' chars '+window.__C.length+' | '+((document.body.innerText.match(/DraftKings NFL DFS Projections[^\\n]*\\n[^\\n]*/)||[''])[0])
   Read window.__C in 950-character slices with browser_batch, join exactly, and Write data/${r.dir}/ETR-main-${meta.date}.csv .`;
  const etrSd = `Open https://establishtherun.com/draftkings-showdown-and-fanduel-single-game-projections/?site=DK and use get_page_text. It lists all player names first, then 10 fields per player (Pos, Team, Salary, Proj, Ceiling, Total Own, CPT Own, CPT Salary, CPT Proj, Slate); zip them in order, keep only this game (${meta.games.join(" ")}), strip $ , %, and Write data/${r.dir}/ETR-showdown-${meta.games.join("").replace("@", "")}-${meta.date}.csv with header Player,Pos,Team,Salary,Proj,Ceiling,Total Own,CPT Own,CPT Salary,CPT Proj .`;
  // classic sub-slates: ETR's "Early Only and Afternoon Only" page has its own tables (projection + one ownership column):
  // the first grid is the Early slate, the second the Late slate (Afternoon Only; Afternoon Turbo uses it too). Blick only
  // publishes the main slate, so it's skipped for these.
  const sub = !sd && /^(early only|afternoon only|afternoon turbo)$/i.test(meta.name || ""), late = /afternoon/i.test(meta.name || "");
  const slateTeams = [...new Set(meta.games.flatMap(g => g.split("@")).flatMap(t => t === "LAR" ? ["LAR", "LA"] : [t]))];
  const etrSub = `Open https://establishtherun.com/early-only-and-afternoon-only-dfs-projections/ and wait 5 seconds. The page has two AG Grids: the FIRST is "DraftKings NFL DFS Projections - Early Slate", the SECOND is "... - Late Slate". Use the ${late ? "SECOND (Late)" : "FIRST (Early)"} one and read every row from React in one step (no scrolling):
     const el=document.querySelectorAll('.ag-root-wrapper')[${late ? 1 : 0}]; const fk=Object.keys(el).find(k=>k.startsWith('__reactFiber')); let f=el[fk]; while(f&&!(f.memoizedProps&&Array.isArray(f.memoizedProps.rowData))) f=f.return;
     const T=${JSON.stringify(slateTeams)}; const D=f.memoizedProps.rowData.filter(o=>T.includes(String(o.team).toUpperCase())&&(o.projection>=2||o.ownership>0));
     window.__C=['player,team,opponent,position,salary,projection,floor,ceiling,largeOwnership,smallOwnership'].concat(D.map(o=>[String(o.player).includes(',')?'"'+o.player+'"':o.player,o.team,o.opponent,o.position,o.salary,o.projection,'',o.ceiling||'',o.ownership,o.ownership].join(','))).join('\\n');
     'rows '+D.length+' chars '+window.__C.length
   Read window.__C in 950-character slices with browser_batch, join exactly, and Write data/${r.dir}/ETR-main-${meta.date}.csv .`;
  const vars = { DIR: r.dir, TYPE: meta.type, DATE: meta.date, SLATEID: String(meta.slateId || ""), GAMES: meta.games.join(" "), ETR_STEPS: sd ? etrSd : sub ? etrSub : etrMain,
    BLICK_SKIP: sub ? "SKIP THIS STEP ENTIRELY: Blick only publishes the main slate. In the final message write \"Blick: main slate only\" for Blick and use \"done\" if ETR worked." : "",
    // Blick Conditional Ownership page (step 3b): /nfl/conditional-ownership and /nfl/conditional-ownership-showdown
    BLICK_COND_SUFFIX: sd ? "-showdown" : "",
    BLICK_URL: sd ? "https://blickanalytics.com/nfl/showdown-ownership-gpp" : "https://blickanalytics.com/nfl/ownership-gpp", BLICK_NEXT: sd ? "%2Fnfl%2Fshowdown-ownership-gpp" : "%2Fnfl%2Fownership-gpp",
    BLICK_FILE: sd ? `nfl-${meta.games.join("-").replace("@", "-").toLowerCase()}-showdown-${wk}.csv` : `nfl-main-${wk}.csv` };
  // "Weekly ETR read" (user-approved 2026-10-03): same launcher, the job in bench/read-etr-week.prompt.md reads every NFL-menu
  // article for the week plus Establish The Show and The Million and writes data/<slate>/slate-guide.json; classic slates only
  const weekly = r.kind === "weekly"; vars.WEEK = String(+wk.slice(6) || nflWeek(meta.date));
  if (weekly) vars.WINDIR = path.win32.join(path.resolve(ROOT), "data", r.dir);
  if (weekly && sd) { const [aw, hm] = String(meta.games[0] || "").split("@"); const night = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(meta.date + "T12:00:00Z").getUTCDay()]; Object.assign(vars, { AWAY: aw, HOME: hm, AWAYNAME: TEAM[aw] || aw, HOMENAME: TEAM[hm] || hm, NIGHT: night }); }
  if (weekly) { const pick = reportsFor(r.dir).filter(x => !r.only || r.only.includes(x.id)); vars.TOTAL = String(pick.length);
    vars.REPORTS = pick.map(x => `   - id "${x.id}": ${x.upload ? "the user's upload: data/" + r.dir + "/blick-thoughts.md and images in data/" + r.dir + "/blick/" : x.data ? `ETR data table at https://establishtherun.com${x.page} (step 2b; kind "${x.data}")` : x.evergreen ? `ETR article at https://establishtherun.com${x.page} (step 2c; evergreen, read it whatever its date)` : x.sd === "breakdown" ? `ETR article "Showdown Breakdown: ${vars.AWAYNAME} at ${vars.HOMENAME}"` : x.sd === "sim" ? "ETR page \"DraftKings Showdown Sim Analysis\" (check it is for this game)" : x.sd === "show" ? `ETR "${vars.NIGHT} Night Football Live Show: ${vars.AWAYNAME} at ${vars.HOMENAME}" (YouTube video)` : x.show ? `ETR show "${x.show} ${x.lastWeek ? +vars.WEEK - 1 : vars.WEEK}" (step 3: its page from the show-links page${x.lastWeek ? "; LAST week's edition on purpose: a review of the previous slate, so its lessons go to notes, not this slate's stances" : ""})` : x.video ? `YouTube video "${x.menu} ${vars.WEEK}"` : `ETR NFL menu link starting "${x.menu}"${sd ? " (use only what it says about this game's two teams)" : ""}`}`).join("\n"); }
  const prompt = fs.readFileSync(weekly ? (sd ? "bench/read-etr-showdown.prompt.md" : "bench/read-etr-week.prompt.md") : "bench/pull-vendors.prompt.md", "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
  const args = ["-p", "--chrome", "--model", PULL_MODEL, "--output-format", "json", "--allowedTools", "mcp__claude-in-chrome", "Edit(data/**)", "Write(data/**)", "Read", "Bash(curl:*)", "--", prompt];
  pullStatus({ status: "working", message: "Claude started" });
  const child = execFile("claude", args, { cwd: ROOT, timeout: (weekly ? 45 : 15) * 60000, maxBuffer: 32e6, windowsHide: true }, (err, out) => {
    // the weekly read rewrote the guide and the ETR data tables: rebuild the Lab likes on top of them
    if (weekly && /nfl/.test(r.dir)) { try { saveLikes(r.dir); } catch {} try { saveStacks(r.dir); } catch {} }
    if (!weekly && /nfl/.test(r.dir)) { try { saveStacks(r.dir); } catch {} }   // the vendor pull may have brought Blick's conditional field
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
    if (p === "/api/upload" && req.method === "POST") { const name = path.basename(u.searchParams.get("name") || "upload.csv").replace(/[^\w.@ -]/g, "_"); fs.mkdirSync("data/inbox", { recursive: true }); const f = path.join("data/inbox", name); fs.writeFileSync(f, await body(req)); if (/^slatelab-.*\.txt$/i.test(name)) { const g = await grabPass([f]); return json(res, 200, { done: g.done.map(x => ({ src: "grab", dest: x })), notes: g.notes }); } const r = ingestPass([f]); lastIngest = Object.assign(r, { at: new Date().toISOString() }); return json(res, 200, r); }
    if (p === "/api/entries") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const E = req.method === "POST" ? importEntries(d, (await body(req)).toString("utf8"), u.searchParams.get("name") || "") : loadEntries(d); return json(res, 200, Object.assign(E, { guide: loadGuide(d) })); }
    if (p === "/api/stacks") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); try { return json(res, 200, req.method === "POST" || !loadStacks(d) ? saveStacks(d) : loadStacks(d)); } catch (e) { return json(res, 200, { error: e.message }); } }
    // Blick Conditional Ownership, posted by the vendor pull as compact text (server/blickcond.mjs)
    if (p === "/api/blick-cond" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); try { const r = saveBlickCond(d, (await body(req)).toString("utf8")); try { if (fs.existsSync(path.join("data", d, "simrun.json"))) saveStacks(d); } catch {} return json(res, 200, r); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (p === "/api/likes") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); try { return json(res, 200, req.method === "POST" || !loadLikes(d) ? saveLikes(d) : loadLikes(d)); } catch (e) { return json(res, 500, { error: e.message }); } }
    if (p === "/api/guide") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, loadGuide(d) || {}); }
    if (p === "/api/sim" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, fourSourceSim(d)); } finally { simming = false; } }
    if (p === "/api/field") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, buildField(d, JSON.parse((await body(req)).toString("utf8") || "{}"))); } finally { simming = false; } } return json(res, 200, stripField(loadField(d))); }
    if (p === "/api/simrun") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, runSim(d, JSON.parse((await body(req)).toString("utf8") || "{}"))); } finally { simming = false; } } return json(res, 200, loadSimRun(d) || { rows: [] }); }
    // "Pull ETR + Blick": the site files a request (data/requests/requests.log, one JSON line each); an open Claude session
    // watching that file pulls the CSVs through the user's logged-in Chrome, ingests them, refreshes, and reports progress back
    // through POST /api/pull-status. GET returns the latest request with its status.
    if (p === "/api/pull-request") { const rq = "data/requests", sf = path.join(rq, "status.json"); fs.mkdirSync(rq, { recursive: true }); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); if (!safeDir(q.dir)) return json(res, 400, { error: "dir" }); const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}; if (/pending|working/.test(cur.status) && Date.now() - Date.parse(cur.at) < (cur.kind === "weekly" ? 50 : 20) * 60000) return json(res, 409, Object.assign({ error: "a pull is already running" }, cur)); if (q.kind === "weekly" && !/nfl/i.test(q.dir)) return json(res, 400, { error: "the ETR read is for NFL slates" }); const only = Array.isArray(q.only) ? q.only.filter(id => safeDir(q.dir) && reportsFor(q.dir).some(x => x.id === id)) : null; if (q.kind === "weekly" && only && !only.length) return json(res, 400, { error: "no reports selected" }); const r = { id: Date.now().toString(36), dir: q.dir, kind: q.kind === "weekly" ? "weekly" : "vendors", only: q.kind === "weekly" ? only : undefined, sources: q.sources || ["etr", "blick"], at: new Date().toISOString(), status: "pending", message: "starting Claude" }; fs.appendFileSync(path.join(rq, "requests.log"), JSON.stringify(r) + "\n"); fs.writeFileSync(sf, JSON.stringify(r)); startPull(r); return json(res, 200, r); } return json(res, 200, fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : { status: "none" }); }
    // Notes tab report list: GET the catalog + what's been read for this slate; the weekly job POSTs one report's result
    if (p === "/api/etr-data") { if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); try { if (q.kind === "contest-sel") return json(res, 200, saveContestSelection(q.text || "", +q.week || nflWeek(new Date().toISOString().slice(0, 10)))); return json(res, 200, await fetchEtrData(q.kind, q.url)); } catch (e) { return json(res, 400, { error: e.message }); } } if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, slateData(d) || {}); }
    if (p === "/api/etr-reads") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); if (!ETR_REPORTS.some(x => x.id === q.id)) return json(res, 400, { error: "unknown report id" }); const all = loadReads(d); all[q.id] = { status: q.status === "ok" ? "ok" : "failed", at: new Date().toISOString(), title: q.title || null, url: q.url || null, note: q.note || null }; fs.writeFileSync(readsFile(d), JSON.stringify(all, null, 1)); return json(res, 200, all[q.id]); } const bd = path.join("data", d, "blick"), bf = path.join("data", d, "blick-thoughts.md"); return json(res, 200, { catalog: reportsFor(d).map(({ id, name, video, upload }) => ({ id, name, video: !!video, upload: !!upload })), reads: loadReads(d), digests: (() => { try { return fs.readdirSync(path.join("data", d, "reads")).filter(f => f.endsWith(".md")).map(f => f.slice(0, -3)); } catch { return []; } })(), blick: { text: fs.existsSync(bf) ? fs.readFileSync(bf, "utf8") : "", images: fs.existsSync(bd) ? fs.readdirSync(bd).filter(x => /.(png|jpe?g|gif|webp)$/i.test(x)).map(x => `data/${d}/blick/${x}`) : [] } }); }
    // Blick slate thoughts the user pastes or drops in the Notes tab (read by the weekly job when "blick" is selected)
    if (p === "/api/blick-thoughts" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); fs.writeFileSync(path.join("data", d, "blick-thoughts.md"), (await body(req)).toString("utf8")); return json(res, 200, { ok: true }); }
    if (p === "/api/blick-image" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const name = path.basename(u.searchParams.get("name") || "image.png").replace(/[^w.-]/g, "_"); const bd = path.join("data", d, "blick"); fs.mkdirSync(bd, { recursive: true }); fs.writeFileSync(path.join(bd, name), await body(req)); return json(res, 200, { path: `data/${d}/blick/${name}` }); }
    if (p === "/api/pull-status" && req.method === "POST") { const sf = path.join("data/requests", "status.json"); const q = JSON.parse((await body(req)).toString("utf8") || "{}"); const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}; const r = Object.assign(cur, q, { updated: new Date().toISOString() }); fs.mkdirSync("data/requests", { recursive: true }); fs.writeFileSync(sf, JSON.stringify(r)); return json(res, 200, r); }
    // Entry Manager plan: which lineups go into which contests for the slate (data/<slate>/entry-plan.json); graded after the slate
    if (p === "/api/plan") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const f = path.join("data", d, "entry-plan.json"); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); q.savedAt = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(q, null, 1)); return json(res, 200, q); } return json(res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { contests: [] }); }
    if (p === "/api/brain") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { const q = JSON.parse((await body(req)).toString("utf8") || "{}"); try { return json(res, 200, q.rules ? reviewByRules(d, q.sigs || []) : q.answer != null ? manualAnswer(d, q.answer) : q.manual ? manualRequest(d, q.sigs || [], q.favs || []) : q.portfolio ? await reviewPortfolio(d, q.sigs || []) : await reviewLineups(d, q.sigs || [], { max: q.max })); } catch (e) { return json(res, 500, { error: e.message }); } } const picked = pickUpAnswer(d); return json(res, 200, Object.assign(brainStatus(d), { reviews: loadBrain(d).reviews || {}, rules: loadRules(d).reviews || {}, picked })); }
    if (p === "/api/gen") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (req.method === "POST") { if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { const cfg = JSON.parse((await body(req)).toString("utf8") || "{}"); return json(res, 200, generateAndSim(d, cfg)); } finally { simming = false; } } return json(res, 200, loadGen(d) || { rows: [] }); }
    if (p === "/api/lateswap" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); if (simming) return json(res, 409, { error: "sim already running" }); simming = true; try { return json(res, 200, await lateSwap(d)); } finally { simming = false; } }
    if (p === "/api/thesis" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const q = JSON.parse((await body(req)).toString("utf8") || "{}"); return json(res, 200, saveThesis(d, q.entryId, q.thesis)); }
    if (p === "/api/tag" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const q = JSON.parse((await body(req)).toString("utf8") || "{}"); return json(res, 200, saveTag(d, q.entryId, q.tag)); }
    if (p === "/api/contests") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, contestsFor(slateMeta(d), { draftGroup: u.searchParams.get("group") })); }
    if (p === "/api/changes") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); return json(res, 200, diff(d, hubData(d))); }
    if (p === "/api/built" && req.method === "POST") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); markBuilt(d, hubData(d)); return json(res, 200, { ok: true }); }
    // the user's own player reads (Notes tab): fill guide.stances without any Claude read (server/entries.mjs parseReads)
    if (p === "/api/my-reads") { if (!safeDir(d)) return json(res, 400, { error: "dir" }); const f = path.join("data", d, "my-reads.txt"); if (req.method === "POST") fs.writeFileSync(f, (await body(req)).toString("utf8")); const text = loadMyReads(d), r = parseReads(text); return json(res, 200, { text, count: Object.keys(r.stances).length, bad: r.bad }); }
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
