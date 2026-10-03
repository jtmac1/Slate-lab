// Does the field generator reproduce real NFL classic fields? For each pulled classic contest
// ($20+), rebuild the slate pool from the post-contest player file (projection, salary, projected
// ownership), generate a field at each archetype, and compare generated exposure per player with
// the ACTUAL ownership in that contest, plus the real stack-type mix of the field.
//   node bench/fit-field-nfl-cl.mjs [from] [to] [--max=40]   -> data/reports/field-fit-nfl-cl.json
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
import { buildPool, autoMap } from "../src/engine/formats.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { STK_HEADER_NFL } from "../src/engine/stokastic.mjs";
const FROM = process.argv[2] || "2025-09-01", TO = process.argv[3] || "2099-12-31", MAX = +((process.argv.find(a => a.startsWith("--max=")) || "").slice(6)) || 40;
// old = the app's previous Marquee; the rest use the stack mix measured on real fields (QB+2 41%, bring-back 62%)
const OLD = { 1: 45, 2: 25, 3: 5, bring: 25 }, REAL = { 1: 45, 2: 41, 3: 5, bring: 62 }, HI = { 1: 37, 2: 48, 3: 10, bring: 67 };
const POS = { QB: 1.0, RB: 1.25, WR: 1.2, TE: 1.25, DST: 1.1, default: 1.2 }, POS2 = { QB: 1.0, RB: 1.3, WR: 1.25, TE: 1.3, DST: 1.1, default: 1.25 };
// CURVE: actual / projected by projected bucket, both seasons, classic flex (bench/fit-conc-nfl.mjs)
const CURVE = [[0, 5, 0.77], [5, 10, 0.94], [10, 20, 1.10], [20, 30, 1.34], [30, 45, 1.16], [45, 100, 1.20]];
const ARCH = { c12: { conc: 1.2, minSal: 48000, boost: 1.0, nflStacks: REAL }, c13: { conc: 1.3, minSal: 48000, boost: 1.0, nflStacks: REAL }, curve10: { conc: 1.0, minSal: 48000, boost: 1.0, nflStacks: REAL, curve: CURVE }, curve11: { conc: 1.1, minSal: 48000, boost: 1.0, nflStacks: REAL, curve: CURVE }, curve09: { conc: 0.9, minSal: 48000, boost: 1.0, nflStacks: REAL, curve: CURVE } };
const headers = STK_HEADER_NFL.split(","), tierOf = fee => fee < 100 ? "lo" : fee < 300 ? "mid" : "hi";
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(p.name.toLowerCase(), p.pos); } catch {}
const acc = {}, byPlayer = [], stackAcc = { real: {}, n: 0 };
const stackOf = (names, posOf, teamOf, oppOf) => { const qb = names.find(n => posOf(n) === "QB"); if (!qb) return "No QB"; const t = teamOf(qb), k = names.filter(n => n !== qb && teamOf(n) === t && /^(WR|TE|RB)$/.test(posOf(n))).length, br = names.some(n => teamOf(n) === oppOf(qb) && posOf(n) !== "DST"); return (k ? `QB + ${k}` : "Unstacked") + (br ? " | OPP" : ""); };
let done = 0;
for (const f of listPost("nfl").reverse()) {
  if (done >= MAX) break;
  const j = readPost(f), c = j.contest; if (!j.players?.length || !j.lineups?.length || c.date < FROM || c.date > TO || c.fee < 20 || /showdown/i.test(c.type + " " + c.name)) continue;
  const pl = j.players.filter(p => p.pos && p.pos !== "CPT" && p.sal > 0); if (pl.length < 60) continue;
  const rows = pl.map(p => [p.name, p.sal, p.pos, p.team, p.opp, p.proj, "", 100 * (p.pown || 0), "", "", "", "", p.id, ""]);
  let pool; try { pool = buildPool(headers, rows, "nfl_cl", autoMap(headers)); } catch (e) { continue; }
  const P = pool.players, N = Math.min(j.lineups.length, 1500), tier = tierOf(c.fee);
  const act = new Map(pl.map(p => [p.name, p.aown || 0])), byId = new Map(pl.map(p => [p.id, p]));
  // real stack mix
  const posOf = n => (byId.get(n) || {}).pos || REF.get(String(n).toLowerCase()) || "?";
  for (const l of j.lineups.slice(0, 1500)) { const ps = l.ids.map(id => byId.get(id)).filter(Boolean); if (ps.length < 9) continue; const names = ps.map(p => p.id); const k = stackOf(names, id => byId.get(id).pos, id => byId.get(id).team, id => byId.get(id).opp).split(" |")[0]; stackAcc.real[k] = (stackAcc.real[k] || 0) + 1; stackAcc.n++; }
  for (const [name, a] of Object.entries(ARCH)) {
    // a.curve: ownership multipliers by projected-ownership bucket, applied before the build (fitted on both seasons by bench/fit-conc-nfl.mjs)
    const gpool = a.curve ? Object.assign({}, pool, { players: P.map(p => { const b = a.curve.find(([lo, hi]) => p.own >= lo && p.own < hi); const m = b ? b[2] : 1; return Object.assign({}, p, { own: p.own * m, fown: p.own * m }); }) }) : pool;
    const g = genField(gpool, N, Object.assign({ rounds: 3, nflStacks: { 1: 45, 2: 25, 3: 5, bring: 25 } }, a), mulberry32(1)).field;
    const cnt = new Map(); for (const lu of g) for (const id of lu) { const nm = P[id].name; cnt.set(nm, (cnt.get(nm) || 0) + 1); }
    let mae = 0, n = 0, topRatio = 0, topN = 0; const st = {};
    for (const lu of g) { const k = stackOf(lu, id => P[id].pos, id => P[id].team, id => P[id].opp).split(" |")[0]; st[k] = (st[k] || 0) + 1; }
    for (const p of P) { const e = 100 * (cnt.get(p.name) || 0) / g.length, ao = 100 * (act.get(p.name) || 0); if (p.own > 0 || ao > 0) { mae += Math.abs(e - ao); n++; if (p.own >= 20) { topRatio += e / Math.max(1, ao); topN++; } byPlayer.push({ arch: name, tier, own: p.own, exp: +e.toFixed(1), act: +ao.toFixed(1) }); } }
    for (const t of [tier, "all"]) { const k = `${name}|${t}`; const x = acc[k] = acc[k] || { contests: 0, mae: 0, top: 0, topN: 0, st: {} }; x.contests++; x.mae += mae / n; x.top += topRatio; x.topN += topN; for (const [s, v] of Object.entries(st)) x.st[s] = (x.st[s] || 0) + v / g.length; }
  }
  done++;
}
const out = { built: new Date().toISOString(), contests: done, arch: ARCH, fit: {}, realStacks: Object.fromEntries(Object.entries(stackAcc.real).map(([k, v]) => [k, +(100 * v / stackAcc.n).toFixed(1)])) };
for (const [k, x] of Object.entries(acc)) out.fit[k] = { contests: x.contests, mae: +(x.mae / x.contests).toFixed(2), chalkRatio: x.topN ? +(x.top / x.topN).toFixed(2) : null, stacks: Object.fromEntries(Object.entries(x.st).map(([s, v]) => [s, +(100 * v / x.contests).toFixed(1)])) };
const B = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 45], [45, 100]]; out.buckets = {};
for (const a of Object.keys(ARCH)) out.buckets[a] = B.map(([lo, hi]) => { const s = byPlayer.filter(x => x.arch === a && x.own >= lo && x.own < hi); return { bucket: `${lo}-${hi}`, n: s.length, proj: s.length ? +(s.reduce((t, x) => t + x.own, 0) / s.length).toFixed(1) : null, generated: s.length ? +(s.reduce((t, x) => t + x.exp, 0) / s.length).toFixed(1) : null, actual: s.length ? +(s.reduce((t, x) => t + x.act, 0) / s.length).toFixed(1) : null }; });
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/field-fit-nfl-cl.json", JSON.stringify(out, null, 1));
console.log(`${done} classic contests, fields of up to 1,500 per archetype\n`);
console.log("real field stack mix: " + Object.entries(out.realStacks).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}%`).join("  "));
console.log("\narchetype|tier      contests  MAE   chalk(>=20%) gen/actual   stack mix generated");
for (const [k, v] of Object.entries(out.fit).sort()) console.log(`${k.padEnd(18)} ${String(v.contests).padStart(5)}   ${String(v.mae).padStart(5)}   ${v.chalkRatio == null ? "-" : v.chalkRatio + "x"}        ${Object.entries(v.stacks).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, p]) => `${s} ${p}%`).join("  ")}`);
console.log("\nprojected -> generated -> actual ownership by projected bucket:");
for (const [a, arr] of Object.entries(out.buckets)) console.log(`${a.padEnd(10)} ` + arr.filter(b => b.n).map(b => `${b.bucket}%: ${b.proj}->${b.generated}->${b.actual}`).join("  "));
