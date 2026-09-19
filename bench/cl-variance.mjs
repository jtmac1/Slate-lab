// Classic-format dispersion: realized lineup residual (actual - Stokastic projection) versus what
// the outcome model draws for the same real lineups, overall and by QB-stack size. Pulled pools
// carry no vendor Std Dev, so the sim side runs on the format's default sigma table.
//   node bench/cl-variance.mjs cfb_cl [draws=800] [maxEntries=5000] [sigmaScale=1] [corrScale=1]
//   sigmaScale multiplies every default sigma; corrScale multiplies every same-team/opponent correlation.
import { listContests, loadPulled } from "./grade-all.mjs";
import { buildModel, drawScores, makeScratch, CSAME, COPP, MLBC, SIGMA_DEF } from "../src/engine/model.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const [fkey = "cfb_cl", drawsArg = "800", maxNArg = "5000", sigScaleArg = "1", corrArg = "1"] = process.argv.slice(2);
const DRAWS = +drawsArg, SS = +sigScaleArg, CS = +corrArg;
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1), sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const scale = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v * CS])), tables = { CSAME: scale(CSAME), COPP: scale(COPP), MLBC };
const contests = listContests().filter(c => c.fkey === fkey && c.json && c.entries <= +maxNArg);
const rows = [], rng = mulberry32(5);
for (const c of contests) {
  const { pool, entries } = loadPulled(c.json), P = pool.players, f = pool.format;
  const base = Object.assign({}, SIGMA_DEF[f.key] || SIGMA_DEF[f.sport] || SIGMA_DEF.nfl), sigmaDef = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * SS]));
  const seen = new Set(), E = [];
  for (const e of entries) { const k = e.lu.join(","); if (!seen.has(k) && e.stkFP > 0) { seen.add(k); E.push(e); } }
  const pick = E.length > 400 ? E.filter(() => rng() < 400 / E.length) : E;
  const model = buildModel(pool, { sigmaDef, tables }), sc = new Float64Array(P.length), scratch = makeScratch(model, pool);
  const proj = pick.map(e => e.lu.reduce((s, id) => s + P[id].proj, 0)), sum = new Float64Array(pick.length), sq = new Float64Array(pick.length), big = new Float64Array(pick.length);
  for (let d = 0; d < DRAWS; d++) { drawScores(model, pool, rng, sc, scratch); for (let k = 0; k < pick.length; k++) { let t = 0; for (const id of pick[k].lu) t += sc[id]; sum[k] += t; sq[k] += t * t; if (t > proj[k] + 30) big[k]++; } }
  pick.forEach((e, k) => {
    const m = sum[k] / DRAWS, ps = e.lu.map(id => P[id]), qb = ps.find(p => p.pos === "QB");
    const mates = qb ? ps.filter(p => p !== qb && p.team === qb.team).length : 0, qbs = ps.filter(p => p.pos === "QB").length;
    rows.push({ resid: e.actFP - e.stkFP, big: e.actFP > e.stkFP + 30 ? 1 : 0, simSd: Math.sqrt(Math.max(0, sq[k] / DRAWS - m * m)), simBig: big[k] / DRAWS, mates: Math.min(mates, 3), qbs, proj: proj[k], stkFP: e.stkFP });
  });
}
console.log(`${fkey}: ${contests.length} contests, ${rows.length} lineups, ${DRAWS} draws; sigma x${SS} (${JSON.stringify(SIGMA_DEF[fkey] || SIGMA_DEF[fkey.split("_")[0]])}), corr x${CS}`);
console.log(`overall: realized residual SD ${sd(rows.map(r => r.resid)).toFixed(1)} vs sim SD ${mean(rows.map(r => r.simSd)).toFixed(1)}; P(actual > proj+30) ${(100 * mean(rows.map(r => r.big))).toFixed(1)}% vs sim ${(100 * mean(rows.map(r => r.simBig))).toFixed(1)}%; actual/proj ${(mean(rows.map(r => r.stkFP + r.resid)) / mean(rows.map(r => r.stkFP))).toFixed(3)}`);
const show = (title, bins) => { console.log(`\n=== ${title} ===`); console.log("bin".padEnd(14) + "n       real SD  sim SD  | real P(>+30)  sim   | actual/proj"); for (const [b, pred] of bins) { const rs = rows.filter(pred); if (rs.length < 30) continue; console.log(b.padEnd(14) + String(rs.length).padEnd(8) + sd(rs.map(r => r.resid)).toFixed(1).padEnd(9) + mean(rs.map(r => r.simSd)).toFixed(1).padEnd(8) + "| " + (100 * mean(rs.map(r => r.big))).toFixed(1).padEnd(14) + (100 * mean(rs.map(r => r.simBig))).toFixed(1).padEnd(6) + "| " + (mean(rs.map(r => r.stkFP + r.resid)) / mean(rs.map(r => r.stkFP))).toFixed(3)); } };
show("QB + teammates", [["QB + 0", r => r.mates === 0], ["QB + 1", r => r.mates === 1], ["QB + 2", r => r.mates === 2], ["QB + 3 or more", r => r.mates >= 3]]);
show("quarterbacks rostered", [["1 QB", r => r.qbs === 1], ["2 QB", r => r.qbs === 2]]);
