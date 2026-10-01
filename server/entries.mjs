// Entry Manager engine: a DraftKings entries export (or Stokastic's Entry Manager export) checked
// against the slate's merged Data Hub and the NFL rulebook (rules/nfl_cl.json, rules/nfl_sd.json)
// before lock. Every entry gets its construction, the rules it breaks, a calibrated duplication
// estimate (data/reports/dup-fit-nfl.json) and a thesis the user writes; all of it is saved in
// data/<slate>/entries.json so the review can grade it after the contests run.
import fs from "node:fs";
import path from "node:path";
import { FORMATS } from "../src/engine/formats.mjs";
import { parseEntries } from "../src/engine/audit.mjs";
import { nrm } from "../src/engine/csv.mjs";
import { hubData } from "./sources.mjs";

const readJ = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
const file = dir => path.join("data", dir, "entries.json");
export const loadEntries = dir => readJ(file(dir)) || { dir, entries: [], importedAt: null };
const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
const CATCH = /^(WR|TE|RB)$/;

function lobby() {
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

export function importEntries(dir, csv, sourceName) {
  const hub = hubData(dir), sd = hub.slate.type === "SHOWDOWN", fkey = sd ? "nfl_sd" : "nfl_cl", f = FORMATS[fkey];
  const rules = readJ(`rules/${fkey}.json`), ruleBy = Object.fromEntries((rules?.rules || []).map(r => [r.id, r]));
  const parsed = parseEntries(csv, f);
  const byDk = new Map(), byCpt = new Map(), byName = new Map();
  for (const r of hub.rows) { if (r.stk?.dkId) byDk.set(r.stk.dkId, r); if (r.stk?.cptDkId) byCpt.set(r.stk.cptDkId, r); const k = isDst(r.pos) ? "dst|" + r.team : nrm(r.name); if (!byName.has(k)) byName.set(k, r); }
  const nick = new Map(); for (const r of hub.rows) if (isDst(r.pos)) nick.set(nrm(r.name), r);
  const resolve = s => { const id = (String(s).match(/\((\d+)\)/) || [])[1], nm = String(s).replace(/\s*\(\d+\)\s*$/, "").trim(); let r = null, isCpt = false; if (id) { if (byCpt.has(id)) { r = byCpt.get(id); isCpt = true; } else r = byDk.get(id) || null; } if (!r) r = byName.get(nrm(nm)) || nick.get(nrm(nm)) || null; return { r, isCpt, nm }; };
  const prev = loadEntries(dir), prevById = new Map(prev.entries.map(e => [e.entryId || e.sig, e]));
  const L = lobby(), model = dupModel(), sigs = {}, entries = [];
  parsed.entries.forEach((e, n) => {
    const fee = +String(e.fee).replace(/[$,]/g, "") || 0, contest = L.get(String(e.cid)) || null, N = contest ? (contest.field || null) : null;
    const slots = e.names.map((s, j) => { const { r, isCpt, nm } = resolve(s); return { slot: f.slots[j], raw: nm, r, isCpt: sd ? j === 0 || isCpt : false }; });
    const missing = slots.filter(x => !x.r).map(x => x.raw);
    const base = { n, entryId: e.entryId, contest: e.contest, cid: e.cid, fee, names: e.names, thesis: (prevById.get(e.entryId) || {}).thesis || "", tag: (prevById.get(e.entryId) || {}).tag || "", result: (prevById.get(e.entryId) || {}).result || undefined };
    if (missing.length) { entries.push(Object.assign(base, { ok: false, missing, checks: [] })); return; }
    const players = slots.map(x => ({ slot: x.slot, name: x.r.name, pos: x.r.pos.split("/")[0], team: x.r.team, opp: x.r.opp, sal: x.isCpt ? Math.round((x.r.sal || 0) * 1.5) : x.r.sal, own: x.isCpt ? (x.r.stk?.cptOwn ?? null) : (x.r.own ?? null), proj: x.isCpt ? (x.r.cons != null ? +(1.5 * x.r.cons).toFixed(2) : null) : x.r.cons, stk: x.r.stk?.proj ?? null, inj: x.r.inj ? x.r.inj.status : (x.r.stk?.inj || ""), isCpt: x.isCpt, dkId: x.isCpt ? (x.r.stk?.cptDkId || "") : (x.r.stk?.dkId || "") }));
    const sal = players.reduce((s, p) => s + (p.sal || 0), 0), left = f.cap - sal, own = players.reduce((s, p) => s + (p.own || 0), 0), cons = players.reduce((s, p) => s + (p.proj || 0), 0);
    const qb = players.find(p => p.pos === "QB"), dst = players.find(p => isDst(p.pos)), chalk = players.filter(p => (p.own || 0) >= 20).length;
    const stackN = qb ? players.filter(p => p !== qb && p.team === qb.team && CATCH.test(p.pos)).length : 0, bring = qb ? players.some(p => p.team === qb.opp && !isDst(p.pos)) : false;
    const tc = {}; for (const p of players) tc[p.team] = (tc[p.team] || 0) + 1; const split = Object.values(tc).sort((a, b) => b - a).join("-");
    const sig = players.map(p => p.name + (p.isCpt ? "*" : "")).sort().join("|"), dupKey = e.contest + "|" + sig; sigs[dupKey] = (sigs[dupKey] || 0) + 1;
    const dup = dupEstimate(model, sd ? "showdown" : "classic", fee, N, players.map(p => p.own));
    const checks = [], add = (id, pass, detail) => { if (ruleBy[id]) checks.push({ id, hard: !!ruleBy[id].hard, pass, detail, rule: ruleBy[id].rule }); };
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
      add("own_200", own >= 200, `own sum ${own.toFixed(0)}%`);
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
      add("own_band", own < 180 ? true : own >= 220 ? false : null, `own sum ${own.toFixed(0)}%`);
      add("salary_left", left >= 1000, `$${left.toLocaleString()} left`);
      add("dup_risk", dup.meanDup == null ? null : dup.meanDup < 2, dup.meanDup == null ? "contest size unknown (pull the lobby)" : `~${dup.meanDup} copies expected, ${(100 * dup.pDup).toFixed(0)}% chance of any (field ${dup.N.toLocaleString()})`);
    }
    add("sim_top_half", null, "needs the four-source sim (next build)");
    entries.push(Object.assign(base, { ok: true, players, sal, left, own: +own.toFixed(1), cons: +cons.toFixed(1), chalk, qb: qb ? qb.name : null, stackN, bring, split, teams: Object.keys(tc).length, sig, dupKey, dup, contestN: N, checks, inj: players.filter(p => p.inj && !/^(Active|)$/i.test(p.inj)).map(p => `${p.name} ${p.inj}`) }));
  });
  for (const e of entries) if (e.ok && ruleBy.no_self_dupe) e.checks.unshift({ id: "no_self_dupe", hard: true, pass: sigs[e.dupKey] === 1, detail: sigs[e.dupKey] > 1 ? `${sigs[e.dupKey]} identical entries in this contest` : "unique in its contest", rule: ruleBy.no_self_dupe.rule });
  for (const e of entries) if (e.ok) { const fails = e.checks.filter(c => c.pass === false); e.verdict = fails.some(c => c.hard) ? "FAIL" : fails.length ? "warn" : "ok"; e.broken = fails.map(c => c.id); }
  const good = entries.filter(e => e.ok), cnt = {};
  for (const e of good) for (const p of e.players) { const k = p.name + "|" + p.team; const c = cnt[k] = cnt[k] || { name: p.name, team: p.team, pos: p.pos, n: 0, own: p.own, cpt: 0 }; c.n++; if (p.isCpt) c.cpt++; }
  const exposure = Object.values(cnt).map(c => Object.assign(c, { pct: +(100 * c.n / good.length).toFixed(0), delta: c.own == null ? null : +(100 * c.n / good.length - c.own).toFixed(0) })).sort((a, b) => b.n - a.n || (b.delta ?? 0) - (a.delta ?? 0));
  const summary = { lineups: entries.length, matched: good.length, unmatched: entries.length - good.length, contests: new Set(good.map(e => e.cid)).size, fees: good.reduce((s, e) => s + e.fee, 0), fail: good.filter(e => e.verdict === "FAIL").length, warn: good.filter(e => e.verdict === "warn").length, ok: good.filter(e => e.verdict === "ok").length, noThesis: good.filter(e => !e.thesis).length,
    avgOwn: good.length ? +(good.reduce((s, e) => s + e.own, 0) / good.length).toFixed(0) : null, avgChalk: good.length ? +(good.reduce((s, e) => s + e.chalk, 0) / good.length).toFixed(1) : null, avgLeft: good.length ? Math.round(good.reduce((s, e) => s + e.left, 0) / good.length) : null, dupHigh: good.filter(e => e.dup.meanDup != null && e.dup.meanDup >= (sd ? 2 : 1)).length };
  const out = { dir, format: fkey, importedAt: new Date().toISOString(), source: sourceName || "", rulesDerived: rules?.derived || null, entries, exposure, summary };
  fs.writeFileSync(file(dir), JSON.stringify(out, null, 1));
  return out;
}
export function saveThesis(dir, entryId, thesis) {
  const j = loadEntries(dir), e = j.entries.find(x => String(x.entryId) === String(entryId) || x.sig === entryId); if (!e) throw new Error("entry not found");
  e.thesis = String(thesis || "").slice(0, 600); e.thesisAt = new Date().toISOString();
  if (j.summary) j.summary.noThesis = j.entries.filter(x => x.ok && !x.thesis).length;
  fs.writeFileSync(file(dir), JSON.stringify(j, null, 1)); return e;
}
// review tag after the contest: "rule broken" | "rule wrong" | "variance" | ""
export function saveTag(dir, entryId, tag) {
  const j = loadEntries(dir), e = j.entries.find(x => String(x.entryId) === String(entryId) || x.sig === entryId); if (!e) throw new Error("entry not found");
  e.tag = ["rule broken", "rule wrong", "variance", ""].includes(tag) ? tag : ""; e.tagAt = new Date().toISOString();
  fs.writeFileSync(file(dir), JSON.stringify(j, null, 1)); return e;
}
