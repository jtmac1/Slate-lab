// Backtests from the 2026-10-04 review, on stored post-contest data (default: the 2025 season, out of sample).
//  6. Chalk risk: lineups with 3+ chalk players (projected own >= 20%, i.e. known before lock) when the slate's chalk is
//     concentrated in one game (3+ of the 6 most-owned players from one game), and the plain "cap chalk at 2" rule.
//  9. Showdown: kicker in the lineup, in general and when the captain is a chalk RB.
// Outcomes are realized ROI, top-10% and top-1% finishes. Contests on the same date share player outcomes, so besides
// the lineup-level Welch t we report a date-clustered t: the per-date difference in mean ROI, averaged across dates.
//   node bench/review-rules-nfl.mjs [from] [to]      (default 2025-08-01 .. 2026-03-01)
// Writes data/reports/review-rules-nfl.json and prints a summary.
import fs from "node:fs";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const FROM = args[0] || "2025-08-01", TO = args[1] || "2026-03-01", CHALK = 0.2;
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const tierOf = fee => fee >= 300 ? "$300+" : fee >= 50 ? "$50-299" : "under $50";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const welch = (a, b) => { if (a.length < 2 || b.length < 2) return NaN; return (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length); };
const game = p => [p.team, p.opp].sort().join("@");

const rows = { classic: [], showdown: [] }, contests = { classic: 0, showdown: 0 }, slateInfo = new Map();
let kickerContests = 0;
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || c.date < FROM || c.date > TO) continue;
  const isSd = /showdown/i.test(c.type + " " + c.name), N = j.lineups.length;
  const t10 = Math.max(1, Math.ceil(N * 0.1)), t1 = Math.max(1, Math.ceil(N * 0.01));
  if (!isSd) {
    const P = new Map(j.players.map(p => [p.id, p]));
    const top6 = j.players.filter(p => p.team).slice().sort((a, b) => b.pown - a.pown).slice(0, 6), gc = {};
    for (const p of top6) gc[game(p)] = (gc[game(p)] || 0) + 1;
    const [cGame, cN] = Object.entries(gc).sort((a, b) => b[1] - a[1])[0] || [null, 0], conc = cN >= 3;
    slateInfo.set(c.date + "|" + c.key, { conc, cGame, cN });
    contests.classic++;
    for (const l of j.lineups) {
      if (l.aroi == null || l.fin == null) continue;
      const ps = l.ids.map(id => P.get(id)).filter(Boolean), ch = ps.filter(p => p.pown >= CHALK);
      rows.classic.push({ date: c.date, key: c.key, tier: tierOf(c.fee), N, conc, chalk: ch.length, chalkInGame: ch.filter(p => game(p) === cGame).length,
        roi: l.aroi, top10: l.fin <= t10 ? 1 : 0, top1: l.fin <= t1 ? 1 : 0 });
    }
  } else {
    const flex = new Map(), cpt = new Map();
    for (const p of j.players) (p.pos === "CPT" ? cpt : flex).set(p.id, p);
    const posOf = p => REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST");
    const hasK = [...flex.values()].some(p => posOf(p) === "K"); if (hasK) kickerContests++;
    // chalk RB captain: an RB whose projected captain ownership is the highest among RBs and 15%+
    const rbCpts = [...cpt.values()].filter(p => posOf(p) === "RB").sort((a, b) => b.pown - a.pown);
    contests.showdown++;
    for (const l of j.lineups) {
      if (l.aroi == null || l.fin == null) continue;
      const ps = l.ids.map(id => flex.get(id) || cpt.get(id)).filter(Boolean);
      const flexSum = ps.reduce((s, p) => s + (flex.get(p.id)?.sal ?? p.sal), 0);
      const cp = ps.find(p => Math.abs(flexSum + 0.5 * (flex.get(p.id)?.sal ?? p.sal) - l.sal) < 1) || ps[0];
      const cptRow = cpt.get(cp.id) || cp, cptPos = posOf(cptRow);
      const kN = ps.filter(p => posOf(p) === "K").length;
      const chalkRbCpt = cptPos === "RB" && cptRow.pown >= 0.15;
      rows.showdown.push({ date: c.date, key: c.key, tier: tierOf(c.fee), N, hasK, k: kN > 0, cptPos, chalkRbCpt, cptK: cptPos === "K",
        roi: l.aroi, top10: l.fin <= t10 ? 1 : 0, top1: l.fin <= t1 ? 1 : 0 });
    }
  }
}

