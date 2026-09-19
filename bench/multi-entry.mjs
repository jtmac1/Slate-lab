// Who is actually in the contest? Every pulled entry carries the user who submitted it, so the
// field's real composition is observable: how many distinct people, how many enter once, and how
// much of the field sits in big blocks from one person.
// The contest's stated cap is not the same thing - most entrants in a 20-max contest still enter
// once or twice - so this reports the realised structure and groups it by the cap the contest NAME
// states, which is the part we would know before lock.
//   node bench/multi-entry.mjs [cfb_cl] [--n=200]
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 200;

// the cap as the contest name states it; unstated is left as its own group rather than guessed
export function statedCap(name) {
  const s = String(name || "");
  if (/single\s*entry/i.test(s)) return 1;
  const m = s.match(/(\d+)\s*(?:entry|entries)\s*max/i) || s.match(/max\s*(\d+)\s*(?:entry|entries)/i);
  return m ? +m[1] : null;
}
const GROUPS = [["single entry", c => c === 1], ["2-5 stated", c => c >= 2 && c <= 5],
  ["6-20 stated", c => c >= 6 && c <= 20], ["over 20 stated", c => c > 20], ["not stated", c => c == null]];
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const blank = () => ({ n: 0, fee: [], users: [], onceShare: [], bigShare: [], maxSeen: [], dupes: [], dp: [], dOwn: [] });
const groups = GROUPS.map(blank);
let done = 0;
for (const c of listContests().filter(c => c.json && c.fkey === FKEY)) {
  if (done >= LIM) break;
  const { pool, entries } = loadPulled(c.json);
  if (entries.length < 50 || !entries.some(e => e.user)) continue;
  const gi = GROUPS.findIndex(g => g[1](statedCap(c.name)));
  if (gi < 0) continue;
  const P = pool.players, f = pool.format;
  const by = {};
  for (const e of entries) by[e.user || "?"] = (by[e.user || "?"] || 0) + 1;
  const counts = Object.values(by).sort((a, b) => b - a), N = entries.length;
  const { field } = genField(pool, N, {}, mulberry32(12345 + done));
  if (!field.length) continue;
  const projOf = lu => lu.reduce((s, id) => s + (P[id].proj || 0), 0);
  const ownOf = lu => lu.reduce((s, id) => s + (P[id].own || 0), 0);
  const dup = lus => { const seen = new Set(); let d = 0; for (const lu of lus) { const s = sigOf(lu, f); if (seen.has(s)) d++; else seen.add(s); } return 100 * d / lus.length; };
  const a = groups[gi]; a.n++;
  a.fee.push(c.fee || 0);
  a.users.push(counts.length);
  a.onceShare.push(100 * counts.filter(x => x === 1).length / counts.length);   // share of PEOPLE entering once
  a.bigShare.push(100 * counts.filter(x => x >= 10).reduce((s, x) => s + x, 0) / N);   // share of the FIELD in blocks of 10+
  a.maxSeen.push(counts[0]);
  a.dupes.push(dup(entries.map(e => e.lu)));
  a.dp.push(mean(entries.map(e => projOf(e.lu))) - mean(field.map(projOf)));
  a.dOwn.push(mean(entries.map(e => ownOf(e.lu))) - mean(field.map(ownOf)));
  done++;
}
console.log(`${done} contests. Strength and ownership are the REAL field minus the generated one.\n`);
console.log("stated cap".padEnd(17) + "n".padEnd(5) + "med fee".padEnd(10) + "people".padEnd(9) + "enter once".padEnd(13)
  + "field in 10+ blocks".padEnd(21) + "biggest block".padEnd(15) + "dupes".padEnd(9) + "mean proj".padEnd(11) + "own");
for (let i = 0; i < GROUPS.length; i++) {
  const a = groups[i]; if (!a.n) continue;
  console.log(GROUPS[i][0].padEnd(17) + String(a.n).padEnd(5) + ("$" + q(a.fee, 0.5).toFixed(0)).padEnd(10)
    + q(a.users, 0.5).toFixed(0).padEnd(9) + (mean(a.onceShare).toFixed(0) + "%").padEnd(13)
    + (mean(a.bigShare).toFixed(1) + "%").padEnd(21) + q(a.maxSeen, 0.5).toFixed(0).padEnd(15)
    + (mean(a.dupes).toFixed(1) + "%").padEnd(9) + mean(a.dp).toFixed(2).padEnd(11) + mean(a.dOwn).toFixed(1));
}
