// Slate Lab — Data Hub, Contest Generator, Pre-Contest Simulator, Review.
import { parseCSV, nrm, num } from "../engine/csv.mjs";
import { FORMATS, detect, autoMap, buildPool, FIELDS } from "../engine/formats.mjs";
import { sigOf, salOf, projOf, ownSum, stackOf, stackTeams, matchLineups, overlap } from "../engine/lineups.mjs";
import { fitPayouts, parsePayoutTable, paidCount, payoutSum } from "../engine/payouts.mjs";
import { buildLineups } from "../engine/build.mjs";
import { stkSlates, stkUpdateInfo, stkProjections, stkToCSV, stkTime, stkEastern, hhmm } from "../engine/stokastic.mjs";
import { featurize, selectScore, gradeRules, DEFAULT_RULE } from "../engine/select.mjs";
import { recoverContest } from "../engine/recover.mjs";
import { fieldProfile } from "../engine/field.mjs";
import { sigmaFor } from "../engine/model.mjs";
import { $, $$, esc, copyText, readFile, download } from "./ui.mjs";
import * as store from "./store.mjs";

/* ================= state ================= */
const STACK_TYPES = ["5-3", "5-2-1", "5-x", "4-4", "4-3-1", "4-2-x", "4-x", "3-3-x"];
// MLB stack mix measured from seven real DK main-slate fields, 2026-09-06 to 09-12 ($67K-$350K contests).
const STACK_DEF = { "5-3": 23, "5-2-1": 29, "5-x": 11, "4-4": 4, "4-3-1": 8, "4-2-x": 5, "4-x": 2, "3-3-x": 3 };
const NFL_DEF = { 1: 45, 2: 25, 3: 5, bring: 25 };
// CFB stack shares measured on 74 pulled DK fields (bench, 2026-09-18); the superflex second QB is handled by the generator
// college stack shares follow the slate size (see src/engine/field.mjs)
const cfbDefFor = g => g <= 2 ? { 1: 7, 2: 50, 3: 43, bring: 85 } : g <= 5 ? { 1: 23, 2: 54, 3: 20, bring: 59 } : g <= 9 ? { 1: 45, 2: 41, 3: 7, bring: 45 } : { 1: 51, 2: 31, 3: 3, bring: 42 };
const stackDef = () => F().sport === "cfb" ? cfbDefFor(S.pool ? S.pool.games.length : 12) : NFL_DEF;
// Marquee conc 1.0 is the graded default (src/engine/field.mjs); the other two bracket it
// How tough the opponents are is set by what the contest costs, fitted on 200 pulled college
// contests (fieldProfile in src/engine/field.mjs). Sports without a fitted curve keep the old
// three-preset spread, now read off the same price ramp instead of a slider position.
const ARCH = [{ conc: 0.85, minSal: 47500, boost: 0.6 }, { conc: 1.0, minSal: 49000, boost: 1.0 }, { conc: 1.25, minSal: 49300, boost: 1.5 }];
const archFor = fee => {
  const f = +fee || 0, p = fieldProfile(fee, F().key);
  // college has a fitted curve, graded with the middle preset s boost; the other sports keep the
  // three presets the slider used to pick, now chosen by price instead of by slider position
  return p ? Object.assign({}, ARCH[1], p) : (f < 10 ? ARCH[0] : f < 50 ? ARCH[1] : ARCH[2]);
};
const feeLabel = fee => { const f = +fee || 0; return f < 10 ? "soft field" : f < 50 ? "mixed field" : "sharp field"; };
const S = {
  view: "hub", league: store.get("league", "mlb"), type: store.get("type", "classic"), stk: store.get("stk", { slates: [], slateId: null, proj: null, own: null, checked: null, loadedProj: null }),
  projText: store.get("projText", ""), projName: store.get("projName", ""), projWhen: store.get("projWhen", ""), tsWhen: store.get("tsWhen", ""), tsText: store.get("tsText", ""),
  pool: null, share: null, mapOverride: null,
  contest: null, LU: [], luSource: "", fieldMode: false, res: null, favs: new Set(), favOrder: [],
  dk: { entries: [], ids: {}, name: "", dupes: true, sort: "fee" }, gate: store.get("gate", 50),
  cfg: Object.assign({
    pool: 500, pct: 10, payMode: "pct", entries: 500, fee: 20, payText: "", rake: 15,
    conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3, seed: 1, stacks: Object.assign({}, STACK_DEF),
    wP: 50, wO: 50, n: 20, obj: "blend", rand: 18, maxExp: 60, bMinSal: 0, minUniq: 1, stackSize: 0, force: "", exclude: "",
    iters: 5000, simSeed: 1, rvDate: new Date().toISOString().slice(0, 10), rvName: "", uniques: 0
  }, store.get("cfg", {}), (s => s && JSON.stringify(s) === JSON.stringify({ "5-3": 17, "5-2-1": 25, "5-x": 15, "4-4": 5, "4-3-1": 10, "4-2-x": 0, "4-x": 10, "3-3-x": 2 }) ? { stacks: Object.assign({}, STACK_DEF) } : {})(store.get("cfg", {}).stacks)),   // saved copies of the old default move to the measured mix
  teamCtl: { removed: {}, boost: {} }, boosts: {}, plCap: {}, plBoost: {},
  filt: { q: "", pos: "ALL", projMin: "", projMax: "", ownMin: "", ownMax: "", salMin: "", types: {}, incl: "", excl: "" },
  tab: { hub: "proj", gen: "players", sim: "proj", review: "grade" },
  ts: {}, review: { files: {}, result: null, history: store.get("reviewHistory", []) },
  busy: null, modal: null, pop: null, stackExpo: false, ctlOpen: true
};
const fkey = () => S.league === "nfl" ? (S.type === "showdown" ? "nfl_sd" : "nfl_cl") : S.league === "cfb" ? "cfb_cl" : "mlb_cl";
const F = () => FORMATS[fkey()];
// "DK_MLB_Main_Data_Hub_Projections.csv" -> "MLB Main slate"; "DK_NFL_Early_..." -> "NFL Early slate"
function slateLabel(name) {
  const s = String(name || "");
  const m = s.match(/DK_(MLB|NFL|NBA|NHL)_(.+?)_Data_Hub/i);
  if (m) return m[1].toUpperCase() + " " + m[2].replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + " slate";
  const e = s.match(/DraftKings\s+(MLB|NFL|NBA|NHL)\s+DFS\s+Projections\s*-+\s*(.+?)(\.csv)?$/i);
  if (e) return e[1].toUpperCase() + " " + e[2].trim().replace(/\bslate\b/i, "").trim() + " slate";
  return s.replace(/\.csv$/i, "");
}
function slateBar() {
  const p = S.pool, ts = S.share, nP = p ? p.players.filter(x => x.own > 0).length : 0;
  const a = p ? `<span class="ok">✓</span> <b>Projections</b> ${esc(slateLabel(S.projName))} · ${esc(p.src)} · ${p.players.length.toLocaleString()} players (${nP} with ownership) · ${p.games.length} game${p.games.length === 1 ? "" : "s"} · loaded ${esc(S.projWhen || "earlier")}` : `<span class="warn">!</span> <b>Projections</b> none loaded`;
  const b = F().sport === "mlb" ? (ts ? `<span class="ok">✓</span> <b>Top stacks</b> ${Object.keys(ts).length} teams · loaded ${esc(S.tsWhen || "earlier")}` : `<span class="warn">!</span> <b>Top stacks</b> none loaded — stack teams will follow hitter ownership`) : "";
  const c = S.contest ? `<span class="ok">✓</span> <b>Contest</b> ${S.contest.N.toLocaleString()} entries · generated ${esc(S.contest.when)}` : `<span class="warn">!</span> <b>Contest</b> not generated yet`;
  return `<div class="slatebar"><span>${a}</span>${b ? `<span>${b}</span>` : ""}<span>${c}</span></div>`;
}
const saveCfg = () => store.set("cfg", S.cfg);
const ts = k => S.ts[k] || (S.ts[k] = { sort: null, page: 0, per: 100 });
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const fmt = (v, d = 1) => v == null || isNaN(v) ? "—" : (+v).toFixed(d);
const pctS = (v, d = 1) => v == null || isNaN(v) ? "—" : (+v).toFixed(d) + "%";
// Showdown stack column, Stokastic style: "AWAY n | HOME n", every roster spot counted.
// Away/home comes from the projections' opponent column ("@DAL"); otherwise alphabetical.
function sdStack(lu, P) {
  const pool = S.pool, tc = {}; for (const id of lu) { const t = P[id].team; if (t) tc[t] = (tc[t] || 0) + 1; }
  const order = pool.away && pool.home ? [pool.away, pool.home] : pool.teams.slice(0, 2);
  return order.map(t => `${t} ${tc[t] || 0}`).join(" | ");
}
// ROI with its standard error: "+12.3% ±4"
const roiCell = r => pctS(r.roi) + (r.se != null ? ` <span class="hint" title="standard error of the simulated ROI">±${r.se.toFixed(0)}</span>` : "");
const money = v => v == null || isNaN(v) ? "—" : "$" + Math.round(v).toLocaleString();
const diffS = v => v == null || isNaN(v) ? "—" : `<span class="${v >= 0 ? "diffpos" : "diffneg"}">${v >= 0 ? "" : ""}${(+v).toFixed(1)}%</span>`;
const nameCell = p => { const parts = p.name.split(" "); const first = parts.shift(); const badge = p.isP ? '<span class="badge p">P</span>' : (p.ord ? `<span class="badge o">${p.ord}</span>` : ""); return `<span class="pname"><span class="first">${esc(first)}</span> ${esc(parts.join(" "))}</span>${badge}`; };
const teamCell = t => `<span class="tm"><i></i>${esc(t || "?")}</span>`;
const luCell = (l, P, f) => `<div class="lu">${l.map((id, j) => { const p = P[id]; return `<span class="ps">${f.mult && j === 0 ? "CPT" : esc(p.posList[0])}</span><b>${esc(p.name)}</b>`; }).join('<span class="sep">|</span>')}</div>`;

/* ================= worker ================= */
let worker = null, jobId = 0; const jobs = {};
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  worker.onmessage = e => { const m = e.data, j = jobs[m.id]; if (!j) return;
    if (m.type === "log") j.onLog && j.onLog(m.line); else if (m.type === "progress") j.onProgress && j.onProgress(m.done, m.total);
    else if (m.type === "done") { delete jobs[m.id]; j.resolve(m.result); } else if (m.type === "error") { delete jobs[m.id]; j.reject(new Error(m.message)); } };
  worker.onerror = e => { for (const id in jobs) { jobs[id].reject(new Error(e.message || "worker error")); delete jobs[id]; } };
  return worker;
}
const runJob = (msg, hooks = {}) => new Promise((resolve, reject) => { const id = ++jobId; jobs[id] = Object.assign({ resolve, reject }, hooks); getWorker().postMessage(Object.assign({ id }, msg)); });
const poolMsg = pool => ({ players: pool.players, teams: pool.teams, games: pool.games, src: pool.src, format: pool.format });

/* ================= data ================= */
function loadProjections(text, name, silent) {
  const rows = parseCSV(text); if (rows.length < 2) return setStatus("That file has no rows.", true);
  const headers = rows[0].map(s => String(s).trim());
  try {
    const map = S.mapOverride && S.mapOverride.name === name ? S.mapOverride.map : autoMap(headers);
    S.pool = buildPool(headers, rows.slice(1), fkey(), map);
    Object.assign(S.pool, { headers, rows: rows.slice(1), map, name: name || "" });
    S.projText = text; S.projName = name || ""; if (!silent) { S.projWhen = new Date().toLocaleString(); store.set("projWhen", S.projWhen); }
    store.set("projText", text); store.set("projName", S.projName);
    S.contest = null; S.res = null; S.LU = []; S.favs = new Set(); S.favOrder = []; S.boosts = {};
    if (!silent) { S.dk = { entries: [], ids: {}, name: "", dupes: true, sort: "fee" }; S.teamCtl = { removed: {}, boost: {} }; S.luSource = ""; }
    if (S.tsText) loadTopstacks(S.tsText, true);
    // top stacks from another slate or sport do not apply here
    if (S.share && !Object.keys(S.share).some(t => S.pool.teams.includes(t))) { S.share = null; S.tsText = ""; S.tsRows = null; S.tsWhen = ""; store.del("tsText"); store.del("tsWhen"); }
    if (!silent) setStatus(`${S.pool.players.length} players · ${S.pool.teams.length} teams · ${S.pool.games.length} game${S.pool.games.length === 1 ? "" : "s"} · ${detect(headers) || "custom layout, auto-mapped"}`);
  } catch (e) { S.pool = null; setStatus(e.message, true); }
}
function loadTopstacks(text, silent) {
  const rows = parseCSV(text); if (rows.length < 2) return;
  const h = rows[0].map(s => String(s).toLowerCase().trim()), ti = h.indexOf("team"), si = h.findIndex(x => x.includes("top stack"));
  if (ti < 0 || si < 0) { if (!silent) setStatus("Top stacks file not recognised (needs Team and Top Stack % columns).", true); return; }
  const share = {}, rowsOut = []; rows.slice(1).forEach(r => { const t = String(r[ti] || "").trim().toUpperCase(); const v = num(r[si]); if (t && v != null) { share[t] = v; rowsOut.push(r); } });
  S.share = share; S.tsText = text; S.tsRows = { h: rows[0], rows: rowsOut }; store.set("tsText", text);
  if (!silent) { S.tsWhen = new Date().toLocaleString(); store.set("tsWhen", S.tsWhen); setStatus(`Top stacks loaded for ${Object.keys(share).length} teams.`); }
}
function loadLineupsCSV(text, name) {
  if (!S.pool) return;
  const rows = parseCSV(text); if (!rows.length) return;
  const f = F(), first = rows[0].map(s => String(s).trim().toUpperCase());
  const hdrLike = first.every(x => /^(CPT|CAPTAIN|FLEX|QB|RB|WR|TE|DST|P|C|1B|2B|3B|SS|OF|UTIL)$/.test(x));
  let body = hdrLike ? rows.slice(1) : rows;
  if (!hdrLike) { const hi = rows[0].map(s => String(s).trim().toUpperCase()); const start = hi.findIndex((x, i) => x === f.slots[0] && hi[i + 1] === f.slots[1]); if (start >= 0) body = rows.slice(1).map(r => r.slice(start, start + f.slots.length)); }
  const m = matchLineups(body, S.pool.players, f);
  S.LU = m.lineups; S.luSource = name || "Lineup file"; S.fieldMode = false; S.res = null; S.favs = new Set(); S.favOrder = [];
  const miss = Object.keys(m.missing);
  setStatus(`${m.lineups.length} of ${body.length} lineups matched` + (miss.length ? ` · missing: ${miss.slice(0, 3).join(", ")}${miss.length > 3 ? " +" + (miss.length - 3) : ""}` : ""), miss.length > 0);
}
function loadDK(text, fname) {
  const rows = parseCSV(text); let hdr = -1, base = -1;
  for (let r = 0; r < rows.length && hdr < 0; r++) for (let c = 0; c < rows[r].length; c++) if (String(rows[r][c]).trim() === "Name + ID") { hdr = r; base = c; break; }
  const ids = {}, entries = [];
  if (hdr >= 0) for (let r = hdr + 1; r < rows.length; r++) { const row = rows[r], nm = String(row[base + 1] || "").trim(), id = String(row[base + 2] || "").trim(), rp = String(row[base + 3] || "").trim();
    if (!nm || !/^\d+$/.test(id)) continue; const k = nrm(nm); if (!ids[k]) ids[k] = { ids: {}, any: id }; ids[k].ids[rp] = id; if (rp !== "CPT") ids[k].any = id; }
  rows.forEach(rw => { if (!/^\d+$/.test(String(rw[0] || "").trim())) return; entries.push({ id: String(rw[0]).trim(), contest: String(rw[1] || "").trim(), cid: String(rw[2] || "").trim(), fee: String(rw[3] || "").trim(), feeN: num(rw[3]) || 0, lu: null }); });
  S.dk.entries = entries; S.dk.ids = ids; S.dk.name = fname || "DKEntries.csv";
}
const dkIdFor = (p, slot) => { const e = S.dk.ids[p.key]; if (!e) return null; if (F().mult) return slot === 0 ? (e.ids.CPT || e.any) : (e.ids.FLEX || e.any); return e.any; };
function entriesCSV() {
  const f = F(), out = ["Entry ID,Contest Name,Contest ID,Entry Fee," + f.slots.join(",")]; let bad = 0;
  for (const en of S.dk.entries) { if (en.lu == null || !S.LU[en.lu]) continue; const ids = S.LU[en.lu].map((id, j) => { const x = dkIdFor(S.pool.players[id], j); if (!x) bad++; return x || ""; }); out.push([en.id, en.contest, en.cid, en.fee].concat(ids).join(",")); }
  return { csv: out.length > 1 ? out.join("\n") : "", bad, n: out.length - 1 };
}

