// The exact payout table, straight from DraftKings, instead of a curve fitted from a typed field
// size and rake. api.draftkings.com/contests/v1/contests/<id> returns payoutSummary as position
// ranges with a cash value, which expands to one payout per finishing place.
// Validated here against the true curve recovered from every entry's realised ROI in the pulled
// contests, which is the same thing measured a completely different way.
//   node bench/dk-payouts.mjs [cfb_cl] [--n=12]
import { listContests, loadPulled } from "./grade-all.mjs";
const FKEY = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "cfb_cl";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LIM = flag("n") || 12;

// one payout per finishing position, in units of the entry fee
export async function dkPayouts(contestId, fee) {
  const r = await fetch(`https://api.draftkings.com/contests/v1/contests/${contestId}?format=json`,
    { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  const sum = ((j.contestDetail || j).payoutSummary) || j.payoutSummary;
  if (!Array.isArray(sum) || !sum.length) return null;
  let last = 0;
  for (const t of sum) last = Math.max(last, +t.maxPosition || 0);
  const pay = new Float64Array(last);
  for (const t of sum) {
    const lo = +t.minPosition || 1, hi = +t.maxPosition || lo;
    const d = (t.payoutDescriptions || []).find(x => x.value > 0);
    const cash = d ? +d.value : parseFloat(String((t.tierPayoutDescriptions || {}).Cash || "").replace(/[$,]/g, ""));
    if (!(cash > 0)) continue;
    for (let i = lo; i <= hi; i++) pay[i - 1] = cash / (fee || 1);
  }
  return pay;
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const isMain = !!(process.argv[1] && /dk-payouts\.mjs$/.test(process.argv[1]));
if (isMain) {
const cs = listContests().filter(c => c.json && c.fkey === FKEY).sort((a, b) => a.date.localeCompare(b.date));
const pick = [];
for (let i = 0; i < cs.length && pick.length < LIM; i += Math.max(1, Math.floor(cs.length / LIM))) pick.push(cs[i]);
console.log(`${pick.length} contests sampled across ${cs[0].date} to ${cs[cs.length - 1].date}\n`);
console.log("date".padEnd(12) + "fee".padEnd(7) + "entries".padEnd(9) + "DK paid".padEnd(10) + "true paid".padEnd(11) + "1st DK/true".padEnd(16) + "mean abs diff");
let ok = 0, fail = 0; const diffs = [];
for (const c of pick) {
  const { entries, payouts, paid } = loadPulled(c.json);
  let pay = null;
  try { pay = await dkPayouts(c.key, c.fee || 1); } catch { /* network */ }
  if (!pay) { console.log(c.date.padEnd(12) + String(c.fee).padEnd(7) + String(entries.length).padEnd(9) + "no answer"); fail++; continue; }
  ok++;
  const n = Math.min(pay.length, payouts.length);
  let d = 0, k = 0;
  for (let i = 0; i < Math.max(paid, pay.length); i++) { d += Math.abs((pay[i] || 0) - (payouts[i] || 0)); k++; }
  diffs.push(d / (k || 1));
  console.log(c.date.padEnd(12) + String(c.fee).padEnd(7) + String(entries.length).padEnd(9) + String(pay.filter(x => x > 0).length).padEnd(10)
    + String(paid).padEnd(11) + `${pay[0].toFixed(0)}/${payouts[0].toFixed(0)}`.padEnd(16) + (d / (k || 1)).toFixed(3));
  await new Promise(r => setTimeout(r, 250));
}
console.log(`\n${ok} answered, ${fail} did not. Mean absolute difference per position: ${mean(diffs).toFixed(3)} entry fees`);
}
