// Slate Lab app: Slate -> Contest generator -> Pre-contest sim -> Review.
import { parseCSV, nrm, num } from "../engine/csv.mjs";
import { FORMATS, detect, autoMap, buildPool, FIELDS } from "../engine/formats.mjs";
import { sigOf, salOf, projOf, ownSum, stackOf, matchLineups } from "../engine/lineups.mjs";
import { fitPayouts, parsePayoutTable, paidCount, payoutSum } from "../engine/payouts.mjs";
import { buildLineups } from "../engine/build.mjs";
import { featurize, selectScore, gradeRules, RULES, DEFAULT_RULE } from "../engine/select.mjs";
import { recoverContest } from "../engine/recover.mjs";
import { sigmaFor } from "../engine/model.mjs";
import { $, $$, esc, fmt, money, pct, signed, heat, table, wireTable, copyText, wireDrop, download } from "./ui.mjs";
import * as store from "./store.mjs";

/* ---------------- state ---------------- */
const S = {
  screen: "slate", fkey: store.get("fkey", "mlb_cl"),
  projText: store.get("projText", ""), projName: store.get("projName", ""), tsText: store.get("tsText", ""),
  pool: null, share: null, mapOverride: null,
  contest: null, LU: [], luNote: "", fieldMode: false, res: null, favs: new Set(),
  dk: { entries: [], ids: {}, name: "" }, gate: store.get("gate", 50),
  cfg: Object.assign({
    entries: 1000, fee: 20, payText: "", pool$: 0, first$: 0, paidPct: 22,
    arch: "marquee", conc: 1.25, minSal: 49000, boost: 1.0, s5: 60, s4: 32, s3: 8, rounds: 3, seed: 1,
    wP: 50, wO: 50,
    n: 20, obj: "blend", rand: 18, maxExp: 60, bMinSal: 0, minUniq: 1, stackSize: 0, force: "", exclude: "",
    iters: 5000, simSeed: 1,
    rvDate: new Date().toISOString().slice(0, 10), rvName: ""
  }, store.get("cfg", {})),
  tab: { gen: "players", sim: "lineups" },
  ts: { pool: { sort: { k: "proj", d: -1 }, page: 0, per: 100 }, ranker: { sort: { k: "ovr", d: 1 }, page: 0, per: 100 }, fplayers: { sort: { k: "tot", d: -1 }, page: 0, per: 250 },
        lineups: { sort: { k: "score", d: -1 }, page: 0, per: 100 }, proi: { sort: { k: "roi", d: -1 }, page: 0, per: 250 }, expo: { sort: { k: "fp", d: -1 }, page: 0, per: 250 } },
  review: { files: {}, result: null, history: store.get("reviewHistory", []) },
  busy: null
};
const ARCH = { low: { conc: 1.0, minSal: 47500, boost: 0.6 }, marquee: { conc: 1.25, minSal: 49000, boost: 1.0 }, high: { conc: 1.6, minSal: 49300, boost: 1.5 } };
const F = () => FORMATS[S.fkey];
const saveCfg = () => store.set("cfg", S.cfg);

/* ---------------- worker ---------------- */
let worker = null, jobId = 0; const jobs = {};
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  worker.onmessage = e => { const m = e.data, j = jobs[m.id]; if (!j) return;
    if (m.type === "log") j.onLog && j.onLog(m.line);
    else if (m.type === "progress") j.onProgress && j.onProgress(m.done, m.total);
    else if (m.type === "done") { delete jobs[m.id]; j.resolve(m.result); }
    else if (m.type === "error") { delete jobs[m.id]; j.reject(new Error(m.message)); } };
  worker.onerror = e => { for (const id in jobs) { jobs[id].reject(new Error(e.message || "worker error")); delete jobs[id]; } };
  return worker;
}
function runJob(msg, hooks = {}) {
  return new Promise((resolve, reject) => { const id = ++jobId; jobs[id] = Object.assign({ resolve, reject }, hooks); getWorker().postMessage(Object.assign({ id }, msg)); });
}
const poolForWorker = () => ({ players: S.pool.players, teams: S.pool.teams, games: S.pool.games, src: S.pool.src, format: S.pool.format });

/* ---------------- data loading ---------------- */
function loadProjections(text, name, silent) {
  const rows = parseCSV(text); if (rows.length < 2) return status("slate", "That file has no rows.");
  const headers = rows[0].map(s => String(s).trim());
  try {
    const map = S.mapOverride && S.mapOverride.name === name ? S.mapOverride.map : autoMap(headers);
    S.pool = buildPool(headers, rows.slice(1), S.fkey, map);
    S.pool.headers = headers; S.pool.rows = rows.slice(1); S.pool.map = map; S.pool.name = name || "";
    S.projText = text; S.projName = name || ""; store.set("projText", text); store.set("projName", S.projName);
    S.contest = null; S.res = null; S.LU = []; S.favs = new Set(); S.luNote = "";
    if (S.tsText) loadTopstacks(S.tsText, true);
    if (!silent) status("slate", `${S.pool.players.length} players · ${S.pool.teams.length} teams · ${S.pool.games.length} game${S.pool.games.length === 1 ? "" : "s"} · ${detect(headers) || "custom layout, auto-mapped"}`);
  } catch (e) { S.pool = null; status("slate", `<span style="color:var(--bad)">${esc(e.message)}</span>`); }
}
function loadTopstacks(text, silent) {
  const rows = parseCSV(text); if (rows.length < 2) return;
  const h = rows[0].map(s => String(s).toLowerCase().trim()), ti = h.indexOf("team"), si = h.findIndex(x => x.includes("top stack"));
  if (ti < 0 || si < 0) { if (!silent) status("slate", "Top stacks file not recognised (needs Team and Top Stack % columns)."); return; }
  const share = {}; rows.slice(1).forEach(r => { const t = String(r[ti] || "").trim().toUpperCase(); const v = num(r[si]); if (t && v != null) share[t] = v; });
  S.share = share; S.tsText = text; store.set("tsText", text);
  if (!silent) status("slate", `Top stacks loaded for ${Object.keys(share).length} teams.`);
}
function loadLineupsCSV(text) {
  if (!S.pool) return;
  const rows = parseCSV(text); if (!rows.length) return;
  const f = F(), first = rows[0].map(s => String(s).trim().toUpperCase());
  const hdrLike = first.every(x => /^(CPT|CAPTAIN|FLEX|QB|RB|WR|TE|DST|P|C|1B|2B|3B|SS|OF|UTIL)$/.test(x));
  let body = hdrLike ? rows.slice(1) : rows;
  // Stokastic / DK exports: find the slot columns by header
  if (!hdrLike) { const hi = rows[0].map(s => String(s).trim()); const start = hi.findIndex((x, i) => x.toUpperCase() === f.slots[0] && hi[i + 1] && hi[i + 1].toUpperCase() === f.slots[1]); if (start >= 0) body = rows.slice(1).map(r => r.slice(start, start + f.slots.length)); }
  const m = matchLineups(body, S.pool.players, f);
  S.LU = m.lineups; S.fieldMode = false; S.res = null; S.favs = new Set();
  const miss = Object.keys(m.missing);
  S.luNote = `${m.lineups.length} of ${body.length} matched` + (miss.length ? ` · <span style="color:var(--bad)">missing: ${esc(miss.slice(0, 3).join(", "))}${miss.length > 3 ? " +" + (miss.length - 3) : ""}</span>` : "");
}
function loadDK(text, fname) {
  const rows = parseCSV(text); let hdr = -1, base = -1;
  for (let r = 0; r < rows.length && hdr < 0; r++) for (let c = 0; c < rows[r].length; c++) if (String(rows[r][c]).trim() === "Name + ID") { hdr = r; base = c; break; }
  const ids = {}, entries = [];
  if (hdr >= 0) for (let r = hdr + 1; r < rows.length; r++) { const row = rows[r], nm = String(row[base + 1] || "").trim(), id = String(row[base + 2] || "").trim(), rp = String(row[base + 3] || "").trim();
    if (!nm || !/^\d+$/.test(id)) continue; const k = nrm(nm); if (!ids[k]) ids[k] = { ids: {}, any: id }; ids[k].ids[rp] = id; if (rp !== "CPT") ids[k].any = id; }
  rows.forEach(rw => { if (!/^\d+$/.test(String(rw[0] || "").trim())) return; entries.push({ id: String(rw[0]).trim(), contest: String(rw[1] || "").trim(), cid: String(rw[2] || "").trim(), fee: String(rw[3] || "").trim(), lu: null }); });
  S.dk = { entries, ids, name: fname || "DKEntries.csv" };
}
function dkIdFor(p, slot) { const e = S.dk.ids[p.key]; if (!e) return null; if (F().mult) return slot === 0 ? (e.ids.CPT || e.any) : (e.ids.FLEX || e.any); return e.any; }
function entriesCSV() {
  const f = F(), out = ["Entry ID,Contest Name,Contest ID,Entry Fee," + f.slots.join(",")]; let bad = 0;
  for (const en of S.dk.entries) { if (en.lu == null || !S.LU[en.lu]) continue; const ids = S.LU[en.lu].map((id, j) => { const x = dkIdFor(S.pool.players[id], j); if (!x) bad++; return x || ""; }); out.push([en.id, en.contest, en.cid, en.fee].concat(ids).join(",")); }
  return { csv: out.length > 1 ? out.join("\n") : "", bad, n: out.length - 1 };
}

