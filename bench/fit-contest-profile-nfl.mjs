// How does a classic field behave as a function of the contest itself? For every pulled classic
// contest ($20+): the contest's attributes (field size, fee, entry cap, single entry, top-prize
// share) and the field's measured behavior (chalk lift overall and by position, stack mix,
// bring-back, unstacked, salary left, duplication, chalk count, ownership sum). Then a linear fit
// of each behavior on the attributes, so the generator can profile a contest from the lobby
// instead of a three-position slider. Hold-out: fit on 2025, score on 2026.
//   node bench/fit-contest-profile-nfl.mjs   -> data/reports/contest-profile-nfl.json
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
const capOf = name => { const s = String(name); if (/single entry/i.test(s)) return 1; const m = s.match(/(\d+)\s*Entry\s*Max/i) || s.match(/max\s*(\d+)\s*(?:entry|entries)/i); return m ? +m[1] : 150; };
const money = t => { const m = String(t).match(/([\d.]+)\s*([KM]?)/i); return m ? +m[1] * (m[2].toUpperCase() === "K" ? 1e3 : m[2].toUpperCase() === "M" ? 1e6 : 1) : null; };
const topShare = name => { const s = String(name), top = (s.match(/\$\s*([\d.]+\s*[KM]?)\s*to\s*1st/i) || [])[1], all = (s.match(/\$\s*([\d.]+\s*[KM]?)/i) || [])[1]; return top && all ? money(top) / money(all) : null; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const rows = [];
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.players?.length || !j.lineups?.length || c.fee < 20 || /showdown/i.test(c.type + " " + c.name)) continue;
  const P = j.players.filter(p => p.pown > 0 && p.aown != null && p.pos !== "CPT"); if (P.length < 40 || j.lineups.length < 100) continue;
  // chalk lift: best power conc, plus top-bucket ratio, by position group
  const tot = P.reduce((s, p) => s + p.pown, 0); let best = 1, bm = Infinity;
  for (let conc = 0.7; conc <= 1.6; conc += 0.05) { const raw = P.map(p => Math.pow(p.pown, conc)), k = tot / raw.reduce((s, x) => s + x, 0); const mae = mean(P.map((p, i) => Math.abs(raw[i] * k - p.aown))); if (mae < bm) { bm = mae; best = conc; } }
  const lift = g => { const s = P.filter(p => g(p) && p.pown >= 0.2); return s.length >= 3 ? mean(s.map(p => p.aown)) / mean(s.map(p => p.pown)) : null; };
  const byId = new Map(j.players.map(p => [p.id, p])), L = j.lineups; const st = { 1: 0, 2: 0, 3: 0, un: 0, bring: 0, stacked: 0 }; let left = 0, dup = 0, chalk = 0, own = 0, n = 0;
  for (const l of L) { const ps = l.ids.map(id => byId.get(id)).filter(Boolean); if (ps.length < 9) continue; const qb = ps.find(p => p.pos === "QB"); n++; left += 50000 - l.sal; dup += l.dup > 0 ? 1 : 0; chalk += ps.filter(p => (p.aown || 0) >= 0.2).length; own += l.own * 100;
    if (!qb) { st.un++; continue; } const k = ps.filter(p => p !== qb && p.team === qb.team && /^(WR|TE)$/.test(p.pos)).length; if (!k) st.un++; else { st[Math.min(3, k)]++; st.stacked++; if (ps.some(p => p.team === qb.opp && p.pos !== "DST")) st.bring++; } }
  if (!n) continue;
  rows.push({ key: c.key, date: c.date, name: c.name, season: c.date < "2026-06-01" ? 2025 : 2026, N: L.length, fee: c.fee, cap: capOf(c.name), single: capOf(c.name) === 1 ? 1 : 0, top: topShare(c.name),
    conc: +best.toFixed(2), liftAll: lift(() => true), liftQB: lift(p => p.pos === "QB"), liftRB: lift(p => p.pos === "RB"), liftWR: lift(p => p.pos === "WR"), liftTE: lift(p => p.pos === "TE"), liftDST: lift(p => p.pos === "DST"),
    qb1: 100 * st[1] / n, qb2: 100 * st[2] / n, qb3: 100 * st[3] / n, unstacked: 100 * st.un / n, bring: st.stacked ? 100 * st.bring / st.stacked : null, left: left / n, dup: 100 * dup / n, chalk: chalk / n, own: own / n });
}
// features: log10 N, log10 fee, single, log10 cap, top share
const X = r => [1, Math.log10(r.N), Math.log10(r.fee), r.single, Math.log10(r.cap || 150), r.top ?? 0.1];
const FEAT = ["const", "log10 field", "log10 fee", "single entry", "log10 cap", "top share"];
function ols(rows, key) {
  const R = rows.filter(r => r[key] != null && isFinite(r[key])); if (R.length < 20) return null;
  const A = R.map(X), y = R.map(r => r[key]), p = A[0].length, XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
  for (let i = 0; i < A.length; i++) for (let a = 0; a < p; a++) { Xty[a] += A[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += A[i][a] * A[i][b]; }
  for (let a = 0; a < p; a++) XtX[a][a] += 1e-6;
  // gauss-jordan
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < p; c++) { let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-9; for (let k = 0; k <= p; k++) M[c][k] /= d; for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c]; for (let k = 0; k <= p; k++) M[r][k] -= f * M[c][k]; } }
  const beta = M.map(row => row[p]), pred = A.map(a => a.reduce((s, v, i) => s + v * beta[i], 0)), my = mean(y), ssTot = y.reduce((s, v) => s + (v - my) ** 2, 0), ssRes = y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  return { n: R.length, mean: +my.toFixed(3), sd: +Math.sqrt(ssTot / R.length).toFixed(3), r2: +(1 - ssRes / ssTot).toFixed(3), beta: Object.fromEntries(beta.map((b, i) => [FEAT[i], +b.toFixed(4)])) };
}
const TARGETS = ["conc", "liftAll", "liftQB", "liftRB", "liftWR", "liftTE", "liftDST", "qb1", "qb2", "qb3", "unstacked", "bring", "left", "dup", "chalk", "own"];
const fitAll = Object.fromEntries(TARGETS.map(k => [k, ols(rows, k)]));
// hold-out: fit on 2025, score 2026
const tr = rows.filter(r => r.season === 2025), te = rows.filter(r => r.season === 2026), hold = {};
for (const k of TARGETS) { const m = ols(tr, k); if (!m) continue; const T = te.filter(r => r[k] != null && isFinite(r[k])); if (T.length < 10) continue; const pred = T.map(r => X(r).reduce((s, v, i) => s + v * m.beta[FEAT[i]], 0)); const my = mean(T.map(r => r[k])); hold[k] = { n: T.length, maeModel: +mean(T.map((r, i) => Math.abs(r[k] - pred[i]))).toFixed(3), maeMean: +mean(T.map(r => Math.abs(r[k] - my))).toFixed(3) }; }
// buckets by field size and fee for a readable table
const sizeOf = n => n < 300 ? "<300" : n < 1500 ? "300-1.5K" : n < 10000 ? "1.5K-10K" : "10K+", tierOf = f => f < 100 ? "$20-99" : f < 300 ? "$100-299" : "$300+";
const B = {}; for (const r of rows) { const k = `${tierOf(r.fee)} | ${sizeOf(r.N)}`; (B[k] = B[k] || []).push(r); }
const table = Object.entries(B).filter(([, a]) => a.length >= 5).map(([k, a]) => Object.assign({ bucket: k, contests: a.length }, Object.fromEntries(TARGETS.map(t => { const v = mean(a.filter(r => r[t] != null && isFinite(r[t])).map(r => r[t])); return [t, v == null ? null : +v.toFixed(2)]; })))).sort((x, y) => x.bucket.localeCompare(y.bucket));
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/contest-profile-nfl.json", JSON.stringify({ built: new Date().toISOString(), contests: rows.length, features: FEAT, fit: fitAll, holdout: hold, buckets: table, rows }, null, 1));
console.log(`${rows.length} classic contests\n`);
console.log("bucket".padEnd(22) + ["n", "conc", "liftAll", "liftQB", "liftRB", "liftWR", "liftTE", "liftDST", "qb1", "qb2", "qb3", "unst", "bring", "left", "dup", "chalk", "own"].map(s => s.padStart(8)).join(""));
for (const t of table) console.log(t.bucket.padEnd(22) + [t.contests, t.conc, t.liftAll, t.liftQB, t.liftRB, t.liftWR, t.liftTE, t.liftDST, t.qb1, t.qb2, t.qb3, t.unstacked, t.bring, t.left, t.dup, t.chalk, t.own].map(v => String(v).padStart(8)).join(""));
console.log("\nfit on contest attributes (R2) and hold-out 2025->2026 (MAE model vs MAE of just using the mean):");
for (const k of TARGETS) { const m = fitAll[k], h = hold[k]; if (!m) continue; const sig = Object.entries(m.beta).filter(([f]) => f !== "const").map(([f, b]) => `${f} ${b > 0 ? "+" : ""}${b}`).join(", "); console.log(`${k.padEnd(10)} mean ${String(m.mean).padStart(7)} sd ${String(m.sd).padStart(6)}  R2 ${String(m.r2).padStart(6)}  ${h ? `holdout ${h.maeModel} vs ${h.maeMean} (${h.n})` : "".padEnd(22)}  | ${sig}`); }