/* ================= contest generation ================= */
function payoutsFor(N) {
  const c = S.cfg;
  if (c.payMode === "custom" && c.payText && c.payText.trim()) { const p = parsePayoutTable(c.payText, N); if (paidCount(p)) return { pay: p, fee: +c.fee || 1 }; }
  const pool = N * (1 - (+c.rake || 15) / 100);   // in units of the entry fee
  return { pay: fitPayouts(N, pool, pool * (+c.pct || 10) / 100, 22), fee: 1 };
}
function stacksToOpt() {
  const st = S.cfg.stacks, g = k => Math.max(0, +st[k] || 0);
  const p5 = g("5-3") + g("5-2-1") + g("5-x"), p4 = g("4-4") + g("4-3-1") + g("4-2-x") + g("4-x"), p3x = g("3-3-x");
  const total = p5 + p4 + p3x, unst = Math.max(0, 100 - total), p3 = p3x + unst;
  const sizes = { 5: p5, 4: p4, 3: p3 };
  const secBy = { 5: { 3: g("5-3"), 2: g("5-2-1"), 1: g("5-x") }, 4: { 4: g("4-4"), 3: g("4-3-1"), 2: g("4-2-x"), 1: g("4-x") }, 3: { 3: p3x, 2: unst * 0.5, 1: unst * 0.5 } };
  for (const k in secBy) { const d = secBy[k]; let s = 0; for (const q in d) s += d[q]; if (!s) d[1] = 1; }
  return { sizes, secBy };
}
function effectivePool() {
  const P = S.pool.players.map(p => Object.assign({}, p));
  for (const p of P) { if (S.teamCtl.removed[p.team]) { p.own = 0; p.fown = 0; p.cown = 0; } const b = S.teamCtl.boost[p.team]; if (b) { p.own *= 1 + b / 100; p.fown *= 1 + b / 100; } const pb = S.boosts[p.i]; if (pb) { p.own = Math.max(0, p.own + pb); p.fown = Math.max(0, p.fown + pb); } }
  return Object.assign({}, S.pool, { players: P });
}
async function generateContest() {
  if (!S.pool || S.busy) return;
  const c = S.cfg, N = Math.max(2, Math.round(+c.pool || 2)), f = F(), a = archFor(c.fee);
  const opt = Object.assign({ conc: a.conc, minSal: a.minSal, boost: a.boost, rounds: Math.max(0, Math.round(+c.rounds || 0)), stackTeams: S.share && Object.keys(S.share).length ? S.share : null }, f.sport === "mlb" ? stacksToOpt() : { nflStacks: Object.assign({}, stackDef(), c.nflStacks || {}) });
  S.busy = "gen"; S.view = "gen"; render(); setStatus(`Simulating slate — building ${N.toLocaleString()} entries…`); prog(5);
  try {
    const t0 = performance.now(), pool = effectivePool(), seed = +c.seed || 1;
    const g = await runJob({ type: "genField", pool: poolMsg(pool), n: N, opt, seed }, { onLog: line => { setStatus(line); prog(Math.min(90, 20 + 20 * (S.contest ? 0 : 1))); } });
    c.seed = seed + 1; saveCfg();   // the next Regenerate rolls a fresh field; the seed used is shown so any run can be repeated
    if (!g.field.length) throw new Error("No lineups could be built with these settings.");
    const P = S.pool.players, field = g.field, sig = {}; let uniq = 0, top = 0;
    for (const l of field) { const k = sigOf(l, f); sig[k] = (sig[k] || 0) + 1; } for (const k in sig) { uniq++; if (sig[k] > top) top = sig[k]; }
    const M = field.length, proj = new Float64Array(M), own = new Float64Array(M), sal = new Float64Array(M), dup = new Int32Array(M), st = new Array(M), tmz = new Array(M);
    for (let i = 0; i < M; i++) { const l = field[i]; proj[i] = projOf(l, P, f); own[i] = ownSum(l, P, f); sal[i] = salOf(l, P, f); dup[i] = sig[sigOf(l, f)] - 1; st[i] = stackTypeOf(l, P, f); tmz[i] = f.mult ? sdStack(l, P) : stackTeams(l, P, f).filter(x => x[1] >= 2).map(x => x[0]).join(","); }
    const rank = arr => { const idx = arr.map((v, i) => i).sort((a2, b) => arr[b] - arr[a2]); const r = new Int32Array(M); idx.forEach((i, k) => r[i] = k + 1); return r; };
    const { pay, fee } = payoutsFor(N);
    S.contest = { N, fee, pay, paidN: paidCount(pay), field, expo: g.expo, cC: g.cC, cF: g.cF, log: g.log, opt, uniq, top, sig, seed, rk: { proj, own, sal, dup, st, tmz, pr: rank(proj), or: rank(own) }, ms: performance.now() - t0, when: new Date().toLocaleTimeString() };
    rankOverall(); S.res = null; S.sd = null; S.sdPick = null; S.tab.gen = "players";
    setStatus(`Contest ready — ${M.toLocaleString()} entries in ${(S.contest.ms / 1000).toFixed(1)}s, ${uniq.toLocaleString()} unique, field seed ${seed}. ${g.log[g.log.length - 1] || ""}`); prog(100);
  } catch (e) { setStatus(e.message, true); prog(0); }
  S.busy = null; if (window.innerWidth <= 700) S.ctlOpen = false; render();
}
function stackTypeOf(l, P, f) {
  if ((f.sport === "nfl" || f.sport === "cfb") && !f.mult) {
    const qbs = l.map(id => P[id]).filter(p => p.pos === "QB"); if (!qbs.length) return "No QB";
    const qb = qbs.length === 1 ? qbs[0] : qbs.slice().sort((a, b) => l.filter(id => P[id] !== b && P[id].team === b.team).length - l.filter(id => P[id] !== a && P[id].team === a.team).length || b.sal - a.sal)[0];
    let k = 0, bring = false;
    for (const id of l) { const p = P[id]; if (p === qb || p.pos === "DST" || p.pos === "K") continue; if (p.team === qb.team) k++; else if (p.team === qb.opp) bring = true; }
    return (k ? "QB+" + Math.min(3, k) : "No stack") + (k && bring ? " +opp" : "");
  }
  if (f.mult) { const tc = {}; for (const id of l) { const t = P[id].team; if (t) tc[t] = (tc[t] || 0) + 1; } return Object.values(tc).sort((a, b) => b - a).join("-"); }   // showdown: all six spots count
  if (f.sport !== "mlb") return stackOf(l, P, f);
  const c = stackTeams(l, P, f).map(x => x[1]); const a = c[0] || 0, b = c[1] || 0;
  if (a >= 5) return b >= 3 ? "5-3" : b === 2 ? "5-2-1" : "5-x";
  if (a === 4) return b === 4 ? "4-4" : b === 3 ? "4-3-1" : b === 2 ? "4-2-x" : "4-x";
  if (a === 3 && b === 3) return "3-3-x";
  return "Unstacked";
}
function rankOverall() {
  const c = S.contest; if (!c) return; const M = c.field.length, w = ((+S.cfg.wP || 0) + (+S.cfg.wO || 0)) || 1;
  const ov = new Float64Array(M); for (let i = 0; i < M; i++) ov[i] = ((+S.cfg.wP || 0) * c.rk.pr[i] + (+S.cfg.wO || 0) * c.rk.or[i]) / w;
  const idx = ov.map((v, i) => i).sort((a, b) => ov[a] - ov[b]); const ovr = new Int32Array(M); idx.forEach((i, k) => ovr[i] = k + 1); c.rk.ov = ov; c.rk.ovr = ovr;
}

