// Contests view: the contest picker (user, 2026-10-14: DraftKings only, a ranked list). Ranked by entry cap, then the
// share of entrants the archive has never seen, then rake (server/picker.mjs). Not the old "your record by family"
// view: his own history measures the old process (2026-10-02). Data from /api/picker; this file only draws it.
import { $, $$, esc } from "../app/ui.mjs";

const pc = (v, d = 0) => v == null || isNaN(v) ? "—" : (100 * v).toFixed(d) + "%";
const money = v => v == null ? "—" : "$" + Math.round(v).toLocaleString();
const capLabel = c => c == null ? "—" : c === 1 ? "SE" : c + "-max";
const tierChip = t => `<span class="vchip ${["g", "g", "y", "r"][t]}">${["single", "2-3 max", "4-20 max", "21+ max"][t]}</span>`;

export async function renderContests(main, ctx) {
  const { S, api, setMsg } = ctx; S.pk = S.pk || { data: null, dir: null, group: null, q: "", minFee: 5, busy: false };
  if (!S.hub) { main.innerHTML = `<div class="empty">Load a slate first<small>The lobby is matched to the slate's games and start time.</small></div>`; $("#bot").innerHTML = ""; return; }
  const P = S.pk, qs = () => `/api/picker?dir=${encodeURIComponent(S.hub.dir)}${P.group ? "&group=" + P.group : ""}&minfee=${P.minFee}`;
  if (!P.data || P.dir !== S.hub.dir) { try { P.data = await api(qs()); P.dir = S.hub.dir; } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
  const D = P.data, med = D.median;
  const rows = D.rows.filter(c => !P.q || c.name.toLowerCase().includes(P.q.toLowerCase()));
  const read = D.rows.filter(r => r.unknown != null).length, last = D.rows.map(r => r.fetched).filter(Boolean).sort().pop();
  let html = `<div class="tool"><button id="pkPull" class="btn"${P.busy ? " disabled" : ""}>${P.busy ? "Reading entrants…" : "Read entrants"}</button>
    <span class="hint">Lobby ${D.fetched ? "pulled " + new Date(D.fetched).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not pulled (Refresh)"} · entrants read for ${read}/${D.rows.length}${last ? ", last " + new Date(last).toLocaleString([], { hour: "numeric", minute: "2-digit" }) : ""} · user index ${D.index ? D.index.contests + " contests" : "missing (run bench/user-index-nfl.mjs)"}</span>
    ${D.groups.length > 1 ? `<div class="pos">${D.groups.map(g => `<button data-group="${g.draftGroup}" aria-selected="${!!g.picked}" title="${g.n} contests, $${Math.round(g.prize).toLocaleString()} in prizes">${esc(g.start)} · ${g.n}</button>`).join("")}</div>` : ""}
    <div class="pos">${[0, 5, 25, 100, 300].map(f => `<button data-fee="${f}" aria-selected="${P.minFee === f}">$${f}+</button>`).join("")}</div>
    <div class="grow"></div><div class="search">🔍 <input id="pq" placeholder="Contest name" value="${esc(P.q)}"></div></div>`;
  html += `<div class="tw" style="max-height:62vh"><table><thead><tr><th class="na num">#</th><th class="na">Cap</th><th class="na">Contest</th><th class="na num">Fee</th><th class="na num" title="entries now / max">Filled</th>
    <th class="na num" title="first 99 entrants (earliest) with fewer than 30 entries in our archive; higher = softer">Unknown</th><th class="na num" title="share of the first 99 entrants' entries from proven players (13%+ top-10% rate over 30+ archive entries)">Proven</th>
    <th class="na num" title="DraftKings' cut: 1 - prize pool / (fee x max entries)">Rake</th><th class="na num">Prizes</th><th class="na num" title="first prize as a share of the pool">Top%</th><th class="na num" title="prize pool not yet covered by entries at the current fill">Overlay now</th><th class="na">Proven entered</th></tr></thead><tbody>
    ${rows.map(c => `<tr><td class="num">${c.rank}</td><td>${tierChip(c.capTier)}<br><span class="mini">${capLabel(c.cap)}</span></td>
      <td style="white-space:normal;max-width:280px"><b>${esc(c.name.replace(/^NFL /, ""))}</b><br><span class="mini">${esc(c.start || "")}</span></td>
      <td class="num">$${c.fee.toLocaleString()}</td><td class="num">${(c.entered ?? 0).toLocaleString()} / ${(c.field || 0).toLocaleString()}<br><span class="mini">${pc(c.fill)}</span></td>
      <td class="num">${c.unknown == null ? `<span class="mini">not read</span>` : `<span class="${med != null && c.unknown >= med ? "gap up" : ""}">${pc(c.unknown)}</span><br><span class="mini">${c.listed} users</span>`}</td>
      <td class="num">${pc(c.proven)}</td><td class="num">${pc(c.rake, 1)}</td><td class="num">${money(c.prizePool)}</td><td class="num">${c.topShare == null ? "—" : pc(c.topShare)}</td>
      <td class="num">${c.overlay ? `<span class="gap up">${money(c.overlay)}</span>` : "—"}</td>
      <td class="mini" style="white-space:normal;max-width:220px">${c.provenNames && c.provenNames.length ? c.provenNames.map(p => `${esc(p.u)}${p.n > 1 ? " x" + p.n : ""}`).join(", ") : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
  main.innerHTML = html;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">Ranked by entry cap (single entry first), then the share of unknown entrants (green = above this slate's median), then rake. Backtest, 528 contests: proven players made +19.5% in single entry vs -10.5% at 7-150 max, and their edge over the field grew from 9 to 23 points as unknown entrants rose. Field size and payout shape are shown for variance; they did not predict edge. DK lists only the first 99 entrants, so this is the earliest entrants. Overlay only means something close to lock.</span></div>`;
  $("#pkPull", main).addEventListener("click", async () => { P.busy = true; renderContests(main, ctx); try { P.data = await api(qs(), { method: "POST" }); const g = P.data.pulled; setMsg(`Entrants: ${g.fetched} read, ${g.cached} cached${g.failed.length ? ", " + g.failed.length + " failed" : ""}`); } catch (e) { setMsg(e.message, true); } P.busy = false; renderContests(main, ctx); });
  $$("[data-group]", main).forEach(b => b.addEventListener("click", () => { P.group = b.getAttribute("data-group"); P.data = null; ctx.render(); }));
  $$("[data-fee]", main).forEach(b => b.addEventListener("click", () => { P.minFee = +b.getAttribute("data-fee"); P.data = null; renderContests(main, ctx); }));
  $("#pq", main).addEventListener("input", e => { P.q = e.target.value; renderContests(main, ctx); const i = $("#pq"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
}
