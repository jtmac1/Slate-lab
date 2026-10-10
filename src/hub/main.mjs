// Slate Lab, rebuilt: Data Hub. One Refresh pulls Stokastic projections + ownership for the chosen
// slate, Pinnacle lines, ESPN injuries, and files any ETR/Blick CSV from Downloads; the table shows
// every source side by side with a consensus, the spread between sources, and the market gap.
// Talks to server/hub.mjs (node server/hub.mjs, http://localhost:8787).
import { $, $$, esc, download } from "../app/ui.mjs";
import { renderEntries, initEntries } from "./entries.mjs";
import { renderContests } from "./contests.mjs";
import { renderReview } from "./review.mjs";
import { renderSim, initSim } from "./sim.mjs";
import { renderGen, initGen } from "./gen.mjs";

const LS = "slatelab:hub";
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } })();
const persist = () => { try { localStorage.setItem(LS, JSON.stringify({ date: S.date, slateId: S.slateId, dir: S.dir, tab: S.tab, view: S.view })); } catch {} };
const nextSlateDate = () => { const d = new Date(), dow = d.getDay(); if (dow >= 2 && dow <= 6) d.setDate(d.getDate() + (7 - dow)); return d.toLocaleString("sv-SE").slice(0, 10); };
const S = { view: ["hub", "entries", "review", "sim", "gen"].includes(saved.view) ? saved.view : "hub", date: saved.date || nextSlateDate(), slateId: saved.slateId || null, dir: saved.dir || null, slates: [], dirs: [], hub: null, tab: saved.tab || "players", q: "", pos: "ALL", sort: { k: "cons", d: -1 }, busy: false, steps: [], msg: "", err: false, showAll: false, slatesErr: "", changes: null, notes: null };
initEntries(S); initSim(S); initGen(S);
// every tab is rebuilt; "Old app" keeps the previous build reachable
// no Contests tab: a record by contest family measures the old process, not the new one (user, 2026-10-02)
const VIEWS = [["hub", "Data Hub", "Data Hub", true], ["gen", "Contest Generator", "Generator", true], ["sim", "Pre-Contest Simulator", "Simulator", true], ["entries", "Entries", "Entries", true], ["review", "Review", "Review", true], ["old", "Old app", "Old app"]];
const api = async (p, opts) => { const r = await fetch(p, opts); const j = await r.json().catch(() => ({ error: r.statusText })); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const f1 = v => v == null || isNaN(v) ? "—" : (+v).toFixed(1);
const f0 = v => v == null || isNaN(v) ? "—" : (+v).toFixed(0);
const pc = v => v == null || isNaN(v) ? "—" : (+v).toFixed(1) + "%";
// every time on the page is Central, 12-hour (user, 2026-10-03)
const CT = "America/Chicago";
const when = iso => { if (!iso) return "—"; const d = iso instanceof Date ? iso : new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("en-US", { timeZone: CT, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT"; };
const clockCT = d => d.toLocaleString("en-US", { timeZone: CT, hour: "numeric", minute: "2-digit" });
// a wall-clock time in a named zone ("2026-10-04T13:00:00" in America/New_York) to a real instant
const zoned = (local, tz) => {
  const guess = new Date(local + "Z"), p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(guess).map(x => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - guess.getTime();   // the zone's UTC offset at that moment
  return new Date(guess.getTime() - offset);
};
// vendor stamps as their sites print them: ETR "Fri, Oct 02, 2026 10:09PM CDT", Blick "2026-10-03 01:29 AM ET"
const vendorTime = s => { if (!s) return null; const t = String(s);
  let m = t.match(/(\w{3})\w*\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)\s*(C[DS]T|E[DS]T|ET|CT)?/i);
  if (m) { const mo = "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[1].slice(0, 3)) / 3 + 1, h = (+m[4] % 12) + (/P/i.test(m[6]) ? 12 : 0); return zoned(`${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[5]}:00`, /^E/i.test(m[7] || "") ? "America/New_York" : CT); }
  m = t.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*([AP]M)\s*(ET|CT)?/i);
  if (m) { const h = (+m[2] % 12) + (/P/i.test(m[4]) ? 12 : 0); return zoned(`${m[1]}T${String(h).padStart(2, "0")}:${m[3]}:00`, /^C/i.test(m[5] || "") ? CT : "America/New_York"); }
  const d = new Date(t); return isNaN(d) ? null : d; };
// the league picker: real league marks (ESPN's league logos); only NFL is rebuilt so far
const LEAGUES = [["nfl", "NFL", "https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png", true], ["cfb", "College Football", "https://a.espncdn.com/i/teamlogos/ncaa/500/ncaa.png", false], ["mlb", "MLB", "https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png", false]];
const ago = iso => { if (!iso) return ""; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const nameCell = p => { const parts = String(p.name || "").split(" "), first = parts.shift(); return `<span class="pname"><span class="first">${esc(first)}</span> ${esc(parts.join(" "))}</span>${p.inj ? `<span class="inj${/Questionable/i.test(p.inj.status) ? " q" : ""}" title="${esc(p.inj.note || "")}">${esc(p.inj.status.replace("Injured Reserve", "IR").slice(0, 4).toUpperCase())}</span>` : (p.stk && p.stk.inj ? `<span class="inj q">${esc(p.stk.inj.slice(0, 4).toUpperCase())}</span>` : "")}`; };
const teamCell = t => `<span class="tm"><i></i>${esc(t || "?")}</span>`;
const gapCell = v => v == null ? "—" : `<span class="gap ${v > 0 ? "up" : v < 0 ? "dn" : ""}">${v > 0 ? "+" : ""}${v.toFixed(1)}</span>`;
const mv = v => v == null || v === 0 ? "" : `<span class="mv ${v > 0 ? "up" : "dn"}">${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}</span>`;
const setMsg = (m, err) => { S.msg = m; S.err = !!err; const el = $("#status"); if (el) el.innerHTML = err ? `<span class="err">${esc(m)}</span>` : esc(m); };

/* ---------------- data ---------------- */
async function loadDirs() { S.dirs = await api("/api/dirs"); if (!S.dir || !S.dirs.some(d => d.dir === S.dir)) S.dir = S.dirs[0] ? S.dirs[0].dir : null; }
async function loadHub() { if (!S.dir) { S.hub = null; return; } S.hub = await api(`/api/hub?dir=${encodeURIComponent(S.dir)}`); }
async function loadSlates() {
  S.slatesErr = "";
  try { S.slates = await api(`/api/slates?date=${S.date}`); } catch (e) { S.slates = []; S.slatesErr = e.message; }
  const cur = S.dirs.find(d => d.dir === S.dir);
  if (!S.slates.some(s => String(s.slateId) === String(S.slateId))) S.slateId = cur && S.slates.some(s => String(s.slateId) === String(cur.slateId)) ? cur.slateId : (S.slates[0] ? S.slates[0].slateId : null);
}
async function refresh() {
  if (S.busy) return; S.busy = true; S.steps = []; render(); setMsg("Refreshing: Stokastic, Pinnacle, Downloads, injuries…");
  try {
    const r = await api("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: S.date, slateId: S.slateId, dir: S.dir }) });
    S.steps = r.steps; const stk = r.steps.find(s => s.name === "stokastic");
    if (stk && stk.ok) S.dir = stk.info.dir;
    S.hub = r.hub; await loadDirs(); if (S.hub) S.dir = S.hub.dir;
    const bad = r.steps.filter(s => !s.ok); setMsg(bad.length ? `Refreshed with ${bad.length} problem${bad.length > 1 ? "s" : ""}: ${bad.map(s => s.name + " (" + s.error + ")").join("; ")}` : `Refreshed ${when(new Date().toISOString())}`, bad.length > 0);
  } catch (e) { setMsg("Refresh failed: " + e.message, true); }
  S.busy = false; persist(); render();
}
async function upload(file) {
  setMsg(`Uploading ${file.name}…`);
  try { const r = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: await file.arrayBuffer() });
    if (r.done.length) { setMsg(`Filed ${r.done.map(d => `${d.src} -> ${d.dest}`).join(", ")}`); await loadDirs(); if (r.done[0].dest && r.done[0].src !== "grab") S.dir = r.done[0].dest.replace(/^data[\\/]/, "").split(/[\\/]/)[0]; await loadHub(); }
    else setMsg(`Not filed: ${r.notes.join("; ") || "already ingested or not a projections file"}`, true);
  } catch (e) { setMsg("Upload failed: " + e.message, true); }
  render();
}

/* ---------------- render ---------------- */
function render() {
  const app = $("#app"), H = S.hub;
  app.innerHTML = `<nav class="nav"><div class="brand"><i></i>SLATE LAB</div><div class="links">${VIEWS.map(([k, l, s, live]) => live ? `<button class="lnk" data-view="${k}" aria-selected="${S.view === k}"><span class="long">${l}</span><span class="short">${s}</span></button>` : `<a class="lnk" href="index.html" title="Not rebuilt yet; opens the current app"><span class="long">${l}</span><span class="short">${s}</span></a>`).join("")}</div><div class="grow"></div>
</nav>
    <div id="ctl" class="${S.view === "hub" ? "" : "nothub"}">${ctl()}</div><div class="prog"><i id="prog"${S.busy ? ' style="width:60%"' : ""}></i></div><div id="status" class="status">${S.err ? `<span class="err">${esc(S.msg)}</span>` : esc(S.msg)}</div>${S.view === "hub" ? steps() + srcStrip() : ""}<div id="tabs">${S.view === "hub" ? tabs() : ""}</div><div id="main"></div><div id="bot"></div>`;
  $$(".lnk[data-view]").forEach(b => b.addEventListener("click", () => { S.view = b.getAttribute("data-view"); persist(); render(); }));
  wireCtl(); renderMain();
}
function leaguePicker() {
  const cur = LEAGUES.find(l => l[0] === "nfl");
  return `<div class="lgpick"><button class="sel lgbtn" id="lgbtn" type="button"><img src="${cur[2]}" alt="" width="20" height="20"> ${cur[1]}</button>${S.lgOpen ? `<div class="menu lgmenu">${LEAGUES.map(([k, l, img, live]) => `<button type="button" data-lg="${k}"${live ? "" : " disabled title=\"not rebuilt yet\""}><img src="${img}" alt="" width="22" height="22"> ${l}${live ? "" : ' <span class="mini">soon</span>'}</button>`).join("")}</div>` : ""}</div>`;
}
function ctl() {
  // Stokastic's slate starts are Eastern wall-clock times; show them in Central, 12-hour
  const slateOpts = S.slates.map(s => `<option value="${s.slateId}"${String(s.slateId) === String(S.slateId) ? " selected" : ""}>${esc(s.name)} · ${s.type === "SHOWDOWN" ? "Showdown" : "Classic"} · ${s.games.length} gm · ${esc(clockCT(zoned(s.start.slice(0, 19), "America/New_York")))} CT</option>`).join("");
  const dirOpts = S.dirs.slice(0, 20).map(d => `<option value="dir:${d.dir}"${d.dir === S.dir && !S.slates.some(s => String(s.slateId) === String(S.slateId) && String(s.slateId) === String(d.slateId)) ? " selected" : ""}>${esc(d.date)} ${esc(d.name || d.code)} (${d.games.length || "?"} gm)</option>`).join("");
  return `<div class="ctl">
    <div class="f"><label>League</label>${leaguePicker()}</div>
    <div class="f"><label>Slate date</label><input class="txt" type="date" id="date" value="${S.date}"></div>
    <div class="f wide"><label>Slate ${S.slatesErr ? `<span class="hint">(Stokastic: ${esc(S.slatesErr)})</span>` : ""}</label><select class="sel" id="slate" style="min-width:260px">${slateOpts ? `<optgroup label="Stokastic · ${S.date}">${slateOpts}</optgroup>` : `<option value="">no DK slates on ${S.date}</option>`}${dirOpts ? `<optgroup label="Saved folders">${dirOpts}</optgroup>` : ""}</select></div>
    <div class="f cta"><label>&nbsp;</label><button class="btn refresh${S.busy ? " busy" : ""}" id="refresh"${S.busy ? " disabled" : ""}>${S.busy ? "Refreshing…" : "⟳ Refresh"}</button></div>
    <div class="f"><label>&nbsp;</label><button class="btn sec" id="pullVend" title="Starts a short Claude run that pulls ETR and Blick in your logged-in Chrome, files them and refreshes. Chrome must be open with the Claude extension connected."${S.hub && !pulling() ? "" : " disabled"}>${pulling() && S.pull.kind !== "weekly" ? `Pulling… <span class="mini">${esc(S.pull.message || "")}</span>` : "⤓ Pull ETR + Blick"}</button></div>
    <div class="f"><label>&nbsp;</label><label class="drop sm btn sec" id="drop" title="ETR or Blick CSV, or a file the Slate Lab grabber saved">Drop ETR / Blick CSV <input type="file" id="file" accept=".csv,.txt" multiple></label></div>
    <div class="f"><label>&nbsp;</label><a class="btn ghost" href="src/grab/index.html" target="_blank" title="A browser button that pulls ETR, Blick and the shows with no Claude">No-Claude grabber</a></div></div>`;
}
function wireCtl() {
  $("#date").addEventListener("change", async e => { S.date = e.target.value; persist(); await loadSlates(); render(); });
  $("#slate").addEventListener("change", async e => { const v = e.target.value; if (v.startsWith("dir:")) { S.dir = v.slice(4); const d = S.dirs.find(x => x.dir === S.dir); if (d && d.slateId) S.slateId = d.slateId; await loadHub(); } else { S.slateId = v; const d = S.dirs.find(x => String(x.slateId) === String(v)); if (d) { S.dir = d.dir; await loadHub(); } } persist(); render(); });
  $("#refresh").addEventListener("click", refresh);
  const lb = $("#lgbtn"); if (lb) lb.addEventListener("click", () => { S.lgOpen = !S.lgOpen; render(); });
  $$("[data-lg]").forEach(b => b.addEventListener("click", () => { S.lgOpen = false; render(); }));
  const pv = $("#pullVend"); if (pv) pv.addEventListener("click", async () => { try { S.pull = await api("/api/pull-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: S.hub.dir, sources: ["etr", "blick"] }) }); setMsg("Asked Claude to pull ETR + Blick; this updates as it works"); render(); watchPull(); } catch (e) { setMsg("Could not file the request: " + e.message, true); } });
  const inp = $("#file"); inp.addEventListener("change", async e => { for (const f of Array.from(e.target.files || [])) await upload(f); try { e.target.value = ""; } catch {} });
  const zone = $("#drop"); ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("over"); })); ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", async e => { for (const f of Array.from(e.dataTransfer.files || [])) await upload(f); });
}
// follow a pull request while it's open: every 3s until Claude marks it done or failed (or 20 minutes pass with nobody picking it up)
let pullTimer = null;
function pulling() { return !!(S.pull && /pending|working/.test(S.pull.status)); }
function watchPull() {
  if (pullTimer) return; const t0 = Date.now();
  pullTimer = setInterval(async () => {
    try { const r = await api("/api/pull-request"); const was = S.pull && S.pull.status + (S.pull.message || ""); S.pull = r;
      const wk = r.kind === "weekly", mins = wk ? 45 : 15;
      if (wk && S.hub && /done|error/.test(r.status)) await loadReads(true);
      if (r.status === "done") { clearInterval(pullTimer); pullTimer = null; setMsg((wk ? "" : "ETR + Blick pulled: ") + (r.message || "done")); await loadHub(); render(); return; }
      if (r.status === "error") { clearInterval(pullTimer); pullTimer = null; setMsg((wk ? "Weekly ETR read stopped: " : "Pull failed: ") + (r.message || "unknown"), true); render(); return; }
      if (/pending|working/.test(r.status) && Date.now() - t0 > (mins + 1) * 60000) { clearInterval(pullTimer); pullTimer = null; await api("/api/pull-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "error", message: `the Claude run didn't finish in ${mins} minutes` }) }); S.pull.status = "error"; setMsg(`The run didn't finish in ${mins} minutes. Check that Chrome is open with the Claude extension connected.`, true); render(); return; }
      if (r.status + (r.message || "") !== was) { if (S.tab === "notes" && $("#weekBox")) { await loadReads(true); paintWeek(); const pv = $("#pullVend"); if (pv) pv.disabled = pulling(); } else render(); }
    } catch { /* server restarting: keep waiting */ }
  }, 3000);
}
function steps() { if (!S.steps.length) return ""; return `<div class="steps">${S.steps.map(s => `<span class="${s.ok ? "ok" : "bad"}">${s.ok ? "✓" : "✗"} ${esc(s.name)} ${s.ok ? esc(stepInfo(s)) : esc(s.error)} <span class="mini">${(s.ms / 1000).toFixed(1)}s</span></span>`).join("")}</div>`; }
function stepInfo(s) { const i = s.info || {}; if (s.name === "stokastic") return `${i.projected} projected, ${i.changed ? "new numbers" : "unchanged"}`; if (s.name === "pinnacle") return `${i.games} games, ${i.props} props`; if (s.name === "ingest") return i.copied.length ? i.copied.join("; ") : "nothing new in Downloads"; if (s.name === "injuries") return `${i.notActive} flagged`; if (s.name === "merge") return `${i.rows.length} players`; return ""; }
function srcStrip() {
  const H = S.hub; if (!H) return "";
  const s = H.sources, box = (cls, name, line, sub) => `<div class="src ${cls}"><i></i><div><b>${name}</b> ${line}<small>${sub}</small></div></div>`;
  return `<div class="srcs">
    ${s.stokastic ? box("ok", "Stokastic", `${s.stokastic.rows} players`, `proj ${when(s.stokastic.projUpdated)} · own ${when(s.stokastic.ownUpdated)} · checked ${ago(s.stokastic.pulledAt)}`) : box("bad", "Stokastic", "not pulled", "pick the slate and Refresh")}
    ${s.etr ? box("ok", "ETR", `${s.etr.rows} players`, `${s.etr.updated ? `updated ${when(vendorTime(s.etr.updated))}` : "update time unknown"} · checked ${ago(s.etr.checked || s.etr.mtime)}`) : box("warn", "ETR", "not pulled", "press Pull ETR + Blick")}
    ${s.blick ? box(s.blick.stale ? "warn" : "ok", "Blick", s.blick.stale ? "file has zero projections" : `${s.blick.rows} players`, `${s.blick.updated ? `updated ${when(vendorTime(s.blick.updated))}` : "update time unknown"} · checked ${ago(s.blick.checked || s.blick.mtime)}`) : box("warn", "Blick", "not pulled", "press Pull ETR + Blick")}
    ${s.market ? box("ok", "Pinnacle", `${s.market.rows} players`, `lines ${when(s.market.pulledAt)} · checked ${ago(s.market.pulledAt)}`) : box("warn", "Pinnacle", "no lines for these games", "Refresh pulls the current week")}
    ${s.injuries ? box("ok", "ESPN", `${s.injuries.flagged} injuries`, `${s.injuries.latest ? `latest report ${when(s.injuries.latest)}` : "no reports"} · checked ${ago(s.injuries.at)}`) : box("warn", "ESPN", "injuries not pulled", "Refresh pulls ESPN")}
  </div>`;
}
function tabs() { const H = S.hub, sd = H && H.slate.type === "SHOWDOWN"; return `<div class="tabs">${[["players", "Players", H ? H.rows.length : ""], ...(sd ? [["captains", "Captains"]] : []), ["games", "Games", H ? H.games.length : ""], ["changes", "What changed"], ["notes", "Notes"], ["sources", "Sources"]].map(([k, l, n]) => `<button class="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${n !== "" && n != null ? `<span class="n">${n}</span>` : ""}</button>`).join("")}</div>`; }
function renderMain() {
  $$("#tabs .tab").forEach(b => b.addEventListener("click", () => { S.tab = b.getAttribute("data-tab"); persist(); render(); }));
  const main = $("#main"), H = S.hub;
  const ctx = { S, api, setMsg, render };
  if (S.view === "entries") { renderEntries(main, ctx); return; }
  if (S.view === "contests") { renderContests(main, ctx); return; }
  if (S.view === "review") { renderReview(main, ctx); return; }
  if (S.view === "sim") { renderSim(main, ctx); return; }
  if (S.view === "gen") { renderGen(main, ctx); return; }
  if (!H) { main.innerHTML = `<div class="empty">No slate loaded<small>Pick the slate date and the DraftKings slate above, then press Refresh.</small></div>`; return; }
  if (S.tab === "players") renderPlayers(main); else if (S.tab === "games") renderGames(main); else if (S.tab === "captains") renderCaptains(main); else if (S.tab === "changes") renderChanges(main); else if (S.tab === "notes") renderNotes(main); else renderSources(main);
}
const COLS = [
  { k: "name", l: "Player", r: nameCell, s: r => r.name },
  { k: "pos", l: "Pos", r: r => esc(r.pos), s: r => r.pos },
  { k: "team", l: "Team", r: r => teamCell(r.team), s: r => r.team },
  { k: "opp", l: "Opp", r: r => esc(r.opp || ""), s: r => r.opp },
  { k: "sal", l: "Sal", n: 1, r: r => r.sal == null ? "—" : "$" + r.sal.toLocaleString(), s: r => r.sal },
  { k: "stk", l: "Stok", n: 1, r: r => f1(r.stk && r.stk.proj), s: r => r.stk ? r.stk.proj : null, t: "Stokastic projection" },
  { k: "stkOwn", l: "Own", n: 1, r: r => pc(r.stk && r.stk.own), s: r => r.stk ? r.stk.own : null, t: "Stokastic ownership" },
  { k: "etr", l: "ETR", n: 1, r: r => f1(r.etr && r.etr.proj), s: r => r.etr ? r.etr.proj : null },
  { k: "etrOwn", l: "Own", n: 1, r: r => pc(r.etr && r.etr.own), s: r => r.etr ? r.etr.own : null, t: "ETR large-field ownership" },
  { k: "blick", l: "Blick", n: 1, r: r => f1(r.blick && r.blick.proj), s: r => r.blick ? r.blick.proj : null },
  { k: "blickOwn", l: "Own", n: 1, r: r => pc(r.blick && r.blick.own), s: r => r.blick ? r.blick.own : null, t: "Blick MME ownership" },
  { k: "mkt", l: "Market", n: 1, r: r => `<span title="${esc(r.mkt ? r.mkt.lines : "")}">${f1(r.mkt && r.mkt.proj)}</span>`, s: r => r.mkt ? r.mkt.proj : null, t: "Pinnacle lines turned into DK points" },
  { k: "cons", l: "Cons", n: 1, r: r => `<b>${f1(r.cons)}</b><span class="mini"> /${r.nSrc}</span>`, s: r => r.cons, t: "mean of the sources present" },
  { k: "lab", l: "Lab", n: 1, r: r => `<b>${f1(r.lab)}</b>`, s: r => r.lab, t: "Lab blend: sources weighted by their scorecard accuracy per position" },
  { k: "labOwn", l: "Model own", n: 1, r: r => pc(r.labOwn), s: r => r.labOwn, t: "predicted actual ownership: the vendors' average run through the player model fit on real fields (classic) or the measured bucket curve (showdown)" },
  { k: "ownDelta", l: "vs sites", n: 1, r: r => r.ownDelta == null ? "—" : `<span class="${Math.abs(r.ownDelta) >= 3 ? (r.ownDelta > 0 ? "gap dn" : "gap up") : ""}">${r.ownDelta > 0 ? "+" : ""}${r.ownDelta.toFixed(1)}</span>`, s: r => r.ownDelta, t: "Model own minus the vendors' average: + means the field will come in heavier than projected, − lighter (classic only)" },
  { k: "spread", l: "Range", n: 1, r: r => r.spread == null ? "—" : `<span class="${r.spread >= 4 ? "gap dn" : ""}">${f1(r.spread)}</span>`, s: r => r.spread, t: "highest minus lowest source" },
  { k: "mktGap", l: "Mkt−Vend", n: 1, r: r => gapCell(r.mktGap), s: r => r.mktGap, t: "market minus the vendor average" },
  { k: "value", l: "Val", n: 1, r: r => f1(r.value), s: r => r.value, t: "consensus per $1K" },
];
function renderPlayers(main) {
  const H = S.hub, sd = H.slate.type === "SHOWDOWN";
  // showdown: a captain-ownership column next to each source's flex ownership
  const cptCol = (src, label) => ({ k: src + "Cpt", l: "CPT", n: 1, r: r => pc(r[src] && r[src].cptOwn), s: r => r[src] ? r[src].cptOwn : null, t: label + " captain ownership" });
  const cols = sd ? COLS.flatMap(c => c.k === "stkOwn" ? [c, cptCol("stk", "Stokastic")] : c.k === "etrOwn" ? [c, cptCol("etr", "ETR")] : c.k === "blickOwn" ? [c, cptCol("blick", "Blick")] : [c]) : COLS;
  let rows = H.rows.filter(r => (S.pos === "ALL" || r.pos.split("/")[0] === S.pos) && (!S.q || (r.name + " " + r.team).toLowerCase().includes(S.q.toLowerCase())) && (S.showAll || (r.cons != null && r.cons >= 1)));
  const col = cols.find(c => c.k === S.sort.k) || cols[12];
  rows = rows.slice().sort((a, b) => { const x = col.s(a), y = col.s(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.sort.d; });
  main.innerHTML = `<div class="tool"><div class="search">🔍 <input id="q" placeholder="Player or team" value="${esc(S.q)}"></div><div class="pos">${["ALL", "QB", "RB", "WR", "TE", "K", "DST"].map(p => `<button data-pos="${p}" aria-selected="${S.pos === p}">${p}</button>`).join("")}</div>
    <label class="sw${S.showAll ? " on" : ""}" id="showAll"><i></i>show everyone</label><div class="grow"></div><button class="btn ghost" id="export">⬇ Export merged CSV</button></div>
    <div class="tw"><table><thead><tr>${cols.map(c => `<th class="${c.n ? "num" : ""}${c.k === "name" ? " stl" : ""}" data-sort="${c.k}" title="${esc(c.t || "")}">${c.l}${S.sort.k === c.k ? `<span class="ar">${S.sort.d < 0 ? "▼" : "▲"}</span>` : ""}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.n ? "num" : ""}${c.k === "name" ? " stl" : ""}">${c.r(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">${rows.length} of ${H.rows.length} players · Range ≥ 4 and |Mkt−Vend| ≥ 3 are the players to look at · hover Market for the lines</span></div>`;
  $("#q").addEventListener("input", e => { S.q = e.target.value; renderPlayers(main); const i = $("#q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
  $$("[data-pos]", main).forEach(b => b.addEventListener("click", () => { S.pos = b.getAttribute("data-pos"); renderPlayers(main); }));
  $("#showAll").addEventListener("click", () => { S.showAll = !S.showAll; renderPlayers(main); });
  $$("th[data-sort]", main).forEach(th => th.addEventListener("click", () => { const k = th.getAttribute("data-sort"); S.sort = S.sort.k === k ? { k, d: -S.sort.d } : { k, d: k === "name" || k === "pos" || k === "team" ? 1 : -1 }; renderPlayers(main); }));
  $("#export").addEventListener("click", () => {
    const head = ["Player", "Pos", "Team", "Opp", "Salary", "Stokastic", "StokOwn", "StokCptOwn", "ETR", "ETROwn", "Blick", "BlickOwn", "Market", "Consensus", "Sources", "Range", "MarketGap", "Injury", "DK ID"];
    const q = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const lines = [head.join(",")].concat(H.rows.map(r => [r.name, r.pos, r.team, r.opp, r.sal, r.stk?.proj, r.stk?.own, r.stk?.cptOwn, r.etr?.proj, r.etr?.own, r.blick?.proj, r.blick?.own, r.mkt?.proj, r.cons, r.nSrc, r.spread, r.mktGap, r.inj ? r.inj.status : (r.stk?.inj || ""), r.stk?.dkId].map(q).join(",")));
    download(`merged-${H.dir}.csv`, lines.join("\n") + "\n");
  });
}
function renderGames(main) {
  const H = S.hub, g = H.games, first = H.sources.market && H.sources.market.firstStamp;
  main.innerHTML = `<div class="tw games"><table><thead><tr><th>Game</th><th>Kick</th><th class="num">Spread (home)</th><th class="num">Total</th><th class="num">Away TT</th><th class="num">Home TT</th><th class="num">Stok away</th><th class="num">Stok home</th><th class="num">ML home</th></tr></thead>
    <tbody>${g.map(x => `<tr><td><b>${esc(x.game)}</b></td><td>${x.start ? new Date(x.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "—"}</td><td class="num">${x.spread == null ? "—" : (x.spread > 0 ? "+" : "") + x.spread}${mv(x.dSpread)}</td><td class="num">${x.total ?? "—"}${mv(x.dTotal)}</td><td class="num">${x.ttAway ?? "—"}${mv(x.dTTAway)}</td><td class="num">${x.ttHome ?? "—"}${mv(x.dTTHome)}</td><td class="num">${f1(x.stkAway)}</td><td class="num">${f1(x.stkHome)}</td><td class="num">${x.mlHome ?? "—"}</td></tr>`).join("")}</tbody></table></div>`;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Pinnacle lines${first ? `; arrows show movement since the first snapshot this week (${esc(first.slice(5, 10))} ${esc(first.slice(11, 13))}:${esc(first.slice(13))})` : ""}. Stok = Stokastic team totals.</span></div>`;
}
async function renderSources(main) {
  const H = S.hub, s = H.sources;
  const row = (name, v) => `<tr><td><b>${name}</b></td><td>${v}</td></tr>`;
  main.innerHTML = `<div class="kpi">${[["Players", H.rows.length], ["2+ sources", H.rows.filter(r => r.nSrc >= 2).length], ["All 4", H.rows.filter(r => r.nSrc === 4).length], ["Range ≥ 4", H.rows.filter(r => r.spread >= 4).length], ["|Mkt−Vend| ≥ 3", H.rows.filter(r => Math.abs(r.mktGap) >= 3).length], ["Injury flags", H.rows.filter(r => r.inj).length]].map(([k, v]) => `<div class="box"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
    <div class="tw"><table><thead><tr><th>Source</th><th>Status</th></tr></thead><tbody>
    ${row("Stokastic", s.stokastic ? `${esc(s.stokastic.file)} · ${s.stokastic.rows} rows · projections ${when(s.stokastic.projUpdated)} · ownership ${when(s.stokastic.ownUpdated)} · pulled ${when(s.stokastic.pulledAt)}` : "none")}
    ${row("ETR", s.etr ? `${esc(s.etr.file)} · ${s.etr.rows} rows · saved ${when(s.etr.mtime)}` : "none — download the slate CSV from ETR while logged in; the server files it from Downloads")}
    ${row("Blick", s.blick ? `${esc(s.blick.file)} · ${s.blick.rows} rows${s.blick.stale ? " · ZERO projections (stale file)" : ""} · saved ${when(s.blick.mtime)}` : "none — download the CSV from the Blick Discord; the server files it from Downloads")}
    ${row("Pinnacle", s.market ? `snapshot ${esc(s.market.stamp)} · ${s.market.rows} players · ${s.market.snapshots} snapshots this week (first ${esc(s.market.firstStamp)})` : "no snapshot covers these games")}
    ${row("Injuries", s.injuries ? `ESPN · ${when(s.injuries.at)} · ${s.injuries.flagged} players on this slate not Active` : "none")}
    </tbody></table></div><div id="score" class="status">loading scorecard…</div>`;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Scorecard: how each source tracked actual points on past slates (bench/source-scorecard-nfl.mjs, nightly).</span></div>`;
  try {
    const sc = await (await fetch("data/reports/source-scorecard-nfl.json", { cache: "no-store" })).json();
    const sl = sc.slates.filter(x => !x.note).slice(-6).reverse(), names = ["stokastic", "etr", "blick", "market", "consensus"];
    $("#score").innerHTML = `<div class="tw"><table><thead><tr><th>Slate</th><th>n</th>${names.map(n => `<th class="num">${n} r / MAE</th>`).join("")}</tr></thead><tbody>${sl.map(x => `<tr><td><b>${esc(x.date)} ${esc(x.code)}</b></td><td>${x.n}</td>${names.map(n => `<td class="num">${x.sources[n] ? `${x.sources[n].r.toFixed(2)} / ${x.sources[n].mae.toFixed(1)}` : "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  } catch { $("#score").textContent = "no scorecard yet"; }
}

/* ---------------- captains (showdown) ---------------- */
function renderCaptains(main) {
  const H = S.hub, rows = H.rows.filter(r => (r.cons ?? 0) >= 2 && r.sal).map(r => ({ r, cptSal: Math.round(r.sal * 1.5), cptProj: +(1.5 * (r.lab ?? r.cons)).toFixed(1), stk: r.stk?.cptOwn, etr: r.etr?.cptOwn, blick: r.blick?.cptOwn, flags: [r.pos === "TE" ? "TE captain (avoid)" : "", r.pos === "K" || r.pos === "DST" ? "K/DST captain (never)" : "", r.stk?.cptOwn != null && r.stk.cptOwn < 10 ? "under 10% CPT own" : ""].filter(Boolean) })).sort((a, b) => b.cptProj - a.cptProj);
  const g = H.games[0];
  main.innerHTML = `<div class="kpi">${g ? [["Game", g.game], ["Spread (home)", g.spread == null ? "—" : (g.spread > 0 ? "+" : "") + g.spread], ["Total", g.total ?? "—"], [g.away + " total", g.ttAway ?? "—"], [g.home + " total", g.ttHome ?? "—"]].map(([k, v]) => `<div class="box"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("") : ""}</div>
    <div class="tw"><table><thead><tr><th class="na">Player</th><th class="na">Pos</th><th class="na">Team</th><th class="na num">CPT $</th><th class="na num" title="1.5x the Lab projection">CPT proj</th><th class="na num">Stok CPT</th><th class="na num">ETR CPT</th><th class="na num">Blick CPT</th><th class="na num">Flex own</th><th class="na">Rulebook</th></tr></thead><tbody>
    ${rows.map(x => `<tr><td>${nameCell(x.r)}</td><td>${esc(x.r.pos)}</td><td>${teamCell(x.r.team)}</td><td class="num">$${x.cptSal.toLocaleString()}</td><td class="num"><b>${x.cptProj}</b></td><td class="num">${pc(x.stk)}</td><td class="num">${pc(x.etr)}</td><td class="num">${pc(x.blick)}</td><td class="num">${pc(x.r.own)}</td><td class="rules">${x.flags.length ? x.flags.map(f => `<div class="soft">✗ ${esc(f)}</div>`).join("") : '<div class="none">clear</div>'}</td></tr>`).join("")}</tbody></table></div>`;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Showdown rulebook: 5-1 split, has QB, has DST, no kicker, captain not TE/K/DST and at least 10% owned, ownership sum under 180, leave $1,000+. Winners' captains over-index QB/WR.</span></div>`;
}
/* ---------------- what changed ---------------- */
async function renderChanges(main) {
  const H = S.hub;
  if (!S.changes || S.changes.dir !== H.dir) { try { S.changes = Object.assign(await api(`/api/changes?dir=${encodeURIComponent(H.dir)}`), { dir: H.dir }); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
  const C = S.changes, mvc = v => `<span class="gap ${v > 0 ? "up" : "dn"}">${v > 0 ? "+" : ""}${v}</span>`;
  const sec = (title, list, cols, row) => `<div style="padding:12px 16px 4px"><b style="font-size:12.5px">${title}</b> <span class="hint">${list.length}</span></div>${list.length ? `<div class="tw" style="max-height:36vh"><table><thead><tr>${cols.map(c => `<th class="na">${c}</th>`).join("")}</tr></thead><tbody>${list.map(row).join("")}</tbody></table></div>` : `<div class="hint" style="padding:0 16px 8px">none</div>`}`;
  main.innerHTML = `<div class="status">${esc(C.label)}</div>
    ${sec("Injury designations", C.inj, ["Player", "Team", "Pos", "Was", "Now"], x => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.team)}</td><td>${esc(x.pos)}</td><td>${esc(x.from)}</td><td><b style="color:#ff9fb3">${esc(x.to)}</b></td></tr>`)}
    ${sec("Line moves", C.lines, ["Game", "Line", "From", "To", "Move"], x => `<tr><td><b>${esc(x.game)}</b></td><td>${esc(x.k)}</td><td>${x.from}</td><td>${x.to}</td><td>${mvc(x.d)}</td></tr>`)}
    ${sec("Projection moves (half a point or more)", C.proj, ["Player", "Team", "Pos", "Source", "From", "To", "Move"], x => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.team)}</td><td>${esc(x.pos)}</td><td>${esc(x.src)}</td><td>${f1(x.from)}</td><td>${f1(x.to)}</td><td>${mvc(x.d)}</td></tr>`)}
    ${sec("Ownership moves (2 points or more)", C.own, ["Player", "Team", "Pos", "Source", "From", "To", "Move"], x => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.team)}</td><td>${esc(x.pos)}</td><td>${esc(x.src)}</td><td>${pc(x.from)}</td><td>${pc(x.to)}</td><td>${mvc(x.d)}</td></tr>`)}`;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Every Refresh (and the hourly game-day pull) snapshots the merged table. Mark as built in the Entry Manager (Simulator) when your lineups are set, so this diffs against that moment.</span></div>`;
}
/* ---------------- notes ---------------- */
// ETR reports (NFL classic): a dropdown of the week's ETR articles + Establish The Show / The Million, plus the user's optional
// Blick slate thoughts. Green = read into this slate's guide, red = not read yet or failed. Read the checked ones or all at once;
// one Claude run (bench/read-etr-week.prompt.md) merges them into data/<slate>/slate-guide.json. Only this box re-renders while it runs.
const weeklyOK = () => !!(S.hub && S.hub.slate && /nfl/i.test(S.hub.dir || ""));
async function loadReads(force) { const d = S.hub.dir; if (!force && S.etr && S.etr.dir === d) return; try { S.etr = Object.assign(await api(`/api/etr-reads?dir=${encodeURIComponent(d)}`), { dir: d }); } catch { S.etr = { dir: d, catalog: [], reads: {}, blick: { text: "", images: [] } }; } if (!S.etrSel || S.etrSel.dir !== d) S.etrSel = Object.assign(new Set(), { dir: d }); }
const unread = () => (S.etr ? S.etr.catalog : []).filter(c => (!c.upload || hasBlick()) && (S.etr.reads[c.id] || {}).status !== "ok").map(c => c.id);
const hasBlick = () => !!(S.etr && S.etr.blick && (S.etr.blick.text.trim() || S.etr.blick.images.length));
function weekBox() {
  const E = S.etr || { catalog: [], reads: {} }, p = S.pull && S.pull.kind === "weekly" && S.pull.dir === S.hub.dir ? S.pull : null, run = !!(p && pulling()), busy = pulling();
  const counted = E.catalog.filter(c => !c.upload || hasBlick() || E.reads[c.id]), ok = counted.filter(c => (E.reads[c.id] || {}).status === "ok").length, sel = S.etrSel || new Set();
  const GREEN = "var(--green,#3ddc84)", RED = "var(--red,#ff4d6d)";
  const row = c => { const r = E.reads[c.id], g = !!(r && r.status === "ok"), picked = run && p.only ? p.only.includes(c.id) : sel.has(c.id);
    const tip = r ? `${g ? "Read" : "Failed"} ${when(r.at)}${r.title ? ` · ${r.title}` : ""}${r.note ? ` · ${r.note}` : ""}` : c.upload ? (hasBlick() ? "Uploaded, not read into the guide yet" : "Nothing uploaded yet") : "Not read yet";
    return `<div class="er" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" data-er="${c.id}"${picked ? " checked" : ""}${busy ? " disabled" : ""}><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${g ? GREEN : RED};box-shadow:0 0 6px ${g ? GREEN : RED}"></span><span>${esc(c.name)}</span></label><span class="hint">${esc(tip)}</span>${r && r.url && r.url !== "#" ? `<a class="hint" href="${esc(r.url)}" target="_blank">open</a>` : ""}${(E.digests || []).includes(c.id) ? `<a class="hint" href="data/${esc(S.hub.dir)}/reads/${esc(c.id)}.md" target="_blank" title="what the Brain reads from this report">takeaways</a>` : ""}</div>${c.upload ? `<div style="margin:2px 0 6px 26px"><textarea class="txt" id="blickText" placeholder="Paste Blick's slate thoughts (Discord, notes). Saves as you type." style="width:100%;min-height:90px;font-family:inherit;font-size:12px">${esc((E.blick || {}).text || "")}</textarea><label class="drop sm" id="blickDrop" style="margin-top:6px">Drop Blick screenshots <input type="file" id="blickFile" accept="image/*" multiple></label><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${((E.blick || {}).images || []).map(s => `<a href="${esc(s)}" target="_blank"><img src="${esc(s)}" style="max-width:140px;max-height:100px;border:1px solid var(--line2);border-radius:4px"></a>`).join("")}</div></div>` : ""}`; };
  const status = run ? `Reading ${p.total ? `<b>${p.read || 0}/${p.total}</b> ` : ""}${esc(String(p.message || "").replace(/^\d+\/\d+:\s*/, ""))}` : p ? `Last run ${when(p.updated || p.at)}: ${esc(p.message || p.status)}${p.cost ? ` · $${(+p.cost).toFixed(2)}` : ""}` : "";
  return `<details id="erDet"${S.etrOpen ? " open" : ""} style="border:1px solid var(--line2);border-radius:6px;padding:8px 12px">
    <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b>ETR reports</b><span class="hint"><b style="color:${ok && ok === counted.length ? GREEN : "inherit"}">${ok}/${counted.length}</b> read into the guide</span>
      <button class="btn sec" id="erSel"${busy || !sel.size ? " disabled" : ""}>Read selected${sel.size ? ` (${sel.size})` : ""}</button><button class="btn sec" id="erNew"${busy || !unread().length ? " disabled" : ""} title="Every report that is still red (not read yet or failed), plus your Blick thoughts if uploaded and not read">Read unread${unread().length ? ` (${unread().length})` : ""}</button><button class="btn sec" id="erAll"${busy ? " disabled" : ""} title="Every ETR report, plus your Blick thoughts if you uploaded any">Read all</button><span class="hint">${status}</span></summary>
    <div style="margin-top:8px;display:grid;gap:4px">${E.catalog.map(row).join("")}</div>
    <div class="hint" style="margin-top:8px">One Claude run in your logged-in Chrome reads what you pick and merges it into the slate guide (Simulator notes and the Brain). Shows have to be up on YouTube. All of them takes up to 45 minutes and a few dollars.</div></details>`;
}
async function startRead(ids) { try { S.pull = await api("/api/pull-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: S.hub.dir, kind: "weekly", only: ids }) }); setMsg(`Asked Claude to read ${ids.length} report${ids.length > 1 ? "s" : ""}; this updates as it works`); paintWeek(); watchPull(); } catch (e) { setMsg("Could not file the request: " + e.message, true); } }
function paintWeek() { const b = $("#weekBox"); if (!b) return; b.innerHTML = weekBox(); wireWeek(); }
function wireWeek() {
  const det = $("#erDet"); if (!det) return; det.addEventListener("toggle", () => { S.etrOpen = det.open; });
  $$("[data-er]").forEach(c => c.addEventListener("change", e => { const id = e.target.dataset.er; if (e.target.checked) S.etrSel.add(id); else S.etrSel.delete(id); paintWeek(); }));
  const bs = $("#erSel"); if (bs) bs.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); startRead([...S.etrSel]); });
  const bn = $("#erNew"); if (bn) bn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); startRead(unread()); });
  const ba = $("#erAll"); if (ba) ba.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); startRead(S.etr.catalog.filter(c => !c.upload || hasBlick()).map(c => c.id)); });
  const bt = $("#blickText"); let t = null; if (bt) bt.addEventListener("input", e => { S.etr.blick.text = e.target.value; clearTimeout(t); t = setTimeout(async () => { try { await fetch(`/api/blick-thoughts?dir=${encodeURIComponent(S.hub.dir)}`, { method: "POST", body: S.etr.blick.text }); setMsg("Blick thoughts saved"); } catch { setMsg("Blick thoughts not saved", true); } }, 600); });
  const up = async f => { try { const r = await api(`/api/blick-image?dir=${encodeURIComponent(S.hub.dir)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.arrayBuffer() }); S.etr.blick.images.push(r.path); paintWeek(); } catch (e) { setMsg("Image not saved: " + e.message, true); } };
  const bf = $("#blickFile"); if (bf) bf.addEventListener("change", async e => { for (const f of Array.from(e.target.files || [])) await up(f); });
  const z = $("#blickDrop"); if (z) { ["dragenter", "dragover"].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add("over"); })); ["dragleave", "drop"].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove("over"); })); z.addEventListener("drop", async e => { for (const f of Array.from(e.dataTransfer.files || [])) await up(f); }); }
}
// Lab likes (server/likes.mjs): a few players per position from projection, value, leverage and ETR's DvP / XFP / PROE
// tables, with the reasons; unfitted, scored after each slate by bench/likes-tracker-nfl.mjs
async function loadLikesUI(force) { const d = S.hub.dir; if (!force && S.likes && S.likes.dir === d) return; try { S.likes = Object.assign(await api(`/api/likes?dir=${encodeURIComponent(d)}`, force ? { method: "POST" } : undefined), { dir: d }); } catch (e) { S.likes = { dir: d, error: e.message }; }
  // Lab stacks (server/stacks.mjs): from the slate's generated field + sim and Blick's conditional ownership
  try { S.stacks = await api(`/api/stacks?dir=${encodeURIComponent(d)}`, force ? { method: "POST" } : undefined); } catch (e) { S.stacks = { error: e.message }; } }
function stacksBox() {
  const T = S.stacks; if (!T) return "";
  if (T.error) return `<div class="hint">Lab stacks: ${esc(T.error)}</div>`;
  const GREEN = "var(--green,#3ddc84)", RED = "var(--red,#ff4d6d)", CYAN = "var(--cyan,#22d3ee)";
  const card = (title, sub, reasons, color) => `<div style="border:1px solid var(--line2);border-left:3px solid ${color};border-radius:5px;padding:6px 9px"><div><b>${esc(title)}</b> <span class="hint">${esc(sub)}</span></div><ul style="margin:4px 0 0 16px;padding:0">${reasons.map(r => `<li class="hint" style="margin:1px 0">${esc(r)}</li>`).join("")}</ul></div>`;
  let body = "";
  if (T.format === "showdown") {
    body = `<div><div style="margin-bottom:4px"><b>Sides</b></div><div style="display:grid;gap:6px">${(T.sides || []).slice(0, 4).map(x => card(x.side, `sim top-1% ${x.t1x}x`, [x.reason], CYAN)).join("")}</div></div>
      <div><div style="margin-bottom:4px"><b>Captain + bring-back</b></div><div style="display:grid;gap:6px">${(T.pairs || []).map(p => card(`CPT ${p.cpt} + ${p.with}`, `score ${p.score}`, [p.reason], GREEN)).join("")}</div></div>`;
  } else {
    body = `<div><div style="margin-bottom:4px"><b>Top stacks</b></div><div style="display:grid;gap:6px">${(T.top || []).map(x => card(`${x.qb} + ${x.catchers.join(" + ")}${x.bringBack ? ` · bring back ${x.bringBack.name}` : ""}`, `score ${x.score}`, x.reasons, GREEN)).join("")}</div></div>
      <div><div style="margin-bottom:4px"><b>Bring-back by QB</b></div><div style="display:grid;gap:6px">${(T.byQB || []).map(b => card(`${b.qb} → ${b.bringBack}`, `${b.own ?? "?"}% owned · with ${b.stack.join(" + ")}`, [b.reason], CYAN)).join("")}</div></div>
      ${(T.avoid || []).length ? `<div><div style="margin-bottom:4px"><b style="color:${RED}">Avoid</b></div><div style="display:grid;gap:6px">${T.avoid.map(a => card(`${a.qb} + ${a.catchers.join(" + ")}`, `${a.freq}% of field`, a.reasons, RED)).join("")}</div></div>` : ""}`;
  }
  return `<details id="stDet"${S.stacksOpen !== false ? " open" : ""} style="border:1px solid var(--line2);border-radius:6px;padding:8px 12px;margin-bottom:10px">
    <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b>Lab stacks</b><span class="hint">built ${when(T.generatedAt)} · sim ${esc(T.sim && T.sim.contest || "generated field")}${T.blick ? ` · Blick conditional: ${esc(T.blick.contest)} (${esc(T.blick.built)})` : " · no Blick conditional for this slate"}</span></summary>
    <div style="margin-top:8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">${body}</div>
    <div class="hint" style="margin-top:8px">${esc(T.method || "")}</div></details>`;
}
function likesBox() {
  const L = S.likes; if (!L) return "";
  if (L.error) return `<div class="hint" style="padding:0 16px 12px">Lab likes unavailable: ${esc(L.error)}</div>`;
  const GREEN = "var(--green,#3ddc84)", RED = "var(--red,#ff4d6d)";
  const card = (p, bad) => `<div style="border:1px solid var(--line2);border-left:3px solid ${bad ? RED : GREEN};border-radius:5px;padding:6px 9px"><div><b>${esc(p.name)}</b> <span class="hint">${esc(p.team)} vs ${esc(p.opp || "")} · ${p.sal} · proj ${p.proj} · ${p.cptOwn != null ? `CPT own ${p.cptOwn}% · ` : ""}own ${p.own ?? "?"}% · score ${p.score}</span></div><ul style="margin:4px 0 0 16px;padding:0">${(p.reasons || []).map(r => `<li class="hint" style="margin:1px 0">${esc(r)}</li>`).join("")}</ul></div>`;
  const groups = Object.entries(L.picks || {}).map(([pos, l]) => `<div><div style="margin-bottom:4px"><b>${esc(pos === "CPT" ? "Captain" : pos === "FLEX" ? "Flex values" : pos)}</b></div><div style="display:grid;gap:6px">${l.map(p => card(p)).join("")}</div></div>`).join("");
  const fades = (L.fades || []).length ? `<div><div style="margin-bottom:4px"><b style="color:${RED}">Fades</b> <span class="hint">chalk with bad signals</span></div><div style="display:grid;gap:6px">${L.fades.map(p => card(p, true)).join("")}</div></div>` : "";
  const inp = L.inputs || {};
  return `<div style="padding:0 16px 12px">${stacksBox()}<details id="lkDet"${S.likesOpen !== false ? " open" : ""} style="border:1px solid var(--line2);border-radius:6px;padding:8px 12px">
    <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b>Lab likes</b><span class="hint">built ${when(L.generatedAt)} · DvP: ${esc(inp.dvp || "-")} · XFP: ${esc(inp.xfp || "-")} · PROE: ${esc(inp.proe || "-")}</span><button class="btn sec" id="lkRe">Rebuild</button></summary>
    <div style="margin-top:8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">${groups}${fades}</div>
    <div class="hint" style="margin-top:8px">${esc(L.method || "")}</div></details></div>`;
}
function wireLikes() {
  const det = $("#lkDet"); if (det) det.addEventListener("toggle", () => { S.likesOpen = det.open; });
  const sdt = $("#stDet"); if (sdt) sdt.addEventListener("toggle", () => { S.stacksOpen = sdt.open; });
  const b = $("#lkRe"); if (b) b.addEventListener("click", async e => { e.preventDefault(); e.stopPropagation(); b.disabled = true; await loadLikesUI(true); const box = $("#likesBox"); if (box) { box.innerHTML = likesBox(); wireLikes(); } setMsg("Lab likes rebuilt"); });
}
async function renderNotes(main) {
  const H = S.hub;
  // NFL (classic and showdown): the Notes tab is the ETR reports dropdown (Blick thoughts live in it); notes saved the old way
  // stay visible, read-only, below it. Other leagues keep the free notes box.
  // NFL classic sub-slates (Early Only, Afternoon, Primetime, Sun-Mon, Thu-Mon): no reads of their own; the server builds their
  // guide from the Main slate's (filtered to their games) plus the showdown guides of prime-time games (server/subguide.mjs)
  if (weeklyOK() && H.slate.type !== "SHOWDOWN" && !/-main$/.test(H.dir)) {
    let g = null; try { g = await api(`/api/guide?dir=${encodeURIComponent(H.dir)}`); } catch {}
    const own = g && g.theses && !g.derived, from = (g && g.from) || [];
    const reads = await Promise.all(from.map(async d => { try { const r = await api(`/api/etr-reads?dir=${encodeURIComponent(d)}`); const c = r.catalog.filter(x => !x.upload || r.reads[x.id]); return { d, ok: c.filter(x => (r.reads[x.id] || {}).status === "ok").length, n: c.length }; } catch { return { d, ok: 0, n: 0 }; } }));
    const GREEN = "var(--green,#3ddc84)", RED = "var(--red,#ff4d6d)", dot = on => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${on ? GREEN : RED};box-shadow:0 0 6px ${on ? GREEN : RED}"></span>`;
    main.innerHTML = `<div style="padding:12px 16px"><div style="border:1px solid var(--line2);border-radius:6px;padding:10px 12px;display:grid;gap:8px">
      <div><b>Slate guide</b> <span class="hint">${own ? "this slate has its own guide" : g && g.derived ? `built from the guides below, filtered to this slate's ${(H.slate.games || []).length} games: <b>${g.theses.length}</b> theses, <b>${Object.keys(g.stances).length}</b> player stances, <b>${g.notes.length}</b> notes` : "no Main slate guide for this week yet"}</span></div>
      ${reads.map(x => `<div style="display:flex;align-items:center;gap:8px">${dot(x.n && x.ok === x.n)}<span>${esc(x.d)}</span><span class="hint">${x.ok}/${x.n} reports read</span><button class="btn sec" data-goslate="${esc(x.d)}">Open it</button></div>`).join("")}
      <div class="hint">Read ETR reports on the Main slate (and on each prime-time showdown slate); this slate picks them up automatically. Games here not on the Main slate only get notes from their showdown guide.</div></div></div>`;
    await loadLikesUI(); main.insertAdjacentHTML("beforeend", `<div id="likesBox">${likesBox()}</div>`); wireLikes();
    $("#bot").innerHTML = `<div class="bot"><span class="hint">Guide is computed from ${esc(from.join(" + ") || "nothing yet")}.</span></div>`;
    $$("[data-goslate]").forEach(b => b.addEventListener("click", async () => { S.dir = b.dataset.goslate; const d = S.dirs.find(x => x.dir === S.dir); if (d && d.slateId) S.slateId = d.slateId; if (S.dir.slice(0, 10) !== S.date) { S.date = S.dir.slice(0, 10); await loadSlates(); } await loadHub(); persist(); render(); }));
    return;
  }
  if (weeklyOK()) { await loadReads(); if (S.etrOpen === undefined) S.etrOpen = true;
    if (!S.notes || S.notes.dir !== H.dir) { try { S.notes = Object.assign(await api(`/api/notes?dir=${encodeURIComponent(H.dir)}`), { dir: H.dir }); } catch (e) { S.notes = { text: "", images: [], dir: H.dir }; } }
    const old = S.notes.text.trim() || S.notes.images.length ? `<div style="padding:0 16px 12px"><div class="hint" style="margin-bottom:6px">Earlier notes on this slate (saved before the report list; the Brain still reads them)</div><pre class="txt" style="display:block;width:100%;box-sizing:border-box;white-space:pre-wrap;font-family:inherit;font-size:12px;padding:10px;margin:0">${esc(S.notes.text)}</pre>${S.notes.images.map(p => `<a href="${esc(p)}" target="_blank"><img src="${esc(p)}" style="max-width:180px;max-height:120px;margin:6px 6px 0 0;border:1px solid var(--line2);border-radius:4px"></a>`).join("")}</div>` : "";
    await loadLikesUI(); await loadMyReads();
    main.innerHTML = `<div id="weekBox" style="padding:12px 16px">${weekBox()}</div>${myReadsBox()}<div id="likesBox">${likesBox()}</div>${old}`; wireLikes(); wireMyReads(); $("#bot").innerHTML = `<div class="bot"><span class="hint">Feeds data/${esc(H.dir)}/slate-guide.json; Blick thoughts in blick-thoughts.md and blick/.</span></div>`; wireWeek(); return; }
  if (!S.notes || S.notes.dir !== H.dir) { try { S.notes = Object.assign(await api(`/api/notes?dir=${encodeURIComponent(H.dir)}`), { dir: H.dir }); } catch (e) { S.notes = { text: "", images: [], dir: H.dir }; } }
  main.innerHTML = `${weeklyOK() ? `<div id="weekBox" style="padding:12px 16px 0">${weekBox()}</div>` : ""}<div style="padding:12px 16px;display:grid;grid-template-columns:1fr 1fr;gap:14px" class="notesgrid"><div><div class="hint" style="margin-bottom:6px">Slate notes: Blick's reads, your own, what you want to remember in the review. Saves as you type.</div><textarea class="txt" id="notesText" style="width:100%;min-height:50vh;font-family:inherit;font-size:12.5px">${esc(S.notes.text)}</textarea></div>
    <div><label class="drop" id="imgDrop">Drop screenshots here (Discord, ETR, anything) <input type="file" id="imgFile" accept="image/*" multiple></label><div id="imgs" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">${S.notes.images.map(p => `<a href="${esc(p)}" target="_blank"><img src="${esc(p)}" style="max-width:220px;max-height:160px;border:1px solid var(--line2);border-radius:4px"></a>`).join("")}</div></div></div>`;
  await loadMyReads(); main.insertAdjacentHTML("afterbegin", myReadsBox()); wireMyReads();
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Stored in data/${esc(H.dir)}/notes.md and notes/; your reads in my-reads.txt.</span></div>`;
  wireWeek();
  let t = null; $("#notesText").addEventListener("input", e => { S.notes.text = e.target.value; clearTimeout(t); t = setTimeout(async () => { try { await fetch(`/api/notes?dir=${encodeURIComponent(H.dir)}`, { method: "POST", body: S.notes.text }); setMsg("Notes saved"); } catch (err) { setMsg("Notes not saved", true); } }, 600); });
  const up = async f => { try { const r = await api(`/api/notes-image?dir=${encodeURIComponent(H.dir)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.arrayBuffer() }); S.notes.images.push(r.path); render(); } catch (e) { setMsg("Image not saved: " + e.message, true); } };
  $("#imgFile").addEventListener("change", async e => { for (const f of Array.from(e.target.files || [])) await up(f); });
  const z = $("#imgDrop"); ["dragenter", "dragover"].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add("over"); })); ["dragleave", "drop"].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove("over"); })); z.addEventListener("drop", async e => { for (const f of Array.from(e.dataTransfer.files || [])) await up(f); });
}

