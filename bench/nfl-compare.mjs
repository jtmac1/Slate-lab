// Reads the arms written by bench/nfl-overnight.sh and answers one question per arm: did the change
// move the engine by more than the engine moves on its own?
//
// The noise floor is computed first, from five runs of the SHIPPED engine that differ only by seed.
// Any arm whose delta sits inside that band is not a result, however good the mean looks - that is
// the mistake that produced three wrong conclusions on the college work. Deltas are paired by
// contest, because contests differ enormously in how they pay.
//
//   node bench/nfl-compare.mjs [dir=data/reports/nfl-overnight]
import fs from "node:fs";
import path from "node:path";
const DIR = process.argv[2] || "data/reports/nfl-overnight";

const load = n => { const f = path.join(DIR, n + ".json");
  return fs.existsSync(f) && fs.statSync(f).size ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
const names = fs.readdirSync(DIR).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")).sort();

// the metrics we judge on. cash rate and rank correlation are stable; realized ROI is heavy-tailed
// and included only so its instability stays visible rather than being quietly trusted.
const RULE = "ROI gated: top half proj";
const METRICS = {
  "rank corr (sMine)":  r => r.sMine,
  "cash rate":          r => r.paid ? r.cashMine / r.paid : null,
  "rule rank corr":     r => r.grades?.[RULE]?.spearman,
  "rule cash hits":     r => r.grades?.[RULE]?.cashHits,
  "top-10% real ROI":   r => r.roiMine
};
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

const arms = {};
for (const n of names) { const j = load(n); if (j && j.length) arms[n] = j; }
if (!Object.keys(arms).length) { console.log(`no finished arms in ${DIR} yet`); process.exit(0); }

// ---- harness assertions. resid is projection error against actual scores; no model flag can touch
// it, so if it moves between arms the arms are not the same contests and nothing below is valid.
console.log("=== harness check ===");
const base = arms["A-base"] || arms[names[0]];
let bad = 0;
for (const [n, rows] of Object.entries(arms)) {
  const common = rows.filter(r => base.some(b => b.dir === r.dir));
  const rs = mean(rows.map(r => r.resid));
  const flag = rows.length !== base.length ? "  <-- DIFFERENT CONTEST COUNT" : "";
  if (flag) bad++;
  console.log(`  ${n.padEnd(18)} ${String(rows.length).padStart(4)} contests   resid ${rs.toFixed(3)}${flag}`);
}
const residSpread = Math.max(...Object.values(arms).map(r => mean(r.map(x => x.resid))))
                  - Math.min(...Object.values(arms).map(r => mean(r.map(x => x.resid))));
console.log(`  projection residual spread across arms: ${residSpread.toFixed(4)} ${residSpread > 0.01 ? "<-- SHOULD BE ~0, INVESTIGATE" : "(ok, model flags cannot move it)"}`);
if (bad) console.log("  WARNING: arms cover different contests; paired deltas below drop to the overlap.");

// ---- noise floor from the seed replicates of the shipped engine
const noise = names.filter(n => /^noise-seed/.test(n) && arms[n]);
console.log(`\n=== noise floor: ${noise.length} runs of the shipped engine, seed only ===`);
const floor = {};
if (noise.length >= 2) {
  console.log("  metric".padEnd(24) + "mean".padEnd(12) + "sd across seeds".padEnd(18) + "full range (max-min)");
  for (const [label, fn] of Object.entries(METRICS)) {
    const per = noise.map(n => mean(arms[n].map(fn).filter(v => v != null && isFinite(v))));
    const range = Math.max(...per) - Math.min(...per);
    floor[label] = range;
    console.log("  " + label.padEnd(22) + mean(per).toFixed(4).padEnd(12) + sd(per).toFixed(4).padEnd(18) + range.toFixed(4));
  }
  console.log("  Nothing below counts as a finding unless it clears the full range in its row.");
} else console.log("  not enough seed replicates yet");

// ---- paired arm comparisons against the shipped baseline
const pairedDelta = (armRows, baseRows, fn) => {
  const bi = Object.fromEntries(baseRows.map(r => [r.dir, r]));
  const d = [];
  for (const r of armRows) { const b = bi[r.dir]; if (!b) continue;
    const a = fn(r), c = fn(b); if (a == null || c == null || !isFinite(a) || !isFinite(c)) continue;
    d.push(a - c); }
  return d;
};
const report = (label, armRows, baseRows) => {
  console.log(`\n--- ${label} vs shipped baseline`);
  console.log("  metric".padEnd(24) + "delta".padEnd(12) + "se".padEnd(10) + "t".padEnd(8) + "better in".padEnd(12) + "verdict");
  for (const [m, fn] of Object.entries(METRICS)) {
    const d = pairedDelta(armRows, baseRows, fn);
    if (d.length < 5) { console.log("  " + m.padEnd(22) + "(too few paired contests)"); continue; }
    const mu = mean(d), se = sd(d) / Math.sqrt(d.length), t = mu / se;
    const up = d.filter(x => x > 0).length;
    const fl = floor[m];
    const verdict = fl == null ? "no floor"
      : Math.abs(mu) <= fl ? "INSIDE noise - not a result"
      : Math.abs(t) < 2 ? "clears floor, not significant"
      : mu > 0 ? "BETTER (clears floor, t>2)" : "WORSE (clears floor, t>2)";
    console.log("  " + m.padEnd(22) + mu.toFixed(4).padEnd(12) + se.toFixed(4).padEnd(10)
      + t.toFixed(2).padEnd(8) + `${up}/${d.length}`.padEnd(12) + verdict);
  }
};

const cmp = names.filter(n => !/^noise-seed/.test(n) && n !== "A-base" && !/^SD-/.test(n) && arms[n]);
if (arms["A-base"]) for (const n of cmp) report(n, arms[n], arms["A-base"]);

// showdown is a separate format with its own sigma table; graded against its own baseline
if (arms["SD-base"] && arms["SD-ctable"]) report("SD-ctable (showdown)", arms["SD-ctable"], arms["SD-base"]);

// ---- seed robustness: same config, several seeds, so the winner is not a seed artefact
const fSeeds = names.filter(n => /^F-all(-seed\d+)?$/.test(n) && arms[n]);
const aSeeds = names.filter(n => /^A-base(-seed\d+)?$/.test(n) && arms[n]);
if (fSeeds.length >= 2 && aSeeds.length >= 2) {
  console.log(`\n=== seed robustness: ${fSeeds.length} runs of the combined arm vs ${aSeeds.length} of baseline ===`);
  console.log("  metric".padEnd(24) + "combined".padEnd(14) + "baseline".padEnd(14) + "gap".padEnd(12) + "noise floor");
  for (const [m, fn] of Object.entries(METRICS)) {
    const f = fSeeds.map(n => mean(arms[n].map(fn).filter(v => v != null && isFinite(v))));
    const a = aSeeds.map(n => mean(arms[n].map(fn).filter(v => v != null && isFinite(v))));
    const gap = mean(f) - mean(a);
    console.log("  " + m.padEnd(22) + mean(f).toFixed(4).padEnd(14) + mean(a).toFixed(4).padEnd(14)
      + gap.toFixed(4).padEnd(12) + (floor[m] != null ? floor[m].toFixed(4) + (Math.abs(gap) > floor[m] ? "  clears" : "  inside") : "-"));
  }
}
console.log();
