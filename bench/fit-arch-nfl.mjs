// Do the classic field archetypes (ARCH low / marquee / high in server/contestsim.mjs) build fields that look like the real
// ones? Per real contest: the chalk set is the 10 players the generator thinks are most owned (its input ownership); the
// real field's exposure of that set is their actual ownership. Compared: chalk ratio (exposure of the set / input own),
// top-10 share (the 10 most-exposed players' exposure / 900), own sum (actual ownership, the same yardstick for both),
// stack mix (QB+1/+2/+3/unstacked, bring-back), salary used and duplicate share.
// Inputs the app would have had: the 10/04 main slate goes through the app's own fieldPool ("auto" ownership by contest
// size, Lab projections) from data/2026-10-04-nfl-main; other dates (2025) only have Stokastic's projected ownership, put
// through the classic player model as the app did then.
//   node bench/fit-arch-nfl.mjs [--date=2026-10-04 | --from=2025-09-01 --to=2026-03-01] [--max=40] [--gen=2500]
//     [--grid] [--set='{"high":{"conc":1.2}}']   -> data/reports/fit-arch-nfl-<tag>.json
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { nrm } from "../src/engine/csv.mjs";
import { ownModel } from "../server/sources.mjs";
import { loadPool } from "../server/foursim.mjs";
import { fieldPool } from "../server/contestsim.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DATE = arg("date", null), FROM = arg("from", "2025-09-01"), TO = arg("to", "2026-03-01"), MAX = +arg("max", 40), GEN = +arg("gen", 2500), GRID = process.argv.includes("--grid");
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN, se = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : NaN;
// current settings (copied from server/contestsim.mjs so a sweep can vary them)
const ARCH = { low: { conc: 1.0, minSal: 48800, boost: 0.6, skill: [[0.10, 40], [0.30, 4]], dupeFloor: "auto" }, marquee: { conc: 1.0, minSal: 49000, boost: 1.0, skill: [[0.15, 60], [0.35, 5]], dupeFloor: "auto" }, high: { conc: 1.15, minSal: 49200, boost: 1.5, skill: [[0.20, 80], [0.40, 6]], dupeFloor: "auto" } };
const NFL_STACKS = { low: { 1: 46, 2: 40, 3: 4, bring: 60 }, marquee: { 1: 45, 2: 41, 3: 5, bring: 62 }, high: { 1: 37, 2: 48, 3: 10, bring: 67 } };
const SET = JSON.parse(arg("set", "{}"));
for (const [k, v] of Object.entries(SET)) Object.assign(ARCH[k], v);
export const tierOf = (fee, n) => fee >= 100 && n <= 1000 ? "high" : (fee < 20 || n > 10000) ? "low" : "marquee";
const scaleSkill = (sk, s) => sk.map(([p, m]) => [Math.min(0.9, p * s), m]);
// variants per archetype: the current setting, or a grid over conc and the skill (optimizer) share
const variantsFor = t => {
  const b = ARCH[t]; if (!GRID) return { cur: b };
  const out = {}; for (const c of [0.9, 1.0, 1.1, 1.25, 1.35]) for (const s of [0.5, 1]) out[`c${c}s${s}`] = Object.assign({}, b, { conc: c, skill: scaleSkill(b.skill, s) });
  return out;
};

function stats(lus, P, aOwn, inOwn) {
  const N = lus.length, cnt = new Map(), sig = {};
  let own = 0, sal = 0; const st = { 0: 0, 1: 0, 2: 0, 3: 0 }; let stacked = 0, bring = 0;
  for (const lu of lus) {
    const pl = lu.map(i => P[i]); for (const p of pl) cnt.set(p.k, (cnt.get(p.k) || 0) + 1);
    own += pl.reduce((s, p) => s + (aOwn.get(p.k) || 0), 0); sal += pl.reduce((s, p) => s + p.sal, 0);
    const s = lu.slice().sort((a, b) => a - b).join(","); sig[s] = (sig[s] || 0) + 1;
    const qb = pl.find(p => p.pos === "QB"); if (!qb) { st[0]++; continue; }
    const n = pl.filter(p => p !== qb && p.team === qb.team && /^(WR|TE|RB)$/.test(p.pos)).length; st[Math.min(3, n)]++;
    if (n) { stacked++; if (pl.some(p => p.team === qb.opp && p.pos !== "DST")) bring++; }
  }
  const exp = new Map([...cnt].map(([k, c]) => [k, 100 * c / N]));
  const chalk = [...inOwn].filter(([k]) => aOwn.has(k)).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const chalkIn = chalk.reduce((s, [, v]) => s + v, 0), chalkExp = chalk.reduce((s, [k]) => s + (exp.get(k) || 0), 0);
  const top10 = [...exp.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, x) => s + x, 0) / 900;
  const dup = lus.filter(lu => sig[lu.slice().sort((a, b) => a - b).join(",")] > 1).length / N;
  return { ratio: chalkExp / chalkIn, top10, own: own / N, sal: sal / N, q1: st[1] / N, q2: st[2] / N, q3: st[3] / N, unst: st[0] / N, bring: stacked ? bring / stacked : 0, dup, exp };
}

