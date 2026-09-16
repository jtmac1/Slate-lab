// Nightly report. Pulls yesterday's contests from Stokastic, refreshes the sharps roster on the
// rolling window, and writes data/reports/<date>.md with: your results, what the sharps played
// and faded, how they differ from you, and how the engine graded on the new contests.
//   node bench/report.mjs                 (yesterday, MLB)
//   node bench/report.mjs 2026-09-14 MLB  (a specific night)
// No Claude involved: pure data. Read the newest report at the start of a session.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listContests, gradeContest, feeTier } from "./grade-all.mjs";

const args = process.argv.slice(2), sport = (args.find(a => /^[A-Za-z]+$/.test(a)) || "MLB").toUpperCase();
const night = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const WINDOW_FROM = sport === "MLB" ? "2026-08-01" : "2025-09-01", YOU = "jtmac1999", MINC = 30;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0, pct = v => (100 * v).toFixed(0) + "%", money = v => "$" + Math.round(v).toLocaleString();
const dir = path.join("data/post", sport.toLowerCase()), repDir = "data/reports"; fs.mkdirSync(repDir, { recursive: true });

// 1. pull the night (and re-try the last 3 nights in case Stokastic simulated late)
const from = new Date(new Date(night) - 3 * 864e5).toISOString().slice(0, 10);
let pullLog = "";
try { pullLog = execFileSync(process.execPath, ["bench/pull-stokastic.mjs", from, night, sport], { encoding: "utf8" }); } catch (e) { pullLog = "pull failed: " + (e.stdout || e.message); }

// 2. load the window
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".json") && f.slice(0, 10) >= WINDOW_FROM).sort() : [];
const contests = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const stackKey = info => String(info || "").split("|").map(s => +s.trim().split(" ").pop()).filter(n => n >= 2).sort((a, b) => b - a).join("-") || "none";

// per-user stats over the window
const U = {};
for (const j of contests) {
  const N = j.lineups.length, c = j.contest;
  for (const l of j.lineups) {
    const u = U[l.user] || (U[l.user] = { user: l.user, n: 0, top10: 0, cash: 0, fee: 0, won: 0, dup: 0, own: 0, contests: new Set() });
    u.n++; u.top10 += l.actualFinishPosition <= N / 10 ? 1 : 0; u.cash += l.actualLineupRoi > -1 ? 1 : 0; u.fee += c.fee; u.won += c.fee * (1 + (l.actualLineupRoi ?? -1)); u.dup += l.duplicates > 0 ? 1 : 0; u.own += 100 * (l.ownershipSum || 0); u.contests.add(c.key);
  }
}
const users = Object.values(U).map(u => Object.assign(u, { c: u.contests.size, z: (u.top10 / u.n - 0.1) / Math.sqrt(0.09 / u.n), roi: u.won / u.fee - 1 }));
const sharps = users.filter(u => u.c >= MINC && u.z >= 2.5 && u.roi > 0).sort((a, b) => b.z - a.z), SH = new Set(sharps.map(u => u.user));
const rosterFile = path.join(repDir, `sharps-${sport.toLowerCase()}.json`), prev = fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile, "utf8")) : [];
fs.writeFileSync(rosterFile, JSON.stringify(sharps.map(u => u.user)));
const joined = sharps.filter(u => !prev.includes(u.user)).map(u => u.user), left = prev.filter(n => !SH.has(n));

// 3. the night itself
const tonight = contests.filter(j => j.contest.date === night);
const out = [];
out.push(`# ${sport} report for ${night}`, "", `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}. Window ${WINDOW_FROM} to ${night}: ${contests.length} contests, ${users.length} users.`, "", "## Pull", "```", pullLog.trim(), "```");

