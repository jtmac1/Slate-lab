// NBA classic duplicate risk: fit a Poisson model of copies (other identical entries) on real 2025-26 NBA classic fields, odd
// dates fit / even dates held out (date index parity, as bench/compare-rows-nba.mjs), calibration by decile of the prediction,
// overall and by slate size. Then grade: on per-entry rows of a grade run (bench/grade-all.mjs --rows), does picking the sim top
// decile by dupe-adjusted ROI (src/engine/nba-dupes.mjs) beat plain sim ROI on realized ROI / top 1% / top 10%?
//   node bench/fit-dupes-nba.mjs [--runs=data/reports/nba/sc/D-s1,data/reports/nba/sc/D-s2]
//   -> data/reports/nba/dupes-nba.json + dupes-nba.txt
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { listPost, readPost } from "./post-store.mjs";
import { loadPulled } from "./grade-all.mjs";
import { dupeFeatures, expectedCopies, payoutSplitter, dupeAdjROI } from "../src/engine/nba-dupes.mjs";
import { compare, printCompare, bucketOf } from "./compare-rows-nba.mjs";

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const RUNS = (arg("runs") || "data/reports/nba/sc/D-s1,data/reports/nba/sc/D-s2").split(",");
const sizeOf = g => g <= 4 ? "2-4" : g <= 7 ? "5-7" : "8+", mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const T0 = Date.now(), log = [], say = s => { console.log(s); log.push(s); };

// 1. lineup features + copies from every NBA classic contest
const C = [];
for (const file of listPost("nba")) {
  const j = readPost(file), c = j.contest; if (/showdown/i.test(c.type) || !j.lineups?.length || j.lineups.length < 50) continue;
  const byId = new Map(); for (const p of j.players) if (!byId.has(p.id)) byId.set(p.id, p);
  const games = new Set(j.players.filter(p => p.team && p.opp).map(p => [p.team, p.opp].sort().join("@"))).size, N = j.lineups.length;
  const L = []; for (const l of j.lineups) { const ps = l.ids.map(id => byId.get(id)); if (ps.length !== 8 || ps.some(p => !p)) continue;
    L.push({ u: l.u, fin: l.fin, dup: l.dup || 0, op: ps.reduce((s, p) => s * Math.max(0.001, p.pown || 0), 1), proj: ps.reduce((s, p) => s + (p.proj || 0), 0), sal: l.sal }); }
  if (L.length < 50) continue;
  const best = Math.max(...L.map(l => l.proj)); for (const l of L) l.x = dupeFeatures({ ownProd: l.op, proj: l.proj, bestProj: best, sal: l.sal, games, N, fee: c.fee });
  C.push({ file, dir: "post/nba/" + path.basename(file).replace(/\.json(\.gz)?$/, ""), date: c.date, fee: c.fee, N, games, L });
}
const dates = [...new Set(C.map(c => c.date))].sort(), di = new Map(dates.map((d, i) => [d, i]));
for (const c of C) c.half = di.get(c.date) % 2 === 1 ? "fit" : "hold";
say(`${C.length} NBA classic contests, ${C.reduce((s, c) => s + c.L.length, 0)} lineups, ${((Date.now() - T0) / 1000).toFixed(0)}s`);

// 2. Poisson regression by Newton (IRLS) with a small ridge
function fitPoisson(rows) {
  const K = rows[0].x.length; let b = new Float64Array(K); b[0] = Math.log(mean(rows.map(r => r.dup)) + 1e-6);
  for (let it = 0; it < 30; it++) {
    const g = new Float64Array(K), H = Array.from({ length: K }, () => new Float64Array(K));
    for (const r of rows) { let z = 0; for (let k = 0; k < K; k++) z += b[k] * r.x[k]; const mu = Math.exp(Math.min(8, z)), e = r.dup - mu;
      for (let k = 0; k < K; k++) { g[k] += e * r.x[k]; const hk = mu * r.x[k]; for (let m = k; m < K; m++) H[k][m] += hk * r.x[m]; } }
    for (let k = 0; k < K; k++) { H[k][k] += 1e-3 * rows.length / 1000; for (let m = 0; m < k; m++) H[k][m] = H[m][k]; }
    const d = solve(H, g); let mx = 0; for (let k = 0; k < K; k++) { b[k] += d[k]; mx = Math.max(mx, Math.abs(d[k])); } if (mx < 1e-7) break;
  }
  return Array.from(b, v => +v.toFixed(5));
}
function solve(A, y) { const n = y.length, M = A.map((r, i) => [...r, y[i]]);
  for (let i = 0; i < n; i++) { let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r; [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let k = i; k <= n; k++) M[r][k] -= f * M[i][k]; } }
  return M.map((r, i) => r[n] / r[i]); }

