// Fit the showdown generator's copy mechanism (o.dupeFloor "auto", SD_DUPE in src/engine/field.mjs) to real showdown fields.
// Per real contest: the field the app would generate (ARCH_SD for its tier, Stokastic's ownership through the position
// multipliers) at the contest's size capped at --gen, against the real field (a random subsample of --gen entries when larger).
// Reports the copy share (entries that repeat an earlier entry), the share of entries in copy groups of 2 / 3-5 / 6-20 / 21+,
// and the bucket-exposure error of bench/fit-arch-sd.mjs, for each variant: off, and copies on at each --pows weight.
//   node bench/fit-dupes-sd.mjs [--from=2025-09-01 --to=2026-03-01] [--max=20] [--gen=2500] [--pows=0,1,2,3] [--scale=1]
//     [--fit]   (least-squares fit of a + b ln N to the real copy share, contests up to 20,000 entries)
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField, SD_DUPE } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { SD_POS_OWN, sdPosAdjust } from "../server/sources.mjs";
import { dupeStats } from "./sd-dupes-real.mjs";

const tierOf = (fee, n) => fee >= 100 && n <= 1000 ? "high" : (fee < 20 || n > 10000) ? "low" : "marquee";
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-03-01"), MAX = +arg("max", 20), GEN = +arg("gen", 2500), FIT = process.argv.includes("--fit");
const POWS = arg("pows", "0,1,2,3").split(",").map(Number), SCALE = +arg("scale", 1);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
// current settings, mirrored from server/contestsim.mjs
const ARCH_SD = { low: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 47500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, marquee: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, high: { conc: { FLEX: 1.15, CPT: 1.0 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 } };
for (const [k, v] of Object.entries(JSON.parse(arg("set", "{}")))) Object.assign(ARCH_SD[k], v);
if (arg("dupe")) Object.assign(SD_DUPE, JSON.parse(arg("dupe")));
const FB = [[5, 10], [10, 25], [25, 45], [45, 101]], CB = [[5, 10], [10, 20], [20, 101]];
const bk = (B, x) => B.findIndex(([lo, hi]) => x >= lo && x < hi);
function expo(lus, P, inF, inC, realF, realC) {
  const N = lus.length, cF = new Float64Array(P.length), cC = new Float64Array(P.length);
  for (const lu of lus) lu.forEach((id, z) => { if (z === 0) cC[id]++; else cF[id]++; });
  const f = FB.map(() => []), c = CB.map(() => []), rf = FB.map(() => []), rc = CB.map(() => []);
  P.forEach((p, i) => { const a = bk(FB, inF[i]); if (a >= 0) { f[a].push(100 * cF[i] / N); rf[a].push(realF[i]); } const b = bk(CB, inC[i]); if (b >= 0) { c[b].push(100 * cC[i] / N); rc[b].push(realC[i]); } });
  return { f: f.map(mean), c: c.map(mean), rf: rf.map(mean), rc: rc.map(mean) };
}

const list = listContests().filter(c => c.json && c.fkey === "nfl_sd" && c.fee >= 3 && c.entries >= 100 && c.date >= FROM && c.date < TO);
if (FIT) {
  const pts = [];
  for (const c of list) { if (c.entries > 20000) continue; const rc = loadPulled(c.json); if (rc.entries.length < 100) continue; const s = dupeStats(rc.entries.map(e => e.lu), rc.pool.players); pts.push([Math.log(rc.entries.length), s.dupShare]); }
  const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1])), b = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0), a = my - b * mx;
  const resid = Math.sqrt(mean(pts.map(p => (p[1] - a - b * p[0]) ** 2)));
  console.log(`fit on ${pts.length} contests: copy share = ${a.toFixed(3)} + ${b.toFixed(4)} ln N  (rms residual ${resid.toFixed(3)})`);
  for (const N of [300, 1300, 4000, 16000, 20000]) console.log(`  N ${N}: ${(a + b * Math.log(N)).toFixed(3)}`);
  process.exit(0);
}
const byT = { high: [], marquee: [], low: [] }; for (const c of list) byT[tierOf(c.fee, c.entries)].push(c);
const thin = a => { const step = Math.max(1, Math.floor(a.length / MAX)); return a.filter((c, i) => i % step === 0).slice(0, MAX); };
const V = { off: { dupeFloor: 0 } }; for (const v of JSON.parse(arg("variants", "[{\"dupeAlpha\":2,\"dupeGamma\":2}]"))) V[Object.entries(v).map(([k, x]) => k.replace("dupe", "")[0] + x).join("")] = Object.assign({ dupeFloor: "auto", dupeScale: SCALE }, v);
const out = { at: new Date().toISOString(), from: FROM, to: TO, gen: GEN, SD_DUPE, tiers: {} };
const G = ["2", "3-5", "6-20", "21+"];
for (const t of arg("tiers", "high,marquee,low").split(",")) {
  const rows = [];
  for (const c of thin(byT[t])) {
    const rc = loadPulled(c.json), P = rc.pool.players; if (rc.entries.length < 100) continue;
    let inF = P.map(p => p.own || 0), inC = P.map(p => p.cown || 0);
    inF = sdPosAdjust(P.map((p, i) => ({ pos: p.pos, own: inF[i] })), SD_POS_OWN.raw.flex); inC = sdPosAdjust(P.map((p, i) => ({ pos: p.pos, own: inC[i] })), SD_POS_OWN.raw.cpt);
    const gp = Object.assign({}, rc.pool, { players: P.map((p, i) => Object.assign({}, p, { own: inF[i], fown: inF[i], cown: inC[i] })) });
    const n = Math.min(rc.entries.length, GEN), rng = mulberry32(7);
    let realLus = rc.entries.map(e => e.lu);
    if (realLus.length > n) { const a = realLus.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } realLus = a.slice(0, n); }
    const real = dupeStats(realLus, gp.players), row = { key: c.key, N: rc.entries.length, n, real, gen: {} };
    const realF = P.map(p => p.actOwn || 0), realC = P.map(p => p.actCown || 0);
    for (const [vk, v] of Object.entries(V)) {
      const g = genField(gp, n, Object.assign({ rounds: 3 }, ARCH_SD[t], v), mulberry32(1)).field;
      const s = dupeStats(g, gp.players), e = expo(g, gp.players, inF, inC, realF, realC);
      row.gen[vk] = Object.assign(s, { e });
    }
    rows.push(row);
  }
  if (!rows.length) continue;
  const agg = pick => ({ copies: +mean(rows.map(r => pick(r).dupShare)).toFixed(3), inDup: +mean(rows.map(r => pick(r).inDup)).toFixed(3), groups: G.map(g => +mean(rows.map(r => pick(r).groups[g])).toFixed(3)), maxCopy: +mean(rows.map(r => pick(r).maxCopy)).toFixed(1) });
  const sum = { real: agg(r => r.real) };
  for (const vk of Object.keys(V)) {
    const a = agg(r => r.gen[vk]);
    // bucket error vs the real field's actual ownership, same buckets as fit-arch-sd (5+ only)
    const ef = FB.map((_, k) => mean(rows.map(r => Math.abs(r.gen[vk].e.f[k] - r.gen[vk].e.rf[k])).filter(isFinite)));
    const ec = CB.map((_, k) => mean(rows.map(r => Math.abs(r.gen[vk].e.c[k] - r.gen[vk].e.rc[k])).filter(isFinite)));
    a.bucketErr = +mean([...ef, ...ec]).toFixed(2);
    a.dupErr = +(Math.abs(a.copies - sum.real.copies) * 100 + G.reduce((s, g, k) => s + Math.abs(a.groups[k] - sum.real.groups[k]) * 100, 0) / G.length).toFixed(2);
    sum[vk] = a;
  }
  out.tiers[t] = { n: rows.length, meanN: Math.round(mean(rows.map(r => r.N))), summary: sum };
  console.log(`\n== ${t} (${rows.length} contests, mean N ${out.tiers[t].meanN}, generated at <= ${GEN}) groups ${G.join("/")}`);
  console.log(`  real    copies ${sum.real.copies} inDup ${sum.real.inDup} groups ${sum.real.groups.join("/")} max ${sum.real.maxCopy}`);
  for (const vk of Object.keys(V)) console.log(`  ${vk.padEnd(6)}  copies ${sum[vk].copies} inDup ${sum[vk].inDup} groups ${sum[vk].groups.join("/")} max ${sum[vk].maxCopy} | dupErr ${sum[vk].dupErr} bucketErr ${sum[vk].bucketErr}`);
}
fs.writeFileSync(`data/reports/fit-dupes-sd-${FROM}_${TO}.json`, JSON.stringify(out, null, 1));
