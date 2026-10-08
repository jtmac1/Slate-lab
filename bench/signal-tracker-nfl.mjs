// Running test of ETR's data tables as signals (user-approved 2026-10-06): for each slate, every player gets the
// signals the tables gave BEFORE the slate (server/etrdata.mjs slateData: no look-ahead) and three outcomes:
//   pts  = actual DK points - projection   (data/<slate>/actuals.csv; projection = Stokastic's pre-lock number)
//   own  = actual ownership - projected     (field over/under-reaction; day's stored contests on the slate, data/post/nfl)
//   roi  = player's actual ROI in those contests
// Signals: dvp = the opposing defense's DvP % at the player's position; xfpGap = actual - expected fantasy points per game
// (negative = usage better than results); proe = the team's pass rate over expectation (QB/WR/TE only).
// Spearman correlation per signal x outcome, pooled over every tracked slate; "noise" when |r| < 2/sqrt(n).
// The lineup grade ignores these until a signal clears noise over several weeks.
//   node bench/signal-tracker-nfl.mjs data/<slate> [more slate dirs...]    (no args: just print the running table)
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
import { slateData } from "../server/etrdata.mjs";

const OUT = "data/reports/signal-tracker-nfl.json";
const ab = t => { t = String(t || "").toUpperCase().replace(/^@/, ""); return t === "LA" ? "LAR" : t === "WSH" ? "WAS" : t; };
const SIGNALS = ["dvp", "xfpGap", "proe"], OUTCOMES = ["pts", "own", "roi"];
const r3 = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;

function spearman(a, b) {
  const n = a.length; if (n < 3) return null;
  const rk = x => { const idx = x.map((v, i) => i).sort((i, j) => x[i] - x[j]), r = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && x[idx[j + 1]] === x[idx[i]]) j++; for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const ra = rk(a), rb = rk(b), m = (n + 1) / 2; let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - m) * (rb[i] - m); saa += (ra[i] - m) ** 2; sbb += (rb[i] - m) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

function scoreSlate(dir) {
  const slug = path.basename(dir), meta = JSON.parse(fs.readFileSync(path.join(dir, "slate.json"), "utf8")), date = meta.date || slug.slice(0, 10), sd = meta.type === "SHOWDOWN";
  const D = slateData(slug); if (!D || !(D.dvp || D.xfp || D.proe)) return { slate: slug, date, skipped: "no ETR data table published before this slate" };
  const teams = new Set((meta.games || []).flatMap(g => String(g).split("@").map(ab)));
  // positions + actual points
  const pos = new Map(), act = new Map();
  for (const f of fs.readdirSync(dir).filter(f => /Projections\.csv$/i.test(f))) { const P = parseCSV(fs.readFileSync(path.join(dir, f), "utf8")), h = P[0].map(x => x.trim()); for (const r of P.slice(1)) if (r[h.indexOf("Player")]) pos.set(nrm(r[h.indexOf("Player")]), r[h.indexOf("Position")]); }
  for (const f of ["actuals-dk.csv", "actuals.csv"]) { const p = path.join(dir, f); if (!fs.existsSync(p)) continue; const A = parseCSV(fs.readFileSync(p, "utf8")), h = A[0]; for (const r of A.slice(1)) { const k = nrm(r[h.indexOf("Player")]); if (!act.has(k) && r[h.indexOf("Actual")] !== "") act.set(k, +r[h.indexOf("Actual")]); } }
  // the day's stored contests on this slate (same team set; showdown vs classic), averaged per player
  const agg = new Map(); let contests = 0;
  for (const f of listPost("nfl").filter(x => path.basename(x).startsWith(date))) {
    const j = readPost(f); if (/showdown/i.test(j.contest.type + " " + j.contest.name) !== sd) continue;
    const ct = new Set(j.players.map(p => ab(p.team)).filter(Boolean)); if (ct.size !== teams.size || [...ct].some(t => !teams.has(t))) continue;
    contests++;
    for (const p of j.players) { if (sd && p.pos === "CPT") continue; const k = nrm(p.name), a = agg.get(k) || { name: p.name, team: ab(p.team), opp: ab(p.opp), roi: [], aown: [], pown: [], proj: p.proj }; if (p.aroi != null) a.roi.push(p.aroi); a.aown.push(p.aown); a.pown.push(p.pown); agg.set(k, a); }
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const xfpBy = new Map(Object.entries(D.xfp ? D.xfp.players : {}).map(([n, v]) => [nrm(n), v]));
  const rows = [];
  for (const [k, a] of agg) {
    const ps = pos.get(k) || "", own = mean(a.pown) * 100; if (!(own >= 0.5) || /DST|^K$/.test(ps)) continue;
    const dv = D.dvp && D.dvp.vs[a.opp] ? D.dvp.vs[a.opp][ps] : null, xg = xfpBy.get(k), pr = D.proe && D.proe.teams[a.team] && /QB|WR|TE/.test(ps) ? D.proe.teams[a.team].proe : null;
    rows.push({ name: a.name, pos: ps, team: a.team, sig: { dvp: dv ?? null, xfpGap: xg ? xg.gap : null, proe: pr }, out: { pts: act.has(k) && a.proj != null ? r3(act.get(k) - a.proj) : null, own: r3((mean(a.aown) - mean(a.pown)) * 100), roi: r3(mean(a.roi)) } });
  }
  return { slate: slug, date, format: sd ? "showdown" : "classic", contests, tables: { dvp: D.dvp ? D.dvp.published : null, xfp: D.xfp ? D.xfp.published : null, proe: D.proe ? D.proe.published : null }, players: rows.length, rows };
}

function running(slates) {
  const res = {};
  for (const s of SIGNALS) { res[s] = {}; for (const o of OUTCOMES) {
    const pairs = slates.flatMap(x => (x.rows || []).filter(r => r.sig[s] != null && r.out[o] != null).map(r => [r.sig[s], r.out[o]]));
    const r = spearman(pairs.map(p => p[0]), pairs.map(p => p[1])), n = pairs.length;
    res[s][o] = { r: r3(r), n, slates: slates.filter(x => (x.rows || []).some(r => r.sig[s] != null && r.out[o] != null)).length, noise: r == null || Math.abs(r) < 2 / Math.sqrt(Math.max(n, 1)) };
  } }
  return res;
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { slates: {} };
for (const d of process.argv.slice(2)) { const s = scoreSlate(d); prev.slates[s.slate] = s; console.log(s.skipped ? `${s.slate}: skipped (${s.skipped})` : `${s.slate}: ${s.players} players from ${s.contests} contests, tables ${JSON.stringify(s.tables)}`); }
const list = Object.values(prev.slates).filter(s => !s.skipped);
prev.running = running(list); prev.updated = new Date().toISOString();
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(prev));
if (!list.length) console.log("no slates with ETR data tables yet (tables only count for slates after they were published)");
for (const s of SIGNALS) console.log(s.padEnd(7), OUTCOMES.map(o => { const x = prev.running[s][o]; return `${o} r=${x.r ?? "-"} n=${x.n}${x.n ? (x.noise ? " (noise)" : " SIGNAL") : ""}`; }).join(" | "));
