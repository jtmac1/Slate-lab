// NFL showdown dispersion: realized lineup residual (actual - Stokastic projection) versus what the
// outcome model draws, by all-six-spot structure and by captain ownership. Pulled fields carry no
// vendor Std Dev, so the sim side runs on the SIGMA_DEF.nfl defaults (the recovered-pool path).
//   node bench/sd-variance.mjs [draws=1000] [maxEntries=5000] [qbSig] [wrSig] [rbSig] [teSig] [dstSig] [sigmaMax] [corrScale]
//   corrScale multiplies every same-team and opponent correlation (CSAME/COPP); "-" keeps a default
import { listContests, loadPulled } from "./grade-all.mjs";
import { buildModel, drawScores, makeScratch, CSAME, COPP, MLBC, SIGMA_DEF, SIGMA_MAX } from "../src/engine/model.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const [drawsArg = "1000", maxNArg = "5000", ...sig] = process.argv.slice(2), DRAWS = +drawsArg;
const over = {}; ["QB", "WR", "RB", "TE", "DST"].forEach((k, i) => { if (sig[i] != null && sig[i] !== "-") over[k] = +sig[i]; }); const SMAX = sig[5] != null && sig[5] !== "-" ? +sig[5] : SIGMA_MAX;
const sigmaDef = Object.assign({}, SIGMA_DEF.nfl, over), CS = sig[6] != null && sig[6] !== "-" ? +sig[6] : 1;
const scale = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v * CS])), tables = { CSAME: scale(CSAME), COPP: scale(COPP), MLBC };
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1), sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const contests = listContests().filter(c => c.fkey === "nfl_sd" && c.json && c.entries <= +maxNArg);
const rows = []; const rng = mulberry32(5);
for (const c of contests) {
  const { pool, entries } = loadPulled(c.json), P = pool.players, f = pool.format, mult = f.mult;
  const seen = new Set(), E = [];
  for (const e of entries) { const k = e.lu.join(","); if (!seen.has(k) && e.stkFP > 0) { seen.add(k); E.push(e); } }
  const pick = E.length > 400 ? E.filter(() => rng() < 400 / E.length) : E;
  const model = buildModel(pool, { sigmaDef, sigmaMax: SMAX, tables }), sc = new Float64Array(P.length), scratch = makeScratch(model, pool);
  const proj = pick.map(e => e.lu.reduce((s, id, q) => s + mult[q] * P[id].proj, 0)), sum = new Float64Array(pick.length), sq = new Float64Array(pick.length), big = new Float64Array(pick.length);
  for (let d = 0; d < DRAWS; d++) { drawScores(model, pool, rng, sc, scratch); for (let k = 0; k < pick.length; k++) { let t = 0; const l = pick[k].lu; for (let q = 0; q < l.length; q++) t += mult[q] * sc[l[q]]; sum[k] += t; sq[k] += t * t; if (t > proj[k] + 30) big[k]++; } }
  pick.forEach((e, k) => { const m = sum[k] / DRAWS, cpt = P[e.lu[0]], six = Object.values(e.lu.reduce((a, id) => { a[P[id].team] = (a[P[id].team] || 0) + 1; return a; }, {})).sort((a, b) => b - a).join("-");
    rows.push({ resid: e.actFP - e.stkFP, big: e.actFP > e.stkFP + 30 ? 1 : 0, simSd: Math.sqrt(Math.max(0, sq[k] / DRAWS - m * m)), simBig: big[k] / DRAWS, simMean: m, proj: proj[k], stkFP: e.stkFP, six, cptOwn: cpt.cown || 0, cptPos: cpt.pos }); });
}
console.log(`${contests.length} showdowns, ${rows.length} lineups, ${DRAWS} draws; sigma ${JSON.stringify(sigmaDef)} cap ${SMAX} corr x${CS}`);
console.log(`overall: realized residual SD ${sd(rows.map(r => r.resid)).toFixed(1)} vs sim SD ${mean(rows.map(r => r.simSd)).toFixed(1)}; P(actual > proj+30) ${(100 * mean(rows.map(r => r.big))).toFixed(1)}% vs sim ${(100 * mean(rows.map(r => r.simBig))).toFixed(1)}%; sim mean/proj ${(mean(rows.map(r => r.simMean)) / mean(rows.map(r => r.proj))).toFixed(3)}, actual/proj ${(mean(rows.map(r => r.stkFP + r.resid)) / mean(rows.map(r => r.stkFP))).toFixed(3)}`);
const show = (title, bins) => { console.log(`\n=== ${title} ===`); console.log("bin".padEnd(14) + "n       real SD  sim SD  | real P(>+30)  sim   | actual/proj"); for (const [b, pred] of bins) { const rs = rows.filter(pred); if (rs.length < 30) continue; console.log(b.padEnd(14) + String(rs.length).padEnd(8) + sd(rs.map(r => r.resid)).toFixed(1).padEnd(9) + mean(rs.map(r => r.simSd)).toFixed(1).padEnd(8) + "| " + (100 * mean(rs.map(r => r.big))).toFixed(1).padEnd(14) + (100 * mean(rs.map(r => r.simBig))).toFixed(1).padEnd(6) + "| " + (mean(rs.map(r => r.stkFP + r.resid)) / mean(rs.map(r => r.stkFP))).toFixed(3)); } };
show("structure (all six spots)", [["4-2", r => r.six === "4-2"], ["3-3", r => r.six === "3-3"], ["5-1", r => r.six === "5-1"], ["6", r => r.six === "6"]]);
show("captain position", ["QB", "RB", "WR", "TE", "K", "DST"].map(p => [p, r => r.cptPos === p]));
show("captain projected ownership", [["<3%", r => r.cptOwn < 3], ["3-8%", r => r.cptOwn >= 3 && r.cptOwn < 8], ["8-15%", r => r.cptOwn >= 8 && r.cptOwn < 15], ["15%+", r => r.cptOwn >= 15]]);
