// Four-source sim: every imported entry is simulated against a generated field four times, once per
// projection source (Stokastic, ETR, Blick with their own ownership for the field; Pinnacle market
// with the vendors' average ownership, since the market has none). Each entry gets ROI per source,
// the worst of them, how many sources agree it is positive, and its percentile among field lineups
// under the same sim (the pre-lock equivalent of "Stokastic sim rank"), which fills the sim_top_half
// rule. The contest is scaled down to at most FIELD_N entries with the payout curve scaled with it.
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
import { loadEntries } from "./entries.mjs";

const FIELD_N = 4000, SAMPLE = 300, ITERS = 2500;
const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
const keyOf = (name, pos, team) => (isDst(pos) ? "dst" : nrm(name)) + "|" + team;
const avg = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
function prizesFromName(name) {
  const s = String(name || ""), money = t => { const m = String(t).match(/([\d.]+)\s*([KM]?)/i); return m ? +m[1] * (m[2].toUpperCase() === "K" ? 1e3 : m[2].toUpperCase() === "M" ? 1e6 : 1) : null; };
  const top = (s.match(/\$\s*([\d.]+\s*[KM]?)\s*to\s*1st/i) || [])[1], all = (s.match(/\$\s*([\d.]+\s*[KM]?)/i) || [])[1];
  return { total: all ? money(all) : null, top: top ? money(top) : null };
}
function lobby() { const f = "data/dk-lobby/nfl.json"; if (!fs.existsSync(f)) return new Map(); const j = JSON.parse(fs.readFileSync(f, "utf8")); return new Map((j.contests || []).map(c => [String(c.id), c])); }

