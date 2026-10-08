// ETR data tables (user-approved 2026-10-06): Defense vs. Position, Expected Fantasy Points and Pass Rate Over Expectation.
// Each ETR page embeds its table as a static Reactable widget on cdn.establishtherun.com (no login needed for the widget
// itself; the weekly read finds the iframe src through the user's Chrome and posts it to /api/etr-data). The hub fetches
// and parses it here and saves data/etr-data/<yyyy>-wk<nn>/<kind>.csv + meta.json, keyed by the week in the widget's file
// name (dvp-wk5-2026-10-06.html). Levitan's contest-selection notes are saved there as contest-selection.md.
// attachData() adds a slate-specific `data` block to the slate guide on every load, using only tables published BEFORE the
// slate's date (no look-ahead), so the Brain sees it; the lineup grade does not use it until the signal tracker
// (bench/signal-tracker-nfl.mjs) shows a signal predicts something.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join("data", "etr-data");
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const ab = t => { t = String(t || "").toUpperCase().replace(/^@/, ""); return t === "LA" ? "LAR" : t === "WSH" ? "WAS" : t; };
const KINDS = { dvp: "dvp-table", xfp: "xfp-site-table", proe: "proe-table" };

// the Reactable widget's columns object ({col: [values]}) from its HTML
export function parseWidget(html) {
  const m = String(html).match(/<script type="application\/json" data-for="([^"]+)">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no table widget in the page");
  const d = JSON.parse(m[2]).x?.tag?.attribs?.data; if (!d) throw new Error("widget has no data");
  return { id: m[1], data: d };
}
const toRows = d => { const ks = Object.keys(d), n = d[ks[0]].length; return Array.from({ length: n }, (_, i) => Object.fromEntries(ks.map(k => [k, d[k][i]]))); };
const csvOf = rows => { const ks = Object.keys(rows[0] || {}); const q = v => v == null || v === "NA" ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v); return [ks.join(","), ...rows.map(r => ks.map(k => q(r[k])).join(","))].join("\n"); };
const parseCsv = txt => { const L = String(txt).trim().split(/\r?\n/), h = L[0].split(","); return L.slice(1).map(l => { const o = [], c = []; let s = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { c.push(s); s = ""; } else s += ch; } c.push(s); return Object.fromEntries(h.map((k, i) => [k, c[i]])); }); };

// week + publish date from the widget file name: ...-wk5-2026-10-06.html
const labelOf = url => { const m = String(url).match(/wk(\d+)-(\d{4})-(\d\d)-(\d\d)\.html/i); return m ? { week: +m[1], year: m[2], published: `${m[2]}-${m[3]}-${m[4]}` } : null; };

export async function fetchEtrData(kind, url) {
  if (!KINDS[kind]) throw new Error("kind must be dvp, xfp or proe");
  const u = new URL(url); if (u.hostname !== "cdn.establishtherun.com" || !/\.html$/.test(u.pathname)) throw new Error("expected the table's cdn.establishtherun.com .html iframe src");
  const lab = labelOf(u.pathname); if (!lab) throw new Error("can't read the week from the file name");
  const r = await fetch(u); if (!r.ok) throw new Error(`fetch ${r.status}`);
  const { id, data } = parseWidget(await r.text()); if (id !== KINDS[kind]) throw new Error(`widget is ${id}, expected ${KINDS[kind]}`);
  const rows = toRows(data), dir = path.join(ROOT, `${lab.year}-wk${String(lab.week).padStart(2, "0")}`);
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${kind}.csv`), csvOf(rows));
  const mf = path.join(dir, "meta.json"), meta = readJ(mf) || {}; meta[kind] = { url: String(u), published: lab.published, week: lab.week, rows: rows.length, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(mf, JSON.stringify(meta, null, 1));
  return { kind, week: lab.week, published: lab.published, rows: rows.length, dir: dir.replace(/\\/g, "/") };
}
export function saveContestSelection(text, week, year = "2026") {
  const dir = path.join(ROOT, `${year}-wk${String(week).padStart(2, "0")}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "contest-selection.md"), String(text)); return { dir: dir.replace(/\\/g, "/") };
}

// latest table of a kind published strictly before the slate date
export function tableFor(kind, date) {
  if (!fs.existsSync(ROOT)) return null;
  let best = null;
  for (const w of fs.readdirSync(ROOT)) { const m = readJ(path.join(ROOT, w, "meta.json")) || {}, k = m[kind]; if (!k || !(k.published < date)) continue; if (!best || k.published > best.published) best = { ...k, dir: w }; }
  if (!best) return null;
  try { return { ...best, rows: parseCsv(fs.readFileSync(path.join(ROOT, best.dir, `${kind}.csv`), "utf8")) }; } catch { return null; }
}
const latestFile = (name, date) => { if (!fs.existsSync(ROOT)) return null; const ws = fs.readdirSync(ROOT).filter(w => fs.existsSync(path.join(ROOT, w, name))).sort(); for (let i = ws.length - 1; i >= 0; i--) { const s = fs.statSync(path.join(ROOT, ws[i], name)); if (s.mtime.toISOString().slice(0, 10) <= date || i === 0) return fs.readFileSync(path.join(ROOT, ws[i], name), "utf8"); } return null; };

