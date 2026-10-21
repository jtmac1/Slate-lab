// One configuration of the CFB sim, graded contest by contest on pulled CFB classic contests, for the high-stakes
// tuning study (bench/tune-cfb-highstakes.mjs reads the output). Wraps grade-all's gradeContest so a contest that
// fails (a generator that cannot fill a tiny slate) is logged and skipped instead of killing the shard, and computes
// what the study needs per contest: lineup Spearman of sim ROI vs actual finish, what the sim's top picks realized
// (top 10% / top 3% by sim ROI, top 10% by sim top-1% chance: ROI, top-1% and top-10% rates), selection rules
// layered on the sim (top 10% by sim inside a pre-lock construction rule vs top 10% by sim alone), and with --gen
// the generated field's realism against the real one (grade-all fieldCheck: stack-shape distance, dupes, own sum).
// The baseline generator is what bench/build-slate.mjs builds for today's run (conc 1.0, salary floor 49,000,
// no skill mix, CFB stacks QB+1/2/3 = 43/32/8, bring-back 50), not grade-all's fee profile; model = engine defaults on the
// factor path, because a full projections file (800+ players) is over the 220-player Cholesky limit and so is today's
// build, while a pulled contest holds only rostered players (--chol keeps the pairwise-table path instead).
//   node bench/tune-cfb-sweep.mjs --name=base --out=<dir> [--gen] [--shard=k/n] [--minfee=0] [--maxentries=3000] [--iters=4000] [--seed=1]
//     model:     --projscale=0.92 | --projscale=QB:0.95,RB:0.9,WR:0.93   --projsal=lo:1,mid:0.95,hi:0.9 (salary <5K / 5-7K / 7K+)
//                --sig=QB:0.33,RB:0.42,WR:0.41   --sigscale=0.857   --corr=1.25 (all CFB pairs)  --corrsame=  --corropp=
//     generator: --conc=1.25  --stacks=1:45,2:40,3:7,bring:47,twoQB:95  --dupefloor (real duplicate share)  --profile (grade-all fee profile)
// Writes <out>/<name>.<k>.jsonl, one line per contest.
import fs from "node:fs";
import path from "node:path";
import { listContests, recover, gradeContest, fieldCheck } from "./grade-all.mjs";
import { CSAME_CFB, COPP_CFB, MLBC, LOAD, SIGMA_DEF } from "../src/engine/model.mjs";
const args = process.argv.slice(2), flag = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; }, has = k => args.includes(`--${k}`);
const NAME = flag("name") || "base", OUT = flag("out") || "data/reports/tune-cfb", ITERS = +(flag("iters") || 4000), MINFEE = +(flag("minfee") || 0), MAXN = +(flag("maxentries") || 3000);
const SHARD = (flag("shard") || "0/1").split("/").map(Number), GEN = has("gen");
const kv = s => Object.fromEntries(String(s).split(",").filter(Boolean).map(x => { const [k, v] = x.split(":"); return [k, +v]; }));
const PROJ = flag("projscale"), PROJSAL = flag("projsal") ? kv(flag("projsal")) : null;
const projBy = PROJ == null ? null : PROJ.includes(":") ? kv(PROJ) : { QB: +PROJ, RB: +PROJ, WR: +PROJ };
// model options
const model = has("chol") ? {} : { cholMax: 0 };
const sig = Object.assign({}, SIGMA_DEF.cfb); if (flag("sig")) Object.assign(sig, kv(flag("sig"))); if (flag("sigscale")) for (const k in sig) sig[k] *= +flag("sigscale");
if (flag("sig") || flag("sigscale")) model.sigmaBy = { cfb: sig };
const cAll = +(flag("corr") || 1), cSame = cAll * +(flag("corrsame") || 1), cOpp = cAll * +(flag("corropp") || 1);
if (cSame !== 1 || cOpp !== 1) {
  const sc = (t, x) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v * x]));
  model.tables = { CSAME: sc(CSAME_CFB, cSame), COPP: sc(COPP_CFB, cOpp), MLBC };
  // pools over 220 players use the factor model: scale team loadings for same-team, game and opponent loadings for opposing
  model.load = { cfb: Object.fromEntries(Object.entries(LOAD.cfb).map(([k, [g, t, o]]) => [k, [g * Math.sqrt(cOpp), t * Math.sqrt(cSame), o * Math.sqrt(cOpp)]])) };
}
// generator options (build-slate baseline)
const gen = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3, skill: null, nflStacks: { 1: 43, 2: 32, 3: 8, bring: 50 } }, has("profile") ? { skill: undefined, conc: undefined, minSal: undefined } : {});
if (has("profile")) { delete gen.skill; delete gen.conc; delete gen.minSal; }
if (flag("conc")) gen.conc = +flag("conc");
if (flag("stacks")) gen.nflStacks = kv(flag("stacks"));
if (has("dupefloor")) gen.dupeFloor = true;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const rankArr = v => { const o = v.map((x, i) => i).sort((a, b) => v[a] - v[b]), r = new Array(v.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && v[o[j + 1]] === v[o[i]]) j++; for (let k = i; k <= j; k++) r[o[k]] = (i + j) / 2; i = j + 1; } return r; };
const spearman = (a, b) => { const ra = rankArr(a), rb = rankArr(b), ma = mean(ra), mb = mean(rb); let n = 0, da = 0, db = 0; for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); };
// selection rules on PRE-LOCK information only (projected ownership), layered on the sim ranking
const RULES = {
  "max 2 under 5% proj own": f => f.sub5 <= 2, "3+ at 20%+ proj own": f => f.chalk >= 3, "no player under 5% proj own": f => f.sub5 === 0,
  "proj own sum above contest median": f => f.ownPct > 0.5, "two QBs": f => f.twoQB, "QB + 1 or more": f => f.stack >= 1, "bring-back": f => f.bring,
  "primary QB 10%+ proj own": f => f.qbOwn >= 10, "combo: max 2 sub-5%, 3+ chalk, two QBs": f => f.sub5 <= 2 && f.chalk >= 3 && f.twoQB
};

