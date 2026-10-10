// Backtests from the 2026-10-08 TB@DAL showdown review, on stored post-contest data (all showdowns by default).
//  7. Low-owned captains: lineups whose captain was projected at <=5% CPT ownership vs the rest, by captain position,
//     and on the few slates where ETR's notes are saved, the captains ETR named.
//  9. Team split and captain position: 3-3 vs not, RB captain vs not, and both together.
// Outcomes are realized ROI, top-10% and top-1% finishes, with the lineup-level Welch t and a date-clustered t (per-date
// difference in mean ROI, averaged across dates), as in review-rules-nfl.mjs.
//   node bench/sd-takeaways.mjs [from] [to]      (default 2025-08-01 .. today)
// Writes data/reports/sd-takeaways.json and prints a summary.
import fs from "node:fs";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const FROM = args[0] || "2025-08-01", TO = args[1] || new Date().toISOString().slice(0, 10);
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = p => REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST");
const tierOf = fee => fee >= 300 ? "$300+" : fee >= 50 ? "$50-299" : "under $50";
const ownB = x => x <= 0.02 ? "0-2%" : x <= 0.05 ? "2-5%" : x <= 0.10 ? "5-10%" : x <= 0.20 ? "10-20%" : "20%+";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const welch = (a, b) => { if (a.length < 2 || b.length < 2) return NaN; return (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length); };
const r3 = x => Math.round(x * 1000) / 1000;

const rows = [], dates = new Set(); let contests = 0, unknownPos = 0;
const cptSeen = new Map(); // date|name -> { pown, aroi, pos } (captain ROI as Stokastic reports it, per contest, averaged)
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || c.date < FROM || c.date > TO) continue;
  if (!/showdown/i.test(c.type + " " + c.name)) continue;
  contests++; dates.add(c.date);
  const flex = new Map(), cpt = new Map();
  for (const p of j.players) (p.pos === "CPT" ? cpt : flex).set(p.id, p);
  for (const p of cpt.values()) { const k = c.date + "|" + p.name, s = cptSeen.get(k) || { name: p.name, date: c.date, pos: posOf(p), pown: [], aroi: [] }; s.pown.push(p.pown); if (p.aroi != null) s.aroi.push(p.aroi); cptSeen.set(k, s); }
  const N = j.lineups.length, t10 = Math.max(1, Math.ceil(N * 0.1)), t1 = Math.max(1, Math.ceil(N * 0.01));
  for (const l of j.lineups) {
    if (l.aroi == null || l.fin == null) continue;
    const ps = l.ids.map(id => flex.get(id) || cpt.get(id)).filter(Boolean); if (ps.length !== 6) continue;
    const flexSum = ps.reduce((s, p) => s + (flex.get(p.id)?.sal ?? p.sal), 0);
    const cp = ps.find(p => Math.abs(flexSum + 0.5 * (flex.get(p.id)?.sal ?? p.sal) - l.sal) < 1) || ps[0];
    const cptRow = cpt.get(cp.id) || cp, cptPos = posOf(cptRow); if (cptPos === "?") unknownPos++;
    const tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
    const split = Object.values(tc).sort((a, b) => b - a).join("-");
    rows.push({ date: c.date, tier: tierOf(c.fee), cptName: cptRow.name, cptPos, cptOwn: cptRow.pown ?? 0, split,
      roi: l.aroi, top10: l.fin <= t10 ? 1 : 0, top1: l.fin <= t1 ? 1 : 0 });
  }
}

function compare(rs, fn) {
  const a = rs.filter(fn), b = rs.filter(r => !fn(r));
  const byDate = new Map(); for (const r of rs) { const d = byDate.get(r.date) || { a: [], b: [] }; (fn(r) ? d.a : d.b).push(r.roi); byDate.set(r.date, d); }
  const diffs = [...byDate.values()].filter(d => d.a.length >= 20 && d.b.length >= 20).map(d => mean(d.a) - mean(d.b));
  const tClu = diffs.length >= 3 ? mean(diffs) / (sd(diffs) / Math.sqrt(diffs.length)) : NaN;
  return { nFollow: a.length, nNot: b.length, shareFollow: r3(a.length / (rs.length || 1)),
    roiFollow: r3(mean(a.map(r => r.roi))), roiNot: r3(mean(b.map(r => r.roi))),
    top10Follow: r3(mean(a.map(r => r.top10))), top10Not: r3(mean(b.map(r => r.top10))),
    top1Follow: r3(mean(a.map(r => r.top1))), top1Not: r3(mean(b.map(r => r.top1))),
    tLineup: r3(welch(a.map(r => r.roi), b.map(r => r.roi))), dates: diffs.length, datesPositive: diffs.filter(d => d > 0).length, tDate: r3(tClu) };
}
function bucket(rs, keyFn) {
  const g = {}; for (const r of rs) (g[keyFn(r)] ??= []).push(r);
  return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.length, share: r3(v.length / rs.length), roi: r3(mean(v.map(r => r.roi))), top10: r3(mean(v.map(r => r.top10))), top1: r3(mean(v.map(r => r.top1))) }]));
}