const pct = v => +(100 * v).toFixed(1), sgn = v => (v > 0 ? "+" : "") + v;
// the slate's slice of the tables plus a few notable-edge notes
export function slateData(dir) {
  const meta = readJ(path.join("data", dir, "slate.json")) || {}, date = meta.date || String(dir).slice(0, 10);
  const opp = {}; for (const g of meta.games || []) { const [a, h] = String(g).split("@").map(ab); if (a && h) { opp[a] = h; opp[h] = a; } }
  const teams = Object.keys(opp); if (!teams.length) return null;
  const out = { asOf: date, edges: [] };
  const dv = tableFor("dvp", date);
  if (dv) {
    out.dvp = { published: dv.published, week: dv.week, note: "defense's expected % boost(+)/drag(-) to opposing scoring at each position, next ~4 games (ETR, predictive)", vs: {} };
    for (const r of dv.rows.filter(r => r.view === "team")) { const t = ab(r.team); if (!teams.includes(t)) continue; out.dvp.vs[t] = Object.fromEntries(["qb", "rb", "wr", "te", "k", "dst"].map(k => [k.toUpperCase(), r[k] === "" ? null : pct(+r[k])])); }
    // offense facing that defense: positive = good matchup
    const m = []; for (const t of teams) { const d = out.dvp.vs[opp[t]]; if (!d) continue; for (const p of ["QB", "RB", "WR", "TE"]) if (d[p] != null) m.push({ team: t, pos: p, def: opp[t], v: d[p] }); }
    m.sort((a, b) => b.v - a.v);
    for (const x of m.slice(0, 4)) if (x.v >= 3) out.edges.push(`DvP: ${x.team} ${x.pos} vs ${x.def} defense ${sgn(x.v)}%`);
    for (const x of m.slice(-2)) if (x.v <= -5) out.edges.push(`DvP: ${x.team} ${x.pos} vs ${x.def} defense ${x.v}% (tough)`);
  }
  const xf = tableFor("xfp", date);
  if (xf) {
    out.xfp = { published: xf.published, week: xf.week, note: "per-game expected fantasy points from usage (full PPR) vs actual; gap = actual - expected (negative = unlucky, usage better than results)", players: {} };
    const rows = xf.rows.filter(r => teams.includes(ab(r.team)) && +r.games >= 1);
    for (const r of rows) out.xfp.players[r.player] = { team: ab(r.team), pos: r.position, games: +r.games, xfp: +(+r.expected).toFixed(1), actual: +(+r.actual).toFixed(1), gap: +(+r.diff).toFixed(1) };
    const big = rows.filter(r => +r.expected >= 10).sort((a, b) => +a.diff - +b.diff);
    for (const r of big.slice(0, 4)) if (+r.diff <= -3) out.edges.push(`XFP: ${r.player} (${ab(r.team)} ${r.position}) ${(+r.expected).toFixed(1)} expected vs ${(+r.actual).toFixed(1)} actual per game - usage better than results`);
  }
  const pr = tableFor("proe", date);
  if (pr) {
    out.proe = { published: pr.published, week: pr.week, note: "pass rate over expectation (+ = passes more than game script predicts)", teams: {} };
    for (const r of pr.rows.filter(r => r.view === "all")) { const t = ab(r.team); if (!teams.includes(t)) continue; out.proe.teams[t] = { proe: pct(+r.proe), neutral: r.proe_neutral === "" ? null : pct(+r.proe_neutral), last4: r.proe_last_4 === "" ? null : pct(+r.proe_last_4) }; }
    const s = Object.entries(out.proe.teams).sort((a, b) => b[1].proe - a[1].proe);
    const f = ([t, v]) => `${t} ${sgn(v.proe)}%`;
    if (s.length > 4) out.edges.push(`PROE: most pass-happy ${s.slice(0, 2).map(f).join(", ")}; most run-heavy ${s.slice(-2).map(f).join(", ")}`);
    else if (s.length) out.edges.push(`PROE: ${s.map(f).join(", ")}`);
  }
  const cs = latestFile("contest-selection.md", date); if (cs) out.contestSel = cs.split(/\r?\n/).filter(l => /^\s*[-*] /.test(l)).map(l => l.replace(/^\s*[-*] /, "").trim()).slice(0, 12);
  return out.dvp || out.xfp || out.proe || out.contestSel ? out : null;
}
// guide + data, computed on load so a guide rewrite never drops it
export const withData = (guide, dir) => { if (!guide) return guide; try { const d = slateData(dir); if (d) return Object.assign({}, guide, { data: d }); } catch {} return guide; };
