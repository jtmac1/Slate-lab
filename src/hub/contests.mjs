// Contests view: the DraftKings lobby for the loaded slate, each contest tagged with this account's
// record in that contest family and its fee/field bucket, plus the family and bucket records
// themselves. Data from server/contests.mjs; this file only draws it.
import { $, $$, esc } from "../app/ui.mjs";

const pc = v => v == null || isNaN(v) ? "—" : (100 * v).toFixed(1) + "%";
const money = v => v == null ? "—" : "$" + Math.round(v).toLocaleString();
const chip = v => `<span class="vchip ${v === "PLAY" ? "g" : v === "AVOID" ? "r" : v === "neutral" ? "y" : "m"}">${v === "few" ? "no record" : v}</span>`;
const rec = s => s ? `${s.n} ent / ${s.contests} ctst · ROI <b>${pc(s.roi)}</b> · t ${s.t == null ? "—" : s.t.toFixed(1)} · W${s.wins} (exp ${s.expWins})` : "never entered";

export async function renderContests(main, ctx) {
  const { S, api, setMsg } = ctx; S.con = S.con || { data: null, dir: null, group: null, q: "" };
  if (!S.hub) { main.innerHTML = `<div class="empty">Load a slate first<small>The lobby is matched to the slate's games and start time.</small></div>`; $("#bot").innerHTML = ""; return; }
  if (!S.con.data || S.con.dir !== S.hub.dir) { try { S.con.data = await api(`/api/contests?dir=${encodeURIComponent(S.hub.dir)}${S.con.group ? "&group=" + S.con.group : ""}`); S.con.dir = S.hub.dir; } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
  const D = S.con.data, o = D.overall;
  let html = `<div class="tool"><span class="hint">Lobby ${D.fetched ? "pulled " + new Date(D.fetched).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not pulled (Refresh)"} · history ${esc(D.historyFile || "none")}</span>
    ${D.groups.length > 1 ? `<div class="pos">${D.groups.map(g => `<button data-group="${g.draftGroup}" aria-selected="${!!g.picked}" title="${g.n} contests, $${Math.round(g.prize).toLocaleString()} in prizes">${esc(g.start)} · ${g.n}</button>`).join("")}</div>` : ""}
    <div class="grow"></div><div class="search">🔍 <input id="cq" placeholder="Contest name" value="${esc(S.con.q)}"></div></div>`;
  if (o) html += `<div class="kpi">${[["Your record", `${o.n} entries`], ["Contests", o.contests], ["In", money(o.fee)], ["Out", money(o.win)], ["ROI", pc(o.roi)], ["Wins", `${o.wins} vs ${o.expWins} exp`], ["Top 10%", pc(o.top10)], ["Cash", pc(o.cash)]].map(([k, v]) => `<div class="box"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>`;
  const rows = D.contests.filter(c => !S.con.q || c.name.toLowerCase().includes(S.con.q.toLowerCase()));
  html += `<div class="tw" style="max-height:52vh"><table><thead><tr><th class="na">Verdict</th><th class="na">Contest</th><th class="na num">Fee</th><th class="na num">Field</th><th class="na num">Cap</th><th class="na num">Prizes</th><th class="na num">1st</th><th class="na num" title="first prize as a share of the pool">Top%</th><th class="na">Your record in this family</th><th class="na">Bucket</th></tr></thead><tbody>
    ${rows.map(c => `<tr><td>${chip(c.verdict)}</td><td style="white-space:normal;max-width:300px"><b>${esc(c.name.replace(/^NFL (Showdown )?/, ""))}</b><br><span class="mini">${esc(c.fam)} · ${esc(c.start)}</span></td><td class="num">$${c.fee}</td><td class="num">${c.entered != null ? c.entered.toLocaleString() + " / " : ""}${(c.field || 0).toLocaleString()}</td><td class="num">${c.cap ?? "—"}</td><td class="num">${money(c.prizePool)}</td><td class="num">${money(c.top)}</td><td class="num">${c.topShare == null ? "—" : (100 * c.topShare).toFixed(0) + "%"}</td><td class="hint" style="white-space:normal;max-width:260px">${rec(c.record)}</td><td class="hint" style="white-space:normal">${chip(c.bucketVerdict)} ${esc(c.bucket)}${c.bucketRecord ? `<br><span class="mini">ROI ${pc(c.bucketRecord.roi)} · t ${c.bucketRecord.t == null ? "—" : c.bucketRecord.t.toFixed(1)} · n ${c.bucketRecord.n}</span>` : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
  const tbl = (title, list, key) => `<div style="padding:12px 16px 4px"><b style="font-size:12.5px">${title}</b></div><div class="tw" style="max-height:34vh"><table><thead><tr><th class="na">${key}</th><th class="na">Verdict</th><th class="na num">Entries</th><th class="na num">Contests</th><th class="na num">In</th><th class="na num">Out</th><th class="na num">ROI</th><th class="na num">t</th><th class="na num">Wins / exp</th><th class="na num">Top 10%</th><th class="na num">Avg fee</th><th class="na">Last</th></tr></thead><tbody>
    ${list.map(s => `<tr><td><b>${esc(s.fam || s.bucket)}</b></td><td>${chip(s.verdict)}</td><td class="num">${s.n}</td><td class="num">${s.contests}</td><td class="num">${money(s.fee)}</td><td class="num">${money(s.win)}</td><td class="num"><span class="${s.roi > 0 ? "gap up" : "gap dn"}">${pc(s.roi)}</span></td><td class="num">${s.t == null ? "—" : s.t.toFixed(1)}</td><td class="num">${s.wins} / ${s.expWins}</td><td class="num">${pc(s.top10)}</td><td class="num">$${s.avgFee}</td><td class="mini">${esc((s.last || "").slice(0, 10))}</td></tr>`).join("")}</tbody></table></div>`;
  html += tbl("Your record by contest family (" + (S.hub.slate.type === "SHOWDOWN" ? "showdown" : "classic") + ", 5+ contests)", D.families, "Family") + tbl("Your record by fee tier and field size", D.buckets, "Bucket");
  main.innerHTML = html;
  $("#bot").innerHTML = `<div class="bot"><span class="hint">PLAY = positive ROI with clustered t ≥ 2 or 3+ wins beyond the field rate; AVOID = negative with t ≤ −2; 15+ contests needed for a verdict. The Dealer's point: the edge starts here, before any lineup exists.</span></div>`;
  $$("[data-group]", main).forEach(b => b.addEventListener("click", () => { S.con.group = b.getAttribute("data-group"); S.con.data = null; ctx.render(); }));
  $("#cq", main).addEventListener("input", e => { S.con.q = e.target.value; renderContests(main, ctx); const i = $("#cq"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
}
