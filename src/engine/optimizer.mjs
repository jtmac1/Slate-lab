// The optimizer (user, 2026-10-15): builds candidate classic NFL lineups to the construction the archive backtests support,
// to be simmed against the Contest Generator's field like any other lineups. Many varied candidates, not one "best" lineup.
// What it builds (bench/stack-shapes-nfl.mjs, bench/mini-stacks-nfl.mjs, bench/game-concentration-nfl.mjs, 2026-10-15):
//   - stack shape per lineup from a mix: main slates QB+1 or QB+2 with one bring-back (QB+2 favored; QB+2 with two bring-backs
//     and QB+3 with one allowed, not pushed; no bring-back rare); small slates (2-4 games) lean QB+2 / QB+3 with two bring-backs
//   - bring-back never a TE under $5,500 (stud TE fine); DST never against the lineup's own QB
//   - optional mini-stack from one other game, preferring an RB or TE with the opposing WR; otherwise the rest spread out
//   - chalk core (players 20%+ owned favored), at most 2 players under 5% owned, under $600 of salary left
//   - QB matchup tilt (bench/qb-matchups-nfl.mjs: QBs vs defenses that give up more than expected won top-1% ~2.3x as often
//     per unit of ownership, 2025-26)
// Variety: every lineup draws its own projection noise, exposures are capped, and lineups must differ by minUniq players.
import { eligible } from "./formats.mjs";
import { assignSlots, sigOf, overlap } from "./lineups.mjs";

const MAIN_SHAPES = { "1|1": 0.36, "2|1": 0.44, "2|2": 0.08, "3|1": 0.07, "1|0": 0.025, "2|0": 0.025 };
const SMALL_SHAPES = { "2|2": 0.35, "3|2": 0.2, "1|2": 0.15, "2|1": 0.25, "3|1": 0.05 };
export const OPT_DEFAULTS = { n: 150, noise: 0.12, maxExp: 50, qbMaxExp: 35, minUniq: 2, minSal: 49400, maxLow: 2, chalkBonus: 0.2, miniShare: 0.4, qbTilt: 2.0, cheapTEbb: 5500 };

