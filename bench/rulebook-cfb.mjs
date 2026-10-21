// CFB high-stakes rulebook: what won in college classic contests like the $555 / 600-entry Mid-Season Main Event.
// For every pulled CFB classic contest in the set, the shape of the winner and the top-1% lineups against the
// field and the user's own entries (QB stack, bring-back, two QBs, own sum, chalk and sub-5% counts, salary
// left, duplicates, teams, game stacks, SFLEX/FLEX position), then a rule table: top-1% rate following vs not
// (lift) with a date-clustered t (contests on one date share player outcomes, so the unit is the date: the
// per-date difference in top-1% rate, averaged over dates, over its standard error). Same for realized ROI.
// Pure data from data/post/cfb (bench/pull-stokastic.mjs), no projections, no sims.
//   node bench/rulebook-cfb.mjs [from] [to] [--user=jtmac1999] [--json=data/reports/cfb-highstakes.json]
// Sets: "like" = $300+ fee, or $100+ with 200-2,000 entries; "like-main" = those on Saturday main slates
// (no Afternoon/Night/Late Night tag); "all100" = every $100+ contest. Prints markdown tables.
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--")), flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const USER = flag("user") || "jtmac1999", FROM = args[0] || "2024-01-01", TO = args[1] || "2099-12-31", JSON_OUT = flag("json") || "data/reports/cfb-highstakes.json";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN, sdv = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const SETS = {
  like: c => c.fee >= 300 || (c.fee >= 100 && c.entries >= 200 && c.entries <= 2000),
  "like-main": c => (c.fee >= 300 || (c.fee >= 100 && c.entries >= 200 && c.entries <= 2000)) && !/\((Afternoon|Night|Late Night|Early)\)/i.test(c.name) && new Date(c.date + "T12:00:00Z").getUTCDay() === 6,
  all100: c => c.fee >= 100
};

function feats(l, P, N, rankOf) {
  const ps = l.ids.map(id => P.get(id)); if (ps.some(p => !p)) return null;
  const qbs = ps.filter(p => p.pos === "QB");
  const stackOfQB = q => ps.filter(p => p !== q && p.team === q.team && (p.pos === "WR" || p.pos === "RB")).length;
  const qb = qbs.slice().sort((a, b) => stackOfQB(b) - stackOfQB(a) || b.sal - a.sal)[0];
  const tc = {}, gc = {}; for (const p of ps) { tc[p.team] = (tc[p.team] || 0) + 1; const g = [p.team, p.opp].sort().join("@"); gc[g] = (gc[g] || 0) + 1; }
  const cut1 = Math.max(1, Math.ceil(N * 0.01)), cut10 = Math.max(1, Math.ceil(N * 0.1));
  const sflex = ps[7], flex = ps[6];
  return {
    roi: l.aroi ?? -1, top1: l.fin <= cut1 ? 1 : 0, top10: l.fin <= cut10 ? 1 : 0, win: l.fin === 1 ? 1 : 0,
    stack: qb ? stackOfQB(qb) : 0, stackWR: qb ? ps.filter(p => p !== qb && p.team === qb.team && p.pos === "WR").length : 0,
    bring: qb ? ps.some(p => p.team === qb.opp) : false, bringN: qb ? ps.filter(p => p.team === qb.opp).length : 0,
    bothQBsGame: qbs.length === 2 && qbs[0].team === qbs[1].opp,
    twoQB: qbs.length >= 2, own: 100 * (l.own ?? 0), chalk: ps.filter(p => (p.aown || 0) >= 0.2).length, sub5: ps.filter(p => (p.aown || 0) < 0.05).length, chalkP: ps.filter(p => (p.pown || 0) >= 0.2).length, sub5P: ps.filter(p => (p.pown || 0) < 0.05).length,
    left: 50000 - l.sal, dup: (l.dup || 0) > 0, teams: Object.keys(tc).length, maxTeam: Math.max(...Object.values(tc)), maxGame: Math.max(...Object.values(gc)), games: Object.keys(gc).length,
    sflexPos: sflex ? sflex.pos : "?", flexPos: flex ? flex.pos : "?", simPct: rankOf(l), qbOwn: qb ? 100 * (qb.aown || 0) : 0,
    rbN: ps.filter(p => p.pos === "RB").length, wrN: ps.filter(p => p.pos === "WR").length, mine: l.u === USER
  };
}

