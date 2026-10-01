// What changed since you built: every Refresh saves a compact snapshot of the merged table
// (data/<slate>/merges/<stamp>.json); "Mark as built" copies the current one to baseline.json.
// diff() lists projection moves, ownership moves, new injury designations and line moves between
// the baseline (or, without one, the previous refresh) and now.
import fs from "node:fs";
import path from "node:path";

const stamp = d => { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
export function snapshot(hub) {
  const rows = {}; for (const r of hub.rows) rows[r.key] = { n: r.name, t: r.team, ps: r.pos, p: [r.stk?.proj ?? null, r.etr?.proj ?? null, r.blick?.proj ?? null, r.mkt?.proj ?? null], o: [r.stk?.own ?? null, r.etr?.own ?? null, r.blick?.own ?? null], i: r.inj ? r.inj.status : (r.stk?.inj || "") };
  const games = {}; for (const g of hub.games) games[g.game] = { spread: g.spread, total: g.total, ttA: g.ttAway, ttH: g.ttHome };
  return { at: hub.builtAt, rows, games };
}
export function saveMerge(dir, hub) {
  const d = path.join("data", dir, "merges"); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, stamp(new Date()) + ".json"); fs.writeFileSync(f, JSON.stringify(snapshot(hub)));
  const all = fs.readdirSync(d).filter(x => x.endsWith(".json")).sort(); for (const x of all.slice(0, Math.max(0, all.length - 60))) fs.unlinkSync(path.join(d, x));
  return f;
}
export function markBuilt(dir, hub) { const f = path.join("data", dir, "baseline.json"); fs.writeFileSync(f, JSON.stringify(Object.assign(snapshot(hub), { marked: new Date().toISOString() }))); return f; }
export function diff(dir, hub) {
  const base = path.join("data", dir, "baseline.json"), md = path.join("data", dir, "merges");
  let from = null, label = null;
  if (fs.existsSync(base)) { from = JSON.parse(fs.readFileSync(base, "utf8")); label = "since you marked built " + from.marked; }
  else if (fs.existsSync(md)) { const all = fs.readdirSync(md).filter(x => x.endsWith(".json")).sort(); if (all.length >= 2) { from = JSON.parse(fs.readFileSync(path.join(md, all[all.length - 2]), "utf8")); label = "since the previous refresh " + from.at; } }
  if (!from) return { label: "no earlier snapshot yet (refresh again, or Mark as built)", proj: [], own: [], inj: [], lines: [] };
  const now = snapshot(hub), SRC = ["Stokastic", "ETR", "Blick", "Market"], OWN = ["Stokastic", "ETR", "Blick"], proj = [], own = [], inj = [], lines = [];
  for (const [k, cur] of Object.entries(now.rows)) {
    const old = from.rows[k]; if (!old) continue;
    cur.p.forEach((v, i) => { const o = old.p[i]; if (v != null && o != null && Math.abs(v - o) >= 0.5) proj.push({ name: cur.n, team: cur.t, pos: cur.ps, src: SRC[i], from: o, to: v, d: +(v - o).toFixed(1) }); });
    cur.o.forEach((v, i) => { const o = old.o[i]; if (v != null && o != null && Math.abs(v - o) >= 2) own.push({ name: cur.n, team: cur.t, pos: cur.ps, src: OWN[i], from: o, to: v, d: +(v - o).toFixed(1) }); });
    if ((cur.i || "") !== (old.i || "")) inj.push({ name: cur.n, team: cur.t, pos: cur.ps, from: old.i || "Active", to: cur.i || "Active" });
  }
  for (const [g, cur] of Object.entries(now.games)) { const old = from.games[g]; if (!old) continue; for (const k of ["spread", "total", "ttA", "ttH"]) if (cur[k] != null && old[k] != null && Math.abs(cur[k] - old[k]) >= 0.5) lines.push({ game: g, k: { spread: "spread", total: "total", ttA: g.split("@")[0] + " total", ttH: g.split("@")[1] + " total" }[k], from: old[k], to: cur[k], d: +(cur[k] - old[k]).toFixed(1) }); }
  proj.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)); own.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return { label, from: from.at, proj: proj.slice(0, 80), own: own.slice(0, 80), inj, lines };
}
