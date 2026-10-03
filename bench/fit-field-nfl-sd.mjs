// Does the field generator reproduce real NFL showdown fields? For each pulled 2026 showdown
// contest ($20+), rebuild the slate pool from the post-contest player file (projection, salary,
// projected flex and captain ownership), generate a field at each archetype, and compare the
// generated exposure per player (flex and captain) with the ACTUAL ownership in that contest.
//   node bench/fit-field-nfl-sd.mjs [from] [to] [--max=40]   -> data/reports/field-fit-nfl-sd.json
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
import { buildPool, autoMap } from "../src/engine/formats.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { STK_HEADER_NFL } from "../src/engine/stokastic.mjs";
const FROM = process.argv[2] || "2026-09-01", TO = process.argv[3] || "2099-12-31", MAX = +((process.argv.find(a => a.startsWith("--max=")) || "").slice(6)) || 40;
const ARCH = { marquee: { conc: 1.0, minSal: 49000, boost: 1.0 },
  m44: { conc: 1.0, minSal: 44000, boost: 1.0 }, m44r10: { conc: 1.0, minSal: 44000, boost: 1.0, rounds: 10 }, m43: { conc: 1.0, minSal: 43000, boost: 1.0 }, m42: { conc: 1.0, minSal: 42000, boost: 1.0 },
  m44c09: { conc: 0.9, minSal: 44000, boost: 1.0 }, m44c08: { conc: 0.8, minSal: 44000, boost: 0.6 }, m44c115: { conc: 1.15, minSal: 44000, boost: 1.5 } };
const headers = STK_HEADER_NFL.split(","), tierOf = fee => fee < 100 ? "lo" : fee < 300 ? "mid" : "hi";
const acc = {}, byPlayer = [];
let done = 0;
for (const f of listPost("nfl").reverse()) {
  if (done >= MAX) break;
  const j = readPost(f), c = j.contest; if (!j.players?.length || !j.lineups?.length || c.date < FROM || c.date > TO || c.fee < 20 || !/showdown/i.test(c.type + " " + c.name)) continue;
  const flex = j.players.filter(p => p.pos !== "CPT"), cpt = new Map(j.players.filter(p => p.pos === "CPT").map(p => [p.name, p]));
  if (flex.length < 12) continue;
  const rows = flex.map(p => { const cp = cpt.get(p.name); return [p.name, p.sal, p.pos, p.team, p.opp, p.proj, "", 100 * (p.pown || 0), cp ? 100 * (cp.pown || 0) : "", "", "", "", p.id, cp ? cp.id : ""]; });
  let pool; try { pool = buildPool(headers, rows, "nfl_sd", autoMap(headers)); } catch (e) { continue; }
  const P = pool.players, N = Math.min(j.lineups.length, 2000), tier = tierOf(c.fee);
  const act = new Map(flex.map(p => [p.name, p.aown || 0])), cact = new Map([...cpt.values()].map(p => [p.name, p.aown || 0]));
  for (const [name, a] of Object.entries(ARCH)) {
    const g = genField(pool, N, Object.assign({ rounds: 3 }, a), mulberry32(1)).field;
    const cnt = new Map(), ccnt = new Map(); for (const lu of g) lu.forEach((id, k) => { const nm = P[id].name; cnt.set(nm, (cnt.get(nm) || 0) + 1); if (k === 0) ccnt.set(nm, (ccnt.get(nm) || 0) + 1); });
    let mae = 0, n = 0, cmae = 0, cn = 0, topRatio = 0, topN = 0;
    for (const p of P) { const e = 100 * (cnt.get(p.name) || 0) / g.length, ce = 100 * (ccnt.get(p.name) || 0) / g.length, ao = 100 * (act.get(p.name) || 0), cao = 100 * (cact.get(p.name) || 0);
      if (p.own > 0 || ao > 0) { mae += Math.abs(e - ao); n++; if (p.own >= 25) { topRatio += e / Math.max(1, ao); topN++; } byPlayer.push({ arch: name, tier, name: p.name, own: p.own, exp: +e.toFixed(1), act: +ao.toFixed(1) }); }
      if (p.cown > 0 || cao > 0) { cmae += Math.abs(ce - cao); cn++; } }
    for (const t of [tier, "all"]) { const k = `${name}|${t}`; const x = acc[k] = acc[k] || { contests: 0, mae: 0, cmae: 0, top: 0, topN: 0 }; x.contests++; x.mae += mae / n; x.cmae += cn ? cmae / cn : 0; x.top += topRatio; x.topN += topN; }
  }
  done++;
}
const out = { built: new Date().toISOString(), contests: done, arch: ARCH, fit: {} };
for (const [k, x] of Object.entries(acc)) out.fit[k] = { contests: x.contests, flexMae: +(x.mae / x.contests).toFixed(2), cptMae: +(x.cmae / x.contests).toFixed(2), chalkRatio: x.topN ? +(x.top / x.topN).toFixed(2) : null };
// ownership buckets: generated exposure vs actual, marquee
const B = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 45], [45, 100]]; out.buckets = {};
for (const a of Object.keys(ARCH)) out.buckets[a] = B.map(([lo, hi]) => { const s = byPlayer.filter(x => x.arch === a && x.own >= lo && x.own < hi); return { bucket: `${lo}-${hi}`, n: s.length, proj: s.length ? +(s.reduce((t, x) => t + x.own, 0) / s.length).toFixed(1) : null, generated: s.length ? +(s.reduce((t, x) => t + x.exp, 0) / s.length).toFixed(1) : null, actual: s.length ? +(s.reduce((t, x) => t + x.act, 0) / s.length).toFixed(1) : null }; });
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/field-fit-nfl-sd.json", JSON.stringify(out, null, 1));
console.log(`${done} showdown contests, field of up to 2,000 per archetype\n`);
console.log("archetype|tier      contests  flex MAE  CPT MAE  chalk(>=25%) generated/actual");
for (const [k, v] of Object.entries(out.fit).sort()) console.log(`${k.padEnd(18)} ${String(v.contests).padStart(5)}   ${String(v.flexMae).padStart(6)}   ${String(v.cptMae).padStart(6)}   ${v.chalkRatio == null ? "-" : v.chalkRatio + "x"}`);
console.log("\nprojected -> generated -> actual flex ownership by projected bucket:");
for (const [a, arr] of Object.entries(out.buckets)) console.log(`${a.padEnd(8)} ` + arr.filter(b => b.n).map(b => `${b.bucket}%: ${b.proj}->${b.generated}->${b.actual}`).join("  "));
