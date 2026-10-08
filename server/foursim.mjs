// Four-source sim: lineups are simulated against a generated field once per projection source
// (Stokastic, ETR, Blick with their own ownership for the field; Pinnacle market with the vendors'
// average ownership, since the market has none). Each lineup gets ROI/se/top-10%/cash per source
// and its percentile among field lineups under the same sim (the pre-lock equivalent of
// "Stokastic sim rank"). The contest is scaled down to at most FIELD_N entries with the payout
// curve scaled with it. simLineups() is the core; fourSourceSim() runs it on the imported entries.
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { buildPool, autoMap } from "../src/engine/formats.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { genField, fieldProfile } from "../src/engine/field.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { hubData } from "./sources.mjs";
import { loadEntries, lobby } from "./entries.mjs";

const FIELD_N = 4000, SAMPLE = 300, ITERS = 2500;
const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
export const keyOf = (name, pos, team) => (isDst(pos) ? "dst" : nrm(name)) + "|" + team;
const avg = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
export function prizesFromName(name) {
  const s = String(name || ""), money = t => { const m = String(t).match(/([\d.]+)\s*([KM]?)/i); return m ? +m[1] * (m[2].toUpperCase() === "K" ? 1e3 : m[2].toUpperCase() === "M" ? 1e6 : 1) : null; };
  const top = (s.match(/\$\s*([\d.]+\s*[KM]?)\s*to\s*1st/i) || [])[1], all = (s.match(/\$\s*([\d.]+\s*[KM]?)/i) || [])[1];
  return { total: all ? money(all) : null, top: top ? money(top) : null };
}
// the slate's engine pool (from the Stokastic file) plus the merged hub, keyed the same way
export function loadPool(dir) {
  const hub = hubData(dir), sd = hub.slate.type === "SHOWDOWN", fkey = sd ? "nfl_sd" : "nfl_cl";
  const hubF = fs.readdirSync(path.join("data", dir)).find(f => /_Data_Hub_Projections\.csv$/i.test(f)); if (!hubF) throw new Error("no Stokastic file in " + dir);
  const all = parseCSV(fs.readFileSync(path.join("data", dir, hubF), "utf8")), headers = all[0].map(s => String(s).trim());
  const pool = buildPool(headers, all.slice(1), fkey, autoMap(headers)), P = pool.players;
  const byKey = new Map(); P.forEach((p, i) => { const k = keyOf(p.name, p.pos, p.team); if (!byKey.has(k)) byKey.set(k, i); });
  const hubBy = new Map(hub.rows.map(r => [keyOf(r.name, r.pos, r.team), r]));
  const vendors = ["stk", "etr", "blick"].filter(s => hub.sources[s === "stk" ? "stokastic" : s] && !(s === "blick" && hub.sources.blick.stale));
  const srcs = vendors.slice(); if (hub.sources.market) srcs.push("mkt");
  shrinkDst(P, hub.rows);
  return { hub, pool, byKey, hubBy, vendors, srcs, sd, fkey };
}
// DST projections pulled halfway to the slate's DST average, per source (Sunday review 2026-10-04,
// data/reports/review-2026-10-04-sources.json: every source's DST projection correlated negatively with actual).
// One slate, so a modest shrink rather than dropping the spread; sigma stays at the graded 0.85.
const DST_SHRINK = 0.5;
function shrinkDst(P, rows) {
  const pull = (list, get, set) => { const v = list.map(get).filter(x => x != null && !isNaN(x)); if (v.length < 2) return; const m = v.reduce((a, b) => a + b, 0) / v.length; for (const o of list) { const x = get(o); if (x != null && !isNaN(x)) set(o, +(m + DST_SHRINK * (x - m)).toFixed(2)); } };
  pull(P.filter(p => isDst(p.pos)), p => p.proj, (p, x) => { p.proj = x; });
  const D = rows.filter(r => isDst(r.pos));
  for (const k of ["stk", "etr", "blick", "mkt"]) pull(D.filter(r => r[k]), r => r[k].proj, (r, x) => { r[k] = Object.assign({}, r[k], { proj: x }); });
  for (const k of ["lab", "cons"]) pull(D, r => r[k], (r, x) => { r[k] = x; });
}
// "vavg": the vendors' average without Stokastic (classic; falls back to Stokastic alone); "blickHS": Blick's
// high-stakes ownership, then its single-entry number, then vavg (see ownTier in server/contestsim.mjs)
const vavgOf = (r, vendors, k) => { const v = vendors.filter(s => s !== "stk"); return (v.length ? avg(v.map(s => r[s]?.[k])) : null) ?? r.stk?.[k] ?? null; };
export const ownOf = (r, s, vendors) => { if (!r) return null; if (s === "mkt" || s === "avg") return avg(vendors.map(v => r[v]?.own)); if (s === "vavg") return vavgOf(r, vendors, "own"); if (s === "blickHS") return r.blick?.ownHS ?? r.blick?.ownSE ?? vavgOf(r, vendors, "own"); return r[s]?.own ?? r.stk?.own ?? null; };
export const cptOf = (r, s, vendors) => { if (!r) return null; if (s === "mkt" || s === "avg") return avg(vendors.map(v => r[v]?.cptOwn)); if (s === "vavg" || s === "blickHS") return vavgOf(r, vendors, "cptOwn"); return r[s]?.cptOwn ?? r.stk?.cptOwn ?? null; };
// the ownership a per-source field is built on: classic drops Stokastic's (worst classic ownership in the 2026-10-04
// review) for Stokastic's and the market's fields; showdown keeps every source's own (Stokastic best on FLEX there)
export const fieldOwnSrc = (s, sd) => sd ? (s === "mkt" ? "avg" : s) : (s === "stk" || s === "mkt" ? "vavg" : s);
export const projOf = (r, s, base) => !r ? base : s === "stk" ? base : s === "lab" ? (r.lab ?? base) : s === "cons" ? (r.cons ?? base) : (r[s]?.proj ?? base);