export function fourSourceSim(dir, opts = {}) {
  const t0 = Date.now(), hub = hubData(dir), sd = hub.slate.type === "SHOWDOWN", fkey = sd ? "nfl_sd" : "nfl_cl";
  const E = loadEntries(dir), good = E.entries.filter(e => e.ok); if (!good.length) throw new Error("no matched entries to simulate");
  const hubF = fs.readdirSync(path.join("data", dir)).find(f => /_Data_Hub_Projections\.csv$/i.test(f)); if (!hubF) throw new Error("no Stokastic file in " + dir);
  const all = parseCSV(fs.readFileSync(path.join("data", dir, hubF), "utf8")), headers = all[0].map(s => String(s).trim());
  const pool = buildPool(headers, all.slice(1), fkey, autoMap(headers)), P = pool.players;
  const byKey = new Map(); P.forEach((p, i) => { const k = keyOf(p.name, p.pos, p.team); if (!byKey.has(k)) byKey.set(k, i); });
  const hubBy = new Map(hub.rows.map(r => [keyOf(r.name, r.pos, r.team), r]));
  const vendors = ["stk", "etr", "blick"].filter(s => hub.sources[s === "stk" ? "stokastic" : s] && !(s === "blick" && hub.sources.blick.stale));
  const srcs = vendors.slice(); if (hub.sources.market) srcs.push("mkt");
  const ownOf = (r, s) => { if (!r) return null; if (s === "mkt") return avg(vendors.map(v => r[v]?.own)); return r[s]?.own ?? r.stk?.own ?? null; };
  const cptOf = (r, s) => { if (!r) return null; if (s === "mkt") return avg(vendors.map(v => r[v]?.cptOwn)); return r[s]?.cptOwn ?? r.stk?.cptOwn ?? null; };
  const projOf = (r, s, base) => !r || s === "stk" ? base : (r[s]?.proj ?? base);
  // entries -> pool indices (slot order is DK's, captain first in showdown)
  for (const e of good) { e._lu = e.players.map(p => byKey.get(keyOf(p.name, p.pos, p.team))); e._bad = e._lu.some(i => i == null); }
  const L = lobby(), groups = {}; for (const e of good) if (!e._bad) (groups[e.cid] = groups[e.cid] || []).push(e);
  const meta = { at: new Date().toISOString(), sources: srcs, contests: [], fieldN: FIELD_N, iters: ITERS };
  for (const [cid, es] of Object.entries(groups)) {
    const c = L.get(String(cid)), fee = es[0].fee || 1, N = c?.field || es[0].contestN || 10000, pr = prizesFromName(es[0].contest);
    const prize = (c?.prizePool || pr.total || N * fee * 0.85) / fee, first = (pr.top || prize * fee * 0.1) / fee;
    const fieldN = Math.min(N, opts.fieldN || FIELD_N), scale = fieldN / N, pay = fitPayouts(fieldN, prize * scale, Math.max(first * scale, prize * scale * 0.05), 20);
    const lus = es.map(e => e._lu), per = {};
    for (const s of srcs) {
      // locked (late swap): players whose game has started score their live points, no variance
      const locked = opts.locked || null;
      const players = P.map(p => { const k = keyOf(p.name, p.pos, p.team), r = hubBy.get(k); const own = ownOf(r, s) ?? p.own, cown = cptOf(r, s) ?? Math.max(0.1, own / 6); const q = Object.assign({}, p, { proj: Math.max(0, projOf(r, s, p.proj) ?? 0), own, cown, fown: own }); if (locked && locked[k] != null) { q.proj = locked[k]; q.sd = 0.01; q.ceil = null; } return q; });
      const ps = Object.assign({}, pool, { players }), model = buildModel(ps, {});
      const opt = Object.assign({ conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3, nflStacks: { 1: 45, 2: 25, 3: 5, bring: 25 } }, fieldProfile(fee, fkey, N) || {});
      const gen = genField(ps, fieldN, opt, mulberry32(7)).field;
      const rng = mulberry32(13), sample = []; for (let i = 0; i < Math.min(SAMPLE, gen.length); i++) sample.push(gen[Math.floor(rng() * gen.length)]);
      const res = simulate({ pool: ps, model, field: gen, lineups: lus.concat(sample), payouts: pay, entries: fieldN, fee: 1, iters: ITERS, maxIters: ITERS * 2, rng: mulberry32(17), fieldMode: false });
      const fieldRoi = res.rows.slice(lus.length).map(r => r.roi).sort((a, b) => a - b);
      per[s] = es.map((e, k) => { const r = res.rows[k]; let lo = 0; while (lo < fieldRoi.length && fieldRoi[lo] < r.roi) lo++; return { roi: +r.roi.toFixed(1), se: +r.se.toFixed(1), t10: +r.t10.toFixed(1), cash: +r.cash.toFixed(1), dupN: r.dupN, pct: +(lo / fieldRoi.length).toFixed(2), proj: +r.proj.toFixed(1) }; });
    }
    es.forEach((e, k) => {
      const by = {}; for (const s of srcs) by[s] = per[s][k];
      const rois = srcs.map(s => by[s].roi), pcts = srcs.map(s => by[s].pct).sort((a, b) => a - b);
      e.sim = Object.assign(by, { sources: srcs, worst: Math.min(...rois), best: Math.max(...rois), mean: +avg(rois).toFixed(1), agree: rois.filter(r => r > 0).length, pctMed: pcts[Math.floor(pcts.length / 2)], N, fieldN, at: meta.at });
      const top = !sd && fee >= 300 && e.sim.pctMed >= 0.9;
      const ck = e.checks.find(c => c.id === "sim_top_half"); if (ck) { ck.pass = top ? false : e.sim.pctMed >= 0.5; ck.detail = srcs.map(s => `${s} ${(100 * by[s].pct).toFixed(0)}th`).join(", ") + (top ? " - top decile in a $300+ classic is where the field sits" : ""); }
      const fails = e.checks.filter(c => c.pass === false); e.verdict = fails.some(c => c.hard) ? "FAIL" : fails.length ? "warn" : "ok"; e.broken = fails.map(c => c.id);
    });
    meta.contests.push({ cid, name: es[0].contest, N, fieldN, fee, entries: es.length });
  }
  for (const e of good) { if (e._bad) e.simError = "player not in the Stokastic pool: " + e.players.filter((p, i) => e._lu[i] == null).map(p => p.name).join(", "); delete e._lu; delete e._bad; }
  meta.ms = Date.now() - t0; E.sim = meta;
  if (E.summary) { E.summary.ok = good.filter(e => e.verdict === "ok").length; E.summary.warn = good.filter(e => e.verdict === "warn").length; E.summary.fail = good.filter(e => e.verdict === "FAIL").length; E.summary.simPositive = good.filter(e => e.sim && e.sim.worst > 0).length; }
  if (!opts.noSave) fs.writeFileSync(path.join("data", dir, "entries.json"), JSON.stringify(E, null, 1));   // late swap runs are not the pre-lock record
  return E;
}
