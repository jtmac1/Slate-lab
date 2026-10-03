// "Grade the week": finds the user's entries on a slate and grades them against what the Pre-Contest Simulator said.
// Entries come from Stokastic's post-contest data filtered by DK username (no DraftKings export, no login): every
// contest in the slate's Entry Manager plan (data/<slate>/entry-plan.json) plus every contest Stokastic simulated on
// the slate. Each lineup is matched to the slate's simrun.json (Lab ROI, rank, the sharp-construction filter) and to the
// contest's top finishers. Writes data/<slate>/week-grade.json and appends to data/reports/scoreboard-nfl.json.
//   node bench/grade-week-nfl.mjs data/2026-10-04-nfl-sun-mon [--user=jtmac1999]
import fs from "node:fs";
import path from "node:path";
const API = "https://app-api-dfs-prod-main.azurewebsites.net/api/contests/";
const dir = process.argv[2], USER = (process.argv.find(a => a.startsWith("--user=")) || "--user=jtmac1999").slice(7);
if (!dir || !fs.existsSync(dir)) { console.error("usage: node bench/grade-week-nfl.mjs data/<slate>"); process.exit(1); }
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const get = async q => { const r = await fetch(API + q); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const plan = readJ(path.join(dir, "entry-plan.json")) || { contests: [] }, sim = readJ(path.join(dir, "simrun.json")), meta = readJ(path.join(dir, "slate.json")) || {};
const nm = s => String(s || "").toLowerCase().replace(/\s*\(\d+\)\s*$/, "").replace(/[.'`’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();
const sigNames = names => names.map(nm).sort().join("|");
// the simulator's view of every lineup it graded, keyed by the sorted player names
const simBy = new Map(); if (sim && sim.rows) { const order = sim.rows.slice().sort((a, b) => b.sim.lab - a.sim.lab); order.forEach((e, i) => simBy.set(sigNames(e.players.map(p => p.name)), { lab: e.sim.lab, rank: i + 1, of: order.length, sharp: e.stackN >= 2 && e.bring && e.left < 600 && e.chalk >= 3, dupN: e.sim.dupN, type: e.type })); }
// plan shapes: Entry Manager (contests[].entries[].lineup, from the DraftKings entries file) or the older contests[].lineups
const planLineups = c => c.entries ? c.entries.map(e => e.lineup).filter(l => l && l.length) : (c.lineups || []);
const lobbyBy = new Map(((readJ("data/dk-lobby/nfl.json") || {}).contests || []).map(c => [String(c.id), c]));
const planned = new Map(); for (const c of plan.contests || []) for (const l of planLineups(c)) planned.set(String(c.cid) + "|" + sigNames(l), true);

// contests to search: the plan's, plus every contest Stokastic simulated on this slate
const contests = new Map((plan.contests || []).map(c => [String(c.cid), { key: String(c.cid), name: c.name, fee: c.fee, entries: c.field || (lobbyBy.get(String(c.cid)) || {}).field || null, planned: planLineups(c).length, held: c.entries ? c.entries.length : null }]));
if (meta.slateId) { try { for (const c of await get("getSimulatedContests?slateId=" + meta.slateId)) if (c.site === "DK" && !contests.has(String(c.siteContestId))) contests.set(String(c.siteContestId), { key: String(c.siteContestId), name: c.name.trim(), fee: c.entryFee, entries: c.entryCount, planned: 0 }); } catch {} }

const out = { slate: path.basename(dir), user: USER, at: new Date().toISOString(), contests: [] };
for (const c of contests.values()) {
  const base = `siteContestId=${c.key}&currentPage=1&pageSize=150&contestType=PostContest`;
  let mine = []; try { mine = await get(`getRoiByLineup?${base}&user=${encodeURIComponent(USER)}&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=false`); } catch (e) { if (c.planned) out.contests.push({ ...c, error: "Stokastic has no post-contest data for this contest (" + e.message + ")" }); continue; }
  if (!Array.isArray(mine) || !mine.length) { if (c.planned) out.contests.push({ ...c, error: "no entries found under " + USER + " (not simulated by Stokastic, or not entered)" }); continue; }
  let top = []; try { const all = await get(`getRoiByLineup?${base}&user=&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=true`); top = (Array.isArray(all) ? all : []).filter(x => x.actualFinishPosition != null).sort((a, b) => a.actualFinishPosition - b.actualFinishPosition).slice(0, 3); } catch {}
  const N = c.entries || null;
  const lineups = mine.map(x => { const names = String(x.exportableLineup || "").split(",").map(s => s.trim()).filter(Boolean), s = sigNames(names), v = simBy.get(s) || null;
    return { names: names.map(n => n.replace(/\s*\(\d+\)$/, "")), finish: x.actualFinishPosition, pct: N && x.actualFinishPosition ? +(100 * (1 - (x.actualFinishPosition - 1) / N)).toFixed(1) : null, points: x.actualFantasyPoints, roi: x.actualLineupRoi != null ? +(100 * x.actualLineupRoi).toFixed(0) : null, dupes: x.duplicates || 0, stkSimROI: x.simLineupRoi != null ? +(100 * x.simLineupRoi).toFixed(0) : null, planned: planned.has(c.key + "|" + s), sim: v }; }).sort((a, b) => (a.finish || 1e9) - (b.finish || 1e9));
  out.contests.push({ ...c, lineups, top: top.map(x => ({ finish: x.actualFinishPosition, points: x.actualFantasyPoints, user: x.user, names: String(x.exportableLineup || "").split(",").map(s => s.trim().replace(/\s*\(\d+\)$/, "")) })) });
}
fs.writeFileSync(path.join(dir, "week-grade.json"), JSON.stringify(out, null, 1));
// running scoreboard: one row per entry, so weeks add up
const sbF = "data/reports/scoreboard-nfl.json", sb = readJ(sbF) || { rows: [] };
sb.rows = sb.rows.filter(r => r.slate !== out.slate);
for (const c of out.contests) for (const l of c.lineups || []) sb.rows.push({ slate: out.slate, contest: c.key, name: c.name, fee: c.fee, entries: c.entries, finish: l.finish, pct: l.pct, roi: l.roi, dupes: l.dupes, planned: l.planned, lab: l.sim ? l.sim.lab : null, labRank: l.sim ? l.sim.rank : null, simOf: l.sim ? l.sim.of : null, sharp: l.sim ? l.sim.sharp : null });
sb.updated = out.at; fs.writeFileSync(sbF, JSON.stringify(sb, null, 1));
// print
for (const c of out.contests) {
  console.log(`\n$${c.fee} ${c.name} (${(c.entries || 0).toLocaleString()} entries)`);
  if (c.error) { console.log("  " + c.error); continue; }
  for (const l of c.lineups) console.log(`  finish ${l.finish}${l.pct != null ? ` (top ${(100 - l.pct).toFixed(1)}%)` : ""}  ${l.points != null ? (+l.points).toFixed(1) : "?"} pts  ROI ${l.roi}%  dupes ${l.dupes}  ${l.sim ? `Lab ROI ${l.sim.lab}% (#${l.sim.rank} of ${l.sim.of})${l.sim.sharp ? " sharp" : ""}` : "not in the sim run"}${l.planned ? "" : "  [not in the plan]"}\n    ${l.names.join(", ")}`);
  if (c.top.length) console.log(`  winner: ${(+c.top[0].points).toFixed(1)} pts (${c.top[0].user}) ${c.top[0].names.join(", ")}`);
}
const R = sb.rows, mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, grp = f => { const s = R.filter(f); return s.length ? `${s.length} entries, avg ROI ${mean(s.map(r => r.roi ?? -100)).toFixed(0)}%, top-10% ${(100 * s.filter(r => r.pct != null && r.pct >= 90).length / s.length).toFixed(0)}%` : "none"; };
console.log(`\nScoreboard so far: all ${grp(() => true)} | sharp-filter lineups ${grp(r => r.sharp === true)} | outside it ${grp(r => r.sharp === false)} | not from the sim ${grp(r => r.lab == null)}`);
