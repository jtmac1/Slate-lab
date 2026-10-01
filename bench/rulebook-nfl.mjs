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
    ["not duplicated", f => !f.dup], ["Stokastic sim top decile", f => f.simPct <= 0.1], ["Stokastic sim top half", f => f.simPct <= 0.5], ["Stokastic sim bottom quarter", f => f.simPct >= 0.75],
    ["max 3 from one team", f => f.maxTeam <= 3], ["4+ from one team", f => f.maxTeam >= 4], ["5 or fewer teams", f => f.teams <= 5],
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
  for (const l of L) { if (l.aroi == null) continue; const ft = feats(l, j, sd, rankOf, cut); ft.tier = tierOf(c.fee); ft.date = c.date; data[sd ? "showdown" : "classic"].push(ft); }
}
dates.sort(); const mid = dates[Math.floor(dates.length / 2)];
const out = [`# NFL rulebook from the archive: ${nC} contests ($${MINFEE}+), ${dates[0]} to ${dates[dates.length - 1]}`, "", "ROI is the lineup's realized return; top-1% is the share of lineups finishing in the top 1% of their contest. t is Welch's t on ROI (follow vs not). KEPT = |t| >= 3, same sign in both halves of the window (split at " + mid + "), 300+ lineups each side. Lift = top-1% rate following / not following.", ""];
for (const fmt of ["classic", "showdown"]) {
  const rows = data[fmt]; if (!rows.length) continue;
  for (const tier of ["all", "$20-99", "$100-299", "$300+"]) {
    const rs = tier === "all" ? rows : rows.filter(r => r.tier === tier); if (rs.length < 1000) continue;
    out.push(`## ${fmt} ${tier}: ${rs.length.toLocaleString()} lineups, ${rs.filter(r => r.mine).length} mine`, "", "| rule | follow n | ROI follow | ROI not | t | top-1% lift | half 1 t | half 2 t | field % | me % | verdict |", "|---|---|---|---|---|---|---|---|---|---|---|");
    const lines = [];
    for (const [name, fn] of RULES[fmt]) {
      const a = rs.filter(fn), b = rs.filter(r => !fn(r)); if (a.length < 50 || b.length < 50) continue;
      const t = welch(a.map(r => r.roi), b.map(r => r.roi));
      const h1 = rs.filter(r => r.date < mid), h2 = rs.filter(r => r.date >= mid);
      const t1 = welch(h1.filter(fn).map(r => r.roi), h1.filter(r => !fn(r)).map(r => r.roi)), t2 = welch(h2.filter(fn).map(r => r.roi), h2.filter(r => !fn(r)).map(r => r.roi));
      const lift = mean(a.map(r => r.top1)) / (mean(b.map(r => r.top1)) || 1e-9);
      const mine = rs.filter(r => r.mine); const mePct = mine.length ? mean(mine.map(r => fn(r) ? 1 : 0)) : NaN;
      const kept = Math.abs(t) >= 3 && Math.sign(t1) === Math.sign(t2) && Math.sign(t1) === Math.sign(t) && a.length >= 300 && b.length >= 300;
      lines.push({ t, s: `| ${name} | ${a.length.toLocaleString()} | ${(100 * mean(a.map(r => r.roi))).toFixed(0)}% | ${(100 * mean(b.map(r => r.roi))).toFixed(0)}% | ${t.toFixed(1)} | ${lift.toFixed(2)} | ${isNaN(t1) ? "-" : t1.toFixed(1)} | ${isNaN(t2) ? "-" : t2.toFixed(1)} | ${(100 * a.length / rs.length).toFixed(0)}% | ${isNaN(mePct) ? "-" : (100 * mePct).toFixed(0) + "%"} | ${kept ? (t > 0 ? "KEEP: follow" : "KEEP: avoid") : ""} |` });
    }
    lines.sort((x, y) => Math.abs(y.t) - Math.abs(x.t)).forEach(x => out.push(x.s)); out.push("");
  }
}
fs.mkdirSync("data/reports", { recursive: true }); fs.writeFileSync("data/reports/rulebook-nfl.md", out.join("\n") + "\n");
console.log(out.join("\n")); console.log("wrote data/reports/rulebook-nfl.md");
