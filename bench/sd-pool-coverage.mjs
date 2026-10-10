// Did our showdown sim pool contain what won? For every showdown slate with a saved simrun.json, match the real contests on
// the same game (data/post) and compare: winners and top-1% lineups found in the pool (exact captain + flex) and their Lab ROI
// rank, and the mix of captain position / team split / captain projected ownership in the pool, its Lab-ROI top 100, the real
// field and the real top 1%.
//   node bench/sd-pool-coverage.mjs        -> data/reports/sd-pool-coverage.json
import fs from "node:fs";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
import { loadSimRun } from "../server/contestsim.mjs";
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = (name, pos) => pos && !/CPT|FLEX/.test(pos) ? pos : (REF.get(nrm(name)) || (/\s/.test(name) ? "?" : "DST"));
const ownB = x => x <= 0.05 ? "<=5%" : x <= 0.10 ? "5-10%" : x <= 0.20 ? "10-20%" : "20%+";
const r3 = x => Math.round(x * 1000) / 1000;
const sigOf = (cpt, flex) => nrm(cpt) + "#" + flex.map(nrm).sort().join("|");
const mix = (rs, key) => { const g = {}; for (const r of rs) g[key(r)] = (g[key(r)] || 0) + 1; return Object.fromEntries(Object.entries(g).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r3(v / rs.length)])); };

const slates = fs.readdirSync("data").filter(d => /^\d{4}-\d{2}-\d{2}-nfl-/.test(d) && fs.existsSync(`data/${d}/simrun.json`));
const post = listPost("nfl");
const out = [];
for (const d of slates) {
  const s = JSON.parse(fs.readFileSync(`data/${d}/simrun.json`, "utf8")); if (s.format !== "nfl_sd" && !s.rows?.[0]?.players?.some(p => p.isCpt)) continue;
  const lab = e => e.sim?.lab ?? e.sim?.mean ?? -1e9, pool = s.rows.slice().sort((a, b) => lab(b) - lab(a));
  const teams = [...new Set(pool[0].players.map(p => p.team).filter(Boolean))].sort();
  const pRow = e => { const c = e.players.find(p => p.isCpt) || e.players[0], fl = e.players.filter(p => p !== c), tc = {}; for (const p of e.players) tc[p.team] = (tc[p.team] || 0) + 1;
    return { sig: sigOf(c.name, fl.map(p => p.name)), cptPos: posOf(c.name, c.pos), cptOwn: c.own > 1 ? c.own / 100 : (c.own ?? 0), split: Object.values(tc).sort((a, b) => b - a).join("-") }; };
  const P = pool.map(pRow), rankBy = new Map(P.map((r, i) => [r.sig, i + 1]));
  // the same pool ranked by the app's grade (loadSimRun attaches it), for the Brain's $100+ candidate list
  const G = loadSimRun(d), gradeRank = new Map();
  if (G && G.rows) G.rows.filter(e => e.grade).sort((a, b) => b.grade.grade - a.grade.grade).forEach((e, i) => gradeRank.set(pRow(e).sig, i + 1));
  const date = d.slice(0, 10), real = { field: [], top1: [], winners: [] };
  let contests = 0;
  for (const f of post) {
    if (!f.includes(date)) continue;
    const j = readPost(f), c = j.contest; if (c.date !== date || !j.lineups?.length || !/showdown/i.test(c.type + " " + c.name)) continue;
    const ct = [...new Set(j.players.map(p => p.team).filter(Boolean))].sort(); if (ct.join() !== teams.join()) continue;
    contests++;
    const flex = new Map(), cpt = new Map(); for (const p of j.players) (p.pos === "CPT" ? cpt : flex).set(p.id, p);
    const N = j.lineups.length, t1 = Math.max(1, Math.ceil(N * 0.01));
    for (const l of j.lineups) {
      if (l.fin == null) continue;
      const ps = l.ids.map(id => flex.get(id) || cpt.get(id)).filter(Boolean); if (ps.length !== 6) continue;
      const fs_ = ps.reduce((a, p) => a + (flex.get(p.id)?.sal ?? p.sal), 0);
      const cp = ps.find(p => Math.abs(fs_ + 0.5 * (flex.get(p.id)?.sal ?? p.sal) - l.sal) < 1) || ps[0], cr = cpt.get(cp.id) || cp;
      const tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
      const r = { sig: sigOf(cr.name, ps.filter(p => p !== cp).map(p => p.name)), cptPos: posOf(cr.name), cptOwn: cr.pown ?? 0, split: Object.values(tc).sort((a, b) => b - a).join("-"), fee: c.fee, contest: c.name };
      real.field.push(r); if (l.fin <= t1) real.top1.push(r); if (l.fin === 1) real.winners.push(r);
    }
  }
  if (!contests) { out.push({ slate: d, contests: 0 }); continue; }
  const found = rs => { const hit = rs.filter(r => rankBy.has(r.sig)), inTop = (rk, k) => r3(rs.filter(r => (rk.get(r.sig) ?? 1e9) <= k).length / (rs.length || 1));
    return { n: rs.length, inPool: r3(hit.length / (rs.length || 1)), inTop100: inTop(rankBy, 100), inTop50: inTop(rankBy, 50), gradeTop50: inTop(gradeRank, 50), gradeTop100: inTop(gradeRank, 100),
      medianRank: hit.length ? hit.map(r => rankBy.get(r.sig)).sort((a, b) => a - b)[Math.floor(hit.length / 2)] : null,
      medianGradeRank: hit.length ? hit.map(r => gradeRank.get(r.sig) ?? 1e9).sort((a, b) => a - b)[Math.floor(hit.length / 2)] : null }; };
  const top100 = P.slice(0, 100), groups = { pool: P, poolTop100: top100, realField: real.field, realTop1: real.top1 };
  out.push({ slate: d, teams, contests, poolSize: P.length,
    winners: real.winners.map(w => ({ contest: w.contest, fee: w.fee, cptPos: w.cptPos, cptOwn: r3(w.cptOwn), split: w.split, poolRank: rankBy.get(w.sig) ?? null })),
    coverage: { winners: found(real.winners), top1: found(real.top1) },
    cptPos: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, mix(v, r => r.cptPos)])),
    split: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, mix(v, r => r.split)])),
    cptOwn: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, mix(v, r => ownB(r.cptOwn))])) });
}
fs.writeFileSync("data/reports/sd-pool-coverage.json", JSON.stringify(out, null, 1));

