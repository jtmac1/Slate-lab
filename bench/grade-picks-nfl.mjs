// Grade the Simulator's OWN picks after a slate (not the user's entries): what it would have recommended pre-lock
// (top 1/5/20 by grade, top 1/5 by Lab ROI, the best pool lineup on the Lab stacks top stack, the pool lineup with the
// most Lab likes, and the Brain's favorites when data/<slate>/brain.json has them), inserted into every real contest
// Stokastic stored for the slate (data/post/nfl): actual points, finish, the payout that finish paid, fee-weighted ROI,
// top-10% / top-1% / cash rates, against the real field. Results go to data/reports/picks-scoreboard-nfl.json (one
// entry per slate, replaced on re-run) with running totals per format, fee tier and strategy, and a noise flag.
//   node bench/grade-picks-nfl.mjs data/2026-10-05-nfl-atlno
//   node bench/grade-picks-nfl.mjs --backfill            every data/<date>-nfl-* dir with simrun.json and stored contests
// Player points: data/<slate>/actuals-dk.csv or actuals.csv, then solved against the stored contests' lineup totals
// (least squares, pulled toward the box-score number) so a pick scores on the same points DraftKings used.
// Look-ahead: a slate whose simrun.json was written after lock (rebuilt later, with code fitted on that week), or whose
// likes/stacks were generated after lock, is marked; its numbers are a backfill, not a pre-lock record.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".."));
const { loadSimRun } = await import("../server/contestsim.mjs");

const POST = "data/post/nfl", OUT = "data/reports/picks-scoreboard-nfl.json";
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const nrm = s => String(s || "").toLowerCase().replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/, "").replace(/[^a-z]/g, "");
const splitCSV = l => { const o = []; let c = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(c); c = ""; } else c += ch; } o.push(c); return o; };
const tierOf = c => c.fee >= 100 && c.entries <= 1000 ? "high" : c.entries > 10000 ? "low" : "marquee";

// lock in UTC from slate.json start (Eastern; October is EDT)
const lockOf = meta => Date.parse(String(meta.start || "") + "-04:00");

function contestsFor(meta) {
  const date = String(meta.start || "").slice(0, 10), sd = meta.type === "SHOWDOWN";
  const teams = new Set((meta.games || []).flatMap(g => g.split("@")));
  const out = [];
  for (const f of fs.readdirSync(POST).filter(x => x.startsWith(date) && x.endsWith(".json.gz"))) {
    let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(POST, f)))); } catch { continue; }
    const c = j.contest || {}; if (c.sport !== "NFL") continue;
    const isSd = /showdown/i.test(c.type || ""); if (isSd !== sd) continue;
    const par = ((c.name || "").replace(/\[[^\]]*\]/g, "").match(/\(([^)]*)\)/) || [, ""])[1].trim();
    if (sd) { const t = par.match(/\b[A-Z]{2,3}\b/g) || []; if (t.length !== 2 || !t.every(x => teams.has(x))) continue; }
    else if (nrm(meta.name) === "main" ? par !== "" : nrm(par) !== nrm(meta.name)) continue;
    const L = j.lineups || [];
    if (!L.length || L.length < 0.95 * c.entries) { out.push({ c, skip: L.length ? `only ${L.length}/${c.entries} lineups stored` : "players only (no lineups stored)" }); continue; }
    out.push({ c, lineups: L, players: j.players || [] });
  }
  return out;
}