const contests = listContests().filter(c => c.fkey === "cfb_cl" && (c.fee || 0) >= MINFEE && (c.entries || 0) <= MAXN);
const mine = SHARD[1] > 1 ? contests.filter((c, i) => i % SHARD[1] === SHARD[0]) : contests;
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `${NAME}.${SHARD[0]}.jsonl`); fs.writeFileSync(file, "");
console.log(`${NAME}: ${mine.length} of ${contests.length} contests, ${GEN ? "generated field " + JSON.stringify(gen) : "real field"}, model ${JSON.stringify({ sig: model.sigmaBy ? sig : "default", corrSame: cSame, corrOpp: cOpp, proj: projBy, projSal: PROJSAL })}`);
let done = 0, failed = 0;
for (const c of mine) {
  const t0 = Date.now();
  try {
    const rc = recover(c), P = rc.pool.players;
    if (projBy || PROJSAL) for (const p of P) { const tier = p.sal < 5000 ? "lo" : p.sal < 7000 ? "mid" : "hi"; p.proj = p.proj * (projBy ? projBy[p.pos] ?? 1 : 1) * (PROJSAL ? PROJSAL[tier] ?? 1 : 1); }
    const r = gradeContest(c, Object.assign({ iters: ITERS, rows: true }, Object.keys(model).length ? { model } : {}, GEN ? { genField: true, batch: 50, gen } : {}));
    const rows = r.entryRows, E = rc.entries, N = rows.length;
    // pre-lock features per entry
    const F = E.map(e => { const ps = e.lu.map(id => P[id]), qbs = ps.filter(p => p.pos === "QB");
      const stk = q => ps.filter(p => p !== q && p.team === q.team && (p.pos === "WR" || p.pos === "RB")).length, qb = qbs.slice().sort((a, b) => stk(b) - stk(a) || b.sal - a.sal)[0];
      return { sub5: ps.filter(p => p.own < 5).length, chalk: ps.filter(p => p.own >= 20).length, own: ps.reduce((s, p) => s + p.own, 0), twoQB: qbs.length >= 2, stack: qb ? stk(qb) : 0, bring: !!qb && ps.some(p => p.team === qb.opp), qbOwn: qb ? qb.own : 0 }; });
    const ownS = F.map(f => f.own).slice().sort((a, b) => a - b); for (const f of F) { let lo = 0, hi = ownS.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ownS[m] < f.own) lo = m + 1; else hi = m; } f.ownPct = lo / ownS.length; }
    const k10 = Math.max(3, Math.round(N * 0.1)), k3 = Math.max(3, Math.round(N * 0.03));
    const idx = rows.map((x, i) => i), bySim = idx.slice().sort((a, b) => rows[b].roi - rows[a].roi), byT1 = idx.slice().sort((a, b) => rows[b].t1 - rows[a].t1 || rows[b].roi - rows[a].roi);
    const take = (ord, k) => ord.slice(0, k), m = (ids, key) => mean(ids.map(i => rows[i][key]));
    const out = { c: c.dir, date: c.date, fee: c.fee, N, name: c.name, ms: 0,
      spearman: spearman(rows.map(x => x.roi), rows.map(x => -x.finish)), sMine: r.sMine, pMine: r.pMine,
      roi10: m(take(bySim, k10), "actROI"), top1of10: m(take(bySim, k10), "top1"), top10of10: m(take(bySim, k10), "top10"),
      roi3: m(take(bySim, k3), "actROI"), top1of3: m(take(bySim, k3), "top1"), t1roi10: m(take(byT1, k10), "actROI"), t1top1of10: m(take(byT1, k10), "top1"),
      fieldTop1: m(idx, "top1"), rules: {} };
    for (const [nm, fn] of Object.entries(RULES)) { const ok = bySim.filter(i => fn(F[i])); const sel = ok.slice(0, k10), sel3 = ok.slice(0, k3);
      out.rules[nm] = { share: ok.length / N, roi10: m(sel, "actROI"), top1of10: m(sel, "top1"), roi3: m(sel3, "actROI"), top1of3: m(sel3, "top1") }; }
    if (GEN) { const fc = fieldCheck(c, { proj: false, gen }); out.field = { tvd: fc.tvd, dupReal: fc.dupReal / fc.N, dupGen: fc.dupGen / Math.max(1, fc.gen), ownReal: fc.ownReal, ownGen: fc.ownGen, gap: fc.gap, salReal: fc.salReal, salGen: fc.salGen }; }
    out.ms = Date.now() - t0; fs.appendFileSync(file, JSON.stringify(out) + "\n"); done++;
  } catch (e) { failed++; console.log(`  FAILED ${c.dir}: ${e.message}`); }
}
console.log(`${NAME} shard ${SHARD[0]}/${SHARD[1]}: ${done} graded, ${failed} failed -> ${file}`);
