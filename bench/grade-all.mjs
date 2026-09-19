// Grade every post-contest export under data/ the way the Review screen does, and benchmark
// the engine against Stokastic's own sim on the same contests.
//   node bench/grade-all.mjs [iters] [filter]      e.g. node bench/grade-all.mjs 4000 nfl
// Each folder holding DK_<SPORT>_<Slate>_Data_Hub_Lineup.csv + _Player.csv is one contest.
// Format comes from the folder name (-sd- = showdown). Teams/positions come from data/mlb-ref
// and data/nfl-ref (bench/nfl-ref.mjs builds the NFL one).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nrm, parseCSV } from "../src/engine/csv.mjs";
import { buildPool, FORMATS } from "../src/engine/formats.mjs";
import { listPost, readPost } from "./post-store.mjs";
import { recoverContest } from "../src/engine/recover.mjs";
import { buildModel, CSAME, COPP, MLBC, SIGMA_DEF, SIGMA_MAX } from "../src/engine/model.mjs";
import { simulate, playerROI } from "../src/engine/sim.mjs";
import { genField } from "../src/engine/field.mjs";
import { stackOf, stackTeams, sigOf, salOf, ownSum, assignSlots } from "../src/engine/lineups.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { featurize, gradeRules, spearman, RULES } from "../src/engine/select.mjs";

const SEED = 1;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const topOf = (arr, k) => arr.map((v, i) => i).sort((a, b) => arr[b] - arr[a]).slice(0, k);
const loose = s => nrm(s).split(" ").filter(w => w.length > 1).join(" ");

// name -> {team, opp, pos} from a reference folder and a game date
function refLookup(refDir, date, mlb) {
  const pf = path.join(refDir, "players-2026.json"), sf = path.join(refDir, `schedule-${date}.json`);
  if (!fs.existsSync(pf)) return null;
  const players = JSON.parse(fs.readFileSync(pf, "utf8"));
  const sched = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : [];
  const opp = {}; for (const g of sched) { opp[g.home] = g.away; opp[g.away] = g.home; }
  const byKey = {}, byLoose = {};
  for (const p of players) { byKey[nrm(p.name)] = p; if (!byLoose[loose(p.name)]) byLoose[loose(p.name)] = p; }
  return name => { const p = byKey[nrm(name)] || byLoose[loose(name)]; return p ? { team: p.team, opp: opp[p.team] || "", pos: mlb ? "" : p.pos } : null; };
}

export const feeTier = fee => fee < 50 ? "<$50" : fee < 200 ? "$50-199" : fee < 600 ? "$200-599" : "$600+";
export const fieldSize = n => n < 300 ? "<300" : n < 1500 ? "300-1.5K" : n < 10000 ? "1.5K-10K" : "10K+";

export function listContests() {
  const out = [];
  for (const dir of fs.readdirSync("data").sort()) {
    const D = path.join("data", dir); if (!fs.statSync(D).isDirectory()) continue;
    const lf = fs.readdirSync(D).find(f => /^DK_(MLB|NFL)_\w+_Data_Hub_Lineup\.csv$/.test(f)); if (!lf) continue;
    const sport = lf.slice(3, 6).toLowerCase(), pf = lf.replace("Lineup", "Player"); if (!fs.existsSync(path.join(D, pf))) continue;
    const fkey = sport === "mlb" ? "mlb_cl" : /-sd-|showdown/i.test(dir) ? "nfl_sd" : "nfl_cl";
    out.push({ dir, sport, fkey, date: (dir.match(/\d{4}-\d{2}-\d{2}/) || [""])[0], lineup: path.join(D, lf), player: path.join(D, pf) });
  }
  // contests pulled from Stokastic's API (bench/pull-stokastic.mjs), compact gzipped files
  if (fs.existsSync("data/post")) for (const sport of fs.readdirSync("data/post").sort()) {
    for (const file of listPost(sport)) {
      const j = readPost(file), c = j.contest; if (j.lineupsSkipped || !j.lineups.length) continue;
      const fkey = sport === "mlb" ? "mlb_cl" : sport === "cfb" ? "cfb_cl" : /showdown/i.test(c.type) ? "nfl_sd" : "nfl_cl";
      out.push({ dir: `post/${sport}/${path.basename(file).replace(/\.json(\.gz)?$/, "")}`, sport, fkey, date: c.date, json: file, name: c.name, fee: c.fee, entries: c.entries, key: c.key, tier: feeTier(c.fee), size: fieldSize(c.entries) });
    }
  }
  return out;
}

