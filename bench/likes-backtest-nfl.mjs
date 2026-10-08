// Lab likes backtest (overnight job 2026-10-07): would the Lab-likes score (server/likes.mjs: mean of within-position
// z-scores, no fitted weights) have picked classic players who beat their ownership in 2025/2026?
// Only the inputs with history are used: projection, value (pts per $1K), leverage (projection rank minus ownership rank
// within the position) and an implied-total proxy (the team's summed projection, since no Vegas lines are stored).
// ETR DvP / XFP / PROE have no stored history, and guide stances only exist from 2026-10-04, so they are left out.
// One slate per date: the classic contest with the most teams, then the most entries. Outcome per player = Stokastic's
// post-contest player ROI (aroi > 0 = rostering him beat the field) and actual vs projected ownership.
// Drop-one: the same picks with each component left out, to see which input carries the signal.
//   node bench/likes-backtest-nfl.mjs [--year=2025] [--out=data/reports/likes-backtest-nfl.json]
import fs from "node:fs";
import zlib from "node:zlib";
const D = "data/post/nfl/";
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const YEARS = arg("year", "2025,2026").split(",");
const FLOOR = { QB: 12, RB: 8, WR: 7, TE: 5, DST: 4 };
const POS = ["QB", "RB", "WR", "TE", "DST"], COMPS = ["proj", "value", "lev", "tt"];

// pick one slate per date
const byDate = {};
for (const f of fs.readdirSync(D).filter(f => f.endsWith(".json.gz") && YEARS.includes(f.slice(0, 4)))) {
  let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(D + f))); } catch { continue; }
  const C = j.contest || {}; if (/Showdown|Captain/i.test(C.name + C.type) || !Array.isArray(j.players)) continue;
  const teams = new Set(j.players.map(p => p.team)).size, date = f.slice(0, 10), cur = byDate[date];
  if (!cur || teams > cur.teams || (teams === cur.teams && (C.entries || 0) > cur.entries)) byDate[date] = { f, teams, entries: C.entries || 0, players: j.players, name: C.name };
}
const zs = v => { const x = v.filter(Number.isFinite); if (x.length < 3) return v.map(() => null); const m = x.reduce((a, b) => a + b, 0) / x.length, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length) || 1; return v.map(y => Number.isFinite(y) ? (y - m) / sd : null); };
const rankOf = v => { const idx = v.map((_, i) => i).sort((a, b) => v[b] - v[a]); const r = []; idx.forEach((i, k) => r[i] = k + 1); return r; };

