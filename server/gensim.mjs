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
  const r = buildLineups(gp, { n, obj: cfg.obj || "blend", rand: Math.max(0, +(cfg.rand ?? 18)) / 100, maxExp: Math.max(5, +cfg.maxExp || 60), minSal: +cfg.minSal || 0, minUniq: Math.max(0, +(cfg.minUniq ?? 1)), stackSize: 0, force: ids(cfg.force), exclude: ids(cfg.exclude) }, mulberry32(+cfg.seed || 1));
  if (r.err) throw new Error(r.err); if (!r.lineups.length) throw new Error("the builder produced no lineups (force/exclude too tight?)");
  const LB = lobby(), c = cfg.cid ? LB.get(String(cfg.cid)) : null, fee = c ? c.fee : (+cfg.fee || 20), N = c ? (c.field || 10000) : (+cfg.N || 10000);
  const sim = simLineups(L, r.lineups, { fee, N, contestName: c ? c.name : "", prizePool: c?.prizePool });
  const rows = r.lineups.map((lu, k) => {
    const pl = lu.map((idx, j) => playerFrom(hubBy.get(keyOf(P[idx].name, P[idx].pos, P[idx].team)), f.slots[j], sd && j === 0));
    const e = evaluateLineup(pl, fee, N, ctx); e.n = k; attachSim(e, sim, k, fee, sd); verdictOf(e); return e;
  });
  // ranks per source and across them
  for (const s of srcs) { const order = rows.map((e, i) => i).sort((a, b) => rows[b].sim[s].roi - rows[a].sim[s].roi); order.forEach((i, rank) => { rows[i].sim[s].rank = rank + 1; }); }
  for (const e of rows) { const rk = srcs.map(s => e.sim[s].rank); e.sim.meanRank = +(rk.reduce((a, b) => a + b, 0) / rk.length).toFixed(1); e.sim.rankSpread = Math.max(...rk) - Math.min(...rk); e.sim.bestRank = Math.min(...rk); }
  rows.sort((a, b) => a.sim.meanRank - b.sim.meanRank);
  const cnt = {}; for (const e of rows) for (const p of e.players) { const k = p.name + "|" + p.team; const x = cnt[k] = cnt[k] || { name: p.name, team: p.team, pos: p.pos, n: 0, own: p.own, cpt: 0 }; x.n++; if (p.isCpt) x.cpt++; }
  const exposure = Object.values(cnt).map(x => Object.assign(x, { pct: +(100 * x.n / rows.length).toFixed(0), delta: x.own == null ? null : +(100 * x.n / rows.length - x.own).toFixed(0) })).sort((a, b) => b.n - a.n);
  const out = { dir, at: new Date().toISOString(), ms: Date.now() - t0, cfg: Object.assign({}, cfg, { n }), contest: { cid: c ? c.id : null, name: c ? c.name : "", fee, N }, sources: srcs, src, ownSrc, format: ctx.fkey, rows, exposure, summary: { n: rows.length, ok: rows.filter(e => e.verdict === "ok").length, warn: rows.filter(e => e.verdict === "warn").length, fail: rows.filter(e => e.verdict === "FAIL").length, allPositive: rows.filter(e => e.sim.worst > 0).length, tries: r.tries } };
  fs.writeFileSync(path.join("data", dir, "gen.json"), JSON.stringify(out, null, 1));
  return out;
}