/* ---------------- contest generation ---------------- */
function currentPayouts() {
  const c = S.cfg, N = Math.max(2, Math.round(+c.entries || 2));
  if (c.payText && c.payText.trim()) { const p = parsePayoutTable(c.payText, N); if (paidCount(p)) return p; }
  return fitPayouts(N, +c.pool$ || 0, +c.first$ || 0, +c.paidPct || 22);
}
async function generateContest() {
  if (!S.pool || S.busy) return;
  const c = S.cfg, N = Math.max(2, Math.round(+c.entries || 2)), f = F();
  const s5 = +c.s5 || 0, s4 = +c.s4 || 0, s3 = +c.s3 || 0, tot = (s5 + s4 + s3) || 1;
  const opt = { conc: +c.conc || 1.25, minSal: +c.minSal || 0, boost: +c.boost || 0, rounds: Math.max(0, Math.round(+c.rounds || 0)),
    sizes: { 5: s5 / tot, 4: s4 / tot, 3: s3 / tot }, stackTeams: S.share && Object.keys(S.share).length ? S.share : null };
  S.busy = "gen"; const log = []; status("gen", `Generating ${N.toLocaleString()} entries…`); progress("gen", 5);
  try {
    const t0 = performance.now();
    const g = await runJob({ type: "genField", pool: poolForWorker(), n: N, opt, seed: +c.seed || 1 }, { onLog: line => { log.push(line); status("gen", esc(line)); progress("gen", Math.min(90, 10 + log.length * 20)); } });
    if (!g.field.length) throw new Error("No lineups could be built with these settings. Lower the salary floor or check positions.");
    const P = S.pool.players, field = g.field, sig = {}; let uniq = 0, top = 0, topKey = "";
    for (const l of field) { const k = sigOf(l, f); sig[k] = (sig[k] || 0) + 1; }
    for (const k in sig) { uniq++; if (sig[k] > top) { top = sig[k]; topKey = k; } }
    const pay = currentPayouts();
    const M = field.length, proj = new Float64Array(M), own = new Float64Array(M), sal = new Float64Array(M), dup = new Int32Array(M), st = new Array(M);
    for (let i = 0; i < M; i++) { const l = field[i]; proj[i] = projOf(l, P, f); own[i] = ownSum(l, P, f); sal[i] = salOf(l, P, f); dup[i] = sig[sigOf(l, f)] - 1; st[i] = stackOf(l, P, f); }
    const rank = (arr, desc) => { const idx = arr.map((v, i) => i).sort((a, b) => desc ? arr[b] - arr[a] : arr[a] - arr[b]); const r = new Int32Array(M); idx.forEach((i, k) => r[i] = k + 1); return r; };
    S.contest = { N, fee: +c.fee || 0, pay, paidN: paidCount(pay), field, expo: g.expo, cC: g.cC, cF: g.cF, log: g.log, opt, seed: +c.seed || 1, uniq, top, topKey, sig,
      rk: { proj, own, sal, dup, st, pr: rank(proj, true), or: rank(own, true) }, ms: performance.now() - t0, stacks: buildStacks(field, P, f, st) };
    rankOverall();
    S.res = null; S.tab.gen = "ranker";
    status("gen", `Contest ready — ${field.length.toLocaleString()} entries in ${(S.contest.ms / 1000).toFixed(1)}s, ${uniq.toLocaleString()} unique. ${g.log[g.log.length - 1] || ""}`); progress("gen", 100);
  } catch (e) { status("gen", `<span style="color:var(--bad)">${esc(e.message)}</span>`); progress("gen", 0); }
  S.busy = null; render();
}
function rankOverall() {
  const c = S.contest; if (!c) return; const M = c.field.length, w = ((+S.cfg.wP || 0) + (+S.cfg.wO || 0)) || 1;
  const ov = new Float64Array(M); for (let i = 0; i < M; i++) ov[i] = ((+S.cfg.wP || 0) * c.rk.pr[i] + (+S.cfg.wO || 0) * c.rk.or[i]) / w;
  const idx = ov.map((v, i) => i).sort((a, b) => ov[a] - ov[b]); const ovr = new Int32Array(M); idx.forEach((i, k) => ovr[i] = k + 1);
  c.rk.ov = ov; c.rk.ovr = ovr;
}
function buildStacks(field, P, f, st) {
  const N = field.length, types = {}, maxStack = {}, cptPos = {}, s = { n: N, hasQB: 0, qbStack: 0, bring: 0, bothQB: 0, noQB: 0, hasK: 0, hasDST: 0, dstVsQB: 0, punt: 0, pitchVsStack: 0, fiveStack: 0 };
  for (let i = 0; i < N; i++) {
    const l = field[i], k = st[i]; (types[k] = types[k] || { n: 0, proj: 0, own: 0, sal: 0 }); types[k].n++;
    types[k].proj += projOf(l, P, f); types[k].own += ownSum(l, P, f); types[k].sal += salOf(l, P, f);
    const tc = {}, qb = {}, pass = {}, dst = {}; let mx = 0, nQB = 0, nK = 0, nDST = 0, minSal = 1e9; const pOpp = {};
    for (let j = 0; j < l.length; j++) { const p = P[l[j]];
      if (p.team && !(f.sport === "mlb" && p.isP)) { tc[p.team] = (tc[p.team] || 0) + 1; if (tc[p.team] > mx) mx = tc[p.team]; }
      if (p.pos === "QB") { nQB++; qb[p.team] = 1; } if (p.pos === "WR" || p.pos === "TE") pass[p.team] = 1;
      if (p.pos === "K") nK++; if (p.pos === "DST") { nDST++; dst[p.team] = 1; }
      if (f.sport === "mlb" && p.isP && p.opp) pOpp[p.opp] = 1;
      const cost = (f.mult && j === 0) ? p.csal : p.sal; if (cost < minSal) minSal = cost; }
    maxStack[mx] = (maxStack[mx] || 0) + 1;
    if (f.mult) { const cp = P[l[0]].pos; cptPos[cp] = (cptPos[cp] || 0) + 1; }
    if (f.sport === "nfl") { if (nQB) s.hasQB++; else s.noQB++; if (nQB >= 2) s.bothQB++;
      let stk = false, br = false, dq = false; for (const t in qb) { if (pass[t]) stk = true; const o = P.find(p => p.team === t)?.opp; if (o && pass[o]) br = true; }
      for (const t in dst) { const o = P.find(p => p.team === t)?.opp; if (o && qb[o]) dq = true; }
      if (stk) s.qbStack++; if (br) s.bring++; if (dq) s.dstVsQB++; if (nK) s.hasK++; if (nDST) s.hasDST++; if (minSal <= 1000) s.punt++; }
    if (f.sport === "mlb") { if (mx >= 5) s.fiveStack++; for (const t in tc) if (pOpp[t]) { s.pitchVsStack++; break; } }
  }
  return { types, maxStack, cptPos, s };
}

