// Small slates are our worst priced cell: 1-3 game college contests run 16.4 points of pricing error
// against 8-9 everywhere else. Player-pair correlation is a property of the game, not of the slate,
// so the suspect is not the correlation table but what it adds up to: on a two game slate every
// lineup is drawn from the same two games, so the whole field rises and falls together and the
// spread of lineup scores is far wider than on a twelve game slate.
// This compares the spread the sim produces against the spread the real entries actually had.
//   node bench/slate-spread.mjs [cfb_cl] [--n=80] [--draws=200]
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel, drawScores, makeScratch } from "../src/engine/model.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 80, DRAWS = flag("draws") || 200;

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const SIZES = [["1-3 games", 1, 3], ["4-7 games", 4, 7], ["8-11 games", 8, 11], ["12+ games", 12, 99]];
const blank = () => ({ n: 0, rs: [], gs: [], rm: [], gm: [] });
const buckets = SIZES.map(blank);
let done = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (done >= LIM) break;
  const { pool, entries } = loadPulled(c.json);
  const scored = entries.filter(e => e.actFP > 0);
  if (scored.length < 80) continue;
  const bi = SIZES.findIndex(s => pool.games.length >= s[1] && pool.games.length <= s[2]);
  if (bi < 0) continue;
  const P = pool.players;
  const { field } = genField(pool, entries.length, {}, mulberry32(777 + done));
  if (field.length < 80) continue;
  const model = buildModel(pool, {}), scratch = makeScratch(model, pool), out = new Float64Array(P.length);
  const rng = mulberry32(31 + done);
  const spreads = [], means = [];
  for (let d = 0; d < DRAWS; d++) {
    drawScores(model, pool, rng, out, scratch);
    const tot = field.map(lu => { let s = 0; for (const id of lu) s += out[id]; return s; });
    spreads.push(sd(tot)); means.push(mean(tot));
  }
  const a = buckets[bi]; a.n++;
  a.rs.push(sd(scored.map(e => e.actFP))); a.gs.push(mean(spreads));
  a.rm.push(mean(scored.map(e => e.actFP))); a.gm.push(mean(means));
  done++;
}
console.log(`${done} contests, ${DRAWS} simulated runs each\n`);
console.log("slate size".padEnd(13) + "n".padEnd(5) + "real spread".padEnd(14) + "sim spread".padEnd(13) + "ratio".padEnd(9) + "real mean".padEnd(12) + "sim mean");
for (let i = 0; i < SIZES.length; i++) {
  const a = buckets[i]; if (!a.n) continue;
  console.log(SIZES[i][0].padEnd(13) + String(a.n).padEnd(5) + mean(a.rs).toFixed(1).padEnd(14) + mean(a.gs).toFixed(1).padEnd(13)
    + (mean(a.gs) / mean(a.rs)).toFixed(2).padEnd(9) + mean(a.rm).toFixed(1).padEnd(12) + mean(a.gm).toFixed(1));
}
