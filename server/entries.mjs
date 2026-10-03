// Entry Manager engine: a DraftKings entries export (or Stokastic's Entry Manager export) checked
// against the slate's merged Data Hub and the NFL rulebook (rules/nfl_cl.json, rules/nfl_sd.json)
// before lock. Every entry gets its construction, the rules it breaks (ours grade; ETR's evergreen
// guidelines and the per-slate guide are shown), a calibrated duplication estimate
// (data/reports/dup-fit-nfl.json) and a review tag; all of it is saved in data/<slate>/entries.json.
// evaluateLineup() is shared with the generator (server/gensim.mjs).
import fs from "node:fs";
import path from "node:path";
import { FORMATS } from "../src/engine/formats.mjs";
import { parseEntries } from "../src/engine/audit.mjs";
import { nrm } from "../src/engine/csv.mjs";
import { hubData } from "./sources.mjs";

const readJ = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
const file = dir => path.join("data", dir, "entries.json");
export const loadEntries = dir => readJ(file(dir)) || { dir, entries: [], importedAt: null };
// slate guide: ETR's breakdown + sim analysis (+ Blick notes) for this specific slate, written per
// slate as data/<slate>/slate-guide.json (see memory "slate-guide"); drives the "Slate" check group
export const loadGuide = dir => readJ(path.join("data", dir, "slate-guide.json"));
const nm = s => nrm(String(s || ""));
const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
const CATCH = /^(WR|TE|RB)$/;

