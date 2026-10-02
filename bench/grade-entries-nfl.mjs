// Grade every imported entry after its contest ran: finish, ROI, cash, top-1%, and where it sat in
// Stokastic's post-contest sim ranking, matched to this account's lineups in the pulled contest
// (pulled here from Stokastic's open API when data/post/nfl does not have it yet). Results go
// back into data/<slate>/entries.json and a season ledger, data/reports/entries-ledger-nfl.json,
// that the Review tab reads: ROI by verdict, by rule broken, by tag, and the thesis next to each.
//   node bench/grade-entries-nfl.mjs [--user=jtmac1999] [--nopull]
import fs from "node:fs";
import path from "node:path";
import { listPost, readPost, writePost, postFile, compact } from "./post-store.mjs";
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
export const ME = (flag("user") || "jtmac1999").toLowerCase(), NOPULL = process.argv.includes("--nopull");
const BASE = "https://app-api-dfs-prod-main.azurewebsites.net/api/contests/";
const getJ = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u.split("?")[0]}`); return r.json(); };

async function pullContest(cid, meta) {
  const q = `siteContestId=${cid}&contestType=PostContest&currentPage=1&pageSize=150`;
  const lineups = await getJ(`${BASE}getRoiByLineup?${q}&sortBy=SIMROI&sortOrder=DESC&includeAllLineups=true`);
  if (!Array.isArray(lineups) || !lineups.length) return null;
  const players = await getJ(`${BASE}getRoiByPlayer?${q}&opponent=&includeAllPLayers=true`);
  const contest = { key: String(cid), sport: "nfl", date: meta.date, name: meta.name, fee: meta.fee, type: /showdown/i.test(meta.name) ? "Showdown" : "Classic", entries: lineups.length };
  const obj = compact({ contest, pulledAt: new Date().toISOString(), lineups, players: Array.isArray(players) ? players : [] });
  writePost(postFile(contest), obj); return obj;
}
function findPost(cid) { const f = listPost("nfl", x => x.includes(`-${cid}.json`))[0]; return f ? readPost(f) : null; }

export async function gradeAll() {
  const ledger = [], dirs = fs.readdirSync("data").filter(d => /^\d{4}-\d{2}-\d{2}-nfl-/.test(d) && fs.existsSync(path.join("data", d, "entries.json"))).sort();
  let graded = 0, pulled = 0, missing = [];
  for (const d of dirs) {
    const file = path.join("data", d, "entries.json"), E = JSON.parse(fs.readFileSync(file, "utf8")), date = d.slice(0, 10); let changed = false;
    // the slate notes (Notes tab) are the user's read on the slate; they ride along into the ledger
    const notesF = path.join("data", d, "notes.md"), notes = fs.existsSync(notesF) ? fs.readFileSync(notesF, "utf8").trim().slice(0, 600) : "";
    const posts = {};
    for (const e of E.entries) {
      if (!e.ok || !e.cid) continue;
      if (!posts[e.cid]) { let j = findPost(e.cid); if (!j && !NOPULL && date <= new Date().toISOString().slice(0, 10)) { try { j = await pullContest(e.cid, { date, name: e.contest, fee: e.fee }); if (j) pulled++; } catch (err) { missing.push(`${e.cid} ${err.message}`); } } posts[e.cid] = j || false; }
      const j = posts[e.cid]; if (!j || !j.lineups?.length) continue;
      const N = j.lineups.length, mine = j.lineups.filter(l => String(l.u).toLowerCase() === ME);
      const byName = new Map(j.players.map(p => [p.id, p])), want = new Set((e.players || []).map(p => p.dkId).filter(Boolean));
      let hit = want.size ? mine.find(l => l.ids.length === want.size && l.ids.every(id => want.has(String(id)))) : null;
      if (!hit) { const names = new Set(e.players.map(p => p.name.toLowerCase())); hit = mine.find(l => l.ids.every(id => byName.get(id) && names.has(byName.get(id).name.toLowerCase()))); }
      if (!hit) continue;
      const order = j.lineups.slice().sort((a, b) => b.sroi - a.sroi), simPct = order.indexOf(hit) / N;
      e.result = { fin: hit.fin, N, roi: hit.aroi, won: +((1 + (hit.aroi || 0)) * e.fee).toFixed(2), cash: hit.aroi > -1 ? 1 : 0, top1: hit.fin <= Math.max(1, Math.ceil(N * 0.01)) ? 1 : 0, top10: hit.fin <= N * 0.1 ? 1 : 0, win: hit.fin === 1 ? 1 : 0, dup: hit.dup || 0, simPct: +(1 - simPct).toFixed(2), pts: hit.afp, gradedAt: new Date().toISOString() };
      changed = true; graded++;
      ledger.push({ dir: d, date, contest: e.contest, cid: e.cid, fee: e.fee, entryId: e.entryId, verdict: e.verdict, broken: e.broken || [], sim: e.sim ? { worst: e.sim.worst, agree: e.sim.agree, pctMed: e.sim.pctMed, sources: e.sim.sources.length } : null, dup: e.dup ? e.dup.meanDup : null, own: e.own, chalk: e.chalk, left: e.left, notes, tag: e.tag || "", result: e.result, lineup: e.players.map(p => p.name) });
    }
    if (changed) { E.gradedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(E, null, 1)); }
  }
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const roiOf = a => a.length ? +(mean(a.map(x => x.result.roi)) * 100).toFixed(1) : null;
  const byVerdict = {}; for (const v of ["ok", "warn", "FAIL"]) { const a = ledger.filter(x => x.verdict === v); if (a.length) byVerdict[v] = { n: a.length, roi: roiOf(a), cash: +(100 * mean(a.map(x => x.result.cash))).toFixed(0), top10: +(100 * mean(a.map(x => x.result.top10))).toFixed(0), fees: a.reduce((s, x) => s + x.fee, 0), won: +a.reduce((s, x) => s + x.result.won, 0).toFixed(0) }; }
  const rules = {}; for (const x of ledger) for (const r of x.broken) (rules[r] = rules[r] || []).push(x);
  const byRule = Object.fromEntries(Object.entries(rules).map(([r, a]) => [r, { n: a.length, roi: roiOf(a), roiNot: roiOf(ledger.filter(x => !x.broken.includes(r))) }]));
  const byTag = {}; for (const t of ["rule broken", "rule wrong", "variance", ""]) { const a = ledger.filter(x => (x.tag || "") === t); if (a.length) byTag[t || "untagged"] = { n: a.length, roi: roiOf(a) }; }
  const simAgree = {}; for (const x of ledger) if (x.sim) (simAgree[x.sim.agree] = simAgree[x.sim.agree] || []).push(x);
  const out = { built: new Date().toISOString(), user: ME, entries: ledger.length, fees: ledger.reduce((s, x) => s + x.fee, 0), won: +ledger.reduce((s, x) => s + x.result.won, 0).toFixed(0), roi: roiOf(ledger), byVerdict, byRule, byTag, bySimAgree: Object.fromEntries(Object.entries(simAgree).map(([k, a]) => [k, { n: a.length, roi: roiOf(a) }])), ledger: ledger.sort((a, b) => b.date.localeCompare(a.date) || b.fee - a.fee) };
  fs.mkdirSync("data/reports", { recursive: true });
  fs.writeFileSync("data/reports/entries-ledger-nfl.json", JSON.stringify(out, null, 1));
  return { graded, pulled, missing, entries: ledger.length, roi: out.roi };
}
if (process.argv[1] && /grade-entries-nfl\.mjs$/.test(process.argv[1])) { const r = await gradeAll(); console.log(`graded ${r.graded} entries (${r.pulled} contests pulled), ledger ${r.entries} entries, ROI ${r.roi == null ? "-" : r.roi + "%"}${r.missing.length ? "; could not pull: " + r.missing.join(", ") : ""}`); }
