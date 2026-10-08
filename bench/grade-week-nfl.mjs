// "Grade the week": finds the user's entries on a slate and grades them against what the Pre-Contest Simulator said.
// Entries come from Stokastic's post-contest data filtered by DK username (no DraftKings export, no login): every
// contest in the slate's Entry Manager plan (data/<slate>/entry-plan.json) plus every contest Stokastic simulated on
// the slate (and on any --slates sub-slates, e.g. Early/Afternoon Only on the Main slate's dir). Lineups the simulator
// generated keep its Lab ROI and rank ("from sim"); every other lineup ("hand-built") is simmed solo against the same
// field and graded inside the same pool, in a scratch copy of the slate dir (the real simrun.json is never touched).
// Writes data/<slate>/week-grade.json and appends to data/reports/scoreboard-nfl.json.
//   node bench/grade-week-nfl.mjs data/2026-10-04-nfl-main [--user=jtmac1999] [--slates=36406,36450]
import fs from "node:fs";
import path from "node:path";
const API = "https://app-api-dfs-prod-main.azurewebsites.net/api/contests/";
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const dir = process.argv[2], USER = arg("user") || "jtmac1999", EXTRA = (arg("slates") || "").split(",").map(s => s.trim()).filter(Boolean);
if (!dir || !fs.existsSync(dir)) { console.error("usage: node bench/grade-week-nfl.mjs data/<slate>"); process.exit(1); }
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const get = async q => { const r = await fetch(API + q); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const { runSim, loadSimRun } = await import(new URL("../server/contestsim.mjs", import.meta.url));
const plan = readJ(path.join(dir, "entry-plan.json")) || { contests: [] }, meta = readJ(path.join(dir, "slate.json")) || {};
const nm = s => String(s || "").toLowerCase().replace(/\s*\(\d+\)\s*$/, "").replace(/[.'`’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();
const sigNames = names => names.map(nm).sort().join("|");
// the simulator's view of every lineup it graded, keyed by the sorted player names (loadSimRun attaches the grade)
// older sim runs (before Lab ROI) carry only the plain mean; the sharp-construction filter is a classic idea, so showdown gets none
const sim = loadSimRun(path.basename(dir)), labOf = e => e.sim.lab ?? e.sim.mean ?? e.sim.roi ?? null, classic = sim && sim.format !== "nfl_sd";
const sharpOf = e => classic ? e.stackN >= 2 && !!e.bring && e.left < 600 && e.chalk >= 3 : null;
const viewOf = (e, rank, of, source) => ({ source, lab: labOf(e), rank, of, sharp: sharpOf(e), dupN: e.sim.dupN, type: e.type, grade: e.grade ? e.grade.grade : null });
const simBy = new Map(); if (sim && sim.rows) { const order = sim.rows.slice().sort((a, b) => (labOf(b) ?? -1e9) - (labOf(a) ?? -1e9)); order.forEach((e, i) => simBy.set(sigNames(e.players.map(p => p.name)), viewOf(e, i + 1, order.length, "from sim"))); }
// plan shapes: Entry Manager (contests[].entries[].lineup, from the DraftKings entries file) or the older contests[].lineups
const planLineups = c => c.entries ? c.entries.map(e => e.lineup).filter(l => l && l.length) : (c.lineups || []);
const lobbyBy = new Map(((readJ("data/dk-lobby/nfl.json") || {}).contests || []).map(c => [String(c.id), c]));
const planned = new Map(); for (const c of plan.contests || []) for (const l of planLineups(c)) planned.set(String(c.cid) + "|" + sigNames(l), true);

// contests to search: the plan's, plus every contest Stokastic simulated on this slate and the --slates sub-slates
const contests = new Map((plan.contests || []).map(c => [String(c.cid), { key: String(c.cid), name: c.name, fee: c.fee, entries: c.field || (lobbyBy.get(String(c.cid)) || {}).field || null, planned: planLineups(c).length, held: c.entries ? c.entries.length : null }]));
for (const sid of [meta.slateId, ...EXTRA].filter(Boolean)) { try { for (const c of await get("getSimulatedContests?slateId=" + sid)) if (c.site === "DK" && !contests.has(String(c.siteContestId))) contests.set(String(c.siteContestId), { key: String(c.siteContestId), name: c.name.trim(), fee: c.entryFee, entries: c.entryCount, planned: 0, slateId: String(sid) }); } catch {} }

const out = { slate: path.basename(dir), user: USER, at: new Date().toISOString(), contests: [] };
for (const c of contests.values()) {
  const base = `siteContestId=${c.key}&currentPage=1&pageSize=150&contestType=PostContest`;
  let mine = []; try { mine = await get(`getRoiByLineup?${base}&user=${encodeURIComponent(USER)}&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=false`); } catch (e) { if (c.planned) out.contests.push({ ...c, error: "Stokastic has no post-contest data for this contest (" + e.message + ")" }); continue; }
  if (!Array.isArray(mine) || !mine.length) { if (c.planned) out.contests.push({ ...c, error: "no entries found under " + USER + " (not simulated by Stokastic, or not entered)" }); continue; }
  let top = []; try { const all = await get(`getRoiByLineup?${base}&user=&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=true`); top = (Array.isArray(all) ? all : []).filter(x => x.actualFinishPosition != null).sort((a, b) => a.actualFinishPosition - b.actualFinishPosition).slice(0, 3); } catch {}
  const N = c.entries || null;
  const lineups = mine.map(x => { const raw = String(x.exportableLineup || "").split(",").map(s => s.trim()).filter(Boolean), s = sigNames(raw), v = simBy.get(s) || null;
    return { names: raw.map(n => n.replace(/\s*\(\d+\)$/, "")), raw, sig: s, finish: x.actualFinishPosition, pct: N && x.actualFinishPosition ? +(100 * (1 - (x.actualFinishPosition - 1) / N)).toFixed(1) : null, points: x.actualFantasyPoints, roi: x.actualLineupRoi != null ? +(100 * x.actualLineupRoi).toFixed(0) : null, dupes: x.duplicates || 0, stkSimROI: x.simLineupRoi != null ? +(100 * x.simLineupRoi).toFixed(0) : null, planned: planned.has(c.key + "|" + s), sim: v }; }).sort((a, b) => (a.finish || 1e9) - (b.finish || 1e9));
  out.contests.push({ ...c, lineups, top: top.map(x => ({ finish: x.actualFinishPosition, points: x.actualFantasyPoints, user: x.user, names: String(x.exportableLineup || "").split(",").map(s => s.trim().replace(/\s*\(\d+\)$/, "")) })) });
}

// hand-built lineups: sim them solo against the slate's field together with the pool, so grade percentiles and Lab ROI
// mean the same thing as for the pool's own lineups. Sub-slate contests (--slates) are priced against this slate's field.
const hand = new Map(); for (const c of out.contests) for (const l of c.lineups || []) if (!l.sim && !hand.has(l.sig)) hand.set(l.sig, l.raw);
if (hand.size && sim && sim.rows) {
  const TMP = dir.replace(/[\\/]+$/, "") + "-zzweek";
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP);
  for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isFile() && f !== "simrun.json") fs.copyFileSync(p, path.join(TMP, f)); }
  try {
    const pool = sim.rows.map(e => e.players.map(p => p.name)), cid = sim.contest && sim.contest.cid ? String(sim.contest.cid) : undefined;
    runSim(path.basename(TMP), { cid, lineups: pool.concat([...hand.values()]) });
    const r = loadSimRun(path.basename(TMP)), order = r.rows.slice().sort((a, b) => (labOf(b) ?? -1e9) - (labOf(a) ?? -1e9));
    const handBy = new Map(); order.forEach((e, i) => { const s = sigNames(e.players.map(p => p.name)); if (hand.has(s) && !handBy.has(s)) handBy.set(s, viewOf(e, i + 1, order.length, "hand-built")); });
    for (const c of out.contests) for (const l of c.lineups || []) if (!l.sim) l.sim = handBy.get(l.sig) || { source: "hand-built", error: "names did not match this slate's players" };
    out.handBuilt = { lineups: hand.size, graded: handBy.size };
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
}
for (const c of out.contests) for (const l of c.lineups || []) { delete l.raw; delete l.sig; }
fs.writeFileSync(path.join(dir, "week-grade.json"), JSON.stringify(out, null, 1));

// running scoreboard: one row per entry, so weeks add up. Headline ROI is fee-weighted (winnings / fees) so a $1 entry
// at +2400% can't swamp a $4,444 entry; the median and the plain mean ride along.
const sbF = "data/reports/scoreboard-nfl.json", sb = readJ(sbF) || { rows: [] };
sb.rows = sb.rows.filter(r => r.slate !== out.slate);
for (const c of out.contests) for (const l of c.lineups || []) sb.rows.push({ slate: out.slate, contest: c.key, name: c.name, fee: c.fee, entries: c.entries, finish: l.finish, pct: l.pct, roi: l.roi, dupes: l.dupes, planned: l.planned, source: l.sim ? l.sim.source : null, grade: l.sim ? l.sim.grade ?? null : null, lab: l.sim ? l.sim.lab ?? null : null, labRank: l.sim ? l.sim.rank ?? null : null, simOf: l.sim ? l.sim.of ?? null : null, sharp: l.sim ? l.sim.sharp ?? null : null });
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const summary = rows => { if (!rows.length) return null; const fees = rows.reduce((t, r) => t + (r.fee || 0), 0), won = rows.reduce((t, r) => t + (r.fee || 0) * (1 + (r.roi ?? -100) / 100), 0), rois = rows.map(r => r.roi ?? -100);
  return { entries: rows.length, fees: +fees.toFixed(2), won: +won.toFixed(2), roi: fees ? +(100 * (won / fees - 1)).toFixed(1) : null, medianRoi: median(rois), meanRoi: +(rois.reduce((t, x) => t + x, 0) / rois.length).toFixed(1), top10: +(100 * rows.filter(r => r.pct != null && r.pct >= 90).length / rows.length).toFixed(1) }; };
const R = sb.rows;
sb.totals = { all: summary(R), fromSim: summary(R.filter(r => r.source === "from sim" || (r.source == null && r.lab != null))), handBuilt: summary(R.filter(r => r.source === "hand-built" || (r.source == null && r.lab == null))), sharp: summary(R.filter(r => r.sharp === true)), notSharp: summary(R.filter(r => r.sharp === false)),
  bySlate: Object.fromEntries([...new Set(R.map(r => r.slate))].map(s => [s, summary(R.filter(r => r.slate === s))])) };
sb.updated = out.at; fs.writeFileSync(sbF, JSON.stringify(sb, null, 1));
// print
for (const c of out.contests) {
  console.log(`\n$${c.fee} ${c.name} (${(c.entries || 0).toLocaleString()} entries)`);
  if (c.error) { console.log("  " + c.error); continue; }
  for (const l of c.lineups) console.log(`  finish ${l.finish}${l.pct != null ? ` (top ${(100 - l.pct).toFixed(1)}%)` : ""}  ${l.points != null ? (+l.points).toFixed(1) : "?"} pts  ROI ${l.roi}%  dupes ${l.dupes}  ${l.sim && l.sim.lab != null ? `[${l.sim.source}] grade ${l.sim.grade ?? "?"}  Lab ROI ${l.sim.lab}% (#${l.sim.rank} of ${l.sim.of})${l.sim.sharp ? " sharp" : ""}` : l.sim ? `[${l.sim.source}] ${l.sim.error || "ungraded"}` : "not graded (no sim run)"}${l.planned ? "" : "  [not in the plan]"}\n    ${l.names.join(", ")}`);
  if (c.top.length) console.log(`  winner: ${(+c.top[0].points).toFixed(1)} pts (${c.top[0].user}) ${c.top[0].names.join(", ")}`);
}
const fmt = s => s ? `${s.entries} entries, $${s.fees.toLocaleString()} in, ROI ${s.roi}% (median ${s.medianRoi}%, mean ${s.meanRoi}%), top-10% ${s.top10}%` : "none";
const t = sb.totals, here = summary(R.filter(r => r.slate === out.slate));
console.log(`\nThis slate: ${fmt(here)}${out.handBuilt ? `  | hand-built graded ${out.handBuilt.graded}/${out.handBuilt.lineups}` : ""}`);
console.log(`Scoreboard so far: ${fmt(t.all)}\n  from the sim ${fmt(t.fromSim)} | hand-built ${fmt(t.handBuilt)} | sharp-filter ${fmt(t.sharp)} | outside it ${fmt(t.notSharp)}`);
