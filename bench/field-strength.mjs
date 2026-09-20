// Is the generated field as STRONG as the real one, and does the real field get sharper as the
// buy-in rises? The calibration test (bench/calibration.mjs) says the sim prices the average entry
// several points of ROI too high, which is what a field that is too easy to beat looks like. This
// compares generated lineups against the real entries on what makes a lineup hard to beat -
// projected points, the top of that distribution, and salary used - and splits it by entry fee.
//   node bench/field-strength.mjs cfb_cl [--n=60] [--best=40 --frac=0.08 --minsal=49300] [--bytier]
import { listContests, loadPulled } from "./grade-all.mjs";
import { fieldProfile, genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const FKEY = process.argv[2] || "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 60, SEC = process.argv.includes("--sec"), BYTIER = process.argv.includes("--bytier");
const MINSAL = flag("minsal"), BEST = flag("best"), FRAC = flag("frac"), CONC = flag("conc");
// --skill=0.08:40,0.42:3  share of entrants and how many candidates each considers
const SKILLRAW = (process.argv.find(a => a.startsWith("--skill=")) || "").slice(8);
const SKILL = SKILLRAW ? SKILLRAW.split(",").map(x => x.split(":").map(Number)) : null;

const BYSIZE = process.argv.includes("--bysize");
const TIERS = BYSIZE
  ? [["under 300", 0, 300], ["300-1500", 300, 1500], ["1500-5000", 1500, 5000], ["5000+", 5000, 1e9]]
  : [["under $10", 0, 10], ["$10-49", 10, 50], ["$50-199", 50, 200], ["$200+", 200, 1e9]];
const tierKey = c => BYSIZE ? (c.entries || 0) : (c.fee || 0);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const blank = () => ({ n: 0, dp: [], dp99: [], ds: [], dOwn: [] });
const all = blank(), tiers = TIERS.map(blank);
let done = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (done >= LIM) break;
  const { pool, entries } = loadPulled(c.json);
  if (entries.length < 50) continue;
  const P = pool.players;
  // the contest own price profile first, so what is left over is the part price cannot explain
  const opts = Object.assign({}, fieldProfile(c.fee, FKEY, entries.length), SEC ? { secStack: true } : {}, MINSAL ? { minSal: MINSAL } : {},
    BEST ? { best: BEST } : {}, FRAC != null ? { sharpFrac: FRAC } : {}, CONC != null ? { conc: CONC } : {}, SKILL ? { skill: SKILL } : {});
  const { field } = genField(pool, entries.length, opts, mulberry32(12345 + done));
  if (!field.length) continue;
  const projOf = lu => lu.reduce((s, id) => s + (P[id].proj || 0), 0);
  const salOf = lu => lu.reduce((s, id) => s + (P[id].sal || 0), 0);
  const ownOf = lu => lu.reduce((s, id) => s + (P[id].own || 0), 0);
  const rp = entries.map(e => projOf(e.lu)), gp = field.map(projOf);
  const row = { dp: mean(rp) - mean(gp), dp99: q(rp, 0.99) - q(gp, 0.99),
    ds: mean(entries.map(e => salOf(e.lu))) - mean(field.map(salOf)),
    dOwn: mean(entries.map(e => ownOf(e.lu))) - mean(field.map(ownOf)) };
  const ti = TIERS.findIndex(t => tierKey(c) >= t[1] && tierKey(c) < t[2]);
  for (const a of [all, ti >= 0 ? tiers[ti] : null]) { if (!a) continue; a.n++; for (const k of ["dp", "dp99", "ds", "dOwn"]) a[k].push(row[k]); }
  done++;
}
const show = (lab, a) => { if (!a.n) return;
  console.log(lab.padEnd(12) + String(a.n).padEnd(7) + mean(a.dp).toFixed(2).padEnd(12) + mean(a.dp99).toFixed(2).padEnd(12) + mean(a.ds).toFixed(0).padEnd(12) + mean(a.dOwn).toFixed(1)); };
console.log(`${done} contests. Positive means the REAL field is stronger than the generated one.\n`);
console.log("tier".padEnd(12) + "n".padEnd(7) + "mean proj".padEnd(12) + "99th proj".padEnd(12) + "salary".padEnd(12) + "ownership sum");
if (BYTIER) for (let i = 0; i < TIERS.length; i++) show(TIERS[i][0], tiers[i]);
show("all", all);
