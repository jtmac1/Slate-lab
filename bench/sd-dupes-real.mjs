// How real NFL showdown fields duplicate: share of entries that are exact copies, how big the copy groups get, and what the
// copied lineups look like (projection and ownership percentile within the field, salary left, chalk captain or not), by
// tier and field size. The target the showdown generator's duplicate mechanism is fitted to (bench/fit-dupes-sd.mjs).
//   node bench/sd-dupes-real.mjs [--from=2025-09-01 --to=2026-03-01]   -> data/reports/sd-dupes-real-<from>_<to>.json
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-03-01");
const tierOf = (fee, n) => fee >= 100 && n <= 1000 ? "high" : (fee < 20 || n > 10000) ? "low" : "marquee";
const sizeOf = n => n <= 500 ? "<=500" : n <= 2000 ? "501-2k" : n <= 10000 ? "2k-10k" : n <= 50000 ? "10k-50k" : "50k+";
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
export const sigSD = lu => lu[0] + ":" + lu.slice(1).sort((a, b) => a - b).join(",");

export function dupeStats(lus, P) {
  const N = lus.length, sig = {}, proj = [], own = [], sal = [];
  for (const lu of lus) { const k = sigSD(lu); sig[k] = (sig[k] || 0) + 1; }
  lus.forEach(lu => {
    proj.push(1.5 * P[lu[0]].proj + lu.slice(1).reduce((s, i) => s + P[i].proj, 0));
    own.push((P[lu[0]].cown || 0) + lu.slice(1).reduce((s, i) => s + (P[i].own || 0), 0));
    sal.push((P[lu[0]].csal || 1.5 * P[lu[0]].sal) + lu.slice(1).reduce((s, i) => s + P[i].sal, 0));
  });
  const pct = arr => { const o = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]), r = new Array(arr.length); o.forEach((i, k) => { r[i] = k / Math.max(1, arr.length - 1); }); return r; };
  const pp = pct(proj), op = pct(own);
  const groups = { "2": 0, "3-5": 0, "6-20": 0, "21+": 0 }, D = { pp: [], op: [], left: [] }, U = { pp: [], op: [], left: [] };
  lus.forEach((lu, i) => { const c = sig[sigSD(lu)], tgt = c > 1 ? D : U; tgt.pp.push(pp[i]); tgt.op.push(op[i]); tgt.left.push(50000 - sal[i]);
    if (c > 1) groups[c === 2 ? "2" : c <= 5 ? "3-5" : c <= 20 ? "6-20" : "21+"]++; });
  // the captain most often used in copied lineups vs in the field
  const dupShare = (N - Object.keys(sig).length) / N;    // share of entries that are a copy of an earlier one
  const inDup = lus.filter(lu => sig[sigSD(lu)] > 1).length / N;   // share of entries sitting in a copy group
  return { N, inDup, dupShare, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v / N])),
    dup: { pp: mean(D.pp), op: mean(D.op), left: mean(D.left) }, uniq: { pp: mean(U.pp), op: mean(U.op), left: mean(U.left) }, maxCopy: Math.max(...Object.values(sig)) };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const list = listContests().filter(c => c.json && c.fkey === "nfl_sd" && c.fee >= 3 && c.entries >= 100 && c.date >= FROM && c.date < TO);
  const by = {};
  for (const c of list) {
    const rc = loadPulled(c.json), P = rc.pool.players; if (rc.entries.length < 100) continue;
    const s = dupeStats(rc.entries.map(e => e.lu), P), t = tierOf(c.fee, c.entries), z = sizeOf(rc.entries.length);
    for (const k of [`tier ${t}`, `size ${z}`]) (by[k] = by[k] || []).push(s);
  }
  const out = { from: FROM, to: TO, groups: {} };
  for (const k of Object.keys(by).sort()) {
    const a = by[k], g = Object.keys(a[0].groups);
    const row = { n: a.length, N: Math.round(mean(a.map(x => x.N))), inDup: +mean(a.map(x => x.inDup)).toFixed(3), dupShare: +mean(a.map(x => x.dupShare)).toFixed(3),
      groups: Object.fromEntries(g.map(q => [q, +mean(a.map(x => x.groups[q])).toFixed(3)])), maxCopy: Math.round(mean(a.map(x => x.maxCopy))),
      dup: { pp: +mean(a.map(x => x.dup.pp)).toFixed(2), op: +mean(a.map(x => x.dup.op)).toFixed(2), left: Math.round(mean(a.map(x => x.dup.left))) },
      uniq: { pp: +mean(a.map(x => x.uniq.pp)).toFixed(2), op: +mean(a.map(x => x.uniq.op)).toFixed(2), left: Math.round(mean(a.map(x => x.uniq.left))) } };
    out.groups[k] = row;
    console.log(`${k.padEnd(14)} n${String(row.n).padStart(4)} N~${row.N} | in copy group ${row.inDup} copies ${row.dupShare} | groups ${JSON.stringify(row.groups)} max ${row.maxCopy} | copied: projPct ${row.dup.pp} ownPct ${row.dup.op} left $${row.dup.left} vs unique ${row.uniq.pp}/${row.uniq.op}/$${row.uniq.left}`);
  }
  fs.writeFileSync(`data/reports/sd-dupes-real-${FROM}_${TO}.json`, JSON.stringify(out, null, 1));
}
