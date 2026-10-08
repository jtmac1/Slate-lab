// Are the sim's probabilities right? Every real NFL entry is simmed against its real contest (bench/grade-all.mjs
// --rows), and its predicted win / top-1% / top-10% / cash chance is compared with what actually happened:
// reliability by predicted-probability bucket, Brier score, and predicted/realised ratio, per format, fee tier and
// season. Noise: bootstrap over dates (contests on one date share player outcomes, so dates are the units).
//   node bench/sim-calibration-nfl.mjs data/reports/cal/base.s0.jsonl data/reports/cal/base.s1.jsonl ...
import fs from "node:fs";

const files = process.argv.slice(2).filter(a => !a.startsWith("--")), JSON_OUT = (process.argv.find(a => a.startsWith("--json=")) || "").slice(7);
const rows = [];
for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line) continue; const r = JSON.parse(line); if (r.t1 == null || r.finish == null) continue; rows.push(r); }
const fmt = r => (r.fkey || "").includes("sd") ? "showdown" : "classic";
const tier = r => (r.fee || 0) >= 300 ? "$300+" : (r.fee || 0) >= 50 ? "$50-299" : "<$50";
const season = r => r.date.slice(0, 4);
// predicted (%) and realised (0/1) for each event
const EV = { win: ["win", "won"], top1: ["t1", "top1"], top10: ["t10", "top10"], cash: ["cash", "cashed"] };

// calibration slope: fit act ~ sigmoid(a + b*logit(pred)). b = 1 is calibrated, b < 1 the sim is overconfident
// (its spread of probabilities is wider than what happens), b > 1 underconfident
function calSlope(rs, pk, ak) {
  const xs = [], ys = []; for (const r of rs) { const p = Math.min(0.999, Math.max(1e-5, r[pk] / 100)); xs.push(Math.log(p / (1 - p))); ys.push(r[ak]); }
  let a = 0, b = 1;
  for (let it = 0; it < 30; it++) { let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < xs.length; i++) { const z = a + b * xs[i], q = 1 / (1 + Math.exp(-z)), w = q * (1 - q), e = ys[i] - q; g0 += e; g1 += e * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i]; }
    const det = h00 * h11 - h01 * h01; if (!(det > 0)) break; const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db; if (Math.abs(da) + Math.abs(db) < 1e-7) break; }
  return b;
}
function summarise(rs) {
  const out = {};
  for (const [ev, [pk, ak]] of Object.entries(EV)) {
    let sp = 0, sa = 0, brier = 0, brierBase = 0, n = rs.length;
    const base = rs.reduce((s, r) => s + r[ak], 0) / (n || 1);
    for (const r of rs) { const p = r[pk] / 100, a = r[ak]; sp += p; sa += a; brier += (p - a) ** 2; brierBase += (base - a) ** 2; }
    out[ev] = { n, pred: sp / n, act: sa / n, ratio: sa / sp, brier: brier / n, skill: 1 - brier / brierBase, slope: calSlope(rs, pk, ak) };
  }
  return out;
}
// reliability: buckets by predicted probability, as multiples of the event's base rate (so contests of every size pool)
function reliability(rs, ev) {
  const [pk, ak] = EV[ev], B = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 1e9], cells = B.slice(0, -1).map(() => ({ n: 0, p: 0, a: 0 }));
  for (const r of rs) {
    const N = r.N || 1, baseP = ev === "win" ? 1 / N : ev === "top1" ? Math.max(1, Math.round(N * 0.01)) / N : ev === "top10" ? Math.max(1, Math.round(N * 0.1)) / N : (r.paid || 0) / N;
    if (!(baseP > 0)) continue;
    const x = (r[pk] / 100) / baseP; let k = 0; while (k < cells.length - 1 && x >= B[k + 1]) k++;
    cells[k].n++; cells[k].p += r[pk] / 100; cells[k].a += r[ak];
  }
  return cells.map((c, k) => ({ bucket: `${B[k]}-${B[k + 1] >= 1e9 ? "+" : B[k + 1]}x base`, n: c.n, pred: c.n ? c.p / c.n : 0, act: c.n ? c.a / c.n : 0 }));
}
// bootstrap the predicted/realised ratio by date
function bootSlope(rs, ev, reps = 200) {
  const [pk, ak] = EV[ev], byD = {}; for (const r of rs) (byD[r.date] = byD[r.date] || []).push(r);
  const ds = Object.values(byD), out = []; let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let b = 0; b < reps; b++) { const pick = []; for (let i = 0; i < ds.length; i++) pick.push(...ds[Math.floor(rnd() * ds.length)]); out.push(calSlope(pick, pk, ak)); }
  out.sort((x, y) => x - y); return { lo: out[Math.floor(reps * 0.05)], hi: out[Math.floor(reps * 0.95)] };
}
function bootRatio(rs, ev, reps = 400) {
  const [pk, ak] = EV[ev], byD = {};
  for (const r of rs) { const d = byD[r.date] || (byD[r.date] = { p: 0, a: 0 }); d.p += r[pk] / 100; d.a += r[ak]; }
  const ds = Object.values(byD), out = []; let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let b = 0; b < reps; b++) { let p = 0, a = 0; for (let i = 0; i < ds.length; i++) { const d = ds[Math.floor(rnd() * ds.length)]; p += d.p; a += d.a; } out.push(a / p); }
  out.sort((x, y) => x - y); return { dates: ds.length, lo: out[Math.floor(reps * 0.05)], hi: out[Math.floor(reps * 0.95)] };
}

const groups = {};
for (const r of rows) for (const k of [`${fmt(r)} all`, `${fmt(r)} ${season(r)}`, `${fmt(r)} ${tier(r)}`]) (groups[k] = groups[k] || []).push(r);
const report = {};
console.log(`${rows.length} entries in ${new Set(rows.map(r => r.c)).size} contests\n`);
for (const k of Object.keys(groups).sort()) {
  const rs = groups[k], s = summarise(rs); report[k] = { summary: s };
  console.log(`== ${k}: ${rs.length} entries, ${new Set(rs.map(r => r.c)).size} contests`);
  for (const ev of Object.keys(EV)) { const b = bootRatio(rs, ev); report[k][ev + "Boot"] = b; console.log(`  ${ev.padEnd(6)} predicted ${(100 * s[ev].pred).toFixed(3)}%  actual ${(100 * s[ev].act).toFixed(3)}%  actual/pred ${s[ev].ratio.toFixed(2)} [90% ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}, ${b.dates} dates]  Brier skill ${s[ev].skill.toFixed(4)}  slope ${s[ev].slope.toFixed(2)}`); }
}
for (const f of ["classic", "showdown"]) {
  const rs = groups[`${f} all`] || []; if (!rs.length) continue;
  for (const ev of ["top1", "top10", "cash"]) { const rel = reliability(rs, ev); report[`${f} all`]["rel_" + ev] = rel; console.log(`\nreliability ${f} ${ev} (predicted as a multiple of the base rate):`); for (const c of rel) if (c.n) console.log(`  ${c.bucket.padEnd(14)} n ${String(c.n).padStart(7)}  predicted ${(100 * c.pred).toFixed(2)}%  actual ${(100 * c.act).toFixed(2)}%  ratio ${(c.act / (c.pred || 1e-9)).toFixed(2)}`); }
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
