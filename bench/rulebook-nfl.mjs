// NFL rulebook from the archive, with t-stats: for every candidate construction rule, the realized ROI
// and top-1% rate of the lineups that follow it against the lineups that do not, per format and fee
// tier, with a Welch t on ROI and the sign checked on both halves of the window. A rule is KEPT when
// |t| >= 3 overall, both halves agree in sign, and each side has 300+ lineups. Also reports how often
// the user's own entries follow each rule. Pure data from data/post/nfl, no projections, no sims.
//   node bench/rulebook-nfl.mjs [from] [to] [--user=jtmac1999] [--minfee=20]
// Writes data/reports/rulebook-nfl.md and prints it.
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--")), flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const JROWS = [];
const USER = flag("user") || "jtmac1999", MINFEE = +(flag("minfee") || 20), FROM = args[0] || "2025-09-01", TO = args[1] || "2099-12-31";
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = p => p.pos && p.pos !== "CPT" && p.pos !== "FLEX" ? p.pos : (REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST"));
const tierOf = fee => fee < 100 ? "$20-99" : fee < 300 ? "$100-299" : "$300+";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const welch = (a, b) => { if (a.length < 2 || b.length < 2) return NaN; const ma = mean(a), mb = mean(b), va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1); return (ma - mb) / Math.sqrt(va / a.length + vb / b.length); };

