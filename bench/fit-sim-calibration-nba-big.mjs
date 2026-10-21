// Big-field (1,000+ entries) NBA classic sim calibration, on top of bench/fit-sim-calibration-nba.mjs. Rows from bench/grade-all.mjs
// --rows --fkey=nba_cl --minentries=1000 (any fee). Fits the ROI shrink by field-size band, as s = a + b*log10(N), and by slate size;
// win / top-1% / top-10% exponents for the big fields; then holds out by date halves and odd/even dates, both directions, against the
// current CALIB.nba_cl (roi 0.7 on 5+ games, raw under 5; win 0.19; top-1% raw) and against raw.
//   node bench/fit-sim-calibration-nba-big.mjs --json=data/reports/nba/calibration-nba-big.json --seed2=<s2.jsonl> <s1.jsonl>
import fs from "node:fs";
import { CALIB } from "../src/engine/sim.mjs";

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const files = process.argv.slice(2).filter(a => !a.startsWith("--")), files2 = arg("seed2") ? arg("seed2").split(",") : [], JSON_OUT = arg("json"), MINN = +(arg("minn") || 1000), UNTIL = arg("until") || "2026-08-01";
const CUR = CALIB.nba_cl, EV = { win: ["win", "won"], top1: ["t1", "top1"], top10: ["t10", "top10"] };
const load = fs_ => { const byC = new Map(); for (const f of fs_) for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line) continue; const r = JSON.parse(line); if (r.finish == null || r.t1 == null || r.fkey !== "nba_cl" || r.N < MINN || r.date >= UNTIL) continue;
  (byC.get(r.c) || byC.set(r.c, []).get(r.c)).push({ c: r.c, date: r.date, N: r.N, games: r.games, roi: r.roi, actROI: r.actROI, win: r.win, t1: r.t1, t10: r.t10, won: r.won, top1: r.top1, top10: r.top10 }); } return byC; };
const C1 = load(files), C2 = files2.length ? load(files2) : null, keys = [...C1.keys()].filter(k => !C2 || C2.has(k)).sort();
const info = k => C1.get(k)[0];
// per contest: mean payout m, and the contest-averaged moments of x = pred - m, y = act - m
const stats = C => { const o = {}; for (const k of keys) { const rs = C.get(k), m = rs.reduce((s, r) => s + 1 + r.roi / 100, 0) / rs.length; let sxy = 0, sxx = 0, syy = 0;
  for (const r of rs) { const x = 1 + r.roi / 100 - m, y = 1 + r.actROI / 100 - m; sxy += x * y; sxx += x * x; syy += y * y; } const n = rs.length; o[k] = { sxy: sxy / n, sxx: sxx / n, syy: syy / n, m, rs, ...info(k), lN: Math.log10(info(k).N) }; } return o; };
const S1 = stats(C1), S2 = C2 ? stats(C2) : null;
const slope = (S, ks) => { let a = 0, b = 0; for (const k of ks) { a += S[k].sxy; b += S[k].sxx; } return b ? a / b : NaN; };
// s = a + b*log10(N): minimize sum_k E[(y - s_k x)^2] -> 2x2 normal equations
const logFit = (S, ks) => { let A = 0, B = 0, D = 0, u = 0, v = 0; for (const k of ks) { const q = S[k], l = q.lN - 3.5; A += q.sxx; B += q.sxx * l; D += q.sxx * l * l; u += q.sxy; v += q.sxy * l; } const det = A * D - B * B; return { a: (u * D - v * B) / det, b: (A * v - B * u) / det, ref: 3.5 }; };
const sOf = (fit, q) => typeof fit === "number" ? fit : fit.a + fit.b * (q.lN - fit.ref);
const curS = q => CUR.roiMinGames && q.games < CUR.roiMinGames ? 1 : CUR.roi;
// held-out loss: contest-averaged E[(y - s x)^2]
const mse = (S, ks, sf) => { let e = 0; for (const k of ks) { const q = S[k], s = sf(q); e += q.syy - 2 * s * q.sxy + s * s * q.sxx; } return e / ks.length; };
let seed = 7; const rnd = () => (seed = ((Math.imul(seed, 1103515245) + 12345) >>> 0) % 2147483648) / 2147483648;
const bootCI = (S, ks, reps = 400) => { const byD = {}; for (const k of ks) (byD[S[k].date] = byD[S[k].date] || []).push(k); const ds = Object.values(byD), out = [];
  for (let b = 0; b < reps; b++) { const pick = []; for (let i = 0; i < ds.length; i++) pick.push(...ds[Math.floor(rnd() * ds.length)]); out.push(slope(S, pick)); } out.sort((x, y) => x - y); return [+out[Math.floor(reps * 0.05)].toFixed(2), +out[Math.floor(reps * 0.95)].toFixed(2)]; };
