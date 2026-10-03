// Generator + four-source sim: build candidate lineups from one projection source (Lab blend by
// default) with the vendors' average ownership, then simulate every candidate under all four
// sources and rank them per source, so the lineups that hold up everywhere stand out from the
// ones that need one vendor to be right. Each candidate also gets the full rules check. Results
// are saved to data/<slate>/gen.json and exported from the page as a DraftKings upload CSV.
import fs from "node:fs";
import path from "node:path";
import { buildLineups } from "../src/engine/build.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { nrm } from "../src/engine/csv.mjs";
import { loadPool, simLineups, attachSim, keyOf, ownOf, cptOf, projOf } from "./foursim.mjs";
import { evalContext, evaluateLineup, verdictOf, playerFrom, lobby } from "./entries.mjs";

export const loadGen = dir => { const f = path.join("data", dir, "gen.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };

export function generateAndSim(dir, cfg = {}) {
  const t0 = Date.now(), L = loadPool(dir), { hub, pool, hubBy, vendors, srcs, sd } = L, P = pool.players, ctx = evalContext(dir, hub), f = ctx.f;
  const src = cfg.src || "lab", ownSrc = cfg.ownSrc || "avg";
  // the building pool: chosen projections, chosen ownership, captain ownership alongside
  const players = P.map(p => { const r = hubBy.get(keyOf(p.name, p.pos, p.team)); const own = ownOf(r, ownSrc, vendors) ?? p.own, cown = cptOf(r, ownSrc, vendors) ?? Math.max(0.1, own / 6); return Object.assign({}, p, { proj: Math.max(0, projOf(r, src, p.proj) ?? 0), own, cown, fown: own, ceil: r && r.etr && r.etr.ceil != null ? r.etr.ceil : (r && r.blick && r.blick.ceil != null ? r.blick.ceil : p.ceil) }); });
  const byName = new Map(); players.forEach((p, i) => byName.set(nrm(p.name), i));
  const ids = txt => String(txt || "").split(/[,\n;]+/).map(s => nrm(s.trim())).filter(Boolean).map(k => byName.get(k)).filter(i => i != null);
  const gp = Object.assign({}, pool, { players });
  const n = Math.max(1, Math.min(300, +cfg.n || 50));
  let r, source;
  if (cfg.lineups && cfg.lineups.length) {
    // uploaded lineups: rows of names (optionally "Name (id)"), captain first in showdown
    const byId = new Map(); hub.rows.forEach(x => { if (x.stk?.dkId) byId.set(x.stk.dkId, x); if (x.stk?.cptDkId) byId.set(x.stk.cptDkId, x); });
    const bad = []; const lus = cfg.lineups.map((row, i) => { const lu = row.map(s => { const id = (String(s).match(/\((\d+)\)/) || [])[1], name = String(s).replace(/\s*\(\d+\)\s*$/, "").trim(); const h = id && byId.get(id); const idx = h ? byName.get(nrm(h.name)) : byName.get(nrm(name)); if (idx == null) bad.push(name); return idx; }); return lu; }).filter(lu => lu.length === f.slots.length && lu.every(i => i != null));
    if (!lus.length) throw new Error("no uploaded lineup matched this slate's players" + (bad.length ? ": " + [...new Set(bad)].slice(0, 6).join(", ") : ""));
    r = { lineups: lus.slice(0, 300), tries: 0 }; source = `uploaded (${lus.length}${bad.length ? `, ${new Set(bad).size} names unmatched` : ""})`;
  } else {
    r = buildLineups(gp, { n, obj: cfg.obj || "blend", rand: Math.max(0, +(cfg.rand ?? 18)) / 100, maxExp: Math.max(5, +cfg.maxExp || 60), minSal: +cfg.minSal || 0, minUniq: Math.max(0, +(cfg.minUniq ?? 1)), stackSize: 0, force: ids(cfg.force), exclude: ids(cfg.exclude) }, mulberry32(+cfg.seed || 1));
    if (r.err) throw new Error(r.err); if (!r.lineups.length) throw new Error("the builder produced no lineups (force/exclude too tight?)");
    source = "built";
  }
  const LB = lobby(), c = cfg.cid ? LB.get(String(cfg.cid)) : null, fee = c ? c.fee : (+cfg.fee || 20), N = c ? (c.field || 10000) : (+cfg.N || 10000);
  const sim = simLineups(L, r.lineups, { fee, N, contestName: c ? c.name : "", prizePool: c?.prizePool });
  const rows = r.lineups.map((lu, k) => {
    const pl = lu.map((idx, j) => playerFrom(hubBy.get(keyOf(P[idx].name, P[idx].pos, P[idx].team)), f.slots[j], sd && j === 0));
    const e = evaluateLineup(pl, fee, N, ctx); e.n = k; attachSim(e, sim, k, fee, sd); verdictOf(e); return e;
  });
  // ranks per source and across them
  for (const s of srcs) { const order = rows.map((e, i) => i).sort((a, b) => rows[b].sim[s].roi - rows[a].sim[s].roi); order.forEach((i, rank) => { rows[i].sim[s].rank = rank + 1; }); }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  for (const e of rows) { const rk = srcs.map(s => e.sim[s].rank); e.sim.meanRank = +mean(rk).toFixed(1); e.sim.rankSpread = Math.max(...rk) - Math.min(...rk); e.sim.bestRank = Math.min(...rk); for (const k of ["win", "t1", "t10", "cash", "dupN", "se"]) e.sim[k] = +mean(srcs.map(s => e.sim[s][k] || 0)).toFixed(k === "win" ? 3 : 2); }
  rows.sort((a, b) => b.sim.mean - a.sim.mean);
  const cnt = {}; for (const e of rows) for (const p of e.players) { const k = p.name + "|" + p.team; const x = cnt[k] = cnt[k] || { name: p.name, team: p.team, pos: p.pos, opp: p.opp, sal: p.isCpt ? Math.round(p.sal / 1.5) : p.sal, n: 0, own: p.own, cpt: 0, roi: 0, by: Object.fromEntries(srcs.map(s => [s, 0])) }; x.n++; if (p.isCpt) x.cpt++; x.roi += e.sim.mean; for (const s of srcs) x.by[s] += e.sim[s].roi; }
  const exposure = Object.values(cnt).map(x => Object.assign(x, { pct: +(100 * x.n / rows.length).toFixed(0), delta: x.own == null ? null : +(100 * x.n / rows.length - x.own).toFixed(0), roi: +(x.roi / x.n).toFixed(1), by: Object.fromEntries(srcs.map(s => [s, +(x.by[s] / x.n).toFixed(1)])) })).sort((a, b) => b.roi - a.roi);
  const out = { dir, at: new Date().toISOString(), ms: Date.now() - t0, source, cfg: Object.assign({}, cfg, { n, lineups: undefined }), contest: { cid: c ? c.id : null, name: c ? c.name : "", fee, N, fieldN: sim.fieldN }, sources: srcs, src, ownSrc, format: ctx.fkey, rows, exposure, summary: { n: rows.length, ok: rows.filter(e => e.verdict === "ok").length, warn: rows.filter(e => e.verdict === "warn").length, fail: rows.filter(e => e.verdict === "FAIL").length, allPositive: rows.filter(e => e.sim.worst > 0).length, tries: r.tries } };
  fs.writeFileSync(path.join("data", dir, "gen.json"), JSON.stringify(out, null, 1));
  return out;
}
