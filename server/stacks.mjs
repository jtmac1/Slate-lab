// "Lab stacks" (user-asked 2026-10-07): game-stack likes from the simulator, not gut feel. Example that prompted it:
// on 2026-10-04 he played Stroud + Nico Collins and missed the bring-back CeeDee Lamb (44 pts).
// Classic: for each QB, every QB+1 and QB+2 of his pass catchers, and every bring-back from the opponent, gets
//   freq   = % of the generated field's lineups containing the combo (average over the per-source fields in field.json)
//   t1x    = the sim's top-1% rate among the pool lineups containing the combo, relative to the pool average
//            (shrunk toward 1x with k=6 pseudo-lineups so a combo seen in 2 lineups can't top the list)
// plus the same transparent inputs as the Lab likes: game total and implied team total (Pinnacle), ETR DvP of the
// opposing defense vs QB/WR/TE, ETR PROE, the receivers' XFP edge, and guide stances. Score = mean of z-scores of
// log(t1x), -log(freq) (uniqueness), implied total, DvP, PROE, XFP edge (+ small stance nudge). Unfitted; scored after
// each slate by bench/likes-tracker-nfl.mjs (stacks key).
// Showdown: the 5-1 / 4-2 / 3-3 side and captain + bring-back pairs, same freq / t1x idea.
// Saved as guide.labStacks (guide.stacks already holds ETR's showdown captain stacks).
import fs from "node:fs";
import path from "node:path";
import { hubData } from "./sources.mjs";
import { slateData } from "./etrdata.mjs";
import { loadBlickCond } from "./blickcond.mjs";