const base = (q, ev) => ev === "win" ? 1 / q.N : ev === "top1" ? Math.max(1, Math.round(q.N * 0.01)) / q.N : Math.max(1, Math.round(q.N * 0.1)) / q.N;
const ll = (S, ks, ev, b) => { const [pk, ak] = EV[ev]; let s = 0, n = 0; for (const k of ks) { const q = S[k], bs = base(q, ev); let c = 0; for (const r of q.rs) { const p = Math.min(0.999, Math.max(1e-7, bs * Math.pow(Math.max(1e-7, r[pk] / 100) / bs, b))); c += r[ak] ? Math.log(p) : Math.log(1 - p); } s += c / q.rs.length; n++; } return s / n; };
const fitB = (S, ks, ev) => { let best = 1, bl = -Infinity; for (let b = 0; b <= 1.5001; b += 0.02) { const v = ll(S, ks, ev, b); if (v > bl) { bl = v; best = b; } } return +best.toFixed(2); };
const predAct = (S, ks, ev, b) => { const [pk, ak] = EV[ev]; let p = 0, a = 0, n = 0; for (const k of ks) { const q = S[k], bs = base(q, ev); for (const r of q.rs) { p += Math.min(1, bs * Math.pow(Math.max(1e-7, r[pk] / 100) / bs, b)); a += r[ak]; n++; } } return { pred: +(100 * p / n).toFixed(3), act: +(100 * a / n).toFixed(3) }; };
// sim top 10% by ROI per contest: predicted (raw / current / candidate) vs realised ROI
const topDec = (S, ks, sf) => { let p0 = 0, pc = 0, p1 = 0, a = 0, n = 0; for (const k of ks) { const q = S[k], top = [...q.rs].sort((x, y) => y.roi - x.roi).slice(0, Math.max(1, Math.round(q.rs.length * 0.1)));
  for (const r of top) { const x = 1 + r.roi / 100 - q.m; p0 += r.roi; pc += (q.m + curS(q) * x - 1) * 100; p1 += (q.m + sf(q) * x - 1) * 100; a += r.actROI; n++; } } return { n, raw: +(p0 / n).toFixed(1), cur: +(pc / n).toFixed(1), cand: +(p1 / n).toFixed(1), act: +(a / n).toFixed(1) }; };

