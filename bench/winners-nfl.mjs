// What won. For every pulled NFL contest in a window (classic and showdown, by fee tier), the shape of
// the winning and top-1% lineups against the field and against the user's own entries: salary used,
// summed ownership, chalk carried, duplicates, stack and bring-back, team split, captain choice, and how
// far the winner sat from Stokastic's own sim ranking. Pure data, no projections, so it runs nightly.
//   node bench/winners-nfl.mjs [from] [to] [--user=jtmac1999]     default: the last 8 days
// Writes data/reports/winners-nfl-<to>.md and prints it.
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--")), flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const USER = flag("user") || "jtmac1999";
const day = d => new Date(d).toISOString().slice(0, 10);
const TO = args[1] || day(Date.now() - 864e5), FROM = args[0] || day(new Date(TO).getTime() - 7 * 864e5);
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = p => p.pos && p.pos !== "CPT" && p.pos !== "FLEX" ? p.pos : (REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST"));
const tierOf = fee => fee < 20 ? "<$20" : fee < 100 ? "$20-99" : fee < 300 ? "$100-299" : "$300+";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN, pct = x => isNaN(x) ? "-" : (100 * x).toFixed(0) + "%", f1 = x => isNaN(x) ? "-" : x.toFixed(1), f0 = x => isNaN(x) ? "-" : x.toFixed(0);

// features of one lineup
function feats(l, j, sd, rankOf) {
  const P = j.byId, ps = l.ids.map(id => P.get(id)).filter(Boolean);
  const own = l.own * 100, maxOwn = Math.max(0, ...ps.map(p => (p.aown || 0) * 100)), chalk = ps.filter(p => (p.aown || 0) >= 0.2).length;
  const tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
  const split = Object.values(tc).sort((a, b) => b - a).join("-");
  const out = { sal: l.sal, left: 50000 - l.sal, own, maxOwn, chalk, dup: l.dup > 0 ? 1 : 0, simPct: rankOf(l), afp: l.afp, teams: Object.keys(tc).length, split };
  if (sd) {
    // captain: the one id whose 1.5x salary closes the gap to the lineup salary
    const flexSum = ps.reduce((s, p) => s + (p.flexSal ?? p.sal), 0);
    const cpt = ps.find(p => Math.abs(flexSum + 0.5 * (p.flexSal ?? p.sal) - l.sal) < 1) || ps[0];
    out.cptPos = posOf(cpt); out.cptOwn = (j.cptOwn.get(cpt.id) ?? cpt.aown ?? 0) * 100; out.cptName = cpt.name;
    out.hasQB = ps.some(p => posOf(p) === "QB") ? 1 : 0; out.hasK = ps.some(p => posOf(p) === "K") ? 1 : 0; out.hasDST = ps.some(p => posOf(p) === "DST") ? 1 : 0;
  } else {
    const qb = ps.find(p => posOf(p) === "QB");
    out.stack = qb ? ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p))).length : 0;
    out.bring = qb ? (ps.some(p => p.team === qb.opp && posOf(p) !== "DST") ? 1 : 0) : 0;
    out.rbDst = ps.some(p => posOf(p) === "DST" && ps.some(q => posOf(q) === "RB" && q.team === p.team)) ? 1 : 0;
    out.qbVsOwnDst = qb && ps.some(p => posOf(p) === "DST" && p.team === qb.opp) ? 1 : 0;
  }
  return out;
}
const groups = {}, lines = [];
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || c.date < FROM || c.date > TO) continue;
  const sd = /showdown/i.test(c.type + " " + c.name), key = (sd ? "Showdown" : "Classic") + " " + tierOf(c.fee);
  j.byId = new Map(); j.cptOwn = new Map();
  for (const p of j.players) { if (p.pos === "CPT") { j.cptOwn.set(p.id, p.aown); if (!j.byId.has(p.id)) j.byId.set(p.id, p); } else j.byId.set(p.id, Object.assign({}, p, { flexSal: p.sal })); }
  const L = j.lineups, N = L.length, cut = Math.max(1, Math.ceil(N * 0.01));
  const order = L.slice().sort((a, b) => b.sroi - a.sroi), rank = new Map(order.map((l, i) => [l, i])), rankOf = l => rank.get(l) / N;
  const g = groups[key] = groups[key] || { n: 0, win: [], top: [], field: [], mine: [], list: [] };
  g.n++;
  const w = L.find(l => l.fin === 1); if (w) g.win.push(feats(w, j, sd, rankOf));
  for (const l of L) { if (l.fin <= cut) g.top.push(feats(l, j, sd, rankOf)); }
  for (const l of L.filter((_, i) => i % Math.max(1, Math.floor(N / 300)) === 0)) g.field.push(feats(l, j, sd, rankOf));
  for (const l of L.filter(l => l.u === USER)) { const ft = feats(l, j, sd, rankOf); ft.fin = l.fin; ft.N = N; ft.fee = c.fee; g.mine.push(ft); }
  if (w && c.fee >= 100) g.list.push({ c, w: feats(w, j, sd, rankOf), names: w.ids.map(id => j.byId.get(id)?.name || id).join(", "), mine: L.filter(l => l.u === USER).map(l => `${l.fin}/${N}`).join(" ") });
}
const out = [`# What won: NFL ${FROM} to ${TO}`, ""];
const col = (rows, k, fmt = f1) => fmt(mean(rows.map(r => r[k]).filter(x => x != null && !isNaN(x))));
for (const key of Object.keys(groups).sort()) {
  const g = groups[key], sd = key.startsWith("Showdown");
  out.push(`## ${key}: ${g.n} contests (${g.mine.length} of my entries)`, "");
  const rows = [["winners", g.win], ["top 1%", g.top], ["field", g.field], ["me", g.mine]];
  if (sd) {
    out.push("| who | n | salary left | own sum | max own | 20%+ players | duplicated | Stokastic sim rank pct | CPT own | has QB | has K | has DST |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [nm, r] of rows) if (r.length) out.push(`| ${nm} | ${r.length} | $${col(r, "left", f0)} | ${col(r, "own", f0)}% | ${col(r, "maxOwn", f0)}% | ${col(r, "chalk")} | ${col(r, "dup", pct)} | ${col(r, "simPct", pct)} | ${col(r, "cptOwn", f1)}% | ${col(r, "hasQB", pct)} | ${col(r, "hasK", pct)} | ${col(r, "hasDST", pct)} |`);
    const cp = {}; for (const r of g.win) cp[r.cptPos] = (cp[r.cptPos] || 0) + 1; const fp = {}; for (const r of g.field) fp[r.cptPos] = (fp[r.cptPos] || 0) + 1;
    out.push("", "Captain position, winners vs field: " + Object.entries(cp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / g.win.length)} (field ${pct((fp[k] || 0) / g.field.length)})`).join(", "));
    const sp = {}; for (const r of g.win) sp[r.split] = (sp[r.split] || 0) + 1; const fsp = {}; for (const r of g.field) fsp[r.split] = (fsp[r.split] || 0) + 1;
    out.push("Team split, winners vs field: " + Object.entries(sp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / g.win.length)} (field ${pct((fsp[k] || 0) / g.field.length)})`).join(", "), "");
  } else {
    out.push("| who | n | salary left | own sum | max own | 20%+ players | duplicated | Stokastic sim rank pct | QB stack | bring-back | RB+own DST | QB vs own DST | teams used |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [nm, r] of rows) if (r.length) out.push(`| ${nm} | ${r.length} | $${col(r, "left", f0)} | ${col(r, "own", f0)}% | ${col(r, "maxOwn", f0)}% | ${col(r, "chalk")} | ${col(r, "dup", pct)} | ${col(r, "simPct", pct)} | ${col(r, "stack")} | ${col(r, "bring", pct)} | ${col(r, "rbDst", pct)} | ${col(r, "qbVsOwnDst", pct)} | ${col(r, "teams")} |`);
    out.push("");
  }
  if (g.mine.length) { const cashed = g.mine.filter(m => m.fin <= m.N * 0.2).length; out.push(`My entries: ${g.mine.length}, finished top 20% in ${cashed}; avg sim rank pct ${pct(mean(g.mine.map(m => m.simPct)))}, avg own sum ${f0(mean(g.mine.map(m => m.own)))}%, duplicated ${pct(mean(g.mine.map(m => m.dup)))}.`, ""); }
  if (g.list.length) { out.push("Winners, $100+ contests:", ""); for (const x of g.list.sort((a, b) => b.c.fee - a.c.fee).slice(0, 12)) out.push(`- ${x.c.date} $${x.c.fee} ${x.c.name.replace(/NFL (Showdown )?/, "").slice(0, 44)} (n=${x.c.entries}): ${x.names}; own ${f0(x.w.own)}%, left $${x.w.left}, sim rank ${pct(x.w.simPct)}${x.mine ? `; me ${x.mine}` : ""}`); out.push(""); }
}
const file = path.join("data/reports", `winners-nfl-${TO}.md`);
fs.mkdirSync("data/reports", { recursive: true }); fs.writeFileSync(file, out.join("\n") + "\n");
console.log(out.join("\n")); console.log("wrote", file);
