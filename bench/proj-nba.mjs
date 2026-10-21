// Lab NBA DK classic projection for a slate folder (src/engine/nba-proj.mjs): ESPN box scores before <date> (this season, plus
// earlier seasons weighted down), players / salaries / positions from the Data Hub projections CSV (its Projection column is not
// read), home teams from slate.json. Availability from each player's previous team game only, unless --out names players OUT.
//   node bench/proj-nba.mjs <date> [--dir=data/<date>-nba-main] [--out="Name,Name"] [--nofetch]   -> <dir>/proj-lab.csv
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";
import { fetchRange, loadGames } from "./nba-espn.mjs";
import { indexHistory, projectSlate, espnTeam, nm, seasonOf } from "../src/engine/nba-proj.mjs";

const args = process.argv.slice(2), flag = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!date) { console.log('usage: node bench/proj-nba.mjs <date> [--dir=data/<date>-nba-main] [--out="Name,Name"] [--nofetch]'); process.exit(1); }
const dir = flag("dir") || `data/${date}-nba-main`, src = fs.readdirSync(dir).find(f => /Projections\.csv$/i.test(f));
if (!src) { console.log(`no *Projections.csv in ${dir}`); process.exit(1); }
const prev = (() => { const x = new Date(date + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); })();
if (!args.includes("--nofetch")) await fetchRange(`${seasonOf(date)}-10-01`, prev, { log: false });

const [hdr, ...body] = parseCSV(fs.readFileSync(path.join(dir, src), "utf8")), col = n => hdr.indexOf(n);
const players = body.map(r => ({ name: r[col("Player")], dkTeam: r[col("Team")], team: espnTeam(r[col("Team")]), opp: espnTeam(r[col("Opponent")]), pos: r[col("Position")], sal: +r[col("Salary")] || 0 })).filter(p => p.name && p.sal > 0);
let home = null; try { home = new Set(JSON.parse(fs.readFileSync(path.join(dir, "slate.json"), "utf8")).games.map(g => espnTeam(g.split("@")[1]))); } catch {}
const H = indexHistory(loadGames({ to: date }));
const outIds = new Set(String(flag("out") || "").split(",").map(s => H.nameToId.get(nm(s))).filter(Boolean));
const res = projectSlate(H, date, players, undefined, { home, out: outIds }).slice(0, players.length);
const q = s => /[",]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s;
const lines = res.map((r, i) => ({ ...r, dkTeam: players[i].dkTeam })).sort((a, b) => b.projection - a.projection)
  .map(r => [q(r.name), r.dkTeam, r.pos, r.sal, r.projection.toFixed(2), r.minutes.toFixed(1)].join(","));
fs.writeFileSync(path.join(dir, "proj-lab.csv"), ["Player,Team,Pos,Salary,Projection,Minutes", ...lines].join("\n") + "\n");
const noHist = res.filter(r => !r.gp).length, doubt = res.filter(r => r.pPlay < 1 && r.projFull >= 15).map(r => `${r.name} (${r.pPlay})`);
console.log(`${dir}/proj-lab.csv: ${res.length} players, ${noHist} with no ESPN history (salary prior only)${doubt.length ? `; missed last game, discounted: ${doubt.join(", ")}` : ""}`);
