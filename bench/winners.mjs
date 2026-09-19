// Winner profiles, Stokastic "spy the winners" style, on the pulled contests: how the 1st-place
// lineup (and the top 1%) is built versus the whole field - pitcher ownership, stack shape,
// ownership sum, salary left, projection rank, duplicates. Share among winners vs share of the
// field gives the lift. Not selection-biased by user.
//   node bench/winners.mjs mlb [minFee=0] [maxFee=1e9]      node bench/winners.mjs nfl_sd
import { listContests, loadPulled } from "./grade-all.mjs";
import { stackOf } from "../src/engine/lineups.mjs";
const [fkey = "mlb_cl", minFee = 0, maxFee = 1e9] = process.argv.slice(2);
const contests = listContests().filter(c => c.fkey === (fkey === "mlb" ? "mlb_cl" : fkey) && c.json && c.fee >= +minFee && c.fee <= +maxFee);
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1), med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const W = [], T = [], FLD = []; let n = 0;
for (const c of contests) {
  const { pool, entries } = loadPulled(c.json), P = pool.players, f = pool.format, N = entries.length; if (N < 20) continue; n++;
  const projRank = new Map(); entries.slice().sort((a, b) => b.stkFP - a.stkFP).forEach((e, i) => projRank.set(e, i / (N - 1)));
  const feat = e => {
    const ps = e.lu.map(id => P[id]), pits = ps.filter(p => p.isP), hits = ps.filter(p => !p.isP);
    const own = p => (f.mult && e.lu[0] === p.i) ? (p.cown || 0) : (p.own || 0);
    const sh = stackOf(e.lu, P, f), parts = String(sh).split("-").map(Number);
    return { pitMin: pits.length ? Math.min(...pits.map(own)) : null, pitMax: pits.length ? Math.max(...pits.map(own)) : null, cptOwn: f.mult ? own(P[e.lu[0]]) : null, cptPos: f.mult ? P[e.lu[0]].pos : null,
      primary: parts[0] || 0, secondary: parts[1] || 0, shape: sh, ownsum: e.own, salLeft: 50000 - e.sal, projPct: projRank.get(e), dup: e.dupes > 0 ? 1 : 0, teams: new Set(hits.map(p => p.team)).size,
      minOwn: Math.min(...ps.map(own)), maxOwn: Math.max(...ps.map(own)), under5: ps.filter(p => own(p) < 5).length, over25: ps.filter(p => own(p) > 25).length,
      qb: (() => { const q = ps.find(p => p.pos === "QB"); if (!q) return null; const mates = ps.filter(p => p !== q && p.team === q.team && !["DST", "K"].includes(p.pos)).length, back = ps.filter(p => p.team === q.opp && !["DST", "K"].includes(p.pos)).length; return { own: own(q), sal: q.sal, mates, back }; })(),
      te: (() => { const t = ps.filter(p => p.pos === "TE"); return t.length ? Math.min(...t.map(p => p.sal)) : null; })(), dst: (() => { const d = ps.find(p => p.pos === "DST"); return d ? d.sal : null; })(),
      six: f.mult ? Object.values(ps.reduce((a, p) => { a[p.team] = (a[p.team] || 0) + 1; return a; }, {})).sort((a, b) => b - a).join("-") : null };
  };
  const byFin = entries.slice().sort((a, b) => a.finish - b.finish || b.actFP - a.actFP), k = Math.max(1, Math.round(N / 100));
  W.push(feat(byFin[0])); for (const e of byFin.slice(0, k)) T.push(feat(e)); for (const e of entries) FLD.push(feat(e));
}
console.log(`${fkey}: ${n} contests${+minFee || +maxFee < 1e9 ? ` (fee $${minFee}-${maxFee >= 1e9 ? "" : maxFee})` : ""}, ${W.length} winners, ${T.length} top-1% entries, ${FLD.length} field entries`);
const pct = x => (100 * x).toFixed(0) + "%";
const row = (lab, pred) => { const w = mean(W.map(x => pred(x) ? 1 : 0)), t = mean(T.map(x => pred(x) ? 1 : 0)), fl = mean(FLD.map(x => pred(x) ? 1 : 0)); console.log(lab.padEnd(44) + pct(w).padStart(8) + pct(t).padStart(9) + pct(fl).padStart(8) + (fl ? (t / fl).toFixed(2) + "x" : "-").padStart(9)); };
console.log("\ntrait".padEnd(44) + "winners".padStart(8) + "top 1%".padStart(9) + "field".padStart(8) + "lift".padStart(9));
if (fkey === "mlb_cl" || fkey === "mlb") {
  for (const [lab, lo, hi] of [["<10%", 0, 10], ["10-20%", 10, 20], ["20-35%", 20, 35], ["35%+", 35, 1e9]]) row(`lowest-owned pitcher ${lab}`, x => x.pitMin >= lo && x.pitMin < hi);
  for (const [lab, lo, hi] of [["<15%", 0, 15], ["15-30%", 15, 30], ["30-45%", 30, 45], ["45%+", 45, 1e9]]) row(`highest-owned pitcher ${lab}`, x => x.pitMax >= lo && x.pitMax < hi);
  row("both pitchers under 20% owned", x => x.pitMax < 20);
} else if (fkey === "nfl_sd") {
  for (const [lab, lo, hi] of [["<3%", 0, 3], ["3-8%", 3, 8], ["8-15%", 8, 15], ["15%+", 15, 1e9]]) row(`captain ownership ${lab}`, x => x.cptOwn >= lo && x.cptOwn < hi);
  for (const p of ["QB", "RB", "WR", "TE", "K", "DST"]) row(`captain ${p}`, x => x.cptPos === p);
}
for (const [lab, pred] of [["primary stack 5", x => x.primary === 5], ["primary stack 4", x => x.primary === 4], ["primary stack <=3", x => x.primary <= 3], ["5-3", x => x.primary === 5 && x.secondary === 3], ["5-2", x => x.primary === 5 && x.secondary === 2], ["5-1 / 5 only", x => x.primary === 5 && x.secondary <= 1], ["4-4", x => x.primary === 4 && x.secondary === 4], ["4-3", x => x.primary === 4 && x.secondary === 3]]) if (fkey === "mlb_cl" || fkey === "mlb") row(lab, pred);
if (fkey === "nfl_sd") for (const [lab, pred] of [["4-2 (all six spots)", x => x.six === "4-2"], ["3-3", x => x.six === "3-3"], ["5-1", x => x.six === "5-1"], ["6-0", x => x.six === "6"]]) row(lab, pred);
if (fkey === "nfl_cl" || fkey === "cfb_cl") {
  for (const [lab, lo, hi] of [["<5%", 0, 5], ["5-10%", 5, 10], ["10-20%", 10, 20], ["20%+", 20, 1e9]]) row("QB ownership " + lab, x => x.qb && x.qb.own >= lo && x.qb.own < hi);
  for (const [lab, lo, hi] of [["< $5,500", 0, 5500], ["$5,500-6,499", 5500, 6500], ["$6,500-7,499", 6500, 7500], ["$7,500+", 7500, 1e9]]) row("QB salary " + lab, x => x.qb && x.qb.sal >= lo && x.qb.sal < hi);
  for (const n of [0, 1, 2]) row("QB + " + n + " teammate" + (n === 1 ? "" : "s"), x => x.qb && x.qb.mates === n); row("QB + 3 or more teammates", x => x.qb && x.qb.mates >= 3);
  row("bring-back from the QB's opponent", x => x.qb && x.qb.back >= 1); row("QB + 2 with bring-back", x => x.qb && x.qb.mates === 2 && x.qb.back >= 1);
  row("TE under $4,000", x => x.te != null && x.te < 4000); row("DST under $3,000", x => x.dst != null && x.dst < 3000);
}
row("duplicated in field", x => x.dup === 1);
row("projection in field's top 10%", x => x.projPct <= 0.10);
row("projection in field's top half", x => x.projPct <= 0.50);
row("projection in field's bottom half", x => x.projPct > 0.50);
row("has a player under 5% owned", x => x.under5 >= 1);
row("has 2+ players under 5% owned", x => x.under5 >= 2);
row("has 3+ players over 25% owned", x => x.over25 >= 3);
row("salary left >= $500", x => x.salLeft >= 500);
console.log("\nmedians".padEnd(44) + "winners".padStart(8) + "top 1%".padStart(9) + "field".padStart(8));
const MED = (fkey === "nfl_cl" || fkey === "cfb_cl") ? [["ownership sum", "ownsum"], ["salary left", "salLeft"], ["projection percentile (0 = best)", "projPct"], ["lowest-owned player %", "minOwn"]] : fkey === "nfl_sd" ? [["ownership sum", "ownsum"], ["salary left", "salLeft"], ["captain ownership %", "cptOwn"], ["projection percentile (0 = best)", "projPct"], ["lowest-owned player %", "minOwn"]] : [["ownership sum", "ownsum"], ["salary left", "salLeft"], ["lowest-owned pitcher %", "pitMin"], ["highest-owned pitcher %", "pitMax"], ["projection percentile (0 = best)", "projPct"], ["hitter teams", "teams"], ["lowest-owned player %", "minOwn"]];
if (fkey === "nfl_cl" || fkey === "cfb_cl") { const q = a => a.filter(x => x.qb); console.log("QB ownership % (median)".padEnd(44) + med(q(W).map(x => x.qb.own)).toFixed(1).padStart(8) + med(q(T).map(x => x.qb.own)).toFixed(1).padStart(9) + med(q(FLD).map(x => x.qb.own)).toFixed(1).padStart(8)); console.log("QB salary (median)".padEnd(44) + med(q(W).map(x => x.qb.sal)).toFixed(0).padStart(8) + med(q(T).map(x => x.qb.sal)).toFixed(0).padStart(9) + med(q(FLD).map(x => x.qb.sal)).toFixed(0).padStart(8)); }
for (const [lab, k] of MED) { const v = a => a.map(x => x[k]).filter(x => x != null); if (v(W).length) console.log(lab.padEnd(44) + med(v(W)).toFixed(k === "projPct" ? 2 : 0).padStart(8) + med(v(T)).toFixed(k === "projPct" ? 2 : 0).padStart(9) + med(v(FLD)).toFixed(k === "projPct" ? 2 : 0).padStart(8)); }
