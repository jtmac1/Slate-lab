// Verdicts for the CFB high-stakes sim tuning study, from bench/tune-cfb-sweep.mjs output (one JSONL per config,
// one line per contest). Each config is paired with its baseline contest by contest (r-* against r-base on the real
// field, g-* against g-base on the generated field); the t on each difference is clustered by date (contests on one
// date share player outcomes), and repeated on each half of the date range. Also the selection rules layered on the
// baseline sim (top 10% by sim inside the rule vs top 10% by sim alone) and, for generated-field configs, how close
// the field is to the real one. The seed-2 reruns of the baselines are graded like any config: that is the noise floor.
//   node bench/tune-cfb-highstakes.mjs [dir=data/reports/tune-cfb] [--json=data/reports/cfb-highstakes.json]
// A metric counts as moved when |t| >= 2, both halves agree in sign, and the change is more than twice what the
// baseline's own seed-2 rerun moved it (Monte Carlo noise). KEEP = a money metric (realized ROI or top-1% rate of the
// top picks) up and none down, rank correlation not down; REJECT = a money metric down, or rank correlation down with
// money flat; otherwise NOISE. Judged on the "match" set ($100+, 200-2,000 entries); the others are for size.
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2), flag = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const DIR = args.find(a => !a.startsWith("--")) || "data/reports/tune-cfb", JSON_OUT = flag("json");
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN, sdv = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const SETS = { match: c => c.fee >= 100 && c.N >= 200 && c.N <= 2000, "$300+": c => c.fee >= 300, all: () => true };
const METRICS = [["spearman", "Spearman", 1], ["roi10", "top-10% ROI", 0], ["top1of10", "top-10% top-1% rate", 100], ["top10of10", "top-10% top-10% rate", 100], ["roi3", "top-3% ROI", 0], ["top1of3", "top-3% top-1% rate", 100], ["t1roi10", "top-10% by sim top-1%: ROI", 0], ["t1top1of10", "top-10% by sim top-1%: top-1% rate", 100]];
const KEY = ["roi10", "top1of10", "roi3", "top1of3", "spearman"];
const load = n => { const f = path.join(DIR, n + ".jsonl"); if (!fs.existsSync(f)) return null; const m = new Map(); for (const l of fs.readFileSync(f, "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l); m.set(r.c, r); } return m; };
const names = fs.readdirSync(DIR).filter(f => f.endsWith(".jsonl") && !/\.\d+\.jsonl$/.test(f)).map(f => f.slice(0, -6)).sort();
const runs = Object.fromEntries(names.map(n => [n, load(n)]));
// paired, date-clustered difference
function paired(base, run, keys, get) {
  const byDate = new Map(); for (const c of keys) { const a = get(base.get(c)), b = get(run.get(c)); if (a == null || b == null || isNaN(a) || isNaN(b)) continue; const d = base.get(c).date; (byDate.get(d) || byDate.set(d, []).get(d)).push(b - a); }
  const dd = [...byDate.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1), vals = dd.map(x => mean(x[1])), t = v => v.length > 3 ? mean(v) / (sdv(v) / Math.sqrt(v.length)) : NaN, h = Math.floor(vals.length / 2);
  return { diff: mean(vals), t: t(vals), t1: t(vals.slice(0, h)), t2: t(vals.slice(h)), d1: mean(vals.slice(0, h)), d2: mean(vals.slice(h)), dates: vals.length };
}
const fmt = (m, v) => isNaN(v) ? "-" : m === "spearman" ? v.toFixed(3) : m.includes("top") && !m.includes("roi") ? (100 * v).toFixed(2) + "%" : v.toFixed(0) + "%";
const fmtD = (m, v) => isNaN(v) ? "-" : (v >= 0 ? "+" : "") + (m === "spearman" ? v.toFixed(3) : m.includes("top") && !m.includes("roi") ? (100 * v).toFixed(2) : v.toFixed(0));
const out = ["# CFB sim tuning: per-config results", ""], J = { built: new Date().toISOString(), sets: {} };
for (const [set, pred] of Object.entries(SETS)) {
  J.sets[set] = { configs: {}, rules: {} };
  for (const baseName of ["r-base", "g-base"]) {
    const base = runs[baseName]; if (!base) continue;
    const family = names.filter(n => n.startsWith(baseName[0] + "-"));
    const keysAll = [...base.values()].filter(pred).map(x => x.c);
    const noise = {}, s2 = runs[baseName + "-s2"]; if (s2) { const ks = keysAll.filter(c => s2.has(c)); for (const [m] of METRICS) noise[m] = Math.abs(paired(base, s2, ks, r => r[m]).diff); }
    out.push(`## ${set}, ${baseName === "r-base" ? "real field" : "generated field (build-slate generator)"}: ${keysAll.length} contests on ${new Set(keysAll.map(c => base.get(c).date)).size} dates`, "");
    out.push("| config | contests | " + METRICS.map(m => m[1]).join(" | ") + " | verdict |", "|---|---|" + METRICS.map(() => "---").join("|") + "|---|");
    for (const n of family) {
      const run = runs[n], keys = keysAll.filter(c => run.has(c)); if (!keys.length) continue;
      const cells = [], jc = { contests: keys.length, metrics: {} };
      for (const [m] of METRICS) {
        const v = mean(keys.map(c => run.get(c)[m]));
        if (n === baseName) { cells.push(fmt(m, v)); jc.metrics[m] = { v }; continue; }
        const p = paired(base, run, keys, r => r[m]); jc.metrics[m] = Object.assign({ v }, p);
        cells.push(`${fmt(m, v)} (${fmtD(m, p.diff)}, t ${isNaN(p.t) ? "-" : p.t.toFixed(1)}; ${isNaN(p.t1) ? "-" : p.t1.toFixed(1)}/${isNaN(p.t2) ? "-" : p.t2.toFixed(1)})`);
      }
      let verdict = n === baseName ? "baseline" : "NOISE";
      if (n !== baseName) {
        // a metric moves only if |t| >= 2, both halves agree, and the change is over twice the seed-2 rerun's change (Monte Carlo noise)
        const M = jc.metrics, nz = m => noise[m] ?? 0, mv = (m, dir) => M[m] && M[m].t * dir >= 2 && M[m].d1 * dir > 0 && M[m].d2 * dir > 0 && Math.abs(M[m].diff) > 2 * nz(m);
        const MONEY = ["roi10", "top1of10", "roi3", "top1of3", "t1roi10", "t1top1of10"], up = MONEY.filter(m => mv(m, 1)), down = MONEY.filter(m => mv(m, -1));
        verdict = up.length && !down.length && !mv("spearman", -1) ? "KEEP (" + up.join(", ") + " up)" : down.length ? "REJECT (" + down.join(", ") + " down)" : mv("spearman", -1) ? "REJECT (rank corr down, money flat)" : mv("spearman", 1) ? "NOISE (rank corr up, money flat)" : "NOISE";
      }
      jc.verdict = verdict;
      if (run.values().next().value.field) { const fr = keys.map(c => run.get(c).field).filter(Boolean); jc.field = { tvd: mean(fr.map(x => x.tvd)), dupReal: mean(fr.map(x => x.dupReal)), dupGen: mean(fr.map(x => x.dupGen)), ownReal: mean(fr.map(x => x.ownReal)), ownGen: mean(fr.map(x => x.ownGen)), gap: mean(fr.map(x => x.gap)) }; }
      J.sets[set].configs[n] = jc;
      out.push(`| ${n} | ${keys.length} | ${cells.join(" | ")} | ${verdict} |`);
    }
    out.push("", "Cells: value (difference vs baseline, date-clustered t; t first half / second half).", "");
    // field realism
    const gens = family.filter(n => runs[n].values().next().value.field);
    if (gens.length) {
      out.push("Field realism (generated vs real, averaged over contests): stack-shape distance (lower is closer), duplicated share real/gen, own sum real/gen, mean exposure gap (pts)", "", "| config | shape TVD | dup real / gen | own sum real / gen | exposure gap |", "|---|---|---|---|---|");
      for (const n of gens) { const f = J.sets[set].configs[n]?.field; if (f) out.push(`| ${n} | ${f.tvd.toFixed(3)} | ${(100 * f.dupReal).toFixed(1)}% / ${(100 * f.dupGen).toFixed(1)}% | ${f.ownReal.toFixed(0)} / ${f.ownGen.toFixed(0)} | ${f.gap.toFixed(2)} |`); }
      out.push("");
    }
    // selection rules on top of the baseline sim
    const ruleNames = Object.keys(base.values().next().value.rules || {});
    if (ruleNames.length) {
      out.push(`Selection rules on top of the ${baseName} sim (top 10% / top 3% by sim inside the rule vs by sim alone):`, "", "| rule | share of field | top-10% ROI | top-10% top-1% rate | top-3% ROI | top-3% top-1% rate | verdict |", "|---|---|---|---|---|---|---|");
      for (const rn of ruleNames) {
        const cells = [], jr = {};
        for (const [m, plain] of [["roi10", "roi10"], ["top1of10", "top1of10"], ["roi3", "roi3"], ["top1of3", "top1of3"]]) {
          const byDate = new Map(); for (const c of keysAll) { const r = base.get(c), a = r[plain], b = r.rules[rn][m]; if (b == null || isNaN(b)) continue; (byDate.get(r.date) || byDate.set(r.date, []).get(r.date)).push(b - a); }
          const dd = [...byDate.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1).map(x => mean(x[1])), tt = v => v.length > 3 ? mean(v) / (sdv(v) / Math.sqrt(v.length)) : NaN, h = Math.floor(dd.length / 2);
          jr[m] = { diff: mean(dd), t: tt(dd), t1: tt(dd.slice(0, h)), t2: tt(dd.slice(h)), d1: mean(dd.slice(0, h)), d2: mean(dd.slice(h)) };
          cells.push(`${fmtD(m, jr[m].diff)} (t ${isNaN(jr[m].t) ? "-" : jr[m].t.toFixed(1)}; ${isNaN(jr[m].t1) ? "-" : jr[m].t1.toFixed(1)}/${isNaN(jr[m].t2) ? "-" : jr[m].t2.toFixed(1)})`);
        }
        const share = mean(keysAll.map(c => base.get(c).rules[rn].share));
        const up = ["roi10", "top1of10"].some(m => jr[m].t >= 2 && jr[m].d1 > 0 && jr[m].d2 > 0), bad = Object.values(jr).some(x => x.t <= -2);
        jr.verdict = up && !bad ? "KEEP" : Object.values(jr).some(x => x.t <= -2 && x.d1 < 0 && x.d2 < 0) ? "REJECT" : "NOISE"; jr.share = share;
        J.sets[set].rules[baseName + ": " + rn] = jr;
        out.push(`| ${rn} | ${(100 * share).toFixed(0)}% | ${cells.join(" | ")} | ${jr.verdict} |`);
      }
      out.push("");
    }
  }
}
console.log(out.join("\n"));
fs.writeFileSync(path.join(DIR, "summary.md"), out.join("\n") + "\n");
if (JSON_OUT) { let prev = {}; try { prev = JSON.parse(fs.readFileSync(JSON_OUT, "utf8")); } catch {} prev.simTune = J; fs.writeFileSync(JSON_OUT, JSON.stringify(prev, null, 1)); console.log("wrote " + JSON_OUT); }
