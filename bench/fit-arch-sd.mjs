// Do the showdown field archetypes (ARCH_SD in server/contestsim.mjs) build fields that look like real showdown fields?
// Per real contest, the generator gets what the app would have had (Stokastic's projected FLEX and CPT ownership, through
// the showdown position multipliers SD_POS_OWN.raw unless --nopos) and builds a field the contest's size (capped). Compared
// against the real field, bucketed by that input ownership: FLEX exposure in 0-5 / 5-10 / 10-25 / 25-45 / 45+ (generated vs
// the real field's FLEX ownership of the same players), CPT exposure in 0-5 / 5-10 / 10-20 / 20+, the 3 most-captained
// players' share, salary used and duplicate share.
//   node bench/fit-arch-sd.mjs [--from=2025-09-01 --to=2026-03-01] [--max=25] [--gen=2500] [--grid] [--nopos]
//     [--set='{"high":{"conc":1.0}}']   -> data/reports/fit-arch-sd-<tag>.json
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { SD_POS_OWN, sdPosAdjust } from "../server/sources.mjs";
// same tiers as bench/fit-arch-nfl.mjs
const tierOf = (fee, n) => fee >= 100 && n <= 1000 ? "high" : (fee < 20 || n > 10000) ? "low" : "marquee";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-03-01"), MAX = +arg("max", 25), GEN = +arg("gen", 2500), GRID = process.argv.includes("--grid"), NOPOS = process.argv.includes("--nopos");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
// current settings (copied from server/contestsim.mjs so a sweep can vary them)
const ARCH_SD = { low: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 47500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, marquee: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, high: { conc: { FLEX: 1.15, CPT: 1.0 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 } };
for (const [k, v] of Object.entries(JSON.parse(arg("set", "{}")))) Object.assign(ARCH_SD[k], v);
const GRIDV = JSON.parse(arg("gridv", '{"conc":[0.7,0.85,1.0],"boost":[0.3,0.6,1.0],"minSal":[44000,46000]}'));
const variantsFor = t => {
  const b = ARCH_SD[t]; if (!GRID) return { cur: b };
  const out = {}; for (const c of GRIDV.conc) for (const bo of GRIDV.boost) for (const ms of GRIDV.minSal) out[`c${c}b${bo}s${ms / 1000}`] = Object.assign({}, b, { conc: c, boost: bo, minSal: ms });
  return out;
};
const FB = [[0, 5], [5, 10], [10, 25], [25, 45], [45, 101]], CB = [[0, 5], [5, 10], [10, 20], [20, 101]];
const bk = (B, x) => B.findIndex(([lo, hi]) => x >= lo && x < hi);

function stats(lus, P, inF, inC) {
  const N = lus.length, cF = new Float64Array(P.length), cC = new Float64Array(P.length), sig = {};
  let sal = 0;
  for (const lu of lus) { lu.forEach((id, z) => { if (z === 0) cC[id]++; else cF[id]++; }); sal += P[lu[0]].csal + lu.slice(1).reduce((s, i) => s + P[i].sal, 0); const k = lu[0] + ":" + lu.slice(1).sort((a, b) => a - b).join(","); sig[k] = (sig[k] || 0) + 1; }
  const f = FB.map(() => []), c = CB.map(() => []);
  P.forEach((p, i) => { const a = bk(FB, inF[i]); if (a >= 0 && inF[i] > 0) f[a].push(100 * cF[i] / N); const b = bk(CB, inC[i]); if (b >= 0 && inC[i] > 0) c[b].push(100 * cC[i] / N); });
  const top3 = [...cC].sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0) / N;
  const dup = lus.filter(lu => sig[lu[0] + ":" + lu.slice(1).sort((a, b) => a - b).join(",")] > 1).length / N;
  return { f: f.map(mean), c: c.map(mean), top3, sal: sal / N, dup };
}
// the real field's exposure by the same buckets is its actual FLEX / CPT ownership
function realStats(rc, inF, inC) {
  const P = rc.pool.players, f = FB.map(() => []), c = CB.map(() => []);
  P.forEach((p, i) => { const a = bk(FB, inF[i]); if (a >= 0 && inF[i] > 0) f[a].push(p.actOwn || 0); const b = bk(CB, inC[i]); if (b >= 0 && inC[i] > 0) c[b].push(p.actCown || 0); });
  const N = rc.entries.length, cnt = {}; let sal = 0; const sig = {};
  for (const e of rc.entries) { cnt[e.lu[0]] = (cnt[e.lu[0]] || 0) + 1; sal += e.sal || 0; const k = e.lu[0] + ":" + e.lu.slice(1).sort((a, b) => a - b).join(","); sig[k] = (sig[k] || 0) + 1; }
  const top3 = Object.values(cnt).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0) / N;
  const dup = rc.entries.filter(e => sig[e.lu[0] + ":" + e.lu.slice(1).sort((a, b) => a - b).join(",")] > 1).length / N;
  return { f: f.map(mean), c: c.map(mean), top3, sal: sal / N, dup };
}

