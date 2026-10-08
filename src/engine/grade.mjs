// Lineup grade (0-100): one number per lineup built from three measured parts, each ranked within the lineup's own pool:
//   sim     - the lineup's sim ROI (Lab ROI in the app, Stokastic sim ROI in backtests), as a percentile of the pool
//   rules   - the NFL rulebook (bench/rulebook-nfl.mjs -> data/reports/rulebook-nfl.json): every KEPT rule the lineup follows
//             adds ln(its top-1% lift): follow rules add, avoid rules (lift < 1) subtract; a rule whose lift and t disagree in
//             sign is skipped. Summed, then a percentile of the pool
//   guide   - the slate guide's notes (stances, theses, top plays, captain reads; contestsim.matchNotes), net, as a percentile
// grade = 100 * weighted mean of the three percentiles. 100 = the best lineup in this pool, so it is relative to the contest.
// Shared by the backtest (bench/grade-loop-nfl.mjs) and the app (server/contestsim.mjs loadSimRun), so both score alike.

// ---- features -------------------------------------------------------------------------------------------------------
// players: [{ name, pos, team, opp, sal, own (percent) }], classic slot order or showdown with the captain first
const SKILL = /^(WR|TE|RB)$/, isD = p => /^(DST|D|DEF)$/i.test(p.pos || "");
export function classicFeatures(players, cap = 50000) {
  const qb = players.find(p => p.pos === "QB"), sal = players.reduce((t, p) => t + (p.sal || 0), 0), own = players.map(p => +p.own || 0);
  const stack = qb ? players.filter(p => p !== qb && p.team === qb.team && SKILL.test(p.pos)).length : 0;
  const opp = qb ? players.filter(p => p.team === qb.opp && !isD(p)) : [];
  const n = pos => players.filter(p => p.pos === pos).length;
  return { qb, stack, bring: opp.length > 0, bringN: opp.length, oppKeys: opp.map(p => p.name + "|" + p.team), left: cap - sal, ownSum: own.reduce((a, b) => a + b, 0),
    chalk: own.filter(o => o >= 20).length, sub1: own.filter(o => o < 1).length, sub5: own.filter(o => o < 5).length, mid510: own.filter(o => o >= 5 && o < 10).length,
    rbN: n("RB"), wrN: n("WR"), teN: n("TE"), qbSal: qb ? qb.sal || 0 : 0, dstVsOwnQB: !!qb && players.some(p => isD(p) && p.team === qb.opp) };
}
export function showdownFeatures(players, cap = 50000) {
  const cpt = players[0], tc = {}; for (const p of players) tc[p.team] = (tc[p.team] || 0) + 1;
  const qb = players.find(p => p.pos === "QB"), own = players.slice(1).map(p => +p.own || 0);
  return { split: Object.values(tc).sort((a, b) => b - a).join("-"), cptPos: cpt.pos, cptOwn: +cpt.cptOwn || +cpt.own || 0, hasQB: !!qb, hasK: players.some(p => p.pos === "K"), hasDST: players.some(isD),
    qbStacked: !!qb && players.some(p => p !== qb && p.team === qb.team && SKILL.test(p.pos)), dstVsOwnQB: !!qb && players.some(p => isD(p) && p.team === qb.opp),
    left: cap - players.reduce((t, p) => t + (p.sal || 0), 0), ownSum: own.reduce((a, b) => a + b, 0), chalk: own.filter(o => o >= 20).length };
}
// "obvious bring-back" per stacked QB from the pool itself (the field a contest is built from): the opposing player 40%+ of that
// QB's stacked lineups carry. feats: classicFeatures() results; sets f.chalkBB = true / false / null (no obvious one)
export function markObviousBringBack(feats) {
  const by = new Map();
  for (const f of feats) if (f.qb && f.stack >= 1) { const k = f.qb.name + "|" + f.qb.team, q = by.get(k) || { n: 0, opp: new Map() }; q.n++; for (const o of f.oppKeys) q.opp.set(o, (q.opp.get(o) || 0) + 1); by.set(k, q); }
  for (const f of feats) { f.chalkBB = null; if (!(f.qb && f.stack >= 1)) continue; const q = by.get(f.qb.name + "|" + f.qb.team); if (!q || q.n < 5) continue; let top = null, c = 0; for (const [o, k] of q.opp) if (k > c) { top = o; c = k; } if (top && c / q.n >= 0.4) { f.chalkBB = f.oppKeys.includes(top); f.chalkBBShare = c / q.n; } }
  return feats;
}