const lowOwn = r => r.cptOwn <= 0.05, is33 = r => r.split === "3-3", rbCpt = r => r.cptPos === "RB";
const holdOut = rows.filter(r => r.date !== "2026-10-08");
const tests = {};
for (const [scope, rs] of [["all", rows], ["excluding 10/08", holdOut], ...["under $50", "$50-299", "$300+"].map(t => [t, holdOut.filter(r => r.tier === t)])]) {
  tests[scope] = {
    "7. CPT projected <=5%": compare(rs, lowOwn),
    "7. RB CPT projected <=5% (vs all others)": compare(rs, r => rbCpt(r) && lowOwn(r)),
    "9. 3-3 split": compare(rs, is33),
    "9. RB captain": compare(rs, rbCpt),
    "9. RB captain + 3-3": compare(rs, r => rbCpt(r) && is33(r)),
  };
}
const byOwn = bucket(holdOut, r => ownB(r.cptOwn)), byPos = bucket(holdOut, r => r.cptPos), bySplit = bucket(holdOut, r => r.split);
const byPosLow = bucket(holdOut.filter(lowOwn), r => r.cptPos);

// ETR-named captains on the slates where the Breakdown notes were saved
const etr = [];
for (const d of fs.readdirSync("data").filter(x => /^\d{4}-\d{2}-\d{2}-nfl-/.test(x))) {
  const txt = ["etr-reads.json", "ETR-breakdown-notes.md", "slate-guide.json"].map(f => { try { return fs.readFileSync(`data/${d}/${f}`, "utf8"); } catch { return ""; } }).join("\n");
  if (!txt.trim()) continue;
  const date = d.slice(0, 10);
  for (const s of cptSeen.values()) if (s.date === date && s.pos !== "K" && mean(s.pown) <= 0.05 && txt.includes(s.name)) {
    const near = [...txt.matchAll(new RegExp(`[^.]{0,120}${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]{0,120}`, "g"))].map(m => m[0]);
    const named = near.some(x => /captain|CPT|leverage|unique|contrarian/i.test(x));
    if (named) etr.push({ date, slate: d, name: s.name, pos: s.pos, cptOwn: r3(mean(s.pown)), cptRoi: r3(mean(s.aroi)) });
  }
}

const out = { from: FROM, to: TO, contests, dates: dates.size, lineups: rows.length, unknownCptPos: unknownPos, tests, byOwn, byPos, byPosLow, bySplit, etr };
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/sd-takeaways.json", JSON.stringify(out, null, 1));

const pc = x => isNaN(x) ? "-" : (x * 100).toFixed(1) + "%";
console.log(`showdown ${FROM}..${TO}: ${contests} contests, ${dates.size} dates, ${rows.length} lineups (captain position unknown: ${unknownPos})`);
for (const [scope, t] of Object.entries(tests)) {
  console.log(`\n== ${scope}`);
  console.log("rule".padEnd(42) + "share   ROI follow / not     top10 f/n      top1 f/n       tLine  tDate (dates +)");
  for (const [k, v] of Object.entries(t)) console.log(k.padEnd(42) + pc(v.shareFollow).padStart(6) + `  ${pc(v.roiFollow).padStart(7)} / ${pc(v.roiNot).padStart(7)}   ${pc(v.top10Follow).padStart(5)} / ${pc(v.top10Not).padStart(5)}   ${pc(v.top1Follow).padStart(5)} / ${pc(v.top1Not).padStart(5)}   ${String(v.tLineup).padStart(6)} ${String(v.tDate).padStart(6)} (${v.datesPositive}/${v.dates})`);
}
for (const [name, b] of [["captain projected ownership (excl 10/08)", byOwn], ["captain position (excl 10/08)", byPos], ["captain position, projected <=5% only (excl 10/08)", byPosLow], ["team split (excl 10/08)", bySplit]]) {
  console.log(`\n== ${name}`); for (const [k, v] of Object.entries(b)) console.log(k.padEnd(10) + `share ${pc(v.share).padStart(6)}  ROI ${pc(v.roi).padStart(7)}  top10 ${pc(v.top10).padStart(5)}  top1 ${pc(v.top1).padStart(5)}  n ${v.n}`);
}
console.log(`\n== ETR-named captains projected <=5% (slates with saved ETR notes)`);
if (!etr.length) console.log("none found"); for (const e of etr) console.log(`${e.date} ${e.name.padEnd(20)} ${e.pos.padEnd(4)} CPT own ${pc(e.cptOwn).padStart(6)}  CPT ROI ${pc(e.cptRoi).padStart(8)}`);
console.log("\nwrote data/reports/sd-takeaways.json");