// one comparison: lineups that follow `fn` vs those that don't, within `scope`
function compare(rs, fn) {
  const a = rs.filter(fn), b = rs.filter(r => !fn(r));
  const byDate = new Map(); for (const r of rs) { const d = byDate.get(r.date) || { a: [], b: [] }; (fn(r) ? d.a : d.b).push(r.roi); byDate.set(r.date, d); }
  const diffs = [...byDate.values()].filter(d => d.a.length >= 20 && d.b.length >= 20).map(d => mean(d.a) - mean(d.b));
  const tClu = diffs.length >= 3 ? mean(diffs) / (sd(diffs) / Math.sqrt(diffs.length)) : NaN;
  const r2 = x => Math.round(x * 1000) / 1000;
  return { nFollow: a.length, nNot: b.length, shareFollow: r2(a.length / (rs.length || 1)),
    roiFollow: r2(mean(a.map(r => r.roi))), roiNot: r2(mean(b.map(r => r.roi))),
    top10Follow: r2(mean(a.map(r => r.top10))), top10Not: r2(mean(b.map(r => r.top10))),
    top1Follow: r2(mean(a.map(r => r.top1))), top1Not: r2(mean(b.map(r => r.top1))),
    tLineup: r2(welch(a.map(r => r.roi), b.map(r => r.roi))), dates: diffs.length, datesPositive: diffs.filter(d => d > 0).length, tDate: r2(tClu) };
}
const out = { from: FROM, to: TO, at: new Date().toISOString(), contests, kickerContests, chalkDef: "projected ownership >= 20%", concentratedDef: "3+ of the 6 highest projected-owned players from one game", classic: {}, showdown: {} };
const C = rows.classic, tiers = ["all", "$300+", "$50-299", "under $50"], inTier = (rs, t) => t === "all" ? rs : rs.filter(r => r.tier === t);
out.slates = { classicContests: slateInfo.size, concentrated: [...slateInfo.values()].filter(s => s.conc).length };
for (const t of tiers) {
  const rs = inTier(C, t);
  out.classic[t] = {
    "3+ chalk, concentrated slates": compare(rs.filter(r => r.conc), r => r.chalk >= 3),
    "3+ chalk, other slates": compare(rs.filter(r => !r.conc), r => r.chalk >= 3),
    "2+ chalk from the concentrated game (conc. slates)": compare(rs.filter(r => r.conc), r => r.chalkInGame >= 2),
    "cap chalk at 2 (all slates)": compare(rs, r => r.chalk <= 2),
  };
}
const S = rows.showdown;
for (const t of tiers) {
  const rs = inTier(S, t).filter(r => r.hasK);
  out.showdown[t] = {
    "kicker in lineup": compare(rs, r => r.k),
    "kicker in lineup, chalk RB captain": compare(rs.filter(r => r.chalkRbCpt), r => r.k),
    "chalk RB captain (vs any other captain)": compare(rs, r => r.chalkRbCpt),
  };
}
fs.writeFileSync("data/reports/review-rules-nfl.json", JSON.stringify(out, null, 1));
const fmt = (name, o) => `${name.padEnd(52)} n=${String(o.nFollow).padStart(7)} (${(o.shareFollow * 100).toFixed(0)}%) ROI ${(o.roiFollow * 100).toFixed(1)}% vs ${(o.roiNot * 100).toFixed(1)}% | top10 ${(o.top10Follow * 100).toFixed(1)} vs ${(o.top10Not * 100).toFixed(1)} | top1 ${(o.top1Follow * 100).toFixed(2)} vs ${(o.top1Not * 100).toFixed(2)} | t ${o.tLineup} | dates ${o.datesPositive}/${o.dates} tDate ${o.tDate}`;
console.log(`contests: classic ${contests.classic} (${out.slates.concentrated} with concentrated chalk), showdown ${contests.showdown} (${kickerContests} with a kicker identified)`);
for (const sec of ["classic", "showdown"]) for (const t of tiers) { console.log(`\n== ${sec} ${t}`); for (const [k, o] of Object.entries(out[sec][t])) console.log(fmt(k, o)); }