// ---- rules: rulebook rule name -> test on the features (only these are graded; sim and duplication rules are left out) ----
const CL = {
  "QB + 2 pass catchers or more": f => f.stack >= 2, "bring-back from the QB's opponent": f => f.bring, "DST facing own QB (should be bad)": f => f.dstVsOwnQB,
  "salary left >= $600": f => f.left >= 600, "own sum < 200%": f => f.ownSum < 200, "own sum 200-260%": f => f.ownSum >= 200 && f.ownSum < 260, "own sum >= 260%": f => f.ownSum >= 260,
  "4+ players at 20%+ owned": f => f.chalk >= 4, "0-2 players at 20%+ owned": f => f.chalk <= 2,
  "ETR: WR in the flex (4 WRs)": f => f.wrN >= 4, "ETR: QB under $6,000": f => f.qbSal > 0 && f.qbSal < 6000, "ETR: QB $7,000+": f => f.qbSal >= 7000,
  "ETR: naked QB (no stack)": f => f.stack === 0, "ETR: QB + exactly 1 (single stack)": f => f.stack === 1,
  "ETR: double bring-back (2+ from opponent)": f => f.bringN >= 2, "ETR: onslaught + bring-back": f => f.stack >= 3 && f.bringN >= 1,
  "ETR: any player under 1% owned": f => f.sub1 >= 1, "ETR: 3+ players under 5%": f => f.sub5 >= 3, "ETR: no player under 5%": f => f.sub5 === 0, "ETR: 3+ players at 5-10% owned": f => f.mid510 >= 3,
  "ETR BB: stack takes the obvious bring-back (vs fading it)": f => f.chalkBB === true,
};
const CL_SCOPE = { "ETR BB: stack takes the obvious bring-back (vs fading it)": f => f.chalkBB != null };
const SD = {
  "5-1 split": f => f.split === "5-1", "4-2 split": f => f.split === "4-2", "3-3 split": f => f.split === "3-3", "CPT is a QB": f => f.cptPos === "QB", "CPT is a WR": f => f.cptPos === "WR",
  "CPT is a RB": f => f.cptPos === "RB", "CPT is a TE": f => f.cptPos === "TE", "CPT is K or DST": f => /^(K|DST)$/.test(f.cptPos), "CPT ownership < 10%": f => f.cptOwn < 10, "CPT ownership >= 20%": f => f.cptOwn >= 20,
  "has a QB": f => f.hasQB, "QB with a pass catcher": f => f.qbStacked, "has a kicker": f => f.hasK, "has a DST": f => f.hasDST, "DST facing own QB (should be bad)": f => f.dstVsOwnQB,
  "salary left >= $300": f => f.left >= 300, "salary left >= $1000": f => f.left >= 1000, "own sum < 180%": f => f.ownSum < 180, "own sum >= 220%": f => f.ownSum >= 220, "4+ players at 20%+ owned": f => f.chalk >= 4,
};
export const tierOf = fee => fee < 100 ? "$20-99" : fee < 300 ? "$100-299" : "$300+";
// the kept rules that apply to a contest: the fee tier's verdict first, then slate length (classic), then all; one row per rule
export function rulesFor(rulebook, { sd, fee = 20, games = 12 } = {}) {
  const fmt = sd ? "showdown" : "classic", defs = sd ? SD : CL, rows = (rulebook && rulebook.rows || []).filter(r => r.fmt === fmt && defs[r.rule]);
  const segs = [tierOf(fee), ...(sd ? [] : [games <= 8 ? "short slate (8 games or fewer)" : "long slate (9+ games)"]), "all"], out = [];
  for (const name of Object.keys(defs)) { const r = segs.map(s => rows.find(x => x.rule === name && x.seg === s && x.kept)).find(Boolean); if (r && r.lift > 0 && Math.sign(Math.log(r.lift)) === Math.sign(r.t)) out.push({ name, test: defs[name], scope: sd ? null : CL_SCOPE[name] || null, pts: Math.log(r.lift), lift: r.lift, t: r.t, seg: r.seg, roiF: r.roiF, roiN: r.roiN }); }
  return out;
}

