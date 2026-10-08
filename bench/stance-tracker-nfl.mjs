// Running record of how the slate guide's calls did: every stance (core/value/leverage/caution/fade) and thesis in
// data/<slate>/slate-guide.json, scored against what happened, and attributed to the commentators behind it.
//   node bench/stance-tracker-nfl.mjs data/2026-10-04-nfl-main [more slate dirs...]
// Outcome per player: actual ROI averaged over that day's stored classic contests on the same slate (data/post/nfl,
// Stokastic post-contest player tables), actual ownership, and points vs the slate's projection (data/<slate>/actuals.csv).
// A "hit" is ROI > 0 for core/value/leverage and ROI <= 0 for caution/fade; the baseline is the same test applied to
// every player 0.5%+ owned on the slate, so a stance type only earns trust by beating that rate over many weeks.
// Commentators: everyone named in a stance's "why" text, with a direction read from the sentence that names them
// (positive / negative / mention). Per-commentator lines score their positive calls (hit = ROI > 0) and negative calls
// (hit = ROI <= 0) separately.
// Appends/replaces the slate in data/reports/stance-tracker-nfl.json and recomputes running totals.
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const OUT = "data/reports/stance-tracker-nfl.json";
const COMMENTATORS = ["Levitan", "Dinkmeyer", "Leone", "Wiggins", "Silva", "Thorman", "Thorn", "Miller", "Brott", "Cody Main", "Hodge", "Blick"];
const POS = /\b(like|likes|love|loves|favorite|favourite|smash|upside|flag plant|conviction|lean|leans|core|best|lock|elite|prefers?|ceiling|top play|buy|stack|pivot|leverage|underowned|under-owned|value)\b/i;
const NEG = /\b(fade|fades|avoid|mistake|doubts?|last of|overrated|gassed|bust|caution|worried|worry|concern|trap|over-?owned|overowned|sell|pass on|low floor|no thanks|wouldn'?t)\b/i;
const POSITIVE = new Set(["core", "value", "leverage"]);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const r3 = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;

function playerOutcomes(dir, date) {
  // the slate's team set from its projection file, then the day's classic contests whose players cover the same teams
  const projFile = fs.readdirSync(dir).find(f => /Projections\.csv$/i.test(f));
  const P = parseCSV(fs.readFileSync(path.join(dir, projFile), "utf8")), H = P[0].map(h => h.trim());
  const iN = H.indexOf("Player"), iT = H.indexOf("Team"), iP = H.indexOf("Projection");
  const proj = new Map(), teams = new Set(); for (const r of P.slice(1)) { if (!r[iN]) continue; proj.set(nrm(r[iN]), +r[iP] || 0); teams.add(r[iT]); }
  const act = new Map(); for (const f of ["actuals-dk.csv", "actuals.csv"]) { const p = path.join(dir, f); if (!fs.existsSync(p)) continue; const A = parseCSV(fs.readFileSync(p, "utf8")), h = A[0]; const ia = h.indexOf("Actual"), ip = h.indexOf("Player"); for (const r of A.slice(1)) if (r[ip] && !act.has(nrm(r[ip]))) act.set(nrm(r[ip]), +r[ia]); }
  const agg = new Map(); let n = 0;
  for (const f of listPost("nfl").filter(x => path.basename(x).startsWith(date))) {
    const j = readPost(f); if (/showdown/i.test(j.contest.type + " " + j.contest.name)) continue;
    const ct = new Set(j.players.map(p => p.team).filter(Boolean)); if (ct.size !== teams.size || [...ct].some(t => !teams.has(t) && !teams.has(t === "LAR" ? "LA" : t === "LA" ? "LAR" : t))) continue;
    n++; for (const p of j.players) { if (p.aroi == null) continue; const k = nrm(p.name), a = agg.get(k) || { roi: [], own: [], name: p.name, team: p.team, game: [p.team, p.opp].sort().join("@") }; a.roi.push(p.aroi); a.own.push(p.aown); agg.set(k, a); }
  }
  const out = new Map(); for (const [k, a] of agg) out.set(k, { name: a.name, team: a.team, game: a.game, roi: mean(a.roi), own: mean(a.own), pts: act.get(k) ?? null, proj: proj.get(k) ?? null });
  return { out, contests: n };
}

function commentatorCalls(why) {
  const calls = []; const parts = String(why || "").split(/(?<=[.!?])\s+|(?=\b(?:Show|Million|Matchups|Blick|Silva|Levitan|Leone|Dinkmeyer|Wiggins|Thorman|Miller|Brott|Hodge)\b[^.]{0,20}:)/);
  for (const s of parts) for (const c of COMMENTATORS) if (new RegExp("\\b" + c + "\\b").test(s)) {
    const pos = POS.test(s), neg = NEG.test(s);
    calls.push({ who: c, dir: pos && !neg ? "pos" : neg && !pos ? "neg" : "mention" });
  }
  // one call per commentator per stance: a clear direction wins over a mention, conflicting directions become a mention
  const by = new Map(); for (const c of calls) { const p = by.get(c.who); by.set(c.who, !p || p === c.dir ? c.dir : p === "mention" ? c.dir : c.dir === "mention" ? p : "mention"); }
  return [...by].map(([who, dir]) => ({ who, dir }));
}

function scoreSlate(dir) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, "slate-guide.json"), "utf8")), date = g.date || path.basename(dir).slice(0, 10);
  const { out: O, contests } = playerOutcomes(dir, date);
  const pool = [...O.values()].filter(p => p.own >= 0.005 && Number.isFinite(p.roi));
  const basePos = mean(pool.map(p => p.roi > 0 ? 1 : 0)), baseRoi = mean(pool.map(p => p.roi));
  const stances = [];
  for (const [name, s] of Object.entries(g.stances || {})) {
    if (!s.stance) continue;
    const o = O.get(nrm(name)); if (!o || !Number.isFinite(o.roi)) { stances.push({ name, stance: s.stance, found: false }); continue; }
    const hit = POSITIVE.has(s.stance) ? o.roi > 0 : o.roi <= 0;
    stances.push({ name, stance: s.stance, found: true, hit, roi: r3(o.roi), own: r3(o.own), pts: o.pts, proj: o.proj == null ? null : r3(o.proj), beatProj: o.pts != null && o.proj ? o.pts > o.proj : null,
      reports: String(s.source || "").split(" / ").map(x => x.replace(/\s*\(.*\)$/, "").replace(/^ETR\s+/, "").trim()).filter(Boolean), calls: commentatorCalls(s.why) });
  }
  const theses = (g.theses || []).map(t => { const ps = (t.players || []).map(n => O.get(nrm(n))).filter(p => p && Number.isFinite(p.roi)); const m = mean(ps.map(p => p.roi)); return { id: t.id, n: ps.length, meanRoi: r3(m), hit: ps.length ? m > 0 : null, best: ps.slice().sort((a, b) => b.roi - a.roi)[0]?.name || null }; });
  return { slate: path.basename(dir), date, contests, baseline: { players: pool.length, positiveRoiRate: r3(basePos), meanRoi: r3(baseRoi) }, stances, theses };
}