const list = listContests().filter(c => c.json && c.fkey === "nfl_sd" && c.fee >= 3 && c.entries >= 100 && c.date >= FROM && c.date < TO);
const byT = { high: [], marquee: [], low: [] }; for (const c of list) byT[tierOf(c.fee, c.entries)].push(c);
const thin = a => { const step = Math.max(1, Math.floor(a.length / MAX)); return a.filter((c, i) => i % step === 0).slice(0, MAX); };
const out = { at: new Date().toISOString(), from: FROM, to: TO, gen: GEN, pos: !NOPOS, arch: ARCH_SD, tiers: {} };
const avgArr = rows => rows[0].map((_, k) => +mean(rows.map(r => r[k]).filter(x => isFinite(x))).toFixed(2));
for (const t of arg("tiers", "high,marquee,low").split(",")) {
  const V = variantsFor(t), rows = [];
  for (const c of thin(byT[t])) {
    const rc = loadPulled(c.json), P = rc.pool.players; if (rc.entries.length < 100) continue;
    let inF = P.map(p => p.own || 0), inC = P.map(p => p.cown || 0);
    if (!NOPOS) { inF = sdPosAdjust(P.map((p, i) => ({ pos: p.pos, own: inF[i] })), SD_POS_OWN.raw.flex); inC = sdPosAdjust(P.map((p, i) => ({ pos: p.pos, own: inC[i] })), SD_POS_OWN.raw.cpt); }
    const gp = Object.assign({}, rc.pool, { players: P.map((p, i) => Object.assign({}, p, { own: inF[i], fown: inF[i], cown: inC[i] })) });
    const real = realStats(rc, inF, inC), row = { key: c.key, name: c.name, fee: c.fee, N: rc.entries.length, real, gen: {} }, n = Math.min(rc.entries.length, GEN);
    for (const [vk, v] of Object.entries(V)) { const g = stats(genField(gp, n, Object.assign({ rounds: 3 }, v), mulberry32(1)).field, gp.players, inF, inC); if (rc.entries.length > GEN) g.dup = null; row.gen[vk] = g; }
    rows.push(row);
  }
  if (!rows.length) continue;
  const sum = { real: { f: avgArr(rows.map(r => r.real.f)), c: avgArr(rows.map(r => r.real.c)), top3: +mean(rows.map(r => r.real.top3)).toFixed(3), sal: Math.round(mean(rows.map(r => r.real.sal))), dup: +mean(rows.map(r => r.real.dup)).toFixed(3) } };
  for (const vk of Object.keys(V)) {
    const f = avgArr(rows.map(r => r.gen[vk].f)), c = avgArr(rows.map(r => r.gen[vk].c));
    // fit score: mean absolute bucket gap (FLEX buckets 5+ and CPT buckets 5+), plus the top-3 captain share gap in points
    const err = mean([...f.slice(1).map((x, k) => Math.abs(x - sum.real.f[k + 1])), ...c.slice(1).map((x, k) => Math.abs(x - sum.real.c[k + 1])), Math.abs(100 * (mean(rows.map(r => r.gen[vk].top3)) - sum.real.top3))]);
    sum[vk] = { f, c, top3: +mean(rows.map(r => r.gen[vk].top3)).toFixed(3), sal: Math.round(mean(rows.map(r => r.gen[vk].sal))), dup: +mean(rows.map(r => r.gen[vk].dup).filter(x => x != null)).toFixed(3), err: +err.toFixed(2) };
  }
  out.tiers[t] = { n: rows.length, summary: sum };
  const fmt = s => `FLEX ${s.f.join("/")} | CPT ${s.c.join("/")} | top3 ${s.top3} sal ${s.sal} dup ${s.dup}`;
  console.log(`\n== ${t} (${rows.length} contests) FLEX buckets ${FB.map(b => b.join("-")).join(" ")} | CPT ${CB.map(b => b.join("-")).join(" ")}\n  real       ${fmt(sum.real)}`);
  for (const vk of Object.keys(V).sort((a, b) => sum[a].err - sum[b].err).slice(0, GRID ? 6 : 1)) console.log(`  ${vk.padEnd(16)} err ${sum[vk].err} ${fmt(sum[vk])}`);
}
fs.writeFileSync(`data/reports/fit-arch-sd-${FROM}_${TO}${GRID ? "-grid" : ""}${NOPOS ? "-nopos" : ""}.json`, JSON.stringify(out, null, 1));