const strategies = { all: COMPS, "rec:2value+proj+tt": ["value", "value", "proj", "tt"], "rec:2value+proj": ["value", "value", "proj"], ...Object.fromEntries(COMPS.map(c => ["drop:" + c, COMPS.filter(x => x !== c)])), ...Object.fromEntries(COMPS.map(c => ["only:" + c, [c]])) };
const res = {}; // strategy -> pos -> date -> {pickRoi, baseRoi, pickHit, baseHit, pickOwnErr}
const fades = {};
for (const [date, s] of Object.entries(byDate).sort()) {
  const ps = s.players.filter(p => p.pos && p.sal > 0 && p.proj > 0);
  const teamStr = {}; for (const p of ps) if (p.pos !== "DST") teamStr[p.team] = (teamStr[p.team] || 0) + p.proj;
  const all = [];
  for (const pos of POS) {
    const list = ps.filter(p => p.pos === pos && p.proj >= FLOOR[pos]).map(p => ({ ...p, value: p.proj / (p.sal / 1000), own: 100 * p.pown, tt: pos === "DST" ? -(teamStr[p.opp] || 0) : teamStr[p.team] || 0 }));
    if (list.length < 6) continue;
    const pr = rankOf(list.map(x => x.proj)), or = rankOf(list.map(x => x.own));
    const comp = { proj: zs(list.map(x => x.proj)), value: zs(list.map(x => x.value)), lev: zs(list.map((x, i) => or[i] - pr[i])), tt: zs(list.map(x => x.tt)) };
    list.forEach((x, i) => { x.zc = Object.fromEntries(COMPS.map(c => [c, comp[c][i]])); all.push(x); });
    const base = { roi: list.reduce((a, x) => a + x.aroi, 0) / list.length, hit: list.filter(x => x.aroi > 0).length / list.length };
    for (const [name, cs] of Object.entries(strategies)) {
      const sc = list.map(x => cs.reduce((a, c) => a + (x.zc[c] ?? 0), 0) / cs.length);
      const top = sc.map((v, i) => i).sort((a, b) => sc[b] - sc[a]).slice(0, 3).map(i => list[i]);
      const r = ((res[name] = res[name] || {})[pos] = res[name][pos] || {});
      r[date] = { pickRoi: top.reduce((a, x) => a + x.aroi, 0) / 3, baseRoi: base.roi, pickHit: top.filter(x => x.aroi > 0).length / 3, baseHit: base.hit, ownGap: top.reduce((a, x) => a + 100 * (x.aown - x.pown), 0) / 3, names: top.map(x => x.name) };
    }
  }
  // fades: 12 most-owned with own >= 15%, score < 0, a component < -0.5; success = negative player ROI
  const chalk = all.filter(x => x.own >= 15).sort((a, b) => b.own - a.own).slice(0, 12).map(x => ({ ...x, score: COMPS.reduce((a, c) => a + (x.zc[c] ?? 0), 0) / COMPS.length }));
  const fd = chalk.filter(x => x.score < 0 && Object.values(x.zc).some(z => z != null && z < -0.5)).sort((a, b) => a.score - b.score).slice(0, 2);
  fades[date] = { fades: fd.map(x => ({ name: x.name, own: +x.own.toFixed(1), aroi: +x.aroi.toFixed(2) })), chalkBaseRoi: chalk.length ? chalk.reduce((a, x) => a + x.aroi, 0) / chalk.length : null };
}
const tstat = v => { const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)); return { mean: m, t: sd ? m / (sd / Math.sqrt(v.length)) : 0, n: v.length, pos: v.filter(x => x > 0).length }; };
const out = { built: new Date().toISOString(), years: YEARS, slates: Object.keys(byDate).length, note: "per date: mean player ROI of the 3 picks minus the position mean among floor-eligible players; hit = share of picks with positive player ROI; t over dates. Inputs: proj, value, leverage, team-projection total proxy (no DvP/XFP/PROE/stance history).", strategies: {}, fades: {} };
for (const [name, byPos] of Object.entries(res)) {
  out.strategies[name] = {};
  for (const [pos, dd] of Object.entries(byPos)) {
    const ds = Object.values(dd);
    out.strategies[name][pos] = { roiEdge: tstat(ds.map(d => d.pickRoi - d.baseRoi)), hitEdge: tstat(ds.map(d => d.pickHit - d.baseHit)), pickHit: ds.reduce((a, d) => a + d.pickHit, 0) / ds.length, baseHit: ds.reduce((a, d) => a + d.baseHit, 0) / ds.length, ownGap: ds.reduce((a, d) => a + d.ownGap, 0) / ds.length };
  }
}
const fdv = Object.values(fades).flatMap(d => d.fades.map(x => x.aroi - (d.chalkBaseRoi ?? 0)));
out.fades = { n: fdv.length, successRate: fdv.length ? Object.values(fades).flatMap(d => d.fades).filter(x => x.aroi < 0).length / fdv.length : null, roiVsChalk: fdv.length ? tstat(fdv) : null };
const pr = (name, pos) => { const s = out.strategies[name]?.[pos]; if (!s) return ""; return `${pos.padEnd(4)} hit ${(100 * s.pickHit).toFixed(0)}% vs base ${(100 * s.baseHit).toFixed(0)}% (t ${s.hitEdge.t.toFixed(1)}) | ROI edge ${(100 * s.roiEdge.mean).toFixed(0)}pp t ${s.roiEdge.t.toFixed(1)} (${s.roiEdge.pos}/${s.roiEdge.n}) | own actual-proj ${s.ownGap.toFixed(1)}pp`; };
console.log(`slates ${out.slates} (${YEARS})`);
for (const name of Object.keys(strategies)) { console.log("\n" + name); for (const pos of POS) { const l = pr(name, pos); if (l) console.log("  " + l); } }
console.log("\nfades:", JSON.stringify(out.fades));
const of = arg("out", ""); if (of) fs.writeFileSync(of, JSON.stringify(out, null, 1));
