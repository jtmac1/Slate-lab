// How duplicated does a lineup get, given only what is known before lock? The naive estimate is
// entries x product of projected ownership; real fields duplicate far more than independence says,
// so this calibrates that estimate on every pulled NFL contest: by bucket of the naive estimate,
// the share of lineups that had at least one copy and the mean number of copies, per format.
//   node bench/fit-dup-nfl.mjs [from] [to]   -> data/reports/dup-fit-nfl.json (used by server/entries.mjs)
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
const FROM = process.argv[2] || "2025-01-01", TO = process.argv[3] || "2099-12-31";
const EDGES = [-9, -6, -5, -4, -3.5, -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 9];
const acc = { classic: {}, showdown: {} }, bucket = x => { for (let i = 0; i < EDGES.length - 1; i++) if (x >= EDGES[i] && x < EDGES[i + 1]) return i; return EDGES.length - 2; };
let contests = 0;
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || !j.players?.length || c.date < FROM || c.date > TO) continue;
  const sd = /showdown/i.test(c.type + " " + c.name), key = sd ? "showdown" : "classic", N = j.lineups.length;
  const byId = new Map(); for (const p of j.players) if (!byId.has(p.id)) byId.set(p.id, p);
  const a = acc[key]; contests++;
  for (const l of j.lineups) {
    const ps = l.ids.map(id => byId.get(id)); if (ps.some(p => !p || !(p.pown > 0))) continue;
    const pred = N * ps.reduce((s, p) => s * p.pown, 1), lp = Math.log10(Math.max(1e-9, pred));
    const tier = c.fee < 100 ? "lo" : c.fee < 300 ? "mid" : "hi", b = bucket(lp);
    for (const k of ["all", tier]) { const t = a[k] = a[k] || { n: 0, buckets: EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], n: 0, dup: 0, any: 0 })) }; t.n++; const bb = t.buckets[b]; bb.n++; bb.dup += l.dup || 0; bb.any += (l.dup || 0) > 0 ? 1 : 0; }
  }
}
const out = { built: new Date().toISOString(), window: [FROM, TO], contests, note: "x = log10(entries * product of projected ownership); pDup = share with a copy; meanDup = mean copies", formats: {} };
for (const [key, tiers] of Object.entries(acc)) { out.formats[key] = {}; for (const [tier, t] of Object.entries(tiers)) out.formats[key][tier] = { n: t.n, buckets: t.buckets.filter(b => b.n >= 50).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, pDup: +(b.any / b.n).toFixed(3), meanDup: +(b.dup / b.n).toFixed(2) })) }; }
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/dup-fit-nfl.json", JSON.stringify(out, null, 1));
for (const [key, tiers] of Object.entries(out.formats)) { console.log(`\n${key}`); for (const [tier, t] of Object.entries(tiers)) console.log(`  ${tier} (${t.n} lineups): ` + t.buckets.map(b => `[${b.lo},${b.hi}) ${(100 * b.pDup).toFixed(0)}%/${b.meanDup}`).join("  ")); }
console.log(`\n${contests} contests -> data/reports/dup-fit-nfl.json`);