/* ================= simulation ================= */
function mulberrySeed(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function buildMine() {
  if (!S.pool) return; const c = S.cfg, P = S.pool.players;
  const byName = txt => String(txt || "").split(/[,\n;]+/).map(s => nrm(s)).filter(Boolean).map(k => P.findIndex(p => p.key === k)).filter(i => i >= 0);
  const r = buildLineups(S.pool, { n: Math.max(1, +c.n || 20), obj: c.obj, rand: Math.max(0, +c.rand || 0) / 100, maxExp: Math.max(5, +c.maxExp || 60), minSal: +c.bMinSal || 0, minUniq: Math.max(0, +c.minUniq || 0), stackSize: +c.stackSize || 0, force: byName(c.force), exclude: byName(c.exclude) }, mulberrySeed(+c.simSeed || 1));
  if (r.err) return setStatus(r.err, true);
  S.LU = r.lineups; S.luSource = "Built lineups"; S.fieldMode = false; S.res = null; S.favs = new Set(); S.favOrder = []; S.dk.entries.forEach(e => e.lu = null);
  setStatus(`${r.lineups.length} lineups built${r.lineups.length < +c.n ? " — constraints capped it below " + c.n : ""}.`);
}
async function runSim() {
  if (!S.pool || !S.LU.length || S.busy) return;
  if (!S.contest) { setStatus("Generate a contest first (Contest Generator).", true); return; }
  // iters is one checkpoint; the engine keeps going (up to 4x) until the top of the ROI ranking settles
  const c = S.contest, iters = Math.max(100, Math.round(+S.cfg.iters || 5000)), seed = +S.cfg.simSeed || 1;
  S.busy = "sim"; render(); setStatus("Running contest simulation…"); prog(2);
  try {
    const t0 = performance.now();
    const res = await runJob({ type: "simulate", pool: poolMsg(S.pool), field: S.fieldMode ? [] : c.field, lineups: S.LU, payouts: c.pay, entries: c.N, fee: c.fee, iters, maxIters: iters * 4, seed, fieldMode: S.fieldMode, story: !!F().mult },
      { onProgress: (d, t) => { prog(d / t * 100); setStatus(`Simulating — ${d.toLocaleString()} draws, checking whether the ranking has settled every ${iters.toLocaleString()}`); } });
    S.cfg.simSeed = seed + 1; saveCfg();   // next run re-draws; the seed used is shown so any run can be repeated
    res.rows.forEach(r => { r.type = stackTypeOf(r.lu, S.pool.players, F()); r.teams = F().mult ? sdStack(r.lu, S.pool.players) : stackTeams(r.lu, S.pool.players, F()).filter(x => x[1] >= 2).map(x => x[0]).join(","); });
    res.feats = featurize(res.rows); applyScore(res); S.res = res; S.tab.sim = "lineups"; ts("lineups").page = 0;
    const topSE = res.rows.slice().sort((a, b) => b.roi - a.roi).slice(0, 20).map(r => r.se).sort((a, b) => a - b), medSE = topSE.length ? topSE[topSE.length >> 1] : 0;
    setStatus(`Simulation done — ${res.iters.toLocaleString()} draws (seed ${seed}) in ${((performance.now() - t0) / 1000).toFixed(1)}s, ${S.fieldMode ? "the " + c.N.toLocaleString() + "-entry field scored against itself" : "your " + S.LU.length + " lineups against " + res.FS.toLocaleString() + " contest entries"}. Top-20 ROI is good to about ±${medSE.toFixed(0)} points.`); prog(100);
  } catch (e) { setStatus(e.message, true); prog(0); }
  S.busy = null; if (window.innerWidth <= 700) S.ctlOpen = false; render();
}
// Showdown: every near-optimal lineup by structure, measured against the generated field.
async function runStructures() {
  if (!S.pool || !S.contest || S.busy) return;
  S.busy = "sd"; render(); setStatus("Enumerating showdown lineups by structure…"); prog(10);
  try {
    const t0 = performance.now(), r = await runJob({ type: "sdStructures", pool: poolMsg(S.pool), field: S.contest.field, per: 40, minFrac: 0.9 });
    const top = Math.max(0, ...r.rows.map(x => x.lineups[0].proj));
    S.sd = { rows: r.rows, top, when: Date.now() }; S.sdPick = r.rows.length ? r.rows[0].structure : null;
    setStatus(`${r.rows.length} structures have a lineup within 10% of the best projection (${((performance.now() - t0) / 1000).toFixed(1)}s).`); prog(100);
  } catch (e) { setStatus(e.message, true); prog(0); }
  S.busy = null; render();
}
function applyScore(res) { const sc = selectScore(res.feats, +S.gate || 0); res.rows.forEach((r, i) => { r.score = sc[i]; r.rProj = res.feats[i].rProj; }); }
function toggleFav(i) { if (S.favs.has(i)) { S.favs.delete(i); S.favOrder = S.favOrder.filter(x => x !== i); } else { S.favs.add(i); S.favOrder.push(i); } }
function quickFavorite(n, useScore) {
  if (!S.res) return; const rows = visibleRows().slice().sort((a, b) => useScore ? b.score - a.score : (b.roi - a.roi));
  const uniq = Math.max(0, Math.min(9, +S.cfg.uniques || 0)), slots = F().slots.length, P = S.pool.players, expo = {};
  S.favs = new Set(); S.favOrder = [];
  for (const r of rows) {
    if (S.favOrder.length >= n) break;
    if (uniq && S.favOrder.some(i => slots - overlap(S.LU[i], r.lu) < uniq)) continue;
    if (r.lu.some(id => S.plCap[id] != null && ((expo[id] || 0) + 1) / n * 100 > S.plCap[id])) continue;
    S.favs.add(r.i); S.favOrder.push(r.i); r.lu.forEach(id => expo[id] = (expo[id] || 0) + 1);
  }
}
function visibleRows() {
  if (!S.res) return []; const f = S.filt, P = S.pool.players, incl = f.incl ? f.incl.split(/[,;\n]+/).map(nrm).filter(Boolean) : [], excl = f.excl ? f.excl.split(/[,;\n]+/).map(nrm).filter(Boolean) : [];
  const typesOn = Object.keys(f.types).filter(k => f.types[k]);
  return S.res.rows.filter(r => {
    if (f.projMin !== "" && r.proj < +f.projMin) return false; if (f.projMax !== "" && r.proj > +f.projMax) return false;
    if (f.ownMin !== "" && r.own < +f.ownMin) return false; if (f.ownMax !== "" && r.own > +f.ownMax) return false;
    if (f.salMin !== "" && r.sal < +f.salMin) return false;
    if (typesOn.length && !typesOn.includes(r.type)) return false;
    const keys = r.lu.map(id => P[id].key);
    if (incl.length && !incl.every(k => keys.includes(k))) return false;
    if (excl.length && excl.some(k => keys.includes(k))) return false;
    return true;
  }).map(r => Object.assign(r, { roiB: r.roi + r.lu.reduce((s, id) => s + (S.plBoost[id] || 0), 0) }));
}

/* ================= review ================= */
async function gradeReview() {
  const rv = S.review; if (!rv.files.lineup || !rv.files.player || S.busy) return;
  S.busy = "review"; render(); setStatus(F().sport === "nfl" ? "Matching teams from the loaded projections…" : "Looking up teams and opponents from the MLB stats API…"); prog(5);
  try {
    let teamOf = null, teamNote = "";
    if (F().sport === "nfl" || F().sport === "cfb") {
      // Teams and real positions (showdown files only say CPT/FLEX) come from the projections loaded on the Data Hub, if any.
      const pool = S.pool && S.pool.format && S.pool.format.sport === "nfl" ? S.pool : null;
      if (pool) { const byKey = {}; for (const p of pool.players) byKey[p.key] = { team: p.team, opp: p.opp, pos: p.pos, ceil: p.ceil, sd: p.sd }; teamOf = nm => byKey[nrm(nm)] || null; }
      else teamNote = " No NFL projections loaded; graded without teams (no stack correlation).";
    } else {
      try { teamOf = await store.mlbTeamLookup(S.cfg.rvDate); } catch (e) { teamNote = " MLB lookup failed; graded without teams (no stack correlation)."; }
    }
    setStatus("Rebuilding the field…"); prog(30);
    const rc = recoverContest(rv.files.lineup, rv.files.player, teamOf, fkey());
    if (rc.entries.length < 10) throw new Error(`Only ${rc.entries.length} entries could be rebuilt from the lineup file.`);
    setStatus(`Simulating ${rc.entries.length} real entries…`);
    const res = await runJob({ type: "simulate", pool: rc.pool, field: [], lineups: rc.entries.map(e => e.lu), payouts: rc.payouts, entries: rc.entries.length, fee: 1, iters: 4000, seed: 1, fieldMode: true }, { onProgress: (d, t) => prog(30 + d / t * 65) });
    const feats = featurize(res.rows.map((r, i) => ({ proj: rc.entries[i].stkFP, roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: rc.entries[i].own, stkROI: rc.entries[i].stkROI, actFP: rc.entries[i].actFP, actROI: rc.entries[i].actROI, finish: rc.entries[i].finish })));
    const grades = gradeRules(feats, rc.paid, { "Stokastic ROI": f => f.stkROI });
    const summary = { name: S.cfg.rvName || `${S.cfg.rvDate} contest`, date: S.cfg.rvDate, N: rc.entries.length, paid: rc.paid, fieldROI: mean(rc.entries.map(e => e.actROI)), unmatched: rc.unmatched.length, grades, when: Date.now() };
    rv.result = summary; rv.history = rv.history.filter(h => h.name !== summary.name).concat([summary]); store.set("reviewHistory", rv.history);
    S.statusMsg = `Graded ${rc.entries.length} entries, ${rc.paid} paid.${teamNote}`; S.statusErr = false;
  } catch (e) { S.statusMsg = e.message; S.statusErr = true; }
  S.busy = null; render(); prog(100);
}

/* ================= rendering ================= */
function setStatus(msg, err) { S.statusMsg = msg; S.statusErr = !!err; const el = $("#status"); if (el) el.innerHTML = err ? `<span class="err">${esc(msg)}</span>` : esc(msg); }
function prog(p) { const el = $("#prog"); if (el) el.style.width = p + "%"; }
const VIEWS = [["hub", "Data Hub", "Data Hub"], ["gen", "Contest Generator", "Generator"], ["sim", "Pre-Contest Simulator", "Simulator"], ["review", "Review", "Review"]];
function render() {
  const app = $("#app");
  app.innerHTML = `<nav class="nav"><div class="brand"><i></i>SLATE LAB</div><div class="links">${VIEWS.map(([k, l, s]) => `<button class="lnk" data-view="${k}" aria-selected="${S.view === k}"><span class="long">${l}</span><span class="short">${s}</span></button>`).join("")}</div><div class="grow"></div>
    <div class="right"><button class="btn ghost" id="ctlToggle" title="Show or hide settings">⚙ Settings</button><span class="st">${S.pool ? `<span class="ok">✓</span> ${esc(S.projName || "projections")}` : "No projections"}</span><button class="btn ghost" id="btnBackup">Backup</button></div></nav>
    ${slateBar()}<div id="ctl" class="${S.ctlOpen === false ? "collapsed" : ""}"></div><div class="prog"><i id="prog"></i></div><div id="status" class="status">${S.statusErr ? `<span class="err">${esc(S.statusMsg || "")}</span>` : esc(S.statusMsg || "")}</div><div id="tabs"></div><div id="main"></div><div id="bot"></div><div id="modal"></div>`;
  $$(".lnk").forEach(b => b.addEventListener("click", () => { S.view = b.getAttribute("data-view"); S.pop = null; render(); }));
  $("#btnBackup").addEventListener("click", () => openModal("backup"));
  $("#ctlToggle").addEventListener("click", () => { S.ctlOpen = !S.ctlOpen; $("#ctl").classList.toggle("collapsed", !S.ctlOpen); });
  ({ hub: renderHub, gen: renderGen, sim: renderSim, review: renderReview })[S.view]();
  renderModal();
}
function renderMain() { ({ hub: mainHub, gen: mainGen, sim: mainSim, review: mainReview })[S.view](); }
const sel = (k, opts, attrs = "") => `<select class="sel" data-cfg="${k}" ${attrs}>${opts.map(o => `<option value="${o[0]}"${String(S.cfg[k]) === String(o[0]) ? " selected" : ""}>${o[1]}</option>`).join("")}</select>`;
const ctlField = (label, inner, info, cls) => `<div class="f${cls ? " " + cls : ""}"><label>${label}${info ? '<span class="i">i</span>' : ""}</label>${inner}</div>`;
function commonCtl() {
  return ctlField("League", `<select class="sel" id="league"><option value="mlb"${S.league === "mlb" ? " selected" : ""}>⚾ MLB</option><option value="nfl"${S.league === "nfl" ? " selected" : ""}>🏈 NFL</option><option value="cfb"${S.league === "cfb" ? " selected" : ""}>🏈 CFB</option></select>`) +
    ctlField("Site", `<select class="sel"><option>DraftKings</option></select>`, false, "site") +
    ctlField("Type", `<select class="sel" id="type"><option value="classic"${S.type === "classic" ? " selected" : ""}>Classic</option>${S.league === "nfl" ? `<option value="showdown"${S.type === "showdown" ? " selected" : ""}>Showdown</option>` : ""}</select>`) +
    ctlField("Slate", `<select class="sel" style="min-width:200px"><option>${S.pool ? esc(S.projName || "Loaded projections") : "No projections loaded"}</option></select>`, true, "wide");
}
function wireCommon() {
  $("#league").addEventListener("change", e => { S.league = e.target.value; if (S.league === "mlb" || S.league === "cfb") S.type = "classic"; S.cfg.nflStacks = null; saveCfg(); /* stack shares are per sport */ store.set("league", S.league); store.set("type", S.type); reloadPool(); });
  $("#type").addEventListener("change", e => { S.type = e.target.value; store.set("type", S.type); reloadPool(); });
  $$("[data-cfg]").forEach(el => { const k = el.getAttribute("data-cfg"); if (el.tagName !== "SELECT") el.value = S.cfg[k] ?? ""; el.addEventListener("change", () => { S.cfg[k] = el.type === "checkbox" ? el.checked : el.value; saveCfg(); if (el.hasAttribute("data-rr")) render(); }); });
}
function reloadPool() { S.contest = null; S.res = null; S.LU = []; if (S.projText) loadProjections(S.projText, S.projName, true); render(); }
function tabsHtml(view, list) { return `<div class="tabs">${list.map(([k, l, n]) => `<button class="tab" data-tab="${k}" aria-selected="${S.tab[view] === k}">${l}${n ? `<span class="n">${n}</span>` : ""}</button>`).join("")}</div>`; }
function wireTabs(view) { $$("#tabs .tab").forEach(t => t.addEventListener("click", () => { S.tab[view] = t.getAttribute("data-tab"); S.pop = null; render(); })); }

// generic sortable/pageable grid; returns {html, rows(sorted idx)}; bottom bar separate
function grid(key, cols, rows, opts = {}) {
  const st = ts(key); if (!st.sort && opts.sort) st.sort = Object.assign({}, opts.sort);
  let idx = rows.map((r, i) => i);
  if (st.sort && st.sort.k) { const col = cols.find(c => c.k === st.sort.k), val = col && col.v ? col.v : r => r[st.sort.k], d = st.sort.d;
    idx.sort((a, b) => { const x = val(rows[a]), y = val(rows[b]); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * d || a - b; }); }
  const per = st.per || 100, pages = Math.max(1, Math.ceil(idx.length / per)); if (st.page >= pages) st.page = pages - 1; if (st.page < 0) st.page = 0;
  const from = st.page * per, to = Math.min(idx.length, from + per);
  let h = `<div class="tw"><table><thead><tr>`;
  for (const c of cols) { const ar = st.sort && st.sort.k === c.k ? `<span class="ar">${st.sort.d < 0 ? "▼" : "▲"}</span>` : ""; h += `<th class="${c.num ? "num" : ""}${c.sortable === false ? " na" : ""}${c.sticky === "l" ? " stl" : c.sticky === "r" ? " str" : ""}" ${c.sortable === false ? "" : `data-sort="${c.k}"`}>${c.label}${c.info ? `<span class="i"${c.tip ? ` title="${esc(c.tip)}"` : ""}>i</span>` : ""}${ar}</th>`; }
  h += "</tr></thead><tbody>";
  for (let i = from; i < to; i++) { const r = rows[idx[i]]; h += "<tr>"; for (const c of cols) h += `<td class="${c.cls ? (typeof c.cls === "function" ? c.cls(r) : c.cls) : ""}${c.num ? " num" : ""}${c.sticky === "l" ? " stl" : c.sticky === "r" ? " str" : ""}">${c.r ? c.r(r, idx[i]) : esc(r[c.k])}</td>`; h += "</tr>"; }
  h += "</tbody></table></div>";
  st.total = idx.length; st.from = from; st.to = to; st.pages = pages; st.idx = idx;
  return h;
}
function wireGrid(key, root, rerender) {
  const st = ts(key);
  $$("th[data-sort]", root).forEach(th => th.addEventListener("click", () => { const k = th.getAttribute("data-sort"); if (st.sort && st.sort.k === k) st.sort.d *= -1; else st.sort = { k, d: -1 }; st.page = 0; rerender(); }));
}
function pager(key, rerender) {
  const st = ts(key); if (st.total == null) return "";
  return `<div class="pg" data-pg="${key}">Rows per page: <select class="sel" data-per style="padding:3px 22px 3px 6px;min-height:0">${[50, 100, 250, 500].map(n => `<option${(st.per || 100) === n ? " selected" : ""}>${n}</option>`).join("")}</select><span>${st.total ? st.from + 1 : 0}–${st.to} of ${st.total.toLocaleString()}</span><button data-page="-1"${st.page <= 0 ? " disabled" : ""}>‹</button><button data-page="1"${st.page >= st.pages - 1 ? " disabled" : ""}>›</button></div>`;
}
function wirePager(key, rerender) { const root = $(`[data-pg="${key}"]`); if (!root) return; const st = ts(key);
  $$("[data-page]", root).forEach(b => b.addEventListener("click", () => { st.page += +b.getAttribute("data-page"); rerender(); }));
  $("[data-per]", root).addEventListener("change", e => { st.per = +e.target.value; st.page = 0; rerender(); }); }
function posTool(key, onChange, extra = "") {
  const f = S.filt, poses = F().sport === "mlb" ? ["ALL", "P", "C", "1B", "2B", "3B", "SS", "OF"] : (F().mult ? ["ALL", "QB", "RB", "WR", "TE", "K", "DST"] : ["ALL", "QB", "RB", "WR", "TE", "DST"]);
  return `<div class="tool"><div class="search">🔍<input id="q-${key}" placeholder="Search Players" value="${esc(f.q)}"></div><div class="pos">${poses.map(p => `<button data-pos="${p}" aria-selected="${f.pos === p}">${p}</button>`).join("")}</div>${extra}</div>`;
}
function wirePosTool(key, rerender) { const q = $(`#q-${key}`); if (q) q.addEventListener("input", () => { S.filt.q = q.value; ts(key).page = 0; rerender(); const q2 = $(`#q-${key}`); if (q2) { q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); } });
  $$("#main [data-pos]").forEach(b => b.addEventListener("click", () => { S.filt.pos = b.getAttribute("data-pos"); ts(key).page = 0; rerender(); })); }
function filterPlayers(P) { const f = S.filt, q = nrm(f.q); return P.filter(p => (f.pos === "ALL" || p.posList.includes(f.pos) || (f.pos === "P" && p.isP)) && (!q || p.key.includes(q))); }
function exportCSV(name, cols, rows) { const lines = [cols.join(",")]; rows.forEach(r => lines.push(r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(","))); download(name, lines.join("\n")); }

/* ---------- projections table (Data Hub + Sim Projections) ---------- */
function projTable(key, rerender) {
  if (!S.pool) return `<div class="empty">Load projections to start.<small>Use the Slate controls above: Stokastic Data Hub, ETR, Blick or any CSV.</small></div>`;
  const P = filterPlayers(S.pool.players), f = F(), mlb = f.sport === "mlb";
  const stepper = (p, k, step) => `<span class="step"><button class="m" data-step="${p.i}|${k}|-${step}">−</button><input data-ed="${p.i}|${k}" value="${(+p[k]).toFixed(k === "own" ? 2 : 2)}"><button class="p" data-step="${p.i}|${k}|${step}">+</button></span>`;
  const cols = [{ k: "name", label: "Player", sticky: "l", r: p => nameCell(p) }, { k: "sal", label: "Salary", num: true, r: p => money(p.sal) }, { k: "pos", label: "Position", r: p => esc(p.posList.join("/")) }]
    .concat(mlb ? [{ k: "ord", label: "Bat Pos.", num: true, r: p => p.ord || "—" }] : []).concat([{ k: "team", label: "Team", r: p => teamCell(p.team) }, { k: "opp", label: "Opponent", r: p => teamCell(p.opp) },
      { k: "proj", label: "Projected FP", info: true, num: true, r: p => stepper(p, "proj", 0.25) }, { k: "val", label: "Value", info: true, num: true, v: p => p.sal ? p.proj / p.sal * 1000 : 0, r: p => fmt(p.sal ? p.proj / p.sal * 1000 : 0, 2) },
      { k: "own", label: "Ownership %", info: true, num: true, r: p => stepper(p, "own", 0.5) }]).concat(f.mult ? [{ k: "cown", label: "CPT Own %", num: true, r: p => stepper(p, "cown", 0.5) }] : [])
    .concat([{ k: "sd", label: "Std Dev", num: true, r: p => fmt(p.sd, 2) }, { k: "sig", label: "σ", num: true, v: p => sigmaFor(p, f.sport), r: p => fmt(sigmaFor(p, f.sport), 2) }, { k: "conf", label: "Confirmed", cls: "ctr", r: p => p.conf == null ? "—" : (p.conf ? "C" : "P") }]);
  return posTool(key, rerender, `<div class="grow"></div><button class="btn ghost" id="expProj">⬇ Export</button>`) + grid(key, cols, P, { sort: { k: "proj", d: -1 } });
}
function wireProjTable(key, rerender) {
  wirePosTool(key, rerender); wireGrid(key, $("#main"), rerender);
  const P = S.pool ? S.pool.players : [];
  const commit = (i, k, v) => { const p = P[i]; if (isNaN(v)) return; p[k] = Math.max(0, v); if (k === "own") p.fown = p.own; S.contest = null; S.res = null; };
  $$("#main [data-ed]").forEach(inp => inp.addEventListener("change", () => { const [i, k] = inp.getAttribute("data-ed").split("|"); commit(+i, k, parseFloat(inp.value)); rerender(); }));
  $$("#main [data-step]").forEach(b => b.addEventListener("click", () => { const [i, k, d] = b.getAttribute("data-step").split("|"); commit(+i, k, P[+i][k] + (+d)); rerender(); }));
  const ex = $("#expProj"); if (ex) ex.addEventListener("click", () => exportCSV("projections.csv", ["Player", "Salary", "Position", "Bat Pos.", "Team", "Opponent", "Projection", "Ownership %", "CPT Ownership %", "Std Dev"], P.map(p => [p.name, p.sal, p.posList.join("/"), p.ord || 0, p.team, p.opp, p.proj, p.own, p.cown, p.sd ?? ""])));
}