const rowsOf = h => C.filter(c => h === "all" || c.half === h).flatMap(c => c.L.map(l => (l.g = c.games, l)));
const coefFit = fitPoisson(rowsOf("fit")), coefAll = fitPoisson(rowsOf("all"));
say(`features: [1, lx, lx^2, lg=log1p(gap), salLeft/1K, small, medium, logN, logFee, lx*small, lx*medium, lg*small, lg*medium]\ncoef (odd-date fit): ${JSON.stringify(coefFit)}\ncoef (all dates):    ${JSON.stringify(coefAll)}`);

// 3. held-out calibration by decile of the prediction, overall and by slate size
function calib(coef, h) {
  const out = {};
  for (const s of ["all", "2-4", "5-7", "8+"]) {
    const R = C.filter(c => c.half === h && (s === "all" || sizeOf(c.games) === s)).flatMap(c => c.L).map(l => [expectedCopies(l.x, coef), l.dup]); if (!R.length) continue;
    R.sort((a, b) => a[0] - b[0]); const dec = [];
    for (let d = 0; d < 10; d++) { const sl = R.slice(Math.floor(d * R.length / 10), Math.floor((d + 1) * R.length / 10)); dec.push({ d: d + 1, n: sl.length, pred: +mean(sl.map(r => r[0])).toFixed(3), real: +mean(sl.map(r => r[1])).toFixed(3), pAny: +mean(sl.map(r => r[1] > 0 ? 1 : 0)).toFixed(3) }); }
    const top = R.slice(Math.floor(0.99 * R.length)); dec.push({ d: "top1%", n: top.length, pred: +mean(top.map(r => r[0])).toFixed(3), real: +mean(top.map(r => r[1])).toFixed(3), pAny: +mean(top.map(r => r[1] > 0 ? 1 : 0)).toFixed(3) });
    // Spearman-free summary: Poisson deviance vs a constant-mean model
    const m0 = mean(R.map(r => r[1])), dev = (mu, y) => 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));
    out[s] = { n: R.length, meanPred: +mean(R.map(r => r[0])).toFixed(3), meanReal: +m0.toFixed(3), devRed: +(1 - R.reduce((a, r) => a + dev(Math.max(1e-6, r[0]), r[1]), 0) / R.reduce((a, r) => a + dev(Math.max(1e-6, m0), r[1]), 0)).toFixed(3), deciles: dec };
  }
  return out;
}
const cal = calib(coefFit, "hold");
say(`\nheld-out (even dates) calibration, odd-date coefficients: pred vs real mean copies by decile of prediction`);
for (const [s, r] of Object.entries(cal)) say(`  ${s.padEnd(4)} n ${r.n}  mean pred ${r.meanPred} real ${r.meanReal}  deviance explained ${(100 * r.devRed).toFixed(1)}%\n       ` + r.deciles.map(d => `${d.d}: ${d.pred}/${d.real}`).join("  "));

