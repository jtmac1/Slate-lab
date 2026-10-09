// Contest Generator + Pre-Contest Simulator, the Stokastic shape: the generator builds a field of
// opponent lineups from projected ownership (pool size, contest archetype, stack-type exposures,
// team controls, ownership boosts) and saves it as data/<slate>/field.json; the simulator grades a
// set of lineups (uploaded, built, or the generated pool itself) against that one field, playing
// the slate out thousands of times under each projection source, and saves data/<slate>/simrun.json
// with Simulated ROI, Win%, Top 1%, Top 10%, Cash%, Dupes per lineup and Player ROI.
import fs from "node:fs";
import path from "node:path";
import { nrm } from "../src/engine/csv.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { genField } from "../src/engine/field.mjs";
import { simulate, playerROI } from "../src/engine/sim.mjs";
import { scriptCollector, lineupScripts } from "../src/engine/portfolio.mjs";
import { fitPayouts, paidCount } from "../src/engine/payouts.mjs";
import { buildLineups } from "../src/engine/build.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf, salOf, ownSum, stackTeams } from "../src/engine/lineups.mjs";
import { loadPool, keyOf, ownOf, cptOf, projOf, prizesFromName } from "./foursim.mjs";
const MAX_POOL = 20000;
import { ownModel, SD_POS_OWN, sdPosAdjust } from "./sources.mjs";
import { evalContext, evaluateLineup, verdictOf, playerFrom, lobby, loadGuide } from "./entries.mjs";
import { classicFeatures, showdownFeatures, markObviousBringBack, markOwnRelative, rulesFor, FLAT_CHALK, gradePool, DEFAULT_WEIGHTS } from "../src/engine/grade.mjs";