/* ---------------- simulation ---------------- */
function buildMine() {
  if (!S.pool) return; const c = S.cfg, P = S.pool.players;
  const byName = txt => String(txt || "").split(/[,\n;]+/).map(s => nrm(s)).filter(Boolean).map(k => P.findIndex(p => p.key === k)).filter(i => i >= 0);
  const r = buildLineups(S.pool, { n: Math.max(1, +c.n || 20), obj: c.obj, rand: Math.max(0, +c.rand || 0) / 100, maxExp: Math.max(5, +c.maxExp || 60), minSal: +c.bMinSal || 0,
    minUniq: Math.max(0, +c.minUniq || 0), stackSize: +c.stackSize || 0, force: byName(c.force), exclude: byName(c.exclude) }, mulberrySeed(+c.simSeed || 1));
  if (r.err) { S.luNote = `<span style="color:var(--bad)">${esc(r.err)}</span>`; return; }
  S.LU = r.lineups; S.fieldMode = false; S.res = null; S.favs = new Set();
  S.luNote = `${r.lineups.length} built` + (r.lineups.length < +c.n ? ` <span style="color:var(--warn)">— constraints capped it below ${c.n}</span>` : "");
  S.dk.entries.forEach(e => e.lu = null);
}
function mulberrySeed(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
async function runSim() {
  if (!S.pool || !S.contest || !S.LU.length || S.busy) return;
  const c = S.contest, iters = Math.max(100, Math.round(+S.cfg.iters || 5000));
  S.busy = "sim"; status("sim", "Scoring…"); progress("sim", 2);
  try {
    const t0 = performance.now();
    const res = await runJob({ type: "simulate", pool: poolForWorker(), field: S.fieldMode ? [] : c.field, lineups: S.LU, payouts: c.pay, entries: c.N, fee: c.fee, iters, seed: +S.cfg.simSeed || 1, fieldMode: S.fieldMode },
      { onProgress: (d, t) => { progress("sim", d / t * 100); status("sim", `Simulating — ${d.toLocaleString()} / ${t.toLocaleString()}`); } });
    res.feats = featurize(res.rows); applyScore(res);
    S.res = res; S.tab.sim = "lineups"; S.ts.lineups.page = 0;
    status("sim", `Done — ${iters.toLocaleString()} iterations in ${((performance.now() - t0) / 1000).toFixed(1)}s against ${res.FS.toLocaleString()} contest entries${S.fieldMode ? " (the field against itself)" : " plus your " + S.LU.length + " lineup" + (S.LU.length === 1 ? "" : "s")}.`);
    progress("sim", 100);
  } catch (e) { status("sim", `<span style="color:var(--bad)">${esc(e.message)}</span>`); progress("sim", 0); }
  S.busy = null; render();
}
function applyScore(res) { const sc = selectScore(res.feats, +S.gate || 0); res.rows.forEach((r, i) => { r.score = sc[i]; r.rProj = res.feats[i].rProj; }); }

/* ---------------- review ---------------- */
async function gradeReview() {
  const rv = S.review; if (!rv.files.lineup || !rv.files.player || S.busy) return;
  S.busy = "review"; render(); status("review", "Looking up teams and opponents from the MLB stats API…"); progress("review", 5);
  try {
    let teamOf = null, teamNote = "";
    try { teamOf = await store.mlbTeamLookup(S.cfg.rvDate); } catch (e) { teamNote = " MLB lookup failed (" + (e.name === "AbortError" ? "timed out" : e.message) + "); graded without teams, so no stack correlation."; }
    status("review", "Rebuilding the field…"); progress("review", 30);
    const rc = recoverContest(rv.files.lineup, rv.files.player, teamOf, S.fkey === "nfl_sd" ? "nfl_sd" : "mlb_cl");
    if (rc.entries.length < 10) throw new Error(`Only ${rc.entries.length} entries could be rebuilt from the lineup file.`);
    status("review", `Simulating ${rc.entries.length} real entries…`);
    const res = await runJob({ type: "simulate", pool: rc.pool, field: [], lineups: rc.entries.map(e => e.lu), payouts: rc.payouts, entries: rc.entries.length, fee: 1, iters: 4000, seed: 1, fieldMode: true },
      { onProgress: (d, t) => progress("review", d / t * 100) });
    const feats = featurize(res.rows.map((r, i) => ({ proj: rc.entries[i].stkFP, roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: rc.entries[i].own, stkROI: rc.entries[i].stkROI, actFP: rc.entries[i].actFP, actROI: rc.entries[i].actROI, finish: rc.entries[i].finish })));
    const grades = gradeRules(feats, rc.paid, { "Stokastic ROI": f => f.stkROI });
    const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const summary = { name: S.cfg.rvName || `${S.cfg.rvDate} contest`, date: S.cfg.rvDate, N: rc.entries.length, paid: rc.paid, fieldROI: mean(rc.entries.map(e => e.actROI)), unmatched: rc.unmatched.length, grades, when: Date.now() };
    rv.result = summary;
    rv.history = rv.history.filter(h => h.name !== summary.name).concat([summary]); store.set("reviewHistory", rv.history);
    S.status_review = `Graded ${rc.entries.length} entries, ${rc.paid} paid.${rc.unmatched.length ? " " + rc.unmatched.length + " players had no team match." : ""}${esc(teamNote)}`;
  } catch (e) { S.status_review = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  S.busy = null; render(); progress("review", 100);
}

/* ---------------- rendering ---------------- */
function status(scr, html) { const el = $("#status-" + scr); if (el) el.innerHTML = html; S["status_" + scr] = html; }
function progress(scr, p) { const el = $("#prog-" + scr); if (el) el.style.width = p + "%"; }
function chips() {
  const f = F(), c = S.contest; let h = `<span class="chip">${f.label}</span>`;
  h += `<span class="chip${S.pool ? " on" : ""}">${S.pool ? esc(S.pool.src) + " ✓ " + S.pool.players.length : "projections —"}</span>`;
  h += `<span class="chip${c ? " on" : ""}">contest${c ? " ✓ " + c.N.toLocaleString() : " —"}</span>`;
  h += `<span class="chip${S.LU.length ? " on" : ""}">lineups${S.LU.length ? " ✓ " + S.LU.length.toLocaleString() : " —"}</span>`;
  if (S.favs.size) h += `<span class="chip on">★ ${S.favs.size}</span>`;
  return h;
}
const SCREENS = [["slate", "Slate"], ["gen", "Contest generator"], ["sim", "Pre-contest sim"], ["review", "Review"]];
function render() {
  const app = $("#app");
  app.innerHTML = `<header class="topbar"><div class="brand">SLATE <span>LAB</span></div><div class="tagline">your own contest sims</div><div class="grow"></div><div id="chips">${chips()}</div>
    <div class="screens">${SCREENS.map(([k, l], i) => `<button class="scr" data-scr="${k}" aria-selected="${S.screen === k}"><span class="step">${i + 1}</span>${l}</button>`).join("")}</div></header>
    <div class="layout"><aside class="rail" id="rail"></aside><section id="main"></section></div>`;
  $$(".scr").forEach(b => b.addEventListener("click", () => { S.screen = b.getAttribute("data-scr"); render(); }));
  ({ slate: renderSlate, gen: renderGen, sim: renderSim, review: renderReview })[S.screen]();
  bindCfg();
}
function bindCfg() {
  $$("[data-cfg]").forEach(el => {
    const k = el.getAttribute("data-cfg"); if (el.type === "checkbox") el.checked = !!S.cfg[k]; else el.value = S.cfg[k] ?? "";
    el.addEventListener("change", () => { S.cfg[k] = el.type === "checkbox" ? el.checked : el.value; saveCfg(); if (el.hasAttribute("data-rerender")) renderMain(); });
  });
}
function renderMain() { ({ slate: mainSlate, gen: mainGen, sim: mainSim, review: mainReview })[S.screen](); $("#chips").innerHTML = chips(); }
const field = (label, inner) => `<div class="field"><label>${label}</label>${inner}</div>`;
const inp = (k, attrs = "") => `<input type="number" data-cfg="${k}" ${attrs}>`;
const panel = (title, body, extra = "") => `<div class="panel"><div class="phead"><span>${title}</span>${extra}</div><div class="pbody">${body}</div></div>`;
const drop = (id, title, hint) => `<label class="drop" id="drop-${id}"><strong>${title}</strong><div class="hint" style="margin-top:3px">${hint}</div><input type="file" id="file-${id}" accept=".csv,text/csv" multiple></label>`;
const empty = (h3, p) => `<div class="empty"><h3>${h3}</h3>${p || ""}</div>`;
const tabs = (scr, list) => `<div class="tabs">${list.map(([k, l, n]) => `<button class="tab" data-tab="${k}" aria-selected="${S.tab[scr] === k}">${l}${n ? `<span class="n">${n}</span>` : ""}</button>`).join("")}</div>`;
function wireTabs(scr) { $$("#main .tab").forEach(t => t.addEventListener("click", () => { S.tab[scr] = t.getAttribute("data-tab"); renderMain(); })); }
function railStatus(scr) { return `<div class="prog"><i id="prog-${scr}"></i></div><div id="status-${scr}" class="hint">${S["status_" + scr] || ""}</div>`; }

/* ---- Slate ---- */
function renderSlate() {
  $("#rail").innerHTML = panel("Slate", field("Contest format", `<select id="fkey">${Object.values(FORMATS).map(f => `<option value="${f.key}"${S.fkey === f.key ? " selected" : ""}>${f.label}</option>`).join("")}</select>`) +
    drop("proj", "Load projections CSV", "Stokastic Data Hub, ETR, Blick or any CSV with name, position, salary, projection, ownership") +
    (F().sport === "mlb" ? drop("ts", "Load top stacks CSV (optional)", "Stokastic Data Hub Topstacks — sets which teams the field stacks") : "") +
    `<div class="hint">${S.projName ? "Loaded: <strong>" + esc(S.projName) + "</strong>" : "No projections loaded."}${S.share ? " · top stacks ✓" : ""}</div>` +
    `<details id="mapWrap"${S.pool ? "" : " hidden"}><summary>Column mapping</summary><div id="mapUI" style="display:flex;flex-direction:column;gap:7px"></div></details>` +
    `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn ghost" id="btnSample">Load sample slate</button><button class="btn ghost" id="btnClear">Clear</button></div>`) +
    panel("Backup", `<div class="hint">Everything lives in this browser. Export to move it to your phone or another machine.</div><div style="display:flex;gap:6px"><button class="btn ghost" id="btnExport">Export data</button><label class="btn ghost" style="cursor:pointer">Import<input type="file" id="file-import" accept=".json" hidden></label></div>`) +
    railStatus("slate");
  $("#fkey").addEventListener("change", e => { S.fkey = e.target.value; store.set("fkey", S.fkey); S.contest = null; S.res = null; S.LU = []; if (S.projText) loadProjections(S.projText, S.projName, true); render(); });
  wireDrop($("#drop-proj"), $("#file-proj"), (t, n) => { loadProjections(t, n); render(); });
  if ($("#drop-ts")) wireDrop($("#drop-ts"), $("#file-ts"), t => { loadTopstacks(t); render(); });
  $("#btnSample").addEventListener("click", () => { const sp = $('script[data-seed="proj"]'), st = $('script[data-seed="topstacks"]'); if (st) loadTopstacks(st.textContent.trim(), true); if (sp) loadProjections(sp.textContent.trim(), "sample: MLB night slate 2026-09-10"); render(); });
  $("#btnClear").addEventListener("click", () => { S.pool = null; S.projText = ""; S.projName = ""; S.tsText = ""; S.share = null; S.contest = null; S.res = null; S.LU = []; store.del("projText"); store.del("projName"); store.del("tsText"); render(); });
  $("#btnExport").addEventListener("click", () => download("slate-lab-backup.json", store.exportAll()));
  $("#file-import").addEventListener("change", async e => { const fl = e.target.files[0]; if (!fl) return; try { store.importAll(await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(fl); })); location.reload(); } catch (err) { status("slate", esc(err.message)); } });
  if (S.pool) renderMap();
  mainSlate();
}
function renderMap() {
  const H = S.pool.headers, M = S.pool.map; let h = "";
  for (const f of FIELDS) { h += `<div class="field"><label>${f[1]}${["name", "pos", "sal", "proj"].includes(f[0]) ? "" : " (optional)"}</label><select data-map="${f[0]}"><option value="">— none —</option>${H.map((c, i) => `<option value="${i}"${M[f[0]] === i ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></div>`; }
  $("#mapUI").innerHTML = h;
  $$("#mapUI select").forEach(sel => sel.addEventListener("change", () => { const map = Object.assign({}, S.pool.map); const k = sel.getAttribute("data-map"); if (sel.value === "") delete map[k]; else map[k] = +sel.value; S.mapOverride = { name: S.projName, map }; loadProjections(S.projText, S.projName); render(); }));
}
function mainSlate() {
  const main = $("#main"); if (!S.pool) { main.innerHTML = empty("No projections loaded", "Drop a projections CSV in the left rail, or load the sample slate."); return; }
  const P = S.pool.players, f = F(), mlb = f.sport === "mlb";
  const cols = [{ k: "pos", label: "Pos", render: p => `<span class="pos">${esc(p.posList.join("/"))}</span>` }, { k: "name", label: "Player" }, { k: "team", label: "Tm", render: p => `<span class="tm">${esc(p.team || "?")}</span>` }, { k: "opp", label: "Opp", render: p => `<span class="sub">${esc(p.opp || "—")}</span>` }]
    .concat(mlb ? [{ k: "ord", label: "Bat", num: true, render: p => p.ord ? p.ord : '<span class="miss">—</span>' }] : [])
    .concat([{ k: "sal", label: "Salary", num: true, render: p => p.sal.toLocaleString() }]).concat(f.mult ? [{ k: "csal", label: "CPT $", num: true, render: p => p.csal.toLocaleString() }] : [])
    .concat([{ k: "proj", label: "Proj", num: true, render: p => `<input class="ed" type="number" step="0.1" data-i="${p.i}" data-f="proj" value="${p.proj}">` },
      { k: "own", label: "Own %", num: true, render: p => `<input class="ed" type="number" step="0.1" data-i="${p.i}" data-f="own" value="${p.own}">` }])
    .concat(f.mult ? [{ k: "cown", label: "CPT own %", num: true, render: p => `<input class="ed" type="number" step="0.1" data-i="${p.i}" data-f="cown" value="${p.cown}">` }] : [])
    .concat([{ k: "sd", label: "Std dev", num: true, render: p => fmt(p.sd, 2) }, { k: "sig", label: "σ", num: true, sortVal: p => sigmaFor(p, f.sport), render: p => fmt(sigmaFor(p, f.sport), 2) }]);
  main.innerHTML = `<div class="bar"><span class="hint">${P.length} players · ${S.pool.teams.length} teams · ${S.pool.games.map(esc).join(", ")}. Projection and ownership are editable; edits invalidate the generated contest.</span></div>` + table(cols, P, S.ts.pool, { tall: true });
  wireTable(main, S.ts.pool, mainSlate);
  $$("#main input.ed").forEach(i => i.addEventListener("change", () => { const v = parseFloat(i.value); if (isNaN(v)) return; const p = P[+i.getAttribute("data-i")]; p[i.getAttribute("data-f")] = v; p.fown = p.own; S.contest = null; S.res = null; $("#chips").innerHTML = chips(); }));
}

/* ---- Contest generator ---- */
function renderGen() {
  const mlb = F().sport === "mlb";
  $("#rail").innerHTML = panel("Contest", `<div class="row2">${field("Entries", inp("entries", 'min="2"'))}${field("Entry fee $", inp("fee", 'min="0" step="0.01"'))}</div>` +
      field("Payout table (paste from DraftKings)", `<textarea data-cfg="payText" rows="5" placeholder="1st&#10;$10,000&#10;2nd&#10;$5,000&#10;6th - 8th&#10;$800"></textarea>`) +
      `<details><summary>Or fit a curve</summary><div class="row2">${field("Prize pool $", inp("pool$"))}${field("1st place $", inp("first$"))}</div>${field("Paid positions %", inp("paidPct", 'min="1" max="60"'))}</details>` +
      `<div class="hint" id="payHint"></div>`) +
    panel("Field model", field("Contest archetype", `<select data-cfg="arch" id="arch"><option value="low">Low stakes — soft field</option><option value="marquee">Marquee — typical GPP</option><option value="high">High stakes — sharp, full salary</option><option value="custom">Custom</option></select>`) +
      `<div class="row2">${field("Chalk pull", inp("conc", 'min="0.5" max="3" step="0.05"'))}${field("Min salary", inp("minSal", 'step="100"'))}</div>` +
      (mlb ? `<div class="hint">Primary stack size mix (%)</div><div class="row2">${field("5-man", inp("s5"))}${field("4-man", inp("s4"))}</div>${field("3-man", inp("s3"))}` : field("Stack pull", inp("boost", 'min="0" max="4" step="0.1"'))) +
      `<div class="row2">${field("Calibration rounds", inp("rounds", 'min="0" max="8"'))}${field("Seed", inp("seed", 'min="0"'))}</div>` +
      `<div class="hint">${S.share ? "Stack teams follow the loaded top stacks file." : "Stack teams follow ownership mass; load a top stacks file on the Slate screen to set them."}</div>`) +
    `<button class="btn" id="btnGen"${S.pool && !S.busy ? "" : " disabled"}>Generate contest</button>` + railStatus("gen") +
    (S.contest ? `<details><summary>Generation log</summary><div class="hint" style="font-family:var(--mono);white-space:pre-wrap">${esc(S.contest.log.join("\n"))}</div></details>` : "");
  $("#btnGen").addEventListener("click", generateContest);
  $("#arch").addEventListener("change", () => { const a = ARCH[$("#arch").value]; if (!a) return; S.cfg.conc = a.conc; S.cfg.minSal = a.minSal; S.cfg.boost = a.boost; saveCfg(); bindCfg(); });
  const payHint = () => { const p = currentPayouts(); $("#payHint").innerHTML = paidCount(p) ? `${paidCount(p)} paid of ${(+S.cfg.entries || 0).toLocaleString()} · pays ${money(payoutSum(p))} · first ${money(p[0])}` : `<span style="color:var(--warn)">No payouts yet — paste the table or fill the curve.</span>`; };
  payHint(); $$("#rail [data-cfg]").forEach(el => el.addEventListener("change", payHint));
  mainGen();
}
function mainGen() {
  const main = $("#main"), c = S.contest, f = F(), P = S.pool ? S.pool.players : [];
  main.innerHTML = tabs("gen", [["players", "Players", P.length || ""], ["stacks", "Stacks"], ["ranker", "Lineups &amp; ranker", c ? c.N.toLocaleString() : ""]]) + `<div id="out"></div>`;
  wireTabs("gen");
  const out = $("#out");
  if (!S.pool) { out.innerHTML = empty("No projections loaded", "Load a slate first."); return; }
  const t = S.tab.gen;
  if (t === "players") {
    const N = c ? c.field.length : 0, rows = P.map(p => ({ p, tot: c ? c.expo[p.i] / N * 100 : null, cp: c && f.mult ? c.cC[p.i] / N * 100 : null, fl: c ? (f.mult ? c.cF[p.i] / N * 100 : c.expo[p.i] / N * 100) : null, target: f.mult ? p.fown : p.own }));
    rows.forEach(r => { r.diff = r.fl == null ? null : r.fl - r.target; r.name = r.p.name; r.proj = r.p.proj; r.own = r.p.own; r.sal = r.p.sal; });
    const cols = [{ k: "pos", label: "Pos", render: r => `<span class="pos">${esc(r.p.posList.join("/"))}</span>` }, { k: "name", label: "Player" }, { k: "team", label: "Tm", sortVal: r => r.p.team, render: r => `<span class="tm">${esc(r.p.team || "?")}</span>` },
      { k: "sal", label: "Salary", num: true, render: r => r.sal.toLocaleString() }, { k: "proj", label: "Proj", num: true, render: r => fmt(r.proj) }, { k: "own", label: "Proj own %", num: true, render: r => fmt(r.own) }]
      .concat(c ? (f.mult ? [{ k: "cp", label: "Field CPT %", num: true, render: r => fmt(r.cp) }] : []).concat([{ k: "fl", label: f.mult ? "Field flex %" : "Field %", num: true, style: r => heat(r.fl / 100), render: r => fmt(r.fl) }, { k: "diff", label: "Diff", num: true, render: r => signed(r.diff) }, { k: "tot", label: "Field total %", num: true, render: r => fmt(r.tot) }]) : []);
    out.innerHTML = `<div class="bar"><span class="hint">${c ? "How often the generated contest rosters each player. <strong>Diff</strong> is field minus projected ownership; near zero means the field reproduces the ownership you gave it." : "Generate a contest to see field exposure next to each player."}</span></div>` + table(cols, rows, S.ts.fplayers, { tall: true });
    wireTable(out, S.ts.fplayers, mainGen);
  } else if (t === "stacks") {
    if (!c) { out.innerHTML = empty("No contest yet", "Generate the field to see how it stacks."); return; }
    const Sx = c.stacks, N = Sx.s.n, keys = Object.keys(Sx.types).sort((a, b) => Sx.types[b].n - Sx.types[a].n);
    let h = `<div class="bar"><span class="hint">How the ${N.toLocaleString()}-entry field is built. Stack type counts ${f.sport === "mlb" ? "hitters" : "skill players"} by team, largest first.</span></div><div style="border:1px solid var(--rule);border-top:none;background:var(--surface)">` +
      `<div class="sect">Stack types</div><div class="tablewrap" style="border:none;max-height:none"><table><thead><tr><th class="na">Type</th><th class="na num">Lineups</th><th class="na num">% of field</th><th class="na num">Avg proj</th><th class="na num">Avg own sum</th><th class="na num">Avg salary</th></tr></thead><tbody>`;
    keys.slice(0, 30).forEach(k => { const x = Sx.types[k]; h += `<tr><td style="color:var(--accent);font-family:var(--mono)">${esc(k)}</td><td class="num">${x.n.toLocaleString()}</td><td class="num" style="${heat(x.n / N)}">${pct(x.n, N)}</td><td class="num">${(x.proj / x.n).toFixed(1)}</td><td class="num">${(x.own / x.n).toFixed(0)}%</td><td class="num">${money(x.sal / x.n)}</td></tr>`; });
    h += "</tbody></table></div>";
    const cell = (l, v) => `<div class="cell"><span>${l}</span><strong style="font-family:var(--mono);font-size:12px">${v}</strong></div>`;
    if (f.sport === "nfl") { const s = Sx.s; h += `<div class="sect">Structure</div><div class="cgrid">` + [["Has a quarterback", s.hasQB], ["QB with own-team WR/TE", s.qbStack], ["QB with a bring-back", s.bring], ["Both quarterbacks", s.bothQB], ["No quarterback", s.noQB], ["Has a kicker", s.hasK], ["Has a defense", s.hasDST], ["Defense against a rostered QB", s.dstVsQB], ["Uses a $1,000-or-less punt", s.punt]].map(r => cell(r[0], pct(r[1], N))).join("") + "</div>"; }
    if (f.sport === "mlb") { const s = Sx.s; h += `<div class="sect">Structure</div><div class="cgrid">` + cell("Has a 5-man stack", pct(s.fiveStack, N)) + cell("Pitcher facing own stack", pct(s.pitchVsStack, N)) + cell("Unique lineups", pct(c.uniq, N)) + cell("Most duplicated", c.top + "×") + "</div>"; }
    h += `<div class="sect">Largest single-team stack</div><div class="cgrid">` + Object.keys(Sx.maxStack).sort((a, b) => b - a).map(k => cell(k + " from one team", pct(Sx.maxStack[k], N))).join("") + "</div>";
    if (f.mult) h += `<div class="sect">Captain by position</div><div class="cgrid">` + Object.keys(Sx.cptPos).sort((a, b) => Sx.cptPos[b] - Sx.cptPos[a]).map(k => cell(k, pct(Sx.cptPos[k], N))).join("") + "</div>";
    if (f.sport === "mlb") { const byTeam = {}; c.field.forEach(l => { const tc = {}; for (const id of l) { const p = P[id]; if (!p.isP && p.team) tc[p.team] = (tc[p.team] || 0) + 1; } for (const tm in tc) if (tc[tm] >= 3) { const k = tm + "|" + tc[tm]; byTeam[k] = (byTeam[k] || 0) + 1; } });
      const ks = Object.keys(byTeam).sort((a, b) => byTeam[b] - byTeam[a]); h += `<div class="sect">Team stacks in the field</div><div class="cgrid">` + ks.slice(0, 24).map(k => cell(k.replace("|", " ") + "-stack", pct(byTeam[k], N))).join("") + "</div>"; }
    out.innerHTML = h + "</div>";
  } else {
    if (!c) { out.innerHTML = empty("No contest yet", "Set the contest and field model in the left rail, then generate."); return; }
    const rk = c.rk, rows = c.field.map((l, i) => ({ i, l, pr: rk.pr[i], or: rk.or[i], ovr: rk.ovr[i], proj: rk.proj[i], own: rk.own[i], sal: rk.sal[i], st: rk.st[i], dup: rk.dup[i] }));
    const topNames = c.topKey ? c.topKey.replace("#", ",").split(",").map(x => P[+x] ? P[+x].name : "?").join(", ") : "";
    const cols = [{ k: "pr", label: "Proj rank", num: true }, { k: "or", label: "Own rank", num: true }, { k: "ovr", label: "Overall", num: true, render: r => `<strong>${r.ovr.toLocaleString()}</strong>` },
      { k: "proj", label: "Lineup proj", num: true, render: r => r.proj.toFixed(2) }, { k: "own", label: "Total own", num: true, render: r => r.own.toFixed(1) + "%" }, { k: "sal", label: "Salary", num: true, render: r => money(r.sal) },
      { k: "st", label: "Stack", render: r => `<span style="color:var(--accent);font-family:var(--mono);font-size:12px">${esc(r.st)}</span>` }, { k: "dup", label: "Dupes", num: true },
      { k: "l", label: "Lineup", sortable: false, render: r => `<span class="sub" style="color:var(--ink-2)">${r.l.map((id, j) => `<span class="tm" style="font-size:11px;color:var(--muted)">${esc(P[id].team)}</span> ${f.mult && j === 0 ? "<strong>CPT</strong> " : ""}${esc(P[id].name)}`).join(" &middot; ")}</span>` }];
    out.innerHTML = `<div class="bar"><span class="hint">${c.N.toLocaleString()} entries · ${c.uniq.toLocaleString()} unique · most duplicated appears ${c.top}×${topNames ? ` <span class="sub">(${esc(topNames)})</span>` : ""}</span><div class="grow"></div>` +
      `<span class="hint">Overall = proj rank × <input type="number" id="wP" value="${S.cfg.wP}" min="0" max="100" style="width:56px;padding:2px 5px"> % + own rank × <input type="number" id="wO" value="${S.cfg.wO}" min="0" max="100" style="width:56px;padding:2px 5px"> %</span>` +
      `<button class="btn ghost" id="btnExportField">Export CSV</button><button class="btn ghost" id="btnSimField">Simulate the field</button><button class="btn" id="btnToSim" style="width:auto;padding:5px 14px;font-size:12.5px">Simulate my lineups &rarr;</button></div>` + table(cols, rows, S.ts.ranker, { tall: true, pager: true });
    wireTable(out, S.ts.ranker, mainGen);
    const rew = () => { S.cfg.wP = +$("#wP").value || 0; S.cfg.wO = +$("#wO").value || 0; saveCfg(); rankOverall(); S.ts.ranker.page = 0; mainGen(); };
    $("#wP").addEventListener("change", rew); $("#wO").addEventListener("change", rew);
    $("#btnToSim").addEventListener("click", () => { S.screen = "sim"; render(); });
    $("#btnSimField").addEventListener("click", () => { S.LU = c.field.map(l => l.slice()); S.fieldMode = true; S.res = null; S.favs = new Set(); S.luNote = `${S.LU.length.toLocaleString()} contest entries loaded as lineups`; S.screen = "sim"; render(); runSim(); });
    $("#btnExportField").addEventListener("click", () => { const lines = [f.slots.join(",") + ",Proj,Total own,Salary,Stack,Dupes,Proj rank,Own rank,Overall rank"];
      rows.forEach(r => lines.push(r.l.map(id => P[id].name).join(",") + `,${r.proj.toFixed(2)},${r.own.toFixed(1)},${r.sal},${r.st},${r.dup},${r.pr},${r.or},${r.ovr}`)); download("field.csv", lines.join("\n")); });
  }
}

/* ---- Pre-contest sim ---- */
function renderSim() {
  const c = S.contest, mlb = F().sport === "mlb";
  $("#rail").innerHTML = panel("Contest", c ? `<div class="hint"><div style="font-family:var(--cond);font-size:15px;color:var(--ink)">${F().label} · ${c.N.toLocaleString()} entries · $${c.fee}</div><div style="margin-top:4px">${money(payoutSum(c.pay))} paid over ${c.paidN.toLocaleString()} places · first ${money(c.pay[0])}</div><div>${c.uniq.toLocaleString()} unique of ${c.N.toLocaleString()}</div></div>` : `<div class="hint">No contest generated yet. <a href="#" id="goGen" style="color:var(--accent)">Open the contest generator.</a></div>`) +
    panel("Your lineups", `<div class="row2">${field("Build how many", inp("n", 'min="1" max="500"'))}${field("Objective", `<select data-cfg="obj"><option value="proj">Projection</option><option value="blend">Projection + ceiling</option><option value="ceil">Ceiling</option></select>`)}</div>` +
      `<div class="row2">${field("Randomness %", inp("rand", 'min="0" max="60"'))}${field("Max exposure %", inp("maxExp", 'min="5" max="100"'))}</div>` +
      `<div class="row2">${field("Min salary", inp("bMinSal", 'step="100"'))}${field("Min unique", inp("minUniq", 'min="0" max="10"'))}</div>` +
      (mlb ? field("Primary stack size (0 = free)", `<select data-cfg="stackSize"><option value="0">Free</option><option value="3">3-man</option><option value="4">4-man</option><option value="5">5-man</option></select>`) : "") +
      `<div class="row2">${field("Force players", `<textarea data-cfg="force" rows="2" placeholder="names, comma separated"></textarea>`)}${field("Exclude players", `<textarea data-cfg="exclude" rows="2" placeholder="names, comma separated"></textarea>`)}</div>` +
      `<button class="btn" id="btnBuild" style="padding:7px;font-size:13px"${S.pool ? "" : " disabled"}>Build lineups</button><div class="hint" id="luinfo">${S.luNote || ""}</div>` +
      `<details><summary>Or load a lineups CSV</summary>${drop("lu", "Load lineups CSV", "Slot columns by name, Stokastic or DraftKings export")}</details>` +
      `<details><summary>Export lineups</summary><button class="btn ghost" id="btnCopyLu">Copy CSV</button> <button class="btn ghost" id="btnDlLu">Download CSV</button></details>`) +
    panel("Simulation", `<div class="row2">${field("Iterations", inp("iters", 'min="100" max="100000" step="500"'))}${field("Seed", inp("simSeed", 'min="0"'))}</div><div class="hint">Every contest entry and every one of your lineups is scored on the same correlated outcome each iteration. Your lineups rank against each other as well as the field.</div>`) +
    `<button class="btn" id="run"${c && S.LU.length && !S.busy ? "" : " disabled"}>Run simulation</button>` + railStatus("sim");
  const gg = $("#goGen"); if (gg) gg.addEventListener("click", e => { e.preventDefault(); S.screen = "gen"; render(); });
  $("#btnBuild").addEventListener("click", () => { buildMine(); render(); });
  wireDrop($("#drop-lu"), $("#file-lu"), t => { loadLineupsCSV(t); render(); });
  const luCSV = () => [F().slots.join(",")].concat(S.LU.map(l => l.map(id => S.pool.players[id].name).join(","))).join("\n");
  $("#btnCopyLu").addEventListener("click", () => status("sim", copyText(luCSV()) ? "Lineups copied." : "Copy failed."));
  $("#btnDlLu").addEventListener("click", () => download("lineups.csv", luCSV()));
  $("#run").addEventListener("click", runSim);
  mainSim();
}
function mainSim() {
  const main = $("#main"), f = F(), P = S.pool ? S.pool.players : [], res = S.res, mlb = f.sport === "mlb";
  main.innerHTML = tabs("sim", [["lineups", "Lineups", res ? res.rows.length.toLocaleString() : (S.LU.length || "")], ["proi", "Player ROI"]].concat(mlb ? [["sroi", "Stack ROI"]] : []).concat([["expo", "Exposures"], ["ent", "Entries", S.dk.entries.length || ""]])) + `<div id="out"></div>`;
  wireTabs("sim"); const out = $("#out"), t = S.tab.sim;
  if (!S.pool) { out.innerHTML = empty("No projections loaded", "Load a slate first."); return; }
  if (t === "lineups") {
    if (!res) { if (!S.LU.length) { out.innerHTML = empty("No lineups yet", "Build lineups or load a CSV in the left rail."); return; }
      const rows = S.LU.map((l, i) => ({ i, l, proj: projOf(l, P, f), own: ownSum(l, P, f), sal: salOf(l, P, f), st: stackOf(l, P, f) }));
      out.innerHTML = `<div class="bar"><span class="hint">${S.contest ? "Run the simulation to score these against the contest." : "Generate a contest first, then run the simulation."}</span></div>` +
        table([{ k: "i", label: "#", num: true, render: r => r.i + 1 }, { k: "proj", label: "Proj", num: true, render: r => r.proj.toFixed(1) }, { k: "own", label: "Own sum", num: true, render: r => r.own.toFixed(0) + "%" }, { k: "st", label: "Stack" }, { k: "sal", label: "Salary", num: true, render: r => money(r.sal) },
          { k: "l", label: "Lineup", sortable: false, render: r => `<span class="sub">${r.l.map((id, j) => (f.mult && j === 0 ? "★ " : "") + esc(P[id].name)).join(", ")}</span>` }], rows, S.ts.lineups, { tall: true });
      wireTable(out, S.ts.lineups, mainSim); return; }
    const rows = res.rows, lo = Math.min(...rows.map(r => r.roi ?? 0)), hi = Math.max(...rows.map(r => r.roi ?? 0));
    const cols = [{ k: "score", label: "Score", num: true, style: r => r.score > -1e8 ? heat(0.3 + 0.7 * r.rProj) : "", render: r => r.score > -1e8 ? signed(r.score, 0) : '<span class="miss">below gate</span>' },
      { k: "roi", label: "Sim ROI", num: true, style: r => { const t = hi > lo ? (r.roi - lo) / (hi - lo) : 0.5; return `background:linear-gradient(90deg,rgba(${r.roi >= 0 ? "var(--good-rgb)" : "var(--bad-rgb)"},.30) ${(t * 100).toFixed(1)}%,transparent ${(t * 100).toFixed(1)}%)`; }, render: r => signed(r.roi) },
      { k: "proj", label: "Proj FP", num: true, render: r => r.proj.toFixed(2) }, { k: "cash", label: "Cash %", num: true, render: r => r.cash.toFixed(1) }, { k: "t1", label: "Top 1%", num: true, render: r => r.t1.toFixed(2) }, { k: "t10", label: "Top 10%", num: true, render: r => r.t10.toFixed(1) },
      { k: "win", label: "Win %", num: true, render: r => r.win.toFixed(3) }, { k: "avgRank", label: "Avg rank", num: true, render: r => r.avgRank.toFixed(0) }, { k: "own", label: "Own sum", num: true, render: r => r.own.toFixed(0) + "%" }, { k: "dupN", label: "Dupes", num: true }, { k: "stack", label: "Stack" }, { k: "sal", label: "Salary", num: true, render: r => money(r.sal) },
      { k: "lu", label: "Lineup", sortable: false, render: r => `<span class="sub">${r.lu.map((id, j) => (f.mult && j === 0 ? "★ " : "") + esc(P[id].name)).join(", ")}</span>` },
      { k: "fav", label: "", sortable: false, render: r => `<span class="favx" data-i="${r.i}" style="cursor:pointer;color:${S.favs.has(r.i) ? "var(--accent)" : "var(--rule-strong)"}">${S.favs.has(r.i) ? "★" : "☆"}</span>` }];
    const R = res, mm = a => [Math.min(...a), a.reduce((x, y) => x + y, 0) / a.length, Math.max(...a)], rs = mm(rows.map(r => r.roi ?? 0));
    out.innerHTML = `<div class="bar"><span class="hint"><strong>Score</strong> = sim ROI, counted only for lineups in the top <input type="number" id="gate" value="${100 - S.gate}" min="0" max="100" style="width:54px;padding:2px 5px"> % by projection. ROI alone rewards variance; the gate keeps a floor of expected points under it.</span><div class="grow"></div>` +
      `<button class="btn ghost" id="favTop">★ top ${Math.min(20, rows.length)} by score</button><button class="btn ghost" id="favClear">clear ★</button><button class="btn ghost" id="btnDlRes">Export CSV</button></div>` +
      table(cols, rows, S.ts.lineups, { tall: true, pager: true }) +
      `<div class="foot"><div><div class="k">Sim ROI min / avg / max</div><div class="v">${rs[0].toFixed(0)} / ${rs[1].toFixed(0)} / ${rs[2].toFixed(0)}%</div></div><div><div class="k">Portfolio ROI</div><div class="v">${R.proi == null ? "—" : signed(R.proi)}</div></div><div><div class="k">P(≥1 top 1%)</div><div class="v">${R.obs.toFixed(2)}%</div></div><div><div class="k">If independent</div><div class="v">${R.indep.toFixed(2)}%</div></div><div><div class="k">Correlation lift</div><div class="v">${R.lift == null ? "—" : signed(R.lift)}</div></div><div><div class="k">Field</div><div class="v" style="font-size:13px">${R.FS.toLocaleString()} of ${R.FE.toLocaleString()}</div></div><div><div class="k">Engine</div><div class="v" style="font-size:13px">${R.engine === "chol" ? "pairwise" : "factor"}</div></div></div>`;
    wireTable(out, S.ts.lineups, mainSim);
    $("#gate").addEventListener("change", () => { S.gate = Math.max(0, Math.min(100, 100 - (+$("#gate").value || 0))); store.set("gate", S.gate); applyScore(res); mainSim(); });
    $$("#out .favx").forEach(el => el.addEventListener("click", () => { const i = +el.getAttribute("data-i"); if (S.favs.has(i)) S.favs.delete(i); else S.favs.add(i); mainSim(); }));
    $("#favTop").addEventListener("click", () => { rows.slice().sort((a, b) => b.score - a.score).slice(0, 20).forEach(r => S.favs.add(r.i)); mainSim(); });
    $("#favClear").addEventListener("click", () => { S.favs = new Set(); mainSim(); });
    $("#btnDlRes").addEventListener("click", () => { const lines = ["Score,Sim ROI,Proj,Cash%,Top1%,Top10%,Win%,AvgRank,OwnSum,Dupes,Stack,Salary," + f.slots.join(",")];
      rows.forEach(r => lines.push([r.score > -1e8 ? r.score.toFixed(1) : "", r.roi.toFixed(1), r.proj.toFixed(2), r.cash.toFixed(2), r.t1.toFixed(2), r.t10.toFixed(2), r.win.toFixed(3), r.avgRank.toFixed(1), r.own.toFixed(1), r.dupN, r.stack, r.sal].concat(r.lu.map(id => P[id].name)).join(","))); download("sim-results.csv", lines.join("\n")); });
  } else if (t === "proi") {
    if (!res) { out.innerHTML = empty("Run the simulation first", "Player ROI is measured across your lineups."); return; }
    const rows = res.players, best = Math.max(1, Math.abs(rows[0] ? rows[0].roi : 1));
    out.innerHTML = `<div class="bar"><span class="hint">Average simulated ROI of your lineups containing each player.</span></div>` + table([{ k: "name", label: "Player" }, { k: "pos", label: "Pos", render: r => `<span class="pos">${esc(r.pos)}</span>` }, { k: "team", label: "Tm", render: r => `<span class="tm">${esc(r.team || "?")}</span>` }, { k: "n", label: "In", num: true }, { k: "exp", label: "Exp %", num: true, render: r => r.exp.toFixed(0) }, { k: "own", label: "Own %", num: true, render: r => fmt(r.own) }, { k: "roi", label: "Avg ROI", num: true, style: r => heat(Math.max(0, r.roi) / best), render: r => signed(r.roi) }, { k: "win", label: "Sum win %", num: true, render: r => r.win.toFixed(2) }].concat(f.mult ? [{ k: "cpt", label: "As CPT", num: true }] : []), rows, S.ts.proi, { tall: true });
    wireTable(out, S.ts.proi, mainSim);
  } else if (t === "sroi") {
    if (!res) { out.innerHTML = empty("Run the simulation first"); return; }
    let h = `<div class="bar"><span class="hint">Average simulated ROI of your lineups by team stack and size.</span></div><div class="tablewrap"><table><thead><tr><th class="na">Team</th><th class="na num">3-stack n</th><th class="na num">3-stack ROI</th><th class="na num">4-stack n</th><th class="na num">4-stack ROI</th><th class="na num">5-stack n</th><th class="na num">5-stack ROI</th></tr></thead><tbody>`;
    const by = {}; res.stacks.forEach(r => { (by[r.team] = by[r.team] || {})[r.size] = r; });
    Object.keys(by).sort().forEach(tm => { h += `<tr><td><span class="tm">${esc(tm)}</span></td>` + [3, 4, 5].map(s => { const r = by[tm][s]; return `<td class="num">${r ? r.n : "—"}</td><td class="num">${r ? signed(r.roi) : "—"}</td>`; }).join("") + "</tr>"; });
    out.innerHTML = h + "</tbody></table></div>";
  } else if (t === "expo") {
    const mine = {}; S.LU.forEach(l => l.forEach(id => mine[id] = (mine[id] || 0) + 1));
    const c = S.contest, N = c ? c.field.length : 0;
    const rows = P.map(p => ({ p, name: p.name, me: S.LU.length ? (mine[p.i] || 0) / S.LU.length * 100 : null, fp: c ? c.expo[p.i] / N * 100 : null, own: p.own })).filter(r => r.me || r.fp);
    rows.forEach(r => r.diff = r.fp == null ? null : r.fp - r.own);
    out.innerHTML = `<div class="bar"><span class="hint">Your exposure against the generated contest.</span></div>` + table([{ k: "name", label: "Player" }, { k: "pos", label: "Pos", sortVal: r => r.p.pos, render: r => `<span class="pos">${esc(r.p.posList.join("/"))}</span>` }, { k: "team", label: "Tm", sortVal: r => r.p.team, render: r => `<span class="tm">${esc(r.p.team || "?")}</span>` }, { k: "me", label: "Your %", num: true, style: r => r.me != null ? heat(r.me / 100) : "", render: r => fmt(r.me, 0) }, { k: "fp", label: "Field %", num: true, render: r => fmt(r.fp) }, { k: "own", label: "Proj own %", num: true, render: r => fmt(r.own) }, { k: "diff", label: "Diff", num: true, render: r => signed(r.diff) }], rows, S.ts.expo, { tall: true });
    wireTable(out, S.ts.expo, mainSim);
  } else if (t === "ent") {
    if (!S.dk.entries.length) { out.innerHTML = `<div class="bar"><span class="hint">Load the <code>DKEntries.csv</code> DraftKings gives you. It carries your live entries and the player IDs, so the export is upload-ready.</span></div><div style="border:1px solid var(--rule);border-top:none;background:var(--surface);padding:22px">${drop("dk", "Load DKEntries.csv", "from the DK contest lobby").replace('style=""', "")}</div>`;
      wireDrop($("#drop-dk"), $("#file-dk"), (t2, n) => { loadDK(t2, n); mainSim(); }); return; }
    const favs = [...S.favs].filter(i => i < S.LU.length); if (res) favs.sort((a, b) => (res.rows[b].score ?? 0) - (res.rows[a].score ?? 0));
    const by = {}; S.dk.entries.forEach(e => (by[e.contest] = by[e.contest] || []).push(e));
    let h = `<div class="bar"><span class="hint">${S.dk.entries.length} entries · ${favs.length} starred lineup${favs.length === 1 ? "" : "s"} available</span><div class="grow"></div><button class="btn ghost" id="fillFav">Fill from ★ by score</button><button class="btn ghost" id="clearAssign">Clear</button></div><div class="tablewrap"><table><thead><tr><th class="na">Entry</th><th class="na">Contest</th><th class="na num">Fee</th><th class="na">Assigned lineup</th><th class="na">Roster</th></tr></thead><tbody>`;
    Object.keys(by).forEach(cn => by[cn].forEach((e, ix) => { const opts = '<option value="">— none —</option>' + favs.map(i => { const r = res ? res.rows[i] : null; return `<option value="${i}"${e.lu === i ? " selected" : ""}>#${i + 1} ${esc(P[S.LU[i][0]].name)}${r && r.roi != null ? ` (${r.roi > 0 ? "+" : ""}${r.roi.toFixed(0)}%)` : ""}</option>`; }).join("");
      h += `<tr><td>${esc(e.id)}</td><td>${ix === 0 ? esc(cn) : '<span class="sub">↳</span>'}</td><td class="num">${esc(e.fee)}</td><td><select data-e="${esc(e.id)}" style="min-width:230px">${opts}</select></td><td class="sub">${e.lu != null && S.LU[e.lu] ? S.LU[e.lu].map((id, j) => (f.mult && j === 0 ? "★" : "") + esc(P[id].name)).join(", ") : ""}</td></tr>`; }));
    const ex = entriesCSV();
    h += `</tbody></table></div><div class="bar" style="border-top:none"><span class="hint">${ex.n} entr${ex.n === 1 ? "y" : "ies"} filled${ex.bad ? ` · <span style="color:var(--bad)">${ex.bad} player IDs not found in DKEntries.csv</span>` : ""}</span><div class="grow"></div><button class="btn ghost" id="copyEnt">Copy upload CSV</button><button class="btn ghost" id="dlEnt">Download upload CSV</button></div><textarea rows="5" readonly style="border-radius:0;border-top:none">${esc(ex.csv)}</textarea>`;
    out.innerHTML = h;
    $$("#out select[data-e]").forEach(sel => sel.addEventListener("change", () => { const id = sel.getAttribute("data-e"); S.dk.entries.forEach(e => { if (e.id === id) e.lu = sel.value === "" ? null : +sel.value; }); mainSim(); }));
    $("#fillFav").addEventListener("click", () => { S.dk.entries.forEach((e, i) => e.lu = favs.length ? favs[i % favs.length] : null); mainSim(); });
    $("#clearAssign").addEventListener("click", () => { S.dk.entries.forEach(e => e.lu = null); mainSim(); });
    $("#copyEnt").addEventListener("click", () => status("sim", copyText(ex.csv) ? "Upload CSV copied." : "Copy failed."));
    $("#dlEnt").addEventListener("click", () => download("DKEntries-upload.csv", ex.csv));
  }
}