const bands = [["1000-1999", q => q.N < 2000], ["2000-4999", q => q.N >= 2000 && q.N < 5000], ["5000+", q => q.N >= 5000]];
const slates = [["2-4 games", q => q.games <= 4], ["5-7 games", q => q.games >= 5 && q.games <= 7], ["8+ games", q => q.games >= 8]];
const dates = [...new Set(keys.map(k => S1[k].date))].sort(), half = dates[Math.floor(dates.length / 2)];
const rep = { contests: keys.length, entries: keys.reduce((s, k) => s + S1[k].rs.length, 0), dates: dates.length, from: dates[0], to: dates[dates.length - 1], split: half, minN: MINN, current: CUR };
const g5 = keys.filter(k => S1[k].games >= 5), g4 = keys.filter(k => S1[k].games < 5);
rep.all = { s: +slope(S1, keys).toFixed(3), ci: bootCI(S1, keys), seed2: S2 ? +slope(S2, keys).toFixed(3) : null, games5: +slope(S1, g5).toFixed(3), games5Seed2: S2 ? +slope(S2, g5).toFixed(3) : null, games4: +slope(S1, g4).toFixed(3), games4Seed2: S2 ? +slope(S2, g4).toFixed(3) : null, n5: g5.length, n4: g4.length,
  log: (f => ({ a: +f.a.toFixed(3), b: +f.b.toFixed(3) }))(logFit(S1, g5)), logSeed2: S2 ? (f => ({ a: +f.a.toFixed(3), b: +f.b.toFixed(3) }))(logFit(S2, g5)) : null };
for (const ev of Object.keys(EV)) { rep.all[ev] = fitB(S1, keys, ev); if (S2) rep.all[ev + "Seed2"] = fitB(S2, keys, ev); }
console.log(`${keys.length} NBA classic contests ${MINN}+ entries, ${rep.entries} entries, ${dates.length} dates (${dates[0]} - ${dates[dates.length - 1]})`);
console.log(`ROI shrink all ${rep.all.s} [90% ${rep.all.ci.join("-")}] seed2 ${rep.all.seed2} | 5+ games (${g5.length}) ${rep.all.games5} / ${rep.all.games5Seed2} | 2-4 games (${g4.length}) ${rep.all.games4} / ${rep.all.games4Seed2}`);
console.log(`log fit on 5+ games: s = ${rep.all.log.a} + ${rep.all.log.b}*(log10 N - 3.5) | seed2 ${JSON.stringify(rep.all.logSeed2)} | b win ${rep.all.win}/${rep.all.winSeed2} top1 ${rep.all.top1}/${rep.all.top1Seed2} top10 ${rep.all.top10}/${rep.all.top10Seed2}`);
for (const [gname, list] of [["by_field", bands], ["by_slate", slates]]) { rep[gname] = {}; for (const [lab, f] of list) { const ks = keys.filter(k => f(S1[k])); if (!ks.length) continue; const h = [ks.filter(k => S1[k].date < half), ks.filter(k => S1[k].date >= half)];
  const o = rep[gname][lab] = { contests: ks.length, s: +slope(S1, ks).toFixed(3), ci: ks.length > 3 ? bootCI(S1, ks) : null, seed2: S2 ? +slope(S2, ks).toFixed(3) : null, halves: h.map(x => x.length ? +slope(S1, x).toFixed(3) : null), win: fitB(S1, ks, "win"), winSeed2: S2 ? fitB(S2, ks, "win") : null, top1: fitB(S1, ks, "top1"), top1Seed2: S2 ? fitB(S2, ks, "top1") : null };
  if (gname === "by_field") { const k5 = ks.filter(k => S1[k].games >= 5); o.games5 = { contests: k5.length, s: +slope(S1, k5).toFixed(3), seed2: S2 ? +slope(S2, k5).toFixed(3) : null }; }
  console.log(`  ${lab.padEnd(10)} ${String(ks.length).padStart(3)}: ROI s ${o.s} [${o.ci}] seed2 ${o.seed2} halves ${o.halves.join(" / ")}${o.games5 ? ` | 5+ games ${o.games5.contests}: ${o.games5.s} / ${o.games5.seed2}` : ""} | win b ${o.win}/${o.winSeed2} top1 b ${o.top1}/${o.top1Seed2}`); } }

