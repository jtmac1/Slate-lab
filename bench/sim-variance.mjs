// Does the sim's lineup spread match reality? Draws scores from the outcome model for real
// lineups (sampled per slate) and reports simulated SD and big-score rate by primary stack size
// and chalk count, to set against bench/chalk-bias.mjs (actual residual SD 24.9/26.5/27.7/28.5
// for stacks <=2/3/4/5, P(actual > proj+30) 12.1/14.1/15.2/15.5%).
//   node bench/sim-variance.mjs [draws=1500] [hitSame] [hitterSigma] [sigmaMax]
import { listContests, loadPulled } from "./grade-all.mjs";
import { buildModel, drawScores, makeScratch, CSAME, COPP, MLBC, SIGMA_DEF, SIGMA_MAX } from "../src/engine/model.mjs";
import { stackOf } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const DRAWS = +(process.argv[2] || 1500), HS = process.argv[3] != null && process.argv[3] !== "-" ? +process.argv[3] : null, HSIG = process.argv[4] != null && process.argv[4] !== "-" ? +process.argv[4] : null, SMAX = process.argv[5] != null && process.argv[5] !== "-" ? +process.argv[5] : null, SLOPE = +(process.argv[6] || 0);
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const tables = { CSAME, COPP, MLBC: Object.assign({}, MLBC, HS != null ? { hitSame: HS } : {}) };
const sigma = Object.assign({}, SIGMA_DEF.mlb); if (HSIG != null) for (const k of ["C", "1B", "2B", "3B", "SS", "OF"]) sigma[k] = HSIG;
const byDate = {}; for (const c of listContests().filter(c => c.fkey === "mlb_cl" && c.json)) if (!byDate[c.date]) byDate[c.date] = c;
const rows = [], types = {}; const rng = mulberry32(3);
for (const c of Object.values(byDate)) {
  const { pool, entries } = loadPulled(c.json), P = pool.players, f = pool.format;
  const seen = new Set(), lus = [];
  for (const e of entries) { const k = e.lu.slice().sort().join(","); if (!seen.has(k)) { seen.add(k); lus.push(e.lu); } }
  const pick = lus.length > 1500 ? lus.filter(() => rng() < 1500 / lus.length) : lus;
  const chalk = new Set(P.map((p, i) => i).filter(i => !P[i].isP).sort((a, b) => P[b].own - P[a].own).slice(0, 10));
  const model = buildModel(pool, { tables, sigmaDef: sigma, sigmaMax: SMAX != null ? SMAX : SIGMA_MAX }), sc = new Float64Array(P.length), scratch = makeScratch(model, pool);
  types[model.type] = (types[model.type] || 0) + 1;
  // SLOPE > 0: hitter sigma shrinks with projection, sigma * (proj / 8)^-SLOPE, so chalk (high-projection) hitters get less relative spread
  if (SLOPE) P.forEach((p, i) => { if (!p.isP && p.proj > 0) model.sig[i] = Math.min(SMAX != null ? SMAX : SIGMA_MAX, model.sig[i] * Math.pow(p.proj / 8, -SLOPE)); });
  const proj = pick.map(l => l.reduce((s, id) => s + P[id].proj, 0)), sum = new Float64Array(pick.length), sq = new Float64Array(pick.length), big = new Float64Array(pick.length);
  for (let d = 0; d < DRAWS; d++) { drawScores(model, pool, rng, sc, scratch); for (let k = 0; k < pick.length; k++) { let t = 0; for (const id of pick[k]) t += sc[id]; sum[k] += t; sq[k] += t * t; if (t > proj[k] + 30) big[k]++; } }
  pick.forEach((l, k) => { const m = sum[k] / DRAWS; rows.push({ proj: proj[k], simMean: m, sd: Math.sqrt(Math.max(0, sq[k] / DRAWS - m * m)), big: big[k] / DRAWS, primary: +String(stackOf(l, P, f)).split(/[^0-9]/)[0] || 0, chalkN: l.filter(id => chalk.has(id)).length }); });
}
console.log(`${Object.keys(byDate).length} slates, ${rows.length} lineups, ${DRAWS} draws; hitSame ${tables.MLBC.hitSame}, hitter sigma ${sigma.OF}, sigmaMax ${SMAX != null ? SMAX : SIGMA_MAX}, slope ${SLOPE}; model types ${JSON.stringify(types)}`);
console.log(`overall: sim mean/proj ${(mean(rows.map(r => r.simMean)) / mean(rows.map(r => r.proj))).toFixed(3)}, sim SD ${mean(rows.map(r => r.sd)).toFixed(1)} (actual residual SD 27.8), P(>proj+30) ${(100 * mean(rows.map(r => r.big))).toFixed(1)}% (actual 14.9%)`);
const show = (title, bins, act) => { console.log(`\n=== ${title} ===`); console.log("bin".padEnd(8) + "n       sim SD   actual SD | sim P(>+30)  actual"); bins.forEach(([b, pred], i) => { const rs = rows.filter(pred); if (rs.length) console.log(b.padEnd(8) + String(rs.length).padEnd(8) + mean(rs.map(r => r.sd)).toFixed(1).padEnd(9) + String(act[i][0]).padEnd(10) + "| " + (100 * mean(rs.map(r => r.big))).toFixed(1).padEnd(13) + act[i][1] + "%"); }); };
show("primary stack size", [["<=2", r => r.primary <= 2], ["3", r => r.primary === 3], ["4", r => r.primary === 4], ["5", r => r.primary === 5]], [[24.9, 12.1], [26.5, 14.1], [27.7, 15.2], [28.5, 15.5]]);
show("chalk count", [["0", r => r.chalkN === 0], ["1", r => r.chalkN === 1], ["2", r => r.chalkN === 2], ["3", r => r.chalkN === 3], ["4", r => r.chalkN === 4], ["5+", r => r.chalkN >= 5]], [[27.5, 14.3], [27.6, 15.0], [28.5, 16.5], [28.1, 15.6], [27.3, 13.6], [27.2, 13.5]]);