// player points by name: box-score start, then least squares on the stored lineup totals. Showdown: the first id is the
// captain (1.5x); the stored player table's pos can label a flex id "CPT", so it isn't used for this
function solvePoints(dir, sets, sd) {
  const prior = new Map();
  for (const f of ["actuals-dk.csv", "actuals.csv"]) {
    const p = path.join("data", dir, f); if (!fs.existsSync(p)) continue;
    const L = fs.readFileSync(p, "utf8").trim().split(/\r?\n/), h = splitCSV(L[0]), P = h.indexOf("Player"), A = h.indexOf("Actual");
    for (const l of L.slice(1)) { const r = splitCSV(l), k = nrm(r[P]); if (!prior.has(k) && r[A] !== "") prior.set(k, +r[A]); }
  }
  const idx = new Map(), names = [];
  const vi = k => { if (!idx.has(k)) { idx.set(k, names.length); names.push(k); } return idx.get(k); };
  const rows = [];
  for (const s of sets) {
    if (!s.lineups) continue;
    const byId = new Map(s.players.map(p => [String(p.id), p]));
    const step = Math.max(1, Math.floor(s.lineups.length / 20000));
    for (let i = 0; i < s.lineups.length; i += step) {
      const lu = s.lineups[i]; if (lu.afp == null) continue;
      const terms = []; let ok = true;
      lu.ids.forEach((id, k) => { const p = byId.get(String(id)); if (!p) { ok = false; return; } terms.push([vi(nrm(p.name)), sd && k === 0 ? 1.5 : 1]); });
      if (ok) rows.push({ terms, y: +lu.afp });
    }
  }
  const n = names.length, x0 = Float64Array.from(names, k => prior.get(k) ?? 0), x = Float64Array.from(x0), lam = 0.05;
  if (rows.length) {
    // conjugate gradient on (A'A + lam I) x = A'y + lam x0
    const Ax = v => rows.map(r => r.terms.reduce((s, [j, w]) => s + w * v[j], 0));
    const ATv = u => { const o = new Float64Array(n); rows.forEach((r, i) => { for (const [j, w] of r.terms) o[j] += w * u[i]; }); return o; };
    const M = v => { const o = ATv(Ax(v)); for (let j = 0; j < n; j++) o[j] += lam * v[j]; return o; };
    const b = ATv(rows.map(r => r.y)); for (let j = 0; j < n; j++) b[j] += lam * x0[j];
    const Mx = M(x), r = Float64Array.from(b, (v, j) => v - Mx[j]);
    let p = Float64Array.from(r), rs = r.reduce((s, v) => s + v * v, 0);
    for (let it = 0; it < 200 && rs > 1e-8; it++) {
      const Mp = M(p), a = rs / p.reduce((s, v, j) => s + v * Mp[j], 0); if (!isFinite(a)) break;
      for (let j = 0; j < n; j++) { x[j] += a * p[j]; r[j] -= a * Mp[j]; }
      const rs2 = r.reduce((s, v) => s + v * v, 0); for (let j = 0; j < n; j++) p[j] = r[j] + (rs2 / rs) * p[j]; rs = rs2;
    }
  }
  const pts = new Map(names.map((k, j) => [k, x[j]]));
  for (const [k, v] of prior) if (!pts.has(k)) pts.set(k, v);
  let err = 0, m = 0; for (const r of rows.slice(0, 5000)) { err += Math.abs(r.terms.reduce((s, [j, w]) => s + w * x[j], 0) - r.y); m++; }
  return { pts, mae: m ? err / m : null, rows: rows.length, fromBox: prior.size };
}

