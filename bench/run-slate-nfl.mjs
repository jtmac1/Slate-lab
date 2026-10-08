// One command for a slate: refresh it in the hub, check the vendor files, build the field sized to the contest, sim the
// generated pool, and print the picks (grade and calibrated Lab ROI, per-source ROI, dupes), Lab likes and Lab stacks,
// and for showdown which side to load. Needs the hub running (npm run hub). It can't drive Chrome, so when ETR or Blick
// is missing it prints the step to run.
//   node bench/run-slate-nfl.mjs --date 2026-10-08 --slate "TB @ DAL" --contest 196285153
//   node bench/run-slate-nfl.mjs --dir 2026-10-05-nfl-atlno --contest 333:2002:150000 [--lineups 8] [--arch high]
// --contest is a DK contest id from the lobby, or fee:field:first[:prizePool] for a contest that has left the lobby
// (full contests drop out); --no-refresh skips the hub refresh (past slates)
import fs from "node:fs";
import path from "node:path";
import { likesText } from "../server/likes.mjs";
import { stacksText } from "../server/stacks.mjs";

const HUB = process.env.SLATELAB_HUB || "http://localhost:8787";
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) { const k = args[i].slice(2), v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true; opt[k] = v; }
const die = m => { console.error(m); process.exit(1); };
const api = async (p, body) => { const r = await fetch(HUB + p, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(`${p}: ${j.error || r.status}`); return j; };
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const N = Math.max(1, +opt.lineups || 5);

try { await fetch(HUB + "/api/dirs"); } catch { die(`The hub isn't running at ${HUB}. Start it first (npm run hub).`); }

// ---------- the slate ----------
let dir = opt.dir || null;
if (!dir) {
  if (!opt.date || !opt.slate) die("usage: --date YYYY-MM-DD --slate <name|slateId> --contest <cid|fee:field:first>   (or --dir <slate dir>)");
  const slates = await api(`/api/slates?date=${opt.date}`), want = String(opt.slate).toLowerCase().replace(/\s+/g, "");
  const s = slates.find(x => String(x.slateId) === String(opt.slate)) || slates.find(x => x.name.toLowerCase().replace(/\s+/g, "") === want) || slates.find(x => x.name.toLowerCase().replace(/\s+/g, "").includes(want));
  if (!s) die(`No Stokastic NFL slate "${opt.slate}" on ${opt.date}. Slates: ${slates.map(x => `${x.slateId} ${x.type} ${x.name}`).join(" | ") || "none (past slates aren't listed - use --dir)"}`);
  console.log(`slate ${s.slateId} ${s.type} ${s.name} (${s.games.join(", ")})`);
  const r = await api("/api/refresh", { date: opt.date, slateId: s.slateId });
  dir = r.hub && r.hub.dir; if (!dir) die("refresh returned no slate dir: " + JSON.stringify(r.steps).slice(0, 300));
} else if (!opt["no-refresh"]) {
  await api("/api/refresh", { dir }).catch(e => console.log(`refresh skipped (${e.message})`));
}
if (!fs.existsSync(path.join("data", dir))) die(`no data/${dir}`);
const meta = readJ(path.join("data", dir, "slate.json")) || {}, sd = /SHOWDOWN/i.test(meta.type || "") || !/main|early|afternoon|primetime|sun-mon|late/i.test(dir) && (meta.games || []).length === 1;
const hub = await api(`/api/hub?dir=${dir}`).catch(() => null), srcs = hub ? Object.keys(hub.sources || {}) : [];
console.log(`dir ${dir} | ${sd ? "showdown" : "classic"} | sources: ${srcs.join(", ") || "?"}`);
const missing = ["etr", "blick"].filter(s => !srcs.includes(s));
if (missing.length) console.log(`  ! missing ${missing.join(" + ")}: in the Data Hub press "Pull ETR + Blick" (or tell Claude "pull ETR and Blick"), then re-run this command. Continuing without them.`);
const guide = readJ(path.join("data", dir, "slate-guide.json"));
console.log(`  guide: ${guide ? `${(guide.theses || []).length} theses, ${Object.keys(guide.stances || {}).length} stances${guide.data ? ", ETR data tables" : ""}` : "none - run the weekly ETR read (Data Hub > Notes) for this slate"}`);

// ---------- the contest ----------
if (!opt.contest) die("--contest <DK cid | fee:field:first[:prizePool]> is required");
const lobby = new Map(((readJ("data/dk-lobby/nfl.json") || {}).contests || []).map(c => [String(c.id), c]));
let C;
if (/^\d+$/.test(String(opt.contest))) {
  const c = lobby.get(String(opt.contest));
  if (!c) die(`contest ${opt.contest} isn't in the lobby cache (full contests drop out). Use --contest fee:field:first, e.g. 333:2002:150000`);
  C = { cid: String(c.id), name: c.name, fee: c.fee, field: c.field, prizePool: c.prizePool, first: null };
} else {
  const [fee, field, first, pool] = String(opt.contest).split(":").map(Number);
  if (!(fee > 0 && field > 0 && first > 0)) die("--contest must be a DK id or fee:field:first[:prizePool]");
  C = { cid: null, name: `${field}-entry $${fee} contest, $${first} to 1st`, fee, field, prizePool: pool || Math.round(fee * field * 0.85), first };
}
// the generator tiers the fits were made on: high = $100+ and <= 1,000 entries; low = > 10,000 entries or under $10
const arch = opt.arch || (C.fee >= 100 && C.field <= 1000 ? "high" : C.field > 10000 || C.fee < 10 ? "low" : "marquee");
// ownership: showdown uses every source; classic follows the contest-size rule (contestsim ownTier), spelled out here when
// the contest isn't in the lobby so buildField can't see it
let own = { ownSrc: "all" };
if (!sd) own = C.cid ? { ownSrc: "auto" } : C.field <= 1000 && C.fee >= 100 ? { ownSrc: "blickHS", curve: false } : C.field > 10000 ? { ownSrc: "vavg", curve: false } : { ownSrc: "vavg" };
console.log(`contest: ${C.name} | fee $${C.fee}, ${C.field} entries${C.first ? `, $${C.first} to 1st` : ""} | field tier ${arch} | ownership ${own.ownSrc}${own.curve === false ? " (no model)" : ""}`);

// ---------- field + sim ----------
const t0 = Date.now();
const F = await api(`/api/field?dir=${dir}`, Object.assign({ arch, projSrc: "lab" }, own, C.cid ? { cid: C.cid } : { n: C.field }));
const simCfg = { useField: true, max: 3000, iters: +opt.iters || 8000 };
if (C.cid) simCfg.cid = C.cid; else Object.assign(simCfg, { fee: C.fee, pct: +(100 * C.first / C.prizePool).toFixed(1) });
await api(`/api/simrun?dir=${dir}`, simCfg);
const run = await api(`/api/simrun?dir=${dir}`), R = run.rows || [];
console.log(`field ${F.N || F.cfg && F.cfg.n} lineups, sim of ${R.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s | payouts ${JSON.stringify({ pct: run.contest && run.contest.pct, paid: run.contest && run.contest.paidN })} | guide ${run.guide ? "on" : "off"}`);
if (!R.length) die("the sim returned no lineups");

const src = e => ["stk", "etr", "blick", "mkt"].filter(s => e.sim[s]).map(s => `${s} ${e.sim[s].roi.toFixed(0)}`).join(" / ");
const names = e => e.players.map((p, i) => (sd && i === 0 ? "CPT " : "") + p.name).join(", ");
const winsTxt = e => e.wins && e.wins.length ? `\n      wins when: ${e.wins.map(w => `${w.name} (${w.share}% of its top finishes)`).join("; ")}` : "";
const line = (e, i) => `${String(i + 1).padStart(2)}. grade ${e.grade ? e.grade.grade : "-"} | Lab ${e.sim.lab}% [${src(e)}] | win ${e.sim.win.toFixed(2)}% cash ${e.sim.cash.toFixed(0)}% | dupes ${e.sim.dupN} | $${e.sal} | own ${e.fieldOwn} | ${e.type || ""}\n      ${names(e)}${winsTxt(e)}`;
console.log(`\nTOP ${N} BY GRADE`); R.slice().sort((a, b) => (b.grade ? b.grade.grade : 0) - (a.grade ? a.grade.grade : 0) || b.sim.lab - a.sim.lab).slice(0, N).forEach((e, i) => console.log(line(e, i)));
console.log(`\nTOP ${N} BY LAB ROI (calibrated)`); R.slice().sort((a, b) => b.sim.lab - a.sim.lab).slice(0, N).forEach((e, i) => console.log(line(e, i)));
const minSrc = e => Math.min(...["stk", "etr", "blick"].filter(s => e.sim[s]).map(s => e.sim[s].roi));
console.log(`\nBEST WORST-CASE SOURCE (grade 85+)`); R.filter(e => e.grade && e.grade.grade >= 85).sort((a, b) => minSrc(b) - minSrc(a)).slice(0, Math.min(N, 3)).forEach((e, i) => console.log(line(e, i)));

// showdown: which side to load, from the graded pool (5-1 / 4-2 by team)
if (sd) {
  const side = {};
  for (const e of R) { const t = {}; e.players.forEach(p => t[p.team] = (t[p.team] || 0) + 1); const [team, n] = Object.entries(t).sort((a, b) => b[1] - a[1])[0]; const k = n >= 5 ? `5-1 ${team}` : n === 4 ? `4-2 ${team}` : "3-3"; (side[k] = side[k] || []).push(e); }
  console.log(`\nSHOWDOWN SIDES (pool lineups; mean calibrated Lab ROI, best grade)`);
  for (const [k, l] of Object.entries(side).sort((a, b) => b[1].reduce((s, e) => s + e.sim.lab, 0) / b[1].length - a[1].reduce((s, e) => s + e.sim.lab, 0) / a[1].length))
    console.log(`  ${k.padEnd(9)} n ${String(l.length).padStart(4)} | mean Lab ${(l.reduce((s, e) => s + e.sim.lab, 0) / l.length).toFixed(0)}% | best grade ${Math.max(...l.map(e => e.grade ? e.grade.grade : 0))}`);
  const st = guide && guide.construction; if (st) console.log(`  guide utilization: ${JSON.stringify(st.utilization)}${guide.structure ? ` | guide prefers ${JSON.stringify(guide.structure.prefer)}` : ""}`);
}

// Lab likes + Lab stacks (rebuilt on this sim)
const likes = await api(`/api/likes?dir=${dir}`, {}).catch(e => ({ error: e.message })), stacks = await api(`/api/stacks?dir=${dir}`, {}).catch(e => ({ error: e.message }));
console.log(`\nLAB LIKES${likes.error ? ` unavailable (${likes.error})` : `\n${likesText(likes)}`}`);
console.log(`\nLAB STACKS${stacks.error ? ` unavailable (${stacks.error})` : `\n${stacksText(stacks)}`}`);
console.log(`\nNumbers are calibrated (Lab ROI shrunk to realistic levels); rank by grade and Lab ROI, don't read them as dollar forecasts.`);
