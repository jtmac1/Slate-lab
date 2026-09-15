// Showdown structure study: for each real showdown field, how common is each lineup
// structure (captain position | team split | kicker+defense count | QB count), how did it
// do, and how close is the best lineup inside it to the best lineup overall? A structure
// that is rare and near-optimal is the cheapest way to be different.
//   node bench/sd-structure.mjs
import { listContests, recover } from "./grade-all.mjs";
import { enumerateShowdown, structureOf } from "../src/engine/showdown.mjs";

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
for (const c of listContests().filter(x => x.fkey === "nfl_sd")) {
  const rc = recover(c), P = rc.pool.players, E = rc.entries, N = E.length, paid = rc.paid;
  const t0 = Date.now(), best = enumerateShowdown(rc.pool, { perStructure: 1 }), ms = Date.now() - t0;
  const globalBest = Math.max(...Object.values(best).map(b => b[0].proj));
  const byS = {};
  for (const e of E) { const k = structureOf(e.lu, P); const g = byS[k] || (byS[k] = { n: 0, dup: 0, roi: [], cash: 0 }); g.n++; if (e.dupes > 0) g.dup++; g.roi.push(e.actROI); if (e.finish <= paid) g.cash++; }
  const rows = Object.keys(best).map(k => { const g = byS[k] || { n: 0, dup: 0, roi: [], cash: 0 }, b = best[k][0]; return { k, share: 100 * g.n / N, dupPct: g.n ? 100 * g.dup / g.n : 0, roi: mean(g.roi), cash: g.n ? 100 * g.cash / g.n : 0, n: g.n, opt: 100 * b.proj / globalBest, own: b.own, names: b.lu.map(id => P[id].name.split(" ").pop()).join(",") }; })
    .sort((a, b) => b.share - a.share);
  console.log(`\n=== ${c.dir}: ${N} entries, ${paid} paid, ${rows.length} structures with a legal lineup; enumeration ${ms} ms; best projection overall ${globalBest.toFixed(1)}`);
  console.log("structure (cpt|split|K+DST|QB)".padEnd(32) + "share%  n     dup%   actROI  cash%  | best-in-structure: %of-best  ownsum  lineup");
  for (const r of rows.filter(r => r.share >= 0.5 || r.opt >= 97)) console.log(r.k.padEnd(32) + r.share.toFixed(1).padEnd(8) + String(r.n).padEnd(6) + r.dupPct.toFixed(0).padEnd(7) + (r.roi.toFixed(0) + "%").padEnd(8) + r.cash.toFixed(0).padEnd(7) + "| " + r.opt.toFixed(1).padEnd(10) + r.own.toFixed(0).padEnd(8) + r.names);
  const rare = rows.filter(r => r.share < 2 && r.opt >= 96).sort((a, b) => b.opt - a.opt).slice(0, 6);
  console.log("rare (<2% of field) and within 4% of the best projection: " + (rare.length ? rare.map(r => `${r.k} (${r.share.toFixed(1)}%, ${r.opt.toFixed(1)}%)`).join("; ") : "none"));
  const common = rows.filter(r => r.share >= 5);
  console.log(`common structures (>=5% share): ${common.length}, covering ${common.reduce((s, r) => s + r.share, 0).toFixed(0)}% of entries, dup rate ${mean(common.map(r => r.dupPct)).toFixed(0)}%; rare structures (<2%): ${rows.filter(r => r.share < 2 && r.n).length}, dup rate ${mean(rows.filter(r => r.share < 2 && r.n).map(r => r.dupPct)).toFixed(0)}%`);
}