// A pulled contest: real projections, salaries, teams and positions per player; lineups keyed
// by DK player id. Pool ownership is the PROJECTED ownership (what the app has at lock);
// actual ownership is kept as actOwn.
export function loadPulled(file) {
  const j = readPost(file), c = j.contest, f = FORMATS[c.sport === "MLB" ? "mlb_cl" : c.sport === "CFB" ? "cfb_cl" : /showdown/i.test(c.type) ? "nfl_sd" : "nfl_cl"];
  const P = [], byId = {}, sd = !!f.mult;
  // showdown: the API lists a CPT row and a FLEX row per player (positions "CPT"/"FLEX"); real positions from the NFL reference
  const ref = sd ? refLookup("data/nfl-ref", c.date, false) : null;
  for (const q of j.players) {
    const slot = String(q.pos || "").toUpperCase();
    // the CPT row carries the 1.5x salary and projection; the FLEX row is the base
    if (sd && byId[q.id] != null) { const p = P[byId[q.id]]; if (slot === "CPT") { p.csal = q.sal; p.cown = 100 * q.pown; p.actCown = 100 * q.aown; } else { p.sal = q.sal; p.proj = q.proj; p.own = p.fown = 100 * q.pown; p.actOwn = 100 * q.aown; p.stkROI = 100 * (q.sroi ?? 0); p.actROI = 100 * (q.aroi ?? 0); } continue; }
    const t = sd && ref ? ref(q.name) : null, posRaw = sd ? (t && t.pos ? t.pos : "FLEX") : String(q.pos || "");
    const plist = posRaw.split("/").filter(Boolean), isP = f.sport === "mlb" ? plist.some(x => x === "SP" || x === "RP" || x === "P") : plist[0] === "DST";
    const p = { name: q.name, key: nrm(q.name), dkId: q.id, pos: isP && f.sport === "mlb" ? "P" : plist[0] || "FLEX", posList: isP && f.sport === "mlb" ? ["P"] : plist.length ? plist : ["FLEX"],
      team: q.team, opp: q.opp, sal: q.sal, csal: q.sal * 1.5, proj: q.proj, own: 100 * q.pown, fown: 100 * q.pown, cown: 0, actOwn: 100 * q.aown,
      ceil: null, sd: null, ord: null, isP, stkROI: 100 * (q.sroi ?? 0), actROI: 100 * (q.aroi ?? 0) };
    if (sd && slot === "CPT") { p.csal = q.sal; p.cown = 100 * q.pown; p.actCown = 100 * q.aown; p.sal = q.sal / 1.5; p.proj = q.proj / 1.5; p.own = p.fown = 0; }
    if (q.id) byId[q.id] = P.length; P.push(p);
  }
  const teams = [...new Set(P.map(p => p.team).filter(Boolean))].sort(), gmap = {}, games = [];
  P.forEach((p, i) => { const k = p.team && p.opp ? [p.team, p.opp].sort().join("@") : (p.team || "?"); if (gmap[k] == null) { gmap[k] = games.length; games.push(k); } p.i = i; p.gi = gmap[k]; p.ti = teams.indexOf(p.team); });
  const pool = { players: P, teams, games, src: "stokastic api", format: f }, entries = [];
  for (const l of j.lineups) {
    let ids = l.ids.map(id => byId[id]);
    if (ids.length !== f.slots.length || ids.some(x => x == null)) continue;
    if (sd) {
      // ids come sorted, not captain-first: the captain is the one player whose 1.5x salary makes the lineup salary add up
      const base = ids.reduce((s, i) => s + P[i].sal, 0), cands = ids.filter(i => Math.abs(base - P[i].sal + P[i].csal - l.sal) < 1);
      if (cands.length !== 1) continue;
      ids = [cands[0]].concat(ids.filter(i => i !== cands[0]));
    }
    const lu = assignSlots(ids, P, f); if (!lu) continue;
    // a lineup with no actual ROI (e.g. an entry DK voided) counts as a full loss
    entries.push({ user: l.u, stkROI: 100 * (l.sroi ?? 0), actROI: 100 * (l.aroi ?? -1), stkFP: l.sfp ?? 0, actFP: l.afp ?? 0, own: 100 * (l.own ?? 0), finish: l.fin ?? j.lineups.length, dupes: l.dup ?? 0, sal: l.sal ?? 0, names: lu.map(id => P[id].name), lu });
  }
  const N = entries.length, payouts = new Float64Array(N), ranked = [...entries].sort((a, b) => a.finish - b.finish || b.actROI - a.actROI);
  ranked.forEach((e, i) => { if (e.actROI > -100) payouts[i] = 1 + e.actROI / 100; });
  return { pool, entries, payouts, paid: payouts.filter(x => x > 0).length, unmatched: [], rows: j.lineups.length, contest: c };
}

// Rebuild one contest from its export; cached so parameter sweeps do not re-solve it.
const recovered = {};
export function recover(c) {
  if (recovered[c.dir]) return recovered[c.dir];
  if (c.json) return recovered[c.dir] = loadPulled(c.json);
  const teamOf = refLookup(c.sport === "mlb" ? "data/mlb-ref" : "data/nfl-ref", c.date, c.sport === "mlb");
  return recovered[c.dir] = recoverContest(fs.readFileSync(c.lineup, "utf8"), fs.readFileSync(c.player, "utf8"), teamOf, c.fkey);
}

