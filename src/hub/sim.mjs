// Pre-Contest Simulator: the screen where lineups get picked. It always grades the Contest
// Generator's pool (no uploads, no builder). Columns: Lab ROI (the sources' ROIs weighted by
// scorecard accuracy), each source's ROI and rank, Projected FP (Lab blend), OwnSum as the
// generated field plays it, Field vs sites (the ownership model's over/under on the lineup), stack
// type, Win%, Top 1%, Top 10%, Cash%, Dupes, Notes (what the slate guide says about the lineup),
// Grade plus its Rulebook and Notes parts as sortable columns (click any of the three for the breakdown; no Claude),
// lineup, salary, favorite. Hard-rule fails are left out of the list. Tabs: Projections, Lineups,
// Player ROI, Favorites (portfolio overview, quick favorite, DK upload export), Exposures.
import { $, $$, esc, download, readFile } from "../app/ui.mjs";

const pc = (v, d = 1) => v == null || isNaN(v) ? "—" : (+v).toFixed(d) + "%";
const SRC = { stk: "S", etr: "E", blick: "B", mkt: "M" }, LONG = { stk: "Stokastic", etr: "ETR", blick: "Blick", mkt: "Market" };
const favKey = dir => "slatelab:favs:" + dir;
// "the notes back it": 3+ supporting guide notes and none against; with full ETR guides almost every lineup has some support
const notesBack = e => !!(e.notes && !e.notes.against.length && e.notes.for.reduce((t, x) => t + x.names.length, 0) + (e.theses || []).length >= 3);
export function initSim(S) { S.sim = S.sim || {}; Object.assign(S.sim, { data: S.sim.data || null, dir: S.sim.dir || null, busy: false, tab: S.sim.tab || "lineups", q: "", pos: "ALL", notesOnly: !!S.sim.notesOnly, contests: S.sim.contests || null, pct: S.sim.pct || 20, cid: S.sim.cid || "", sort: S.sim.sort || { k: "lab", d: 1 }, favs: S.sim.favs || new Set(), qn: S.sim.qn || 20, minUniq: S.sim.minUniq ?? 1 }); }