/* ---------- Data Hub ---------- */
// Stokastic Data Hub: which DK slates exist today, when each was last updated, and load one straight in
function stkSlateOptions() {
  const list = S.stk.slates || [];
  return `<option value="">${list.length ? "Choose a slate" : "Check to list today's slates"}</option>` + list.map(sl => `<option value="${sl.slateId}"${S.stk.slateId === sl.slateId ? " selected" : ""}>${esc(sl.name)}${sl.type === "SHOWDOWN" ? " SD" : ""} · ${esc(stkEastern(sl.start).toLocaleDateString([], { weekday: "short" }))} ${esc(hhmm(stkEastern(sl.start)))} (${sl.games.length}g)</option>`).join("");
}
function stkStampHtml() {
  const k = S.stk; if (!k.checked) return "Not checked yet";
  const fresh = k.loadedProj && k.proj && stkTime(k.proj) > stkTime(k.loadedProj);
  return `Stokastic projections <b>${esc(hhmm(stkTime(k.proj)))}</b> · ownership <b>${esc(hhmm(stkTime(k.own)))}</b> · checked ${esc(hhmm(k.checked))}${k.loadedProj ? (fresh ? ` · <span class="warn">newer than what you loaded (${esc(hhmm(stkTime(k.loadedProj)))})</span>` : ` · <span class="ok">loaded is current</span>`) : ""}`;
}
async function stkCheck() {
  if (S.busy) return; const sport = F().sport;
  try {
    setStatus("Checking Stokastic…");
    // today and the next six days, so Thursday-night and weekend slates show up midweek
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() + i * 864e5).toLocaleString("sv-SE").slice(0, 10));
    S.stk.slates = (await Promise.all(days.map(d => stkSlates(sport, d)))).flat();
    if (!S.stk.slateId || !S.stk.slates.some(x => x.slateId === S.stk.slateId)) { const want = F().mult ? "SHOWDOWN" : "CLASSIC"; const main = S.stk.slates.find(x => x.type === want && /main/i.test(x.name)) || S.stk.slates.find(x => x.type === want) || S.stk.slates[0]; S.stk.slateId = main ? main.slateId : null; }
    if (S.stk.slateId) { const u = await stkUpdateInfo(S.stk.slateId); S.stk.proj = u.projectionsLastUpdated; S.stk.own = u.ownershipLastUpdated; S.stk.checked = new Date().toISOString(); }
    store.set("stk", S.stk); render();
    setStatus(S.stk.slateId ? `Stokastic checked — projections ${hhmm(stkTime(S.stk.proj))}, ownership ${hhmm(stkTime(S.stk.own))}.` : `No DK ${sport.toUpperCase()} slates on Stokastic in the next week.`);
  } catch (e) { setStatus(e.message, true); }
}
async function stkLoad() {
  if (S.busy || !S.stk.slateId) return;
  try {
    setStatus("Loading Stokastic projections…");
    const u = await stkUpdateInfo(S.stk.slateId), proj = await stkProjections(S.stk.slateId), sl = (S.stk.slates || []).find(x => x.slateId === S.stk.slateId);
    S.stk.proj = u.projectionsLastUpdated; S.stk.own = u.ownershipLastUpdated; S.stk.checked = new Date().toISOString(); S.stk.loadedProj = u.projectionsLastUpdated; store.set("stk", S.stk);
    loadProjections(stkToCSV(proj, F().sport), `DK ${F().sport.toUpperCase()} ${sl ? sl.name : "slate"} — Stokastic ${hhmm(stkTime(u.projectionsLastUpdated))}`);
    render();
  } catch (e) { setStatus(e.message, true); }
}
function renderHub() {
  $("#ctl").innerHTML = `<div class="ctl">${commonCtl()}<div class="f"><label>Projections</label><label class="btn sec" style="cursor:pointer">Load Projections CSV<input type="file" id="fileProj" accept=".csv,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel" hidden multiple></label></div><div class="f wide"><label>Stokastic Data Hub</label><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><select class="sel" id="stkSlate" style="min-width:170px">${stkSlateOptions()}</select><button class="btn sec" id="stkCheck" title="Ask Stokastic when this slate's projections and ownership were last updated">Check</button><button class="btn sec" id="stkLoad" title="Load the current Stokastic projections for this slate"${S.stk.slateId ? "" : " disabled"}>Load</button></div><div class="stamp" id="stkStamp">${stkStampHtml()}</div></div>${F().sport === "mlb" ? `<div class="f"><label>Top stacks</label><label class="btn sec" style="cursor:pointer">Load Topstacks CSV<input type="file" id="fileTs" accept=".csv,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel" hidden></label></div>` : ""}<div class="f"><label>&nbsp;</label><button class="btn ghost" id="btnSample">Load sample slate</button></div><div class="stamp">${S.projWhen ? "Projections loaded: " + esc(S.projWhen) : ""}${S.share ? "<br>Top stacks ✓" : ""}</div></div>`;
  wireCommon();
  $("#stkSlate").addEventListener("change", e => { S.stk.slateId = +e.target.value || null; S.stk.proj = S.stk.own = S.stk.checked = null; store.set("stk", S.stk); render(); });
  $("#stkCheck").addEventListener("click", stkCheck);
  $("#stkLoad").addEventListener("click", stkLoad);
  $("#fileProj").addEventListener("change", async e => { for (const fl of Array.from(e.target.files)) { const t = await readFile(fl); const h = t.slice(0, 300).toLowerCase(); if (h.includes("top stack")) loadTopstacks(t); else loadProjections(t, fl.name); } render(); });
  const ft = $("#fileTs"); if (ft) ft.addEventListener("change", async e => { const fl = e.target.files[0]; if (fl) loadTopstacks(await readFile(fl)); render(); });
  $("#btnSample").addEventListener("click", () => { const sp = $('script[data-seed="proj"]'), st = $('script[data-seed="topstacks"]'); if (st) loadTopstacks(st.textContent.trim(), true); if (sp) loadProjections(sp.textContent.trim(), "Sample: MLB night 2026-09-10"); render(); });
  $("#tabs").innerHTML = tabsHtml("hub", [["proj", "Projections", S.pool ? S.pool.players.length : ""], ["stacks", "Top Stacks"], ["map", "Column Mapping"]]); wireTabs("hub");
  mainHub();
}
function mainHub() {
  const main = $("#main"), t = S.tab.hub;
  if (t === "proj") { main.innerHTML = projTable("hub", mainHub); wireProjTable("hub", mainHub); $("#bot").innerHTML = `<div class="bot">${pager("hub", mainHub)}<div class="grow"></div><button class="btn next" id="toGen"${S.pool ? "" : " disabled"}>Generate Contest</button></div>`; wirePager("hub", mainHub); $("#toGen").addEventListener("click", () => { S.view = "gen"; render(); }); }
  else if (t === "stacks") { if (!S.tsRows) { main.innerHTML = `<div class="empty">No top stacks loaded.<small>Load the Stokastic Data Hub Topstacks file. Without it, the generator weights stack teams by hitter ownership.</small></div>`; $("#bot").innerHTML = ""; return; }
    const h = S.tsRows.h, rows = S.tsRows.rows; main.innerHTML = `<div class="tw"><table><thead><tr>${h.map(x => `<th class="na">${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((x, i) => `<td class="${i > 1 ? "num" : ""}">${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; $("#bot").innerHTML = ""; }
  else { if (!S.pool) { main.innerHTML = `<div class="empty">Load projections first.</div>`; $("#bot").innerHTML = ""; return; }
    const H = S.pool.headers, M = S.pool.map; main.innerHTML = `<div style="padding:16px;max-width:560px" class="grid2">${FIELDS.map(f => `<div class="field"><label>${f[1]}${["name", "pos", "sal", "proj"].includes(f[0]) ? "" : " (optional)"}</label><select class="sel" data-map="${f[0]}"><option value="">— none —</option>${H.map((c, i) => `<option value="${i}"${M[f[0]] === i ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></div>`).join("")}</div>`;
    $$("#main select[data-map]").forEach(s => s.addEventListener("change", () => { const map = Object.assign({}, S.pool.map), k = s.getAttribute("data-map"); if (s.value === "") delete map[k]; else map[k] = +s.value; S.mapOverride = { name: S.projName, map }; loadProjections(S.projText, S.projName); render(); })); $("#bot").innerHTML = ""; }
}

/* ---------- DraftKings contest list ----------
   bench/dk-contests.mjs writes data/dk-lobby/<sport>.json from DraftKings' own lobby: every live
   contest with its field size, entry fee, per-user cap, prize pool, and for the larger ones the
   exact payout table. Picking one here replaces three numbers that were previously typed and
   guessed. It is a local step rather than something this page does itself because DraftKings sends
   no CORS headers and returns 403 to any browser origin; the file it writes is same-origin.
   The payout table matters more than it sounds: graded over 140 contests, the curve fitted from a
   typed field size and rake moves an individual lineup's ROI by 13.3 points against the real table,
   and the real table cuts that to 3.1. */
const dkSport = () => ({ mlb: "mlb", nfl: "nfl", cfb: "cfb" })[S.league] || "cfb";
async function loadDkLobby() {
  if (S.dkTried) return;
  S.dkTried = true;
  try {
    const r = await fetch(`data/dk-lobby/${dkSport()}.json`, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    S.dkLobby = (j.contests || []).filter(c => c.gameType === "Classic" || !c.gameType);
    S.dkWhen = j.fetched || "";
    render();
  } catch { /* no file yet: the typed buy-in still works */ }
}
// Only the contests you are actually in. Entry Manager gives the contest id for every entry, so the
// lobby is filtered to those; matching falls back to the contest name because a CSV exported from a
// different slate still names the contest. With no entries loaded the whole lobby is offered.
function dkMine() {
  const all = S.dkLobby || [];
  const ents = (S.dk && S.dk.entries) || [];
  if (!all.length || !ents.length) return { list: all, filtered: false };
  const ids = new Set(ents.map(e => String(e.cid || "").trim()).filter(Boolean));
  const names = new Set(ents.map(e => String(e.contest || "").trim().toLowerCase()).filter(Boolean));
  const mine = all.filter(c => ids.has(String(c.id)) || names.has(String(c.name || "").trim().toLowerCase()));
  return mine.length ? { list: mine, filtered: true } : { list: all, filtered: false };
}
function dkOptions() {
  const { list } = dkMine();
  if (!list.length) return "";
  return list.slice(0, 120).map(c => {
    const n = ((S.dk && S.dk.entries) || []).filter(e => String(e.cid) === String(c.id)).length;
    return `<option value="${c.id}">${esc(c.name.slice(0, 44))} — $${c.fee}, ${(c.field || 0).toLocaleString()} entries${n ? `, ${n} of yours` : ""}${c.payText ? " ✓" : ""}</option>`;
  }).join("");
}
function pickDkContest(id) {
  const c = (S.dkLobby || []).find(x => String(x.id) === String(id));
  if (!c) return;
  S.cfg.fee = c.fee || S.cfg.fee;
  if (c.field >= 2) { S.cfg.pool = Math.round(c.field); S.cfg.entries = Math.round(c.field); }
  if (c.payText) { S.cfg.payMode = "custom"; S.cfg.payText = c.payText; }
  S.dkPicked = `${c.name} — $${c.fee}, ${(c.field || 0).toLocaleString()} entries, ${c.payText ? "real payout table" : "payout estimated"}`;
  saveCfg(); render();
  setStatus(c.payText ? "Contest loaded with its real payout table." : "Contest loaded; payouts estimated for this one.");
}

/* ---------- Contest Generator ---------- */
function renderGen() {
  const mlb = F().sport === "mlb", fee = +S.cfg.fee || 20;
  $("#ctl").innerHTML = `<div class="ctl gen">${commonCtl()}
    ${ctlField("Pool Size", `<select class="sel" data-cfg="pool" id="poolSel">${[250, 500, 1000, 1500, 2000, 5000].map(n => `<option value="${n}"${+S.cfg.pool === n ? " selected" : ""}>${n}</option>`).join("")}<option value="custom"${![250, 500, 1000, 1500, 2000, 5000].includes(+S.cfg.pool) ? " selected" : ""}>Custom: ${![250, 500, 1000, 1500, 2000, 5000].includes(+S.cfg.pool) ? S.cfg.pool : "…"}</option></select>`, true)}
    ${ctlField("Team Controls", `<button class="btn sec" id="btnTeams">Team Controls</button>`, true)}
    ${(mlb || fkey() === "nfl_cl" || fkey() === "cfb_cl") ? ctlField("Stack Type Exposures", `<div style="position:relative"><button class="btn sec" id="btnStacks">Stack Type Exposures ✎</button><div id="popStacks"></div></div>`, true) : ""}
    ${ctlField(dkMine().filtered ? "My Contests" : "DraftKings Contest", `<select class="sel" id="dkPick"><option value="">${!S.dkLobby ? "None loaded" : dkMine().filtered ? "Pick one you entered…" : "Load entries to filter…"}</option>${dkOptions()}</select>`, true)}
    <div class="f"><label>Contest Buy-in <span class="i">i</span></label><input class="txt" id="fee" type="number" min="0" step="1" value="${fee}"><div class="ticks"><span id="feeNote">$${fee} — ${feeLabel(fee)}</span></div></div>
    <div class="stamp">${S.projWhen ? "Projections loaded: " + esc(S.projWhen) : ""}${S.dkPicked ? "<br>" + esc(S.dkPicked) : ""}${S.contest ? "<br>Contest generated " + esc(S.contest.when) : ""}</div>
    <div class="f wide cta"><label>&nbsp;</label><button class="btn gen" id="btnGen"${S.pool && !S.busy ? "" : " disabled"}>${S.contest ? "Generate Lineups" : "Generate Lineups"}</button></div></div>`;
  wireCommon();
  $("#poolSel").addEventListener("change", e => { if (e.target.value === "custom") { const v = prompt("Pool size (exact number of entries):", S.cfg.pool); if (v && +v >= 2) S.cfg.pool = Math.round(+v); saveCfg(); render(); } });
  $("#fee").addEventListener("input", e => { S.cfg.fee = +e.target.value; saveCfg();
    const n = $("#feeNote"); if (n) n.textContent = "$" + (+e.target.value || 0) + " — " + feeLabel(e.target.value); });
  $("#dkPick").addEventListener("change", e => { if (e.target.value) pickDkContest(e.target.value); else { S.dkTried = false; loadDkLobby(); } });
  if (!S.dkLobby) loadDkLobby();
  $("#btnTeams").addEventListener("click", () => openModal("teams"));
  const bs = $("#btnStacks"); if (bs) bs.addEventListener("click", () => { S.pop = S.pop === "stacks" ? null : "stacks"; renderStackPop(); });
  $("#btnGen").addEventListener("click", generateContest);
  $("#tabs").innerHTML = tabsHtml("gen", [["players", "Players"], ["stacks", "Stacks"], ["ranker", "Lineups & Ranker"]]); wireTabs("gen");
  mainGen(); renderStackPop();
}
function renderStackPop() {
  const el = $("#popStacks"); if (!el) return; if (S.pop !== "stacks") { el.innerHTML = ""; return; }
  if (F().sport === "nfl") {
    const ns = S.cfg.nflStacks = Object.assign({}, stackDef(), S.cfg.nflStacks || {}); const tot = [1, 2, 3].reduce((s, k) => s + Math.max(0, +ns[k] || 0), 0);
    const row = (k, lab) => `<tr><td><b>${lab}</b></td><td><span class="step"><button class="m" data-ns="${k}|-1">−</button><input data-nsv="${k}" value="${+ns[k] || 0}">%<button class="p" data-ns="${k}|1">+</button></span></td></tr>`;
    el.innerHTML = `<div class="pop"><h4>Stack Type Exposures</h4><div class="hint">Adjust stack exposures and ensure the desired total is 100% or less. The remainder has no QB stack.</div><table><thead><tr><th>Stack Type</th><th>Desired Exposure</th></tr></thead><tbody>${row(1, "QB + 1")}${row(2, "QB + 2")}${row(3, "QB + 3")}</tbody></table><div class="tot"><span>Total</span><span style="color:${tot > 100 ? "#ff8a8a" : ""}">${tot}%</span></div><table><tbody>${row("bring", "Includes Opposing Player")}</tbody></table><div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><button class="btn ghost" id="stDef">Restore Defaults</button><button class="btn" id="stApply">Apply</button></div></div>`;
    $$("#popStacks [data-ns]").forEach(b => b.addEventListener("click", () => { const [k, d] = b.getAttribute("data-ns").split("|"); ns[k] = Math.max(0, (+ns[k] || 0) + (+d)); renderStackPop(); }));
    $$("#popStacks [data-nsv]").forEach(i => i.addEventListener("change", () => { ns[i.getAttribute("data-nsv")] = Math.max(0, +i.value || 0); renderStackPop(); }));
    $("#stDef").addEventListener("click", () => { S.cfg.nflStacks = Object.assign({}, stackDef()); renderStackPop(); });
    $("#stApply").addEventListener("click", () => { saveCfg(); S.pop = null; renderStackPop(); setStatus("Stack exposures saved — regenerate to apply."); });
    return;
  }
  const st = S.cfg.stacks; let tot = 0; STACK_TYPES.forEach(k => tot += Math.max(0, +st[k] || 0));
  el.innerHTML = `<div class="pop"><h4>Stack Type Exposures</h4><div class="hint">Adjust stack exposures; the desired total must be 100% or less. The remainder is unstacked.</div><table><thead><tr><th>Stack Type</th><th>Desired Exposure</th></tr></thead><tbody>${STACK_TYPES.map(k => `<tr><td><b>${k}</b></td><td><span class="step"><button class="m" data-st="${k}|-1">−</button><input data-stv="${k}" value="${+st[k] || 0}">%<button class="p" data-st="${k}|1">+</button></span></td></tr>`).join("")}</tbody></table><div class="tot"><span>Unstacked</span><span>${Math.max(0, 100 - tot)}%</span></div><div class="tot"><span>Total</span><span style="color:${tot > 100 ? "#ff8a8a" : ""}">${tot}%</span></div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><button class="btn ghost" id="stDef">Restore Defaults</button><button class="btn" id="stApply">Apply</button></div></div>`;
  $$("#popStacks [data-st]").forEach(b => b.addEventListener("click", () => { const [k, d] = b.getAttribute("data-st").split("|"); st[k] = Math.max(0, (+st[k] || 0) + (+d)); renderStackPop(); }));
  $$("#popStacks [data-stv]").forEach(i => i.addEventListener("change", () => { st[i.getAttribute("data-stv")] = Math.max(0, +i.value || 0); renderStackPop(); }));
  $("#stDef").addEventListener("click", () => { S.cfg.stacks = Object.assign({}, STACK_DEF); renderStackPop(); });
  $("#stApply").addEventListener("click", () => { saveCfg(); S.pop = null; renderStackPop(); setStatus("Stack exposures saved — regenerate to apply."); });
}
function mainGen() {
  const main = $("#main"), c = S.contest, f = F(), P = S.pool ? S.pool.players : [], t = S.tab.gen;
  if (!S.pool) { main.innerHTML = `<div class="empty">Load projections in the Data Hub first.</div>`; $("#bot").innerHTML = ""; return; }
  if (!c) { main.innerHTML = `<div class="empty">Fill out settings to start generating.<small>Pool size, team controls, stack exposures and archetype, then Generate Lineups.</small></div>`; $("#bot").innerHTML = ""; return; }
  const N = c.field.length;
  const bottom = (key, extra) => `<div class="bot">${pager(key, mainGen)}<div class="grow"></div>${extra || ""}<button class="lnk" id="expGen">Export to CSV</button><button class="btn sec" id="regen">Regenerate Lineups ⟳</button><button class="btn next" id="toSim">Simulate Lineups</button></div>`;
  if (t === "players") {
    const rows = filterPlayers(P).map(p => ({ p, name: p.name, pos: p.pos, team: p.team, opp: p.opp, own: p.own, fp: c.expo[p.i] / N * 100 })).map(r => Object.assign(r, { diff: r.fp - r.own }));
    const cols = [{ k: "name", label: "Name", sticky: "l", r: r => nameCell(r.p) }, { k: "pos", label: "Pos.", r: r => esc(r.p.posList.join("/")) }, { k: "team", label: "Team", r: r => teamCell(r.team) }, { k: "opp", label: "Opp", r: r => teamCell(r.opp) },
      { k: "own", label: "Ownership", info: true, num: true, r: r => pctS(r.own) }, { k: "fp", label: "Pool Exposure", info: true, num: true, r: r => pctS(r.fp) }, { k: "diff", label: "Difference", info: true, num: true, r: r => diffS(r.diff) },
      { k: "boost", label: "Boost Ownership", info: true, cls: "ctr", sortable: false, r: r => `<span class="boost"><button data-boost="${r.p.i}|1">▲</button><button data-boost="${r.p.i}|-1">▼</button></span>${S.boosts[r.p.i] ? ` <span class="hint">${S.boosts[r.p.i] > 0 ? "+" : ""}${S.boosts[r.p.i]}%</span>` : ""}` }];
    main.innerHTML = posTool("gplayers", mainGen, `<div class="grow"></div>`) + grid("gplayers", cols, rows, { sort: { k: "fp", d: -1 } });
    wirePosTool("gplayers", mainGen); wireGrid("gplayers", main, mainGen);
    $$("#main [data-boost]").forEach(b => b.addEventListener("click", () => { const [i, d] = b.getAttribute("data-boost").split("|"); S.boosts[+i] = (S.boosts[+i] || 0) + (+d); if (!S.boosts[+i]) delete S.boosts[+i]; mainGen(); setStatus("Ownership boosts change the next generation — click Regenerate."); }));
    $("#bot").innerHTML = bottom("gplayers"); wirePager("gplayers", mainGen);
  } else if (t === "stacks") {
    const cnt = {}; c.rk.st.forEach(k => cnt[k] = (cnt[k] || 0) + 1);
    let rows;
    if ((f.sport === "nfl" || f.sport === "cfb") && !f.mult) {
      const ns = Object.assign({}, stackDef(), S.cfg.nflStacks || {}), base = k => Object.keys(cnt).filter(x => x.startsWith(k)).reduce((s, x) => s + cnt[x], 0);
      const stacked = ["QB+1", "QB+2", "QB+3"].reduce((s, k) => s + base(k), 0), bring = Object.keys(cnt).filter(x => x.endsWith("+opp")).reduce((s, x) => s + cnt[x], 0);
      rows = [{ k: "QB + 1", fp: base("QB+1") / N * 100, want: +ns[1] || 0 }, { k: "QB + 2", fp: base("QB+2") / N * 100, want: +ns[2] || 0 }, { k: "QB + 3", fp: base("QB+3") / N * 100, want: +ns[3] || 0 },
        { k: "No QB stack", fp: (N - stacked) / N * 100, want: Math.max(0, 100 - [1, 2, 3].reduce((s, k) => s + (+ns[k] || 0), 0)) }, { k: "Includes opposing player (of stacked)", fp: stacked ? bring / stacked * 100 : 0, want: +ns.bring || 0 }];
    } else rows = (f.sport === "mlb" ? STACK_TYPES.concat(["Unstacked"]) : Object.keys(cnt)).map(k => ({ k, fp: (cnt[k] || 0) / N * 100, want: f.sport === "mlb" ? (k === "Unstacked" ? Math.max(0, 100 - STACK_TYPES.reduce((s, x) => s + (+S.cfg.stacks[x] || 0), 0)) : (+S.cfg.stacks[k] || 0)) : null }));
    rows = rows.map(r => Object.assign(r, { diff: r.want == null ? null : r.fp - r.want }));
    main.innerHTML = `<div class="tool"><div class="grow"></div></div>` + grid("gstacks", [{ k: "k", label: "Stack Types" }, { k: "fp", label: "Pool Exposure", num: true, r: r => pctS(r.fp) }, { k: "want", label: "Desired Exposure", num: true, r: r => r.want == null ? "-" : r.want + "%" }, { k: "diff", label: "Difference", num: true, r: r => r.diff == null ? "-" : diffS(r.diff) }], rows, { sort: { k: "fp", d: -1 } });
    wireGrid("gstacks", main, mainGen); $("#bot").innerHTML = bottom("gstacks"); wirePager("gstacks", mainGen);
  } else {
    const rk = c.rk, rows = c.field.map((l, i) => ({ i, l, pr: rk.pr[i], or: rk.or[i], ovr: rk.ovr[i], proj: rk.proj[i], own: rk.own[i], sal: rk.sal[i], st: rk.st[i], tmz: rk.tmz[i], dup: rk.dup[i] }));
    const wt = (k, lab) => `${lab}<span class="wt"><button class="m" data-w="${k}|-5">−</button><span>${S.cfg[k]}%</span><button class="p" data-w="${k}|5">+</button></span>`;
    const cols = [{ k: "pr", label: wt("wP", "Proj. Rank"), num: true, sticky: "l" }, { k: "or", label: wt("wO", "Own. Rank"), num: true }, { k: "ovr", label: "Overall Rank", num: true }, { k: "proj", label: "Lineup Proj", num: true, r: r => r.proj.toFixed(2) }, { k: "own", label: "Total Ownership", num: true, r: r => pctS(r.own) }, { k: "sal", label: "Salary", num: true, r: r => r.sal.toLocaleString() },
      { k: "st", label: "Stack Type", cls: "ctr", r: r => `${esc(r.st)}${r.tmz ? ` <span class="hint">${esc(r.tmz)}</span>` : ""}` }, { k: "dup", label: "Dupes", num: true }, { k: "l", label: "Lineup", sortable: false, r: r => luCell(r.l, P, f) }];
    main.innerHTML = `<div class="tool"><div class="grow"></div><span class="hint">${N.toLocaleString()} entries · ${c.uniq.toLocaleString()} unique · most duplicated ${c.top}×</span></div>` + grid("ranker", cols, rows, { sort: { k: "ovr", d: 1 } });
    wireGrid("ranker", main, mainGen); $$("#main [data-w]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); const [k, d] = b.getAttribute("data-w").split("|"); S.cfg[k] = Math.max(0, Math.min(100, (+S.cfg[k] || 0) + (+d))); saveCfg(); rankOverall(); mainGen(); }));
    $("#bot").innerHTML = bottom("ranker", `<button class="lnk" id="simField">Simulate the field</button>`); wirePager("ranker", mainGen);
    $("#simField").addEventListener("click", () => { S.LU = c.field.map(l => l.slice()); S.luSource = "Contest Generator File"; S.fieldMode = true; S.res = null; S.favs = new Set(); S.favOrder = []; S.view = "sim"; render(); runSim(); });
  }
  $("#regen").addEventListener("click", generateContest);
  $("#toSim").addEventListener("click", () => { if (!S.LU.length || S.luSource === "Contest Generator File") { S.LU = c.field.map(l => l.slice()); S.luSource = "Contest Generator File"; S.fieldMode = true; S.res = null; S.favs = new Set(); S.favOrder = []; } S.view = "sim"; render(); });
  $("#expGen").addEventListener("click", () => exportCSV("contest-generator-lineups.csv", ["Proj. Rank", "Own. Rank", "Overall Rank", "Lineup Proj", "Total Ownership", "Salary", "Stack Type", "Dupes"].concat(f.slots), c.field.map((l, i) => [c.rk.pr[i], c.rk.or[i], c.rk.ovr[i], c.rk.proj[i].toFixed(2), c.rk.own[i].toFixed(1) + "%", c.rk.sal[i], c.rk.st[i], c.rk.dup[i]].concat(l.map(id => P[id].name)))));
}

/* ---------- Pre-Contest Simulator ---------- */
function renderSim() {
  const c = S.contest, mlb = F().sport === "mlb";
  $("#ctl").innerHTML = `<div class="ctl">${commonCtl()}
    ${ctlField("Percent to First", `<select class="sel" id="pct">${[5, 10, 15, 20, 25, 30, 35, 40].map(p => `<option value="${p}"${S.cfg.payMode === "pct" && +S.cfg.pct === p ? " selected" : ""}>${p}%</option>`).join("")}<option value="custom"${S.cfg.payMode === "custom" ? " selected" : ""}>Custom payouts…</option></select>`, true)}
    <div class="f"><label>&nbsp;</label><label class="btn sec" style="cursor:pointer">Upload Lineup File 📄<input type="file" id="fileLu" accept=".csv,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel" hidden></label></div>
    <div class="f"><label>&nbsp;</label><button class="btn sec" id="btnBuild"${S.pool ? "" : " disabled"}>Build Lineups</button></div>
    ${S.LU.length ? `<span class="chip"><span class="x" id="clearLu">✕</span> ${esc(S.luSource)} · ${S.LU.length.toLocaleString()}</span>` : ""}
    <div class="stamp">${c ? `Contest: ${c.N.toLocaleString()} entries · ${c.paidN} paid<br>first place ${(c.pay[0] / c.fee).toFixed(0)}× the entry fee` : "No contest generated"}<br><a href="#" id="dlProj">Download Projections ⬇</a></div>
    <div class="f"><label>&nbsp;</label><button class="btn sec" id="btnEntry">Entry Manager</button></div>
    <div class="f wide cta"><label>&nbsp;</label><button class="btn gen" id="run"${c && S.LU.length && !S.busy ? "" : " disabled"}>Run Contest Simulation</button></div></div>`;
  wireCommon();
  $("#pct").addEventListener("change", e => { if (e.target.value === "custom") { S.cfg.payMode = "custom"; saveCfg(); openModal("payout"); } else { S.cfg.payMode = "pct"; S.cfg.pct = +e.target.value; saveCfg(); if (S.contest) { const { pay, fee } = payoutsFor(S.contest.N); S.contest.pay = pay; S.contest.fee = fee; S.contest.paidN = paidCount(pay); S.res = null; } render(); } });
  $("#fileLu").addEventListener("change", async e => { const fl = e.target.files[0]; if (fl) loadLineupsCSV(await readFile(fl), fl.name); render(); });
  $("#btnBuild").addEventListener("click", () => openModal("build"));
  const cl = $("#clearLu"); if (cl) cl.addEventListener("click", () => { S.LU = []; S.luSource = ""; S.res = null; S.favs = new Set(); S.favOrder = []; render(); });
  $("#dlProj").addEventListener("click", e => { e.preventDefault(); if (S.projText) download(S.projName || "projections.csv", S.projText); });
  $("#btnEntry").addEventListener("click", () => openModal("entry"));
  $("#run").addEventListener("click", runSim);
  $("#tabs").innerHTML = tabsHtml("sim", [["proj", "Projections"], ["lineups", "Lineups", S.res ? S.res.rows.length.toLocaleString() : (S.LU.length ? S.LU.length.toLocaleString() : "")], ["proi", "Player ROI"]].concat(mlb ? [["sroi", "Stack ROI"]] : []).concat(F().mult ? [["sd", "Structures", S.sd ? S.sd.rows.length : ""]] : []).concat([["favs", "Favorites", S.favs.size || ""], ["expo", "Exposures"]])); wireTabs("sim");
  mainSim();
}
function overviewBox() {
  const favRows = S.res ? S.res.rows.filter(r => S.favs.has(r.i)) : [], rs = favRows.map(r => r.roi), ps = favRows.map(r => r.proj);
  const box = (lab, a, d) => `<div class="box"><b>${lab}</b><span><span class="v">${a.length ? Math.min(...a).toFixed(d) : "-"}</span><span class="k">Min</span></span><span><span class="v">${a.length ? mean(a).toFixed(d) : "-"}</span><span class="k">Avg</span></span><span><span class="v">${a.length ? Math.max(...a).toFixed(d) : "-"}</span><span class="k">Max</span></span></div>`;
  return `<div class="ovw"><span class="lab">Lineup Portfolio Overview <span class="i" style="display:inline-block;width:12px;height:12px;border:1px solid var(--muted);border-radius:50%;font-size:9px;line-height:10px;text-align:center;color:var(--muted)">i</span></span>${box("Sim ROI", rs, 1)}${box("Proj. FP", ps, 1)}</div>`;
}
function mainSim() {
  const main = $("#main"), bot = $("#bot"), f = F(), P = S.pool ? S.pool.players : [], res = S.res, t = S.tab.sim;
  if (!S.pool) { main.innerHTML = `<div class="empty">Load projections in the Data Hub first.</div>`; bot.innerHTML = ""; return; }
  const favBot = key => `<div class="bot">${overviewBox()}<div class="grow"></div>${key ? pager(key, mainSim) : ""}<button class="btn sec" id="addEntry"${S.favs.size ? "" : " disabled"}>Add to Entry Manager</button><button class="btn" id="expFav"${S.favs.size ? "" : " disabled"}>Export Favorites ⬇</button></div>`;
  const wireFavBot = key => { if (key) wirePager(key, mainSim); const a = $("#addEntry"); if (a) a.addEventListener("click", () => openModal("entry")); const e = $("#expFav"); if (e) e.addEventListener("click", () => exportCSV("favorites.csv", ["Simulated ROI", "Projected FP", "OwnSum", "Stack", "Stack Type", "Win%", "Top 10%", "Cash%", "Dupes", "Salary"].concat(f.slots), S.favOrder.filter(i => S.res && S.res.rows[i]).map(i => { const r = S.res.rows[i]; return [r.roi.toFixed(1) + "%", r.proj.toFixed(2), r.own.toFixed(1) + "%", r.teams, r.type, r.win.toFixed(3), r.t10.toFixed(2), r.cash.toFixed(2), r.dupN, r.sal].concat(r.lu.map(id => P[id].name)); }))); };
  if (t === "proj") { main.innerHTML = projTable("sproj", mainSim); wireProjTable("sproj", mainSim); bot.innerHTML = `<div class="bot">${pager("sproj", mainSim)}<div class="grow"></div><button class="btn" id="run2"${S.contest && S.LU.length && !S.busy ? "" : " disabled"}>Run Contest Simulation</button></div>`; wirePager("sproj", mainSim); $("#run2").addEventListener("click", runSim); return; }
  if (t === "lineups") {
    if (!res) { if (!S.LU.length) { main.innerHTML = `<div class="empty">Upload your lineups to start generating.<small>Upload a lineup file, build lineups, or send the generated contest from the Contest Generator.</small></div>`; bot.innerHTML = ""; return; }
      const rows = S.LU.map((l, i) => ({ i, l, proj: projOf(l, P, f), own: ownSum(l, P, f), sal: salOf(l, P, f), type: stackTypeOf(l, P, f) }));
      main.innerHTML = `<div class="tool"><span class="hint">${S.LU.length.toLocaleString()} lineups loaded from ${esc(S.luSource)}. ${S.contest ? "Run the contest simulation to score them." : "Generate a contest first."}</span></div>` + grid("lu0", [{ k: "i", label: "#", num: true, r: r => r.i + 1 }, { k: "proj", label: "Projected FP", num: true, r: r => r.proj.toFixed(2) }, { k: "own", label: "OwnSum", num: true, r: r => pctS(r.own) }, { k: "type", label: "Stack Type", cls: "ctr" }, { k: "sal", label: "Salary", num: true, r: r => r.sal.toLocaleString() }, { k: "l", label: "Lineups", sortable: false, r: r => luCell(r.l, P, f) }], rows, { sort: { k: "proj", d: -1 } });
      wireGrid("lu0", main, mainSim); bot.innerHTML = `<div class="bot">${pager("lu0", mainSim)}<div class="grow"></div><button class="btn" id="run2"${S.contest && !S.busy ? "" : " disabled"}>Run Contest Simulation</button></div>`; wirePager("lu0", mainSim); $("#run2").addEventListener("click", runSim); return; }
    const rows = visibleRows();
    const cols = [{ k: "roi", label: "Simulated ROI", info: true, tip: "Average return per entry across the simulated contests: this lineup's payouts against this field, minus the entry fee.", sticky: "l", cls: r => "roi " + (r.roi >= 0 ? "pos" : "neg"), r: r => roiCell(r) }, { k: "score", label: "Lineup Score", info: true, tip: "Simulated ROI, ranked only among lineups that project in the top share of this field (50% by default, set in the bar above). Lineups outside that share show their ROI greyed out and sort to the bottom. This ordering beat every blend, band and fitted score in grading on 200+ real contests.", num: true, r: r => r.score > -1e8 ? pctS(r.score, 0) : `<span class="hint" title="Outside the top ${100 - S.gate}% of the field by projection, so not ranked">${pctS(r.roi, 0)}</span>` },
      { k: "proj", label: "Projected FP", info: true, num: true, r: r => r.proj.toFixed(2) }, { k: "own", label: "OwnSum", info: true, num: true, r: r => pctS(r.own) }, { k: "teams", label: "Stack", cls: "ctr" }, { k: "type", label: "Stack Type", cls: "ctr" },
      { k: "win", label: "Win%", info: true, num: true, r: r => pctS(r.win, 3) }, { k: "t10", label: "Top 10%", info: true, num: true, r: r => pctS(r.t10, 3) }, { k: "cash", label: "Cash%", info: true, num: true, r: r => pctS(r.cash, 3) }, { k: "dupN", label: "Dupes", info: true, num: true }]
      .concat(f.mult ? [{ k: "coh", label: "One bet", info: true, num: true, r: r => r.coh != null ? r.coh.toFixed(2) + "×" : "—" }, { k: "tale", label: "Story", sortable: false, r: r => `<span class="hint">${esc(r.tale || "")}</span>` }] : [])
      .concat([{ k: "lu", label: "Lineups", sortable: false, r: r => luCell(r.lu, P, f) }, { k: "sal", label: "Salary", num: true, r: r => "$" + r.sal.toLocaleString() }, { k: "fav", label: "", sortable: false, sticky: "r", cls: "ctr", r: r => `<span class="heart${S.favs.has(r.i) ? " on" : ""}" data-fav="${r.i}">${S.favs.has(r.i) ? "♥" : "♡"}</span>` }]);
    main.innerHTML = `<div class="tool"><button class="btn ghost" id="fLineup">☰ Lineup Filters</button><button class="btn ghost" id="fPlayers">✎ Players <span class="i"></span></button><button class="btn ghost" id="expRes">⬇ Export</button><span class="hint" title="Lineup Score ranks by simulated ROI within the lineups that project in the top share of the field. Lower the share to be stricter about projection; raise it toward 100% to rank on ROI alone.">Lineup Score = ROI rank within the top <input class="txt" id="gate" style="width:52px;padding:2px 5px;min-height:0" value="${100 - S.gate}">% of the field by projection</span><div class="grow"></div><div style="position:relative"><button class="btn sec" id="qf">Quick Favorite ▾</button><div id="qfMenu"></div></div></div>` + grid("lineups", cols, rows, { sort: { k: "roi", d: -1 } });
    wireGrid("lineups", main, mainSim);
    $$("#main [data-fav]").forEach(el => el.addEventListener("click", () => { toggleFav(+el.getAttribute("data-fav")); mainSim(); }));
    $("#gate").addEventListener("change", e => { S.gate = Math.max(0, Math.min(100, 100 - (+e.target.value || 0))); store.set("gate", S.gate); applyScore(res); mainSim(); });
    $("#fLineup").addEventListener("click", () => openModal("filters")); $("#fPlayers").addEventListener("click", () => openModal("players"));
    $("#expRes").addEventListener("click", () => exportCSV("pre-contest-lineups.csv", ["Simulated ROI", "Lineup Score", "Projected FP", "OwnSum", "Stack", "Stack Type", "Win%", "Top 10%", "Cash%", "Dupes", "Salary"].concat(f.slots), rows.map(r => [r.roi.toFixed(1) + "%", r.score > -1e8 ? r.score.toFixed(1) : "", r.proj.toFixed(2), r.own.toFixed(1) + "%", r.teams, r.type, r.win.toFixed(3), r.t10.toFixed(2), r.cash.toFixed(2), r.dupN, r.sal].concat(r.lu.map(id => P[id].name)))));
    $("#qf").addEventListener("click", () => { S.pop = S.pop === "qf" ? null : "qf"; renderQF(); }); renderQF();
    bot.innerHTML = favBot("lineups"); wireFavBot("lineups"); return;
  }
  if (t === "proi") { if (!res) { main.innerHTML = `<div class="empty">Run the contest simulation first.</div>`; bot.innerHTML = ""; return; }
    const rows = res.players.filter(r => { const p = P[r.id]; return (S.filt.pos === "ALL" || p.posList.includes(S.filt.pos) || (S.filt.pos === "P" && p.isP)) && (!S.filt.q || p.key.includes(nrm(S.filt.q))); }).map(r => Object.assign({}, r, { p: P[r.id] }));
    main.innerHTML = posTool("proi", mainSim, `<button class="btn ghost" id="expP">⬇ Export</button>`) + grid("proi", [{ k: "name", label: "Player", sticky: "l", r: r => nameCell(r.p) }, { k: "team", label: "Team", r: r => teamCell(r.team) }, { k: "opp", label: "Opponent", v: r => r.p.opp, r: r => teamCell(r.p.opp) }, { k: "pos", label: "Position", r: r => esc(r.p.posList.join("/")) }, { k: "sal", label: "Salary", num: true, v: r => r.p.sal, r: r => "$" + r.p.sal.toLocaleString() }, { k: "roi", label: "Avg Simulated ROI", info: true, num: true, r: r => pctS(r.roi) }, { k: "proj", label: "Projected FP", info: true, num: true, v: r => r.p.proj, r: r => r.p.proj.toFixed(2) }, { k: "exp", label: "Exposure", num: true, r: r => pctS(r.exp, 0) }], rows, { sort: { k: "roi", d: -1 } });
    wirePosTool("proi", mainSim); wireGrid("proi", main, mainSim); $("#expP").addEventListener("click", () => exportCSV("player-roi.csv", ["Player", "Team", "Opponent", "Position", "Salary", "Avg Simulated ROI", "Projected FP"], rows.map(r => [r.name, r.team, r.p.opp, r.p.posList.join("/"), r.p.sal, r.roi.toFixed(1) + "%", r.p.proj.toFixed(2)])));
    bot.innerHTML = `<div class="bot">${pager("proi", mainSim)}</div>`; wirePager("proi", mainSim); return; }
  if (t === "sroi") { if (!res) { main.innerHTML = `<div class="empty">Run the contest simulation first.</div>`; bot.innerHTML = ""; return; }
    const by = {}; res.stacks.forEach(r => { (by[r.team] = by[r.team] || { team: r.team, opp: (P.find(p => p.team === r.team) || {}).opp || "" })[r.size] = r; });
    const rows = Object.values(by), cell = (r, s, k) => r[s] ? (k === "n" ? r[s].n : pctS(r[s].roi)) : "-";
    main.innerHTML = `<div class="tool"><div class="grow"></div></div>` + grid("sroi", [{ k: "team", label: "Team", r: r => teamCell(r.team) }, { k: "opp", label: "Opponent", r: r => teamCell(r.opp) }, { k: "n3", label: "3 Man Stack Count", num: true, v: r => r[3] ? r[3].n : 0, r: r => cell(r, 3, "n") }, { k: "r3", label: "3 Man Stack ROI", num: true, v: r => r[3] ? r[3].roi : -999, r: r => cell(r, 3, "roi") }, { k: "n4", label: "4 Man Stack Count", num: true, v: r => r[4] ? r[4].n : 0, r: r => cell(r, 4, "n") }, { k: "r4", label: "4 Man Stack ROI", num: true, v: r => r[4] ? r[4].roi : -999, r: r => cell(r, 4, "roi") }, { k: "n5", label: "5 Man Stack Count", num: true, v: r => r[5] ? r[5].n : 0, r: r => cell(r, 5, "n") }, { k: "r5", label: "5 Man Stack ROI", num: true, v: r => r[5] ? r[5].roi : -999, r: r => cell(r, 5, "roi") }], rows, { sort: { k: "r5", d: -1 } });
    wireGrid("sroi", main, mainSim); bot.innerHTML = ""; return; }
  if (t === "favs") { const rows = S.favOrder.filter(i => res && res.rows[i]).map(i => res.rows[i]);
    if (!rows.length) { main.innerHTML = `<div class="empty">No Lineups have been favorited</div>`; bot.innerHTML = favBot(); wireFavBot(); return; }
    main.innerHTML = `<div class="tool"><div class="grow"></div><span class="hint">${rows.length} favorites</span></div>` + grid("favs", [{ k: "roi", label: "Simulated ROI", sticky: "l", cls: r => "roi " + (r.roi >= 0 ? "pos" : "neg"), r: r => roiCell(r) }, { k: "proj", label: "Projected FP", num: true, r: r => r.proj.toFixed(2) }, { k: "own", label: "OwnSum", num: true, r: r => pctS(r.own) }, { k: "teams", label: "Stack", cls: "ctr" }, { k: "type", label: "Stack Type", cls: "ctr" }, { k: "lu", label: "Lineups", sortable: false, r: r => luCell(r.lu, P, f) }, { k: "sal", label: "Salary", num: true, r: r => "$" + r.sal.toLocaleString() }, { k: "fav", label: "", sortable: false, sticky: "r", cls: "ctr", r: r => `<span class="heart on" data-fav="${r.i}">♥</span>` }], rows, { sort: { k: "roi", d: -1 } });
    wireGrid("favs", main, mainSim); $$("#main [data-fav]").forEach(el => el.addEventListener("click", () => { toggleFav(+el.getAttribute("data-fav")); mainSim(); })); bot.innerHTML = favBot("favs"); wireFavBot("favs"); return; }
  if (t === "sd") {
    const c = S.contest, sd = S.sd, pretty = k => { const [cp, split, kd, qb] = k.split("|"); return `${cp} captain · ${split} · ${kd.replace("K/D", " K/DST")} · ${qb.replace("QB", " QB")}`; };
    if (!c) { main.innerHTML = `<div class="empty">Generate a contest first (Contest Generator).<small>Structures are ranked against that field: rare in it, yet close to the best projection.</small></div>`; bot.innerHTML = ""; return; }
    const head = `<div class="tool"><span class="hint">Every legal lineup within 10% of the best projection, grouped by structure (captain position · team split · kickers+defenses · QBs). Share is how much of the generated field uses the structure; dupes and "differs by" compare a lineup with that field. Pick a rare structure whose best is near the top, then the lineup inside it that shares the least.</span><div class="grow"></div><button class="btn sec" id="sdRun"${S.busy ? " disabled" : ""}>${sd ? "Recompute" : "Find structures"}</button></div>`;
    if (!sd) { main.innerHTML = head + `<div class="empty">No structures computed yet.<small>Takes a few seconds and runs in the background.</small></div>`; bot.innerHTML = ""; $("#sdRun").addEventListener("click", runStructures); return; }
    const rows = sd.rows.map(r => ({ ...r, best: r.lineups[0], dupes: r.lineups[0].dupes, nearest: r.lineups[0].nearest, score: r.optimal - r.share }));
    const pick = S.sdPick && sd.rows.find(r => r.structure === S.sdPick);
    let html = head + grid("sdst", [
      { k: "structure", label: "Structure", sticky: "l", r: r => `<button class="lnk" data-sd="${esc(r.structure)}"${r.structure === S.sdPick ? ' style="color:#fff;font-weight:700"' : ""}>${esc(pretty(r.structure))}</button>` },
      { k: "share", label: "Field share", num: true, r: r => pctS(r.share) }, { k: "optimal", label: "Best vs optimum", num: true, r: r => pctS(r.optimal) },
      { k: "dupes", label: "Dupes of best", num: true }, { k: "nearest", label: "Differs by", num: true }, { k: "own", label: "OwnSum", num: true, v: r => r.best.own, r: r => pctS(r.best.own, 0) },
      { k: "lu", label: "Best lineup", sortable: false, r: r => luCell(r.best.lu, P, f) }], rows, { sort: { k: "score", d: -1 } });
    if (pick) html += `<div class="tool" style="margin-top:12px"><b>${esc(pretty(pick.structure))}</b><span class="hint">· ${pick.lineups.length} lineups within 10% of the optimum · "differs by" is players not shared with the closest field lineup</span></div>` + grid("sdlu", [
      { k: "proj", label: "Projected FP", num: true, r: r => r.proj.toFixed(2) }, { k: "opt", label: "vs optimum", num: true, r: r => pctS(r.opt) }, { k: "own", label: "OwnSum", num: true, r: r => pctS(r.own, 0) },
      { k: "dupes", label: "Dupes in field", num: true, r: r => r.dupes == null ? "—" : r.dupes }, { k: "nearest", label: "Differs by", num: true, r: r => r.nearest == null ? "—" : r.nearest },
      { k: "sal", label: "Salary", num: true, r: r => "$" + r.sal.toLocaleString() }, { k: "lu", label: "Lineup", sortable: false, r: r => luCell(r.lu, P, f) },
      { k: "add", label: "", sortable: false, sticky: "r", cls: "ctr", r: r => `<button class="lnk" data-sdadd="${r.i}">${r.added ? "added" : "+ add"}</button>` }],
      pick.lineups.map((l, i) => ({ ...l, i, opt: 100 * l.proj / (sd.top || 1), added: S.LU.some(x => sigOf(x, f) === sigOf(l.lu, f)) })), { sort: { k: "proj", d: -1 } });
    main.innerHTML = html;
    wireGrid("sdst", main, mainSim); if (pick) wireGrid("sdlu", main, mainSim);
    $("#sdRun").addEventListener("click", runStructures);
    $$("#main [data-sd]").forEach(el => el.addEventListener("click", () => { S.sdPick = el.getAttribute("data-sd"); mainSim(); }));
    $$("#main [data-sdadd]").forEach(el => el.addEventListener("click", () => { const l = pick.lineups[+el.getAttribute("data-sdadd")]; if (!S.LU.some(x => sigOf(x, f) === sigOf(l.lu, f))) { S.LU.push(l.lu.slice()); S.luSource = "structures"; S.res = null; } render(); }));
    bot.innerHTML = `<div class="bot"><span class="hint">${S.LU.length} lineups in your set</span><div class="grow"></div><button class="btn" id="run3"${S.contest && S.LU.length && !S.busy ? "" : " disabled"}>Run Contest Simulation</button></div>`; $("#run3").addEventListener("click", runSim);
    return;
  }
  if (t === "expo") {
    const src = S.favs.size ? S.favOrder.map(i => S.LU[i]) : [], N = src.length, c = S.contest, FN = c ? c.field.length : 0;
    if (!N) { main.innerHTML = `<div class="empty">No Lineups have been favorited<small>Exposures are measured across your favorited lineups.</small></div>`; bot.innerHTML = favBot(); wireFavBot(); return; }
    const toggle = `<div class="grow"></div><label class="sw${S.stackExpo ? " on" : ""}" id="swStack">Stack Exposures <i></i></label>`;
    if (!S.stackExpo) { const mine = {}; src.forEach(l => l.forEach(id => mine[id] = (mine[id] || 0) + 1)); const pr = {}; (res ? res.players : []).forEach(r => pr[r.id] = r.roi);
      const rows = filterPlayers(P).filter(p => mine[p.i]).map(p => ({ p, name: p.name, team: p.team, opp: p.opp, sal: p.sal, roi: pr[p.i], proj: p.proj, pown: c ? c.expo[p.i] / FN * 100 : p.own, exp: mine[p.i] / N * 100 })).map(r => Object.assign(r, { lev: r.exp - r.pown }));
      main.innerHTML = posTool("expo", mainSim, toggle) + grid("expo", [{ k: "name", label: "Player", sticky: "l", r: r => nameCell(r.p) }, { k: "team", label: "Team", r: r => teamCell(r.team) }, { k: "opp", label: "Opponent", r: r => teamCell(r.opp) }, { k: "pos", label: "Position", v: r => r.p.pos, r: r => esc(r.p.posList.join("/")) }, { k: "sal", label: "Salary", num: true, r: r => r.sal.toLocaleString() }, { k: "roi", label: "Simulated Player ROI", info: true, num: true, r: r => pctS(r.roi) }, { k: "proj", label: "Projected FP", info: true, num: true, r: r => r.proj.toFixed(2) }, { k: "pown", label: "Pool Own", info: true, num: true, r: r => pctS(r.pown) }, { k: "exp", label: "Exposure", info: true, num: true, r: r => pctS(r.exp) }, { k: "lev", label: "Leverage", info: true, num: true, r: r => diffS(r.lev) }], rows, { sort: { k: "exp", d: -1 } });
      wirePosTool("expo", mainSim); wireGrid("expo", main, mainSim);
    } else { const mine = {}, fld = {}; src.forEach(l => { for (const [tm, n] of stackTeams(l, P, f)) if (n >= 3) mine[tm + "|" + n] = (mine[tm + "|" + n] || 0) + 1; }); if (c) c.field.forEach(l => { for (const [tm, n] of stackTeams(l, P, f)) if (n >= 3) fld[tm + "|" + n] = (fld[tm + "|" + n] || 0) + 1; });
      const keys = [...new Set(Object.keys(mine).concat(Object.keys(fld)))], rows = keys.map(k => { const [team, size] = k.split("|"); return { team, size: +size, exp: (mine[k] || 0) / N * 100, pown: FN ? (fld[k] || 0) / FN * 100 : 0 }; }).map(r => Object.assign(r, { lev: r.exp - r.pown }));
      main.innerHTML = `<div class="tool">${toggle}</div>` + grid("sexpo", [{ k: "team", label: "Team", r: r => teamCell(r.team) }, { k: "size", label: "Stack Size", num: true }, { k: "pown", label: "Pool Exposure", num: true, r: r => pctS(r.pown) }, { k: "exp", label: "Your Exposure", num: true, r: r => pctS(r.exp) }, { k: "lev", label: "Leverage", num: true, r: r => diffS(r.lev) }], rows, { sort: { k: "exp", d: -1 } }); wireGrid("sexpo", main, mainSim); }
    $("#swStack").addEventListener("click", () => { S.stackExpo = !S.stackExpo; mainSim(); }); bot.innerHTML = favBot(); wireFavBot(); return;
  }
}
function renderQF() {
  const el = $("#qfMenu"); if (!el) return; if (S.pop !== "qf") { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="menu"><div class="row"><span class="i" style="display:inline-block;width:12px;height:12px;border:1px solid var(--muted);border-radius:50%;font-size:9px;line-height:10px;text-align:center;color:var(--muted)">i</span> Uniques: <small class="hint">(Max 9)</small><input class="txt" id="qfU" value="${S.cfg.uniques || 0}" style="width:60px;padding:2px 5px;min-height:0"></div><div class="row"><label class="sw${S.cfg.qfScore ? " on" : ""}" id="qfScore">Rank by Score <i></i></label></div>${[300, 150, 100, 50, 20].map(n => `<button data-qf="${n}">Favorite Top ${n} Lineups</button>`).join("")}<button data-qf="custom">Favorite Custom Amount</button><button data-qf="0">Un-Favorite All</button></div>`;
  $("#qfU").addEventListener("change", e => { S.cfg.uniques = Math.max(0, Math.min(9, +e.target.value || 0)); saveCfg(); });
  $("#qfScore").addEventListener("click", () => { S.cfg.qfScore = !S.cfg.qfScore; saveCfg(); renderQF(); });
  $$("#qfMenu [data-qf]").forEach(b => b.addEventListener("click", () => { let n = b.getAttribute("data-qf"); if (n === "custom") { n = prompt("How many lineups to favorite?", "30"); if (!n) return; } n = +n; S.pop = null; if (n > 0) quickFavorite(n, !!S.cfg.qfScore); else { S.favs = new Set(); S.favOrder = []; } mainSim(); }));
}

/* ---------- Review ---------- */
function renderReview() {
  const rv = S.review, have = k => rv.files[k] ? "✓" : "—";
  $("#ctl").innerHTML = `<div class="ctl">${ctlField("League", `<select class="sel" id="league"><option value="mlb"${S.league === "mlb" ? " selected" : ""}>⚾ MLB</option><option value="nfl"${S.league === "nfl" ? " selected" : ""}>🏈 NFL</option><option value="cfb"${S.league === "cfb" ? " selected" : ""}>🏈 CFB</option></select>`)}${ctlField("Slate date", `<input type="date" class="txt" data-cfg="rvDate" style="width:150px">`)}${ctlField("Contest name", `<input type="text" class="txt" data-cfg="rvName" style="width:240px" placeholder="e.g. 09-10 $30K Perfect Game">`)}<div class="f"><label>Post-contest files &nbsp;<span class="hint">Lineups ${have("lineup")} · Players ${have("player")} · Stacks ${have("stack")}</span></label><label class="btn sec" style="cursor:pointer">Upload Post-Contest CSVs<input type="file" id="fileRv" accept=".csv,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel" hidden multiple></label></div><div class="f wide cta"><label>&nbsp;</label><button class="btn gen" id="btnGrade"${rv.files.lineup && rv.files.player && !S.busy ? "" : " disabled"}>Grade Selection Rules</button></div></div>`;
  $("#league").addEventListener("change", e => { S.league = e.target.value; store.set("league", S.league); render(); });
  $$("[data-cfg]").forEach(el => { const k = el.getAttribute("data-cfg"); el.value = S.cfg[k] ?? ""; el.addEventListener("change", () => { S.cfg[k] = el.value; saveCfg(); }); });
  $("#fileRv").addEventListener("change", async e => { for (const fl of Array.from(e.target.files)) { const t = await readFile(fl), h = t.slice(0, 400).toLowerCase(); if (h.includes("sim lineup roi")) rv.files.lineup = t; else if (h.includes("sim player roi")) rv.files.player = t; else if (h.includes("stack roi")) rv.files.stack = t; else setStatus("Not a post-contest file: " + fl.name, true); } render(); });
  $("#btnGrade").addEventListener("click", gradeReview);
  $("#tabs").innerHTML = tabsHtml("review", [["grade", "This Contest"], ["all", "All Contests", rv.history.length || ""]]); wireTabs("review");
  mainReview();
}
function mainReview() {
  const main = $("#main"), rv = S.review, hist = rv.history; $("#bot").innerHTML = "";
  const gcols = [{ k: "name", label: "Rule", r: r => `${esc(r.name)}${r.name === DEFAULT_RULE ? ' <span class="hint">(default)</span>' : ""}` }, { k: "spearman", label: "Rank correlation with actual", num: true, r: r => r.spearman.toFixed(3) }, { k: "cashHits", label: "Cash hits vs random", num: true, r: r => r.cashHits.toFixed(2) + "×" }, { k: "real10", label: "Realized ROI of top 10%", num: true, r: r => diffS(r.real10) }, { k: "real3", label: "Realized ROI of top 3", num: true, r: r => diffS(r.real3) }];
  if (S.tab.review === "grade") { if (!rv.result) { main.innerHTML = `<div class="empty">No contest graded yet.<small>Upload the three Stokastic post-contest CSVs, set the date, and grade.</small></div>`; return; }
    const r = rv.result, rows = Object.keys(r.grades).map(k => Object.assign({ name: k }, r.grades[k]));
    main.innerHTML = `<div class="tool"><span class="hint"><b style="color:#fff">${esc(r.name)}</b> · ${r.N} entries, ${r.paid} paid · whole field averaged ${diffS(r.fieldROI)}${r.unmatched ? ` · ${r.unmatched} players without a team match` : ""}</span></div>` + grid("grade", gcols, rows, { sort: { k: "real10", d: -1 } }); wireGrid("grade", main, mainReview); return; }
  if (!hist.length) { main.innerHTML = `<div class="empty">No contests graded yet.</div>`; return; }
  const agg = {}; hist.forEach(c => { for (const k in c.grades) { const a = agg[k] || (agg[k] = { name: k, n: 0, spearman: 0, cashHits: 0, real10: 0, real3: 0 }); a.n++; for (const m of ["spearman", "cashHits", "real10", "real3"]) a[m] += c.grades[k][m]; } });
  const rows = Object.values(agg).map(a => ({ name: a.name, n: a.n, spearman: a.spearman / a.n, cashHits: a.cashHits / a.n, real10: a.real10 / a.n, real3: a.real3 / a.n }));
  main.innerHTML = `<div class="tool"><span class="hint">${hist.length} contest${hist.length === 1 ? "" : "s"} · field averaged ${diffS(mean(hist.map(c => c.fieldROI)))} · ${hist.map(c => esc(c.name)).join(", ")}</span><div class="grow"></div><button class="btn ghost" id="rvClear">Clear history</button></div>` + grid("gradeAll", gcols.concat([{ k: "n", label: "Contests", num: true }]), rows, { sort: { k: "real10", d: -1 } });
  wireGrid("gradeAll", main, mainReview); $("#rvClear").addEventListener("click", () => { if (confirm("Clear all graded contests?")) { rv.history = []; store.set("reviewHistory", []); rv.result = null; render(); } });
}

/* ---------- modals ---------- */
function openModal(kind) { S.modal = kind; renderModal(); }
function closeModal() { S.modal = null; renderModal(); }
function renderModal() {
  const root = $("#modal"); if (!S.modal) { root.innerHTML = ""; return; }
  const P = S.pool ? S.pool.players : [], f = F(), k = S.modal, c = S.cfg;
  const wrap = (title, body, foot, small) => `<div class="ov" id="ov"><div class="modal${small ? " sm" : ""}"><div class="mh"><span>${title}</span><button class="x" id="mx">×</button></div><div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ""}</div></div>`;
  const fld = (label, inner) => `<div class="field"><label>${label}</label>${inner}</div>`;
  const inp = (key, attrs = "") => `<input class="txt" style="width:100%" data-m="${key}" value="${esc(c[key] ?? "")}" ${attrs}>`;
  let html = "";
  if (k === "teams") {
    const games = {}; P.forEach(p => { if (!p.team) return; const g = [p.team, p.opp].filter(Boolean).sort().join(" @ "); (games[g] = games[g] || new Set()).add(p.team); });
    const row = t => `<div class="crow"><button class="del" data-tr="${t}" title="${S.teamCtl.removed[t] ? "Restore team" : "Remove team from slate"}" style="color:${S.teamCtl.removed[t] ? "#ff8a8a" : "var(--red)"}">${S.teamCtl.removed[t] ? "⊕" : "⊖"}</button>${teamCell(t)}<span class="hint">${S.teamCtl.removed[t] ? "removed" : ""}</span><div class="grow"></div><span class="hint">Boost offense</span><span class="step"><button class="m" data-tb="${t}|-10">−</button><input data-tbv="${t}" value="${S.teamCtl.boost[t] || 0}">%<button class="p" data-tb="${t}|10">+</button></span></div>`;
    html = wrap(`Team Controls - ${esc(S.projName || "slate")}`, `<div class="hint">Remove teams from the slate before creating a contest, or boost team offenses (ownership) for the next generation.</div><div class="search" style="display:flex;gap:6px;background:#0f1f3f;border:1px solid var(--line2);border-radius:4px;padding:6px 9px">🔍<input id="tq" placeholder="Search Teams" style="background:none;border:0;color:#fff;width:100%;outline:none"></div><div id="tlist" style="display:flex;flex-direction:column;gap:8px">${Object.keys(games).sort().map(g => `<div class="note"><b>${esc(g)}</b>${[...games[g]].map(row).join("")}</div>`).join("")}</div>`, `<button class="btn ghost" id="tClear">Clear Selections</button><div class="grow"></div><button class="btn" id="tSet">Set Team Controls</button>`);
  } else if (k === "payout") {
    html = wrap("Custom Payouts", `<div class="hint">Use the exact contest instead of a percent-to-first preset. Paste the payout list from the DraftKings contest page.</div><div class="grid2">${fld("Entry fee $", inp("fee", 'type="number" step="0.01"'))}${fld("Rake % (for the preset curve)", inp("rake", 'type="number"'))}</div>${fld("Payout table", `<textarea class="txt" data-m="payText" placeholder="1st&#10;$10,000&#10;2nd&#10;$5,000&#10;6th - 8th&#10;$800">${esc(c.payText || "")}</textarea>`)}<div class="hint" id="payHint"></div>`, `<div class="grow"></div><button class="btn ghost" id="payPct">Use percent to first instead</button><button class="btn" id="payApply">Apply</button>`, true);
  } else if (k === "build") {
    html = wrap("Build Lineups", `<div class="hint">Builds your own lineups from the loaded projections. They replace any uploaded lineup file.</div><div class="grid3">${fld("How many", inp("n", 'type="number"'))}${fld("Objective", `<select class="sel" data-m="obj"><option value="proj"${c.obj === "proj" ? " selected" : ""}>Projection</option><option value="blend"${c.obj === "blend" ? " selected" : ""}>Projection + ceiling</option><option value="ceil"${c.obj === "ceil" ? " selected" : ""}>Ceiling</option></select>`)}${fld("Randomness %", inp("rand", 'type="number"'))}${fld("Max exposure %", inp("maxExp", 'type="number"'))}${fld("Min salary", inp("bMinSal", 'type="number" step="100"'))}${fld("Min unique", inp("minUniq", 'type="number"'))}${f.sport === "mlb" ? fld("Primary stack", `<select class="sel" data-m="stackSize"><option value="0"${+c.stackSize === 0 ? " selected" : ""}>Free</option><option value="3"${+c.stackSize === 3 ? " selected" : ""}>3-man</option><option value="4"${+c.stackSize === 4 ? " selected" : ""}>4-man</option><option value="5"${+c.stackSize === 5 ? " selected" : ""}>5-man</option></select>`) : ""}${fld("Seed", inp("simSeed", 'type="number"'))}</div><div class="grid2">${fld("Force players (comma separated)", `<textarea class="txt" data-m="force" style="min-height:60px">${esc(c.force || "")}</textarea>`)}${fld("Exclude players", `<textarea class="txt" data-m="exclude" style="min-height:60px">${esc(c.exclude || "")}</textarea>`)}</div>`, `<div class="grow"></div><button class="btn" id="buildGo">Build</button>`);
  } else if (k === "filters") {
    const ft = S.filt, types = f.sport === "mlb" ? STACK_TYPES.concat(["Unstacked"]) : [...new Set((S.res ? S.res.rows : []).map(r => r.type))];
    html = wrap("Lineup Filters", `<div class="grid3">${fld("Projected FP min", `<input class="txt" style="width:100%" data-f="projMin" value="${esc(ft.projMin)}">`)}${fld("Projected FP max", `<input class="txt" style="width:100%" data-f="projMax" value="${esc(ft.projMax)}">`)}${fld("Salary min", `<input class="txt" style="width:100%" data-f="salMin" value="${esc(ft.salMin)}">`)}${fld("OwnSum min", `<input class="txt" style="width:100%" data-f="ownMin" value="${esc(ft.ownMin)}">`)}${fld("OwnSum max", `<input class="txt" style="width:100%" data-f="ownMax" value="${esc(ft.ownMax)}">`)}</div>${fld("Stack types", `<div style="display:flex;gap:6px;flex-wrap:wrap">${types.map(t => `<label class="sw${ft.types[t] ? " on" : ""}" data-ft="${t}"><i></i>${t}</label>`).join("")}</div>`)}<div class="grid2">${fld("Must include players", `<textarea class="txt" data-f="incl" style="min-height:56px">${esc(ft.incl)}</textarea>`)}${fld("Exclude players", `<textarea class="txt" data-f="excl" style="min-height:56px">${esc(ft.excl)}</textarea>`)}</div>`, `<button class="btn ghost" id="fClear">Clear</button><div class="grow"></div><button class="btn" id="fApply">Apply</button>`);
  } else if (k === "players") {
    const rows = filterPlayers(P).filter(p => p.own > 0 || S.plCap[p.i] != null || S.plBoost[p.i]);
    html = wrap("Players — exposure caps and ROI boosts", `<div class="hint">Caps limit how often Quick Favorite uses a player across your favorites. Boosts add to a lineup's ROI for ranking only.</div><div class="search" style="display:flex;gap:6px;background:#0f1f3f;border:1px solid var(--line2);border-radius:4px;padding:6px 9px">🔍<input id="pq" placeholder="Search Players" value="${esc(S.filt.q)}" style="background:none;border:0;color:#fff;width:100%;outline:none"></div><div class="tw" style="max-height:50vh"><table><thead><tr><th class="na">Player</th><th class="na">Team</th><th class="na">Pos</th><th class="na num">Own %</th><th class="na num">Max exposure %</th><th class="na num">ROI boost</th></tr></thead><tbody>${rows.map(p => `<tr><td>${nameCell(p)}</td><td>${teamCell(p.team)}</td><td>${esc(p.posList.join("/"))}</td><td class="num">${pctS(p.own)}</td><td class="num"><input class="txt" style="width:70px;padding:2px 5px;min-height:0" data-cap="${p.i}" value="${S.plCap[p.i] ?? ""}" placeholder="—"></td><td class="num"><input class="txt" style="width:70px;padding:2px 5px;min-height:0" data-pb="${p.i}" value="${S.plBoost[p.i] || ""}" placeholder="0"></td></tr>`).join("")}</tbody></table></div>`, `<button class="btn ghost" id="pClear">Clear all</button><div class="grow"></div><button class="btn" id="pDone">Done</button>`);
  } else if (k === "entry") {
    const favs = S.favOrder.filter(i => S.LU[i]);
    const groups = {}; S.dk.entries.forEach(e => { const g = groups[e.contest] || (groups[e.contest] = { name: e.contest, fee: e.fee, feeN: e.feeN, entries: [] }); g.entries.push(e); });
    const glist = Object.values(groups).sort((a, b) => S.dk.sort === "fee" ? b.feeN - a.feeN : b.entries.length - a.entries.length);
    const filled = S.dk.entries.filter(e => e.lu != null).length;
    html = wrap("Entry Manager", (S.dk.entries.length ? `<div class="crow" style="background:#0d2a1a"><span style="color:var(--red);font-size:16px">♥</span><b>${favs.length} Favorite Lineups</b><div class="grow"></div><span class="hint">Select the contest(s) you want to apply these favorited lineups to.</span><span class="ok">✓</span></div>` : `<div class="note" style="display:flex;align-items:center;gap:12px"><div><b>Upload CSV</b>You need to upload your DraftKings CSV entry file to add lineups to the Entry Manager.</div><div class="grow"></div><label class="btn" style="cursor:pointer">Upload CSV<input type="file" id="fileDk" accept=".csv,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel" hidden></label></div><div class="hint">Don't have the CSV? On DraftKings, open the contest lobby and use "Export lineups to CSV" or download the entries file.</div>`) +
      (S.dk.entries.length ? `<div style="display:flex;align-items:center;gap:12px"><b>My Contests</b><span class="hint">${esc(S.dk.name)}</span><label class="btn ghost" style="cursor:pointer">Edit CSV<input type="file" id="fileDk" accept=".csv,text/csv,text/plain,text/comma-separated-values,application/vnd.ms-excel" hidden></label><div class="grow"></div><button class="btn ghost" id="emClear">Clear all lineups 🗑</button></div><div style="display:flex;gap:16px;align-items:center;font-size:12.5px">Sort: <label><input type="radio" name="emsort" value="fee"${S.dk.sort === "fee" ? " checked" : ""}> Entry Fee</label><label><input type="radio" name="emsort" value="entries"${S.dk.sort === "entries" ? " checked" : ""}> Entries</label></div>` +
        glist.map(g => { const done = g.entries.filter(e => e.lu != null).length; return `<div class="crow"><span class="nm">${esc(g.name)}</span><span class="fee">${esc(g.fee)}/entry</span><div class="grow"></div><span class="cnt">${done}/${g.entries.length} Lineups</span>${done ? `<span class="ok">✓</span><button class="del" data-emdel="${esc(g.name)}">🗑</button>` : `<button class="plus" data-emadd="${esc(g.name)}"${favs.length ? "" : " disabled"}>+</button>`}</div>`; }).join("") : ""),
      S.dk.entries.length ? `<span><b>${glist.length} Contests</b> &nbsp; ${filled}/${S.dk.entries.length} Lineups</span><label class="sw${S.dk.dupes ? " on" : ""}" id="emDupes"><i></i>Enable Duplicate Lineups</label><div class="grow"></div><button class="btn sec" id="emDl"${filled ? "" : " disabled"}>Download Entry File ⬇</button><button class="btn" id="emSave">Save and Continue</button>` : "");
  } else if (k === "backup") {
    html = wrap("Backup", `<div class="hint">Everything lives in this browser. Export to move it to your phone or another machine, then import there.</div><div style="display:flex;gap:10px"><button class="btn sec" id="bkExp">Export data</button><label class="btn sec" style="cursor:pointer">Import data<input type="file" id="bkImp" accept=".json" hidden></label><button class="btn ghost" id="bkClear">Clear projections</button></div>`, "", true);
  }
  root.innerHTML = html; if (!html) return;
  $("#mx").addEventListener("click", closeModal); $("#ov").addEventListener("click", e => { if (e.target.id === "ov") closeModal(); });
  $$("#modal [data-m]").forEach(el => el.addEventListener("change", () => { S.cfg[el.getAttribute("data-m")] = el.value; saveCfg(); }));
  if (k === "teams") {
    $$("#modal [data-tr]").forEach(b => b.addEventListener("click", () => { const t = b.getAttribute("data-tr"); if (S.teamCtl.removed[t]) delete S.teamCtl.removed[t]; else S.teamCtl.removed[t] = 1; renderModal(); }));
    $$("#modal [data-tb]").forEach(b => b.addEventListener("click", () => { const [t, d] = b.getAttribute("data-tb").split("|"); S.teamCtl.boost[t] = (S.teamCtl.boost[t] || 0) + (+d); if (!S.teamCtl.boost[t]) delete S.teamCtl.boost[t]; renderModal(); }));
    $$("#modal [data-tbv]").forEach(i => i.addEventListener("change", () => { const t = i.getAttribute("data-tbv"); S.teamCtl.boost[t] = +i.value || 0; if (!S.teamCtl.boost[t]) delete S.teamCtl.boost[t]; }));
    $("#tq").addEventListener("input", e => { const q = e.target.value.toLowerCase(); $$("#tlist .note").forEach(n => n.hidden = q && !n.textContent.toLowerCase().includes(q)); });
    $("#tClear").addEventListener("click", () => { S.teamCtl = { removed: {}, boost: {} }; renderModal(); });
    $("#tSet").addEventListener("click", () => { closeModal(); setStatus(`Team controls set: ${Object.keys(S.teamCtl.removed).length} removed, ${Object.keys(S.teamCtl.boost).length} boosted. Generate to apply.`); });
  } else if (k === "payout") {
    const hint = () => { const N = S.contest ? S.contest.N : +c.pool || 500; const p = parsePayoutTable($('[data-m="payText"]').value, N); $("#payHint").textContent = paidCount(p) ? `${paidCount(p)} paid of ${N} · pays ${money(payoutSum(p))} · first ${money(p[0])}` : "Paste a payout table to use custom payouts."; }; hint(); $('[data-m="payText"]').addEventListener("input", hint);
    $("#payApply").addEventListener("click", () => { S.cfg.payMode = "custom"; saveCfg(); if (S.contest) { const { pay, fee } = payoutsFor(S.contest.N); S.contest.pay = pay; S.contest.fee = fee; S.contest.paidN = paidCount(pay); S.res = null; } closeModal(); render(); });
    $("#payPct").addEventListener("click", () => { S.cfg.payMode = "pct"; saveCfg(); closeModal(); render(); });
  } else if (k === "build") { $("#buildGo").addEventListener("click", () => { buildMine(); closeModal(); render(); }); }
  else if (k === "filters") {
    $$("#modal [data-f]").forEach(el => el.addEventListener("change", () => { S.filt[el.getAttribute("data-f")] = el.value; }));
    $$("#modal [data-ft]").forEach(el => el.addEventListener("click", () => { const t = el.getAttribute("data-ft"); S.filt.types[t] = !S.filt.types[t]; el.classList.toggle("on", !!S.filt.types[t]); }));
    $("#fClear").addEventListener("click", () => { S.filt = Object.assign(S.filt, { projMin: "", projMax: "", ownMin: "", ownMax: "", salMin: "", types: {}, incl: "", excl: "" }); renderModal(); });
    $("#fApply").addEventListener("click", () => { ts("lineups").page = 0; closeModal(); mainSim(); });
  } else if (k === "players") {
    $("#pq").addEventListener("input", e => { S.filt.q = e.target.value; renderModal(); const q = $("#pq"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
    $$("#modal [data-cap]").forEach(i => i.addEventListener("change", () => { const id = +i.getAttribute("data-cap"); if (i.value === "") delete S.plCap[id]; else S.plCap[id] = +i.value; }));
    $$("#modal [data-pb]").forEach(i => i.addEventListener("change", () => { const id = +i.getAttribute("data-pb"); if (!(+i.value)) delete S.plBoost[id]; else S.plBoost[id] = +i.value; }));
    $("#pClear").addEventListener("click", () => { S.plCap = {}; S.plBoost = {}; renderModal(); }); $("#pDone").addEventListener("click", () => { closeModal(); mainSim(); });
  } else if (k === "entry") {
    const fd = $("#fileDk"); if (fd) fd.addEventListener("change", async e => { const fl = e.target.files[0]; if (fl) loadDK(await readFile(fl), fl.name); renderModal(); });
    $$("#modal [name=emsort]").forEach(r => r.addEventListener("change", () => { S.dk.sort = r.value; renderModal(); }));
    const favs = S.favOrder.filter(i => S.LU[i]);
    $$("#modal [data-emadd]").forEach(b => b.addEventListener("click", () => { const name = b.getAttribute("data-emadd"); const used = new Set(S.dk.entries.filter(e => e.lu != null).map(e => e.lu)); let k2 = 0;
      S.dk.entries.filter(e => e.contest === name).forEach(e => { let pick = null; for (let tries = 0; tries < favs.length; tries++) { const cand = favs[(k2 + tries) % favs.length]; if (S.dk.dupes || !used.has(cand)) { pick = cand; k2 += tries + 1; break; } } if (pick != null) { e.lu = pick; used.add(pick); } }); renderModal(); }));
    $$("#modal [data-emdel]").forEach(b => b.addEventListener("click", () => { const name = b.getAttribute("data-emdel"); S.dk.entries.filter(e => e.contest === name).forEach(e => e.lu = null); renderModal(); }));
    const cl = $("#emClear"); if (cl) cl.addEventListener("click", () => { S.dk.entries.forEach(e => e.lu = null); renderModal(); });
    const dp = $("#emDupes"); if (dp) dp.addEventListener("click", () => { S.dk.dupes = !S.dk.dupes; renderModal(); });
    const dl = $("#emDl"); if (dl) dl.addEventListener("click", () => { const ex = entriesCSV(); if (ex.bad) setStatus(`${ex.bad} player IDs were not found in the DraftKings file.`, true); download("DKEntries-upload.csv", ex.csv); });
    const sv = $("#emSave"); if (sv) sv.addEventListener("click", () => { closeModal(); setStatus(`Entry Manager: ${S.dk.entries.filter(e => e.lu != null).length} of ${S.dk.entries.length} entries assigned.`); });
  } else if (k === "backup") {
    $("#bkExp").addEventListener("click", () => download("slate-lab-backup.json", store.exportAll()));
    $("#bkImp").addEventListener("change", async e => { const fl = e.target.files[0]; if (!fl) return; try { store.importAll(await readFile(fl)); location.reload(); } catch (err) { setStatus(err.message, true); } });
    $("#bkClear").addEventListener("click", () => { S.pool = null; S.projText = ""; S.projName = ""; S.tsText = ""; S.share = null; S.tsRows = null; S.contest = null; S.res = null; S.LU = []; store.del("projText"); store.del("projName"); store.del("tsText"); closeModal(); render(); });
  }
}

/* ================= boot ================= */
window.SL = S;
document.addEventListener("click", e => { if (S.pop && e.target.isConnected && !e.target.closest("#popStacks,#qfMenu,#btnStacks,#qf")) { S.pop = null; renderStackPop(); renderQF(); } });
if (S.projText) loadProjections(S.projText, S.projName, true);
if (S.tsText) loadTopstacks(S.tsText, true);
render();