// 4. grade: top decile by sim ROI vs by dupe-adjusted ROI, on per-entry rows of a grade run (odd-date coefficients)
const byDir = new Map(C.map(c => [c.dir, c]));
async function gradeRun(prefix) {
  const by = new Map(), rl = readline.createInterface({ input: fs.createReadStream(prefix + ".jsonl"), crlfDelay: Infinity });
  for await (const line of rl) { if (!line) continue; const r = JSON.parse(line); if (r.fkey !== "nba_cl" || !byDir.has(r.c)) continue;
    let c = by.get(r.c); if (!c) by.set(r.c, c = []); c.push({ u: r.user, fin: r.finish, roi: r.roi, win: r.win, t1: r.t1, t10: r.t10, cash: r.cash, top10: r.top10, top1: r.top1, act: r.actROI, N: r.N, fee: r.fee }); }
  const A = new Map(), B = new Map(), cop = [];
  for (const [dir, rows] of by) {
    const c = byDir.get(dir), fx = new Map(c.L.map(l => [l.u + "|" + l.fin, l])), pay = loadPulled(c.file).payouts, split = payoutSplitter(Array.from(pay)), N = rows[0].N, fee = rows[0].fee;
    for (const r of rows) { const l = fx.get(r.u + "|" + r.fin); r.cp = l ? expectedCopies(l.x, coefFit) : 0; r.adj = dupeAdjROI(r, r.cp, split, N, fee); r.dup = l ? l.dup : 0; }
    const k = Math.max(3, Math.round(rows.length * 0.1)), top = key => rows.map((r, i) => i).sort((a, b) => rows[b][key] - rows[a][key] || a - b).slice(0, k);
    const summ = idx => { const m = f => idx.reduce((s, i) => s + f(rows[i]), 0) / k; return { c: dir, date: c.date, games: c.games, n: rows.length, sp: 0, t10: m(r => r.top10), t1: m(r => r.top1), roi: m(r => r.act), cp: m(r => r.cp), dup: m(r => r.dup) }; };
    const a = summ(top("roi")), b = summ(top("adj")); A.set(dir, a); B.set(dir, b); cop.push([a.cp, b.cp, a.dup, b.dup, c.games]);
  }
  return { A, B, cop };
}
const runs = [];
for (const p of RUNS) { if (!fs.existsSync(p + ".jsonl")) { say(`missing ${p}.jsonl`); continue; } runs.push({ p, ...(await gradeRun(p)) }); say(`graded ${p}: ${runs.at(-1).A.size} contests, ${((Date.now() - T0) / 1000).toFixed(0)}s`); }
const grades = {};
for (const [i, r] of runs.entries()) {
  const other = runs[1 - i], res = compare(r.A, r.B, other ? other.A : null);
  grades[path.basename(r.p)] = res;
  say(`\n=== ${path.basename(r.p)}: A = sim top decile by Sim ROI, B = by dupe-adjusted ROI${other ? `; seed noise = ${path.basename(other.p)} plain - ${path.basename(r.p)} plain` : ""} ===`);
  say(printCompare(res, "simROI", "dupeAdj").split("\n").filter(l => !l.includes("rank Spearman")).join("\n"));
  for (const s of ["all", "2-4", "5-7", "8+"]) { const q = r.cop.filter(x => s === "all" || sizeOf(x[4]) === s); say(`  top-decile copies (${s}): predicted ${mean(q.map(x => x[0])).toFixed(2)} -> ${mean(q.map(x => x[1])).toFixed(2)}, real ${mean(q.map(x => x[2])).toFixed(2)} -> ${mean(q.map(x => x[3])).toFixed(2)}`); }
}
fs.mkdirSync("data/reports/nba", { recursive: true });
fs.writeFileSync("data/reports/nba/dupes-nba.json", JSON.stringify({ built: new Date().toISOString(), contests: C.length, features: ["1", "lx=log(N*prod own)", "lx^2", "log1p(gap to best field proj)", "salLeft/1000", "games 2-4", "games 5-7", "log N", "log fee", "lx*small", "lx*medium", "lg*small", "lg*medium"], coefFit, coefAll, calibration: cal, grades }, null, 1));
fs.writeFileSync("data/reports/nba/dupes-nba.txt", log.join("\n") + "\n");
say(`\n-> data/reports/nba/dupes-nba.json + .txt, ${((Date.now() - T0) / 1000).toFixed(0)}s`);