export function lobby() {
  const j = readJ("data/dk-lobby/nfl.json"); if (!j) return new Map();
  const a = Array.isArray(j) ? j : (j.contests || j.rows || []); return new Map(a.map(c => [String(c.id), c]));
}
function dupModel() { const j = readJ("data/reports/dup-fit-nfl.json"); return j ? j.formats : null; }
function dupEstimate(model, key, fee, N, owns) {
  if (!model || !model[key] || !N || owns.some(o => !(o > 0))) return { pred: null, pDup: null, meanDup: null, N: N || null };
  const tier = fee < 100 ? "lo" : fee < 300 ? "mid" : "hi", t = model[key][tier] || model[key].all, pred = N * owns.reduce((s, o) => s * o / 100, 1), x = Math.log10(Math.max(1e-9, pred));
  let b = t.buckets.find(b => x >= b.lo && x < b.hi); if (!b) b = x < t.buckets[0].lo ? t.buckets[0] : t.buckets[t.buckets.length - 1];
  return { pred: +pred.toFixed(2), pDup: b.pDup, meanDup: b.meanDup, N, tier };
}
// a hub row -> the player record a lineup carries (captain = 1.5x salary and projection, captain ownership)
export function playerFrom(r, slot, isCpt) {
  return { slot, name: r.name, pos: r.pos.split("/")[0], team: r.team, opp: r.opp, sal: isCpt ? Math.round((r.sal || 0) * 1.5) : r.sal, own: isCpt ? (r.stk?.cptOwn ?? null) : (r.own ?? null), fown: isCpt ? (r.labCptOwn ?? r.stk?.cptOwn ?? null) : (r.labOwn ?? r.own ?? null), proj: isCpt ? (r.cons != null ? +(1.5 * r.cons).toFixed(2) : null) : r.cons, lab: isCpt ? (r.lab != null ? +(1.5 * r.lab).toFixed(2) : null) : r.lab, stk: r.stk?.proj ?? null, inj: r.inj ? r.inj.status : (r.stk?.inj || ""), isCpt: !!isCpt, dkId: isCpt ? (r.stk?.cptDkId || "") : (r.stk?.dkId || "") };
}
// shared context for a slate: format, rulebook, dup model, guide
export function evalContext(dir, hub) {
  const sd = hub.slate.type === "SHOWDOWN", fkey = sd ? "nfl_sd" : "nfl_cl", rules = readJ(`rules/${fkey}.json`);
  return { sd, fkey, f: FORMATS[fkey], rules, ruleBy: Object.fromEntries((rules?.rules || []).map(r => [r.id, r])), model: dupModel(), guide: loadGuide(dir) };
}
// construction + every check for one lineup (players in slot order, captain first in showdown)
export function evaluateLineup(players, fee, N, ctx) {
  const { sd, f, ruleBy, model, guide } = ctx;
  const sal = players.reduce((s, p) => s + (p.sal || 0), 0), left = f.cap - sal, own = players.reduce((s, p) => s + (p.own || 0), 0), cons = players.reduce((s, p) => s + (p.proj || 0), 0), lab = players.reduce((s, p) => s + (p.lab ?? p.proj ?? 0), 0);
  // chalk and ownership-sum rules were fit on actual ownership, so they read Model own (fown) when the slate has it
  const fo = p => p.fown ?? p.own ?? 0, qb = players.find(p => p.pos === "QB"), dst = players.find(p => isDst(p.pos)), chalk = players.filter(p => fo(p) >= 20).length, fown = players.reduce((s, p) => s + fo(p), 0);
  const stackN = qb ? players.filter(p => p !== qb && p.team === qb.team && CATCH.test(p.pos)).length : 0, bring = qb ? players.some(p => p.team === qb.opp && !isDst(p.pos)) : false;
  const tc = {}; for (const p of players) tc[p.team] = (tc[p.team] || 0) + 1; const split = Object.values(tc).sort((a, b) => b - a).join("-");
  const sig = players.map(p => p.name + (p.isCpt ? "*" : "")).sort().join("|");
  const dup = dupEstimate(model, sd ? "showdown" : "classic", fee, N, players.map(p => p.own));
  const checks = [], add = (id, pass, detail) => { if (ruleBy[id]) checks.push({ id, hard: !!ruleBy[id].hard, pass, detail, rule: ruleBy[id].rule, source: ruleBy[id].source || "lab" }); };
  add("salary_cap", sal <= f.cap, `$${sal.toLocaleString()}`);
  add("no_dst_vs_qb", !(qb && dst && dst.team === qb.opp), dst && qb ? `${dst.name} vs ${qb.name}` : "no QB/DST pair");
  if (!sd) {
    add("qb_stack1", !!qb && stackN >= 1, qb ? `${qb.name} + ${stackN}` : "no QB");
    add("qb_stack2", !!qb && stackN >= 2, qb ? `${qb.name} + ${stackN}` : "no QB");
    add("bring_back", bring, qb ? (bring ? `from ${qb.opp}` : `nothing from ${qb.opp}`) : "no QB");
    add("chalk_low", chalk >= 3, `${chalk} at 20%+`);
    add("chalk4", chalk >= 4, `${chalk} at 20%+`);
    add("salary_left", left < 600, `$${left.toLocaleString()} left`);
    add("no_rb_own_dst", !(dst && players.some(p => p.pos === "RB" && p.team === dst.team)), dst ? `DST ${dst.team}` : "no DST");
    add("own_200", fown >= 200, `own sum ${fown.toFixed(0)}% (model)`);
    add("dup_risk", dup.meanDup == null ? null : dup.meanDup < 1, dup.meanDup == null ? "contest size unknown (pull the lobby)" : `~${dup.meanDup} copies expected, ${(100 * dup.pDup).toFixed(0)}% chance of any (field ${dup.N.toLocaleString()})`);
  } else {
    const cpt = players[0];
    add("has_qb", !!qb, qb ? qb.name : "none");
    add("cpt_not_k_dst", !(cpt.pos === "K" || isDst(cpt.pos)), `CPT ${cpt.name} (${cpt.pos})`);
    add("no_kicker", !players.some(p => p.pos === "K"), players.some(p => p.pos === "K") ? players.find(p => p.pos === "K").name : "none");
    add("split_51", split === "5-1", split);
    add("qb_pass_catcher", !!qb && stackN >= 1, qb ? `${qb.name} + ${stackN}` : "no QB");
    add("has_dst", !!dst, dst ? dst.name : "none");
    add("cpt_own_10", cpt.own == null ? null : cpt.own >= 10, `CPT own ${cpt.own == null ? "?" : cpt.own.toFixed(1) + "%"}`);
    add("cpt_not_te", cpt.pos !== "TE", `CPT ${cpt.pos}`);
    add("own_band", fown < 180 ? true : fown >= 220 ? false : null, `own sum ${fown.toFixed(0)}%`);
    add("salary_left", left >= 1000, `$${left.toLocaleString()} left`);
    add("dup_risk", dup.meanDup == null ? null : dup.meanDup < 2, dup.meanDup == null ? "contest size unknown (pull the lobby)" : `~${dup.meanDup} copies expected, ${(100 * dup.pDup).toFixed(0)}% chance of any (field ${dup.N.toLocaleString()})`);
    // ETR evergreen showdown guidelines (rules/nfl_sd.json, source "etr"): shown in their own group
    const flex = players.slice(1), sameWRTE = p => flex.filter(q => q.team === p.team && /^(WR|TE)$/.test(q.pos)).length, oppWRTE = p => flex.filter(q => q.team !== p.team && /^(WR|TE)$/.test(q.pos)).length;
    const cptQB = players.find(p => p.pos === "QB" && p.team === cpt.team), kd = players.filter(p => p.pos === "K" || isDst(p.pos)).length;
    const heavy = Object.entries(tc).sort((a, b) => b[1] - a[1])[0][0], counts = Object.values(tc).sort((a, b) => b - a);
    if (cpt.pos === "QB") { add("etr_cpt_qb_2pc", sameWRTE(cpt) >= 2, `CPT ${cpt.name} + ${sameWRTE(cpt)} same-team WR/TE`); add("etr_bring_back", oppWRTE(cpt) >= 1, `${oppWRTE(cpt)} opposing WR/TE`); }
    if (cpt.pos === "WR") { add("etr_cpt_wr_max1", sameWRTE(cpt) <= 1, `CPT ${cpt.name} + ${sameWRTE(cpt)} same-team WR/TE`); add("etr_bring_back", oppWRTE(cpt) >= 1, `${oppWRTE(cpt)} opposing WR/TE`); }
    if (cpt.pos === "RB") add("etr_cpt_rb_max2", sameWRTE(cpt) <= 2, `CPT ${cpt.name} + ${sameWRTE(cpt)} same-team WR/TE${cptQB ? ", with his QB" : ", no QB"}`);
    if (cpt.pos === "TE") add("etr_cpt_te_qb", !!cptQB, cptQB ? `with ${cptQB.name}` : "without his QB");
    if (dst) { const mates = players.filter(p => p !== dst && p.team === dst.team).length, opps = players.filter(p => p.team !== dst.team).length; add("etr_dst_teammates", mates >= 3 && opps <= 3, `${dst.name} with ${mates} teammates, ${opps} opponents`); }
    add("etr_max2_kdst", kd <= 2, `${kd} K/DST`);
    if (counts[0] >= 4) add("etr_cpt_heavy_side", cpt.team === heavy, `${split}, CPT from ${cpt.team}${cpt.team === heavy ? " (heavy side)" : " (light side)"}`);
    if (split === "5-1") add("etr_onslaught_qb", players.some(p => p.pos === "QB" && p.team === heavy), players.some(p => p.pos === "QB" && p.team === heavy) ? `${heavy} QB in` : `no ${heavy} QB`);
    add("etr_cpt_salary", (cpt.sal || 0) >= 10500, `CPT $${(cpt.sal || 0).toLocaleString()}`);
    add("etr_k_or_dst", kd >= 1, kd ? `${kd} K/DST in flex` : "six skill players");
    // slate-specific guide: ETR's breakdown and sim analysis (+ Blick notes) for this game
    if (guide) {
      const names = players.map(p => nm(p.name)), has = list => (list || []).filter(x => names.includes(nm(x)));
      const pool = guide.cptPool || [], simCpt = guide.simCpt || {}, simRate = Object.entries(simCpt).find(([k]) => nm(k) === nm(cpt.name)), inPool = pool.some(x => nm(x) === nm(cpt.name));
      checks.push({ id: "slate_cpt", source: "slate", hard: false, pass: inPool || (simRate && simRate[1] >= 5) || null, detail: `CPT ${cpt.name}: ${inPool ? "a captain idea in the guide" : "not a captain idea in the guide"}${simRate ? `, optimal CPT in ${simRate[1]}% of ETR's sims` : ""}`, rule: "captain is one of the guide's captain ideas for this slate, or wins 5%+ of ETR's sims" });
      const lev = has(guide.topPlays?.leverage); checks.push({ id: "slate_leverage", source: "slate", hard: false, pass: lev.length >= 1, detail: lev.length ? "has " + lev.join(", ") : "no leverage play (" + (guide.topPlays?.leverage || []).join(", ") + ")", rule: "carries at least one of the guide's leverage plays for this slate" });
      const fav = guide.construction?.favorite || guide.lines?.favorite, nf = fav ? players.filter(p => p.team === fav).length : null, key = nf == null ? split : `${nf}-${players.length - nf}`;
      if (guide.construction && guide.construction.utilization) { const u = guide.construction.utilization[key]; if (u != null) checks.push({ id: "slate_construction", source: "slate", hard: false, pass: u < 25, detail: `${key} (${fav} first): ETR projects ${u}% of the field there`, rule: "roster construction the field is projected to use under 25% of the time" }); }
      if (guide.structure) { const dogCpt = fav && cpt.team !== fav, pref = (guide.structure.prefer || []).includes(key), av = (guide.structure.avoid || []).includes(key), exc = av && key === "3-3" && dogCpt && /underdog/i.test(guide.structure.exception || ""); checks.push({ id: "slate_structure", source: "slate", hard: false, pass: pref || exc ? true : av ? false : null, detail: `${key}${fav ? " (" + fav + " first)" : ""}: ${pref ? "preferred" : exc ? "allowed (" + guide.structure.exception + ")" : av ? "a losing build so far" : "no read"}`, rule: guide.structure.source || "slate structure read" }); }
      const pr = Object.entries(guide.cptPairs || {}).find(([k]) => nm(k) === nm(cpt.name));
      if (pr) { const hurt = has(pr[1].hurt), boost = has(pr[1].boost); checks.push({ id: "slate_pairings", source: "slate", hard: false, pass: hurt.length ? false : boost.length ? true : null, detail: (boost.length ? "boosted by CPT: " + boost.join(", ") : "none of the sim's boosted flexes") + (hurt.length ? "; hurt by CPT: " + hurt.join(", ") : ""), rule: "flex choices ETR's sims say go with this captain, none they say go against him" }); }
      const st = (guide.stacks || []).find(s => nm(s.cpt) === nm(cpt.name)); if (st) { const w = has(st.with); checks.push({ id: "slate_stack", source: "slate", hard: false, pass: w.length ? true : null, detail: w.length ? `stack idea: with ${w.join(", ")}` : `the guide pairs this CPT with ${st.with.join(", ")}`, rule: "matches one of the guide's stack ideas for this captain" }); }
    }
  }
  add("sim_top_half", null, "needs the four-source sim");
  return { players, sal, left, own: +own.toFixed(1), cons: +cons.toFixed(1), lab: +lab.toFixed(1), chalk, qb: qb ? qb.name : null, stackN, bring, split, teams: Object.keys(tc).length, sig, dup, contestN: N, checks, inj: players.filter(p => p.inj && !/^(Active|)$/i.test(p.inj)).map(p => `${p.name} ${p.inj}`) };
}
export function verdictOf(e) {
  const fails = e.checks.filter(c => c.pass === false && (c.source || "lab") === "lab");
  e.verdict = fails.some(c => c.hard) ? "FAIL" : fails.length ? "warn" : "ok"; e.broken = fails.map(c => c.id);
  e.etrBroken = e.checks.filter(c => c.pass === false && c.source === "etr").map(c => c.id); e.slateBroken = e.checks.filter(c => c.pass === false && c.source === "slate").map(c => c.id);
  return e;
}

export function importEntries(dir, csv, sourceName) {
  const hub = hubData(dir), ctx = evalContext(dir, hub), { sd, fkey, f, rules, ruleBy } = ctx;
  const parsed = parseEntries(csv, f);
  const byDk = new Map(), byCpt = new Map(), byName = new Map();
  for (const r of hub.rows) { if (r.stk?.dkId) byDk.set(r.stk.dkId, r); if (r.stk?.cptDkId) byCpt.set(r.stk.cptDkId, r); const k = isDst(r.pos) ? "dst|" + r.team : nrm(r.name); if (!byName.has(k)) byName.set(k, r); }
  const nick = new Map(); for (const r of hub.rows) if (isDst(r.pos)) nick.set(nrm(r.name), r);
  const resolve = s => { const id = (String(s).match(/\((\d+)\)/) || [])[1], name = String(s).replace(/\s*\(\d+\)\s*$/, "").trim(); let r = null, isCpt = false; if (id) { if (byCpt.has(id)) { r = byCpt.get(id); isCpt = true; } else r = byDk.get(id) || null; } if (!r) r = byName.get(nrm(name)) || nick.get(nrm(name)) || null; return { r, isCpt, name }; };
  const prev = loadEntries(dir), prevById = new Map(prev.entries.map(e => [e.entryId || e.sig, e]));
  const L = lobby(), sigs = {}, entries = [];
  parsed.entries.forEach((e, n) => {
    const fee = +String(e.fee).replace(/[$,]/g, "") || 0, contest = L.get(String(e.cid)) || null, N = contest ? (contest.field || null) : null;
    const slots = e.names.map((s, j) => { const { r, isCpt, name } = resolve(s); return { slot: f.slots[j], raw: name, r, isCpt: sd ? j === 0 || isCpt : false }; });
    const missing = slots.filter(x => !x.r).map(x => x.raw);
    const p0 = prevById.get(e.entryId) || {}, base = { n, entryId: e.entryId, contest: e.contest, cid: e.cid, fee, names: e.names, tag: p0.tag || "", result: p0.result || undefined };
    if (missing.length) { entries.push(Object.assign(base, { ok: false, missing, checks: [] })); return; }
    const ev = evaluateLineup(slots.map(x => playerFrom(x.r, x.slot, x.isCpt)), fee, N, ctx), dupKey = e.contest + "|" + ev.sig; sigs[dupKey] = (sigs[dupKey] || 0) + 1;
    entries.push(Object.assign(base, { ok: true }, ev, { dupKey }));
  });
  for (const e of entries) if (e.ok && ruleBy.no_self_dupe) e.checks.unshift({ id: "no_self_dupe", hard: true, pass: sigs[e.dupKey] === 1, detail: sigs[e.dupKey] > 1 ? `${sigs[e.dupKey]} identical entries in this contest` : "unique in its contest", rule: ruleBy.no_self_dupe.rule, source: "lab" });
  for (const e of entries) if (e.ok) verdictOf(e);
  const good = entries.filter(e => e.ok), cnt = {};
  for (const e of good) for (const p of e.players) { const k = p.name + "|" + p.team; const c = cnt[k] = cnt[k] || { name: p.name, team: p.team, pos: p.pos, n: 0, own: p.own, cpt: 0 }; c.n++; if (p.isCpt) c.cpt++; }
  const exposure = Object.values(cnt).map(c => Object.assign(c, { pct: +(100 * c.n / good.length).toFixed(0), delta: c.own == null ? null : +(100 * c.n / good.length - c.own).toFixed(0) })).sort((a, b) => b.n - a.n || (b.delta ?? 0) - (a.delta ?? 0));
  const summary = { lineups: entries.length, matched: good.length, unmatched: entries.length - good.length, contests: new Set(good.map(e => e.cid)).size, fees: good.reduce((s, e) => s + e.fee, 0), fail: good.filter(e => e.verdict === "FAIL").length, warn: good.filter(e => e.verdict === "warn").length, ok: good.filter(e => e.verdict === "ok").length,
    avgOwn: good.length ? +(good.reduce((s, e) => s + e.own, 0) / good.length).toFixed(0) : null, avgChalk: good.length ? +(good.reduce((s, e) => s + e.chalk, 0) / good.length).toFixed(1) : null, avgLeft: good.length ? Math.round(good.reduce((s, e) => s + e.left, 0) / good.length) : null, dupHigh: good.filter(e => e.dup.meanDup != null && e.dup.meanDup >= (sd ? 2 : 1)).length };
  const out = { dir, format: fkey, importedAt: new Date().toISOString(), source: sourceName || "", rulesDerived: rules?.derived || null, entries, exposure, summary };
  fs.writeFileSync(file(dir), JSON.stringify(out, null, 1));
  return out;
}
export function saveThesis(dir, entryId, thesis) {
  const j = loadEntries(dir), e = j.entries.find(x => String(x.entryId) === String(entryId) || x.sig === entryId); if (!e) throw new Error("entry not found");
  e.thesis = String(thesis || "").slice(0, 600); e.thesisAt = new Date().toISOString();
  fs.writeFileSync(file(dir), JSON.stringify(j, null, 1)); return e;
}
// review tag after the contest: "rule broken" | "rule wrong" | "variance" | ""
export function saveTag(dir, entryId, tag) {
  const j = loadEntries(dir), e = j.entries.find(x => String(x.entryId) === String(entryId) || x.sig === entryId); if (!e) throw new Error("entry not found");
  e.tag = ["rule broken", "rule wrong", "variance", ""].includes(tag) ? tag : ""; e.tagAt = new Date().toISOString();
  fs.writeFileSync(file(dir), JSON.stringify(j, null, 1)); return e;
}
