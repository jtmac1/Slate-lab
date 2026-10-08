// Late Swap tab: live points for started players, the best fits for every open slot, and, with a
// DraftKings contest standings export loaded (My Contests -> Export Lineups to CSV), how many entries
// share your locked players and how many are likely to finish identical to you, for the lineup as it
// stands and for each swap. Data from server/lateswap.mjs and server/standings.mjs.
import { $, $$, esc } from "../app/ui.mjs";

const LS = "slatelab:dkuser";
const pcs = v => v == null ? "—" : (+v).toFixed(0) + "%";
const dk = v => v == null ? "—" : v < 0.05 ? "0" : v.toFixed(1);
export function initLate(S) { S.late = S.late || { data: null, dir: null, busy: false, simBusy: null, sims: {}, standings: null, user: (() => { try { return localStorage.getItem(LS) || ""; } catch { return ""; } })() }; }

export async function renderLate(main, ctx) {
  const { S, api } = ctx; initLate(S); const T = S.late;
  if (!S.hub) { main.innerHTML = `<div class="empty">Load a slate first<small>Pick the slate on the Data Hub and press Refresh; late swap works on that slate's players.</small></div>`; $("#bot").innerHTML = ""; return; }
  if (T.dir !== S.hub.dir) { T.dir = S.hub.dir; T.data = null; T.standings = null; T.sims = {}; }
  if (!T.standings) { try { T.standings = await api(`/api/standings?dir=${encodeURIComponent(S.hub.dir)}`); } catch { T.standings = []; } }
  const L = T.data, st = T.standings;
  let html = `<div class="tool"><button class="btn" id="latePull"${T.busy ? " disabled" : ""}>${T.busy ? "Pulling live…" : L ? "⟳ Pull live again" : "Pull live"}</button>
    <label class="drop sm" id="stDrop" style="margin:0">Drop the DraftKings standings export here (.csv or .zip)<input type="file" id="stFile" accept=".csv,.zip"></label>
    <div class="f"><input class="txt" id="dkUser" placeholder="DraftKings name" value="${esc(T.user)}" style="width:150px" title="Used to find your entries in the standings when no DKEntries file was imported"></div>
    <span class="hint">${L ? `live ${new Date(L.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${L.started.length} teams started · ${L.locked} players locked${L.sources.length ? " · re-simmed under " + L.sources.join(", ") : ""}` : "locks started players at live points and lists swaps for open slots"}</span></div>
    <div class="hint" style="padding:0 16px 8px">${st.length ? `Standings loaded: ${st.map(s => `contest ${esc(s.contestId)} · ${s.entries.toLocaleString()} entries${s.hidden ? ` · ${s.hidden.toLocaleString()} hidden slots` : ""} · ${new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`).join(" | ")}` : `No standings yet. On DraftKings My Contests, open the live contest and use Export Lineups to CSV, then drop the file here or leave it in Downloads. That turns on the duplicate check.`}</div>`;
  if (L) {
    html += `<div class="kpi">${L.games.map(g => `<div class="box"><div class="k">${esc(g.away)}@${esc(g.home)}</div><div class="v" style="font-size:13px">${g.started ? `${g.score[g.away]}-${g.score[g.home]} <span class="mini">${esc(g.detail)}</span>` : `<span class="mini">${esc(g.detail)}</span>`}</div></div>`).join("")}</div>`;
    for (const e of L.entries) {
      const d = e.dupes;
      html += `<div style="padding:10px 16px 2px"><b>${esc(String(e.contest || "").replace(/^NFL (Showdown )?/, "").slice(0, 60))}</b> <span class="hint">${e.fee != null ? `$${e.fee} · ` : ""}locked ${e.lockedPts} + open ${e.openProj} = <b>${e.total}</b> projected${e.sim ? ` · sim worst ${e.sim.worst > 0 ? "+" : ""}${e.sim.worst}% (${e.sim.agree}/${e.sim.sources.length})` : ""} · $${e.left.toLocaleString()} left</span></div>
        ${d ? `<div style="padding:0 16px 4px;font-size:12px">${d.shadows ? `<span class="${d.expected >= 1 ? "gap dn" : ""}"><b>${d.shadows}</b> ${d.shadows === 1 ? "entry shares" : "entries share"} your locked players · about <b>${dk(d.expected)}</b> likely to finish identical${d.certain ? ` (${d.certain} already identical)` : ""} · you'd keep about <b>${Math.round(100 * d.winShare)}%</b> of a top prize</span>` : `<span class="gap up">No other entry shares your locked players</span>`}${d.yours ? ` <span class="mini">· ${d.yours} of your own entries match too</span>` : ""} <span class="mini">· rank ${d.rank ?? "—"} · ${d.points} pts in the export</span> <button class="btn sec" data-sim="${esc(e.entryId)}"${T.simBusy ? " disabled" : ""} style="margin-left:8px">${T.simBusy === String(e.entryId) ? "Simming…" : T.sims[e.entryId] ? "⟳ Sim swaps again" : "Sim swaps"}</button></div>` : ""}
        <div class="lu" style="padding:0 16px 6px">${e.players.map(p => `<span class="ps">${esc(p.slot)}</span><b style="${p.locked ? "color:var(--muted)" : ""}">${esc(p.name)}</b><span class="mini"> ${p.locked ? (p.final ? "final " : "live ") + p.pts : "proj " + p.proj}</span>`).join('<span class="sep">|</span>')}</div>`;
      if (e.swaps.length) html += `<div class="tw" style="max-height:none;padding:0 16px 8px"><table style="font-size:11.5px"><thead><tr><th class="na">Open slot</th><th class="na">Current</th><th class="na num">Proj</th><th class="na num">Own</th><th class="na num">Budget</th><th class="na">Best fits (proj · own · gain${d ? " · copies if swapped" : ""})</th></tr></thead><tbody>
        ${e.swaps.map(s => `<tr><td><b>${esc(s.slot)}</b></td><td>${esc(s.current)}</td><td class="num">${s.currentProj}</td><td class="num">${pcs(s.currentOwn)}</td><td class="num">$${s.budget.toLocaleString()}</td><td style="white-space:normal">${s.cands.map(c => `<span style="display:inline-block;margin:1px 10px 1px 0"><b>${esc(c.name)}</b> <span class="mini">${esc(c.team)} $${c.sal.toLocaleString()} · ${c.proj} · ${pcs(c.own)} · <span class="${c.gain > 0 ? "gap up" : "gap dn"}">${c.gain > 0 ? "+" : ""}${c.gain}</span>${c.dupes != null ? ` · <span class="${d && c.dupes < d.expected ? "gap up" : ""}" title="expected entries finishing identical to you after this swap">${dk(c.dupes)} copies</span>` : ""}${c.inj ? " · " + esc(c.inj) : ""}</span></span>`).join("") || '<span class="mini">nothing fits</span>'}</td></tr>`).join("")}</tbody></table></div>`;
      else html += `<div class="hint" style="padding:0 16px 8px">every slot locked</div>`;
      html += simTable(T.sims[e.entryId]);
    }
  } else html += `<div class="empty">Nothing pulled yet<small>Press Pull live once the first games kick off. Entries come from the DKEntries file imported on the Entries tab, or from the standings export for your DraftKings name.</small></div>`;
  main.innerHTML = html; wire(main, ctx);
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Swaps are ranked by the Lab projection and must fit the salary left; players listed Out, Doubtful or IR are excluded. Copies: entries in the export with your exact locked players, weighted by how likely each fills your open slots the same way (each player's ownership among the fits for that slot). Nothing here is written to the pre-lock record.</span></div>`;
}

// the live field from the export: where you stand, the chalk that already played (did it hit, and do the
// entries still in contention have it), and the late players the contenders hold against the whole field
function liveTable(V) {
  if (!V) return "";
  const pf = V.ptsFrom || {}, src = pf.dk ? `DraftKings' points from the export${pf.espn ? ` (${pf.espn} from ESPN)` : ""}` : V.espn ? "ESPN box scores" : "no live points";
  const lev = (a, b) => { const d = b - a; return Math.abs(d) < 2 ? "" : `<span class="${d < 0 ? "gap dn" : "gap up"}">${d > 0 ? "+" : ""}${d.toFixed(0)}</span>`; };
  const tbl = (head, rows) => `<div class="tw" style="max-height:none;flex:1;min-width:300px"><table style="font-size:11.5px"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const st = V.started.map(r => { const m = r.proj > 0 ? r.pts / r.proj : 1; return `<tr${r.mine ? ' style="background:rgba(var(--neonrgb),.08)"' : ""}><td>${esc(r.name)} <span class="mini">${esc(r.pos)} ${esc(r.team)}</span>${r.mine ? ' <span class="mini">yours</span>' : ""}</td><td class="num">${r.own}%</td><td class="num"><b class="${m >= 1.2 ? "up" : m <= 0.6 ? "dn" : ""}">${r.pts}</b> <span class="mini">/ ${r.proj}</span></td><td class="num">${r.contOwn}% ${lev(r.own, r.contOwn)}</td></tr>`; }).join("");
  const lt = V.late.map(r => `<tr${r.mine ? ' style="background:rgba(var(--neonrgb),.08)"' : ""}><td>${esc(r.name)} <span class="mini">${esc(r.pos)} ${esc(r.team)} $${(r.sal / 1000).toFixed(1)}k</span>${r.mine ? ' <span class="mini">yours</span>' : ""}</td><td class="num">${r.own}%</td><td class="num">${r.proj}</td><td class="num">${r.contOwn}% ${lev(r.own, r.contOwn)}</td></tr>`).join("");
  return `<div style="padding:4px 16px 2px;font-size:12px"><b>Live field</b> · you have <b>${V.now}</b> pts now, ahead of <b>${V.aheadNow}%</b> of the field · headed for about <b>${V.fin}</b>, ahead of <b>${V.aheadFin}%</b> · ${V.youContend ? `<span class="gap up">you're in the top tenth</span>` : `top tenth needs about ${V.cut}`} <span class="mini">· ${V.contenders.toLocaleString()} contenders · ${esc(src)}</span></div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;padding:0 16px 6px">
      ${V.started.length ? tbl(`<th class="na">Already played</th><th class="na num" title="real %Drafted">Own</th><th class="na num" title="points so far / pre-lock projection">Pts</th><th class="na num" title="share of the top tenth (by where they're headed) that has him, against the whole field">Contenders</th>`, st) : ""}
      ${V.late.length ? tbl(`<th class="na">Still to play</th><th class="na num" title="${V.real ? "real %Drafted from the export" : "projected ownership"}">Own</th><th class="na num">Proj</th><th class="na num" title="estimated: contenders' hidden slots are filled from their salary left and real ownership">Contenders</th>`, lt) : ""}
    </div>
    <div class="hint" style="padding:0 16px 6px">Chalk that busted drags down every entry that has it, so the contenders own less of it; if you skipped it, you only need to beat the contenders, and the sim rewards the chalkier finishes below when that pays.</div>`;
}

// every version of the entry simmed against the real field, best mean ROI first; your current lineup is marked
function simTable(R) {
  if (!R) return "";
  const sg = v => (v > 0 ? "+" : "") + v.toFixed(1) + "%", NAME = { stk: "Stokastic", etr: "ETR", blick: "Blick", mkt: "Market" };
  return liveTable(R.live) + `<div class="hint" style="padding:2px 16px 4px">${R.rows.length} versions simmed, top 15 shown (of ${R.candidates.toLocaleString()} that fit) against the real field: ${R.fieldN.toLocaleString()} of ${R.N.toLocaleString()} entries${R.unmatched ? ` (${R.unmatched} unreadable)` : ""}, hidden slots filled ${R.live && R.live.real ? "to match the real %Drafted" : "by projected ownership (no %Drafted in the export)"} · payouts: ${esc(R.payouts)} · ${R.sources.map(x => NAME[x] || x).join(", ")} · ${(R.ms / 1000).toFixed(0)}s</div>
    <div class="tw" style="max-height:none;padding:0 16px 8px"><table style="font-size:11.5px"><thead><tr><th class="na">#</th><th class="na">Swaps</th><th class="na num">Proj</th><th class="na num" title="mean sim ROI across the projection sources">ROI</th><th class="na num">Worst</th><th class="na num">Win%</th><th class="na num">Top 1%</th><th class="na num">Cash%</th><th class="na num" title="real %Drafted of the players in your open slots, added up: higher is chalkier">Own</th><th class="na num" title="entries in the field with this exact lineup">Copies</th></tr></thead><tbody>
    ${R.rows.slice(0, 15).map((r, i) => `<tr${r.current ? ' style="background:rgba(var(--neonrgb),.08)"' : ""}><td>${i + 1}</td><td style="white-space:normal">${r.current ? "<b>Current lineup</b>" : r.swaps.map(w => `${esc(w.out)} → <b>${esc(w.in)}</b> <span class="mini">${esc(w.slot)}</span>`).join("<br>")}</td><td class="num">${r.proj}</td><td class="num" title="${esc(R.sources.map(x => `${NAME[x] || x} ${sg(r.roi[x])}`).join(" · "))}"><b class="${r.mean > 0 ? "up" : "dn"}">${sg(r.mean)}</b></td><td class="num">${sg(r.worst)}</td><td class="num">${r.win.toFixed(2)}</td><td class="num">${r.t1.toFixed(1)}</td><td class="num">${r.cash.toFixed(0)}</td><td class="num">${r.ownOpen ?? "—"}</td><td class="num"><span class="${r.copies ? "gap dn" : ""}">${r.copies}</span></td></tr>`).join("")}</tbody></table></div>`;
}

function wire(main, ctx) {
  const { S, api, setMsg, render } = ctx, T = S.late;
  const pull = async () => { T.busy = true; render(); setMsg("Pulling live box scores, reading the standings and re-simulating with started players locked…");
    try { T.data = await api(`/api/lateswap?dir=${encodeURIComponent(S.hub.dir)}&user=${encodeURIComponent(T.user)}`, { method: "POST" }); T.standings = T.data.standings; const n = T.data.entries.filter(e => e.dupes && e.dupes.expected >= 1).length; setMsg(`${T.data.started.length} teams started, ${T.data.locked} players locked${T.data.standings.length ? ` · ${n} ${n === 1 ? "entry is" : "entries are"} likely to finish duplicated` : ""}`, n > 0); }
    catch (err) { setMsg("Late swap failed: " + err.message, true); } T.busy = false; render(); };
  const b = $("#latePull", main); if (b) b.addEventListener("click", pull);
  $$("[data-sim]", main).forEach(x => x.addEventListener("click", async () => { const id = x.getAttribute("data-sim"); T.simBusy = id; render(); setMsg("Simming every version of this entry against the real field…");
    try { const R = await api(`/api/lateswap-sim?dir=${encodeURIComponent(S.hub.dir)}&entry=${encodeURIComponent(id)}`, { method: "POST" }); T.sims[id] = R; const top = R.rows[0], cur = R.rows.find(r => r.current); setMsg(top.current ? `Your current lineup sims best (${top.mean > 0 ? "+" : ""}${top.mean}%)` : `Best: ${top.swaps.map(w => w.out + " → " + w.in).join(", ")} at ${top.mean > 0 ? "+" : ""}${top.mean}% vs your current ${cur.mean > 0 ? "+" : ""}${cur.mean}%`); }
    catch (err) { setMsg("Sim failed: " + err.message, true); } T.simBusy = null; render(); }));
  const user = $("#dkUser", main); if (user) user.addEventListener("change", () => { T.user = user.value.trim(); try { localStorage.setItem(LS, T.user); } catch {} });
  const up = async f => { setMsg(`Reading ${f.name}…`); try { const s = await api(`/api/standings?dir=${encodeURIComponent(S.hub.dir)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.arrayBuffer() }); T.standings = null; setMsg(`Standings for contest ${s.contestId}: ${s.entries.toLocaleString()} entries${s.hidden ? `, ${s.hidden.toLocaleString()} hidden slots` : ""}`); if (T.data) await pull(); else render(); } catch (err) { setMsg("Standings not read: " + err.message, true); } };
  const inp = $("#stFile", main); if (inp) inp.addEventListener("change", e => { const f = e.target.files[0]; if (f) up(f); });
  const z = $("#stDrop", main); if (z) { ["dragenter", "dragover"].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add("over"); })); ["dragleave", "drop"].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove("over"); })); z.addEventListener("drop", e => { for (const f of Array.from(e.dataTransfer.files || [])) up(f); }); }
}