function totals(slates) {
  const T = { byStance: {}, byCommentator: {}, byReport: {}, theses: { n: 0, hits: 0 } };
  const add = (bucket, key, hit, roi, base) => { const b = bucket[key] || (bucket[key] = { n: 0, hits: 0, roiSum: 0, expectedHits: 0 }); b.n++; b.hits += hit ? 1 : 0; b.roiSum += roi; b.expectedHits += base; };
  for (const s of slates) {
    const bp = s.baseline.positiveRoiRate;
    for (const x of s.stances.filter(x => x.found)) {
      const pos = POSITIVE.has(x.stance), base = pos ? bp : 1 - bp;
      add(T.byStance, x.stance, x.hit, x.roi, base);
      for (const r of x.reports) add(T.byReport, r + (pos ? " (+)" : " (-)"), x.hit, x.roi, base);
      for (const c of x.calls) { if (c.dir === "mention") continue; const h = c.dir === "pos" ? x.roi > 0 : x.roi <= 0; add(T.byCommentator, c.who + (c.dir === "pos" ? " likes" : " dislikes"), h, x.roi, c.dir === "pos" ? bp : 1 - bp); }
    }
    for (const t of s.theses) if (t.hit != null) { T.theses.n++; T.theses.hits += t.hit ? 1 : 0; }
  }
  for (const bucket of [T.byStance, T.byCommentator, T.byReport]) for (const b of Object.values(bucket)) { b.hitRate = r3(b.hits / b.n); b.expectedRate = r3(b.expectedHits / b.n); b.vsBaseline = r3(b.hitRate - b.expectedRate); b.meanRoi = r3(b.roiSum / b.n); delete b.roiSum; delete b.expectedHits; }
  return T;
}

const dirs = process.argv.slice(2); if (!dirs.length) { console.error("usage: node bench/stance-tracker-nfl.mjs data/<slate> [...]"); process.exit(1); }
const db = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { note: "hit = ROI > 0 for core/value/leverage and likes, ROI <= 0 for caution/fade and dislikes; expectedRate = the slate baseline for the same test", slates: [] };
for (const d of dirs) {
  if (!fs.existsSync(path.join(d, "slate-guide.json"))) { console.log(d, "- no slate-guide.json, skipped"); continue; }
  const s = scoreSlate(d); if (!s.stances.length) { console.log(d, "- guide has no stances (showdown guide), skipped"); continue; }
  db.slates = db.slates.filter(x => x.slate !== s.slate).concat(s);
  console.log(`${s.slate}: ${s.contests} contests, baseline ${s.baseline.players} players, ${(s.baseline.positiveRoiRate * 100).toFixed(0)}% positive ROI; ${s.stances.filter(x => x.found).length}/${s.stances.length} stances matched`);
}
db.updated = new Date().toISOString(); db.totals = totals(db.slates);
fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
const show = (title, b, min = 1) => { console.log("\n" + title); for (const [k, v] of Object.entries(b).filter(([, v]) => v.n >= min).sort((a, b) => b[1].vsBaseline - a[1].vsBaseline)) console.log(`  ${k.padEnd(34)} n=${String(v.n).padStart(3)} hit ${(v.hitRate * 100).toFixed(0)}% vs ${(v.expectedRate * 100).toFixed(0)}% expected (${v.vsBaseline >= 0 ? "+" : ""}${(v.vsBaseline * 100).toFixed(0)}) meanROI ${(v.meanRoi * 100).toFixed(0)}%`); };
show("By stance", db.totals.byStance); show("By commentator (directional calls only)", db.totals.byCommentator, 2); show("By report", db.totals.byReport, 3);
console.log(`\nTheses: ${db.totals.theses.hits}/${db.totals.theses.n} with positive mean player ROI`);