// held out: candidates fitted on one half, scored on the other (relative to raw and to the current calibration), both seeds
const splits = { "date halves": [keys.filter(k => S1[k].date < half), keys.filter(k => S1[k].date >= half)], "odd/even dates": [keys.filter(k => dates.indexOf(S1[k].date) % 2 === 0), keys.filter(k => dates.indexOf(S1[k].date) % 2 === 1)] };
rep.heldOut = [];
const tally = {};
for (const [seedLab, S] of [["s1", S1], ["s2", S2]]) { if (!S) continue; for (const [name, [A, B]] of Object.entries(splits)) for (const [dir, tr, te] of [["A->B", A, B], ["B->A", B, A]]) {
  const tr5 = tr.filter(k => S[k].games >= 5), flat5 = slope(S, tr5), lf = logFit(S, tr5), flatAll = slope(S, tr), band = {}; for (const [lab, f] of bands) band[lab] = slope(S, tr5.filter(k => f(S[k])));
  const bandOf = q => { const l = bands.find(([, f]) => f(q))[0]; return isFinite(band[l]) ? band[l] : flat5; };
  const g4raw = f => q => q.games < 5 ? 1 : f(q);   // 2-4 game slates kept raw as today
  const cands = { raw: () => 1, current: curS, "flat 5+": g4raw(() => flat5), "flat all": () => flatAll, "log N 5+": g4raw(q => sOf(lf, q)), "bands 5+": g4raw(bandOf) };
  const e = {}; for (const [c, sf] of Object.entries(cands)) e[c] = mse(S, te, sf);
  const rel = Object.fromEntries(Object.entries(e).map(([c, v]) => [c, +(100 * (v / e.raw - 1)).toFixed(4)]));
  const best = Object.entries(e).sort((x, y) => x[1] - y[1])[0][0]; tally[best] = (tally[best] || 0) + 1;
  const te5 = te.filter(k => S[k].games >= 5);
  const pr = {}; for (const ev of ["win", "top1"]) { const b = fitB(S, tr, ev), curB = CUR[ev === "top1" ? "t1" : ev] ?? 1, l0 = ll(S, te, ev, 1), lc = ll(S, te, ev, curB), l1 = ll(S, te, ev, b);
    pr[ev] = { b, curB, llVsRawPct: +(100 * (l1 / l0 - 1)).toFixed(3), curVsRawPct: +(100 * (lc / l0 - 1)).toFixed(3), candVsCurPct: +(100 * (l1 / lc - 1)).toFixed(3), raw: predAct(S, te, ev, 1), cur: predAct(S, te, ev, curB), cand: predAct(S, te, ev, b) }; }
  const row = { seed: seedLab, split: name, dir, fit: tr.length, test: te.length, flat5: +flat5.toFixed(3), log: { a: +lf.a.toFixed(3), b: +lf.b.toFixed(3) }, bands: Object.fromEntries(Object.entries(band).map(([k, v]) => [k, isFinite(v) ? +v.toFixed(3) : null])), mseVsRawPct: rel, best, topDecile5: topDec(S, te5, g4raw(() => flat5)), prob: pr };
  rep.heldOut.push(row);
  console.log(`\n${seedLab} ${name} ${dir}: fit ${tr.length} -> test ${te.length} | flat5 ${row.flat5} log ${row.log.a}+${row.log.b}L bands ${JSON.stringify(row.bands)}`);
  console.log(`  payout MSE vs raw %: ${Object.entries(rel).map(([c, v]) => `${c} ${v}`).join(", ")} | best ${best}`);
  console.log(`  sim top-10% (5+ games): raw ${row.topDecile5.raw}% current ${row.topDecile5.cur}% flat5 ${row.topDecile5.cand}% actual ${row.topDecile5.act}%`);
  for (const ev of ["win", "top1"]) { const p = pr[ev]; console.log(`  ${ev.padEnd(4)} b ${p.b} (current ${p.curB}) log loss vs raw ${p.llVsRawPct}% (current ${p.curVsRawPct}%), vs current ${p.candVsCurPct}% | pred raw ${p.raw.pred}% cur ${p.cur.pred}% cand ${p.cand.pred}% actual ${p.raw.act}%`); }
} }
rep.bestCount = tally; console.log("\nbest held-out candidate count: " + JSON.stringify(tally));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rep, null, 1));
