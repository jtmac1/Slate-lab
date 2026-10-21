// Contest picker backtest: which pre-lock contest features predict what skilled players earn there?
// Walks the classic NFL archive in date order. For each contest, every feature uses only what was knowable
// before lock: structure (rake, field size, max entries, payout shape) and the field's entrants scored on
// their record in EARLIER contests (top-10% rate persists year to year, ROI does not - pro-plan study).
// Outcome: ROI of "proven" users in that contest (30+ earlier entries, earlier top-10% rate >= 13%), plus
// the skill premium (proven minus everyone else). Prints each feature by quartile and a 2025-fit / 2026-test
// linear score.
//   node bench/contest-picker-nfl.mjs [--from=2025-10-01] [--minfee=5] [--cap=20] [--out=data/reports/contest-picker-nfl.json]
import fs from "node:fs";
import { listContests } from "./grade-all.mjs";
import { readPost } from "./post-store.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const FROM = arg("from", "2025-10-01"), MINFEE = +arg("minfee", 5), CAPROI = +arg("cap", 20), OUT = arg("out", "data/reports/contest-picker-nfl.json");
const MIN_PRIOR = 30, PROVEN = 0.13, WEAK = 0.09;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN, se = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : NaN;
const roiCap = r => Math.min(r, CAPROI);

const list = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl").sort((a, b) => a.date.localeCompare(b.date));
console.error(`${list.length} classic contests in the archive`);
const user = new Map(), rows = [];
const prior = u => user.get(u) || { n: 0, t10: 0, fee: 0, won: 0 };
for (let i = 0; i < list.length;) {
  const date = list[i].date, day = []; while (i < list.length && list[i].date === date) day.push(list[i++]);
  const loaded = day.map(c => { const j = readPost(c.json); return { c, j }; });
  // features + outcomes from records strictly before this date
  for (const { c, j } of loaded) {
    const L = j.lineups, N = L.length, fee = j.contest.fee; if (N < 100 || fee < MINFEE || date < FROM) continue;
    const pays = L.map(l => fee * (1 + (l.aroi ?? -1))).filter(p => p > 0.01).sort((a, b) => b - a), pool = pays.reduce((s, x) => s + x, 0);
    if (!pays.length) continue;
    const per = {}; for (const l of L) { const u = l.u.toLowerCase(); per[u] = (per[u] || 0) + 1; }
    const nm = j.contest.name || "", capName = /single entry/i.test(nm) ? 1 : +((nm.match(/(\d+)[- ]entry max/i) || [])[1] || 0), cap = Math.max(capName, ...Object.values(per));
    let unknown = 0, weak = 0, proven = 0, provenVol = 0;
    for (const [u, n] of Object.entries(per)) { const p = prior(u); if (p.n < MIN_PRIOR) unknown += n; else { const r = p.t10 / p.n; if (r < WEAK) weak += n; if (r >= PROVEN) { proven += n; provenVol = Math.max(provenVol, n); } } }
    const known = N - unknown, isProven = u => { const p = prior(u); return p.n >= MIN_PRIOR && p.t10 / p.n >= PROVEN; };
    const pr = L.filter(l => isProven(l.u.toLowerCase())).map(l => roiCap(l.aroi ?? -1)), rest = L.filter(l => !isProven(l.u.toLowerCase())).map(l => roiCap(l.aroi ?? -1));
    // the public contest page's first 99 entrants (bench/dk-entrants.mjs), scored the same way: what the picker sees before lock
    const ef = `data/dk-entrants/${c.dir.split("-").pop()}.json`, S = fs.existsSync(ef) ? JSON.parse(fs.readFileSync(ef, "utf8")).users : null;
    let sUnknown = null, sProven = null, sBadge5 = null, sEpu = null;
    if (S && S.length) { const tot = S.reduce((t, x) => t + x.n, 0); let un = 0, pv = 0; for (const x of S) { const p = prior(x.u); if (p.n < MIN_PRIOR) un += x.n; else if (p.t10 / p.n >= PROVEN) pv += x.n; }
      sUnknown = un / tot; sProven = pv / tot; sBadge5 = S.filter(x => x.badge >= 5).length / S.length; sEpu = tot / S.length; }
    rows.push({ dir: c.dir, sUnknown, sProven, sBadge5, sEpu, date, name: nm, fee, N, cap, users: Object.keys(per).length,
      rake: 1 - pool / (fee * N), toFirst: pays[0] / pool, tenth: (pays[9] || 0) / pays[0], minCash: pays[pays.length - 1] / fee, paid: pays.length / N,
      unknown: unknown / N, soft: known ? weak / known : null, shark: known ? proven / known : null, epu: N / Object.keys(per).length,
      provN: pr.length, provROI: pr.length ? mean(pr) : null, restROI: mean(rest), premium: pr.length ? mean(pr) - mean(rest) : null,
      mine: (j.contest.mine || []).map(m => m.won / fee - 1) });
  }
  // then add this date's results to the user records
  for (const { j } of loaded) { const N = j.lineups.length, fee = j.contest.fee; for (const l of j.lineups) { const u = l.u.toLowerCase(), p = user.get(u) || { n: 0, t10: 0, fee: 0, won: 0 }; p.n++; p.t10 += l.fin <= N * 0.1; p.fee += fee; p.won += fee * (1 + (l.aroi ?? -1)); user.set(u, p); } }
}
console.error(`${rows.length} contests scored (fee >= $${MINFEE}, from ${FROM}), ${user.size} users`);