function feats(l, j, sd, rankOf, cut) {
  const P = j.byId, ps = l.ids.map(id => P.get(id)).filter(Boolean);
  const own = l.own * 100, chalk = ps.filter(p => (p.aown || 0) >= 0.2).length;
  const tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
  const split = Object.values(tc).sort((a, b) => b - a).join("-");
  const f = { roi: l.aroi, top1: l.fin <= cut ? 1 : 0, cash: l.aroi > -1 ? 1 : 0, left: 50000 - l.sal, own, chalk, dup: l.dup > 0, simPct: rankOf(l), teams: Object.keys(tc).length, split, mine: l.u === USER };
  if (sd) {
    const flexSum = ps.reduce((s, p) => s + (p.flexSal ?? p.sal), 0);
    const cpt = ps.find(p => Math.abs(flexSum + 0.5 * (p.flexSal ?? p.sal) - l.sal) < 1) || ps[0];
    f.cptPos = posOf(cpt); f.cptOwn = (j.cptOwn.get(cpt.id) ?? cpt.aown ?? 0) * 100;
    f.hasQB = ps.some(p => posOf(p) === "QB"); f.hasK = ps.some(p => posOf(p) === "K"); f.hasDST = ps.some(p => posOf(p) === "DST");
    const qb = ps.find(p => posOf(p) === "QB"); f.qbStacked = !!qb && ps.some(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p)));
    f.dstVsOwnQB = !!qb && ps.some(p => posOf(p) === "DST" && p.team === qb.opp);
  } else {
    const qb = ps.find(p => posOf(p) === "QB");
    f.stack = qb ? ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p))).length : 0;
    f.bring = !!qb && ps.some(p => p.team === qb.opp && posOf(p) !== "DST");
    f.rbDst = ps.some(p => posOf(p) === "DST" && ps.some(q => posOf(q) === "RB" && q.team === p.team));
    f.dstVsOwnQB = !!qb && ps.some(p => posOf(p) === "DST" && p.team === qb.opp);
    f.maxTeam = Math.max(...Object.values(tc));
    // ETR "How to Win NFL DFS Tournaments in 2026" tips (data/strategy/nfl-classic-playbook.json)
    const n = pos => ps.filter(p => posOf(p) === pos).length, spend = pos => ps.filter(p => posOf(p) === pos).reduce((s, p) => s + (p.sal || 0), 0);
    f.rbN = n("RB"); f.wrN = n("WR"); f.teN = n("TE");
    f.rbSpend = spend("RB"); f.teSpend = spend("TE"); f.wrSpend = spend("WR"); f.qbSal = qb ? qb.sal || 0 : 0; f.dstSal = spend("DST");
    f.bringN = qb ? ps.filter(p => p.team === qb.opp && posOf(p) !== "DST").length : 0;
    f.qbId = f.stack >= 1 ? qb.id : null; f.oppIds = qb ? ps.filter(p => p.team === qb.opp && posOf(p) !== "DST").map(p => p.id) : [];
    f.sub1 = ps.filter(p => (p.aown || 0) < 0.01).length; f.sub5 = ps.filter(p => (p.aown || 0) < 0.05).length; f.mid510 = ps.filter(p => (p.aown || 0) >= 0.05 && (p.aown || 0) < 0.10).length;
    const dst = ps.find(p => posOf(p) === "DST"); f.rbDstPair = dst ? ps.filter(p => posOf(p) === "RB" && p.team === dst.team).map(p => [p.id, dst.id]) : [];
  }
  return f;
}
const RULES = {
  classic: [
    ["QB + 1 pass catcher or more", f => f.stack >= 1], ["QB + 2 pass catchers or more", f => f.stack >= 2], ["QB + 3 or more", f => f.stack >= 3],
    ["bring-back from the QB's opponent", f => f.bring], ["RB with his own DST", f => f.rbDst], ["DST facing own QB (should be bad)", f => f.dstVsOwnQB],
    ["salary left >= $100", f => f.left >= 100], ["salary left >= $300", f => f.left >= 300], ["salary left >= $600", f => f.left >= 600],
    ["own sum < 200%", f => f.own < 200], ["own sum 200-260%", f => f.own >= 200 && f.own < 260], ["own sum >= 260%", f => f.own >= 260],
    ["4+ players at 20%+ owned", f => f.chalk >= 4], ["0-2 players at 20%+ owned", f => f.chalk <= 2],
    // slate-relative versions (2026-10-09): the fixed cutoffs can't be met on flat slates (10/11 Main: 7 players at 20%+,
    // no pool lineup reached 200%), so test ownership against this contest's own field instead
    ["own sum above the contest median", f => f.ownPct > 0.5], ["own sum in the contest's top 30%", f => f.ownPct >= 0.7], ["own sum in the contest's bottom 30%", f => f.ownPct <= 0.3],
    ["chalk count above the contest median", f => f.chalk > f.chalkMed], ["chalk count below the contest median", f => f.chalk < f.chalkMed],
    ["not duplicated", f => !f.dup], ["Stokastic sim top decile", f => f.simPct <= 0.1], ["Stokastic sim top half", f => f.simPct <= 0.5], ["Stokastic sim bottom quarter", f => f.simPct >= 0.75],
    ["max 3 from one team", f => f.maxTeam <= 3], ["4+ from one team", f => f.maxTeam >= 4], ["5 or fewer teams", f => f.teams <= 5],
    ["ETR: RB in the flex (3 RBs)", f => f.rbN >= 3], ["ETR: WR in the flex (4 WRs)", f => f.wrN >= 4], ["ETR: TE in the flex (2 TEs)", f => f.teN >= 2],
    ["ETR: RB spend above contest median", f => f.rbHi], ["ETR: TE spend above contest median", f => f.teHi], ["ETR: WR spend below contest median", f => f.wrLo], ["ETR: QB salary below contest median", f => f.qbLo],
    ["ETR: QB under $6,000", f => f.qbSal > 0 && f.qbSal < 6000], ["ETR: QB $7,000+", f => f.qbSal >= 7000],
    ["ETR: spend up RB+TE, down WR+QB (all four)", f => f.rbHi && f.teHi && f.wrLo && f.qbLo],
    ["ETR: naked QB (no stack)", f => f.stack === 0], ["ETR: QB + exactly 1 (single stack)", f => f.stack === 1], ["ETR: QB + exactly 2 (double stack)", f => f.stack === 2],
    ["ETR: double bring-back (2+ from opponent)", f => f.bringN >= 2], ["ETR: onslaught + bring-back", f => f.stack >= 3 && f.bringN >= 1],
    ["ETR: DST $3,000+", f => f.dstSal >= 3000], ["ETR: DST spend above contest median", f => f.dstHi], ["ETR: DST $2,500 or less", f => f.dstSal > 0 && f.dstSal <= 2500],
    ["ETR: RB + own DST, pair under 30% of the RB's lineups", f => f.rbDstLev === true], ["ETR: RB + own DST, pair 30%+ of the RB's lineups", f => f.rbDstLev === false],
    ["ETR: any player under 1% owned", f => f.sub1 >= 1], ["ETR: 1-2 players under 5%", f => f.sub5 >= 1 && f.sub5 <= 2], ["ETR: 3+ players under 5%", f => f.sub5 >= 3], ["ETR: no player under 5%", f => f.sub5 === 0],
    ["ETR: 3+ players at 5-10% owned", f => f.mid510 >= 3],
    ["ETR: chalk combo, most common pair in 15%+ of field", f => f.maxPair >= 0.15], ["ETR: no pair in 8%+ of field", f => f.maxPair < 0.08],
    // scoped rules (third element): compared only among QB stacks whose QB has an obvious bring-back
    ["ETR BB: stack takes the obvious bring-back (vs fading it)", f => f.chalkBB === true, f => f.chalkBB != null],
    ["ETR BB: fades it for a different bring-back", f => f.chalkBB === false && f.bringN >= 1, f => f.chalkBB != null],
    ["ETR BB: fades it, no bring-back at all", f => f.chalkBB === false && f.bringN === 0, f => f.chalkBB != null],
    ["ETR BB: fades it and plays 3 RBs", f => f.chalkBB === false && f.rbN >= 3, f => f.chalkBB != null],
    ["ETR BB: takes it when 60%+ of the QB's stacks do", f => f.chalkBB === true, f => f.chalkBB != null && f.chalkBBShare >= 0.6],
  ],
  showdown: [
    ["5-1 split", f => f.split === "5-1"], ["4-2 split", f => f.split === "4-2"], ["3-3 split", f => f.split === "3-3"],
    ["CPT is a QB", f => f.cptPos === "QB"], ["CPT is a WR", f => f.cptPos === "WR"], ["CPT is a RB", f => f.cptPos === "RB"], ["CPT is a TE", f => f.cptPos === "TE"], ["CPT is K or DST", f => f.cptPos === "K" || f.cptPos === "DST"],
    ["CPT ownership < 10%", f => f.cptOwn < 10], ["CPT ownership >= 20%", f => f.cptOwn >= 20],
    ["has a QB", f => f.hasQB], ["QB with a pass catcher", f => f.qbStacked], ["has a kicker", f => f.hasK], ["has a DST", f => f.hasDST], ["DST facing own QB (should be bad)", f => f.dstVsOwnQB],
    ["salary left >= $300", f => f.left >= 300], ["salary left >= $1000", f => f.left >= 1000],
    ["own sum < 180%", f => f.own < 180], ["own sum >= 220%", f => f.own >= 220], ["4+ players at 20%+ owned", f => f.chalk >= 4],
    ["not duplicated", f => !f.dup], ["Stokastic sim top decile", f => f.simPct <= 0.1], ["Stokastic sim top half", f => f.simPct <= 0.5], ["Stokastic sim bottom quarter", f => f.simPct >= 0.75],
  ]
};
const data = { classic: [], showdown: [] }; let nC = 0; const dates = [];
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || c.fee < MINFEE || c.date < FROM || c.date > TO) continue;
  const sd = /showdown/i.test(c.type + " " + c.name); nC++; dates.push(c.date);
  j.byId = new Map(); j.cptOwn = new Map();
  for (const p of j.players) { if (p.pos === "CPT") { j.cptOwn.set(p.id, p.aown); if (!j.byId.has(p.id)) j.byId.set(p.id, p); } else j.byId.set(p.id, Object.assign({}, p, { flexSal: p.sal })); }
  const L = j.lineups, N = L.length, cut = Math.max(1, Math.ceil(N * 0.01));
  const order = L.slice().sort((a, b) => b.sroi - a.sroi), rank = new Map(order.map((l, i) => [l, i])), rankOf = l => rank.get(l) / N;
  const games = new Set(j.players.map(p => p.team).filter(Boolean)).size / 2, fs_ = [];
  for (const l of L) { if (l.aroi == null) continue; const ft = feats(l, j, sd, rankOf, cut); ft.tier = tierOf(c.fee); ft.date = c.date; ft.N = N; ft.games = games; ft._l = l; fs_.push(ft); data[sd ? "showdown" : "classic"].push(ft); }
  if (!sd && fs_.length) {
    // spend vs this contest's median lineup, and how common each lineup's player pairs are in this field
    const med = k => { const v = fs_.map(f => f[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    // ownership vs this contest's own field: percentile of the lineup's own sum, and the field's median chalk count
    const ownSorted = fs_.map(f => f.own).sort((a, b) => a - b), below = v => { let lo = 0, hi = ownSorted.length; while (lo < hi) { const m2 = (lo + hi) >> 1; if (ownSorted[m2] < v) lo = m2 + 1; else hi = m2; } return lo; };
    const chalkMed = med("chalk"), fieldChalk = j.players.filter(p => p.pos !== "CPT" && (p.aown || 0) >= 0.2).length;
    for (const f of fs_) { f.ownPct = below(f.own) / ownSorted.length; f.chalkMed = chalkMed; f.fieldChalk = fieldChalk; }
    const m = { rb: med("rbSpend"), te: med("teSpend"), wr: med("wrSpend"), qb: med("qbSal"), dst: med("dstSal") };
    const single = new Map(), pair = new Map(), key = (a, b) => a < b ? a + "|" + b : b + "|" + a;
    for (const l of L) { const ids = l.ids.filter(Boolean); for (let i = 0; i < ids.length; i++) { single.set(ids[i], (single.get(ids[i]) || 0) + 1); for (let k = i + 1; k < ids.length; k++) { const q = key(ids[i], ids[k]); pair.set(q, (pair.get(q) || 0) + 1); } } }
    for (const f of fs_) {
      f.rbHi = f.rbSpend > m.rb; f.teHi = f.teSpend > m.te; f.wrLo = f.wrSpend < m.wr; f.qbLo = f.qbSal < m.qb; f.dstHi = f.dstSal > m.dst;
      const ids = f._l.ids.filter(Boolean); let mx = 0; for (let i = 0; i < ids.length; i++) for (let k = i + 1; k < ids.length; k++) mx = Math.max(mx, pair.get(key(ids[i], ids[k])) || 0);
      f.maxPair = mx / N;
      f.rbDstLev = f.rbDstPair.length ? f.rbDstPair.every(([rb, d]) => (pair.get(key(rb, d)) || 0) / (single.get(rb) || 1) < 0.3) : null;
    }
    // Leone, "When Is a Chalk Bring-Back Worth It?": for each stacked QB, the obvious bring-back is the opposing player
    // most often paired with him in this field; "obvious" when 40%+ of that QB's stacked lineups carry him
    const byQB = new Map();
    for (const f of fs_) if (f.qbId) { const q = byQB.get(f.qbId) || { n: 0, opp: new Map() }; q.n++; for (const o of f.oppIds) q.opp.set(o, (q.opp.get(o) || 0) + 1); byQB.set(f.qbId, q); }
    for (const f of fs_) {
      f.chalkBB = null; if (!f.qbId) continue; const q = byQB.get(f.qbId); if (q.n < 5) continue;
      let top = null, c = 0; for (const [o, k] of q.opp) if (k > c) { top = o; c = k; }
      if (top && c / q.n >= 0.4) { f.chalkBB = f.oppIds.includes(top); f.chalkBBShare = c / q.n; }
    }
  }
  for (const f of fs_) { delete f._l; delete f.rbDstPair; delete f.qbId; delete f.oppIds; }
}
dates.sort(); const mid = dates[Math.floor(dates.length / 2)];
const out = [`# NFL rulebook from the archive: ${nC} contests ($${MINFEE}+), ${dates[0]} to ${dates[dates.length - 1]}`, "", "ROI is the lineup's realized return; top-1% is the share of lineups finishing in the top 1% of their contest. t is Welch's t on ROI (follow vs not). KEPT = |t| >= 3, same sign in both halves of the window (split at " + mid + "), 300+ lineups each side. Lift = top-1% rate following / not following.", ""];
for (const fmt of ["classic", "showdown"]) {
  const rows = data[fmt]; if (!rows.length) continue;
  const SEG = { "small field (2,000 or fewer)": r => r.N <= 2000, "large field (5,000+)": r => r.N >= 5000, "short slate (8 games or fewer)": r => r.games <= 8, "long slate (9+ games)": r => r.games >= 9,
    "flat slate (7 or fewer players at 20%+)": r => r.fieldChalk <= 7, "concentrated slate (8+ players at 20%+)": r => r.fieldChalk >= 8 };
  for (const tier of ["all", "$20-99", "$100-299", "$300+", ...(fmt === "classic" ? Object.keys(SEG) : [])]) {
    const rs = tier === "all" ? rows : SEG[tier] ? rows.filter(SEG[tier]) : rows.filter(r => r.tier === tier); if (rs.length < 1000) continue;
    out.push(`## ${fmt} ${tier}: ${rs.length.toLocaleString()} lineups, ${rs.filter(r => r.mine).length} mine`, "", "| rule | follow n | ROI follow | ROI not | t | top-1% lift | half 1 t | half 2 t | field % | me % | verdict |", "|---|---|---|---|---|---|---|---|---|---|---|");
    const lines = [];
    const rsSeg = rs;
    for (const [name, fn, scope] of RULES[fmt]) { const rs = scope ? rsSeg.filter(scope) : rsSeg;
      const a = rs.filter(fn), b = rs.filter(r => !fn(r)); if (a.length < 50 || b.length < 50) continue;
      const t = welch(a.map(r => r.roi), b.map(r => r.roi));
      const h1 = rs.filter(r => r.date < mid), h2 = rs.filter(r => r.date >= mid);
      const t1 = welch(h1.filter(fn).map(r => r.roi), h1.filter(r => !fn(r)).map(r => r.roi)), t2 = welch(h2.filter(fn).map(r => r.roi), h2.filter(r => !fn(r)).map(r => r.roi));
      const lift = mean(a.map(r => r.top1)) / (mean(b.map(r => r.top1)) || 1e-9);
      const mine = rs.filter(r => r.mine); const mePct = mine.length ? mean(mine.map(r => fn(r) ? 1 : 0)) : NaN;
      const kept = Math.abs(t) >= 3 && Math.sign(t1) === Math.sign(t2) && Math.sign(t1) === Math.sign(t) && a.length >= 300 && b.length >= 300;
      JROWS.push({ fmt, seg: tier, rule: name, n: a.length, notN: b.length, roiF: +(100 * mean(a.map(r => r.roi))).toFixed(1), roiN: +(100 * mean(b.map(r => r.roi))).toFixed(1), t: +t.toFixed(2), lift: +lift.toFixed(3), t1: isNaN(t1) ? null : +t1.toFixed(2), t2: isNaN(t2) ? null : +t2.toFixed(2), kept, follow: kept ? t > 0 : null });
      lines.push({ t, s: `| ${name} | ${a.length.toLocaleString()} | ${(100 * mean(a.map(r => r.roi))).toFixed(0)}% | ${(100 * mean(b.map(r => r.roi))).toFixed(0)}% | ${t.toFixed(1)} | ${lift.toFixed(2)} | ${isNaN(t1) ? "-" : t1.toFixed(1)} | ${isNaN(t2) ? "-" : t2.toFixed(1)} | ${(100 * a.length / rs.length).toFixed(0)}% | ${isNaN(mePct) ? "-" : (100 * mePct).toFixed(0) + "%"} | ${kept ? (t > 0 ? "KEEP: follow" : "KEEP: avoid") : ""} |` });
    }
    lines.sort((x, y) => Math.abs(y.t) - Math.abs(x.t)).forEach(x => out.push(x.s)); out.push("");
  }
}
// machine-readable copy for the lineup grade (server/grade.mjs); --json=<file> to write a window-specific one (backtests)
fs.mkdirSync("data/reports", { recursive: true }); fs.writeFileSync(flag("json") || "data/reports/rulebook-nfl.json", JSON.stringify({ built: new Date().toISOString(), from: FROM, to: TO, minfee: MINFEE, contests: nC, split: mid, rows: JROWS }, null, 1));
if (!flag("json")) fs.writeFileSync("data/reports/rulebook-nfl.md", out.join("\n") + "\n");
console.log(out.join("\n")); console.log("wrote data/reports/rulebook-nfl.md");