const RULES = [
  ["naked QB (no same-team RB/WR)", f => f.stack === 0], ["QB + 1 or more", f => f.stack >= 1], ["QB + 2 or more", f => f.stack >= 2], ["QB + 3 or more", f => f.stack >= 3],
  ["QB + exactly 1", f => f.stack === 1], ["QB + exactly 2", f => f.stack === 2],
  ["bring-back from the QB's opponent", f => f.bring], ["2+ from the QB's opponent", f => f.bringN >= 2],
  ["two QBs (QB in SFLEX)", f => f.twoQB], ["two QBs from the same game", f => f.bothQBsGame], ["RB in SFLEX", f => f.sflexPos === "RB"], ["WR in SFLEX", f => f.sflexPos === "WR"], ["RB in FLEX (3+ RBs)", f => f.rbN >= 3], ["4+ WRs", f => f.wrN >= 4],
  ["own sum < 180%", f => f.own < 180], ["own sum 180-260%", f => f.own >= 180 && f.own < 260], ["own sum >= 260%", f => f.own >= 260],
  ["own sum in the contest's top 30%", f => f.ownPct >= 0.7], ["own sum in the contest's bottom 30%", f => f.ownPct <= 0.3],
  ["0-1 players at 20%+ owned", f => f.chalk <= 1], ["3+ players at 20%+ owned", f => f.chalk >= 3], ["4+ players at 20%+ owned", f => f.chalk >= 4],
  ["no player under 5% owned", f => f.sub5 === 0], ["1-2 players under 5%", f => f.sub5 >= 1 && f.sub5 <= 2], ["3+ players under 5%", f => f.sub5 >= 3],
  // the same ownership rules on PROJECTED ownership, which is what is known before lock
  ["3+ under 5% projected own", f => f.sub5P >= 3], ["no player under 5% projected own", f => f.sub5P === 0], ["3+ at 20%+ projected own", f => f.chalkP >= 3], ["0-1 at 20%+ projected own", f => f.chalkP <= 1],
  ["salary left $0", f => f.left === 0], ["salary left >= $300", f => f.left >= 300], ["salary left >= $1,000", f => f.left >= 1000],
  ["duplicated lineup", f => f.dup], ["4 or fewer teams", f => f.teams <= 4], ["6+ teams", f => f.teams >= 6], ["4+ from one team", f => f.maxTeam >= 4],
  ["game stack: 3+ from one game", f => f.maxGame >= 3], ["game stack: 4+ from one game", f => f.maxGame >= 4], ["game stack: 5+ from one game", f => f.maxGame >= 5],
  ["primary QB 20%+ owned", f => f.qbOwn >= 20], ["primary QB under 10% owned", f => f.qbOwn < 10],
  ["Stokastic sim top decile", f => f.simPct <= 0.1], ["Stokastic sim top half", f => f.simPct <= 0.5], ["Stokastic sim bottom quarter", f => f.simPct >= 0.75]
];

// per-date difference (follow - not), averaged over dates; t = mean / (sd / sqrt(dates))
function clustered(rows, fn, key) {
  const byDate = new Map(); for (const r of rows) { const d = byDate.get(r.date) || { a: [], b: [] }; (fn(r) ? d.a : d.b).push(r[key]); byDate.set(r.date, d); }
  const diffs = [], ma = [], mb = []; for (const d of byDate.values()) if (d.a.length >= 3 && d.b.length >= 3) { diffs.push(mean(d.a) - mean(d.b)); ma.push(mean(d.a)); mb.push(mean(d.b)); }
  if (diffs.length < 4) return { t: NaN, dates: diffs.length, lift: NaN };
  return { t: mean(diffs) / (sdv(diffs) / Math.sqrt(diffs.length)), dates: diffs.length, diff: mean(diffs), lift: mean(ma) / (mean(mb) || 1e-9) };
}

