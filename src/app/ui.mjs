// Small rendering helpers shared by the screens.
export const $ = (s, r) => (r || document).querySelector(s);
export const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
export const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmt = (v, d = 1) => v == null || isNaN(v) ? '<span class="miss">&mdash;</span>' : (+v).toFixed(d);
export const money = v => v == null || isNaN(v) ? '<span class="miss">&mdash;</span>' : "$" + Math.round(v).toLocaleString();
export const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "&mdash;";
export const signed = (v, d = 1) => v == null || isNaN(v) ? '<span class="miss">&mdash;</span>'
  : `<span style="color:${v > 0 ? "var(--good)" : v < 0 ? "var(--bad)" : "var(--muted)"}">${v > 0 ? "+" : ""}${(+v).toFixed(d)}%</span>`;
export const heat = p => p == null || isNaN(p) ? "" : `background:rgba(var(--accent-rgb),${(Math.max(0, Math.min(1, p)) * 0.42).toFixed(3)})`;

// Sortable, pageable table. cols: [{k, label, num, render, sortable}]. state: {sort:{k,d}, page, per}.
export function table(cols, rows, state, opts = {}) {
  const st = state, per = st.per || 100;
  let idx = rows.map((r, i) => i);
  if (st.sort && st.sort.k) {
    const k = st.sort.k, d = st.sort.d, col = cols.find(c => c.k === k);
    const val = col && col.sortVal ? col.sortVal : r => r[k];
    idx.sort((a, b) => { const x = val(rows[a]), y = val(rows[b]); if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * d || a - b; });
  }
  const pages = Math.max(1, Math.ceil(idx.length / per)); if (st.page >= pages) st.page = pages - 1; if (st.page < 0) st.page = 0;
  const from = st.page * per, to = Math.min(idx.length, from + per);
  let h = `<div class="tablewrap${opts.tall ? " tall" : ""}"><table><thead><tr>`;
  for (const c of cols) {
    const ar = st.sort && st.sort.k === c.k ? `<span class="ar">${st.sort.d < 0 ? "▼" : "▲"}</span>` : "";
    h += `<th class="${c.num ? "num" : ""}${c.sortable === false ? " na" : ""}" ${c.sortable === false ? "" : `data-sort="${c.k}"`}>${c.label}${ar}</th>`;
  }
  h += "</tr></thead><tbody>";
  for (let i = from; i < to; i++) {
    const r = rows[idx[i]]; h += `<tr${opts.rowAttr ? " " + opts.rowAttr(r, idx[i]) : ""}>`;
    for (const c of cols) h += `<td class="${c.num ? "num" : ""}"${c.style ? ` style="${c.style(r)}"` : ""}>${c.render ? c.render(r, idx[i]) : esc(r[c.k])}</td>`;
    h += "</tr>";
  }
  h += "</tbody></table></div>";
  if (idx.length > per || opts.pager) {
    h += `<div class="bar" style="border-top:none"><span class="hint">Rows per page <select data-per style="width:auto;padding:2px 5px">${[50, 100, 250, 500].map(n => `<option${per === n ? " selected" : ""}>${n}</option>`).join("")}</select></span>` +
      `<span class="hint">${(from + 1).toLocaleString()}&ndash;${to.toLocaleString()} of ${idx.length.toLocaleString()}</span>` +
      `<button class="btn ghost" data-page="-1"${st.page <= 0 ? " disabled" : ""}>&lsaquo; prev</button><button class="btn ghost" data-page="1"${st.page >= pages - 1 ? " disabled" : ""}>next &rsaquo;</button>` +
      `<div class="grow"></div><span class="hint">page ${st.page + 1} of ${pages}</span></div>`;
  }
  return h;
}
export function wireTable(root, state, rerender) {
  $$("th[data-sort]", root).forEach(th => th.addEventListener("click", () => {
    const k = th.getAttribute("data-sort");
    if (state.sort && state.sort.k === k) state.sort.d *= -1; else state.sort = { k, d: -1 };
    state.page = 0; rerender();
  }));
  $$("[data-page]", root).forEach(b => b.addEventListener("click", () => { state.page += +b.getAttribute("data-page"); rerender(); }));
  const per = $("[data-per]", root); if (per) per.addEventListener("change", () => { state.per = +per.value; state.page = 0; rerender(); });
}
export function copyText(text) {
  const t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t);
  t.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  document.body.removeChild(t); return ok;
}
export function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); }); }
export function wireDrop(zone, input, onText) {
  if (input) input.addEventListener("change", async e => { const files = Array.from(e.target.files || []); for (const fl of files) onText(await readFile(fl), fl.name); try { e.target.value = ""; } catch (err) {} });
  if (!zone) return;
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", async e => { for (const fl of Array.from(e.dataTransfer.files || [])) onText(await readFile(fl), fl.name); });
}
export function download(name, text) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