// Real entries re-matched onto a projection pool (ceilings, std dev, batting order intact) so
// the sim is graded on the inputs it gets in the app. Returns null when too few entries match.
export function matchToProjections(rc, file, fkey) {
  const pp = poolFromProjections(file, fkey), byKey = {}; pp.players.forEach((p, i) => { if (byKey[p.key] == null) byKey[p.key] = i; });
  const kept = [];
  for (const e of rc.entries) { const ids = e.names.map(nm => byKey[nrm(nm)]); if (ids.some(x => x == null)) continue; const lu = assignSlots(ids, pp.players, pp.format); if (lu) kept.push(Object.assign({}, e, { lu })); }
  if (kept.length < rc.entries.length * 0.9) return null;
  for (const q of rc.pool.players) { const i = byKey[q.key]; if (i != null) { pp.players[i].stkROI = q.stkROI; pp.players[i].actROI = q.actROI; } }
  return { pool: pp, entries: kept };
}

export function gradeContest(c, opts = {}) {
  const iters = opts.iters || 4000, rc = recover(c);
  let { pool, entries } = rc; const { payouts, paid } = rc;
  const pf = opts.proj === true ? projFileFor(c) : opts.proj || null, m = pf ? matchToProjections(rc, pf, c.fkey) : null;
  if (m) { pool = m.pool; entries = m.entries; }
  const P = pool.players, N = entries.length, lus = entries.map(e => e.lu);
  const t0 = Date.now();
  const mo = Object.assign({}, opts.model || {}); if (mo.sigmaBy) { mo.sigmaDef = mo.sigmaBy[pool.format.key] || mo.sigmaBy[pool.format.sport] || null; delete mo.sigmaBy; }
  const model = buildModel(pool, mo);
  let res;
  if (opts.genField) {
    // the app's situation: real entries scored against a GENERATED field (not against each other),
    // in batches like a multi-entry user, so the field generator is part of what gets graded
    const f = pool.format, opt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 }, f.sport === "mlb" ? mlbStackOpt() : { nflStacks: NFL_DEF }, opts.gen || {});
    // oracleOwn: build the field on ACTUAL ownership instead of projected - an upper bound on what a perfect ownership projection would buy
    const gpool = opts.gen && opts.gen.oracleOwn ? Object.assign({}, pool, { players: P.map(q => Object.assign({}, q, { own: q.actOwn != null ? q.actOwn : q.own, fown: q.actOwn != null ? q.actOwn : q.fown })) }) : pool;
    const gen = genField(gpool, N, opt, mulberry32(SEED)).field, B = opts.batch || 50, rows = [];
    for (let b = 0; b < N; b += B) {
      const batch = lus.slice(b, b + B), r = simulate({ pool, model, field: gen, lineups: batch, payouts, entries: N, fee: 1, iters, rng: mulberry32(SEED + b), fieldMode: false });
      r.rows.forEach((row, k) => { row.i = b + k; rows.push(row); });
    }
    res = { rows, iters, genDupes: gen.length - new Set(gen.map(l => sigOf(l, f))).size, genN: gen.length };
  } else res = simulate({ pool, model, field: [], lineups: lus, payouts, entries: N, fee: 1, iters, rng: mulberry32(SEED), fieldMode: true });
  // against a generated field the sim's own copy count (r.dupN) is pre-contest information; against the real field only the actual count exists
  const feats = featurize(res.rows.map((r, i) => { const e = entries[i]; return { proj: e.stkFP, roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: e.own, dupN: opts.genField ? (r.dupN || 0) : e.dupes, stkROI: e.stkROI, actFP: e.actFP, actROI: e.actROI, finish: e.finish }; }));
  // duplicate-aware candidates (graded only; they enter the app if they beat the default)
  const extra = { "Stokastic ROI": f => f.stkROI,
    // the field's single highest-projected lineup wins less than its projection implies (winners study 0.84x): skip it
    "Gated, skip max-projection lineup": f => f.rProj >= 0.999 ? -1e9 : (f.rProj >= 0.5 ? f.roi : -1e9 + f.rProj),
    "Sim ROI, skip max-projection lineup": f => f.rProj >= 0.999 ? -1e9 : f.roi };
  if (opts.genField) Object.assign(extra, { "Sim ROI, no expected copies": f => f.dupN > 0 ? -1e9 + f.rROI : f.roi, "Gated top half, no expected copies": f => (f.rProj >= 0.5 && f.dupN === 0) ? f.roi : -1e9 + f.rProj, "Sim ROI minus 15pp per expected copy": f => f.roi - 15 * f.dupN, "Gated top half minus 15pp per copy": f => f.rProj >= 0.5 ? f.roi - 15 * f.dupN : -1e9 + f.rProj });
  const grades = gradeRules(feats, paid, extra);
  const entryRows = opts.rows ? (() => { const chalk = new Set(P.map((q, i) => i).filter(i => !P[i].isP).sort((a, b) => P[b].own - P[a].own).slice(0, 10)); return feats.map((f, i) => { const e = entries[i], r = res.rows[i], st = stackTeams(e.lu, P, pool.format), pits = e.lu.map(id => P[id]).filter(q => q.isP); return { c: c.dir, date: c.date, fee: c.fee, N, paid, user: e.user, rROI: f.rROI, rProj: f.rProj, rCash: f.rCash, rT10: f.rT10, rLowOwn: f.rLowOwn, roi: r.roi, cash: r.cash, t10: r.t10, win: r.win, own: e.own, primary: st.length ? st[0][1] : 0, secondary: st.length > 1 ? st[1][1] : 0, teams: st.filter(x => x[1] >= 1).length, chalkN: e.lu.filter(id => chalk.has(id)).length, pitMax: pits.length ? Math.max(...pits.map(q => q.own || 0)) : 0, pitMin: pits.length ? Math.min(...pits.map(q => q.own || 0)) : 0, salLeft: (pool.format.cap || 50000) - e.sal, stkROI: e.stkROI, actROI: e.actROI, finishPct: (e.finish - 1) / Math.max(1, N - 1), top10: e.finish <= Math.max(1, Math.round(N * 0.1)) ? 1 : 0, cashed: e.finish <= paid ? 1 : 0 }; }); })() : null;
  // set-level candidate: the gated ranking, but no two picks share a primary stack team (portfolio spread)
  {
    const k10 = Math.max(3, Math.round(N * 0.1)), scoreG = feats.map(f => f.rProj >= 0.5 ? f.roi : -1e9 + f.rProj), order = feats.map((f, i) => i).sort((a, b) => scoreG[b] - scoreG[a]);
    const primary = entries.map(e => { const st = stackTeams(e.lu, P, pool.format); return st.length ? st[0][0] : ""; });
    const pick = kk => { const out = [], used = new Set(); for (const i of order) { if (used.has(primary[i])) continue; used.add(primary[i]); out.push(i); if (out.length >= kk) break; } return out; };
    const top10 = pick(k10), top3 = pick(3), cashSetD = new Set(entries.map((e, i) => e.finish <= paid ? i : -1).filter(i => i >= 0));
    grades["Gated, distinct primary stacks"] = { spearman: grades["ROI gated: top half proj"].spearman, cashHits: paid ? pick(paid).filter(i => cashSetD.has(i)).length * N / (paid * paid) : 0, real10: mean(top10.map(i => entries[i].actROI)), real3: mean(top3.map(i => entries[i].actROI)) };
  }
  const actFP = entries.map(e => e.actFP), stk = entries.map(e => e.stkROI), mine = res.rows.map(r => r.roi);
  const cashSet = new Set(entries.map((e, i) => e.finish <= paid ? i : -1).filter(i => i >= 0));
  const k = Math.max(3, Math.round(N * 0.1));
  const pr = {}; playerROI(res, P, pool.format).forEach(r => pr[r.id] = r.roi);
  const pp = P.filter(p => (p.own > 0 || p.cown > 0) && pr[p.i] != null);
  const mult = pool.format.mult, resid = Math.sqrt(mean(entries.map(e => (e.stkFP - e.lu.reduce((s, id, q) => s + (mult ? mult[q] : 1) * P[id].proj, 0)) ** 2)));
  return { ...c, entryRows, src: m ? "projections" : "recovered", N, rows: rc.rows, paid, unmatched: rc.unmatched, players: P.length, teams: pool.teams.length, games: pool.games.length, ms: Date.now() - t0, resid,
    fieldROI: mean(entries.map(e => e.actROI)), grades,
    sStk: spearman(stk, actFP), sMine: spearman(mine, actFP), sProj: spearman(entries.map(e => e.stkFP), actFP), agree: spearman(mine, stk),
    cashStk: topOf(stk, paid).filter(i => cashSet.has(i)).length, cashMine: topOf(mine, paid).filter(i => cashSet.has(i)).length, cashRand: paid * paid / N,
    roiStk: mean(topOf(stk, k).map(i => entries[i].actROI)), roiMine: mean(topOf(mine, k).map(i => entries[i].actROI)),
    pStk: spearman(pp.map(p => p.stkROI), pp.map(p => p.actROI)), pMine: spearman(pp.map(p => pr[p.i]), pp.map(p => p.actROI)), pAgree: spearman(pp.map(p => pr[p.i]), pp.map(p => p.stkROI)) };
}