const contests = [];
for (const file of listPost("cfb")) {
  const j = readPost(file), c = j.contest; if (!j.lineups?.length || /showdown/i.test(c.type) || c.date < FROM || c.date > TO || c.fee < 100) continue;
  const P = new Map(j.players.map(p => [p.id, p])), L = j.lineups.filter(l => l.fin != null), N = L.length;
  const order = L.slice().sort((a, b) => (b.sroi ?? -9) - (a.sroi ?? -9)), rank = new Map(order.map((l, i) => [l, i])), rankOf = l => rank.get(l) / N;
  const fs_ = []; for (const l of L) { const f = feats(l, P, N, rankOf); if (f) { f.date = c.date; f.key = c.key; fs_.push(f); } }
  const ownSorted = fs_.map(f => f.own).sort((a, b) => a - b);
  for (const f of fs_) { let lo = 0, hi = ownSorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ownSorted[m] < f.own) lo = m + 1; else hi = m; } f.ownPct = lo / ownSorted.length; }
  contests.push({ c, rows: fs_ });
}

const out = [], J = { built: new Date().toISOString(), from: FROM, to: TO, sets: {} };
const pct = x => isNaN(x) ? "-" : (100 * x).toFixed(0) + "%", f1 = x => isNaN(x) ? "-" : x.toFixed(1), f0 = x => isNaN(x) ? "-" : x.toFixed(0);
for (const [set, pred] of Object.entries(SETS)) {
  const cs = contests.filter(x => pred(x.c)); if (!cs.length) continue;
  const rows = cs.flatMap(x => x.rows), dates = [...new Set(cs.map(x => x.c.date))].sort(), mid = dates[Math.floor(dates.length / 2)];
  const fees = {}; for (const x of cs) { const k = x.c.fee >= 300 ? "$300+" : "$100-299"; fees[k] = (fees[k] || 0) + 1; }
  out.push(`## ${set}: ${cs.length} contests on ${dates.length} dates (${dates[0]} to ${dates[dates.length - 1]}), ${rows.length.toLocaleString()} lineups, ${rows.filter(r => r.mine).length} mine; ${Object.entries(fees).map(([k, v]) => k + " " + v).join(", ")}; median field ${cs.map(x => x.rows.length).sort((a, b) => a - b)[cs.length >> 1]}`, "");
  // winners / top 1% / field / me profile
  const groups = { "winners": rows.filter(r => r.win), "top 1%": rows.filter(r => r.top1), "field": rows, "me": rows.filter(r => r.mine) };
  const prof = {};
  out.push("| who | n | QB stack | QB+0 / +1 / +2 / +3+ | bring-back | two QBs | own sum | 20%+ players | sub-5% players | salary left | duplicated | teams | 3+ one game | 4+ one game | SFLEX QB/RB/WR | Stk sim pct |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [nm, g] of Object.entries(groups)) {
    if (!g.length) continue;
    const m = k => mean(g.map(r => +r[k])), sh = fn => mean(g.map(r => fn(r) ? 1 : 0));
    prof[nm] = { n: g.length, stack: m("stack"), qb0: sh(r => r.stack === 0), qb1: sh(r => r.stack === 1), qb2: sh(r => r.stack === 2), qb3: sh(r => r.stack >= 3), bring: m("bring"), twoQB: m("twoQB"), own: m("own"), chalk: m("chalk"), sub5: m("sub5"), left: m("left"), dup: m("dup"), teams: m("teams"), game3: sh(r => r.maxGame >= 3), game4: sh(r => r.maxGame >= 4), sflexQB: sh(r => r.sflexPos === "QB"), sflexRB: sh(r => r.sflexPos === "RB"), sflexWR: sh(r => r.sflexPos === "WR"), simPct: m("simPct") };
    const p = prof[nm];
    out.push(`| ${nm} | ${g.length} | ${f1(p.stack)} | ${pct(p.qb0)} / ${pct(p.qb1)} / ${pct(p.qb2)} / ${pct(p.qb3)} | ${pct(p.bring)} | ${pct(p.twoQB)} | ${f0(p.own)}% | ${f1(p.chalk)} | ${f1(p.sub5)} | $${f0(p.left)} | ${pct(p.dup)} | ${f1(p.teams)} | ${pct(p.game3)} | ${pct(p.game4)} | ${pct(p.sflexQB)}/${pct(p.sflexRB)}/${pct(p.sflexWR)} | ${pct(p.simPct)} |`);
  }
  out.push("", "| rule | field % | top-1% follow | top-1% not | lift | within-date lift | t (top-1%, by date) | dates | ROI follow | ROI not | t (ROI, by date) | half 1 t | half 2 t | winners % | me % | verdict |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const table = [];
  for (const [name, fn] of RULES) {
    const a = rows.filter(fn), b = rows.filter(r => !fn(r)); if (a.length < 30 || b.length < 30) continue;
    const r1a = mean(a.map(r => r.top1)), r1b = mean(b.map(r => r.top1)), lift = r1a / (r1b || 1e-9);
    const t1 = clustered(rows, fn, "top1"), tr = clustered(rows, fn, "roi");
    const h1 = clustered(rows.filter(r => r.date < mid), fn, "top1"), h2 = clustered(rows.filter(r => r.date >= mid), fn, "top1");
    const winners = groups.winners.length ? mean(groups.winners.map(r => fn(r) ? 1 : 0)) : NaN, me = groups.me.length ? mean(groups.me.map(r => fn(r) ? 1 : 0)) : NaN;
    const sig = Math.abs(t1.t) >= 2, verdict = sig ? (t1.t > 0 ? "FOLLOW" : "AVOID") + (Math.sign(h1.t) === Math.sign(h2.t) ? "" : " (halves disagree)") : Math.abs(tr.t) >= 2 ? "ROI only" : "noise";
    const row = { rule: name, fieldShare: a.length / rows.length, top1F: r1a, top1N: r1b, lift, dateLift: t1.lift, t: t1.t, dates: t1.dates, roiF: mean(a.map(r => r.roi)), roiN: mean(b.map(r => r.roi)), tRoi: tr.t, tH1: h1.t, tH2: h2.t, winners, me, verdict };
    table.push(row);
  }
  table.sort((x, y) => Math.abs(y.t || 0) - Math.abs(x.t || 0));
  for (const r of table) out.push(`| ${r.rule} | ${pct(r.fieldShare)} | ${(100 * r.top1F).toFixed(2)}% | ${(100 * r.top1N).toFixed(2)}% | ${r.lift.toFixed(2)} | ${isNaN(r.dateLift) ? "-" : r.dateLift.toFixed(2)} | ${f1(r.t)} | ${r.dates} | ${f0(100 * r.roiF)}% | ${f0(100 * r.roiN)}% | ${f1(r.tRoi)} | ${f1(r.tH1)} | ${f1(r.tH2)} | ${pct(r.winners)} | ${pct(r.me)} | ${r.verdict} |`);
  out.push("");
  J.sets[set] = { contests: cs.length, dates: dates.length, from: dates[0], to: dates[dates.length - 1], lineups: rows.length, mine: groups.me.length, split: mid, fees,
    contestList: cs.map(x => ({ date: x.c.date, key: x.c.key, fee: x.c.fee, entries: x.rows.length, name: x.c.name })), profile: prof,
    rules: table.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(4) : v]))) };
}
let prev = {}; try { prev = JSON.parse(fs.readFileSync(JSON_OUT, "utf8")); } catch {}
// top-level rules (read by bench/cfb-sheet.mjs): the "like" set, lift = within-date lift so it agrees in sign with t; keep = |t| >= 2 and both halves agree
const like = (J.sets.like || { rules: [] }).rules, rules = like.map(r => ({ rule: r.rule, lift: r.dateLift, t: r.t, n: Math.round(r.fieldShare * J.sets.like.lineups), keep: Math.abs(r.t) >= 2 && Math.sign(r.tH1) === Math.sign(r.t) && Math.sign(r.tH2) === Math.sign(r.t), follow: r.t > 0, top1Follow: r.top1F, top1Not: r.top1N, fieldShare: r.fieldShare, winners: r.winners, me: r.me }));
fs.mkdirSync("data/reports", { recursive: true }); fs.writeFileSync(JSON_OUT, JSON.stringify(Object.assign(prev, { rulebook: J, rules }), null, 1));
console.log(out.join("\n")); console.log("wrote " + JSON_OUT);