const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const nrm = s => String(s || "").toLowerCase().replace(/[.'`’]/g, "").replace(/\s+(jr|sr|ii|iii|iv|v)$/, "").replace(/\s+/g, " ").trim();
const STANCE = { core: 0.25, value: 0.4, leverage: 0.25, caution: -0.3, fade: -0.5 };
const K_SHRINK = 6, r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const zs = vals => { const v = vals.filter(x => x != null && Number.isFinite(x)); if (v.length < 3) return vals.map(() => null); const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1; return vals.map(x => x == null || !Number.isFinite(x) ? null : (x - m) / sd); };
const t1Of = s => s.t1 ?? (s.sources ? s.sources.map(k => s[k] && s[k].t1).filter(v => v != null).reduce((a, b, i, A) => a + b / A.length, 0) : null);

// combo index over the generated fields and the simmed pool
function indexes(dir) {
  const F = readJ(path.join("data", dir, "field.json")), S = readJ(path.join("data", dir, "simrun.json"));
  if (!F || !S || !S.rows || !S.rows.length) throw new Error("build the field and run the Pre-Contest Simulator for this slate first");
  // field lineups hold pool indices; F.rows (the union) carries the names for every index used
  const idName = new Map(); for (const r of F.rows || []) (r.ids || []).forEach((id, j) => idName.set(id, nrm(r.names[j])));
  const fields = F.by && Object.keys(F.by).length ? Object.values(F.by).map(b => b.field) : [F.field];
  const teamBy = new Map((F.players || []).map(p => [nrm(p.name), p.team]));
  const fieldSets = fields.map(field => field.map(lu => ({ set: new Set(lu.map(i => idName.get(i))), cpt: idName.get(lu[0]), teams: lu.map(i => teamBy.get(idName.get(i))) })));
  const pool = S.rows.filter(r => r.players && r.sim).map(r => ({ set: new Set(r.players.map(p => nrm(p.name))), cpt: nrm((r.players.find(p => p.slot === "CPT") || r.players[0]).name), t1: t1Of(r.sim), t10: r.sim.t10 ?? null, type: r.type || "", teams: r.players.map(p => p.team) }));
  const base = pool.reduce((a, r) => a + (r.t1 || 0), 0) / pool.length;
  // freq (% of each source's field, averaged) and shrunk top-1% ratio for a predicate over a lineup
  const stat = pred => {
    const freq = fieldSets.reduce((a, fs) => a + 100 * fs.filter(pred).length / fs.length, 0) / fieldSets.length;
    const rows = pool.filter(pred), sum = rows.reduce((a, r) => a + (r.t1 || 0), 0);
    return { freq: r2(freq), n: rows.length, t1x: r2(base > 0 ? (sum + K_SHRINK * base) / (rows.length + K_SHRINK) / base : 1) };
  };
  return { stat, base, pool, sims: S.at, fieldAt: F.at, contest: S.contest || null };
}

export function buildStacks(dir) {
  const hub = hubData(dir), meta = hub.slate || {}, sd = meta.type === "SHOWDOWN", date = meta.date || String(dir).slice(0, 10);
  const guide = readJ(path.join("data", dir, "slate-guide.json")) || {}, D = slateData(dir) || {};
  const X = indexes(dir), B = loadBlickCond(dir);   // Blick's conditional field (server/blickcond.mjs), when pulled
  const stanceBy = new Map(Object.entries(guide.stances || {}).map(([n, s]) => [nrm(n), s.stance]));
  const xfpAge = D.xfp ? Math.round((Date.parse(date) - Date.parse(D.xfp.published)) / 864e5) : null, xfpBy = new Map(D.xfp && xfpAge <= 14 ? Object.entries(D.xfp.players).map(([n, v]) => [nrm(n), v]) : []);
  const tt = {}, tot = {}; for (const g of hub.games || []) { if (g.ttAway != null) { tt[g.away] = g.ttAway; tt[g.home] = g.ttHome; } if (g.total != null) { tot[g.away] = g.total; tot[g.home] = g.total; } }
  const P = hub.rows.filter(r => r.lab != null && r.sal > 0 && !(r.inj && /out|ir|injured reserve|doubtful/i.test(r.inj.status || ""))).map(r => ({ name: r.name, k: nrm(r.name), pos: String(r.pos).split("/")[0], team: r.team, opp: r.opp, sal: r.sal, proj: r.lab, own: r.labOwn ?? r.own ?? null }));
  const byTeam = t => P.filter(p => p.team === t);
  const xfpEdge = p => { const x = xfpBy.get(p.k); return x && x.xfp >= 6 ? -x.gap : null; };
  const dvp = (p) => D.dvp && D.dvp.vs[p.opp] ? D.dvp.vs[p.opp][p.pos] ?? null : null;
  const proe = t => D.proe && D.proe.teams[t] ? D.proe.teams[t].proe : null;
  const stanceN = ps => ps.reduce((a, p) => a + (STANCE[stanceBy.get(p.k)] || 0), 0) / Math.max(1, ps.length);
  const names = ps => ps.map(p => p.name).join(" + ");
  const out = { generatedAt: new Date().toISOString(), format: sd ? "showdown" : "classic", sim: { at: X.sims, field: X.fieldAt, contest: X.contest && X.contest.name || null, poolTop1: r2(X.base) }, blick: B ? { contest: B.meta.contest, built: B.meta.built } : null,
    method: sd ? "sides and captain+bring-back pairs ranked by the sim's top-1% rate among pool lineups containing them (x the pool average, shrunk) vs how often the generated field plays them" : "QB stacks (QB+1, QB+2) and bring-backs scored by mean z of log(sim top-1% x), uniqueness (-log field %), implied team total, DvP vs the passing game, PROE, receivers' XFP edge; + stance nudge. Every stack carries a bring-back (no naked QBs); the bring-back defaults to the opponent's top pass catcher unless another clearly beats him (score +0.5 and sim top-1% 1.2x). Tracked by bench/likes-tracker-nfl.mjs." };
  if (!sd) {
    const qbs = P.filter(p => p.pos === "QB" && p.proj >= 12).sort((a, b) => (b.own || 0) - (a.own || 0)).slice(0, 14);
    const stacks = [];
    for (const qb of qbs) {
      const cat = byTeam(qb.team).filter(p => /WR|TE/.test(p.pos) && p.proj >= 5).sort((a, b) => b.proj - a.proj).slice(0, 6);
      const combos = []; cat.forEach((x, i) => { combos.push([x]); for (const y of cat.slice(i + 1)) combos.push([x, y]); });
      for (const c of combos) {
        const ks = [qb.k, ...c.map(p => p.k)], s = X.stat(r => ks.every(k => r.set.has(k)));
        if (s.n < 2 && s.freq < 0.2) continue;
        const rec = c, dv = rec.map(p => dvp(p)).filter(v => v != null), xe = rec.map(xfpEdge).filter(v => v != null);
        stacks.push({ qb, catchers: c, ...s, blick: B ? B.combo([qb.name, ...c.map(p => p.name)]) : null, tt: tt[qb.team] ?? null, total: tot[qb.team] ?? null, dvpQB: dvp(qb), dvpRec: dv.length ? dv.reduce((a, b) => a + b, 0) / dv.length : null, proe: proe(qb.team), xfp: xe.length ? xe.reduce((a, b) => a + b, 0) : null, nudge: stanceN([qb, ...c]) });
      }
    }
    // the sim's top-1% rate already prices ownership (it is run against the field), so it counts twice and rarity is shown, not scored
    // blickLev: Blick's field plays the combo less (+) or more (-) than our generated field thinks
    const comp = { t1: zs(stacks.map(s => Math.log(s.t1x))), t1b: zs(stacks.map(s => Math.log(s.t1x))), blickLev: zs(stacks.map(s => s.blick != null ? Math.log((s.freq + 0.05) / (s.blick + 0.05)) : null)), tt: zs(stacks.map(s => s.tt)), dvp: zs(stacks.map(s => s.dvpQB != null || s.dvpRec != null ? (s.dvpQB ?? 0) + (s.dvpRec ?? 0) : null)), proe: zs(stacks.map(s => s.proe)), xfp: zs(stacks.map(s => s.xfp)) };
    stacks.forEach((s, i) => { s.z = {}; const v = []; for (const [k, a] of Object.entries(comp)) if (a[i] != null) { s.z[k] = r2(a[i]); v.push(a[i]); } s.score = r2(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length) + s.nudge); });
    // bring-back options for a stack: opponent WR/TE/RB, scored on the combo with the stack
    const bring = (s) => {
      const opps = byTeam(s.qb.opp).filter(p => /WR|TE/.test(p.pos) && p.proj >= 6 || p.pos === "RB" && p.proj >= 12).sort((a, b) => b.proj - a.proj).slice(0, 7);
      const ks = [s.qb.k, ...s.catchers.map(p => p.k)];
      const opts = opps.map(z => { const st = X.stat(r => ks.every(k => r.set.has(k)) && r.set.has(z.k)), solo = X.stat(r => r.set.has(s.qb.k) && r.set.has(z.k));
        // Blick: the full stack + bring-back when the pull computed it (QB + one catcher), else QB + bring-back; cond = share of those QB lineups that add him
        const bStack = B ? B.combo([s.qb.name, ...s.catchers.map(p => p.name), z.name]) : null, bBase = B ? B.combo([s.qb.name, ...s.catchers.map(p => p.name)]) : null, bPair = B ? B.combo([s.qb.name, z.name]) : null, bQB = B ? B.combo([s.qb.name]) : null;
        const blick = bStack != null ? { pct: bStack, cond: bBase ? r1(100 * bStack / bBase) : null, of: names([s.qb, ...s.catchers]) } : bPair != null ? { pct: bPair, cond: bQB ? r1(100 * bPair / bQB) : null, of: s.qb.name } : null;
        return { z, ...st, qbPair: solo, blick, xfp: xfpEdge(z), nudge: STANCE[stanceBy.get(z.k)] || 0 }; });
      // with the stack when the pool has it, else QB + bring-back (the stack-specific sample is often thin)
      // sim top-1% of QB + bring-back counted twice, projection once, XFP edge once; pairs the pool barely has (<4) fall back to 1x
      const t1Of2 = o => o.n >= 4 ? o.t1x : o.qbPair.n >= 4 ? o.qbPair.t1x : 1;
      const cmp = { t1: zs(opts.map(o => Math.log(t1Of2(o)))), t1b: zs(opts.map(o => Math.log(t1Of2(o)))), proj: zs(opts.map(o => o.z.proj)), xfp: zs(opts.map(o => o.xfp)), blickLev: zs(opts.map(o => o.blick ? Math.log(((o.n >= 4 ? o.freq : o.qbPair.freq) + 0.05) / (o.blick.pct + 0.05)) : null)) };
      opts.forEach((o, i) => { const v = Object.values(cmp).map(a => a[i]).filter(x => x != null); o.score = r2(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length) + o.nudge); });
      // role: the opponent's highest-projected pass catcher is "WR1"; other WRs are "WR2/3"
      const wrs = opts.filter(o => o.z.pos === "WR").sort((a, b) => b.z.proj - a.z.proj), top = opts.filter(o => /WR|TE/.test(o.z.pos)).sort((a, b) => b.z.proj - a.z.proj)[0];
      opts.forEach(o => { o.role = o === top ? "WR1" : o.z.pos === "WR" ? (wrs.indexOf(o) <= 0 ? "WR1" : "WR2/3") : o.z.pos; });
      opts.sort((a, b) => b.score - a.score);
      // default bring-back = the opponent's top pass catcher (bench/bringback-study-nfl.mjs: an opponent WR2/3 was the worst
      // single bring-back in 2025, top-10% -2.5pp, t -3.0, neutral in 2026; position otherwise barely mattered). Another
      // option replaces him only when it clearly beats him: score +0.5 or more AND sim top-1% rate 1.2x his or better.
      if (top && opts[0] !== top) { const c = opts[0]; if (!(c.score >= top.score + 0.5 && t1Of2(c) >= 1.2 * t1Of2(top))) { opts.splice(opts.indexOf(top), 1); opts.unshift(top); } }
      return opts;
    };
    const why = (s) => {
      const r = [`${names([s.qb, ...s.catchers])} in ${s.freq}% of our generated field${s.blick != null ? ` (${s.blick}% of Blick's field)` : ""}; sim top-1% rate ${s.t1x}x the pool (${s.n} pool lineups)`];
      if (s.tt != null) r.push(`${s.qb.team} implied ${s.tt} (game total ${s.total})`);
      if (s.dvpQB != null && Math.abs(s.dvpQB) >= 2) r.push(`${s.qb.opp} defense ${s.dvpQB > 0 ? "inflates" : "deflates"} QBs ${s.dvpQB > 0 ? "+" : ""}${s.dvpQB}% (ETR DvP)`);
      if (s.proe != null) r.push(`${s.qb.team} PROE ${s.proe > 0 ? "+" : ""}${s.proe}%`);
      if (s.xfp != null && s.xfp >= 2) r.push(`receivers' usage ahead of results (XFP +${r1(s.xfp)}/game)`);
      return r.slice(0, 4);
    };
    const bbWhy = (s, o, alt) => `${o.z.name} (${s.qb.opp} ${o.role === "WR1" ? "top pass catcher" : o.role === "WR2/3" ? "WR2/3 - weaker bring-back type" : o.z.pos}, proj ${r1(o.z.proj)}): with ${o.n >= 4 ? names([s.qb, ...s.catchers]) : s.qb.name} in ${o.n >= 4 ? o.freq : o.qbPair.freq}% of our field, sim top-1% ${o.n >= 4 ? o.t1x : o.qbPair.t1x}x${o.blick && o.blick.cond != null ? `; only ${o.blick.cond}% of ${o.blick.of} lineups have him (Blick conditional)` : ""}${alt ? `; ahead of ${alt.z.name} (${alt.n >= 4 ? alt.t1x : alt.qbPair.t1x}x, ${alt.n >= 4 ? alt.freq : alt.qbPair.freq}% of field)` : ""}`;
    const pack = s => ({ qb: s.qb.name, team: s.qb.team, opp: s.qb.opp, catchers: s.catchers.map(p => p.name), freq: s.freq, blick: s.blick, t1x: s.t1x, n: s.n, score: s.score, z: s.z });
    const ranked = stacks.filter(s => s.n >= 5).sort((a, b) => b.score - a.score);
    // top 3 stacks, at most one per QB
    const seenQB = new Set(); out.top = [];
    // never a naked QB: a QB stack without a bring-back lost about 25 ROI points in 2025 and 2026 (t -3.8 each year)
    for (const s of ranked) { if (seenQB.has(s.qb.k)) continue; const bb = bring(s); if (!bb.length) continue; seenQB.add(s.qb.k); out.top.push({ ...pack(s), bringBack: bb[0] ? { name: bb[0].z.name, pos: bb[0].z.pos, role: bb[0].role, blick: bb[0].blick, freq: bb[0].n >= 4 ? bb[0].freq : bb[0].qbPair.freq, t1x: bb[0].n >= 4 ? bb[0].t1x : bb[0].qbPair.t1x, score: bb[0].score } : null, reasons: [...why(s), bb[0] ? "bring-back " + bbWhy(s, bb[0], bb[1]) : null].filter(Boolean) }); if (out.top.length >= 3) break; }
    // best bring-back per popular QB (his most-played stack in the field)
    out.byQB = [];
    for (const qb of qbs.filter(q => (q.own || 0) >= 4).slice(0, 8)) {
      const mine = stacks.filter(s => s.qb.k === qb.k).sort((a, b) => b.freq - a.freq)[0]; if (!mine) continue;
      const bb = bring(mine); if (!bb.length) continue;
      const pop = bb.slice().sort((a, b) => b.qbPair.freq - a.qbPair.freq)[0];
      out.byQB.push({ qb: qb.name, team: qb.team, own: qb.own != null ? r1(qb.own) : null, stack: mine.catchers.map(p => p.name), bringBack: bb[0].z.name, options: bb.map(o => ({ name: o.z.name, score: o.score, t1x: o.n >= 4 ? o.t1x : o.qbPair.t1x, freq: o.n >= 4 ? o.freq : o.qbPair.freq, blick: o.blick })), alternatives: bb.slice(1, 3).map(o => o.z.name), fieldFavorite: pop.z.name, reason: `If you play ${qb.name}: the bring-back is ${bbWhy(mine, bb[0], pop !== bb[0] ? pop : bb[1])}` });
    }
    // one overowned stack to avoid: among the 8 most-played stacks, the worst score with sim top-1% under the pool rate
    const popular = stacks.filter(s => s.n >= 3).sort((a, b) => b.freq - a.freq).slice(0, 8), bad = popular.filter(s => s.t1x < 1).sort((a, b) => a.score - b.score)[0];
    out.avoid = bad ? [{ ...pack(bad), reasons: [`${names([bad.qb, ...bad.catchers])} is in ${bad.freq}% of the field (one of the 8 most-played stacks) but its sim top-1% rate is ${bad.t1x}x the pool`, bad.tt != null ? `${bad.qb.team} implied ${bad.tt}` : null].filter(Boolean) }] : [];
  } else {
    const teams = [...new Set(P.map(p => p.team))];
    // sides: majority team + split, e.g. "5-1 NO"
    const sideOf = r => { const c = {}; for (const t of r.teams) c[t] = (c[t] || 0) + 1; const [t, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return n === 3 ? "3-3" : `${n}-${6 - n} ${t}`; };
    const sides = [...new Set(X.pool.map(sideOf))].map(sd2 => ({ side: sd2, ...X.stat(r => r.teams && r.teams.every(Boolean) && sideOf(r) === sd2) }));
    // the field's side shares come from the pool's types by source field: approximate with pool freq if field lacks teams
    out.sides = sides.filter(s => s.n >= 3).sort((a, b) => b.t1x - a.t1x).map(s => { const bl = B && B.sides ? B.sides[s.side] ?? null : null; return { ...s, blick: bl, reason: `${s.side}: ${s.freq}% of our field${bl != null ? ` (${bl}% of Blick's)` : ""}, sim top-1% ${s.t1x}x the pool (${s.n} pool lineups)` }; });
    const caps = P.filter(p => p.proj >= 8), pairs = [];
    for (const c of caps) for (const z of P.filter(p => p.team !== c.team && p.proj >= 4)) { const st = X.stat(r => r.cpt === c.k && r.set.has(z.k)); if (st.n >= 8) pairs.push({ cpt: c.name, cptTeam: c.team, with: z.name, withPos: z.pos, blick: B ? B.cpt(c.name, z.name) : null, blickCpt: B ? B.cpt(c.name) : null, ...st }); }
    // the sim already prices ownership; rank pairs on its top-1% rate (8+ pool lineups so a thin pair can't top the list),
    // plus half the Blick leverage (log of our field % over Blick's) when Blick has the pair
    pairs.forEach(p => { p.score = r2(Math.log(p.t1x) + (p.blick != null ? 0.5 * Math.log((p.freq + 0.05) / (p.blick + 0.05)) : 0)); });
    out.pairs = pairs.sort((a, b) => b.score - a.score).slice(0, 3).map(p => ({ ...p, reason: `CPT ${p.cpt} + ${p.with} (bring-back): in ${p.freq}% of our field${p.blick != null ? ` (${p.blick}% of Blick's; ${p.blickCpt ? r1(100 * p.blick / p.blickCpt) : "?"}% of ${p.cpt} captain lineups)` : ""}, sim top-1% ${p.t1x}x the pool (${p.n} pool lineups)` }));
  }
  return out;
}

export function saveStacks(dir) {
  const f = path.join("data", dir, "slate-guide.json"), st = buildStacks(dir), g = readJ(f);
  if (g) { g.labStacks = st; fs.writeFileSync(f, JSON.stringify(g, null, 1)); }
  else fs.writeFileSync(path.join("data", dir, "lab-stacks.json"), JSON.stringify(st, null, 1));
  return st;
}
export const loadStacks = dir => (readJ(path.join("data", dir, "slate-guide.json")) || {}).labStacks || readJ(path.join("data", dir, "lab-stacks.json")) || null;
export function stacksText(st) {
  if (!st) return "";
  if (st.format === "showdown") return `SIDES: ${(st.sides || []).slice(0, 4).map(s => s.reason).join("; ")}\nCAPTAIN + BRING-BACK: ${(st.pairs || []).map(p => p.reason).join("; ")}`;
  return `TOP STACKS:\n${(st.top || []).map(s => `  - ${s.qb} + ${s.catchers.join(" + ")}${s.bringBack ? `, bring back ${s.bringBack.name}` : ""}: ${s.reasons.join("; ")}`).join("\n")}\nBRING-BACK BY QB:\n${(st.byQB || []).map(b => `  - ${b.reason}`).join("\n")}${(st.avoid || []).length ? `\nAVOID: ${st.avoid.map(a => a.reasons.join("; ")).join(" | ")}` : ""}`;
}
// our generated field's % for any combo (and captain + flex for showdown); the tracker compares it with Blick's and the real field's
export function fieldFreq(dir) {
  const X = indexes(dir);
  return { combo: names => X.stat(r => names.map(nrm).every(k => r.set.has(k))).freq, cpt: (c, flex) => X.stat(r => r.cpt === nrm(c) && (!flex || r.set.has(nrm(flex)))).freq };
}