// your night
const mine = []; for (const j of tonight) for (const l of j.lineups) if (l.user === YOU) mine.push({ c: j.contest, l, N: j.lineups.length });
out.push("", "## Your night");
if (!mine.length) out.push(`No entries of yours in the ${tonight.length} pulled contests.`);
else {
  const fee = mine.reduce((s, m) => s + m.c.fee, 0), won = mine.reduce((s, m) => s + m.c.fee * (1 + (m.l.actualLineupRoi ?? -1)), 0);
  out.push(`${mine.length} entries in ${new Set(mine.map(m => m.c.key)).size} contests: ${money(fee)} in, ${money(won)} back, ROI ${pct(won / fee - 1)}, top-10% finishes ${mine.filter(m => m.l.actualFinishPosition <= m.N / 10).length}, dupes ${mine.filter(m => m.l.duplicates > 0).length}.`);
  const byC = {}; for (const m of mine) { const g = byC[m.c.key] || (byC[m.c.key] = { c: m.c, n: 0, fee: 0, won: 0, best: Infinity, N: m.N }); g.n++; g.fee += m.c.fee; g.won += m.c.fee * (1 + (m.l.actualLineupRoi ?? -1)); g.best = Math.min(g.best, m.l.actualFinishPosition); }
  for (const g of Object.values(byC).sort((a, b) => b.fee - a.fee)) out.push(`- ${g.c.name} · x${g.n} · ${money(g.fee)} -> ${money(g.won)} · best finish ${g.best} of ${g.N}`);
}
const you = users.find(u => u.user === YOU);
if (you) out.push("", `Window: ${you.n} entries, ${money(you.fee)} in, ROI ${pct(you.roi)}, top-10% rate ${pct(you.top10 / you.n)}, cash ${pct(you.cash / you.n)}, dupes ${pct(you.dup / you.n)}, ownsum ${(you.own / you.n).toFixed(0)}.`);

// sharps
out.push("", `## Sharps (${sharps.length} users with ${MINC}+ contests, top-10% z>=2.5, ROI>0)`);
if (joined.length) out.push(`Joined the roster: ${joined.join(", ")}.`); if (left.length) out.push(`Dropped off: ${left.join(", ")}.`);
const prof = list => { const n = list.reduce((s, u) => s + u.n, 0); return { n, top10: list.reduce((s, u) => s + u.top10, 0) / n, cash: list.reduce((s, u) => s + u.cash, 0) / n, roi: list.reduce((s, u) => s + u.won, 0) / list.reduce((s, u) => s + u.fee, 0) - 1, dup: list.reduce((s, u) => s + u.dup, 0) / n, own: list.reduce((s, u) => s + u.own, 0) / n }; };
const ps = prof(sharps), pf = prof(users), py = you ? prof([you]) : null;
out.push("", "| | Sharps | Field | You |", "|---|---|---|---|", `| top-10% rate | ${pct(ps.top10)} | ${pct(pf.top10)} | ${py ? pct(py.top10) : "-"} |`, `| cash rate | ${pct(ps.cash)} | ${pct(pf.cash)} | ${py ? pct(py.cash) : "-"} |`, `| ROI | ${pct(ps.roi)} | ${pct(pf.roi)} | ${py ? pct(py.roi) : "-"} |`, `| duplicated entries | ${pct(ps.dup)} | ${pct(pf.dup)} | ${py ? pct(py.dup) : "-"} |`, `| ownership sum | ${ps.own.toFixed(0)} | ${pf.own.toFixed(0)} | ${py ? py.own.toFixed(0) : "-"} |`);
out.push("", "Roster: " + sharps.slice(0, 20).map(u => `${u.user} (${u.c} contests, ${money(u.fee)}, ${pct(u.roi)})`).join("; ") + (sharps.length > 20 ? "; …" : ""));

