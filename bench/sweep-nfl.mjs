// Coordinate sweep of the NFL correlation tables and default sigmas over every NFL
// post-contest export. Score = agreement with Stokastic's lineup ROI + player ROI
// (the sim we are replacing); predictive Spearman vs actual points is printed alongside
// so a change that matches Stokastic better but predicts worse is visible.
//   node bench/sweep-nfl.mjs [iters] [passes]
import { listContests, gradeContest } from "./grade-all.mjs";
import { CSAME, COPP, MLBC, SIGMA_DEF } from "../src/engine/model.mjs";

const ITERS = +(process.argv[2] || 5000), PASSES = +(process.argv[3] || 1);
const contests = listContests().filter(c => c.sport === "nfl");
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const clone = o => JSON.parse(JSON.stringify(o));
const cur = { CSAME: clone(CSAME), COPP: clone(COPP), sigma: clone(SIGMA_DEF.nfl) };

function evaluate(state) {
  const rows = contests.map(c => gradeContest(c, { iters: ITERS, model: { tables: { CSAME: state.CSAME, COPP: state.COPP, MLBC }, sigmaDef: state.sigma } }));
  const by = k => rows.filter(r => r.fkey === k);
  const f = rs => ({ agree: mean(rs.map(r => r.agree)), pAgree: mean(rs.map(r => r.pAgree)), sMine: mean(rs.map(r => r.sMine)), pMine: mean(rs.map(r => r.pMine)) });
  const cl = f(by("nfl_cl")), sd = f(by("nfl_sd")), all = f(rows);
  return { score: all.agree + all.pAgree, cl, sd, all };
}
const fmt = r => `score ${r.score.toFixed(3)} | classic agree ${r.cl.agree.toFixed(3)} pAgree ${r.cl.pAgree.toFixed(3)} pred ${r.cl.sMine.toFixed(3)}/${r.cl.pMine.toFixed(3)} | showdown agree ${r.sd.agree.toFixed(3)} pAgree ${r.sd.pAgree.toFixed(3)} pred ${r.sd.sMine.toFixed(3)}/${r.sd.pMine.toFixed(3)}`;

const PARAMS = [
  ["sigma", "QB", [0.35, 0.55]], ["sigma", "RB", [0.5, 0.75]], ["sigma", "WR", [0.6, 0.85]], ["sigma", "TE", [0.65, 0.9]], ["sigma", "DST", [0.6, 1.0]], ["sigma", "K", [0.3, 0.55]],
  ["CSAME", "QB|WR", [0.4, 0.5, 0.7, 0.8]], ["CSAME", "QB|TE", [0.3, 0.6]], ["CSAME", "QB|RB", [0.0, 0.3]], ["CSAME", "RB|RB", [-0.35, -0.05]],
  ["CSAME", "WR|WR", [0.0, 0.2, 0.3]], ["CSAME", "RB|WR", [-0.1, 0.1]], ["CSAME", "QB|DST", [0.0, 0.25]], ["CSAME", "WR|TE", [0.0, 0.2]],
  ["COPP", "QB|QB", [0.1, 0.4]], ["COPP", "QB|WR", [0.1, 0.3]], ["COPP", "QB|DST", [-0.6, -0.3]], ["COPP", "WR|DST", [-0.5, -0.2]], ["COPP", "RB|DST", [-0.4, -0.1]], ["COPP", "WR|WR", [0.05, 0.25]]
];

let best = evaluate(cur);
console.log("baseline: " + fmt(best));
for (let pass = 0; pass < PASSES; pass++) {
  for (const [tbl, key, vals] of PARAMS) {
    const orig = cur[tbl][key]; let bestVal = orig;
    for (const v of vals) {
      cur[tbl][key] = v; const r = evaluate(cur);
      const mark = r.score > best.score + 0.004 ? " <-- better" : "";
      console.log(`${tbl}.${key} = ${v} (was ${orig}): ${fmt(r)}${mark}`);
      if (r.score > best.score + 0.004) { best = r; bestVal = v; }
    }
    cur[tbl][key] = bestVal;
    if (bestVal !== orig) console.log(`  keep ${tbl}.${key} = ${bestVal}`);
  }
}
console.log("\nfinal: " + fmt(best));
console.log("CSAME", JSON.stringify(cur.CSAME));
console.log("COPP", JSON.stringify(cur.COPP));
console.log("sigma", JSON.stringify(cur.sigma));