export async function renderSim(main, ctx) {
  const { S, api, setMsg, render } = ctx; initSim(S); const G = S.sim; if (G.tab === "em") G.tab = "lineups";
  if (!S.hub) { main.innerHTML = `<div class="empty">Load a slate first<small>Pick the slate and press Refresh on the Data Hub.</small></div>`; $("#tabs").innerHTML = ""; $("#bot").innerHTML = ""; return; }
  if (!G.data || G.dir !== S.hub.dir) { try { G.data = await api(`/api/simrun?dir=${encodeURIComponent(S.hub.dir)}`); } catch { G.data = { rows: [] }; } G.dir = S.hub.dir; try { G.favs = new Set(JSON.parse(localStorage.getItem(favKey(G.dir)) || "[]")); } catch { G.favs = new Set(); } if (G.data.contest) { G.pct = G.data.contest.pct || G.pct; if (G.data.contest.cid) G.cid = String(G.data.contest.cid); } try { G.plan = await api(`/api/plan?dir=${encodeURIComponent(S.hub.dir)}`); } catch { G.plan = { contests: [] }; } }
  if (!G.contests) { try { const c = await api(`/api/contests?dir=${encodeURIComponent(S.hub.dir)}`); G.contests = c.contests.filter(x => x.fee > 0 && x.field > 0 && x.field < 1e6).sort((a, b) => (b.prizePool || 0) - (a.prizePool || 0)).slice(0, 80); } catch { G.contests = []; } }
  // what the current pool was built for (the Contest Generator's field)
  if (G.fieldDir !== S.hub.dir || G.fieldAt !== (S.gen && S.gen.data && S.gen.data.at)) { try { const F = S.gen && S.gen.data && S.gen.data.dir === S.hub.dir ? S.gen.data : await api(`/api/field?dir=${encodeURIComponent(S.hub.dir)}`); G.fieldCfg = F.cfg || null; G.fieldN = F.all ? F.N : (F.N || 0); G.fieldAt = F.at; G.fieldDir = S.hub.dir; if (!G.cid && F.cfg && F.cfg.contest) G.cid = String(F.cfg.contest.cid); } catch { G.fieldCfg = null; } }
  // lineups DraftKings or the engine would never let through are left out; everything else is ranked
  const BLOCK = ["salary_cap", "no_dst_vs_qb", "qb_stack1", "no_self_dupe"];
  const D = G.data, all = D.rows || [], legal = all.filter(e => !(e.broken || []).some(b => BLOCK.includes(b))), srcs = D.sources || [], sd = S.hub.slate.type === "SHOWDOWN";
  // sharp construction (graded on 352 real classic contests, bench/grade-loop-nfl.mjs): QB + 2, bring-back, 4+ chalk on Model own,
  // under $600 left, then ranked by Lab ROI -> top-10% finishes 15% vs the field's 10% and 0.3 real duplicates vs 1.4 for raw
  // projection; sim ROI on its own was no better than the field. Falls back to 3 chalk when the slate is thin.
  const sharp = e => e.stackN >= 2 && e.bring && e.left < 600, strict = legal.filter(e => sharp(e) && e.chalk >= 4), lite = legal.filter(e => sharp(e) && e.chalk >= 3), base = legal.filter(sharp);
  const sharpRows = strict.length >= 20 ? strict : lite.length >= 20 ? lite : base, sharpNote = strict.length >= 20 ? "QB+2, bring-back, 4+ chalk (Model own 20%+), under $600 left" : lite.length >= 20 ? `QB+2, bring-back, 3+ chalk (only ${strict.length} lineups have 4 chalk on this slate), under $600 left` : `QB+2, bring-back, under $600 left (the slate has too few 20%+ players for a chalk rule yet)`;
  const rowsAll = !sd && G.sharpOnly !== false ? sharpRows : legal, hidden = all.length - legal.length;
  const fld = (label, inner) => `<div class="f"><label>${label}</label>${inner}</div>`;
  const head = `<div class="ctl">
    ${fld("Contest", `<select class="sel" id="scid" style="min-width:260px"><option value="">(custom: $20)</option>${G.contests.map(c => `<option value="${c.id}"${String(G.cid) === String(c.id) ? " selected" : ""}>$${c.fee} · ${c.field.toLocaleString()} · ${esc(c.name.replace(/^NFL (Showdown )?/, "").slice(0, 40))}</option>`).join("")}</select>`)}
    ${G.cid ? "" : fld("Percent to First", `<select class="sel" id="spct">${[5, 10, 15, 20, 25, 30, 35, 40].map(p => `<option value="${p}"${+G.pct === p ? " selected" : ""}>${p}%</option>`).join("")}</select>`)}
    ${sizeWarn(G)}
    <div class="stamp">${D.at ? `${esc(D.source)} vs ${D.field.all ? `one ${D.field.N.toLocaleString()}-entry field per source` : `a ${D.field.N.toLocaleString()}-entry field`} (${esc(D.field.arch)})<br>${D.iters.toLocaleString()} draws per source · ${(D.ms / 1000).toFixed(1)}s · first place ${D.contest.first}× · ${D.contest.paidN} paid${hidden ? ` · ${hidden} left out (no QB stack, DST vs own QB, over the cap)` : ""}${D.weights ? `<br>Lab ROI weights ${srcs.map(k => `${SRC[k]} ${(100 * D.weights[k]).toFixed(0)}%`).join(" · ")}` : ""}${D.at && !D.guide ? "<br>no slate guide yet (Notes empty)" : ""}` : "No simulation yet: generate a pool on the Contest Generator, then run"}</div>
    <div class="f cta"><label>&nbsp;</label><button class="btn gen" id="srun"${G.busy ? " disabled" : ""}>${G.busy ? "Simulating…" : "Run Contest Simulation"}</button></div>
    <div class="f"><label>&nbsp;</label><button class="btn sec" id="semopen" title="your contests from the DraftKings entries file, filled from favorites">Entry Manager${emCount(G)}</button></div></div>`;
  $("#tabs").innerHTML = `<div class="tabs">${[["proj", "Projections"], ["lineups", "Lineups", rowsAll.length || ""], ["proi", "Player ROI"], ["favs", "Favorites", G.favs.size || ""], ["expo", "Exposures"]].map(([k, l, n]) => `<button class="tab" data-stab="${k}" aria-selected="${G.tab === k}">${l}${n ? `<span class="n">${n}</span>` : ""}</button>`).join("")}</div>`;
  let body = "";
  if (G.tab === "proj") body = projTable(S, G);
  else if (!rowsAll.length) body = `<div class="empty">Nothing to rank yet<small>Generate a pool on the Contest Generator, then Run Contest Simulation here.</small></div>`;
  else if (G.tab === "proi") body = playersTable(G, D, srcs, sd);
  else if (G.tab === "expo") body = expoTable(G, D, rowsAll);
  else body = lineupTable(G, D, rowsAll, srcs, sd, G.tab === "favs" ? legal.filter(e => G.favs.has(e.sig)) : rowsAll.filter(e => (!G.notesOnly || notesBack(e)) && (!G.q || e.players.some(p => p.name.toLowerCase().includes(G.q.toLowerCase())))), { sharpNote, legal: legal.length, sharpN: sharpRows.length });
  main.innerHTML = head + body + (G.emModal ? emModal(G, legal) : "");
  $("#bot").innerHTML = rowsAll.length ? `<div class="bot">${overview(G, rowsAll)}<div class="grow"></div><span class="hint">Quick favorite</span><input class="txt" id="gqn" type="number" min="1" max="150" value="${G.qn}" style="width:60px"><span class="hint">uniques</span><input class="txt" id="gqu" type="number" min="0" max="9" value="${G.minUniq}" style="width:48px"><button class="btn sec" id="gquick">Top by Lab ROI</button><button class="btn sec" id="sentry" title="assign favorites to contests and export the DraftKings upload">Entry Manager</button><button class="btn" id="gexpfav"${G.favs.size ? "" : " disabled"}>Export Favorites ⬇</button></div>` : "";
  wire(main, ctx, rowsAll, legal);
}
// the pool must be the contest's size for dupes and ranks to mean anything: say so when it is not
function sizeWarn(G) {
  const fc = G.fieldCfg && G.fieldCfg.contest, c = G.cid ? (G.contests || []).find(x => String(x.id) === String(G.cid)) : null;
  if (!c) return "";
  const want = Math.min(20000, c.field), have = G.fieldN || 0;
  if (fc && String(fc.cid) === String(c.id)) return `<span class="chip ok" title="pool built for this contest">pool sized to contest · ${have.toLocaleString()}</span>`;
  return `<span class="chip warn" title="duplicates and ranks are measured against the pool; rebuild it at the contest's size on the Contest Generator">pool is ${have.toLocaleString()}, contest is ${c.field.toLocaleString()}: <a href="#" id="sregen">regenerate at ${want.toLocaleString()}</a></span>`;
}
function projTable(S, G) {
  const H = S.hub, rows = H.rows.filter(r => (r.cons ?? 0) >= 1 && (G.pos === "ALL" || r.pos.split("/")[0] === G.pos) && (!G.q || r.name.toLowerCase().includes(G.q.toLowerCase()))).sort((a, b) => (b.lab ?? 0) - (a.lab ?? 0)), sd = H.slate.type === "SHOWDOWN";
  const f1 = v => v == null ? "—" : (+v).toFixed(1), dl = v => v == null ? "—" : `<span class="${Math.abs(v) >= 3 ? (v > 0 ? "gap dn" : "gap up") : ""}">${v > 0 ? "+" : ""}${(+v).toFixed(1)}</span>`;
  return `<div class="tool"><div class="search">🔍 <input id="gq" placeholder="Player" value="${esc(G.q)}"></div><div class="pos">${["ALL", "QB", "RB", "WR", "TE", "K", "DST"].map(p => `<button data-spos="${p}" aria-selected="${G.pos === p}">${p}</button>`).join("")}</div><div class="grow"></div><span class="hint">The projections the sim draws from, the Lab blend, the sites' ownership, and Model own (what the field will actually do)</span></div>
    <div class="tw"><table><thead><tr><th class="na stl">Player</th><th class="na">Pos</th><th class="na">Team</th><th class="na">Opp</th><th class="na num">Salary</th><th class="na num">Stok</th><th class="na num">ETR</th><th class="na num">Blick</th><th class="na num">Market</th><th class="na num">Lab</th><th class="na num">Sites own</th><th class="na num">Model own</th>${sd ? "" : '<th class="na num">vs sites</th>'}</tr></thead><tbody>
    ${rows.map(r => `<tr><td class="stl"><b>${esc(r.name)}</b></td><td>${esc(r.pos)}</td><td>${esc(r.team)}</td><td>${esc(r.opp || "")}</td><td class="num">$${(r.sal || 0).toLocaleString()}</td><td class="num">${f1(r.stk && r.stk.proj)}</td><td class="num">${f1(r.etr && r.etr.proj)}</td><td class="num">${f1(r.blick && r.blick.proj)}</td><td class="num">${f1(r.mkt && r.mkt.proj)}</td><td class="num"><b>${f1(r.lab)}</b></td><td class="num">${pc(r.vown ?? r.own)}</td><td class="num"><b>${pc(r.labOwn)}</b></td>${sd ? "" : `<td class="num">${dl(r.ownDelta)}</td>`}</tr>`).join("")}</tbody></table></div>`;
}
// Notes cell: the slate guide's thesis tags and the player stances it matches (green) or goes against (red); the score is the grade's notes part
const notesCell = e => {
  const n = e.notes || { for: [], against: [] }, th = e.theses || [];
  const chips = th.length ? `<div class="theses">${th.map(t => `<span class="chip t">${esc(t)}</span>`).join("")}</div>` : "";
  if (!n.for.length && !n.against.length && !th.length) return `<span class="hint">—</span>`;
  const line = (x, cls) => `<div class="${cls}" title="${esc(x.note || "")}"><b>${esc(x.kind)}:</b> ${x.names.map(esc).join(", ")}</div>`;
  return `<div class="notes">${chips}${n.for.map(x => line(x, "nfor")).join("")}${n.against.map(x => line(x, "nagainst")).join("")}</div>`;
};
// lineup grade (src/engine/grade.mjs via loadSimRun): a 0-100 pill; click opens how it was built
const gColor = g => g >= 70 ? "var(--green,#3ddc84)" : g >= 40 ? "#f5c542" : "var(--red,#ff4d6d)";
const winsCell = e => e.wins && e.wins.length ? e.wins.map(w => `<div title="${esc(w.name)}: ${w.share}% of its top finishes, ${w.lift}x how often this script happens"><span style="color:var(--neon,#22d3ee)">${esc(w.name)}</span> <span class="mini">${w.share}%</span></div>`).join("") : "—";
// one part of the grade (rulebook or notes) as a plain 0-100 number; click opens the same breakdown as the grade
const partCell = (e, k) => { const v = e.grade && e.grade.parts[k]; return v == null ? '<span class="hint">—</span>' : `<span data-grade="${esc(e.sig)}" style="cursor:pointer;font-weight:700;color:${gColor(v)}" title="click for how it was built">${v}</span>`; };
// a part that barely separates lineups on this slate (thin notes, or few showdown rules) says so in its header
const thinPart = (rows, k) => { const vs = new Set(rows.map(e => e.grade && e.grade.parts[k]).filter(v => v != null)); return vs.size <= 6 ? ` (only ${vs.size} distinct scores on this slate, so it barely separates lineups)` : ""; };
const gradePill = e => e.grade ? `<span class="gpill" data-grade="${esc(e.sig)}" title="Grade ${e.grade.grade}/100: sim ${e.grade.parts.sim}, rules ${e.grade.parts.rules}${e.grade.parts.guide == null ? "" : ", guide " + e.grade.parts.guide} (click for how)" style="display:inline-block;min-width:34px;text-align:center;padding:3px 6px;border-radius:12px;font-weight:700;cursor:pointer;color:#0b0f14;background:${gColor(e.grade.grade)}">${e.grade.grade}</span>` : '<span class="hint">—</span>';
function gradeModal(e, info) {
  const g = e.grade, w = g.weights, bar = (label, v, wt, why) => v == null ? "" : `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between"><b>${label}</b><span>${v}/100 <span class="hint">× ${Math.round(100 * wt)}% weight</span></span></div><div style="height:8px;border-radius:4px;background:var(--line2);overflow:hidden"><div style="height:100%;width:${v}%;background:${gColor(v)}"></div></div><div class="hint" style="margin-top:2px">${why}</div></div>`;
  const rl = g.rules.slice().sort((a, b) => b.pts - a.pts).map(r => `<div style="display:flex;gap:8px"><span style="min-width:44px;color:${r.pts > 0 ? "var(--green,#3ddc84)" : "var(--red,#ff4d6d)"}">${r.pts > 0 ? "+" : ""}${r.pts.toFixed(2)}</span><span>${esc(r.name.replace(/^ETR( BB)?: /, ""))} <span class="hint">top-1% ×${r.lift.toFixed(2)}, ROI ${r.roiF}% vs ${r.roiN}%, t ${r.t} (${esc(r.seg)})</span></span></div>`).join("") || '<div class="hint">No measured rule applies either way.</div>';
  const gl = g.guide.slice().sort((a, b) => b.pts - a.pts).map(x => `<div style="display:flex;gap:8px" title="${esc(x.note || "")}"><span style="min-width:44px;color:${x.pts > 0 ? "var(--green,#3ddc84)" : "var(--red,#ff4d6d)"}">${x.pts > 0 ? "+" : ""}${x.pts}</span><span><b>${esc(x.kind)}:</b> ${(x.names || []).map(esc).join(", ")}${x.note ? ` <span class="hint">${esc(String(x.note).slice(0, 140))}${String(x.note).length > 140 ? "…" : ""}</span>` : ""}</span></div>`).join("") || '<div class="hint">The slate guide says nothing about these players.</div>';
  const bb = g.bringBack ? `<div class="hint" style="margin-top:4px">Obvious bring-back for this QB: ${g.bringBack.share}% of his stacks in the pool carry it; this lineup ${g.bringBack.takes ? "takes" : "fades"} it.</div>` : "";
  // the rulebook sections these rules came from: they follow the selected contest (fee tier, slate length, flat or concentrated)
  const segs = [...new Set(g.rules.map(r => r.seg))], segLine = `Rulebook section${segs.length === 1 ? "" : "s"} used for this contest: ${segs.length ? segs.map(esc).join(", ") : "none apply"}${info && info.flat ? ` · flat slate (${info.chalkN} at 20%+): ownership rules off` : ""}. Switching the contest can change this score.`;
  const dup = e.sim.dupN, lev = [
    e.fieldDelta == null ? "" : e.fieldDelta <= -5 ? `The field plays it ${Math.abs(e.fieldDelta)} points lighter than the sites say` : e.fieldDelta >= 5 ? `The field plays it ${e.fieldDelta} points heavier than the sites say` : "The field plays it about as the sites say",
    dup == null ? "" : dup < 0.3 ? "Rarely duplicated" : dup >= 1.5 ? `Expect ${(+dup).toFixed(1)} copies in the field` : `About ${(+dup).toFixed(1)} copies in the field`,
    e.wins && e.wins.length ? `Wins when ${e.wins[0].name} (${e.wins[0].share}% of its top finishes)` : ""].filter(Boolean);
  return `<div id="gmodal" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:40px 12px;overflow:auto"><div style="background:var(--bg2,#11161d);border:1px solid var(--line2);border-radius:8px;max-width:720px;width:100%;padding:16px 18px" onclick="event.stopPropagation()">
    <div style="display:flex;align-items:center;gap:12px"><span style="font-size:34px;font-weight:800;color:${gColor(g.grade)}">${g.grade}</span><div><b>Lineup grade</b><div class="hint">100 = the best lineup in this pool. Weights ${info && info.fitted ? "fitted on the backtest" : "set by hand until the backtest fits them"}; rules measured on ${info && info.rulebook ? info.rulebook.contests + " contests" : "the archive"}.</div></div><div class="grow"></div><button class="btn sec" id="gmclose">Close</button></div>
    <div class="lu" style="margin:10px 0">${e.players.map(p => `<span class="ps">${esc(p.slot)}</span><b>${esc(p.name)}</b>`).join('<span class="sep">|</span>')}</div>
    ${bar("Sim", g.parts.sim, w.sim, `Lab ROI ${e.sim.lab ?? e.sim.mean}% ranks ahead of ${g.parts.sim}% of this pool${e.grade.parts.sim === 60 ? " (capped: in $300+ contests the sim's top decile has lost)" : ""}`)}
    ${bar("Rulebook", g.parts.rules, w.rules, "measured rules it follows or breaks, weighted by how much each moved top-1% finishes")}
    <div style="margin:4px 0 10px 4px">${rl}${bb}<div class="hint" style="margin-top:4px">${segLine}</div></div>
    ${bar("Notes", g.parts.guide, w.guide, "the slate notes (ETR / Blick and your reads): stances, theses, top plays; cautions are a small penalty, fades a big one")}
    ${g.parts.guide == null ? '<div class="hint" style="margin:4px 0 4px 4px">No slate notes yet, so this part is left out of the grade.</div>' : `<div style="margin:4px 0 4px 4px">${gl}</div>`}
    ${lev.length ? `<div style="margin-top:10px"><b>Leverage and dupes</b> <span class="hint">(shown for context; not part of the grade)</span>${lev.map(x => `<div style="margin:2px 0 0 4px">${esc(x)}</div>`).join("")}</div>` : ""}
  </div></div>`;
}
function lineupTable(G, D, rowsAll, srcs, sd, rows, X = {}) {
  const part = k => e => e.grade && e.grade.parts[k] != null ? e.grade.parts[k] : -1;
  const SORT = { grade: e => e.grade ? e.grade.grade : -1, rules: part("rules"), notes: part("guide"), lab: e => e.sim.lab, proj: e => e.lab ?? e.sim.proj, own: e => e.fieldOwn, delta: e => e.fieldDelta ?? -999, win: e => e.sim.win, t1: e => e.sim.t1, t10: e => e.sim.t10, cash: e => e.sim.cash, dup: e => -e.sim.dupN, sal: e => e.sal };
  for (const k of srcs) SORT["r_" + k] = e => e.sim[k].roi;
  const opts = [["grade", "Grade"], ["lab", "Lab ROI"], ...srcs.map(k => ["r_" + k, LONG[k] + " ROI"]), ["rules", "Rulebook"], ["notes", "Notes"], ["t10", "Top 10%"], ["win", "Win%"], ["dup", "Fewest dupes"], ["delta", "Field vs sites"], ["proj", "Projected FP"], ["sal", "Salary"]];
  const sk = SORT[G.sort.k] || SORT.lab, sorted = rows.slice().sort((a, b) => (sk(b) - sk(a)) * G.sort.d || a.n - b.n);
  const th = (k, label, cls = "", title = "") => `<th class="${cls}" data-gsort="${k}" title="${esc(title)}">${label}${G.sort.k === k ? `<span class="ar">${G.sort.d > 0 ? "▼" : "▲"}</span>` : ""}</th>`;
  const dl = v => v == null ? "—" : `<span class="${Math.abs(v) >= 5 ? (v > 0 ? "gap dn" : "gap up") : ""}">${v > 0 ? "+" : ""}${(+v).toFixed(0)}</span>`;
  const lu = e => `<div class="lu">${e.players.map(p => `<span class="ps">${esc(p.slot)}</span><b>${esc(p.name)}</b>`).join('<span class="sep">|</span>')}</div>`;
  // phone: the 17-column table becomes one card per lineup (Lab ROI first, the sources, Brain, players, heart), with a sort menu
  if (typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches) {
    const cards = sorted.slice(0, 150).map(e => `<div class="lcard${G.favs.has(e.sig) ? " fav" : ""}">
      <div class="lc-top">${gradePill(e)}<span class="lc-sub" title="Rulebook / Notes">R ${partCell(e, "rules")} N ${partCell(e, "guide")}</span><span class="lc-roi ${e.sim.lab >= 0 ? "pos" : "neg"}">${pc(e.sim.lab, 0)}</span><span class="lc-sub">${srcs.map(k => `<span class="lc-src"><b>${SRC[k]}</b> <span class="${e.sim[k].roi > 0 ? "gap up" : "gap dn"}">${e.sim[k].roi > 0 ? "+" : ""}${e.sim[k].roi.toFixed(0)}%</span></span>`).join("")}</span><span class="heart${G.favs.has(e.sig) ? " on" : ""}" data-fav="${esc(e.sig)}">♥</span></div>
      <div class="lc-meta"><span>${esc(e.type)}</span><span>top 10% ${pc(e.sim.t10, 0)}</span><span>dupes ${e.sim.dupN}</span><span>own ${pc(e.fieldOwn, 0)}</span>${sd || e.fieldDelta == null ? "" : `<span>vs sites ${dl(e.fieldDelta)}</span>`}<span>$${e.sal.toLocaleString()}</span></div>
      ${notesCell(e)}
      <div class="lc-players">${e.players.map(p => `<span><i>${esc(p.slot)}</i>${esc(p.name)}</span>`).join("")}</div></div>`).join("");
    const head = `<div class="tool"><div class="search">🔍 <input id="gq" placeholder="Player in lineup" value="${esc(G.q)}"></div>${sd ? "" : `<label class="sw${G.sharpOnly !== false ? " on" : ""}" id="gsharp"><i></i>sharp <span class="mini">${X.sharpN}/${X.legal}</span></label>`}<label class="sw${G.notesOnly ? " on" : ""}" id="gnotes" title="At least 3 supporting notes from the slate guide (stances, theses, top plays, captain reads) and nothing it is against (no fade, caution or hurt-by-captain)"><i></i>notes back it</label><select class="sel" id="gsortm">${opts.map(([k, l]) => `<option value="${k}"${G.sort.k === k ? " selected" : ""}>Sort: ${esc(l)}</option>`).join("")}</select></div>`;
    return head + `<div class="lcards">${cards || '<div class="empty">No lineups match</div>'}${sorted.length > 150 ? `<div class="hint" style="padding:10px">First 150 of ${sorted.length}; search or sort to narrow</div>` : ""}</div>`;
  }
  return `<div class="tool"><div class="search">🔍 <input id="gq" placeholder="Player in lineup" value="${esc(G.q)}"></div>${sd ? "" : `<label class="sw${G.sharpOnly !== false ? " on" : ""}" id="gsharp" title="${esc(X.sharpNote || "")}; graded on 352 real contests: top-10% finishes 15% vs the field's 10%"><i></i>sharp construction <span class="mini">${X.sharpN} of ${X.legal}</span></label>`}<label class="sw${G.notesOnly ? " on" : ""}" id="gnotes" title="At least 3 supporting notes from the slate guide (stances, theses, top plays, captain reads) and nothing it is against (no fade, caution or hurt-by-captain)"><i></i>only lineups the notes back</label><div class="grow"></div><span class="hint">${G.data && G.data.gradeInfo && G.data.gradeInfo.flat ? `<span title="On flat slates your past contests show no ownership edge either way, so the ownership-sum and chalk checks and grade rules are off">flat slate (${G.data.gradeInfo.chalkN} at 20%+): ownership rules off</span> · ` : ""}${rows.length} lineups · Lab ROI weights ${srcs.map(k => SRC[k]).join("/")} by scorecard accuracy</span><button class="btn ghost" id="gexpall">⬇ Export</button></div>
    <div class="tw"><table><thead><tr>${th("grade", "Grade", "ctr", "0-100: sim + measured rulebook + slate guide, ranked within this pool; click a grade for how it was built")}${th("rules", "Rulebook", "ctr", "0-100: the measured rules from your past contests this lineup follows or breaks, ranked within this pool" + thinPart(rows, "rules"))}${th("notes", "Notes", "ctr", "0-100: how well it matches the slate notes (ETR / Blick and your reads), ranked within this pool" + thinPart(rows, "guide"))}${th("lab", "Lab ROI", "stl", "the sources' simulated ROI weighted by their scorecard accuracy")}${srcs.map(k => th("r_" + k, SRC[k], "num", LONG[k] + " ROI and rank" + (D.field && D.field.all ? ", in the " + LONG[k] + " field" : ""))).join("")}${th("proj", "Projected FP", "num", "Lab blend projection")}${th("own", "OwnSum", "num", "summed exposure in the generated field")}${sd ? "" : th("delta", "Field vs sites", "num", "model ownership minus the sites' ownership, summed over the lineup: + the field comes in heavier than the sites say, − lighter")}<th class="na">Stack Type</th><th class="na" title="the game scripts this lineup wins in: share of its top-1% finishes (explanation only, does not change the ranking)">Wins when</th>${th("win", "Win%", "num")}${th("t1", "Top 1%", "num")}${th("t10", "Top 10%", "num")}${th("cash", "Cash%", "num")}${th("dup", "Dupes", "num", "copies of this lineup in the generated field")}<th class="na" title="the slate notes this lineup matches (green) or goes against (red), and its thesis tags">What the notes say</th><th class="na">Lineup</th>${th("sal", "Salary", "num")}<th class="na str"></th></tr></thead><tbody>
    ${sorted.map(e => `<tr><td class="ctr">${gradePill(e)}</td><td class="ctr">${partCell(e, "rules")}</td><td class="ctr">${partCell(e, "guide")}</td><td class="stl roi ${e.sim.lab >= 0 ? "pos" : "neg"}">${pc(e.sim.lab)} <span class="hint">±${e.sim.se.toFixed(0)}</span></td>${srcs.map(k => `<td class="num" title="${LONG[k]}: rank #${e.sim[k].rank} of ${rowsAll.length}"><span class="${e.sim[k].roi > 0 ? "gap up" : "gap dn"}">${e.sim[k].roi > 0 ? "+" : ""}${e.sim[k].roi.toFixed(0)}%</span><br><span class="mini">#${e.sim[k].rank}</span></td>`).join("")}<td class="num">${(e.lab ?? e.sim.proj).toFixed(1)}</td><td class="num">${pc(e.fieldOwn, 0)}</td>${sd ? "" : `<td class="num">${dl(e.fieldDelta)}</td>`}<td class="ctr hint">${esc(e.type)}</td><td class="hint" style="white-space:nowrap">${winsCell(e)}</td><td class="num">${pc(e.sim.win, 2)}</td><td class="num">${pc(e.sim.t1, 2)}</td><td class="num">${pc(e.sim.t10)}</td><td class="num">${pc(e.sim.cash)}</td><td class="num">${e.sim.dupN}</td><td>${notesCell(e)}</td><td>${lu(e)}</td><td class="num">$${e.sal.toLocaleString()}</td><td class="str ctr"><span class="heart${G.favs.has(e.sig) ? " on" : ""}" data-fav="${esc(e.sig)}" title="favorite">♥</span></td></tr>`).join("")}</tbody></table></div>`;
}
function playersTable(G, D, srcs, sd) {
  const rows = (D.players || []).filter(x => (G.pos === "ALL" || String(x.pos).split("/")[0] === G.pos) && (!G.q || x.name.toLowerCase().includes(G.q.toLowerCase())));
  return `<div class="tool"><div class="search">🔍 <input id="gq" placeholder="Player" value="${esc(G.q)}"></div><div class="pos">${["ALL", "QB", "RB", "WR", "TE", "K", "DST"].map(p => `<button data-spos="${p}" aria-selected="${G.pos === p}">${p}</button>`).join("")}</div><div class="grow"></div><span class="hint">Average simulated ROI of the lineups each player is in, overall and by source</span></div>
    <div class="tw"><table><thead><tr><th class="na stl">Player</th><th class="na">Team</th><th class="na">Opp</th><th class="na">Pos</th><th class="na num">Salary</th><th class="na num">Exposure</th><th class="na num">Own</th><th class="na num">Avg Sim ROI</th>${srcs.map(k => `<th class="na num">${SRC[k]}</th>`).join("")}${sd ? '<th class="na num">CPT</th>' : ""}</tr></thead><tbody>
    ${rows.map(x => `<tr><td class="stl"><b>${esc(x.name)}</b></td><td>${esc(x.team)}</td><td>${esc(x.opp || "")}</td><td>${esc(x.pos)}</td><td class="num">$${(x.sal || 0).toLocaleString()}</td><td class="num">${pc(x.exp)}</td><td class="num">${pc(x.own)}</td><td class="num roi ${x.roi >= 0 ? "pos" : "neg"}">${pc(x.roi)}</td>${srcs.map(k => `<td class="num"><span class="${(x.by[k] ?? 0) > 0 ? "gap up" : "gap dn"}">${pc(x.by[k], 0)}</span></td>`).join("")}${sd ? `<td class="num">${x.cpt}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function expoTable(G, D, rowsAll) {
  const favs = rowsAll.filter(e => G.favs.has(e.sig)); if (!favs.length) return `<div class="empty">No favorites yet<small>Heart lineups on the Lineups tab, or Quick favorite at the bottom.</small></div>`;
  const cnt = {}; for (const e of favs) for (const p of e.players) { const k = p.name + "|" + p.team; const x = cnt[k] = cnt[k] || { name: p.name, team: p.team, pos: p.pos, own: p.isCpt ? null : p.own, n: 0, cpt: 0 }; x.n++; if (p.isCpt) x.cpt++; if (!p.isCpt && x.own == null) x.own = p.own; }
  const rows = Object.values(cnt).map(x => Object.assign(x, { pct: 100 * x.n / favs.length })).sort((a, b) => b.n - a.n);
  return `<div class="tool"><span class="hint">Exposure across your ${favs.length} favorites against projected ownership</span></div><div class="tw"><table><thead><tr><th class="na stl">Player</th><th class="na">Team</th><th class="na">Pos</th><th class="na num">Lineups</th><th class="na num">Exposure</th><th class="na num">Ownership</th><th class="na num">Difference</th>${D.format === "nfl_sd" ? '<th class="na num">CPT</th>' : ""}</tr></thead><tbody>${rows.map(x => `<tr><td class="stl"><b>${esc(x.name)}</b></td><td>${esc(x.team)}</td><td>${esc(x.pos)}</td><td class="num">${x.n}</td><td class="num">${pc(x.pct, 0)}</td><td class="num">${pc(x.own)}</td><td class="num"><span class="${x.pct - (x.own || 0) > 0 ? "diffpos" : "diffneg"}">${x.own == null ? "—" : (x.pct - x.own > 0 ? "+" : "") + (x.pct - x.own).toFixed(0) + "%"}</span></td>${D.format === "nfl_sd" ? `<td class="num">${x.cpt}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function overview(G, rowsAll) {
  const favs = rowsAll.filter(e => G.favs.has(e.sig)), rs = favs.map(e => e.sim.lab), ps = favs.map(e => e.lab ?? e.sim.proj), m = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const box = (lab, a, d, suf) => `<div class="box"><b>${lab}</b><span><span class="v">${a.length ? Math.min(...a).toFixed(d) + suf : "-"}</span><span class="k">Min</span></span><span><span class="v">${a.length ? m(a).toFixed(d) + suf : "-"}</span><span class="k">Avg</span></span><span><span class="v">${a.length ? Math.max(...a).toFixed(d) + suf : "-"}</span><span class="k">Max</span></span></div>`;
  return `<div class="ovw"><span class="lab">Lineup Portfolio Overview (${favs.length} favorites)</span>${box("Lab ROI", rs, 1, "%")}${box("Projected FP", ps, 1, "")}</div>`;
}
function wire(main, ctx, rowsAll, legal0) {
  const { S, api, setMsg, render } = ctx, G = S.sim, saveFavs = () => { try { localStorage.setItem(favKey(G.dir), JSON.stringify([...G.favs])); } catch {} };
  $$("#tabs .tab").forEach(b => b.addEventListener("click", () => { G.tab = b.getAttribute("data-stab"); render(); }));
  $("#scid").addEventListener("change", e => { G.cid = e.target.value; render(); });
  const sp = $("#spct"); if (sp) sp.addEventListener("change", e => { G.pct = +e.target.value; });
  const rg = $("#sregen"); if (rg) rg.addEventListener("click", e => { e.preventDefault(); if (S.gen && S.gen.cfg) { S.gen.cfg.cid = G.cid; const c = G.contests.find(x => String(x.id) === String(G.cid)); if (c) S.gen.cfg.n = Math.min(20000, c.field); } else S.pendingGenCid = G.cid; S.view = "gen"; setMsg("Contest set on the Contest Generator; press Generate Lineups"); render(); });
  $("#srun").addEventListener("click", async () => { G.busy = true; render(); setMsg("Simulating the generated pool under every source…");
    try { G.data = await api(`/api/simrun?dir=${encodeURIComponent(S.hub.dir)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ cid: G.cid, useField: true }, G.cid ? {} : { pct: G.pct })) }); G.tab = "lineups"; setMsg(`Simulation done: ${G.data.summary.n} lineups vs ${G.data.field.N.toLocaleString()} entries, ${G.data.iters.toLocaleString()} draws per source, ${(G.data.ms / 1000).toFixed(1)}s`); }
    catch (e) { setMsg("Simulation failed: " + e.message, true); } G.busy = false; render(); });
  const q = $("#gq"); if (q) q.addEventListener("input", e => { G.q = e.target.value; render(); setTimeout(() => { const i = $("#gq"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); });
  $$("[data-spos]", main).forEach(b => b.addEventListener("click", () => { G.pos = b.getAttribute("data-spos"); render(); }));
  const no = $("#gnotes"); if (no) no.addEventListener("click", () => { G.notesOnly = !G.notesOnly; render(); });
  $$("[data-grade]", main).forEach(b => b.addEventListener("click", ev => { ev.stopPropagation(); const e = (G.data.rows || []).find(x => x.sig === b.getAttribute("data-grade")); if (!e || !e.grade) return;
    const d = document.createElement("div"); d.innerHTML = gradeModal(e, G.data.gradeInfo); const m = d.firstElementChild; document.body.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener("keydown", esc_); }, esc_ = x => { if (x.key === "Escape") close(); };
    m.addEventListener("click", close); m.querySelector("#gmclose").addEventListener("click", close); document.addEventListener("keydown", esc_); }));
  const sh = $("#gsharp"); if (sh) sh.addEventListener("click", () => { G.sharpOnly = G.sharpOnly === false; render(); });
  $$("th[data-gsort]", main).forEach(h => h.addEventListener("click", () => { const k = h.getAttribute("data-gsort"); G.sort = G.sort.k === k ? { k, d: -G.sort.d } : { k, d: 1 }; render(); }));
  const sm = $("#gsortm"); if (sm) sm.addEventListener("change", e => { G.sort = { k: e.target.value, d: 1 }; render(); });
  $$("[data-fav]", main).forEach(el => el.addEventListener("click", () => { const k = el.getAttribute("data-fav"); if (G.favs.has(k)) G.favs.delete(k); else G.favs.add(k); saveFavs(); render(); }));
  const qu = $("#gqu"); if (qu) qu.addEventListener("change", e => { G.minUniq = Math.max(0, +e.target.value || 0); });
  const qk = $("#gquick"); if (qk) qk.addEventListener("click", () => { const n = Math.max(1, +$("#gqn").value || 20); G.qn = n; const uniq = Math.max(0, +$("#gqu").value || 0); G.minUniq = uniq; const picked = []; for (const e of rowsAll.slice().sort((a, b) => b.sim.lab - a.sim.lab)) { if (picked.length >= n) break; if (uniq && picked.some(p => { const s = new Set(p.players.map(x => x.name)); return e.players.filter(x => !s.has(x.name)).length < uniq; })) continue; picked.push(e); } G.favs = new Set(picked.map(e => e.sig)); saveFavs(); setMsg(`${picked.length} favorites picked by Lab ROI${uniq ? `, at least ${uniq} unique` : ""}`); render(); });
  const en = $("#sentry"); if (en) en.addEventListener("click", () => { G.emModal = true; render(); });
  const eo = $("#semopen"); if (eo) eo.addEventListener("click", () => { G.emModal = true; render(); });
  const ex0 = $("#emx"); if (ex0) ex0.addEventListener("click", () => { G.emModal = false; render(); });
  const ov0 = $("#emov"); if (ov0) ov0.addEventListener("click", e => { if (e.target === ov0) { G.emModal = false; render(); } });
  wireEM(main, ctx, legal0);
  const ex = $("#gexpfav"); if (ex) ex.addEventListener("click", () => { const favs = rowsAll.filter(e => G.favs.has(e.sig)); if (!favs.length) return; const sd = G.data.format === "nfl_sd", head = sd ? ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"] : ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]; download(`DK-upload-${G.data.dir}.csv`, [head.join(",")].concat(favs.map(e => e.players.map(p => p.dkId ? `${p.name} (${p.dkId})` : p.name).map(v => /,/.test(v) ? `"${v}"` : v).join(","))).join("\n") + "\n"); setMsg(`${favs.length} favorites exported; upload on DraftKings (Lineups → Upload), then import DK's entries file on the Entries tab`); });
  const ea = $("#gexpall"); if (ea) ea.addEventListener("click", () => { const srcs = G.data.sources, head = ["Lab ROI", ...srcs.map(k => LONG[k] + " ROI"), "Projected FP", "OwnSum (field)", "Field vs sites", "Stack Type", "Win%", "Top1%", "Top10%", "Cash%", "Dupes", "Notes for", "Notes against", "Salary", ...G.data.rows[0].players.map(p => p.slot)]; const nt = l => l.map(x => x.kind + ": " + x.names.join(", ")).join("; "); download(`sim-${G.data.dir}.csv`, [head.join(",")].concat(rowsAll.map(e => [e.sim.lab, ...srcs.map(k => e.sim[k].roi), e.lab ?? e.sim.proj, e.fieldOwn, e.fieldDelta ?? "", e.type, e.sim.win, e.sim.t1, e.sim.t10, e.sim.cash, e.sim.dupN, e.notes ? nt(e.notes.for) : "", e.notes ? nt(e.notes.against) : "", e.sal, ...e.players.map(p => p.name)].map(v => /,/.test(String(v)) ? `"${v}"` : v).join(","))).join("\n") + "\n"); });
}

// Entry Manager, the Stokastic shape: upload the DraftKings entries file (DKEntries.csv: one row per contest entry you hold on
// the slate), see My Contests with lineups filled out of entries, fill the entries from your favorites by Lab ROI (Enable
// Duplicate Lineups lets one lineup go into several contests; never twice in one contest), then Download Entry File to upload
// back to DraftKings. The plan is saved on the server (data/<slate>/entry-plan.json) so the slate can be graded afterwards.
const shortName = n => esc(String(n || "").replace(/^NFL (Showdown )?/, "").slice(0, 60));
const slotHead = sd => sd ? ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"] : ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"];
const slateLabel = G => G.dir ? G.dir.replace(/^(\d{4}-\d{2}-\d{2})-nfl-/, "$1 · ").replace(/-/g, " ") : "";
function splitCSV(line) { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; }
function parseDKEntries(text, nSlots) {
  const rows = String(text).replace(/^﻿/, "").split(/\r?\n/).map(splitCSV);
  const h = rows[0] || [], iE = h.findIndex(x => /^entry id$/i.test(x)), iN = h.findIndex(x => /^contest name$/i.test(x)), iC = h.findIndex(x => /^contest id$/i.test(x)), iF = h.findIndex(x => /^entry fee$/i.test(x));
  if (iE < 0 || iC < 0) throw new Error("not a DraftKings entries file (needs Entry ID and Contest ID columns)");
  const by = new Map();
  for (const r of rows.slice(1)) {
    if (!/^\d+$/.test(r[iE] || "")) continue;
    const cid = r[iC], c = by.get(cid) || { cid, name: r[iN] || "", fee: +String(r[iF] || "").replace(/[$,]/g, "") || 0, entries: [] };
    const cells = r.slice(iF + 1, iF + 1 + nSlots);
    c.entries.push({ entryId: r[iE], lineup: cells.length === nSlots && cells.every(x => x) ? cells : [], sig: null }); by.set(cid, c);
  }
  return [...by.values()];
}
function entryManager(G, legal) {
  const P = G.plan || (G.plan = { contests: [] }), favN = [...G.favs].filter(s => legal.some(e => e.sig === s)).length;
  const filled = c => c.entries.filter(e => e.lineup && e.lineup.length).length, totE = P.contests.reduce((t, c) => t + c.entries.length, 0), totF = P.contests.reduce((t, c) => t + filled(c), 0);
  const sorted = P.contests.slice().sort(G.emSort === "entries" ? (a, b) => b.entries.length - a.entries.length : (a, b) => b.fee - a.fee);
  const top = `<div class="note" style="margin:8px 12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div><b style="margin:0">Upload CSV</b><span class="hint">${P.fileName ? `Loaded ${esc(P.fileName)}${P.savedAt ? ` · saved ${new Date(P.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "Upload your DraftKings entries file (Lineups, Edit Entries, Download CSV) to add your contests."}</span></div><div class="grow"></div><label class="btn" style="cursor:pointer">Upload CSV<input type="file" id="emfile" accept=".csv,text/csv" hidden></label></div>`;
  if (!P.contests.length) return top + `<div class="empty">No contests<small>Upload your DraftKings entries file for this slate. Your favorites (${favN}) fill its entries.</small></div>`;
  const list = sorted.map(c => {
    const open = G.emOpen === c.cid, f = filled(c);
    const rows = c.entries.map((e, k) => { const r = e.sig ? legal.find(x => x.sig === e.sig) : null; return `<tr><td class="hint">${esc(e.entryId)}</td><td class="num">${r ? pc(r.sim.lab) : "—"}</td><td>${e.lineup && e.lineup.length ? `<div class="lu">${e.lineup.map(x => `<b>${esc(String(x).replace(/\s*\(\d+\)$/, ""))}</b>`).join('<span class="sep">|</span>')}</div>` : '<span class="hint">empty</span>'}</td><td>${e.lineup && e.lineup.length ? `<span class="x" style="cursor:pointer" data-emrm="${esc(c.cid)}|${k}" title="clear">✕</span>` : ""}</td></tr>`; }).join("");
    return `<div class="note" style="margin:6px 12px;border-left-color:${f === c.entries.length ? "var(--green)" : "var(--neon)"}"><div style="display:flex;gap:10px;align-items:center;cursor:pointer" data-emopen="${esc(c.cid)}"><b style="display:inline;margin:0">$${c.fee} · ${shortName(c.name)}</b><div class="grow"></div><span class="${f === c.entries.length ? "diffpos" : "hint"}">${f}/${c.entries.length} Lineups</span><span class="mini">${open ? "▴" : "▾"}</span></div>${open ? `<div class="tw" style="max-height:none;min-height:0;margin-top:6px"><table><thead><tr><th class="na">Entry</th><th class="na num">Lab ROI</th><th class="na">Lineup</th><th class="na"></th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}</div>`;
  }).join("");
  const head = `<div class="tool"><b>My Contests</b><span class="hint">${esc(slateLabel(G))}</span><span class="hint" style="margin-left:12px">Sort:</span><label class="hint"><input type="radio" name="emsort" value="fee"${G.emSort !== "entries" ? " checked" : ""}> Entry Fee</label><label class="hint"><input type="radio" name="emsort" value="entries"${G.emSort === "entries" ? " checked" : ""}> Entries</label><div class="grow"></div><button class="btn sec" id="emfill"${favN ? "" : " disabled"} title="fill empty entries with your favorites by Lab ROI">Fill from favorites (${favN})</button><button class="btn ghost" id="emclear">Clear all lineups</button></div>`;
  const foot = `<div class="tool" style="border-top:1px solid var(--line)"><span>${P.contests.length} Contests · ${totF}/${totE} Lineups</span><div class="grow"></div><label class="sw${P.dupes !== false ? " on" : ""}" id="emdupes"><i></i>Enable Duplicate Lineups</label><button class="btn sec" id="embuilt" title="snapshot every source now; the Data Hub What changed tab shows what moved after this">${P.builtAt ? `Built ${new Date(P.builtAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · re-mark` : "Mark as built"}</button><button class="btn" id="emdl"${totF ? "" : " disabled"}>Download Entry File ⬇</button></div>`;
  return top + head + list + foot;
}
function wireEM(main, ctx, legal) {
  const { S, api, setMsg, render } = ctx, G = S.sim, P = G.plan || (G.plan = { contests: [] }), sd = G.data && G.data.format === "nfl_sd", head = slotHead(sd);
  const cell = p => (p.dkId ? `${p.name} (${p.dkId})` : p.name), q = v => /,/.test(v) ? `"${v}"` : v;
  const save = async () => { P.dir = S.hub.dir; try { const r = await api(`/api/plan?dir=${encodeURIComponent(S.hub.dir)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(P) }); P.savedAt = r.savedAt; } catch (e) { setMsg("Could not save: " + e.message, true); } render(); };
  const fi = $("#emfile"); if (fi) fi.addEventListener("change", async e => { const fl = e.target.files[0]; if (!fl) return; try { const contests = parseDKEntries(await readFile(fl), head.length); if (!contests.length) throw new Error("no entries in that file"); Object.assign(P, { fileName: fl.name, contests, dupes: P.dupes !== false }); setMsg(`${contests.length} contests, ${contests.reduce((t, c) => t + c.entries.length, 0)} entries loaded from ${fl.name}`); await save(); } catch (err) { setMsg(err.message, true); } });
  $$("[data-emopen]", main).forEach(d => d.addEventListener("click", () => { const k = d.getAttribute("data-emopen"); G.emOpen = G.emOpen === k ? null : k; render(); }));
  $$('input[name="emsort"]', main).forEach(r => r.addEventListener("change", () => { G.emSort = r.value; render(); }));
  const fl = $("#emfill"); if (fl) fl.addEventListener("click", () => {
    const favs = [...G.favs].map(s => legal.find(e => e.sig === s)).filter(Boolean).sort((a, b) => b.sim.lab - a.sim.lab), usedAny = new Set(P.contests.flatMap(c => c.entries.map(e => e.sig).filter(Boolean)));
    let filledN = 0, short = 0;
    for (const c of P.contests.slice().sort((a, b) => b.fee - a.fee)) {
      const inC = new Set(c.entries.map(e => e.sig).filter(Boolean));
      for (const e of c.entries) { if (e.lineup && e.lineup.length) continue; const pick = favs.find(x => !inC.has(x.sig) && (P.dupes !== false || !usedAny.has(x.sig))); if (!pick) { short++; continue; } e.sig = pick.sig; e.lineup = pick.players.map(cell); inC.add(pick.sig); usedAny.add(pick.sig); filledN++; }
    }
    setMsg(`${filledN} entries filled from favorites by Lab ROI${short ? `; ${short} left empty (not enough favorites${P.dupes === false ? " with duplicates off" : ""})` : ""}`, !!short); save();
  });
  const cl = $("#emclear"); if (cl) cl.addEventListener("click", () => { for (const c of P.contests) for (const e of c.entries) { e.lineup = []; e.sig = null; } setMsg("All lineups cleared; contests kept"); save(); });
  $$("[data-emrm]", main).forEach(x => x.addEventListener("click", ev => { ev.stopPropagation(); const [cid, k] = x.getAttribute("data-emrm").split("|"); const e = P.contests.find(c => c.cid === cid).entries[+k]; e.lineup = []; e.sig = null; save(); }));
  const bu = $("#embuilt"); if (bu) bu.addEventListener("click", async () => { try { await api(`/api/built?dir=${encodeURIComponent(S.hub.dir)}`, { method: "POST" }); P.builtAt = new Date().toISOString(); S.changes = null; setMsg("Marked as built: the Data Hub What changed tab now diffs against this moment"); save(); } catch (e) { setMsg("Could not mark: " + e.message, true); } });
  const du = $("#emdupes"); if (du) du.addEventListener("click", () => { P.dupes = P.dupes === false; save(); });
  const dl = $("#emdl"); if (dl) dl.addEventListener("click", () => { const lines = [["Entry ID", "Contest Name", "Contest ID", "Entry Fee", ...head].join(",")]; for (const c of P.contests) for (const e of c.entries) lines.push([e.entryId, c.name, c.cid, "$" + c.fee, ...(e.lineup && e.lineup.length ? e.lineup : head.map(() => ""))].map(v => q(String(v))).join(",")); download(`DKEntries-${S.hub.dir}.csv`, lines.join("\n") + "\n"); setMsg("Entry file downloaded; upload it on DraftKings (Lineups, Edit Entries, Upload)"); });
}

// the Entry Manager opens as a modal from the button at the top right of the control bar (Stokastic layout)
function emCount(G) { const P = G.plan || { contests: [] }, t = P.contests.reduce((x, c) => x + c.entries.length, 0), f = P.contests.reduce((x, c) => x + c.entries.filter(e => e.lineup && e.lineup.length).length, 0); return t ? ` <span class="mini">${f}/${t}</span>` : ""; }
function emModal(G, legal) { return `<div class="ov" id="emov"><div class="modal"><div class="mh">Entry Manager<button class="x" id="emx" title="close">×</button></div><div class="mb" style="padding:0 0 4px">${entryManager(G, legal)}</div></div></div>`; }