const sigOf = e => e.players.map((p, i) => (i === 0 && p.slot === "CPT" ? "C:" : "") + nrm(p.name)).sort().join("|");
function picksFor(dir, meta, run) {
  const sd = run.format === "nfl_sd", g = readJ(path.join("data", dir, "slate-guide.json")) || {};
  const seen = new Set(), pool = run.rows.filter(e => e.players && e.sim && e.grade && !seen.has(sigOf(e)) && seen.add(sigOf(e)));
  const byGrade = pool.slice().sort((a, b) => b.grade.grade - a.grade.grade || (b.sim.lab ?? 0) - (a.sim.lab ?? 0));
  const byLab = pool.slice().sort((a, b) => (b.sim.lab ?? -1e9) - (a.sim.lab ?? -1e9));
  const S = { grade1: byGrade.slice(0, 1), grade5: byGrade.slice(0, 5), grade20: byGrade.slice(0, 20), lab1: byLab.slice(0, 1), lab5: byLab.slice(0, 5) };
  const has = (e, n) => e.players.some(p => nrm(p.name) === nrm(n));
  const ls = g.labStacks;
  if (ls && !sd && ls.top && ls.top[0]) {
    const t = ls.top[0], need = [t.qb, ...(t.catchers || []), ...(t.bringBack ? [t.bringBack.name] : [])];
    const m = byGrade.find(e => need.every(n => has(e, n))) || byGrade.find(e => [t.qb, ...(t.catchers || [])].every(n => has(e, n)));
    if (m) S.stack = [m];
  }
  if (ls && sd && ls.pairs && ls.pairs[0]) {
    const pr = ls.pairs[0], m = byGrade.find(e => nrm(e.players[0].name) === nrm(pr.cpt) && has(e, pr.with));
    if (m) S.stack = [m];
  }
  if (g.likes && g.likes.picks) {
    const liked = new Set(Object.values(g.likes.picks).flat().map(p => nrm(p.name)));
    const score = e => e.players.filter(p => liked.has(nrm(p.name))).length;
    const m = byGrade.slice().sort((a, b) => score(b) - score(a))[0];
    if (m && score(m) > 0) S.likes = [m];
  }
  // the Brain's picks: its best letter grades (A, then A-), from Claude's reviews and from the Lab rules Brain (no Claude);
  // reviews carry a letter grade, not a verdict, so the old verdict test never matched anything
  const RANK = { "A": 0, "A-": 1 };
  for (const [key, file] of [["brain", "brain.json"], ["rulesbrain", "brain-rules.json"]]) {
    const B = readJ(path.join("data", dir, file)); if (!B || !B.reviews) continue;
    const top = Object.entries(B.reviews).filter(([, v]) => v && RANK[v.grade] != null).sort((a, b) => RANK[a[1].grade] - RANK[b[1].grade]).map(([k]) => k);
    const m = top.map(k => pool.find(e => e.sig === k || sigOf(e) === k)).filter(Boolean);
    if (m.length) S[key] = m.slice(0, 5);
  }
  const lock = lockOf(meta), simAt = fs.statSync(path.join("data", dir, "simrun.json")).mtimeMs;
  const after = t => t && Date.parse(t) > lock;
  const look = { simAfterLock: simAt > lock, simAt: new Date(simAt).toISOString(), likesAfterLock: !!(g.likes && after(g.likes.generatedAt)), stacksAfterLock: !!(ls && after(ls.generatedAt)) };
  return { S, look, sd, poolN: pool.length };
}

function scoreInto(contest, ptsOf) {
  const L = contest.lineups, c = contest.c, N = L.length;
  const afp = L.map(l => +l.afp), byFin = L.slice().sort((a, b) => a.fin - b.fin);
  // payout by finishing position; a lineup with no stored ROI takes the payout of the place above it
  const pay = []; for (const l of byFin) { const v = c.fee * (1 + +l.aroi); pay.push(isFinite(v) ? v : pay.length ? pay[pay.length - 1] : 0); }
  const fieldPay = pay.reduce((s, v) => s + v, 0);
  return { field: { roi: fieldPay / (N * c.fee) - 1, cash: pay.filter(v => v > 0).length / N },
    place: pts => {
      let above = 0, tie = 0; for (const a of afp) { if (a > pts + 0.005) above++; else if (Math.abs(a - pts) <= 0.005) tie++; }
      const r = above + 1, lo = r - 1, hi = Math.min(N - 1, lo + tie); if (lo > N - 1) return { rank: r, pct: 1, won: 0, t10: false, t1: false, cash: false }; let s = 0; for (let i = lo; i <= hi; i++) s += pay[Math.min(i, N - 1)];
      const won = s / (hi - lo + 1);
      return { rank: r, pct: above / N, won, t10: r <= Math.ceil(0.1 * N), t1: r <= Math.max(1, Math.ceil(0.01 * N)), cash: won > 0 };
    } };
}