// each feature by quartile: proven-user ROI (entry-weighted across contests), premium, n
const feats = { rake: "rake", N: "field size", cap: "max entries", fee: "entry fee", toFirst: "% to 1st", tenth: "10th / 1st", minCash: "min cash x fee", unknown: "unknown entrants", soft: "softness (weak share)", shark: "shark share (proven)", epu: "entries per user", sUnknown: "SAMPLE unknown share (first 99)", sProven: "SAMPLE proven share", sBadge5: "SAMPLE DK badge-5 share" };
const report = {};
const useRows = rows.filter(r => r.provN >= 3);
const wROI = rs => { let s = 0, n = 0; for (const r of rs) { s += r.provROI * r.provN; n += r.provN; } return s / n; };
console.log(`\n${useRows.length} contests with 3+ proven entries. Proven-user ROI (capped at +${CAPROI * 100}% per lineup), entry-weighted; premium = proven minus the rest, contest mean.`);
for (const [k, label] of Object.entries(feats)) {
  const R = useRows.filter(r => r[k] != null).sort((a, b) => a[k] - b[k]), q = Math.floor(R.length / 4), out = [];
  for (let b = 0; b < 4; b++) { const s = R.slice(b * q, b === 3 ? R.length : (b + 1) * q); out.push({ lo: s[0][k], hi: s[s.length - 1][k], n: s.length, provROI: wROI(s), premium: mean(s.map(r => r.premium)), premSE: se(s.map(r => r.premium)) }); }
  report[k] = out;
  const fmt = v => k === "N" || k === "cap" || k === "fee" ? (+v).toFixed(0) : k === "epu" || k === "minCash" ? (+v).toFixed(2) : (100 * v).toFixed(1) + "%";
  console.log(`\n${label}`); for (const [b, o] of out.entries()) console.log(`  Q${b + 1} ${fmt(o.lo).padStart(7)} - ${fmt(o.hi).padEnd(7)} proven ROI ${(100 * o.provROI).toFixed(1).padStart(6)}%  premium ${(100 * o.premium).toFixed(1).padStart(6)} ±${(100 * o.premSE).toFixed(1)}  (${o.n})`);
}

// combined linear score on standardized features, fit on 2025, tested on 2026 (target: contest premium)
const X = ["rake", "N", "cap", "toFirst", "tenth", "unknown", "soft", "shark", "epu"], tf = { N: Math.log, cap: Math.log, epu: Math.log };
const val = (r, k) => (tf[k] || (x => x))(r[k]);
const train = useRows.filter(r => r.date < "2026-06-01" && r.soft != null), test = useRows.filter(r => r.date >= "2026-06-01" && r.soft != null);
const mu = {}, sd = {}; for (const k of X) { const v = train.map(r => val(r, k)); mu[k] = mean(v); sd[k] = Math.sqrt(mean(v.map(x => (x - mu[k]) ** 2))) || 1; }
const Z = r => X.map(k => (val(r, k) - mu[k]) / sd[k]);
// ridge least squares, weighted by proven entries
const m = X.length + 1, A = Array.from({ length: m }, () => new Float64Array(m + 1));
for (const r of train) { const z = [1, ...Z(r)], w = Math.sqrt(r.provN); for (let a = 0; a < m; a++) { A[a][m] += w * z[a] * r.premium; for (let b = 0; b < m; b++) A[a][b] += w * z[a] * z[b]; } }
for (let a = 1; a < m; a++) A[a][a] += 5;
for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; const d = A[c][c]; for (let k = c; k <= m; k++) A[c][k] /= d; for (let r = 0; r < m; r++) if (r !== c) { const f = A[r][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
const beta = A.map(row => row[m]), score = r => [1, ...Z(r)].reduce((s, z, i) => s + z * beta[i], 0);
console.log(`\nlinear score (fit 2025: ${train.length} contests, test 2026: ${test.length}); coefficients per 1 SD:`);
X.forEach((k, i) => console.log(`  ${k.padEnd(8)} ${(100 * beta[i + 1]).toFixed(1)}`));
const half = (R, lab) => { const s = R.slice().sort((a, b) => score(b) - score(a)), h = Math.floor(s.length / 2), top = s.slice(0, h), bot = s.slice(h);
  console.log(`  ${lab}: top half by score proven ROI ${(100 * wROI(top)).toFixed(1)}% premium ${(100 * mean(top.map(r => r.premium))).toFixed(1)} | bottom half ${(100 * wROI(bot)).toFixed(1)}% premium ${(100 * mean(bot.map(r => r.premium))).toFixed(1)}`); };
half(train, "2025 (in sample)"); half(test, "2026 (out of sample)");
// his own entries by score half (all seasons; score fit on 2025)
const mineRows = useRows.filter(r => r.mine.length && r.soft != null).sort((a, b) => score(b) - score(a)), mh = Math.floor(mineRows.length / 2);
const mineROI = R => { const v = R.flatMap(r => r.mine); return `${(100 * mean(v)).toFixed(0)}% on ${v.length} entries`; };
if (mineRows.length) console.log(`  jtmac1999: top half ${mineROI(mineRows.slice(0, mh))} | bottom half ${mineROI(mineRows.slice(mh))}`);
fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), args: { FROM, MINFEE, CAPROI, MIN_PRIOR, PROVEN, WEAK }, report, beta: Object.fromEntries(X.map((k, i) => [k, beta[i + 1]])), mu, sd, rows }, null, 1));
console.log(`\n-> ${OUT}`);
