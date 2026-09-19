// Does the sim know what it takes to win? Large contests price about 50% worse than small ones, and
// the bar to beat in a large field is an extreme of the score distribution, so a tail that is even
// slightly too thin shows up there first and barely at all in a small field.
// For each pulled contest this scores a generated field many times and compares the bar the sim
// expects - the winning score, and the score at the top 1% and at the cash line - against what the
// real contest actually produced.
//   node bench/winning-score.mjs [cfb_cl] [--n=60] [--draws=300]
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel, drawScores, makeScratch } from "../src/engine/model.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 60, DRAWS = flag("draws") || 300;
// --sig=1.2 scales every default sigma, --corr=1.2 scales every correlation entry: the two ways a
// simulated tail can be too thin
const SIG = flag("sig"), CORR = flag("corr");
const TAILC = flag("tailc"), TAILA = flag("taila");   // bend the upper tail: z + a(z-c)^2 above c
const { SIGMA_DEF, CSAME, COPP, MLBC } = await import("../src/engine/model.mjs");
const scale = (t, k) => Object.fromEntries(Object.entries(t).map(([a2, v]) => [a2, typeof v === "number" ? v * k : v]));
const MODEL = (SIG || CORR) ? Object.assign({},
  SIG ? { sigmaDef: scale(SIGMA_DEF[FKEY] || SIGMA_DEF.cfb, SIG), sigmaMax: 5 } : {},
  CORR ? { tables: { CSAME: scale(CSAME, CORR), COPP: scale(COPP, CORR), MLBC } } : {}) : {};
if (TAILA != null) MODEL.tail = TAILA ? { c: TAILC == null ? 1.0 : TAILC, a: TAILA } : false;

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))]; };
const SIZES = [["under 300", 0, 300], ["300-1.5K", 300, 1500], ["1.5K+", 1500, 1e9]];
const blank = () => ({ n: 0, win: [], top1: [], cash: [] });
const buckets = SIZES.map(blank), all = blank();
let done = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (done >= LIM) break;
  const { pool, entries, paid } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 50) continue;
  const P = pool.players, N = entries.length;
  const { field } = genField(pool, N, {}, mulberry32(4242 + done));
  if (field.length < 50) continue;
  const model = buildModel(pool, MODEL), scratch = makeScratch(model, pool);
  const out = new Float64Array(P.length);
  const simWin = [], simTop1 = [], simCash = [];
  const rng = mulberry32(99 + done);
  const paidN = Math.max(1, paid || Math.round(N * 0.2));
  for (let d = 0; d < DRAWS; d++) {
    drawScores(model, pool, rng, out, scratch);
    const tot = field.map(lu => { let s = 0; for (const id of lu) s += out[id]; return s; });
    tot.sort((a, b) => b - a);
    simWin.push(tot[0]);
    simTop1.push(tot[Math.min(tot.length - 1, Math.floor(tot.length * 0.01))]);
    simCash.push(tot[Math.min(tot.length - 1, paidN - 1)]);
  }
  const act = scored.map(e => e.actFP).sort((a, b) => b - a);
  const row = { win: mean(simWin) - act[0],
    top1: mean(simTop1) - act[Math.min(act.length - 1, Math.floor(act.length * 0.01))],
    cash: mean(simCash) - act[Math.min(act.length - 1, paidN - 1)] };
  const bi = SIZES.findIndex(s => N >= s[1] && N < s[2]);
  for (const a of [all, bi >= 0 ? buckets[bi] : null]) { if (!a) continue; a.n++; a.win.push(row.win); a.top1.push(row.top1); a.cash.push(row.cash); }
  done++;
}
console.log(`${done} contests, ${DRAWS} simulated runs each. Negative means the sim expects a LOWER bar than reality produced.\n`);
console.log("field size".padEnd(13) + "n".padEnd(6) + "winning score".padEnd(16) + "top 1% score".padEnd(16) + "cash line");
const show = (lab, a) => { if (!a.n) return;
  console.log(lab.padEnd(13) + String(a.n).padEnd(6) + mean(a.win).toFixed(1).padEnd(16) + mean(a.top1).toFixed(1).padEnd(16) + mean(a.cash).toFixed(1)); };
for (let i = 0; i < SIZES.length; i++) show(SIZES[i][0], buckets[i]);
show("all", all);