/* ---- Review ---- */
function renderReview() {
  const rv = S.review, have = k => rv.files[k] ? "✓" : "—";
  $("#rail").innerHTML = panel("Post-contest files", drop("rv", "Drop the three Stokastic post-contest CSVs", "Data_Hub_Lineup, Data_Hub_Player, Data_Hub_PlayerExp") +
      `<div class="hint">Lineups ${have("lineup")} · Players ${have("player")} · Stacks ${have("stack")}</div>` +
      `<div class="row2">${field("Slate date", `<input type="date" data-cfg="rvDate">`)}${field("Contest name", `<input type="text" data-cfg="rvName" placeholder="e.g. 09-10 $30K Perfect Game">`)}</div>` +
      `<button class="btn" id="btnGrade"${rv.files.lineup && rv.files.player && !S.busy ? "" : " disabled"}>Grade selection rules</button>`) +
    railStatus("review") +
    panel("What this does", `<div class="hint">Rebuilds the real field from the post-contest export, re-simulates it with the Slate Lab engine, then asks: if you had picked lineups by each rule, how would you have done? Results accumulate across contests so the best rule for the contests you actually play emerges from evidence, not opinion.</div>`);
  wireDrop($("#drop-rv"), $("#file-rv"), (t, n) => { const h = String(t).slice(0, 400).toLowerCase(); if (h.includes("sim lineup roi")) rv.files.lineup = t; else if (h.includes("sim player roi")) rv.files.player = t; else if (h.includes("stack roi")) rv.files.stack = t; else status("review", `Not a post-contest file: ${esc(n)}`); render(); });
  $("#btnGrade").addEventListener("click", gradeReview);
  mainReview();
}
function mainReview() {
  const main = $("#main"), rv = S.review, hist = rv.history;
  const gradeTable = (title, rows, note) => { let h = `<div class="sect">${title}</div><div class="tablewrap" style="border:none;max-height:none"><table><thead><tr><th class="na">Rule</th><th class="na num">Rank correlation with actual</th><th class="na num">Cash hits vs random</th><th class="na num">Realized ROI of top 10%</th><th class="na num">Realized ROI of top 3</th>${note ? '<th class="na num">Contests</th>' : ""}</tr></thead><tbody>`;
    rows.forEach(r => { h += `<tr><td${r.name === DEFAULT_RULE ? ' style="color:var(--accent)"' : ""}>${esc(r.name)}${r.name === DEFAULT_RULE ? " <span class=\"sub\">(default)</span>" : ""}</td><td class="num">${r.spearman.toFixed(3)}</td><td class="num" style="${heat((r.cashHits - 0.5) / 1.5)}">${r.cashHits.toFixed(2)}×</td><td class="num">${signed(r.real10, 0)}</td><td class="num">${signed(r.real3, 0)}</td>${note ? `<td class="num">${r.n}</td>` : ""}</tr>`; });
    return h + "</tbody></table></div>"; };
  let h = "";
  if (rv.result) { const r = rv.result, rows = Object.keys(r.grades).map(k => Object.assign({ name: k }, r.grades[k])).sort((a, b) => b.real10 - a.real10);
    h += `<div class="bar"><span class="hint"><strong>${esc(r.name)}</strong> · ${r.N} entries, ${r.paid} paid · whole field averaged ${signed(r.fieldROI, 0)}${r.unmatched ? ` · ${r.unmatched} players without a team match` : ""}</span></div><div style="border:1px solid var(--rule);border-top:none;background:var(--surface)">` + gradeTable("This contest", rows) + "</div>"; }
  if (hist.length) { const agg = {}; hist.forEach(c => { for (const k in c.grades) { const a = agg[k] || (agg[k] = { name: k, n: 0, spearman: 0, cashHits: 0, real10: 0, real3: 0 }); a.n++; for (const m of ["spearman", "cashHits", "real10", "real3"]) a[m] += c.grades[k][m]; } });
    const rows = Object.values(agg).map(a => ({ name: a.name, n: a.n, spearman: a.spearman / a.n, cashHits: a.cashHits / a.n, real10: a.real10 / a.n, real3: a.real3 / a.n })).sort((a, b) => b.real10 - a.real10);
    h += `<div class="bar" style="margin-top:14px;border-top:1px solid var(--rule)"><span class="hint"><strong>All graded contests</strong> · ${hist.length} contest${hist.length === 1 ? "" : "s"} · field averaged ${signed(hist.reduce((s, c) => s + c.fieldROI, 0) / hist.length, 0)}</span><div class="grow"></div><button class="btn ghost" id="rvClear">Clear history</button></div><div style="border:1px solid var(--rule);border-top:none;background:var(--surface)">` + gradeTable("Average across contests", rows, true) +
      `<div class="sect">Contests</div><div class="cgrid">${hist.map(c => `<div class="cell"><span>${esc(c.name)} · ${c.N} entries</span><strong style="font-family:var(--mono);font-size:12px">${signed(c.fieldROI, 0)}</strong></div>`).join("")}</div></div>`; }
  main.innerHTML = h || empty("No contests graded yet", "Drop a finished contest's three post-contest files in the left rail and grade it.");
  const cl = $("#rvClear"); if (cl) cl.addEventListener("click", () => { if (confirm("Clear all graded contests?")) { rv.history = []; store.set("reviewHistory", []); rv.result = null; render(); } });
}

/* ---------------- boot ---------------- */
window.SL = S;
if (S.projText) loadProjections(S.projText, S.projName, true);
render();
