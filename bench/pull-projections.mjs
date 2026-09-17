// Save Stokastic Data Hub projections for a DK MLB slate as the CSV the app parses, with history.
// Each run asks Stokastic when projections/ownership were last updated; if either changed since the
// last pull it writes a timestamped snapshot, refreshes the latest CSV, and logs what moved.
//   node bench/pull-projections.mjs [date=today] [slate=Main|Early|Night|Turbo|<slateId>] [sport=MLB] [--force] [--watch N]
//   --force    save a snapshot even if Stokastic reports no update
//   --watch N  keep checking every N minutes until the slate locks (Ctrl+C to stop)
// Files: data/<date>-<sport>-<slate>/DK_<SPORT>_<Slate>_Data_Hub_Projections.csv (latest), snapshots/<HHMM>_proj<HHMM>_own<HHMM>.csv,
//        slate.json (slate + last update stamps), pulls.log (one line per check).
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";
import { stkToCSV } from "../src/engine/stokastic.mjs";
const BASE = "https://app-api-dfs-prod-main.azurewebsites.net/api/";
const args = process.argv.slice(2), flags = args.filter(a => a.startsWith("--")), pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--watch"));
const FORCE = flags.includes("--force"), WATCH = flags.includes("--watch") ? +args[args.indexOf("--watch") + 1] || 5 : 0;
// Stokastic stamps come without a zone and are UTC
const utc = d => typeof d === "string" && !/Z|[+-]dd:dd$/.test(d) ? d + "Z" : d;
const local = d => new Date(utc(d)).toLocaleString("sv-SE").slice(0, 16), hhmm = d => new Date(utc(d)).toLocaleString("sv-SE").slice(11, 16).replace(":", "");
const today = new Date().toLocaleString("sv-SE").slice(0, 10);
const [date = today, slateArg = "Main", sport = "MLB"] = pos;
const get = async u => { const r = await fetch(BASE + u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const info = await get("contests/getPreContestSlateInfo?app=DATAHUB");
const slates = info.filter(s => s.site === "DK" && s.sport === sport.toUpperCase() && s.startTime.startsWith(date));
const slate = /^\d+$/.test(slateArg) ? slates.find(s => String(s.slateId) === slateArg) : slates.find(s => s.type === "CLASSIC" && s.name.toLowerCase() === slateArg.toLowerCase()) || slates.find(s => s.name.toLowerCase().startsWith(slateArg.toLowerCase()));
if (!slate) { console.error(`no ${sport} DK slate "${slateArg}" on ${date}. Available:\n` + slates.map(s => `  ${s.slateId}  ${s.type.padEnd(9)} ${s.name.padEnd(12)} ${s.startTime.slice(11, 16)}  ${(s.matchupInfo || []).map(m => m.awayTeamAbbrev + "@" + m.homeTeamAbbrev).join(" ")}`).join("\n")); process.exit(1); }
const slateName = slate.type === "SHOWDOWN" ? slate.name.replace(/\W+/g, "") : slate.name;
const dir = path.join("data", `${date}-${sport.toLowerCase()}-${slateName.toLowerCase()}`), latest = path.join(dir, `DK_${sport.toUpperCase()}_${slateName}_Data_Hub_Projections.csv`), snapDir = path.join(dir, "snapshots"), meta = path.join(dir, "slate.json"), logFile = path.join(dir, "pulls.log");
fs.mkdirSync(snapDir, { recursive: true });
const lockMs = new Date(slate.startTime + (slate.startTime.length <= 19 ? "-04:00" : "")).getTime();   // Stokastic times are US Eastern

async function check() {
  const now = new Date(), upd = await get(`slatedata/slateUpdateInfo?slateId=${slate.slateId}`);
  const prev = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, "utf8")) : {};
  const changed = upd.projectionsLastUpdated !== prev.projectionsUpdated || upd.ownershipLastUpdated !== prev.ownershipUpdated;
  const stamp = `${local(now)} check  proj ${local(upd.projectionsLastUpdated)}  own ${local(upd.ownershipLastUpdated)}`;
  if (!changed && !FORCE) { const line = `${stamp}  no change`; fs.appendFileSync(logFile, line + "\n"); console.log(line); return false; }
  const proj = await get(`slatedata/projections?SlateId=${slate.slateId}`);
  const csv = stkToCSV(proj, sport);
  // what moved since the previous latest file
  let moves = "";
  if (fs.existsSync(latest)) {
    const old = {}; const oldRows = parseCSV(fs.readFileSync(latest, "utf8")), H = oldRows[0].map(h => h.trim().toLowerCase()), ci = n => H.indexOf(n); for (const r of oldRows.slice(1)) if (r.length > 6) old[r[0]] = { proj: +r[ci("projection")], own: +r[ci("ownership %")], conf: ci("confirmed") >= 0 ? r[ci("confirmed")] : "" };
    const d = proj.filter(p => p.projection > 0 || (old[p.name] && old[p.name].proj > 0)).map(p => ({ n: p.name, dp: p.projection - (old[p.name]?.proj ?? 0), dOwn: 100 * (p.ownership || 0) - (old[p.name]?.own ?? 0), newConf: p.confirmedLineup && old[p.name]?.conf !== "C", out: p.projection === 0 && (old[p.name]?.proj ?? 0) > 0 }));
    const up = d.filter(x => Math.abs(x.dp) >= 0.5).sort((a, b) => Math.abs(b.dp) - Math.abs(a.dp)), own = d.filter(x => Math.abs(x.dOwn) >= 2).sort((a, b) => Math.abs(b.dOwn) - Math.abs(a.dOwn)), outs = d.filter(x => x.out), conf = d.filter(x => x.newConf);
    moves = `  proj moves>=0.5: ${up.length}${up.length ? " (" + up.slice(0, 5).map(x => `${x.n} ${x.dp > 0 ? "+" : ""}${x.dp.toFixed(1)}`).join(", ") + ")" : ""}; own moves>=2pp: ${own.length}${own.length ? " (" + own.slice(0, 4).map(x => `${x.n} ${x.dOwn > 0 ? "+" : ""}${x.dOwn.toFixed(0)}`).join(", ") + ")" : ""}${outs.length ? "; OUT: " + outs.map(x => x.n).join(", ") : ""}${conf.length ? "; newly confirmed: " + conf.length : ""}`;
  }
  const snap = path.join(snapDir, `${hhmm(now)}_proj${hhmm(upd.projectionsLastUpdated)}_own${hhmm(upd.ownershipLastUpdated)}.csv`);
  fs.writeFileSync(snap, csv); fs.writeFileSync(latest, csv);
  fs.writeFileSync(meta, JSON.stringify({ slateId: slate.slateId, name: slate.name, type: slate.type, start: slate.startTime, games: (slate.matchupInfo || []).map(m => m.awayTeamAbbrev + "@" + m.homeTeamAbbrev), projectionsUpdated: upd.projectionsLastUpdated, ownershipUpdated: upd.ownershipLastUpdated, pulledAt: now.toISOString(), snapshots: fs.readdirSync(snapDir).length }, null, 2));
  const line = `${stamp}  SAVED ${path.basename(snap)}  ${proj.filter(p => p.projection > 0).length} projected${moves}`;
  fs.appendFileSync(logFile, line + "\n"); console.log(line); return true;
}
console.log(`${slate.name} ${slate.type} ${date}, lock ${local(lockMs)} local, slate ${slate.slateId} -> ${dir}`);
await check();
if (WATCH) {
  while (Date.now() < lockMs) { await new Promise(r => setTimeout(r, WATCH * 60000)); try { await check(); } catch (e) { const line = `${local(new Date())} check  ERROR ${e.message}`; fs.appendFileSync(logFile, line + "\n"); console.log(line); } }
  console.log("slate locked; watch finished");
}
