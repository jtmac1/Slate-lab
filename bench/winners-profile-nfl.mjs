// What winning NFL lineups look like, as numbers the Entry Manager can hold your entries against:
// per format (classic / showdown) and fee tier, the top-1% lineups vs the whole field on ownership
// sum, chalk count, salary left, QB stack, bring-back, duplication, team split and captain choice.
//   node bench/winners-profile-nfl.mjs [from] [to]   -> data/reports/winners-profile-nfl.json
import fs from "node:fs";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const FROM = process.argv[2] || "2026-09-01", TO = process.argv[3] || "2099-12-31";
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = p => p.pos && p.pos !== "CPT" && p.pos !== "FLEX" ? p.pos : (REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST"));
const tierOf = fee => fee < 100 ? "lo" : fee < 300 ? "mid" : "hi";
const acc = {};
const bucket = (fmt, tier, who) => { const k = `${fmt}|${tier}|${who}`; return acc[k] = acc[k] || { n: 0, sums: {} }; };
const push = (b, f) => { b.n++; for (const [k, v] of Object.entries(f)) if (v != null && !isNaN(v)) { const s = b.sums[k] = b.sums[k] || { n: 0, s: 0 }; s.n++; s.s += v; } };
let contests = 0;
for (const file of listPost("nfl")) {
  const j = readPost(file), c = j.contest; if (!j.lineups?.length || !j.players?.length || c.date < FROM || c.date > TO || c.fee < 20) continue;
  const sd = /showdown/i.test(c.type + " " + c.name), fmt = sd ? "showdown" : "classic", tier = tierOf(c.fee), N = j.lineups.length, cut = Math.max(1, Math.ceil(N * 0.01));
  const byId = new Map(), cptOwn = new Map();
  for (const p of j.players) { if (p.pos === "CPT") { cptOwn.set(p.id, p.aown); if (!byId.has(p.id)) byId.set(p.id, p); } else byId.set(p.id, Object.assign({}, p, { flexSal: p.sal })); }
  contests++;
  const step = Math.max(1, Math.floor(N / 400));
  j.lineups.forEach((l, i) => {
    const win = l.fin != null && l.fin <= cut; if (!win && i % step !== 0) return;
    const ps = l.ids.map(id => byId.get(id)).filter(Boolean); if (ps.length < l.ids.length) return;
    const tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
    const f = { own: l.own * 100, chalk: ps.filter(p => (p.aown || 0) >= 0.2).length, left: 50000 - l.sal, dup: l.dup > 0 ? 1 : 0, teams: Object.keys(tc).length };
    if (sd) {
      const flexSum = ps.reduce((s, p) => s + (p.flexSal ?? p.sal), 0), cpt = ps.find(p => Math.abs(flexSum + 0.5 * (p.flexSal ?? p.sal) - l.sal) < 1) || ps[0], cp = posOf(cpt), split = Object.values(tc).sort((a, b) => b - a).join("-");
      Object.assign(f, { split51: split === "5-1" ? 1 : 0, split42: split === "4-2" ? 1 : 0, split33: split === "3-3" ? 1 : 0, cptQB: cp === "QB" ? 1 : 0, cptWR: cp === "WR" ? 1 : 0, cptRB: cp === "RB" ? 1 : 0, cptTE: cp === "TE" ? 1 : 0, cptKD: cp === "K" || cp === "DST" ? 1 : 0, cptOwn: (cptOwn.get(cpt.id) ?? cpt.aown ?? 0) * 100, hasDST: ps.some(p => posOf(p) === "DST") ? 1 : 0, hasK: ps.some(p => posOf(p) === "K") ? 1 : 0, hasQB: ps.some(p => posOf(p) === "QB") ? 1 : 0 });
    } else {
      const qb = ps.find(p => posOf(p) === "QB");
      Object.assign(f, { stack: qb ? ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p))).length : 0, bring: qb && ps.some(p => p.team === qb.opp && posOf(p) !== "DST") ? 1 : 0, rbDst: ps.some(p => posOf(p) === "DST" && ps.some(q => posOf(q) === "RB" && q.team === p.team)) ? 1 : 0, maxTeam: Math.max(...Object.values(tc)) });
    }
    for (const t of [tier, "all"]) { push(bucket(fmt, t, "field"), f); if (win) push(bucket(fmt, t, "winners"), f); }
  });
}
const out = { built: new Date().toISOString(), window: [FROM, TO], contests, formats: {} };
for (const [k, b] of Object.entries(acc)) { const [fmt, tier, who] = k.split("|"); const t = (out.formats[fmt] = out.formats[fmt] || {})[tier] = out.formats[fmt][tier] || {}; t[who] = { n: b.n, ...Object.fromEntries(Object.entries(b.sums).map(([m, s]) => [m, +(s.s / s.n).toFixed(3)])) }; }
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/winners-profile-nfl.json", JSON.stringify(out, null, 1));
for (const [fmt, tiers] of Object.entries(out.formats)) for (const [tier, t] of Object.entries(tiers)) if (t.winners && t.field) console.log(`${fmt} ${tier}: winners n=${t.winners.n} own ${t.winners.own.toFixed(0)} vs field ${t.field.own.toFixed(0)}, chalk ${t.winners.chalk.toFixed(1)} vs ${t.field.chalk.toFixed(1)}, left $${t.winners.left.toFixed(0)} vs $${t.field.left.toFixed(0)}, dup ${(100 * t.winners.dup).toFixed(0)}% vs ${(100 * t.field.dup).toFixed(0)}%${fmt === "showdown" ? `, 5-1 ${(100 * t.winners.split51).toFixed(0)}% vs ${(100 * t.field.split51).toFixed(0)}%` : `, stack ${t.winners.stack.toFixed(1)} vs ${t.field.stack.toFixed(1)}, bring ${(100 * t.winners.bring).toFixed(0)}% vs ${(100 * t.field.bring).toFixed(0)}%`}`);
console.log(`${contests} contests -> data/reports/winners-profile-nfl.json`);
