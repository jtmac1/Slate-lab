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
import { contestsFor } from "./contests.mjs";
import { saveMerge, markBuilt, diff } from "./changes.mjs";
import { lateSwap } from "./lateswap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const PORT = +process.env.PORT || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".md": "text/markdown", ".txt": "text/plain" };
const NIGHTLY = [["bench/pull-pinnacle-nfl.mjs"], ["bench/winners-nfl.mjs"], ["bench/source-scorecard-nfl.mjs"], ["bench/winners-profile-nfl.mjs", "2026-09-01"], ["bench/rulebook-nfl.mjs"], ["bench/vendor-index.mjs"], ["bench/grade-entries-nfl.mjs"]];
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
async function nightly() {
  if (nightlyRunning) return { running: true }; nightlyRunning = true;
  const log = [], t0 = Date.now();
  try { for (const a of NIGHTLY) { const t = Date.now(); try { const out = await run(a, 900000); log.push({ script: a[0], ok: true, ms: Date.now() - t, out }); } catch (e) { log.push({ script: a[0], ok: false, ms: Date.now() - t, error: e.message }); } } }
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