const pc = x => x == null ? "-" : (x * 100).toFixed(0) + "%";
const line = (label, m, keys) => console.log("  " + label.padEnd(12) + keys.map(k => `${k} ${pc(m[k] ?? 0).padStart(4)}`).join("  "));
for (const o of out) {
  console.log(`\n== ${o.slate}: ${o.contests} real contests` + (o.contests ? `, pool ${o.poolSize}` : " (no post data for this game)")); if (!o.contests) continue;
  console.log(`  winners in pool ${pc(o.coverage.winners.inPool)} (${o.coverage.winners.n}), in Lab top 100 ${pc(o.coverage.winners.inTop100)} | real top-1% in pool ${pc(o.coverage.top1.inPool)} (${o.coverage.top1.n}), in top 100 ${pc(o.coverage.top1.inTop100)}, median pool rank of those found ${o.coverage.top1.medianRank ?? "-"}`);
  const w = o.coverage.winners, t = o.coverage.top1;
  console.log(`  top 50 by Lab ROI vs by grade: winners ${pc(w.inTop50)} vs ${pc(w.gradeTop50)}, real top-1% ${pc(t.inTop50)} vs ${pc(t.gradeTop50)} | top 100: winners ${pc(w.inTop100)} vs ${pc(w.gradeTop100)}, top-1% ${pc(t.inTop100)} vs ${pc(t.gradeTop100)} | median rank of top-1% found: Lab ${t.medianRank ?? "-"}, grade ${t.medianGradeRank ?? "-"}`);
  for (const [name, keys] of [["captain pos", ["QB", "RB", "WR", "TE", "K", "DST"]], ["split", ["5-1", "4-2", "3-3"]], ["CPT own", ["<=5%", "5-10%", "10-20%", "20%+"]]]) {
    const src = name === "captain pos" ? o.cptPos : name === "split" ? o.split : o.cptOwn;
    console.log(`  ${name}:`); for (const g of ["pool", "poolTop100", "realField", "realTop1"]) line(g, src[g], keys);
  }
}
console.log("\nwrote data/reports/sd-pool-coverage.json");
