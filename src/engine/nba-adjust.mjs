// NBA classic player adjustments fit on 2025-26 real fields, held out on alternate dates (159 slates).
// Ownership: bench/fit-own-error-nba.mjs -> data/reports/nba/own-error-nba.json. Stokastic's pre-lock own runs light on
// chalk (15%+ projected: real is 5.1 pts heavier) and heavy at 2-10%. Held-out MAE 3.93 -> 2.75 (all, own >= 1%),
// 8.29 -> 5.94 on 15%+, better than raw in every slate-size bucket and than a projected-own band curve overall. Terms:
// projected-own shape, position, chalk rank on the slate, started his team's previous game, projection above his last-5
// DK average (field chases news bumps), slate chalk count. No slate-size terms: none held out in every bucket.
// Projection: bench/fit-proj-bias-nba.mjs -> data/reports/nba/proj-bias-nba.json. Stokastic's projection is unbiased to
// within 0.2 pts and no term (shape, salary, value, own, minutes, form, injury return, price change, slate size) lowered
// held-out error beyond noise, so adjustProj is the identity on purpose. model.mjs PROJ_TILT has no NBA entry either.
// Own in percent (0-100).
const B = [1.15985, -0.89695, 0.12664, 0.22008, 0.34423, 0.24375, 0.20937, -0.00912, -0.16403, -0.02113, -0.00349, -0.02674, 0.07814, -0.11695, -0.03947, 0.05723, -0.13355];
const MEAN_STARTED = 0.6088, BANDS = [3, 7, 12, 20, 30, 45], POS = ["SG", "SF", "PF", "C"], CLAMP = [0.4, 2.0];

// players: [{id?, name, pown}] on one classic slate -> {chalkN, rank: Map(key -> chalk rank, 0 = most owned)}
export function nbaSlateInfo(players) {
  const P = players.filter(p => p.pown != null), key = p => p.id ?? p.name, rank = new Map();
  [...P].sort((a, b) => b.pown - a.pown).forEach((p, i) => rank.set(key(p), i));
  return { chalkN: P.filter(p => p.pown >= 20).length, rank };
}
// player: {pown (%), pos ("PG/SG" ok), proj, l5Dk? (last-5 games DK avg), startedPrev? (bool), chalkRank?}; slateInfo from nbaSlateInfo
export function adjustOwn(p, slateInfo = {}) {
  if (!(p.pown >= 0)) return p.pown;
  const lp = Math.log(p.pown + 1), pos = String(p.pos || "").split("/")[0], rk = p.chalkRank ?? slateInfo.rank?.get(p.id ?? p.name) ?? 0;
  const x = [1, lp, lp * lp, ...BANDS.map(b => p.pown >= b ? 1 : 0), ...POS.map(q => pos === q ? 1 : 0), Math.log(rk + 1),
    p.startedPrev == null ? MEAN_STARTED : p.startedPrev ? 1 : 0, p.l5Dk != null && p.proj != null ? (p.proj - p.l5Dk) / 10 : 0, (slateInfo.chalkN ?? 0) / 10];
  const m = Math.min(CLAMP[1], Math.max(CLAMP[0], Math.exp(x.reduce((s, v, i) => s + v * B[i], 0))));
  return Math.max(0, (p.pown + 1) * m - 1);
}
export const adjustProj = (p, slateInfo) => p.proj;