// your own player reads: work with no Claude read at all (they fill the slate guide's stances; server/entries.mjs parseReads)
async function loadMyReads() { const H = S.hub; if (!S.myReads || S.myReads.dir !== H.dir) { try { S.myReads = Object.assign(await api(`/api/my-reads?dir=${encodeURIComponent(H.dir)}`), { dir: H.dir }); } catch { S.myReads = { text: "", count: 0, bad: [], dir: S.hub.dir }; } } }
function myReadsBox() {
  const R = S.myReads || { text: "", count: 0, bad: [] };
  return `<div style="padding:12px 16px"><div class="hint" style="margin-bottom:6px">Your reads, one player per line: <b>Name like: why</b>, <b>Name fade: why</b> (also core, value, leverage, dart, caution), or <b>+Name: why</b> / <b>-Name: why</b>. They count in the notes columns and the grade over ETR's, and need no Claude. Saves as you type.</div>
    <textarea class="txt" id="myReads" rows="6" style="width:100%;box-sizing:border-box" placeholder="Bijan Robinson like: cheap for his usage&#10;-Ja'Marr Chase: chalk in a bad spot">${esc(R.text)}</textarea>
    <div class="hint" id="myReadsN">${R.count} read${R.count === 1 ? "" : "s"}${R.bad.length ? ` · not understood: ${esc(R.bad.slice(0, 3).join(" | "))}` : ""}</div></div>`;
}
function wireMyReads() {
  const el = $("#myReads"); if (!el) return; let t = null;
  el.addEventListener("input", e => { const H = S.hub; S.myReads.text = e.target.value; clearTimeout(t); t = setTimeout(async () => { try { const r = await api(`/api/my-reads?dir=${encodeURIComponent(H.dir)}`, { method: "POST", body: S.myReads.text }); Object.assign(S.myReads, r); const n = $("#myReadsN"); if (n) n.innerHTML = `${r.count} read${r.count === 1 ? "" : "s"}${r.bad.length ? ` · not understood: ${esc(r.bad.slice(0, 3).join(" | "))}` : ""}`; if (S.sim) S.sim.data = null; setMsg("Reads saved"); } catch (err) { setMsg("Reads not saved: " + err.message, true); } }, 600); });
}

/* ---------------- boot ---------------- */
(async () => {
  try { await loadDirs(); await loadHub(); render(); if (!S.hub) setMsg("Pick a slate and Refresh"); await loadSlates(); render();
    try { S.pull = await api("/api/pull-request"); if (/pending|working/.test(S.pull.status)) { render(); watchPull(); } } catch {} }
  catch (e) { $("#app").innerHTML = `<div class="empty">Hub server not reachable<small>${esc(e.message)} — start it with <code>node server/hub.mjs</code> and open http://localhost:8787</small></div>`; }
})();