// ---- grading a pool ---------------------------------------------------------------------------------------------------
// items: [{ sim (number), feats, guide: notes object or null }]; returns [{ grade, parts{sim,rules,guide}, rules[], guide[] }]
// scoped rules (the obvious bring-back) compare two kinds of lineup inside their scope: the other kind pays the mirror (-pts)
const GUIDE_PTS = { Core: 1, Value: 1, Leverage: 1.5, Dart: 0.5, "CPT idea": 1, "With CPT": 0.5, "Stack idea": 1, "Game idea": 0.5, Note: 0.5, Caution: -0.5, Fade: -2, "Hurt by CPT": -1, "Game to avoid": -1 };
export const DEFAULT_WEIGHTS = { sim: 0.45, rules: 0.35, guide: 0.2 };
const pctRanks = v => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), out = new Array(v.length); let i = 0; while (i < o.length) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; const p = v.length > 1 ? ((i + j) / 2) / (v.length - 1) : 1; for (let k = i; k <= j; k++) out[o[k][1]] = p; i = j + 1; } return out; };
export function gradePool(items, rules, { weights = DEFAULT_WEIGHTS, fee = 20, sd = false } = {}) {
  const simP = pctRanks(items.map(x => x.sim ?? -1e9)).map(p => !sd && fee >= 300 && p > 0.9 ? 0.6 : p); // $300+ classic: the sim's top decile lost (rulebook t -3.4)
  const rr = items.map(x => { const hit = []; let s = 0; for (const r of rules) { if (r.scope && !r.scope(x.feats)) continue; if (r.test(x.feats)) { s += r.pts; hit.push(r); } else if (r.scope) { s -= r.pts; hit.push(Object.assign({}, r, { name: r.name.replace("takes the obvious bring-back (vs fading it)", "fades the obvious bring-back"), pts: -r.pts })); } } return { s, hit }; });
  const ruleP = pctRanks(rr.map(x => x.s));
  const gp = items.map(x => { const n = x.guide; if (!n) return { s: 0, lines: [] }; const lines = []; let s = 0; for (const it of n.for.concat(n.against)) { const w = GUIDE_PTS[it.kind] ?? (n.for.includes(it) ? 1 : -1), v = w * (it.names || [1]).length; s += v; lines.push({ kind: it.kind, names: it.names, pts: v, note: it.note || null }); } for (const t of n.theses || []) { s += 1; lines.push({ kind: "Thesis", names: [t], pts: 1 }); } return { s, lines }; });
  const hasGuide = items.some(x => x.guide), guideP = hasGuide ? pctRanks(gp.map(x => x.s)) : items.map(() => null);
  const w = Object.assign({}, weights); if (!hasGuide) w.guide = 0; const W = w.sim + w.rules + w.guide;
  return items.map((x, i) => ({ grade: Math.round(100 * (w.sim * simP[i] + w.rules * ruleP[i] + w.guide * (guideP[i] ?? 0)) / W),
    parts: { sim: Math.round(100 * simP[i]), rules: Math.round(100 * ruleP[i]), guide: guideP[i] == null ? null : Math.round(100 * guideP[i]) }, weights: { sim: +(w.sim / W).toFixed(2), rules: +(w.rules / W).toFixed(2), guide: +(w.guide / W).toFixed(2) },
    rules: rr[i].hit.map(r => ({ name: r.name, pts: +r.pts.toFixed(3), lift: r.lift, t: r.t, seg: r.seg, roiF: r.roiF, roiN: r.roiN })), guide: gp[i].lines }));
}
