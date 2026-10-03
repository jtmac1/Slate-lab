// Which players come in under- or over-owned? For every player in every pulled classic contest
// ($20+): the gap between actual and projected ownership, explained by player-level features
// (projected ownership bucket, position, salary, value, rank within position, the team's QB
// ownership, the slate's chalk count, field size). Linear fit on 2025, scored on 2026, so the
// hold-out says whether the prediction is real. Output feeds the calibrated ownership ("Lab own").
//   node bench/fit-own-error-nfl.mjs [--holdout=2026-06-01]   -> data/reports/own-error-nfl.json
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
const HOLD = ((process.argv.find(a => a.startsWith("--holdout=")) || "--holdout=2026-06-01").slice(10));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const POS = ["QB", "RB", "WR", "TE", "DST"], rows = [];
let contests = 0;
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.players?.length || !j.lineups?.length || c.fee < 20 || /showdown/i.test(c.type + " " + c.name) || j.lineups.length < 100) continue;
  const P = j.players.filter(p => p.pos !== "CPT" && p.sal > 0 && p.pown != null && p.aown != null && POS.includes(p.pos)); if (P.length < 60) continue;
  const qbOwn = {}; for (const p of P) if (p.pos === "QB") qbOwn[p.team] = Math.max(qbOwn[p.team] || 0, p.pown);
  const chalkN = P.filter(p => p.pown >= 0.2).length, byPos = {}; for (const p of P) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  for (const list of Object.values(byPos)) list.sort((a, b) => b.pown - a.pown).forEach((p, i) => { p._rank = i; });
  const teamOwn = {}; for (const p of P) teamOwn[p.team] = (teamOwn[p.team] || 0) + p.pown;
  for (const p of P) { if (p.pown < 0.01 && p.aown < 0.01) continue; rows.push({ season: c.date < HOLD ? "train" : "test", key: c.key, name: p.name, pos: p.pos, pown: 100 * p.pown, aown: 100 * p.aown, sal: p.sal, proj: p.proj, value: p.proj / (p.sal / 1000), rank: p._rank, qbOwn: 100 * (qbOwn[p.team] || 0), teamOwn: 100 * (teamOwn[p.team] || 0), chalkN, logN: Math.log10(j.lineups.length), fee: c.fee }); }
  contests++;
}
// target: log ratio (actual+1)/(projected+1); features
const feat = r => [1, Math.log(r.pown + 1), Math.pow(Math.log(r.pown + 1), 2), ...POS.map(p => r.pos === p ? 1 : 0).slice(1), r.sal / 1000, r.value, Math.min(r.rank, 8), Math.log(r.qbOwn + 1), Math.log(r.teamOwn + 1), r.chalkN, r.logN, Math.log(r.fee)];
const FEAT = ["const", "ln(pown+1)", "ln(pown+1)^2", "RB", "WR", "TE", "DST", "salary/1K", "value", "pos rank", "ln(QB own+1)", "ln(team own+1)", "slate chalk count", "log field", "log fee"];
const y = r => Math.log((r.aown + 1) / (r.pown + 1));
function ols(R) {
  const A = R.map(feat), Y = R.map(y), p = A[0].length, XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
  for (let i = 0; i < A.length; i++) for (let a = 0; a < p; a++) { Xty[a] += A[i][a] * Y[i]; for (let b = 0; b < p; b++) XtX[a][b] += A[i][a] * A[i][b]; }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) { let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = 0; k <= p; k++) M[c][k] /= d; for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c]; for (let k = 0; k <= p; k++) M[r][k] -= f * M[c][k]; } }
  return M.map(row => row[p]);
}
// multiplier clamped: the quadratic term extrapolates past the data at 50%+ projected (Gibbs 52 -> 86 unclamped)
const CLAMP = [0.5, 1.4];
const predict = (beta, r) => { const m = Math.min(CLAMP[1], Math.max(CLAMP[0], Math.exp(feat(r).reduce((s, v, i) => s + v * beta[i], 0)))); return Math.max(0, (r.pown + 1) * m - 1); };
const train = rows.filter(r => r.season === "train"), test = rows.filter(r => r.season === "test");
const beta = ols(train);
const score = (R, label) => {
  const maeProj = mean(R.map(r => Math.abs(r.aown - r.pown))), maeModel = mean(R.map(r => Math.abs(r.aown - predict(beta, r))));
  // bucket curve baseline: multiply by the train-set ratio in the player's projected bucket
  const B = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 45], [45, 100]], ratio = B.map(([lo, hi]) => { const s = train.filter(r => r.pown >= lo && r.pown < hi); return s.length ? mean(s.map(r => r.aown)) / mean(s.map(r => r.pown)) : 1; });
  const curve = r => { const i = B.findIndex(([lo, hi]) => r.pown >= lo && r.pown < hi); return r.pown * (i >= 0 ? ratio[i] : 1); };
  const maeCurve = mean(R.map(r => Math.abs(r.aown - curve(r))));
  // on chalk only (projected 15%+): where it matters
  const C = R.filter(r => r.pown >= 15);
  const cProj = mean(C.map(r => Math.abs(r.aown - r.pown))), cModel = mean(C.map(r => Math.abs(r.aown - predict(beta, r)))), cCurve = mean(C.map(r => Math.abs(r.aown - curve(r))));
  // direction: does the model call under/over correctly on chalk (actual vs projected by >= 3 pts)?
  const D = C.filter(r => Math.abs(r.aown - r.pown) >= 3), hit = D.filter(r => Math.sign(predict(beta, r) - r.pown) === Math.sign(r.aown - r.pown)).length;
  console.log(`${label}: ${R.length} player-contests | all: proj MAE ${maeProj.toFixed(2)}  curve ${maeCurve.toFixed(2)}  model ${maeModel.toFixed(2)} | chalk 15%+: proj ${cProj.toFixed(2)}  curve ${cCurve.toFixed(2)}  model ${cModel.toFixed(2)} | direction on 3+ pt misses: ${hit}/${D.length} = ${(100 * hit / D.length).toFixed(0)}%`);
  return { n: R.length, maeProj: +maeProj.toFixed(3), maeCurve: +maeCurve.toFixed(3), maeModel: +maeModel.toFixed(3), chalk: { n: C.length, maeProj: +cProj.toFixed(3), maeCurve: +cCurve.toFixed(3), maeModel: +cModel.toFixed(3), direction: +(hit / D.length).toFixed(3), misses: D.length } };
};
console.log(`${contests} classic contests; train before ${HOLD}`);
// production fit: every contest, the current season counted twice (fields drift year to year)
const prod = ols(rows.flatMap(r => r.season === "test" ? [r, r] : [r]));
const out = { built: new Date().toISOString(), holdout: HOLD, contests, features: FEAT, clamp: CLAMP, beta: Object.fromEntries(beta.map((b, i) => [FEAT[i], +b.toFixed(5)])), prodBeta: prod.map(b => +b.toFixed(5)), train: score(train, "train"), test: score(test, "test ") };
console.log("\ncoefficients (log ratio of actual to projected ownership):"); for (const [k, v] of Object.entries(out.beta)) console.log(`  ${k.padEnd(18)} ${v > 0 ? "+" : ""}${v}`);
// example: biggest predicted under/over on the test set
const ex = test.map(r => Object.assign({}, r, { pred: predict(beta, r) })).filter(r => r.pown >= 15).sort((a, b) => (b.pred - b.pown) - (a.pred - a.pown));
console.log("\ntest-set examples, predicted most OVER-owned vs projection:"); for (const r of ex.slice(0, 5)) console.log(`  ${r.name.padEnd(22)} ${r.pos} proj ${r.pown.toFixed(1)} -> pred ${r.pred.toFixed(1)} actual ${r.aown.toFixed(1)}`);
console.log("predicted most UNDER-owned:"); for (const r of ex.slice(-5).reverse()) console.log(`  ${r.name.padEnd(22)} ${r.pos} proj ${r.pown.toFixed(1)} -> pred ${r.pred.toFixed(1)} actual ${r.aown.toFixed(1)}`);
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/own-error-nfl.json", JSON.stringify(out, null, 1));