// what the sharps did tonight, contest by contest
out.push("", "## What the sharps played tonight");
let any = false;
for (const j of tonight.sort((a, b) => b.contest.fee - a.contest.fee)) {
  const N = j.lineups.length, sl = j.lineups.filter(l => SH.has(l.user)); if (sl.length < 5) continue; any = true;
  const byId = {}; for (const p of j.players) byId[(String(p.exportableNameAndId).match(/\((\d+)\)/) || [])[1]] = p;
  const exp = {}; for (const l of sl) for (const s of l.exportableLineup.split(",")) { const id = (s.match(/\((\d+)\)/) || [])[1]; exp[id] = (exp[id] || 0) + 1 / sl.length; }
  const rows = Object.entries(exp).map(([id, e]) => ({ p: byId[id], e, own: byId[id] ? byId[id].overallOwnership || 0 : 0 })).filter(r => r.p);
  const over = rows.filter(r => r.e - r.own >= 0.08).sort((a, b) => (b.e - b.own) - (a.e - a.own)).slice(0, 5), under = rows.filter(r => r.own >= 0.15 && r.own - r.e >= 0.08).sort((a, b) => (b.own - b.e) - (a.own - a.e)).slice(0, 5);
  const st = {}; for (const l of sl) { const k = stackKey(l.stackInfo); st[k] = (st[k] || 0) + 1 / sl.length; }
  const fee = sl.length * j.contest.fee, won = sl.reduce((s, l) => s + j.contest.fee * (1 + (l.actualLineupRoi ?? -1)), 0);
  const teams = {}; for (const l of sl) { const t = (l.stackInfo || "").split("|").map(s => s.trim().split(" ")).sort((a, b) => +b[1] - +a[1])[0]; if (t) teams[t[0]] = (teams[t[0]] || 0) + 1 / sl.length; }
  out.push("", `### ${j.contest.name} (${money(j.contest.fee)}, ${N} entries)`, `Sharps: ${sl.length} entries from ${new Set(sl.map(l => l.user)).size} users, ROI ${pct(won / fee - 1)}, top-10% ${pct(sl.filter(l => l.actualFinishPosition <= N / 10).length / sl.length)}. Stacks: ${Object.entries(st).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}. Stack teams: ${Object.entries(teams).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}.`);
  if (over.length) out.push(`- Over the field: ${over.map(r => `${r.p.player} ${pct(r.e)} vs ${pct(r.own)} (${r.p.actualPlayerRoiPct})`).join("; ")}`);
  if (under.length) out.push(`- Faded chalk: ${under.map(r => `${r.p.player} ${pct(r.e)} vs ${pct(r.own)} (${r.p.actualPlayerRoiPct})`).join("; ")}`);
}
if (!any) out.push("No contest tonight had 5+ sharp entries.");

// engine grade on tonight's contests
out.push("", "## Engine on tonight's contests");
const graded = listContests().filter(c => c.json && c.date === night && c.sport === sport.toLowerCase()).map(c => { try { return gradeContest(c, { iters: 4000 }); } catch (e) { return null; } }).filter(Boolean);
if (!graded.length) out.push("Nothing to grade.");
else { out.push(`${graded.length} contests. Lineup ROI rank correlation with actual: Stokastic ${mean(graded.map(r => r.sStk)).toFixed(3)}, mine ${mean(graded.map(r => r.sMine)).toFixed(3)} (agreement ${mean(graded.map(r => r.agree)).toFixed(2)}). Player ROI: Stokastic ${mean(graded.map(r => r.pStk)).toFixed(2)}, mine ${mean(graded.map(r => r.pMine)).toFixed(2)}. Realized top-10%: Stokastic ${mean(graded.map(r => r.roiStk)).toFixed(0)}%, mine ${mean(graded.map(r => r.roiMine)).toFixed(0)}%, field ${mean(graded.map(r => r.fieldROI)).toFixed(0)}%.`);
  for (const r of graded.sort((a, b) => b.fee - a.fee)) out.push(`- ${r.name} (${feeTier(r.fee)}, ${r.N} entries): Stk ${r.sStk.toFixed(2)} / mine ${r.sMine.toFixed(2)}, top-10% realized Stk ${r.roiStk.toFixed(0)}% / mine ${r.roiMine.toFixed(0)}%`); }

const file = path.join(repDir, `${sport.toLowerCase()}-${night}.md`);
fs.writeFileSync(file, out.join("\n") + "\n");
fs.appendFileSync(path.join(repDir, "index.md"), `- ${night} ${sport}: ${tonight.length} contests, you ${mine.length ? pct(mine.reduce((s, m) => s + m.c.fee * (1 + (m.l.actualLineupRoi ?? -1)), 0) / mine.reduce((s, m) => s + m.c.fee, 0) - 1) : "no entries"}, sharps ${sharps.length}${joined.length ? " (+" + joined.length + ")" : ""}${left.length ? " (-" + left.length + ")" : ""}\n`);
console.log(`wrote ${file}`);