// How close is a generated field (app defaults, Marquee archetype) to the real one?
const STACK_DEF = { "5-3": 23, "5-2-1": 29, "5-x": 11, "4-4": 4, "4-3-1": 8, "4-2-x": 5, "4-x": 2, "3-3-x": 3 };   // keep in step with src/app/main.mjs
const NFL_DEF = { 1: 45, 2: 25, 3: 5, bring: 25 };
export function mlbStackOpt() {
  const g = k => STACK_DEF[k] || 0, p5 = g("5-3") + g("5-2-1") + g("5-x"), p4 = g("4-4") + g("4-3-1") + g("4-2-x") + g("4-x"), p3x = g("3-3-x"), unst = Math.max(0, 100 - p5 - p4 - p3x);
  return { sizes: { 5: p5, 4: p4, 3: p3x + unst }, secBy: { 5: { 3: g("5-3"), 2: g("5-2-1"), 1: g("5-x") }, 4: { 4: g("4-4"), 3: g("4-3-1"), 2: g("4-2-x"), 1: g("4-x") }, 3: { 3: p3x, 2: unst * 0.5, 1: unst * 0.5 } } };
}
// Projections file for a contest, if one was saved: the generator is judged on the same
// inputs it gets in the app (batting order, real salaries) rather than recovered ones.
function projFileFor(c) {
  const dirs = [path.join("data", c.dir), path.join("data", c.dir.replace(/-post$/, "")), path.join("data", `${c.date}-${c.sport}-main`)];
  for (const d of dirs) if (fs.existsSync(d)) { const f = fs.readdirSync(d).find(x => /Data_Hub_Projections\.csv$/i.test(x)); if (f) return path.join(d, f); }
  return null;
}
function poolFromProjections(file, fkey) {
  const rows = parseCSV(fs.readFileSync(file, "utf8")), pool = buildPool(rows[0], rows.slice(1), fkey);
  return pool;
}
export function fieldCheck(c, opts = {}) {
  const rc = recover(c), pf = opts.proj === false ? null : projFileFor(c);
  let pool = rc.pool, entries = rc.entries;
  if (pf) {
    // real lineups re-matched onto the projection pool; entries whose players are not in it are dropped
    const pp = poolFromProjections(pf, c.fkey), byKey = {}; pp.players.forEach((p, i) => { if (byKey[p.key] == null) byKey[p.key] = i; });
    const kept = [];
    for (const e of rc.entries) { const ids = e.names.map(nm => byKey[nrm(nm)]); if (ids.some(x => x == null)) continue; const lu = assignSlots(ids, pp.players, pp.format); if (lu) kept.push(Object.assign({}, e, { lu })); }
    if (kept.length >= rc.entries.length * 0.8) { pool = pp; entries = kept; }
  }
  const P = pool.players, f = pool.format, N = entries.length, real = entries.map(e => e.lu);
  const opt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3 }, f.sport === "mlb" ? mlbStackOpt() : { nflStacks: NFL_DEF }, opts.gen || {});
  const t0 = Date.now(), gen = genField(pool, N, opt, mulberry32(SEED)).field, ms = Date.now() - t0;
  const dist = lus => { const d = {}; for (const l of lus) { const k = stackOf(l, P, f); d[k] = (d[k] || 0) + 1 / lus.length; } return d; };
  const dr = dist(real), dg = dist(gen), keys = [...new Set(Object.keys(dr).concat(Object.keys(dg)))];
  const tvd = 0.5 * keys.reduce((s, k) => s + Math.abs((dr[k] || 0) - (dg[k] || 0)), 0);
  const dupes = lus => lus.length - new Set(lus.map(l => sigOf(l, f))).size;
  const expo = lus => { const e = new Float64Array(P.length); for (const l of lus) for (const id of l) e[id] += 100 / lus.length; return e; };
  const er = expo(real), eg = expo(gen), big = P.map((p, i) => i).filter(i => er[i] >= 1);
  const gap = mean(big.map(i => Math.abs(er[i] - eg[i])));
  const worst = big.map(i => ({ name: P[i].name, real: er[i], gen: eg[i] })).sort((a, b) => Math.abs(b.real - b.gen) - Math.abs(a.real - a.gen)).slice(0, 4);
  const top = Object.entries(dr).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}/${(100 * (dg[k] || 0)).toFixed(0)}`).join("  ");
  return { dir: c.dir, fkey: c.fkey, src: pool === rc.pool ? "recovered" : "projections", N, gen: gen.length, ms, tvd, dupReal: dupes(real), dupGen: dupes(gen), salReal: mean(real.map(l => salOf(l, P, f))), salGen: mean(gen.map(l => salOf(l, P, f))),
    ownReal: mean(real.map(l => ownSum(l, P, f))), ownGen: mean(gen.map(l => ownSum(l, P, f))), gap, worst, top };
}

// Averages by contest attribute for pulled contests (fee tier, field size), with counts.
function printByAttr(rows, attr, label, order) {
  const rs = rows.filter(r => r[attr]); if (!rs.length) return;
  const g = {}; for (const r of rs) (g[r[attr]] = g[r[attr]] || []).push(r);
  const avg = (list, k) => mean(list.map(r => r[k]));
  console.log(`\n=== by ${label} ===`);
  console.log("group".padEnd(12) + "contests  StkROI  MyROI   Agree  | playerROI Stk/Me  | top10% Stk / Me / field  | gated rule: Spearman  top10%");
  for (const k of order.filter(k => g[k])) { const l = g[k], gr = l.map(r => r.grades["ROI gated: top half proj"]); console.log(k.padEnd(12) + String(l.length).padEnd(10) + avg(l, "sStk").toFixed(3).padEnd(8) + avg(l, "sMine").toFixed(3).padEnd(8) + avg(l, "agree").toFixed(3).padEnd(7) + " | " + `${avg(l, "pStk").toFixed(2)}/${avg(l, "pMine").toFixed(2)}`.padEnd(18) + " | " + `${avg(l, "roiStk").toFixed(0)}% / ${avg(l, "roiMine").toFixed(0)}% / ${avg(l, "fieldROI").toFixed(0)}%`.padEnd(25) + " | " + mean(gr.map(x => x.spearman)).toFixed(3).padEnd(10) + mean(gr.map(x => x.real10)).toFixed(0) + "%"); }
}

export function printSummary(rows) {
  const names = rows.length ? Object.keys(rows[0].grades) : Object.keys(RULES).concat(["Stokastic ROI"]);
  printByAttr(rows, "tier", "entry fee", ["<$50", "$50-199", "$200-599", "$600+"]);
  printByAttr(rows, "size", "field size", ["<300", "300-1.5K", "1.5K-10K", "10K+"]);
  for (const fkey of ["mlb_cl", "nfl_cl", "nfl_sd"]) {
    const rs = rows.filter(r => r.fkey === fkey); if (!rs.length) continue;
    console.log(`\n=== ${fkey}: ${rs.length} contests ===`);
    console.log("contest".padEnd(40) + "N     paid  StkROI  MyROI  Proj   Agree | cash Stk/Me/rand  | top10% Stk / Me / field | playerROI Stk/Me");
    for (const r of rs) console.log(r.dir.padEnd(40) + String(r.N).padEnd(6) + String(r.paid).padEnd(6) + r.sStk.toFixed(3).padEnd(8) + r.sMine.toFixed(3).padEnd(7) + r.sProj.toFixed(3).padEnd(7) + r.agree.toFixed(3).padEnd(6) + " | " + `${r.cashStk}/${r.cashMine}/${r.cashRand.toFixed(1)}`.padEnd(18) + " | " + `${r.roiStk.toFixed(0)}% / ${r.roiMine.toFixed(0)}% / ${r.fieldROI.toFixed(0)}%`.padEnd(24) + " | " + `${r.pStk.toFixed(2)}/${r.pMine.toFixed(2)}`);
    const avg = f => mean(rs.map(r => r[f]));
    console.log("AVERAGE".padEnd(52) + avg("sStk").toFixed(3).padEnd(8) + avg("sMine").toFixed(3).padEnd(7) + avg("sProj").toFixed(3).padEnd(7) + avg("agree").toFixed(3).padEnd(6) + " | " + `${avg("cashStk").toFixed(1)}/${avg("cashMine").toFixed(1)}/${avg("cashRand").toFixed(1)}`.padEnd(18) + " | " + `${avg("roiStk").toFixed(0)}% / ${avg("roiMine").toFixed(0)}% / ${avg("fieldROI").toFixed(0)}%`.padEnd(24) + " | " + `${avg("pStk").toFixed(2)}/${avg("pMine").toFixed(2)}`);
    console.log("\n  selection rules (avg over contests): Spearman vs actual | cash hits vs random | realized top-10% | realized top-3 | contests with top-3 profit");
    for (const nme of names) {
      const g = rs.map(r => r.grades[nme]);
      console.log("  " + nme.padEnd(28) + mean(g.map(x => x.spearman)).toFixed(3).padEnd(22) + mean(g.map(x => x.cashHits)).toFixed(2).padEnd(22) + (mean(g.map(x => x.real10)).toFixed(0) + "%").padEnd(19) + (mean(g.map(x => x.real3)).toFixed(0) + "%").padEnd(17) + g.filter(x => x.real3 > 0).length + "/" + g.length);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), FIELD = args.includes("--field"), DUPECAP = args.includes("--dupecap"), JSON_OUT = (args.find(a => a.startsWith("--json=")) || "").slice(7), rest = args.filter(a => a !== "--field" && !a.startsWith("--json="));
  // --hitsame=0.30 --hsig=0.80 --psig=0.45 --smax=0.9: MLB outcome-model overrides for calibration runs (bench/compare-grades.mjs grades them against a default run)
  const flag = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
  const plain = args.filter(a => !a.startsWith("--"));
  const ITERS = +(plain[0] || 4000), FILTER = plain[1] || "";
  const HS = flag("hitsame"), HSIG = flag("hsig"), PSIG = flag("psig"), SMAX = flag("smax"), CONC = flag("conc");
  // NFL: --nflsig=QB:0.45,WR:0.5,RB:0.42,TE:0.55,DST:0.65 (per-position sigma) and --corr=0.8 (scale every CSAME/COPP entry)
  const NFLSIG = (args.find(a => a.startsWith("--nflsig=")) || "").slice(9), CORR = flag("corr");
  // --ctable=<file>: correlation tables fitted from real results (bench/fit-corr.mjs), merged over the defaults
  const LOADFILE = (args.find(a => a.startsWith("--load=")) || "").slice(7), LOADT = LOADFILE ? JSON.parse(fs.readFileSync(LOADFILE, "utf8")) : null;
  const CHOLMAX = flag("cholmax");   // force the factor model (0) or the pairwise matrix (large), as the app would use them
  const CTFILE = (args.find(a => a.startsWith("--ctable=")) || "").slice(9), CT = CTFILE ? JSON.parse(fs.readFileSync(CTFILE, "utf8")) : null;
  const nflSigma = Object.assign({}, SIGMA_DEF.nfl), cfbSigma = Object.assign({}, SIGMA_DEF.cfb);
  for (const kv of NFLSIG.split(",").filter(Boolean)) { const [k, v] = kv.split(":"); nflSigma[k] = +v; if (k in cfbSigma) cfbSigma[k] = +v; }
  const scaleT = t => CORR != null ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v * CORR])) : t;
  const sigmaDef = Object.assign({}, SIGMA_DEF.mlb); if (HSIG != null) for (const k of ["C", "1B", "2B", "3B", "SS", "OF"]) sigmaDef[k] = HSIG; if (PSIG != null) for (const k of ["P", "SP", "RP"]) sigmaDef[k] = PSIG;
  const isNFL = /nfl|cfb/.test(FILTER);   // football: --nflsig positions apply to CFB too (its base table is SIGMA_DEF.cfb)
  const MODEL = (LOADT || CHOLMAX != null || HS != null || HSIG != null || PSIG != null || SMAX != null || NFLSIG || CORR != null || CT) ? { tables: { CSAME: Object.assign({}, scaleT(CSAME), (CT || {}).CSAME || {}), COPP: Object.assign({}, scaleT(COPP), (CT || {}).COPP || {}), MLBC: Object.assign({}, MLBC, HS != null ? { hitSame: HS } : {}) }, sigmaBy: { mlb: sigmaDef, nfl: nflSigma, cfb: cfbSigma }, sigmaMax: SMAX != null ? SMAX : SIGMA_MAX, cholMax: CHOLMAX != null ? CHOLMAX : undefined, load: LOADT || undefined } : null;
  // --genfield [--batch=50] [--dupecap] [--minfee=200]: grade the generator too (real entries vs a generated field)
  // --vendor: grade on the recovered Stokastic pre-lock file (vendor Std Dev path) when bench/stk-vendor-files.mjs found one
  const NOSD = args.includes("--nosd");   // with --vendor: same file, but default sigmas instead of its Std Dev
  const VENDOR = args.includes("--vendor"), vendorMap = VENDOR ? Object.fromEntries(fs.readdirSync("data/vendor").flatMap(k => { const m = path.join("data/vendor", k, "map.json"); return fs.existsSync(m) ? Object.entries(JSON.parse(fs.readFileSync(m, "utf8"))) : []; })) : {};
  const ROWS = (args.find(a => a.startsWith("--rows=")) || "").slice(7); if (ROWS) fs.writeFileSync(ROWS, "");
  const GENFIELD = args.includes("--genfield"), BATCH = flag("batch") || 50, MINFEE = flag("minfee") || 0, MAXFEE = flag("maxfee") || 1e9, MAXN = flag("maxentries") || 1e9, ORACLE = args.includes("--oracleown"), SHARD = (args.find(a => a.startsWith("--shard=")) || "").slice(8).split("/").map(Number);
  if (MODEL) console.log(`model overrides:${CT ? ` fitted correlations from ${CTFILE} (${Object.keys(CT.CSAME || {}).length} same-team, ${Object.keys(CT.COPP || {}).length} opposing)` : ""} MLB hitSame ${MODEL.tables.MLBC.hitSame} hitter ${sigmaDef.OF} pitcher ${sigmaDef.P} | NFL ${JSON.stringify(nflSigma)} | CFB ${JSON.stringify(cfbSigma)} | corr x${CORR != null ? CORR : 1} sigmaMax ${MODEL.sigmaMax}`);
  const contests = listContests().filter(c => (!FILTER || c.dir.includes(FILTER) || c.fkey.includes(FILTER)) && (!MINFEE || (c.fee || 0) >= MINFEE) && ((c.fee || 0) <= MAXFEE) && ((c.entries || 0) <= MAXN));
  // --shard=k/n: take every n-th contest starting at k (0-based) so several processes can split a run; merge with bench/merge-json.mjs
  const shardList = SHARD.length === 2 && SHARD[1] > 1 ? contests.filter((c, i) => i % SHARD[1] === SHARD[0]) : contests;
  if (shardList !== contests) console.log(`shard ${SHARD[0]}/${SHARD[1]}: ${shardList.length} of ${contests.length} contests`);
  if (GENFIELD) console.log(`generated-field grading: batches of ${BATCH}${DUPECAP ? ", duplicate quota on" : ""}${CONC != null ? ", conc " + CONC : ""}${ORACLE ? ", field built on ACTUAL ownership (oracle)" : ""}`);
  if (FIELD) {
    // node bench/grade-all.mjs --field [iters-ignored] [filter]: generated field vs the real one
    console.log("contest".padEnd(40) + "N     stackTVD  dupes real/gen  salary real/gen   ownsum real/gen  expo gap | top stacks real/gen %");
    for (const c of shardList) {
      const r = fieldCheck(c, { gen: Object.assign({}, DUPECAP ? { dupeCap: true } : {}, CONC != null ? { conc: CONC } : {}) });
      console.log(r.dir.padEnd(40) + String(r.N).padEnd(6) + r.tvd.toFixed(2).padEnd(10) + `${r.dupReal}/${r.dupGen}`.padEnd(16) + `${r.salReal.toFixed(0)}/${r.salGen.toFixed(0)}`.padEnd(18) + `${r.ownReal.toFixed(0)}/${r.ownGen.toFixed(0)}`.padEnd(17) + r.gap.toFixed(1).padEnd(9) + "| " + r.top);
      console.log("".padEnd(46) + "largest exposure misses: " + r.worst.map(w => `${w.name} ${w.real.toFixed(0)}→${w.gen.toFixed(0)}`).join(", ") + ` (${r.ms} ms)`);
    }
    process.exit(0);
  }
  const rows = [];
  for (const c of shardList) {
    if (VENDOR && !vendorMap[c.key]) continue;   // only contests with a vendor file, so A/B runs pair up
    const r = gradeContest(c, Object.assign({ iters: ITERS }, VENDOR ? { proj: vendorMap[c.key].file } : {}, MODEL ? { model: MODEL } : {}, NOSD ? { model: Object.assign({}, MODEL || {}, { ignoreFileSigma: true }) } : {}, GENFIELD ? { genField: true, batch: BATCH, gen: Object.assign({}, DUPECAP ? { dupeCap: true } : {}, CONC != null ? { conc: CONC } : {}, ORACLE ? { oracleOwn: true } : {}) } : {}, ROWS ? { rows: true } : {})); rows.push(r);
    if (ROWS && r.entryRows) { fs.appendFileSync(ROWS, r.entryRows.map(x => JSON.stringify(x)).join("\n") + "\n"); delete r.entryRows; }
    console.log(`\n=== ${c.dir} [${c.fkey}] ===`);
    console.log(`  ${r.N} entries of ${r.rows} rows, ${r.paid} paid, field ROI ${r.fieldROI.toFixed(0)}%; ${r.players} players, ${r.teams} teams, ${r.games} games; unmatched ${r.unmatched.length}${r.unmatched.length ? " (" + r.unmatched.slice(0, 5).join(", ") + ")" : ""}; projection residual ${r.resid.toFixed(2)} FP/lineup; sim ${r.ms} ms`);
    console.log(`  lineup ROI vs actual FP: Stokastic ${r.sStk.toFixed(3)}  mine ${r.sMine.toFixed(3)}  projection ${r.sProj.toFixed(3)}  (agree ${r.agree.toFixed(3)}) | top-${r.paid} cashed: Stk ${r.cashStk} / me ${r.cashMine} / rand ${r.cashRand.toFixed(1)} | top-10% realized: Stk ${r.roiStk.toFixed(0)}% / me ${r.roiMine.toFixed(0)}%`);
    console.log(`  player ROI vs actual: Stokastic ${r.pStk.toFixed(3)}  mine ${r.pMine.toFixed(3)}  (agree ${r.pAgree.toFixed(3)})`);
  }
  printSummary(rows);
  // --json=<file>: keep per-contest grades so selection rules can be analysed without re-simming
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows.map(r => ({ dir: r.dir, fkey: r.fkey, date: r.date, fee: r.fee, tier: r.tier, size: r.size, src: r.src, resid: r.resid, N: r.N, paid: r.paid, fieldROI: r.fieldROI, sStk: r.sStk, sMine: r.sMine, roiStk: r.roiStk, roiMine: r.roiMine, pStk: r.pStk, pMine: r.pMine, agree: r.agree, cashStk: r.cashStk, cashMine: r.cashMine, grades: r.grades }))));
}