export function optimizeLineups(pool, cfg = {}, rng = Math.random) {
  const C = Object.assign({}, OPT_DEFAULTS, cfg), P = pool.players, f = pool.format;
  if (f.mult) return { lineups: [], err: "the optimizer is for classic slates" };
  const games = new Set(P.filter(p => p.team && p.opp).map(p => [p.team, p.opp].sort().join("@"))).size;
  const SH = C.shapes || (games <= 4 ? SMALL_SHAPES : MAIN_SHAPES), shapeKeys = Object.keys(SH), shapeW = shapeKeys.map(k => SH[k]);
  const qbm = C.qbMatchups || {};   // defense team -> matchup (+0.2 = gives QBs 20% more than expected)
  const live = P.map((p, i) => i).filter(i => P[i].proj > 0);
  const byPos = pos => live.filter(i => P[i].pos === pos);
  const QBS = byPos("QB"), DST = byPos("DST");
  const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
  const pickW = (items, w) => { let t = 0; for (const x of w) t += x; if (t <= 0) return null; let u = rng() * t; for (let k = 0; k < items.length; k++) { u -= w[k]; if (u <= 0) return items[k]; } return items[items.length - 1]; };
  const own = i => P[i].own ?? 0, lowOwn = i => own(i) < 5;
  const exp = new Map(), out = [], meta = [], sigs = new Set();
  const capOf = i => P[i].pos === "QB" ? C.qbMaxExp : C.maxExp, overCap = i => (exp.get(i) || 0) >= Math.max(1, Math.floor(C.n * capOf(i) / 100));
  const pc = i => /^(WR|TE|RB)$/.test(P[i].pos);

  for (let attempt = 0; attempt < C.n * 25 && out.length < C.n; attempt++) {
    const v = new Map(); for (const i of live) v.set(i, P[i].proj * Math.exp(C.noise * gauss() - C.noise * C.noise / 2));
    const val = i => v.get(i) * (own(i) >= 20 ? 1 + C.chalkBonus : 1);
    const [st, bb] = pickW(shapeKeys, shapeW).split("|").map(Number);
    // QB: projection (sharpened) x matchup tilt
    const qcands = QBS.filter(i => !overCap(i));
    const qb = pickW(qcands, qcands.map(i => Math.pow(v.get(i), 4) * Math.exp(C.qbTilt * (qbm[P[i].opp] || 0)))); if (qb == null) break;
    const Q = P[qb], lu = [qb], inLu = i => lu.includes(i);
    const take = (cands, k, wfn) => { for (let n = 0; n < k; n++) { const c = cands.filter(i => !inLu(i) && !overCap(i)); const x = pickW(c, c.map(wfn)); if (x == null) return false; lu.push(x); } return true; };
    // stack: QB's pass-catchers (RBs count, at half weight), bring-back from the other side (no cheap TE)
    if (!take(live.filter(i => P[i].team === Q.team && pc(i)), st, i => val(i) * (P[i].pos === "RB" ? 0.5 : 1))) continue;
    if (!take(live.filter(i => P[i].team === Q.opp && pc(i) && !(P[i].pos === "TE" && P[i].sal < C.cheapTEbb)), bb, i => val(i))) continue;
    const qGame = new Set([Q.team, Q.opp]);
    // optional mini-stack: an RB or TE with the opposing WR from one other game
    let mini = "";
    if (rng() < C.miniShare) {
      const anchors = live.filter(i => !qGame.has(P[i].team) && (P[i].pos === "RB" || P[i].pos === "TE") && !overCap(i));
      const a = pickW(anchors, anchors.map(val));
      if (a != null) { const wrs = live.filter(i => P[i].team === P[a].opp && P[i].pos === "WR" && !overCap(i)), w = pickW(wrs, wrs.map(val)); if (w != null) { lu.push(a, w); mini = `${P[a].pos}+opp WR`; } }
    }
    // fill: other games only (keeps the shape exact), at most one more from the mini-stack game, DST not facing the QB
    const miniGame = mini ? new Set([P[lu[lu.length - 1]].team, P[lu[lu.length - 2]].team]) : null;
    const filled = fill(lu, i => !qGame.has(P[i].team) && !(miniGame && miniGame.has(P[i].team)) && !inLu(i) && !overCap(i), d => P[d].opp !== Q.team && !qGame.has(P[d].team) && !overCap(d));
    if (!filled) continue;
    const sal = filled.reduce((s, i) => s + P[i].sal, 0); if (sal > f.cap || sal < C.minSal) continue;
    if (filled.filter(lowOwn).length > C.maxLow) continue;
    const order = assignSlots(filled, P, f); if (!order) continue;
    const sig = sigOf(order, f); if (sigs.has(sig)) continue;
    if (C.minUniq > 1 && out.some(o => overlap(o, order) > 9 - C.minUniq)) continue;
    sigs.add(sig); out.push(order); for (const i of order) exp.set(i, (exp.get(i) || 0) + 1);
    meta.push({ shape: `QB+${st}${bb ? ` | ${bb} OPP` : ""}`, mini, qbMatchup: qbm[Q.opp] ?? null, sal, own: +order.reduce((s, i) => s + own(i), 0).toFixed(1) });

    // fill the open slots: positions still needed, best noisy value under the budget, then upgrade toward the salary floor
    function fill(core, okSkill, okDst) {
      const L0 = core.slice(), cnt = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0 }; for (const i of L0) cnt[P[i].pos]++;
      if (cnt.RB > 3 || cnt.WR > 4 || cnt.TE > 2 || cnt.RB + cnt.WR + cnt.TE > 7) return null;
      const d = pickW(DST.filter(okDst), DST.filter(okDst).map(i => val(i))); if (d == null) return null; L0.push(d); cnt.DST++;
      const cheapest = pos => Math.min(...live.filter(i => P[i].pos === pos).map(i => P[i].sal));
      const minCost = { RB: cheapest("RB"), WR: cheapest("WR"), TE: cheapest("TE") };
      while (L0.length < 9) {
        const need = { RB: Math.max(0, 2 - cnt.RB), WR: Math.max(0, 3 - cnt.WR), TE: Math.max(0, 1 - cnt.TE) }, left = 9 - L0.length, nNeed = need.RB + need.WR + need.TE, free = left - nNeed;
        const spent = L0.reduce((s, i) => s + P[i].sal, 0);
        const okPos = pos => need[pos] > 0 || (free > 0 && (pos === "RB" ? cnt.RB < 3 : pos === "WR" ? cnt.WR < 4 : cnt.TE < 2) && cnt.RB + cnt.WR + cnt.TE < 7);
        const cands = live.filter(i => pc(i) && okPos(P[i].pos) && okSkill(i) && !L0.includes(i)).filter(i => {
          const after = { RB: need.RB - (P[i].pos === "RB" ? 1 : 0), WR: need.WR - (P[i].pos === "WR" ? 1 : 0), TE: need.TE - (P[i].pos === "TE" ? 1 : 0) };
          const rest = Math.max(0, after.RB) * minCost.RB + Math.max(0, after.WR) * minCost.WR + Math.max(0, after.TE) * minCost.TE + Math.max(0, left - 1 - Math.max(0, after.RB) - Math.max(0, after.WR) - Math.max(0, after.TE)) * Math.min(minCost.RB, minCost.WR);
          return spent + P[i].sal + rest <= f.cap; });
        if (!cands.length) return null;
        const top = cands.sort((a, b) => val(b) - val(a)).slice(0, 4), x = pickW(top, top.map(i => Math.pow(val(i), 3)));
        L0.push(x); cnt[P[x].pos]++;
      }
      // upgrade: swap a fill player for a better one at the same position while the cap allows, until the floor is met
      for (let pass = 0; pass < 12; pass++) {
        const spent = L0.reduce((s, i) => s + P[i].sal, 0); if (spent >= C.minSal) break;
        let best = null;
        for (let k = core.length + 1; k < 9; k++) { const o = L0[k]; for (const i of live) { if (P[i].pos !== P[o].pos || L0.includes(i) || !okSkill(i)) continue; const ns = spent - P[o].sal + P[i].sal; if (ns > f.cap || P[i].sal <= P[o].sal) continue; const gain = val(i) - val(o); if (!best || gain > best.gain) best = { k, i, gain }; } }
        if (!best) break; L0[best.k] = best.i;
      }
      return L0;
    }
  }
  if (!out.length) return { lineups: [], meta: [], err: "the optimizer couldn't build a lineup to these rules on this slate" };
  return { lineups: out, meta, games };
}
