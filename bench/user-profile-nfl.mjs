// How does one user build? For a DK username, every pulled NFL contest in a window at or above a fee:
// results, construction (stack, bring-back, chalk, ownership, salary, duplicates, sim rank), captain
// and split choices in showdown, how diversified the entries are within a contest, and the players
// and games leaned on, each against the field in the same contests and against a second user.
//   node bench/user-profile-nfl.mjs <user> [from] [to] [--minfee=100] [--vs=jtmac1999]
import fs from "node:fs";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--")), flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const USER = (args[0] || "dacoltz").toLowerCase(), FROM = args[1] || "2026-09-10", TO = args[2] || "2026-09-28", MINFEE = +(flag("minfee") || 100), VS = (flag("vs") || "jtmac1999").toLowerCase();
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = p => p.pos && p.pos !== "CPT" && p.pos !== "FLEX" ? p.pos : (REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST"));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN, pct = x => isNaN(x) ? "-" : (100 * x).toFixed(0) + "%", f1 = x => isNaN(x) ? "-" : x.toFixed(1), f0 = x => isNaN(x) ? "-" : x.toFixed(0);
function feats(l, j, sd, rankOf, cut, N) {
  const ps = l.ids.map(id => j.byId.get(id)).filter(Boolean), tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
  const f = { roi: l.aroi, top1: l.fin <= cut ? 1 : 0, top10: l.fin <= N * 0.1 ? 1 : 0, cash: l.aroi > -1 ? 1 : 0, left: 50000 - l.sal, own: l.own * 100, chalk: ps.filter(p => (p.aown || 0) >= 0.2).length, maxOwn: Math.max(0, ...ps.map(p => (p.aown || 0) * 100)), dup: l.dup > 0 ? 1 : 0, simPct: rankOf(l), teams: Object.keys(tc).length, split: Object.values(tc).sort((a, b) => b - a).join("-"), ids: l.ids, lev: mean(ps.map(p => ((p.aown || 0) - (p.pown || 0)) * 100)) };
  if (sd) { const flexSum = ps.reduce((s, p) => s + (p.flexSal ?? p.sal), 0); const cpt = ps.find(p => Math.abs(flexSum + 0.5 * (p.flexSal ?? p.sal) - l.sal) < 1) || ps[0]; f.cptPos = posOf(cpt); f.cptOwn = (j.cptOwn.get(cpt.id) ?? cpt.aown ?? 0) * 100; f.cptName = cpt.name; f.hasK = ps.some(p => posOf(p) === "K") ? 1 : 0; f.hasDST = ps.some(p => posOf(p) === "DST") ? 1 : 0; const qb = ps.find(p => posOf(p) === "QB"); f.hasQB = qb ? 1 : 0; f.qbStack = qb ? ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p))).length : 0; }
  else { const qb = ps.find(p => posOf(p) === "QB"); f.stack = qb ? ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p))).length : 0; f.bring = qb && ps.some(p => p.team === qb.opp && posOf(p) !== "DST") ? 1 : 0; f.rbDst = ps.some(p => posOf(p) === "DST" && ps.some(q => posOf(q) === "RB" && q.team === p.team)) ? 1 : 0; f.maxTeam = Math.max(...Object.values(tc)); f.qbName = qb ? qb.name : "-"; f.game = qb ? [qb.team, qb.opp].sort().join("@") : "-"; }
  return f;
}
const G = {};
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || c.fee < MINFEE || c.date < FROM || c.date > TO) continue;
  const mine = j.lineups.filter(l => String(l.u).toLowerCase() === USER); if (!mine.length) continue;
  const sd = /showdown/i.test(c.type + " " + c.name), key = sd ? "showdown" : "classic";
  j.byId = new Map(); j.cptOwn = new Map();
  for (const p of j.players) { if (p.pos === "CPT") { j.cptOwn.set(p.id, p.aown); if (!j.byId.has(p.id)) j.byId.set(p.id, p); } else j.byId.set(p.id, Object.assign({}, p, { flexSal: p.sal })); }
  const L = j.lineups, N = L.length, cut = Math.max(1, Math.ceil(N * 0.01)), order = L.slice().sort((a, b) => b.sroi - a.sroi), rank = new Map(order.map((l, i) => [l, i])), rankOf = l => rank.get(l) / N;
  const g = G[key] = G[key] || { contests: [], user: [], field: [], vs: [], expo: {}, games: {}, cpts: {} };
  const uf = mine.map(l => feats(l, j, sd, rankOf, cut, N)); g.user.push(...uf);
  // within-contest diversity: average share of players two of his entries share
  let ov = [], ids = mine.map(l => new Set(l.ids)); for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) { let s = 0; for (const x of ids[a]) if (ids[b].has(x)) s++; ov.push(s / ids[a].size); }
  g.contests.push({ c, n: mine.length, N, fee: c.fee, won: mine.reduce((s, l) => s + c.fee * (1 + l.aroi), 0), best: Math.min(...mine.map(l => l.fin)), overlap: mean(ov) });
  for (const l of L.filter((_, i) => i % Math.max(1, Math.floor(N / 200)) === 0)) g.field.push(feats(l, j, sd, rankOf, cut, N));
  for (const l of L.filter(l => String(l.u).toLowerCase() === VS)) g.vs.push(feats(l, j, sd, rankOf, cut, N));
  for (const l of mine) for (const id of l.ids) { const p = j.byId.get(id); if (!p) continue; const k = p.name + " (" + posOf(p) + " " + p.team + ")"; const e = g.expo[k] = g.expo[k] || { n: 0, own: [], aroi: [] }; e.n++; e.own.push((p.aown || 0) * 100); e.aroi.push(p.aroi || 0); }
  for (const ft of uf) { if (ft.game) g.games[ft.game] = (g.games[ft.game] || 0) + 1; if (ft.cptName) g.cpts[ft.cptName + " (" + ft.cptPos + ")"] = (g.cpts[ft.cptName + " (" + ft.cptPos + ")"] || 0) + 1; }
}
for (const key of ["classic", "showdown"]) {
  const g = G[key]; if (!g) continue;
  const fees = g.contests.reduce((s, x) => s + x.fee * x.n, 0), won = g.contests.reduce((s, x) => s + x.won, 0);
  console.log(`\n=== ${USER} NFL ${key}, $${MINFEE}+, ${FROM}..${TO}: ${g.contests.length} contests, ${g.user.length} entries (${f1(g.user.length / g.contests.length)}/contest), fees $${fees.toFixed(0)}, won $${won.toFixed(0)}, ROI ${((won / fees - 1) * 100).toFixed(0)}%`);
  console.log(`  finishes: top 1% ${pct(mean(g.user.map(r => r.top1)))}, top 10% ${pct(mean(g.user.map(r => r.top10)))}, cashed ${pct(mean(g.user.map(r => r.cash)))}; within-contest overlap between his entries ${pct(mean(g.contests.filter(x => x.n > 1).map(x => x.overlap)))} (${g.contests.filter(x => x.n > 1).length} multi-entry contests)`);
  const rows = [["him", g.user], ["field", g.field], [VS, g.vs]];
  const cols = key === "classic" ? [["salary left", "left", f0], ["own sum", "own", f0], ["max own", "maxOwn", f0], ["20%+ players", "chalk", f1], ["lev (act-proj own)", "lev", f1], ["duplicated", "dup", pct], ["sim rank pct", "simPct", pct], ["QB stack", "stack", f1], ["bring-back", "bring", pct], ["RB+own DST", "rbDst", pct], ["max from a team", "maxTeam", f1], ["teams", "teams", f1]]
    : [["salary left", "left", f0], ["own sum", "own", f0], ["max own", "maxOwn", f0], ["20%+ players", "chalk", f1], ["lev (act-proj own)", "lev", f1], ["duplicated", "dup", pct], ["sim rank pct", "simPct", pct], ["CPT own", "cptOwn", f1], ["has QB", "hasQB", pct], ["QB stack", "qbStack", f1], ["has K", "hasK", pct], ["has DST", "hasDST", pct]];
  console.log("  " + "who".padEnd(12) + "n".padEnd(6) + cols.map(c => c[0].padEnd(20)).join(""));
  for (const [nm, r] of rows) if (r.length) console.log("  " + nm.padEnd(12) + String(r.length).padEnd(6) + cols.map(([, k, fmt]) => fmt(mean(r.map(x => x[k]).filter(v => v != null && !isNaN(v)))).padEnd(20)).join(""));
  const dist = (r, k) => { const d = {}; for (const x of r) d[x[k]] = (d[x[k]] || 0) + 1; return Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a, b]) => `${a} ${pct(b / r.length)}`).join(", "); };
  if (key === "showdown") { console.log("  CPT position  him: " + dist(g.user, "cptPos") + " | field: " + dist(g.field, "cptPos")); console.log("  team split    him: " + dist(g.user, "split") + " | field: " + dist(g.field, "split")); console.log("  captains used: " + Object.entries(g.cpts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(", ")); }
  else { console.log("  QB stack size him: " + dist(g.user, "stack") + " | field: " + dist(g.field, "stack")); console.log("  games stacked: " + Object.entries(g.games).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(", ")); }
  console.log("  most-used players (entries, their avg actual own, their avg actual ROI): " + Object.entries(g.expo).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, e]) => `${k} x${e.n} ${f0(mean(e.own))}% ${f0(100 * mean(e.aroi))}%`).join("; "));
  console.log("  contests: " + g.contests.sort((a, b) => b.fee - a.fee).slice(0, 10).map(x => `${x.c.date} $${x.fee} ${x.c.name.replace(/NFL (Showdown )?/, "").slice(0, 30)} n${x.n} best ${x.best}/${x.N} won $${x.won.toFixed(0)}`).join(" | "));
}
