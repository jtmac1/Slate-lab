// Paired comparison of NBA classic grade runs (bench/grade-all.mjs --fkey=nba_cl --rows=<jsonl> --json=<json>), overall and by
// slate size (games: 2-4 / 5-7 / 8+). Per contest: lineup rank Spearman of sim ROI vs actual points (json sMine), and for the sim's
// top decile of real entries by sim ROI (raw, uncalibrated), the share that finished top 10% / top 1% of the contest and their
// realized ROI. Differences B - A with a contest bootstrap 95% CI; --noise=<A2 base> adds the same-model seed difference.
//   node bench/compare-rows-nba.mjs base-s1 cand-s1 [--noise=base-s2]     (prefixes: <p>.jsonl + <p>.json)
import fs from "node:fs";
import readline from "node:readline";

export const bucketOf = g => g <= 1 ? "1" : g <= 4 ? "2-4" : g <= 7 ? "5-7" : "8+";
export async function loadRun(prefix) {
  const by = new Map(), rl = readline.createInterface({ input: fs.createReadStream(prefix + ".jsonl"), crlfDelay: Infinity });
  for await (const line of rl) { if (!line) continue; const r = JSON.parse(line); if (r.fkey !== "nba_cl") continue;
    let c = by.get(r.c); if (!c) by.set(r.c, c = { c: r.c, date: r.date, games: r.games, N: r.N, rows: [] }); c.rows.push([r.roi, r.top10, r.top1, r.actROI]); }
  const js = fs.existsSync(prefix + ".json") ? JSON.parse(fs.readFileSync(prefix + ".json", "utf8")) : [], sM = new Map(js.map(r => [r.dir, r]));
  const out = new Map();
  for (const c of by.values()) { const k = Math.max(3, Math.round(c.rows.length * 0.1)), top = c.rows.map((r, i) => i).sort((a, b) => c.rows[b][0] - c.rows[a][0] || a - b).slice(0, k);
    const m = f => top.reduce((s, i) => s + f(c.rows[i]), 0) / k, j = sM.get(c.c);
    out.set(c.c, { c: c.c, date: c.date, games: c.games ?? j?.games, n: c.rows.length, sp: j ? j.sMine : NaN, t10: m(r => r[1]), t1: m(r => r[2]), roi: m(r => r[3]) }); }
  return out;
}
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const ci = d => { const ms = []; for (let b = 0; b < 2000; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]; ms.push(s / d.length); } ms.sort((x, y) => x - y); return [ms[50], ms[1949]]; };
export const METRICS = { "rank Spearman": "sp", "top decile -> top 10%": "t10", "top decile -> top 1%": "t1", "top decile realized ROI": "roi" };
export function compare(A, B, N2) {
  const keys = [...A.keys()].filter(k => B.has(k) && (!N2 || N2.has(k)) && !Number.isNaN(A.get(k).sp) && !Number.isNaN(B.get(k).sp)), res = {};
  // date halves as in bench/fit-spread-nba.mjs: index of the date among all contest dates, odd = fit half, even = held out
  const dts = [...new Set(keys.map(k => A.get(k).date))].sort(), di = new Map(dts.map((d, i) => [d, i]));
  for (const bk of ["all", "2-4", "5-7", "8+", "odd dates (fit)", "even dates (held out)"]) {
    const ks = keys.filter(k => bk === "all" || (bk.startsWith("odd") ? di.get(A.get(k).date) % 2 === 1 : bk.startsWith("even") ? di.get(A.get(k).date) % 2 === 0 : bucketOf(A.get(k).games) === bk)); if (!ks.length) continue; res[bk] = { contests: ks.length };
    for (const [mn, f] of Object.entries(METRICS)) { const a = ks.map(k => A.get(k)[f]), b = ks.map(k => B.get(k)[f]), d = b.map((x, i) => x - a[i]), [lo, hi] = ci(d);
      const o = { A: +mean(a).toFixed(4), B: +mean(b).toFixed(4), diff: +mean(d).toFixed(4), ci: [+lo.toFixed(4), +hi.toFixed(4)], wins: `${d.filter(x => x > 0).length}/${d.filter(x => x !== 0).length}` };
      if (N2) { const dn = ks.map(k => N2.get(k)[f] - A.get(k)[f]), [nlo, nhi] = ci(dn); o.noise = +mean(dn).toFixed(4); o.noiseCi = [+nlo.toFixed(4), +nhi.toFixed(4)]; o.noiseSd = +Math.sqrt(mean(dn.map(x => x * x))).toFixed(4); }
      res[bk][mn] = o; } }
  return res;
}
export function printCompare(res, la = "A", lb = "B") {
  const lines = [];
  for (const [bk, r] of Object.entries(res)) { lines.push(`  -- ${bk === "all" ? "all slates" : bk.includes("dates") ? bk : bk + " games"}: ${r.contests} contests`);
    for (const mn of Object.keys(METRICS)) { const o = r[mn], pct = mn !== "rank Spearman", f = x => pct ? (mn.includes("ROI") ? x.toFixed(1) + "%" : (100 * x).toFixed(2) + "%") : x.toFixed(4);
      lines.push(`     ${mn.padEnd(25)} ${la} ${f(o.A).padEnd(8)} ${lb} ${f(o.B).padEnd(8)} diff ${(o.diff >= 0 ? "+" : "") + f(o.diff)} [${f(o.ci[0])}, ${f(o.ci[1])}]${o.ci[0] > 0 ? " +" : o.ci[1] < 0 ? " -" : "  "} wins ${o.wins}` + (o.noise != null ? `  | seed noise ${(o.noise >= 0 ? "+" : "") + f(o.noise)} [${f(o.noiseCi[0])}, ${f(o.noiseCi[1])}]` : "")); } }
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("compare-rows-nba.mjs")) {
  const pos = process.argv.slice(2).filter(a => !a.startsWith("--")), nz = (process.argv.find(a => a.startsWith("--noise=")) || "").slice(8);
  const A = await loadRun(pos[0]), B = await loadRun(pos[1]), N2 = nz ? await loadRun(nz) : null;
  console.log(`A = ${pos[0]}  B = ${pos[1]}${nz ? `  noise = ${nz} (same model as A, other seed)` : ""}`);
  console.log(printCompare(compare(A, B, N2)));
}