// lus: arrays of pool indices (captain first in showdown). Returns { sources, per: {src: rows[]}, fieldN, N, fee }
export function simLineups(L, lus, opts = {}) {
  const { pool, hubBy, vendors, srcs, fkey } = L, P = pool.players;
  const fee = opts.fee || 20, N = opts.N || 10000, name = opts.contestName || "", pr = prizesFromName(name);
  const prize = (opts.prizePool || pr.total || N * fee * 0.85) / fee, first = (pr.top || prize * fee * 0.1) / fee;
  const fieldN = Math.min(N, opts.fieldN || FIELD_N), scale = fieldN / N, pay = fitPayouts(fieldN, prize * scale, Math.max(first * scale, prize * scale * 0.05), 20);
  const locked = opts.locked || null, per = {};
  for (const s of srcs) {
    const players = P.map(p => { const k = keyOf(p.name, p.pos, p.team), r = hubBy.get(k); const os = fieldOwnSrc(s, L.sd), own = ownOf(r, os, vendors) ?? p.own, cown = cptOf(r, os, vendors) ?? Math.max(0.1, own / 6); const q = Object.assign({}, p, { proj: Math.max(0, projOf(r, s, p.proj) ?? 0), own, cown, fown: own }); if (locked && locked[k] != null) { q.proj = locked[k]; q.sd = 0.01; q.ceil = null; } return q; });
    const ps = Object.assign({}, pool, { players }), model = buildModel(ps, {});
    // fitted presets (see server/contestsim.mjs): showdown leaves salary, classic stacks QB+2 far more than the old default
    const opt = Object.assign(fkey === "nfl_sd" ? { conc: 1.0, minSal: 44000, boost: 1.0, rounds: 3 } : { conc: 1.25, minSal: 48000, boost: 1.0, rounds: 3, nflStacks: { 1: 45, 2: 41, 3: 5, bring: 62 }, skill: [[0.15, 60], [0.35, 5]], dupeFloor: "auto" }, fieldProfile(fee, fkey, N) || {});
    const gen = genField(ps, fieldN, opt, mulberry32(7)).field;
    const rng = mulberry32(13), sample = []; for (let i = 0; i < Math.min(SAMPLE, gen.length); i++) sample.push(gen[Math.floor(rng() * gen.length)]);
    const res = simulate({ pool: ps, model, field: gen, lineups: lus.concat(sample), payouts: pay, entries: fieldN, fee: 1, iters: opts.iters || ITERS, maxIters: (opts.iters || ITERS) * 2, rng: mulberry32(17), fieldMode: false });
    const fieldRoi = res.rows.slice(lus.length).map(r => r.roi).sort((a, b) => a - b);
    per[s] = lus.map((lu, k) => { const r = res.rows[k]; let lo = 0; while (lo < fieldRoi.length && fieldRoi[lo] < r.roi) lo++; return { roi: +r.roi.toFixed(1), se: +r.se.toFixed(1), win: +r.win.toFixed(3), t1: +r.t1.toFixed(2), t10: +r.t10.toFixed(1), cash: +r.cash.toFixed(1), dupN: r.dupN, pct: +(lo / fieldRoi.length).toFixed(2), proj: +r.proj.toFixed(1) }; });
  }
  return { sources: srcs, per, fieldN, N, fee };
}
// per-lineup summary across sources + the sim_top_half check
export function attachSim(e, sim, k, fee, sd) {
  const by = {}; for (const s of sim.sources) by[s] = sim.per[s][k];
  const rois = sim.sources.map(s => by[s].roi), pcts = sim.sources.map(s => by[s].pct).sort((a, b) => a - b);
  e.sim = Object.assign(by, { sources: sim.sources, worst: Math.min(...rois), best: Math.max(...rois), mean: +avg(rois).toFixed(1), agree: rois.filter(r => r > 0).length, pctMed: pcts[Math.floor(pcts.length / 2)], N: sim.N, fieldN: sim.fieldN, at: new Date().toISOString() });
  const top = !sd && fee >= 300 && e.sim.pctMed >= 0.9, ck = (e.checks || []).find(c => c.id === "sim_top_half");
  if (ck) { ck.pass = top ? false : e.sim.pctMed >= 0.5; ck.detail = sim.sources.map(s => `${s} ${(100 * by[s].pct).toFixed(0)}th`).join(", ") + (top ? " - top decile in a $300+ classic is where the field sits" : ""); }
  return e;
}
const reverdict = e => { const fails = e.checks.filter(c => c.pass === false && (c.source || "lab") === "lab"); e.verdict = fails.some(c => c.hard) ? "FAIL" : fails.length ? "warn" : "ok"; e.broken = fails.map(c => c.id); };