// Archetypes. Classic keeps the app's presets. Showdown is fitted on 30 real 2026 $20+ showdown
// fields (bench/fit-field-nfl-sd.mjs, 2026-10-01): real fields leave salary ($580 on average), and
// a $49,000 floor forced the generator onto the expensive chalk (top-owned players 72% of the pool
// vs 60% actual). A $44,000 floor cut the flex-ownership error from 5.6 to 5.1 points; chalk still
// runs ~1.1x actual, which is the generator's remaining bias, not the conc setting.
// Classic fitted on 40 real 2025 classic fields (bench/fit-field-nfl-cl.mjs): conc 1.2 with a $48,000
// floor reproduces actual ownership within 2.9 points on average with chalk at 0.99x actual, every
// bucket within a point. The old Marquee (conc 1.0, $49,000) under-weighted chalk at 0.95x.
// With the ownership curve applied first (fieldPool), the exponent only adds a little on top: 1.1 fit
// this season's fields best (MAE 3.22, chalk 0.95x); 1.0 and 1.25 bracket it for softer / sharper rooms.
// Marquee re-fit 2026-10-02 (bench/fit-field-dupes-nfl.mjs, 60 real contests at their own size): conc 1.25 plus a mix of
// optimizer entrants (15% keep the best of 60 candidate lineups, 35% the best of 5) matches the real field on duplicate share
// (13.4% vs 13.3%; the old 1.1 built 7.9%), chalk per lineup (248 vs 247 actual-own) and strength. Graded on 352 contests
// (bench/grade-loop-nfl.mjs) the construction-filtered picks are unchanged (top-10% 15.0% vs 15.1%, paired t 0.06), so this
// buys honest Dupes and split payouts at no cost to picks. Low and High keep the same mix scaled down / up (not separately fit).
// Re-fit 2026-10-05 (bench/fit-arch-nfl.mjs, real Sunday 10/04 main-slate fields with the app's own inputs, checked on 2025):
// every archetype over-built chalk (exposure of the 10 most-projected players / their projection: high 1.20 vs 1.05 real,
// marquee 1.22 vs 0.94, low 1.10 vs 0.94; 2025 gaps +0.11 to +0.16), and left $300-700 of salary unused vs ~$100 real.
// conc 1.15 / 1.0 / 1.0 with higher salary floors closes the chalk gap to +0.02 / +0.10 / +0.04 on Sunday and +0.07 / +0.03
// / +0.06 on 2025, with top-10 share within 0.02 everywhere. Optimizer mixes unchanged (halving them barely moved chalk).
const ARCH = { low: { conc: 1.0, minSal: 48800, boost: 0.6, skill: [[0.10, 40], [0.30, 4]], dupeFloor: "auto" }, marquee: { conc: 1.0, minSal: 49000, boost: 1.0, skill: [[0.15, 60], [0.35, 5]], dupeFloor: "auto" }, high: { conc: 1.15, minSal: 49200, boost: 1.5, skill: [[0.20, 80], [0.40, 6]], dupeFloor: "auto" } };
// Showdown re-fit 2026-10-06 (bench/fit-arch-sd.mjs, real showdown fields by input-ownership bucket, with the position
// multipliers SD_POS_OWN in place): the $44,000 floor let the generator fill with cheap punts (salary $47,300-48,500 vs
// ~$49,500 real), so 0-10%-owned players were over-exposed and 45%+ under-exposed (2026 high: 54 vs 59 real). FLEX conc
// 1.3 / 1.15 / 1.15 with a $48,500 / $48,500 / $47,500 floor, and a separate, flatter captain conc (1.2 / 1.0 / 1.0; one
// conc for both over-built CPT chalk in 2026), fit on 2025 and checked on 2026: mean bucket error 2.59 / 2.66 / 3.26 (old
// settings, no position multipliers) -> 1.31 / 1.09 / 1.01 on 2026, 0.92 / 1.23 / 0.95 on 2025. Duplicates stay well
// under real (17-35% vs 43-66%).
// Copies 2026-10-06 (bench/sd-dupes-real.mjs, bench/fit-dupes-sd.mjs): real showdown fields copy in groups - a few lineups
// entered by many people - with the copy share rising with field size (SD_DUPE in src/engine/field.mjs, 0.28 at 300 entries
// to 0.68 at 16,000). dupeFloor "auto" adds copy groups (sizes ~g^-2.4, sources by projection rank) to that share; the
// extra chalk is offset by a lower conc in marquee/low (0.95 / 0.9) and high (1.15 / 1.0). Fit on 2025, checked on 2026:
// duplicate error (copy share + copy-group sizes) 25-28 -> 4-8 points in every tier; bucket exposure error high 2.92 ->
// 2.83, marquee 2.16 -> 2.26, low 1.98 -> 2.12 (full-size fields), the last two inside noise.
const ARCH_SD = { low: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 47500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, marquee: { conc: { FLEX: 0.95, CPT: 0.9 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 }, high: { conc: { FLEX: 1.15, CPT: 1.0 }, minSal: 48500, boost: 1.0, dupeFloor: "auto", dupeAlpha: 2.4, dupeGamma: 1 } };
// Stack-type exposures measured on 381 real classic fields, 2025-26 (QB + same-team WR/TE):
// QB+1 43-49%, QB+2 40-43%, QB+3 4-6%, unstacked 8-9%; 60-62% of stacked lineups bring back an
// opponent. High-stakes fields stack deeper (QB+2 48%, QB+3 11%, unstacked 4%, bring-back 67%).
const NFL_DEF = { 1: 45, 2: 41, 3: 5, bring: 62 };
const NFL_STACKS = { low: { 1: 46, 2: 40, 3: 4, bring: 60 }, marquee: NFL_DEF, high: { 1: 37, 2: 48, 3: 10, bring: 67 } };
const readJ = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null, nm = s => nrm(String(s || ""));
export const loadField = dir => readJ(path.join("data", dir, "field.json"));
// the guide notes (Notes / Theses columns, the Brain) are re-matched against the current slate guide on every load, so new
// ETR reads show up without re-running the sim
export const loadSimRun = dir => { const r = readJ(path.join("data", dir, "simrun.json")); if (!r || !Array.isArray(r.rows)) return r; const g = loadGuide(dir), sd = r.format === "nfl_sd"; for (const e of r.rows) if (e.players) { e.notes = matchNotes(e.players, g, sd); e.theses = e.notes.theses; } r.guide = !!g; gradeRun(dir, r, sd); return r; };
// the lineup grade (src/engine/grade.mjs): Lab ROI percentile + the rulebook (data/reports/rulebook-nfl.json, ownership = Model own)
// + the slate guide notes, weighted by data/reports/grade-weights.json when the backtest has written one
// players in the pool projected 20%+ owned (Model own): how concentrated the slate is (src/engine/grade.mjs FLAT_CHALK)
const chalkOf = rows => { const seen = new Map(); for (const e of rows) for (const p of e.players || []) seen.set(p.name + "|" + p.team, p.fown ?? p.own ?? 0); return [...seen.values()].filter(o => o >= 20).length; };
// the generated contest field's own sums and chalk counts on the same Model own the lineups are graded on, so "above the
// contest median" means the field's median (the archive's definition), not the Lab pool's; null without a field.json
function fieldOwn(dir, rows) {
  const F = loadField(dir); if (!F || !Array.isArray(F.rows) || !F.rows.length) return null;
  const own = new Map(); for (const p of F.players || []) own.set(p.name, p.own ?? 0);
  for (const e of rows) for (const p of e.players || []) own.set(p.name, p.fown ?? p.own ?? 0);
  return F.rows.filter(x => Array.isArray(x.names)).map(x => { const o = x.names.map(n => own.get(n) ?? 0); return { ownSum: o.reduce((a, b) => a + b, 0), chalk: o.filter(v => v >= 20).length }; });
}
function gradeRun(dir, r, sd) {
  const rb = readJ("data/reports/rulebook-nfl.json"); if (!rb) return;
  const wf = readJ("data/reports/grade-weights.json"), weights = wf && wf.weights || DEFAULT_WEIGHTS, fee = r.contest && r.contest.fee || 20;
  const games = (readJ(path.join("data", dir, "slate.json")) || {}).games || [], mk = p => ({ name: p.name, pos: p.pos, team: p.team, opp: p.opp, sal: p.sal, own: p.fown ?? p.own, cptOwn: p.cptOwn });
  const rows = r.rows.filter(e => e.players && e.sim), feats = rows.map(e => sd ? showdownFeatures(e.players.map(mk)) : classicFeatures(e.players.map(mk)));
  if (!sd) { markObviousBringBack(feats); markOwnRelative(feats, fieldOwn(dir, rows)); }
  const G = gradePool(rows.map((e, i) => ({ sim: e.sim.lab ?? e.sim.mean, feats: feats[i], guide: r.guide ? e.notes : null })), rulesFor(rb, { sd, fee, games: games.length || 12, chalkN: sd ? null : chalkOf(rows) }), { weights, fee, sd });
  rows.forEach((e, i) => { e.grade = G[i]; if (!sd && feats[i].chalkBB != null) e.grade.bringBack = { takes: feats[i].chalkBB, share: +(100 * feats[i].chalkBBShare).toFixed(0) }; });
  const chalkN = sd ? null : chalkOf(rows);
  r.gradeInfo = { chalkN, flat: chalkN != null && chalkN <= FLAT_CHALK, weights: G[0] ? G[0].weights : null, rulebook: { from: rb.from, to: rb.to, contests: rb.contests }, fitted: !!(wf && wf.weights) };
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// Ownership source by contest size (Sunday review 2026-10-04, data/reports/review-2026-10-04-sources.json: one slate,
// 46 main-slate contests). In $100+ fields of 1,000 or fewer Blick's high-stakes number was closest (MAE 1.34), the player
// model next (1.42), but the two stacked over-shot chalk (CMC 54% vs 40% actual), so Blick HS alone; in fields over 10,000 the plain vendor average was closest and the model's chalk boost over-shot
// (chalk error 6.9), so no model there; Stokastic was the worst classic ownership (2.54) and leaves the classic average.
// Between 1,000 and 10,000 (and under-$100 small fields): the vendor average without Stokastic, through the model, as before.
// Showdown keeps every source and its fitted exponent (Stokastic was best on FLEX). ownSrc "auto" applies this; "avg",
// "stk", "etr", "blick" still override it (avg = the old all-vendor average).
export function ownTier(sd, contest) {
  if (sd) return { src: "avg", curve: true, tier: "showdown" };
  const n = contest && contest.field, fee = contest && contest.fee;
  if (n && n <= 1000 && fee >= 100) return { src: "blickHS", curve: false, tier: "high-stakes small field: Blick HS, no model" };
  if (n && n > 10000) return { src: "vavg", curve: false, tier: "large field: vendor average (no Stokastic), no model" };
  return { src: "vavg", curve: true, tier: "vendor average (no Stokastic); model + chalk curve on Stokastic-only players" };
}
// the engine pool with the chosen ownership source, boosts and team controls applied; projections from the Lab blend
export function fieldPool(L, cfg) {
  const { pool, hubBy, vendors, sd } = L, projSrc = cfg.projSrc || "lab", boosts = cfg.boosts || {}, removed = new Set(cfg.teamsRemoved || []), tboost = cfg.teamBoost || {};
  const t = (cfg.ownSrc || "auto") === "auto" ? ownTier(sd, cfg.contest) : null, ownSrc = t ? t.src : cfg.ownSrc, curve = t ? t.curve : cfg.curve !== false;
  // classic: predict each player's actual ownership from the chosen source with the player model (over/under-owned by
  // position, value, rank, team chalk; 2026 hold-out chalk MAE 7.5 vs 9.7 raw); showdown stays on the fitted exponent
  const base = pool.players.map(p => { const r = hubBy.get(keyOf(p.name, p.pos, p.team)); return { p, r, pos: p.pos, team: p.team, sal: p.sal, vown: ownOf(r, ownSrc, vendors) ?? p.own, proj: projOf(r, projSrc, p.proj), labOwn: null }; });
  // the model + chalk curve only touch rows whose number is Stokastic's (both fit on Stokastic; they over-shoot chalk on
  // ETR/Blick numbers, see CLASSIC_CHALK in server/sources.mjs): ownSrc "stk", or players ETR and Blick don't carry
  if (!sd && curve) ownModel("classic")(base, { n: cfg.contest ? cfg.contest.field : cfg.n, fee: cfg.contest ? cfg.contest.fee : cfg.fee,
    only: b => ownSrc === "stk" || !b.r || (b.r.etr?.own == null && b.r.blick?.own == null) });
  for (const b of base) b.cown = cptOf(b.r, ownSrc, vendors) ?? Math.max(0.1, (b.labOwn ?? b.vown) / 6);
  // showdown: the field plays some positions more than projected (SD_POS_OWN in server/sources.mjs); cfg.posAdj false skips it
  if (sd && cfg.posAdj !== false) {
    const f = sdPosAdjust(base.map(b => ({ pos: b.pos, own: b.labOwn ?? b.vown })), SD_POS_OWN.raw.flex), c = sdPosAdjust(base.map(b => ({ pos: b.pos, own: b.cown })), SD_POS_OWN.raw.cpt);
    base.forEach((b, i) => { b.labOwn = f[i]; b.cown = c[i]; });
  }
  const players = base.map(({ p, r, vown, labOwn, cown: c0 }) => {
    let own = labOwn ?? vown, cown = c0;
    const b = boosts[nrm(p.name)] || 0; if (b) { own *= Math.pow(1.25, b); cown *= Math.pow(1.25, b); }
    if (tboost[p.team]) { own *= tboost[p.team]; cown *= tboost[p.team]; }
    let proj = Math.max(0, projOf(r, projSrc, p.proj) ?? 0);
    if (removed.has(p.team)) { own = 0; cown = 0; proj = 0; }
    return Object.assign({}, p, { proj, own, cown, fown: own });
  });
  return Object.assign({}, pool, { players });
}
const stackLabel = (lu, P, f) => {
  if (f.mult) { const tc = {}; for (const id of lu) tc[P[id].team] = (tc[P[id].team] || 0) + 1; const cpt = P[lu[0]]; return `${cpt.pos} CPT · ${Object.values(tc).sort((a, b) => b - a).join("-")}`; }
  const qb = lu.map(i => P[i]).find(p => p.pos === "QB"); if (!qb) return "No QB";
  const n = lu.map(i => P[i]).filter(p => p !== qb && p.team === qb.team && /^(WR|TE|RB)$/.test(p.pos)).length, opp = lu.map(i => P[i]).filter(p => p.team === qb.opp && p.pos !== "DST").length;
  return (n ? `QB + ${n}` : "Unstacked") + (opp ? ` | ${opp} OPP` : "");
};

// one field from one ownership/projection source; returns the lineups plus the exposure, stack and ranker tables
function buildOne(L, cfg, n, arch, stacks) {
  const f = L.pool.format, gp = fieldPool(L, cfg), P = gp.players;
  const opt = Object.assign({ rounds: 3, nflStacks: stacks }, arch, cfg.opt || {});
  const g = genField(gp, n, opt, mulberry32(+cfg.seed || 1));
  const field = g.field, N = field.length;
  // per-player pool exposure vs projected ownership
  const cnt = new Array(P.length).fill(0), ccnt = new Array(P.length).fill(0);
  for (const lu of field) lu.forEach((id, j) => { cnt[id]++; if (f.mult && j === 0) ccnt[id]++; });
  const players = P.map((p, i) => ({ name: p.name, pos: p.posList ? p.posList.join("/") : p.pos, team: p.team, opp: p.opp, sal: p.sal, own: +(p.own || 0).toFixed(1), cown: f.mult ? +(p.cown || 0).toFixed(1) : null, exp: +(100 * cnt[i] / N).toFixed(1), cexp: f.mult ? +(100 * ccnt[i] / N).toFixed(1) : null, boost: (cfg.boosts || {})[nrm(p.name)] || 0 })).filter(p => p.own > 0 || p.exp > 0).sort((a, b) => b.exp - a.exp);
  // stack types in the pool vs desired
  const types = {}; for (const lu of field) { const k = stackLabel(lu, P, f).split(" |")[0]; types[k] = (types[k] || 0) + 1; }
  const desired = f.mult ? null : { "QB + 1": stacks[1], "QB + 2": stacks[2], "QB + 3": stacks[3], "Unstacked": Math.max(0, 100 - stacks[1] - stacks[2] - stacks[3]) };
  const stackRows = Object.entries(types).map(([k, c]) => ({ type: k, exp: +(100 * c / N).toFixed(1), desired: desired && desired[k] != null ? desired[k] : null })).map(r => Object.assign(r, { diff: r.desired == null ? null : +(r.exp - r.desired).toFixed(1) })).sort((a, b) => b.exp - a.exp);
  const sigs = {}; for (const lu of field) { const s = sigOf(lu, f); sigs[s] = (sigs[s] || 0) + 1; }
  return { field, P, players, stackRows, sigs, rows: rankRows(field, P, f, sigs) };
}
// ranker: projection rank and ownership rank, dupes within the pool
function rankRows(field, P, f, sigs) {
  const rows = field.map((lu, i) => ({ i, proj: +lu.reduce((s, id, j) => s + (f.mult ? f.mult[j] : 1) * P[id].proj, 0).toFixed(2), own: +ownSum(lu, P, f).toFixed(1), sal: salOf(lu, P, f), type: stackLabel(lu, P, f), dupes: sigs[sigOf(lu, f)] - 1, names: lu.map(id => P[id].name), ids: lu }));
  const byProj = rows.map(r => r.i).sort((a, b) => rows[b].proj - rows[a].proj), byOwn = rows.map(r => r.i).sort((a, b) => rows[b].own - rows[a].own);
  byProj.forEach((i, r) => { rows[i].pr = r + 1; }); byOwn.forEach((i, r) => { rows[i].or = r + 1; });
  return rows;
}

// cfg.ownSrc "all": one field per source (Stokastic, ETR, Blick own + proj; Market = its projections on the
// vendors' average ownership), saved side by side; the top-level pool is the union of all of them, each
// lineup tagged with the sources that built it, scored on the Lab blend and the average ownership.
// Classic since the 2026-10-04 review: the Stokastic and Market fields take the contest-size ownership (ownTier) instead of
// Stokastic's / the all-vendor average, and the union is scored on it too; showdown is unchanged.
export function buildField(dir, cfg = {}) {
  const t0 = Date.now(), L = loadPool(dir), { sd, fkey, srcs } = L, f = L.pool.format;
  // sized to the contest: when a DK contest is picked the pool is that contest's entry count (capped at MAX_POOL), so the
  // simulator's duplicate counts and finishing ranks mean what they will mean in the real room
  const LBc0 = cfg.cid ? lobby().get(String(cfg.cid)) : null, LBc = LBc0 && LBc0.fee > 0 && LBc0.field > 0 && LBc0.field < 1e6 ? LBc0 : null, contest = LBc ? { cid: String(LBc.id), name: LBc.name, fee: LBc.fee, field: LBc.field, prizePool: LBc.prizePool || null, top: prizesFromName(LBc.name).top } : null;
  const n = Math.max(50, Math.min(MAX_POOL, contest && cfg.sizeToContest !== false ? contest.field : (+cfg.n || 1000))), archKey = (sd ? ARCH_SD : ARCH)[cfg.arch] ? cfg.arch : "marquee", arch = (sd ? ARCH_SD : ARCH)[archKey], stacks = Object.assign({}, NFL_STACKS[archKey] || NFL_DEF, cfg.stacks || {});
  cfg = Object.assign({}, cfg, { contest });
  const tier = ownTier(sd, contest), base = { n, contest, arch: cfg.arch || "marquee", ownSrc: cfg.ownSrc || "auto", ownTier: (cfg.ownSrc || "auto") === "auto" || cfg.ownSrc === "all" ? tier.tier : null, projSrc: cfg.projSrc || "lab", stacks, boosts: cfg.boosts || {}, teamsRemoved: cfg.teamsRemoved || [], teamBoost: cfg.teamBoost || {} };
  let out;
  if (cfg.ownSrc === "all") {
    const by = {}, union = [], seen = new Map();
    for (const s of srcs) {
      const one = buildOne(L, Object.assign({}, cfg, { ownSrc: s === "mkt" ? (sd ? "avg" : "auto") : s === "stk" && !sd ? "auto" : s, projSrc: s }), n, arch, stacks);
      by[s] = { N: one.field.length, dupes: one.field.length - Object.keys(one.sigs).length, field: one.field, players: one.players, stackRows: one.stackRows };
      for (const lu of one.field) { const k = sigOf(lu, f); if (seen.has(k)) { const u = seen.get(k); if (!u.from.includes(s)) u.from.push(s); u.copies++; } else { const u = { lu, from: [s], copies: 1 }; seen.set(k, u); union.push(u); } }
    }
    // union scored on the Lab blend and the contest-size ownership (the all-vendor average for showdown)
    const gp = fieldPool(L, Object.assign({}, cfg, { ownSrc: "auto", projSrc: "lab" })), P = gp.players, field = union.map(u => u.lu);
    const sigs = {}; for (const u of union) sigs[sigOf(u.lu, f)] = u.copies;
    const rows = rankRows(field, P, f, sigs); rows.forEach((r, i) => { r.from = union[i].from; });
    // players and stack rows: the average across the per-source fields, with each source's exposure beside it
    const pm = new Map(); for (const s of srcs) for (const p of by[s].players) { const k = p.name + "|" + p.team + "|" + p.pos; const x = pm.get(k) || Object.assign({}, p, { by: {}, own: 0, exp: 0, cexp: 0, cown: p.cown == null ? null : 0, k: 0 }); x.by[s] = p.exp; x.own += p.own; x.exp += p.exp; if (p.cexp != null) x.cexp += p.cexp; if (p.cown != null) x.cown += p.cown; x.k++; pm.set(k, x); }
    const players = [...pm.values()].map(x => Object.assign(x, { own: +(x.own / x.k).toFixed(1), exp: +(x.exp / x.k).toFixed(1), cexp: f.mult ? +(x.cexp / x.k).toFixed(1) : null, cown: f.mult && x.cown != null ? +(x.cown / x.k).toFixed(1) : null, k: undefined })).sort((a, b) => b.exp - a.exp);
    const sm = {}; for (const s of srcs) for (const r of by[s].stackRows) { const x = sm[r.type] = sm[r.type] || { type: r.type, exp: 0, desired: r.desired, k: 0 }; x.exp += r.exp; x.k++; }
    const stackRows = Object.values(sm).map(x => ({ type: x.type, exp: +(x.exp / srcs.length).toFixed(1), desired: x.desired, diff: x.desired == null ? null : +(x.exp / srcs.length - x.desired).toFixed(1) })).sort((a, b) => b.exp - a.exp);
    out = { dir, at: new Date().toISOString(), ms: Date.now() - t0, cfg: base, format: fkey, all: true, sources: srcs, N: n, dupes: Object.values(by).reduce((s, b) => s + b.dupes, 0), union: union.length, players, stackRows, rows, field, by };
  } else {
    const one = buildOne(L, cfg, n, arch, stacks);
    out = { dir, at: new Date().toISOString(), ms: Date.now() - t0, cfg: base, format: fkey, N: one.field.length, dupes: one.field.length - Object.keys(one.sigs).length, players: one.players, stackRows: one.stackRows, rows: one.rows, field: one.field };
  }
  fs.writeFileSync(path.join("data", dir, "field.json"), JSON.stringify(out));
  return stripField(out);
}
// the field file without the lineup arrays, for the client
export const stripField = F => !F ? { rows: [] } : Object.assign({}, F, { field: undefined, by: F.by ? Object.fromEntries(Object.entries(F.by).map(([s, b]) => [s, Object.assign({}, b, { field: undefined })])) : undefined });

// per-source weights from the scorecard (data/reports/source-scorecard-nfl.json byPos): 1/MAE^2 with MAE pooled over positions
function sourceWeights(srcs) {
  const names = { stk: "stokastic", etr: "etr", blick: "blick", mkt: "market" }, w = {};
  try {
    const bp = JSON.parse(fs.readFileSync("data/reports/source-scorecard-nfl.json", "utf8")).byPos || {};
    for (const s of srcs) { let n = 0, m = 0; for (const b of Object.values(bp)) { const q = b[names[s]]; if (q && q.n >= 30 && q.mae > 0) { n += q.n; m += q.n * q.mae; } } if (n) w[s] = 1 / Math.pow(m / n, 2); }
  } catch {}
  const have = Object.values(w), floor = have.length ? 0.5 * Math.min(...have) : 1;
  for (const s of srcs) if (w[s] == null) w[s] = floor;
  return w;
}
// what the slate guide (ETR breakdown / sim analysis / Blick notes, data/<slate>/slate-guide.json) says about this lineup:
// plays it carries (core, value, leverage, dart), fades it carries, stack and game ideas it matches, captain reads on showdown.
// guide.data (ETR DvP / XFP / PROE tables) is deliberately not scored here: the Brain sees it, the grade waits until
// bench/signal-tracker-nfl.mjs shows a signal predicts points, ownership error or ROI on the user's slates
// name normalizing is memoized and the guide's name lookups indexed once per guide object (loadSimRun runs this on every row)
const NMC = new Map(), nmc = s => { s = String(s || ""); let v = NMC.get(s); if (v === undefined) { v = nm(s); if (NMC.size > 50000) NMC.clear(); NMC.set(s, v); } return v; };
const GIDX = new WeakMap(), gidx = g => { let x = GIDX.get(g); if (!x) { const by = o => new Map(Object.keys(o || {}).map(k => [nmc(k), k])); x = { stance: by(g.stances), pn: by(g.playerNotes), pair: by(g.cptPairs) }; GIDX.set(g, x); } return x; };
export function matchNotes(players, guide, sd) {
  const out = { for: [], against: [], n: 0, theses: [] };
  if (!guide) return out;
  const nm = nmc, I = gidx(guide);
  const names = players.map(p => nm(p.name)), has = list => (list || []).filter(x => names.includes(nm(x)));
  // theses: the ways the slate can play out (guide.theses[{id,name,players[],games[]}]). Classic: a lineup bets on one when it has a QB
  // stack (QB + a skill player) in the thesis game or 3+ non-DST pieces of it (its players or its games); measured 10/03 on the main
  // slate this tags ~1 thesis per lineup instead of 2+. Showdown (one game, every lineup is "in" it): 2+ of the thesis players.
  { const qb = players.find(p => p.pos === "QB"), isD = p => /^(DST|D|DEF)$/i.test(p.pos || "");
    for (const t of guide.theses || []) { const tn = new Set((t.players || []).map(nm)), teams = (t.games || []).flatMap(g => String(g).toUpperCase().split(/[@s-]+/));
      if (sd) { if (players.filter(p => tn.has(nm(p.name))).length >= 2) out.theses.push(t.id || t.name); continue; }
      const pieces = players.filter(p => !isD(p) && (tn.has(nm(p.name)) || teams.includes(String(p.team).toUpperCase()))).length;
      const qbStack = qb && teams.includes(String(qb.team).toUpperCase()) && players.some(p => p !== qb && !isD(p) && p.team === qb.team);
      if (qbStack || pieces >= 3) out.theses.push(t.id || t.name); } }
  // stances: per-player reads with the reason (guide.stances{name:{stance,why,source}}); core/value/leverage count for, fade/avoid against
  for (const p of players) { const k = I.stance.get(nm(p.name)); if (!k) continue; const s = guide.stances[k], st = String(s.stance || "").toLowerCase(); if (/fade|avoid|against/.test(st)) out.against.push({ kind: "Fade", names: [p.name], note: s.why }); else if (/caution/.test(st)) out.against.push({ kind: "Caution", names: [p.name], note: s.why }); else if (/core|value|leverage|dart|like|play/.test(st)) out.for.push({ kind: st[0].toUpperCase() + st.slice(1), names: [p.name], note: s.why }); }
  const tp = guide.topPlays || {}, cats = [["overall", "Core"], ["core", "Core"], ["value", "Value"], ["leverage", "Leverage"], ["dart", "Dart"]], seen = new Set(out.for.concat(out.against).flatMap(x => x.names.map(nm)));
  for (const [k, label] of cats) { const h = has(tp[k]).filter(x => !seen.has(nm(x))); if (h.length) out.for.push({ kind: label, names: h }); }
  for (const k of ["fade", "avoid"]) { const h = has(tp[k]).filter(x => !seen.has(nm(x))); if (h.length) out.against.push({ kind: "Fade", names: h }); }
  if (sd) {
    const cpt = players[0];
    if ((guide.cptPool || []).some(x => nm(x) === nm(cpt.name))) out.for.push({ kind: "CPT idea", names: [cpt.name] });
    const pk = I.pair.get(nm(cpt.name)), pr = pk ? [pk, guide.cptPairs[pk]] : null;
    if (pr) { const b = has(pr[1].boost), h = has(pr[1].hurt); if (b.length) out.for.push({ kind: "With CPT", names: b }); if (h.length) out.against.push({ kind: "Hurt by CPT", names: h }); }
    for (const st of guide.stacks || []) if (nm(st.cpt) === nm(cpt.name)) { const w = has(st.with); if (w.length) out.for.push({ kind: "Stack idea", names: w }); }
  } else {
    const qb = players.find(p => p.pos === "QB");
    for (const st of guide.stacks || []) { const anchor = st.qb || st.cpt; if (qb && anchor && nm(anchor) === nm(qb.name)) { const w = has(st.with); if (w.length) out.for.push({ kind: "Stack idea", names: [qb.name, ...w] }); } }
    for (const g of guide.games || []) { const teams = String(g.game || g.teams || "").toUpperCase().split(/[@\s-]+/).filter(Boolean), inG = players.filter(p => teams.includes(String(p.team).toUpperCase())); if (teams.length === 2 && inG.length >= 2) (g.kind === "avoid" ? out.against : out.for).push({ kind: g.kind === "avoid" ? "Game to avoid" : "Game idea", names: [teams.join("@")], note: g.note }); }
  }
  const pn = guide.playerNotes || {}; for (const p of players) { const k = I.pn.get(nm(p.name)); if (k) { const t = pn[k]; const neg = typeof t === "object" ? t.kind === "against" : /^(fade|avoid|against)/i.test(t); (neg ? out.against : out.for).push({ kind: "Note", names: [p.name], note: typeof t === "object" ? t.note : t }); } }
  out.n = out.for.reduce((t, x) => t + x.names.length, 0) - out.against.reduce((t, x) => t + x.names.length, 0);
  return out;
}
// lineups: cfg.useField (grade the generated pool), cfg.lineups (rows of names / "Name (id)"), or cfg.build (buildLineups cfg)
export function runSim(dir, cfg = {}) {
  const t0 = Date.now(), L = loadPool(dir), { hub, pool, hubBy, vendors, srcs, sd, fkey } = L, f = pool.format, P = pool.players, ctx = evalContext(dir, hub);
  let F = loadField(dir); if (!F) { buildField(dir, { n: 1000 }); F = loadField(dir); }
  // all-sources field: each source is simulated against the field its own ownership built; the pool to grade is the union
  const field = F.field, N = F.all ? F.N : field.length, fieldOf = s => (F.all && F.by[s] && F.by[s].field) || field;
  const fromOf = new Map(); if (F.all) for (const r of F.rows) fromOf.set(sigOf(r.ids, f), r.from);
  const byName = new Map(); P.forEach((p, i) => { if (!byName.has(nrm(p.name))) byName.set(nrm(p.name), i); });
  const byId = new Map(); hub.rows.forEach(x => { if (x.stk?.dkId) byId.set(x.stk.dkId, x); if (x.stk?.cptDkId) byId.set(x.stk.cptDkId, x); });
  let lus, source;
  if (cfg.useField) { lus = field.slice(0, Math.min(field.length, +cfg.max || 3000)); source = `generated pool (${lus.length}${lus.length < field.length ? ` of ${field.length}` : ""})`; }
  else if (cfg.lineups && cfg.lineups.length) {
    const bad = [];
    lus = cfg.lineups.map(row => row.map(s => { const id = (String(s).match(/\((\d+)\)/) || [])[1], name = String(s).replace(/\s*\(\d+\)\s*$/, "").trim(); const h = id && byId.get(id); const idx = h ? byName.get(nrm(h.name)) : byName.get(nrm(name)); if (idx == null) bad.push(name); return idx; })).filter(lu => lu.length === f.slots.length && lu.every(i => i != null));
    if (!lus.length) throw new Error("no uploaded lineup matched this slate's players" + (bad.length ? ": " + [...new Set(bad)].slice(0, 6).join(", ") : ""));
    source = `uploaded (${lus.length}${bad.length ? `, ${new Set(bad).size} names unmatched` : ""})`;
  } else {
    const b = cfg.build || {}, gp = fieldPool(L, { ownSrc: F.cfg.ownSrc === "all" ? "auto" : F.cfg.ownSrc, projSrc: b.src || "lab", contest: F.cfg.contest });
    const ids = txt => String(txt || "").split(/[,\n;]+/).map(s => nrm(s.trim())).filter(Boolean).map(k => byName.get(k)).filter(i => i != null);
    const r = buildLineups(gp, { n: Math.max(1, Math.min(300, +b.n || 20)), obj: b.obj || "blend", rand: Math.max(0, +(b.rand ?? 18)) / 100, maxExp: Math.max(5, +b.maxExp || 60), minSal: +b.minSal || 0, minUniq: Math.max(0, +(b.minUniq ?? 1)), stackSize: 0, force: ids(b.force), exclude: ids(b.exclude) }, mulberry32(+b.seed || 1));
    if (r.err) throw new Error(r.err); if (!r.lineups.length) throw new Error("the builder produced no lineups");
    lus = r.lineups; source = `built (${lus.length})`;
  }
  // payouts: the picked contest's prize pool and first place (from the lobby and its name), scaled to the pool when the
  // pool is smaller than the contest; with no contest, a pool-sized contest at 15% rake, percent to first, 20% paid
  const LB = lobby(), cid = cfg.cid || (F.cfg.contest && F.cfg.contest.cid) || null, c0 = cid ? LB.get(String(cid)) : null, c = c0 && c0.fee > 0 && c0.field > 0 && c0.field < 1e6 ? c0 : null, fee = c ? c.fee : (+cfg.fee || 20);
  let pct = Math.max(1, Math.min(60, +cfg.pct || 20)), pay;
  if (c && c.prizePool && c.field) {
    const s = N / c.field, prize = c.prizePool / c.fee * s, top = prizesFromName(c.name).top;
    if (top && !cfg.pct) pct = +(100 * top / c.prizePool).toFixed(1);
    pay = fitPayouts(N, prize, prize * pct / 100, 22);
  } else { const prize = N * (1 - 0.15); pay = fitPayouts(N, prize, prize * pct / 100, 20); }
  const paidN = paidCount(pay);
  const sized = c ? { contestN: c.field, poolN: N, match: Math.abs(N - Math.min(c.field, MAX_POOL)) <= Math.max(25, 0.02 * c.field) } : null;
  const iters = Math.max(500, Math.min(20000, +cfg.iters || 3000));
  const per = {}, pROI = {};
  for (const s of srcs) {
    const players = P.map(p => { const r = hubBy.get(keyOf(p.name, p.pos, p.team)); return Object.assign({}, p, { proj: Math.max(0, projOf(r, s, p.proj) ?? 0) }); });
    const ps = Object.assign({}, pool, { players }), model = buildModel(ps, {});
    // each graded lineup is entered alone against this source's whole contest field (N entries), the way a single-lineup sim
    // works; fixed 2026-10-03: grading more lineups than the contest holds (3,000 vs an 833-entry Spy) had ranked them all
    // against each other on an 833-entry payout table, so only 6% cashed and the mean ROI read -75%
    const res = simulate({ pool: ps, model, field: fieldOf(s), lineups: lus, payouts: pay, entries: N, fee: 1, iters, maxIters: iters * 2, rng: mulberry32(17 + (+cfg.seed || 0)), solo: true });
    per[s] = res.rows.map(r => ({ roi: +r.roi.toFixed(1), se: +r.se.toFixed(1), win: +r.win.toFixed(3), t1: +r.t1.toFixed(2), t10: +r.t10.toFixed(1), cash: +r.cash.toFixed(1), dupN: r.dupN, proj: +r.proj.toFixed(1) }));
    pROI[s] = playerROI(res, players, f);
  }
  // "Wins when": the game scripts each lineup wins in, explanation only (ranking is untouched). One extra pass on the
  // heaviest-weighted source with kept per-draw finishes, capped at 2,000 draws so 3,000 lineups stay ~30 MB
  const wins = cfg.scripts === false ? null : (() => { try {
    const Wt = sourceWeights(srcs), s0 = srcs.slice().sort((a, b) => Wt[b] - Wt[a])[0], n2 = Math.min(2000, iters);
    const players = P.map(p => { const r = hubBy.get(keyOf(p.name, p.pos, p.team)); return Object.assign({}, p, { proj: Math.max(0, projOf(r, s0, p.proj) ?? 0) }); });
    const ps = Object.assign({}, pool, { players }), sc = scriptCollector(ps, n2);
    const res = simulate({ pool: ps, model: buildModel(ps, {}), field: fieldOf(s0), lineups: lus, payouts: pay, entries: N, fee: 1, iters: n2, maxIters: n2, rng: mulberry32(29 + (+cfg.seed || 0)), solo: true, keep: true, onIter: sc.onIter, calibrate: false });
    const lab = sc.finish();
    return lus.map((lu, k) => lineupScripts(k, lu, ps, res.kept, lab).scripts.slice(0, 2).map(x => ({ name: x.name, share: x.share, lift: x.lift })));
  } catch (e) { return null; } })();
  // Lab ROI: the sources' ROIs weighted by scorecard accuracy (1/MAE^2 over all positions); a source the scorecard has not graded gets half the lightest weight
  const W = sourceWeights(srcs);
  // the generated field's exposure to each player, for OwnSum "as the contest we generated plays it"
  const expOf = new Map((F.players || []).map(p => [nrm(p.name) + "|" + p.team, p.exp]));
  const rows = lus.map((lu, k) => {
    const pl = lu.map((idx, j) => playerFrom(hubBy.get(keyOf(P[idx].name, P[idx].pos, P[idx].team)), f.slots[j], sd && j === 0));
    const e = evaluateLineup(pl, fee, N, ctx); e.n = k; e.type = stackLabel(lu, P, f); if (F.all) e.from = fromOf.get(sigOf(lu, f)) || [];
    const by = {}; for (const s of srcs) by[s] = per[s][k];
    const rois = srcs.map(s => by[s].roi), ws = srcs.reduce((t, s) => t + W[s], 0);
    e.sim = Object.assign(by, { sources: srcs, lab: +(srcs.reduce((t, s) => t + W[s] * by[s].roi, 0) / ws).toFixed(1), mean: +mean(rois).toFixed(1), worst: Math.min(...rois), best: Math.max(...rois), agree: rois.filter(x => x > 0).length, se: +mean(srcs.map(s => by[s].se)).toFixed(1), win: +mean(srcs.map(s => by[s].win)).toFixed(3), t1: +mean(srcs.map(s => by[s].t1)).toFixed(2), t10: +mean(srcs.map(s => by[s].t10)).toFixed(1), cash: +mean(srcs.map(s => by[s].cash)).toFixed(1), dupN: F.all ? +mean(srcs.map(s => by[s].dupN)).toFixed(1) : by[srcs[0]].dupN, proj: +mean(srcs.map(s => by[s].proj)).toFixed(1) });
    e.fieldOwn = +lu.reduce((t, idx) => t + (expOf.get(nrm(P[idx].name) + "|" + P[idx].team) ?? 0), 0).toFixed(1);
    const deltas = lu.map(idx => hubBy.get(keyOf(P[idx].name, P[idx].pos, P[idx].team))?.ownDelta).filter(v => v != null);
    e.fieldDelta = sd || !deltas.length ? null : +deltas.reduce((a, b) => a + b, 0).toFixed(1);
    e.notes = matchNotes(pl, ctx.guide, sd); e.theses = e.notes.theses;
    const ck = e.checks.find(x => x.id === "sim_top_half"); if (ck) { ck.pass = null; ck.detail = "pre-contest sim: " + srcs.map(s => `${s} ${by[s].roi}%`).join(", "); }
    if (wins) e.wins = wins[k];
    verdictOf(e); return e;
  });
  for (const s of srcs) { const order = rows.map((e, i) => i).sort((a, b) => rows[b].sim[s].roi - rows[a].sim[s].roi); order.forEach((i, r) => { rows[i].sim[s].rank = r + 1; }); }
  rows.sort((a, b) => b.sim.lab - a.sim.lab);
  // player ROI merged across sources
  const pm = {}; for (const s of srcs) for (const r of pROI[s]) { const x = pm[r.id] = pm[r.id] || { name: r.name, team: r.team, pos: r.pos, opp: P[r.id].opp, sal: P[r.id].sal, n: r.n, exp: +r.exp.toFixed(1), own: P[r.id].own, cpt: r.cpt, by: {} }; x.by[s] = +r.roi.toFixed(1); }
  const players = Object.values(pm).map(x => Object.assign(x, { roi: +mean(srcs.map(s => x.by[s] ?? 0)).toFixed(1) })).sort((a, b) => b.roi - a.roi);
  const out = { dir, at: new Date().toISOString(), ms: Date.now() - t0, source, format: fkey, sources: srcs, weights: Object.fromEntries(srcs.map(s => [s, +(W[s] / srcs.reduce((t, x) => t + W[x], 0)).toFixed(3)])), guide: !!ctx.guide, field: { N, at: F.at, arch: F.cfg.arch, ownSrc: F.cfg.ownSrc, all: !!F.all }, contest: { cid: c ? c.id : null, name: c ? c.name : "", fee, pct, paidN, first: +(pay[0]).toFixed(1), field: c ? c.field : null, prizePool: c ? c.prizePool : null }, sized, iters, rows, players, summary: { n: rows.length, allPositive: rows.filter(e => e.sim.worst > 0).length, ok: rows.filter(e => e.verdict === "ok").length, fail: rows.filter(e => e.verdict === "FAIL").length } };
  fs.writeFileSync(path.join("data", dir, "simrun.json"), JSON.stringify(out));
  return out;
}