function gradeSlate(dir) {
  const meta = readJ(path.join("data", dir, "slate.json")); if (!meta) return { dir, skip: "no slate.json" };
  if (!fs.existsSync(path.join("data", dir, "simrun.json"))) return { dir, skip: "no simrun.json" };
  const run = loadSimRun(dir); if (!run || !run.rows) return { dir, skip: "simrun unreadable" };
  const sets = contestsFor(meta), usable = sets.filter(s => s.lineups);
  if (!usable.length) return { dir, skip: sets.length ? "no contest with full lineups stored" : "no stored contests", contestsSkipped: sets.map(s => `${s.c.name}: ${s.skip}`) };
  const { S, look, sd, poolN } = picksFor(dir, meta, run), P = solvePoints(dir, usable, sd);
  const ptsOf = e => e.players.reduce((s, p, i) => { const v = P.pts.get(nrm(p.name)); return s + (isFinite(v) ? v : 0) * (sd && i === 0 ? 1.5 : 1); }, 0);
  const res = { dir, date: String(meta.start).slice(0, 10), format: sd ? "showdown" : "classic", poolN, simContest: run.contest && run.contest.name || null,
    points: { solvedRows: P.rows, boxScorePlayers: P.fromBox, lineupMAE: P.mae && +P.mae.toFixed(2) }, lookahead: look,
    backfill: look.simAfterLock || look.likesAfterLock || look.stacksAfterLock, contests: [], contestsSkipped: sets.filter(s => !s.lineups).map(s => `${s.c.name}: ${s.skip}`) };
  for (const s of usable) {
    const sc = scoreInto(s, ptsOf), cr = { key: s.c.key, name: s.c.name, fee: s.c.fee, entries: s.c.entries, tier: tierOf(s.c), field: { roi: +sc.field.roi.toFixed(4), cash: +sc.field.cash.toFixed(3) }, strat: {} };
    for (const [k, lus] of Object.entries(S)) {
      const pl = lus.map(e => ({ pts: +ptsOf(e).toFixed(2), ...sc.place(ptsOf(e)) }));
      cr.strat[k] = { n: pl.length, fees: pl.length * s.c.fee, won: +pl.reduce((t, x) => t + x.won, 0).toFixed(2), t10: pl.filter(x => x.t10).length, t1: pl.filter(x => x.t1).length, cash: pl.filter(x => x.cash).length,
        best: pl.reduce((b, x) => x.rank < b.rank ? x : b, pl[0]) };
    }
    res.contests.push(cr);
  }
  res.picks = Object.fromEntries(Object.entries(S).map(([k, lus]) => [k, lus.slice(0, 5).map(e => ({ players: e.players.map((p, i) => (sd && i === 0 ? "CPT " : "") + p.name).join(", "), grade: e.grade.grade, lab: e.sim.lab, pts: +ptsOf(e).toFixed(2) }))]));
  return res;
}

// running totals per format | tier | strategy (pre-lock slates only, plus an all-slates line that includes backfills)
function totals(slates) {
  const T = {};
  for (const s of Object.values(slates)) for (const c of s.contests || []) for (const [k, v] of Object.entries(c.strat)) {
    for (const scope of ["all", ...(s.backfill ? [] : ["prelock"])]) {
      const key = `${scope} | ${s.format} | ${c.tier} | ${k}`, t = T[key] || (T[key] = { n: 0, fees: 0, won: 0, t10: 0, t1: 0, cash: 0, fieldFees: 0, fieldWon: 0, byDate: {} });
      t.n += v.n; t.fees += v.fees; t.won += v.won; t.t10 += v.t10; t.t1 += v.t1; t.cash += v.cash;
      t.fieldFees += v.fees; t.fieldWon += v.fees * (1 + c.field.roi);
      const d = t.byDate[s.date] || (t.byDate[s.date] = { fees: 0, won: 0 }); d.fees += v.fees; d.won += v.won;
    }
  }
  const out = {};
  for (const [k, t] of Object.entries(T)) {
    const dr = Object.values(t.byDate).map(d => d.won / d.fees - 1), m = dr.reduce((a, b) => a + b, 0) / dr.length;
    const sdv = dr.length > 1 ? Math.sqrt(dr.reduce((a, b) => a + (b - m) ** 2, 0) / (dr.length - 1)) : null;
    out[k] = { n: t.n, dates: dr.length, roi: +(t.won / t.fees - 1).toFixed(3), fieldRoi: +(t.fieldWon / t.fieldFees - 1).toFixed(3), top10: +(t.t10 / t.n).toFixed(3), top1: +(t.t1 / t.n).toFixed(3), cash: +(t.cash / t.n).toFixed(3),
      tDate: sdv ? +(m / (sdv / Math.sqrt(dr.length))).toFixed(2) : null, noise: dr.length < 5 || t.n < 30 };
  }
  return out;
}