const isMain = rc => rc.pool.teams.length >= 22;
const main = DATE === "2026-10-04" ? loadPool("2026-10-04-nfl-main") : null;
let list = listContests().filter(c => c.json && c.fkey === "nfl_cl" && c.fee >= 3 && c.entries >= 100 && (DATE ? c.date === DATE : c.date >= FROM && c.date < TO));
const byT = { high: [], marquee: [], low: [] }; for (const c of list) byT[tierOf(c.fee, c.entries)].push(c);
const thin = a => { const step = Math.max(1, Math.floor(a.length / MAX)); return a.filter((c, i) => i % step === 0).slice(0, MAX); };
const out = { at: new Date().toISOString(), date: DATE, from: DATE ? null : FROM, to: DATE ? null : TO, gen: GEN, arch: ARCH, tiers: {} };
const TIERS = arg("tiers", "high,marquee,low").split(",");
for (const t of TIERS) {
  const V = variantsFor(t), rows = [];
  for (const c of thin(byT[t])) {
    const rc = loadPulled(c.json); if (DATE === "2026-10-04" && !isMain(rc)) continue;
    const RP = rc.pool.players.map(p => Object.assign({}, p, { k: nrm(p.name) + "|" + p.team }));
    const aOwn = new Map(RP.map(p => [p.k, p.actOwn || 0])), N = rc.entries.length; if (N < 100) continue;
    let gp;
    if (main) gp = fieldPool(main, { ownSrc: "auto", projSrc: "lab", contest: { field: c.entries, fee: c.fee } });
    else { const r = ownModel("classic")(RP.map(p => ({ pos: p.pos, team: p.team, sal: p.sal, proj: p.proj, vown: p.own })), { n: c.entries, fee: c.fee }); gp = Object.assign({}, rc.pool, { players: RP.map((p, i) => Object.assign({}, p, { own: r[i].labOwn ?? p.own, fown: r[i].labOwn ?? p.own })) }); }
    const GP = gp.players.map(p => Object.assign({}, p, { k: nrm(p.name) + "|" + p.team }));
    const inOwn = new Map(GP.filter(p => p.own > 0).map(p => [p.k, p.own]));
    const real = stats(rc.entries.map(e => e.lu), RP, aOwn, inOwn); delete real.exp;
    const row = { key: c.key, name: c.name, fee: c.fee, N, real, gen: {} }, n = Math.min(N, GEN);
    for (const [vk, v] of Object.entries(V)) { const g = stats(genField(gp, n, Object.assign({ rounds: 3, nflStacks: NFL_STACKS[t] }, v), mulberry32(1)).field, GP, aOwn, inOwn); delete g.exp; if (N > GEN) g.dup = null; row.gen[vk] = g; }
    rows.push(row);
    const g0 = row.gen[Object.keys(V)[0]];
    console.error(`${t} $${c.fee} N${N} real ratio ${real.ratio.toFixed(2)} top10 ${real.top10.toFixed(3)} own ${real.own.toFixed(0)} | ${Object.keys(V)[0]} ratio ${g0.ratio.toFixed(2)} top10 ${g0.top10.toFixed(3)} own ${g0.own.toFixed(0)}`);
  }
  const sum = {}, keys = ["ratio", "top10", "own", "sal", "q1", "q2", "q3", "unst", "bring", "dup"];
  const agg = get => Object.fromEntries(keys.map(k => { const a = rows.map(get).map(x => x && x[k]).filter(x => x != null && isFinite(x)); return [k, [+mean(a).toFixed(4), +se(a).toFixed(4)]]; }));
  sum.real = agg(r => r.real);
  for (const vk of Object.keys(V)) { sum[vk] = agg(r => r.gen[vk]); sum[vk].gapRatio = +mean(rows.map(r => r.gen[vk].ratio - r.real.ratio)).toFixed(4); sum[vk].gapTop10 = +mean(rows.map(r => r.gen[vk].top10 - r.real.top10)).toFixed(4); sum[vk].maeRatio = +mean(rows.map(r => Math.abs(r.gen[vk].ratio - r.real.ratio))).toFixed(4); }
  out.tiers[t] = { n: rows.length, summary: sum, rows };
  console.log(`\n== ${t} (${rows.length} contests)  real: ratio ${sum.real.ratio[0]}±${sum.real.ratio[1]} top10 ${sum.real.top10[0]} own ${sum.real.own[0]} q1/q2/q3/unst ${[sum.real.q1[0], sum.real.q2[0], sum.real.q3[0], sum.real.unst[0]].join("/")} bring ${sum.real.bring[0]} dup ${sum.real.dup[0]} sal ${sum.real.sal[0]}`);
  for (const vk of Object.keys(V)) { const s = sum[vk]; console.log(`  ${vk.padEnd(10)} ratio ${s.ratio[0]} (gap ${s.gapRatio}, mae ${s.maeRatio}) top10 ${s.top10[0]} (gap ${s.gapTop10}) own ${s.own[0]} q1/q2/q3/unst ${[s.q1[0], s.q2[0], s.q3[0], s.unst[0]].join("/")} bring ${s.bring[0]} dup ${s.dup[0]} sal ${s.sal[0]}`); }
}
const tag = DATE || `${FROM}_${TO}`;
fs.writeFileSync(`data/reports/fit-arch-nfl-${tag}${GRID ? "-grid" : ""}${Object.keys(SET).length ? "-set" : ""}.json`, JSON.stringify(out));