export function fourSourceSim(dir, opts = {}) {
  const t0 = Date.now(), L = loadPool(dir), { byKey, sd, srcs } = L;
  const E = loadEntries(dir), good = E.entries.filter(e => e.ok); if (!good.length) throw new Error("no matched entries to simulate");
  for (const e of good) { e._lu = e.players.map(p => byKey.get(keyOf(p.name, p.pos, p.team))); e._bad = e._lu.some(i => i == null); }
  const LB = lobby(), groups = {}; for (const e of good) if (!e._bad) (groups[e.cid] = groups[e.cid] || []).push(e);
  const meta = { at: new Date().toISOString(), sources: srcs, contests: [], fieldN: FIELD_N, iters: ITERS };
  for (const [cid, es] of Object.entries(groups)) {
    const c = LB.get(String(cid)), fee = es[0].fee || 1, N = c?.field || es[0].contestN || 10000;
    const sim = simLineups(L, es.map(e => e._lu), { fee, N, contestName: es[0].contest, prizePool: c?.prizePool, locked: opts.locked });
    es.forEach((e, k) => { attachSim(e, sim, k, fee, sd); reverdict(e); });
    meta.contests.push({ cid, name: es[0].contest, N, fieldN: sim.fieldN, fee, entries: es.length });
  }
  for (const e of good) { if (e._bad) e.simError = "player not in the Stokastic pool: " + e.players.filter((p, i) => e._lu[i] == null).map(p => p.name).join(", "); delete e._lu; delete e._bad; }
  meta.ms = Date.now() - t0; E.sim = meta;
  if (E.summary) { E.summary.ok = good.filter(e => e.verdict === "ok").length; E.summary.warn = good.filter(e => e.verdict === "warn").length; E.summary.fail = good.filter(e => e.verdict === "FAIL").length; E.summary.simPositive = good.filter(e => e.sim && e.sim.worst > 0).length; }
  if (!opts.noSave) fs.writeFileSync(path.join("data", dir, "entries.json"), JSON.stringify(E, null, 1));   // late swap runs are not the pre-lock record
  return E;
}
