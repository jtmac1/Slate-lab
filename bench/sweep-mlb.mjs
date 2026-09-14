// Coordinate sweep of the MLB outcome model (sigmas, sigma cap, hitter/pitcher correlations)
// over every MLB post-contest export, with a holdout: fit on half the contests, report the
// other half at every accepted step, then swap halves. A change that only helps the fitting
// half is noise. Score = agreement with Stokastic's lineup ROI + player ROI on the fit half;
// predictive Spearman vs actual points is printed alongside.
//   node bench/sweep-mlb.mjs [iters]
import { listContests, gradeContest } from "./grade-all.mjs";
import { CSAME, COPP, MLBC, SIGMA_DEF, SIGMA_MAX } from "../src/engine/model.mjs";

const ITERS = +(process.argv[2] || 5000);
const all = listContests().filter(c => c.fkey === "mlb_cl");
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const clone = o => JSON.parse(JSON.stringify(o));

function evaluate(state, contests) {
  const rows = contests.map(c => gradeContest(c, { iters: ITERS, model: { tables: { CSAME, COPP, MLBC: state.MLBC }, sigmaDef: state.sigma, sigmaMax: state.sigmaMax } }));
  const r = { agree: mean(rows.map(x => x.agree)), pAgree: mean(rows.map(x => x.pAgree)), sMine: mean(rows.map(x => x.sMine)), pMine: mean(rows.map(x => x.pMine)) };
  r.score = r.agree + r.pAgree; return r;
}
const fmt = r => `score ${r.score.toFixed(3)} (agree ${r.agree.toFixed(3)} pAgree ${r.pAgree.toFixed(3)} pred ${r.sMine.toFixed(3)}/${r.pMine.toFixed(3)})`;
const HIT = ["C", "1B", "2B", "3B", "SS", "OF"];
const setHit = (sig, v) => { for (const k of HIT) sig[k] = v; };
const PARAMS = [
  ["sigmaMax", null, [0.5, 0.7, 0.8]], ["hit", null, [0.5, 0.7, 0.8]], ["pit", null, [0.45, 0.65]],
  ["MLBC", "hitSame", [0.08, 0.22, 0.30]], ["MLBC", "hitOppSameGame", [0.0, 0.05, 0.15]], ["MLBC", "hitOwnPitcher", [0.0, 0.12]],
  ["MLBC", "hitOppPitcher", [-0.30, -0.10]], ["MLBC", "pitchPitchSameGame", [-0.20, -0.05]]
];
const get = (st, tbl, key) => tbl === "sigmaMax" ? st.sigmaMax : tbl === "hit" ? st.sigma.C : tbl === "pit" ? st.sigma.P : st[tbl][key];
const set = (st, tbl, key, v) => { if (tbl === "sigmaMax") st.sigmaMax = v; else if (tbl === "hit") setHit(st.sigma, v); else if (tbl === "pit") { st.sigma.P = v; st.sigma.SP = v; st.sigma.RP = v + 0.05; } else st[tbl][key] = v; };

for (const [label, fit, hold] of [["fit A / hold B", all.filter((c, i) => i % 2 === 0), all.filter((c, i) => i % 2 === 1)], ["fit B / hold A", all.filter((c, i) => i % 2 === 1), all.filter((c, i) => i % 2 === 0)]]) {
  const cur = { MLBC: clone(MLBC), sigma: clone(SIGMA_DEF.mlb), sigmaMax: SIGMA_MAX };
  let best = evaluate(cur, fit), held = evaluate(cur, hold);
  console.log(`\n=== ${label}: fit ${fit.map(c => c.dir).join(", ")}`);
  console.log(`baseline fit ${fmt(best)} | holdout ${fmt(held)}`);
  for (const [tbl, key, vals] of PARAMS) {
    const orig = get(cur, tbl, key); let bestVal = orig;
    for (const v of vals) {
      set(cur, tbl, key, v); const r = evaluate(cur, fit);
      if (r.score > best.score + 0.004) { const h = evaluate(cur, hold); console.log(`${tbl}${key ? "." + key : ""} = ${v} (was ${orig}): fit ${fmt(r)} | holdout ${fmt(h)} ${h.score > held.score ? "<-- holds up" : "<-- holdout worse"}`); best = r; held = h; bestVal = v; }
      else console.log(`${tbl}${key ? "." + key : ""} = ${v} (was ${orig}): fit ${fmt(r)}`);
    }
    set(cur, tbl, key, bestVal);
    if (bestVal !== orig) console.log(`  keep ${tbl}${key ? "." + key : ""} = ${bestVal}`);
  }
  console.log(`final fit ${fmt(best)} | holdout ${fmt(held)}`);
  console.log("MLBC", JSON.stringify(cur.MLBC), "sigma", JSON.stringify(cur.sigma), "sigmaMax", cur.sigmaMax);
}