const arg = process.argv.slice(2), backfill = arg.includes("--backfill");
const dirs = backfill ? fs.readdirSync("data").filter(d => /^\d{4}-\d{2}-\d{2}-nfl-/.test(d) && fs.existsSync(path.join("data", d, "simrun.json"))).sort()
  : arg.filter(a => !a.startsWith("--")).map(a => path.basename(a));
if (!dirs.length) { console.error("usage: node bench/grade-picks-nfl.mjs data/<slate> | --backfill"); process.exit(1); }
const board = readJ(OUT) || { slates: {} };
for (const dir of dirs) {
  const r = gradeSlate(dir);
  if (r.skip) { console.log(`${dir}: skipped (${r.skip})${r.contestsSkipped && r.contestsSkipped.length ? " - " + r.contestsSkipped.length + " contests lacked lineups" : ""}`); continue; }
  board.slates[dir] = r;
  console.log(`\n${dir} [${r.format}]${r.backfill ? " BACKFILL (" + Object.entries(r.lookahead).filter(([k, v]) => v === true).map(([k]) => k).join(", ") + ")" : ""} pool ${r.poolN}, ${r.contests.length} contests scored, ${r.contestsSkipped.length} skipped; points solve: ${r.points.solvedRows} lineup rows, lineup MAE ${r.points.lineupMAE}`);
  const agg = {}; for (const c of r.contests) for (const [k, v] of Object.entries(c.strat)) { const a = agg[k] || (agg[k] = { n: 0, fees: 0, won: 0, t10: 0, t1: 0, ff: 0, fw: 0 }); a.n += v.n; a.fees += v.fees; a.won += v.won; a.t10 += v.t10; a.t1 += v.t1; a.ff += v.fees; a.fw += v.fees * (1 + c.field.roi); }
  for (const [k, a] of Object.entries(agg)) console.log(`  ${k.padEnd(8)} entries ${String(a.n).padStart(4)} | ROI ${(100 * (a.won / a.fees - 1)).toFixed(0).padStart(5)}% (field ${(100 * (a.fw / a.ff - 1)).toFixed(0)}%) | top-10% ${(100 * a.t10 / a.n).toFixed(1)}% | top-1% ${(100 * a.t1 / a.n).toFixed(1)}%`);
  for (const [k, v] of Object.entries(r.picks)) if (v[0]) console.log(`    ${k}: ${v[0].pts} pts | ${v[0].players}`);
}
board.updated = new Date().toISOString(); board.totals = totals(board.slates);
fs.writeFileSync(OUT, JSON.stringify(board, null, 1));
console.log(`\nwrote ${OUT}: ${Object.keys(board.slates).length} slates; running totals (pre-lock only / all incl. backfills):`);
for (const [k, t] of Object.entries(board.totals).filter(([k]) => /\| (grade1|grade20|lab1|stack|likes|brain|rulesbrain) *$/.test(k)).sort())
  console.log(`  ${k.padEnd(40)} n ${String(t.n).padStart(4)} dates ${t.dates} | ROI ${(100 * t.roi).toFixed(0)}% vs field ${(100 * t.fieldRoi).toFixed(0)}% | top-10% ${(100 * t.top10).toFixed(1)}% top-1% ${(100 * t.top1).toFixed(1)}%${t.noise ? " (noise)" : ""}`);
