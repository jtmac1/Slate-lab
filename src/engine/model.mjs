// Outcome model: per-player skewed distributions tied together by a correlation matrix.

export const CSAME = { "QB|QB": 0.00, "QB|RB": 0.15, "QB|WR": 0.60, "QB|TE": 0.45, "QB|K": 0.30, "QB|DST": 0.10,
  "RB|RB": -0.20, "RB|WR": 0.02, "RB|TE": 0.02, "RB|K": 0.15, "RB|DST": 0.20,
  "WR|WR": 0.10, "WR|TE": 0.08, "WR|K": 0.10, "WR|DST": 0.05,
  "TE|TE": 0.10, "TE|K": 0.08, "TE|DST": 0.05, "K|K": -0.30, "K|DST": 0.15, "DST|DST": 0.00 };
export const COPP = { "QB|QB": 0.25, "QB|RB": 0.05, "QB|WR": 0.20, "QB|TE": 0.15, "QB|K": 0.15, "QB|DST": -0.45,
  "RB|RB": -0.05, "RB|WR": 0.03, "RB|TE": 0.03, "RB|K": 0.05, "RB|DST": -0.25,
  "WR|WR": 0.15, "WR|TE": 0.12, "WR|K": 0.12, "WR|DST": -0.35,
  "TE|TE": 0.12, "TE|K": 0.10, "TE|DST": -0.30, "K|K": 0.10, "K|DST": -0.15, "DST|DST": -0.30 };
// hitSame 0.22 and hitter sigma 0.70 (2026-09-16, bench/sim-variance.mjs + compare-grades.mjs over 212 pulled
// contests): real lineups spread 27.8 FP around projection, the old 0.15/0.60 model drew 20.8; the wider
// model lifted the gated rule's realized top-10% ROI +11pp at a cost in player-ROI rank correlation.
// College football correlations, fitted from 403 finished games and 19,083 player pairs
// (bench/fit-corr.mjs, 2026-09-19): college stacks move together far less than NFL ones.
// Graded on 277 pulled CFB contests: lineup rank correlation 0.183 -> 0.204, player ROI
// 0.391 -> 0.415, cash hits +1.1 per contest, realized money unchanged.
export const CSAME_CFB = Object.assign({}, CSAME, { "QB|RB": 0.097, "QB|WR": 0.192, "RB|RB": 0.150, "RB|WR": -0.019, "WR|WR": 0.126 });
export const COPP_CFB = Object.assign({}, COPP, { "QB|QB": 0.099, "QB|RB": 0.021, "QB|WR": 0.008, "RB|RB": -0.017, "RB|WR": 0.000, "WR|WR": 0.038 });
// MLB correlations fitted from 480 finished 2026 games and 86,106 player pairs (bench/game-logs-mlb.mjs +
// bench/fit-corr-mlb.mjs, 2026-09-30). Same-team hitters move together far less than the hand-set 0.22
// (+0.08 order bonus) assumed, and opposing offenses do not move together at all; the pitcher-vs-opposing-
// hitters link is stronger. Graded on 266 pulled contests against the hand-set table (noise floor from a
// seed re-run: lineup rank +-0.004, player rank +-0.006, cash hits +-1.3): lineup rank correlation
// 0.104 -> 0.119, player 0.116 -> 0.147, both halves and all six fee/size tiers; cash hits +1.5.
// Top-decile realized ROI -6 points, inside its +-13 noise floor. Lineup spread is now narrower than real
// (SD 23.0 vs 28.5 for 5-stacks); widening hitter sigma to 0.85 restores the spread but gives back the
// rank gains (-0.023) and 2.6 cash hits, so the spread gap is a per-player tail-shape problem, not sigma.
// Hand-set table it replaced: hitSame 0.22, hitOppSameGame 0.10, hitOwnPitcher 0.05, hitOppPitcher -0.20,
// pitchPitchSameGame -0.12, orderBonus 0.08.
export const MLBC = { hitSame: 0.094, hitOppSameGame: -0.009, hitOwnPitcher: 0.031, hitOppPitcher: -0.286,
  pitchPitchSameGame: -0.064, orderBonus: 0.013 };
export const LOAD = {
  // NFL [game, team, opponent], QB/RB/WR/TE fitted 2026-10-15 to real box scores (bench/fit-load-nfl.mjs --target=tail --fit=all):
  // the loadings that reproduce how often two players both land in their top 15% vs projection, by position pair. The hand-set
  // table made teammates move together far more than real games do (WR-WR 0.47 vs ~0, RB-WR 0.36 vs ~-0.05, QB-WR 0.53 vs ~0.3).
  // Graded on the live path (grade-all --vendor), fit one season / test the other: lineup rank +0.022 (2026) / +0.023 (2025),
  // more cashes both ways, significant clustered by date; realized top-10% ROI +13 (2026) / -2 (2025), not significant.
  // K and DST aren't in the box scores and keep the hand-set values (DST relies on the game loading staying >= 0).
  // Hand-set table it replaced: QB [0.30, 0.70, 0.10], RB [0.20, 0.48, 0.05], WR [0.28, 0.62, 0.10], TE [0.25, 0.55, 0.10].
  nfl: { QB: [0.6, 0.6, -0.188], RB: [0.1, -0.063, -0.063], WR: [0.263, 0.225, -0.025], TE: [0.063, 0.3, 0.15], K: [0.20, 0.45, 0.05], DST: [-0.15, 0.30, -0.55] },
  mlb: { HIT: [0.25, 0.52, 0.08], PIT: [-0.30, 0.18, -0.55] },
  cfb: { QB: [0.332, 0.456, -0.013], RB: [-0.056, 0.311, 0.043], WR: [0.284, 0.159, -0.129] }
};
// NBA pair correlations of (actual/projected - 1) for players in the same game, 8,817 player-games (bench/fit-nba.mjs,
// 2026-10-19). Basketball barely correlates: overall teammates -0.009, opponents 0.000. What stands out (se 0.01-0.03):
// two bigs on a team -0.10 (they split rebounds and minutes), teammate guards -0.04 / guard-wing -0.03, a cheap player
// with his team's star -0.06 (one usage pie), and stars in the same game move together, +0.056 teammates / +0.060
// opponents (pace, overtime). Terms add: a position term plus a tier term (star = 30+ projected, low = under 18).
// Graded against no correlation at all on 336 classic contests: no difference beyond seed noise (rank +0.002 without,
// top-10% ROI -5% without). Kept because it is measured, not because it earns anything yet.
export const NBAC = { bigBig: -0.10, guardGuard: -0.04, guardWing: -0.03, starStar: 0.056, lowStar: -0.06, oppStarStar: 0.06, oppMidStar: 0.02 };
const nbaRole = p => { const l = p.posList || [p.pos]; return l.includes("C") && !l.some(x => x === "PG" || x === "SG") ? "big" : l.some(x => x === "PG" || x === "SG") ? "guard" : "wing"; };
const nbaTier = p => p.proj >= 30 ? "star" : p.proj >= 18 ? "mid" : "low";
function nbaCorr(p, q, same, C) {
  const ta = nbaTier(p), tb = nbaTier(q), tiers = [ta, tb].sort().join("-");
  if (!same) return tiers === "star-star" ? C.oppStarStar : tiers === "mid-star" ? C.oppMidStar : 0;
  const roles = [nbaRole(p), nbaRole(q)].sort().join("-");
  let v = roles === "big-big" ? C.bigBig : roles === "guard-guard" ? C.guardGuard : roles === "guard-wing" ? C.guardWing : 0;
  if (tiers === "star-star") v += C.starStar; else if (tiers === "low-star") v += C.lowStar;
  return v;
}
// NBA classic game factors (bench/fit-gamecorr-nba.mjs): a shared per-game pace factor with loading g and a blowout factor with
// loading b, by role at lock (team projection rank 1-5 = S, 6+ = B), plus a teammate residual t by role pair. A pair in the same game
// correlates g_p g_q + b_p b_q (+ t if teammates). Off unless buildModel gets opts.gameCorr (true = this table, or an object);
// nbac: false drops the NBAC position/tier terms underneath. Fitted 2026-10-21 on 829 games: the blowout is real in the means
// (rank 1-5 players' normal score -0.28 and 26 min vs 31 when the final margin is 26+, bench +0.27) but as a correlation it is
// small: blowout size max(0, |margin| - 8) loads -0.14 on S and +0.09 on B; pace loads ~0 (S -0.025, B 0.075). It matches
// held-out pair correlations better than NBAC (same-team S-B -0.075 observed: NBAC -0.041, factors -0.057) but grades as a
// wash: rank +0.001 vs old model and vs the new spread, top-decile top-10%/top-1% inside seed noise. Kept behind the flag.
export const NBA_GAME = { gS: -0.025, gB: 0.075, bS: -0.142, bB: 0.088, tSS: 0.001, tSB: -0.043, tBB: -0.027, nbac: false };
export function nbaGameCorr(p, q, same, F = NBA_GAME) {
  const sp = p.rank <= 5, sq = q.rank <= 5;
  let v = (sp ? F.gS : F.gB) * (sq ? F.gS : F.gB) + (sp ? F.bS : F.bB) * (sq ? F.bS : F.bB);
  if (same) v += sp && sq ? F.tSS : sp || sq ? F.tSB : F.tBB;
  return v;
}
const POSES = ["QB", "RB", "WR", "TE", "K", "DST"];
function ckey(a, b) { let i = POSES.indexOf(a), j = POSES.indexOf(b); if (i < 0) i = 99; if (j < 0) j = 99; return (i <= j ? a : b) + "|" + (i <= j ? b : a); }

// Lognormal sigma. Capped: a tiny projection with a large std dev would otherwise
// produce absurd tails (a 2-point hitter scoring 50).
export const SIGMA_MAX = 0.6;
export const SIGMA_DEF = {
  // Pitcher value from bench/sweep-mlb.mjs: the one change that held up on both holdout halves of 8 contests.
  mlb: { P: 0.45, SP: 0.45, RP: 0.50, C: 0.70, "1B": 0.70, "2B": 0.70, "3B": 0.70, SS: 0.70, OF: 0.70 },
  // NFL values from bench/sweep-nfl.mjs over the 2026-09-13 classic slates and three showdowns.
  nfl: { QB: 0.55, RB: 0.50, WR: 0.60, TE: 0.65, K: 0.55, DST: 0.85 },
  // Showdown: 0.82x the classic values (2026-09-17, bench/sd-variance.mjs + grade-all over 272 pulled
  // showdowns): the classic sigmas drew lineup spread ~20% wider than realized; at 0.82x the spread and
  // the 30-point tail match, and lineup rank correlation with actual rose 0.082 -> 0.125 (both halves).
  nfl_sd: { QB: 0.45, RB: 0.42, WR: 0.50, TE: 0.55, K: 0.55, DST: 0.65 },
  // CFB: the 0.7x-NFL level that graded best, but with the position shape measured from real results.
  // 3,951 college player-games (bench/game-logs.mjs) put the log-residual spread at QB 0.65, RB 0.84,
  // WR 0.81 - backs are the most volatile position in college, and the old table made them the least.
  // Rescaling that shape to the graded level and grading it on the same 277 contests (2026-09-19):
  // player ROI rank correlation 0.415 -> 0.421 (significant in both window halves), top-decile realized
  // ROI 32% -> 36%, gated rule 31% -> 37%, nothing significantly worse.
  cfb: { QB: 0.327, RB: 0.421, WR: 0.406 },
  // NBA: log-residual spread of 8,817 player-games recovered from 338 pulled 2025-26 classic contests
  // (bench/fit-nba.mjs, 2026-10-19), non-bust games: 0.36 at a 30-point projection for every position
  // (PG .35, SG .36, SF .37, PF .38, C .38), shrinking with the projection about as proj^-0.5 (.44 at 20,
  // .29 at 40, .27 at 50) - see SIGMA_TILT. Basketball is far tighter than football around its projection.
  // Graded on 336 pulled classic contests (grade-all, data/reports/nba): tilted vs flat 0.36 lifts lineup rank correlation
  // 0.133 -> 0.149 and realized top-10% ROI 9% -> 19% (both CIs exclude 0; seed noise +-0.003 / +-5%).
  nba: { PG: 0.36, SG: 0.36, SF: 0.36, PF: 0.36, C: 0.36, G: 0.36, F: 0.36, FLEX: 0.36, UTIL: 0.36 }
};
// Spread shrinks as the projection grows: over 3,951 college player-games the log-residual sd runs
// 0.90 at a 5-10 point projection down to 0.59 above 20, which is very close to proj^-0.35. tilt is
// that exponent, applied around a reference projection so the average player keeps his graded sigma.
// Sigma tilt by sport. Graded on 280 pulled CFB contests (2026-09-19) against a flat sigma:
// lineup rank correlation 0.208 -> 0.229 and cash hits +1.1 per contest, both halves, nothing worse.
// -0.55 kept lifting lineup rank but cost player rank correlation significantly, so the measured
// exponent is also the stop. NFL and MLB are untilted until the same measurement is made there.
// One exponent for every position, not one each: bench/fit-sigma.mjs measures QB -0.67, RB -0.34,
// WR -0.28, and grading those (and a shrunk QB -0.50, RB -0.34, WR -0.30) lifted rank correlation a
// little but moved realized money down in every cut, including the gated rule the app ranks on.
// sigmaFor still accepts a per-position object, so --sigtilt=QB:-0.5,... regrades it on new data.
export const SIGMA_TILT = { cfb: -0.35, nba: -0.5 }, SIGMA_TILT_REF = { cfb: 11.5, nba: 30 };
// Projections run hot on small numbers and cold on large ones: over the same college player-games the
// actual/projected ratio falls from 1.064 below 10 points to about 0.95 above 15. PROJ_TILT is the
// exponent of that shrink toward the middle, and it is empty on purpose. Grading the measured -0.09 on
// 280 CFB contests (2026-09-19) was worse on every quality metric in both window halves: lineup rank
// correlation 0.229 -> 0.216, player 0.425 -> 0.414, cash hits -1.1 per contest. It only moved the sim
// closer to Stokastic, which is not the target. Kept as a graded negative, reachable with --projtilt.
export const PROJ_TILT = {};

// NBA classic sigma by role, from what the pool has at lock (bench/fit-spread-nba.mjs): projection, salary, value (projection
// per $1K) and the player's projection rank on his team (rank 6+ ~ bench). s0 (proj/30)^e (value/5)^v (sal/6000)^sal x bench, capped
// at max, plus an optional bust share (ba, bb, bbench). 13,040 player-games (ESPN box scores x pre-lock Stokastic projections,
// 149 dates, 2026-10-21): spread is set by the projection; salary, value and team rank add nothing once it is in (fitted ~0 on
// both date halves), and the 0.6 cap was binding - under-15 projections run sigma 0.8-1.0. Fitted on the upper half of the
// distribution (censored at 75% of projection) it is tighter for stars and wider for cheap players than the old 0.36 x
// (proj/30)^-0.5: s0 0.32, e -0.69, cap 1.3. Graded on 352 classic contests vs the old sigma (data/reports/nba/spread-corr-nba.txt):
// lineup rank Spearman 0.149 -> 0.183 (+0.035, CI +0.029..+0.041; seed noise 0.002), held-out dates +0.038, every slate size;
// sim top decile finishing top 10% 12.1% -> 12.6% (both seeds). The full-shape fit (censored at 25%, cap 1.2-1.4, with or without
// a bust share) is better calibrated on PIT but graded WORSE (rank -0.011 with bust, -0.023 without): wide stars hurt ranking.
// Default for nba_cl; opts.spread false (or a sigmaTilt / sigmaDef override) goes back to sigmaFor. nba_sd unchanged.
export const NBA_SPREAD = { s0: 0.32, e: -0.69, v: 0, sal: 0, bench: 1, max: 1.3 };
export function nbaSpreadSigma(p, T = NBA_SPREAD) {
  const pr = Math.max(3, p.proj), val = p.sal > 0 ? pr / (p.sal / 1000) : 5;
  return Math.min(T.max ?? SIGMA_MAX, T.s0 * Math.pow(pr / 30, T.e) * Math.pow(Math.max(1, val) / 5, T.v || 0) * Math.pow(Math.max(3000, p.sal || 6000) / 6000, T.sal || 0) * (p.rank > 5 ? T.bench ?? 1 : 1));
}
// bust share of the role draw (a zero, mean kept by the lognormal part): ba (20 / proj)^bb, x bbench for rank 6+; 0 when ba is 0
export function nbaSpreadBust(p, T = NBA_SPREAD) {
  if (!T.ba || !(p.proj > 0)) return 0;
  return Math.min(0.5, T.ba * Math.pow(20 / Math.max(3, p.proj), T.bb ?? 2) * (p.rank > 5 ? T.bbench ?? 1 : 1));
}
// projection rank of each player on his team among players with a projection (1 = highest)
export function teamRanks(P) {
  const by = {}, rk = new Int32Array(P.length).fill(99);
  P.forEach((p, i) => { if (p.proj > 0) (by[p.team] ||= []).push(i); });
  for (const t in by) by[t].sort((a, b) => P[b].proj - P[a].proj).forEach((i, k) => rk[i] = k + 1);
  return rk;
}

export function sigmaFor(p, sport, sigmaMax, sigmaDef, ignoreFile, tilt, tiltRef) {
  const cap = sigmaMax ?? SIGMA_MAX;
  // MLB uses the calibrated per-position values: vendor std dev puts nearly every hitter on the
  // cap anyway and made pitchers too volatile (bench ablation on 2026-09-10 and 09-11, both worse).
  // NBA likewise uses the spread measured from its own results until a vendor Std Dev column is graded against it.
  const fromFile = sport !== "mlb" && sport !== "nba" && !ignoreFile;   // ignoreFile: grade the default-sigma path on a file that carries Std Dev
  if (fromFile && p.sd != null && p.sd > 0 && p.proj > 0) { const r = p.sd / p.proj; return Math.min(cap, Math.sqrt(Math.log(1 + r * r))); }
  if (fromFile && p.ceil != null && p.ceil > p.proj) {
    const L = Math.log(p.ceil / p.proj), z = 1.036, d = z * z - 2 * L;
    if (d > 0) { const s = z - Math.sqrt(d); if (s > 0.05 && s < 2) return s; }
  }
  const def = sigmaDef || SIGMA_DEF[sport] || SIGMA_DEF.nfl;
  const base = def[p.pos] || 0.72;
  const e = typeof tilt === "object" && tilt ? (tilt[p.pos] || 0) : tilt;   // one exponent, or one per position
  if (!e || !(p.proj > 0)) return base;
  return Math.min(cap, base * Math.pow(Math.max(3, p.proj) / (tiltRef || 11.5), e));
}

export function corrOf(p, q, sport, nGames, tables) {
  if (p === q) return 1;
  const T = tables || { CSAME, COPP, MLBC };
  const same = p.team && q.team && p.team === q.team;
  const sameGame = p.gi === q.gi;
  if (sport === "mlb") {
    const C = T.MLBC;
    if (p.isP && q.isP) return sameGame ? C.pitchPitchSameGame : 0;
    if (p.isP || q.isP) {
      const pit = p.isP ? p : q, hit = p.isP ? q : p;
      if (pit.team === hit.team) return C.hitOwnPitcher;
      return sameGame ? C.hitOppPitcher : 0;
    }
    if (same) {
      let base = C.hitSame;
      if (p.ord && q.ord) { let d = Math.abs(p.ord - q.ord); if (d > 4) d = 9 - d; base += C.orderBonus * Math.max(0, (3 - d) / 3); }
      return Math.min(0.95, base);
    }
    return sameGame ? C.hitOppSameGame : 0;
  }
  if (!sameGame && nGames > 1) return 0;
  if (sport === "nba") return nbaCorr(p, q, same, T.NBAC || NBAC);
  const v = (same ? T.CSAME : T.COPP)[ckey(p.pos, q.pos)];
  return v == null ? 0 : v;
}

function jacobi(A, n) {
  const V = []; for (let i = 0; i < n; i++) { V.push(new Float64Array(n)); V[i][i] = 1; }
  const a = A.map(r => Float64Array.from(r));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-10) break;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (Math.abs(a[i][j]) < 1e-13) continue;
      const th = (a[j][j] - a[i][i]) / (2 * a[i][j]);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const aik = a[i][k], ajk = a[j][k]; a[i][k] = c * aik - s * ajk; a[j][k] = s * aik + c * ajk; }
      for (let k = 0; k < n; k++) {
        const aki = a[k][i], akj = a[k][j]; a[k][i] = c * aki - s * akj; a[k][j] = s * aki + c * akj;
        const vki = V[k][i], vkj = V[k][j]; V[k][i] = c * vki - s * vkj; V[k][j] = s * vki + c * vkj;
      }
    }
  }
  return { ev: a.map((r, i) => r[i]), V };
}

// Pairwise matrix repaired to positive-definite, then Cholesky. Factor model above cholMax.
export function buildModel(pool, opts = {}) {
  // NBA always takes the pairwise path: its teammate correlations are negative, which the factor model cannot draw
  const P = pool.players, sport = pool.format.sport, n = P.length, cholMax = opts.cholMax ?? (sport === "nba" ? Infinity : 220);
  // default sigmas are per format when a format table exists (showdown), else per sport
  const sigmaDef = opts.sigmaDef || SIGMA_DEF[pool.format.key] || SIGMA_DEF[sport];
  const tilt = opts.sigmaTilt ?? SIGMA_TILT[sport] ?? 0, tiltRef = opts.sigmaTiltRef ?? SIGMA_TILT_REF[sport];
  // projTilt: projections shrunk toward the middle by (proj/ref)^e, measured from real results
  const pTilt = opts.projTilt ?? PROJ_TILT[sport] ?? 0, pRef = opts.projTiltRef ?? SIGMA_TILT_REF[sport] ?? 11.5;
  let mu = null;
  if (pTilt) { mu = new Float64Array(n); for (let i = 0; i < n; i++) { const pr = P[i].proj; mu[i] = pr > 0 ? pr * Math.pow(Math.max(3, pr) / pRef, pTilt) : pr; } }
  const tail = opts.tail === false ? null : (opts.tail || TAIL[sport] || null);
  const tc = tail ? tail.c : 0, ta = tail ? tail.a : 0;
  const sig = new Float64Array(n); for (let i = 0; i < n; i++) sig[i] = sigmaFor(P[i], sport, opts.sigmaMax, sigmaDef, opts.ignoreFileSigma, tilt, tiltRef);
  // NBA classic role spread (NBA_SPREAD): sigma, and a bust share, by projection, salary and team projection rank
  const spT = pool.format.key !== "nba_cl" || opts.spread === false || (opts.spread == null && (opts.sigmaTilt != null || opts.sigmaDef)) ? null : (opts.spread && opts.spread !== true ? opts.spread : NBA_SPREAD);
  let spP0 = null;
  if (spT) { const rk = teamRanks(P);
    for (let i = 0; i < n; i++) { const q = { proj: P[i].proj, sal: P[i].sal, rank: rk[i] }; sig[i] = nbaSpreadSigma(q, spT); const b = nbaSpreadBust(q, spT); if (b > 0) { if (!spP0) spP0 = new Float64Array(n); spP0[i] = b; } } }
  const minutes = sport === "nba" && opts.minutes !== false ? nbaMinutes(P, sig, Math.max(opts.sigmaMax ?? SIGMA_MAX, spT ? spT.max ?? 0 : 0)) : null;
  // put the mean back: the bend only adds mass above c, so every centre is scaled down to match
  if (ta) { const base = mu; mu = new Float64Array(n);
    for (let i = 0; i < n; i++) { const pr = base ? base[i] : P[i].proj; mu[i] = pr > 0 ? pr * tailFactor(sig[i], tc, ta) : pr; } }
  // zero-inflated draw (BUST): per-player bust probability, or null for the plain lognormal
  const bustTbl = opts.bust === true ? BUST[sport] : (opts.bust || null);
  let p0 = null; if (bustTbl) { p0 = new Float64Array(n); for (let i = 0; i < n; i++) p0[i] = bustProb(P[i], bustTbl); }
  if (spP0) { if (!p0) p0 = new Float64Array(n); for (let i = 0; i < n; i++) p0[i] = 1 - (1 - p0[i]) * (1 - spP0[i]); }
  if (minutes && minutes.p0) { if (!p0) p0 = new Float64Array(n); for (let i = 0; i < n; i++) p0[i] = 1 - (1 - p0[i]) * (1 - minutes.p0[i]); }
  if (n > cholMax) {
    const tbl = (opts.load && opts.load[sport]) || LOAD[sport], L = [];   // opts.load: grade alternative factor loadings without editing the table
    for (const p of P) {
      const l = sport === "mlb" ? (p.isP ? tbl.PIT : tbl.HIT) : (tbl[p.pos] || [0.22, 0.50, 0.05]);
      const ss = l[0] * l[0] + l[1] * l[1] + l[2] * l[2];
      L.push({ g: l[0], t: l[1], o: l[2], e: Math.sqrt(Math.max(0.02, 1 - ss)) });
    }
    return { type: "factor", L, sig, n, mu, tc, ta, p0, minutes };
  }
  const tables = opts.tables || (sport === "cfb" ? { CSAME: CSAME_CFB, COPP: COPP_CFB, MLBC } : null);
  const C = []; for (let i = 0; i < n; i++) C.push(new Float64Array(n));
  const gF = opts.gameCorr && pool.format.key === "nba_cl" ? (opts.gameCorr === true ? NBA_GAME : opts.gameCorr) : null, gRk = gF ? teamRanks(P) : null;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) { C[i][j] = 1; continue; }
    C[i][j] = gF && gF.nbac === false ? 0 : corrOf(P[i], P[j], sport, pool.games.length, tables);
    if (gF && P[i].gi === P[j].gi) C[i][j] += nbaGameCorr({ rank: gRk[i] }, { rank: gRk[j] }, P[i].team === P[j].team, gF);
  }
  const e = jacobi(C, n), D = [];
  for (let i = 0; i < n; i++) D.push(new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let s = 0; for (let k = 0; k < n; k++) { const lam = e.ev[k] < 1e-6 ? 1e-6 : e.ev[k]; s += e.V[i][k] * lam * e.V[j][k]; }
    D[i][j] = s;
  }
  const d = []; for (let i = 0; i < n; i++) d.push(Math.sqrt(D[i][i]) || 1);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) D[i][j] /= d[i] * d[j];
  const Lm = []; for (let i = 0; i < n; i++) Lm.push(new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let sum = D[i][j]; for (let k = 0; k < j; k++) sum -= Lm[i][k] * Lm[j][k];
    if (i === j) Lm[i][j] = Math.sqrt(Math.max(sum, 1e-9)); else Lm[i][j] = sum / (Lm[j][j] || 1e-9);
  }
  return { type: "chol", L: Lm, sig, n, mu, tc, ta, p0, minutes };
}

// NBA availability and minutes risk, from Blick's P(play) and minutes Q20-Q80 (attached per slate by
// bench/blick-nba.mjs as p.pplay 0-1, p.mlo, p.mhi, p.mplay = minutes if he plays). Ungraded: Blick has
// no history from last season, so this is on by request (2026-10-20) until it can be graded; opts.minutes
// false turns it off.
//  - P(play): the projection is P(play) x the if-plays projection, so a DNP is drawn as a zero with
//    probability 1 - P(play) through the p0 split, which keeps the mean at the projection.
//  - minutes: the fitted sigma (0.36 at 30 points) is the slate-typical spread and includes minutes
//    noise. Each player swaps the slate's typical minutes CV for his own: sigma^2 - cvRef^2 + cv^2, with
//    cv = (Q80 - Q20) / 1.683 / minutes-if-plays (Q20-Q80 spans 1.683 sd of a normal) and cvRef the
//    median cv of players projected 15+. Without the columns nothing changes.
export const MIN_CV_MAX = 0.6, PPLAY_MIN = 0.05;
function nbaMinutes(P, sig, cap) {
  const n = P.length, cv = new Float64Array(n).fill(NaN);
  let p0 = null, nAvail = 0, nMin = 0;
  for (let i = 0; i < n; i++) {
    const p = P[i]; if (!(p.proj > 0)) continue;
    if (p.pplay != null && p.pplay < 1) { if (!p0) p0 = new Float64Array(n); p0[i] = 1 - Math.max(PPLAY_MIN, p.pplay); nAvail++; }
    if (p.mlo != null && p.mhi > p.mlo && p.mplay > 0) cv[i] = Math.min(MIN_CV_MAX, (p.mhi - p.mlo) / 1.683 / p.mplay);
  }
  const ref = [...cv].filter((c, i) => c === c && P[i].proj >= 15).sort((a, b) => a - b);
  const cvRef = ref.length >= 8 ? ref[ref.length >> 1] : null;
  if (cvRef != null) for (let i = 0; i < n; i++) if (cv[i] === cv[i]) { sig[i] = Math.min(cap, Math.sqrt(Math.max(0.01, sig[i] * sig[i] - cvRef * cvRef) + cv[i] * cv[i])); nMin++; }
  return (p0 || cvRef != null) ? { p0, cvRef, nAvail, nMin } : null;
}

// A lognormal draw gets the cash line right and the winning score badly wrong: over 60 pulled college
// contests the bar the sim expected to WIN came in 15.9 points under what actually won, while its
// cash line was within a point (bench/winning-score.mjs). Scaling sigma fixes the top only by
// widening the middle too, which pushes the cash line out; scaling correlation does almost nothing.
// What is missing is a fatter right tail at the same centre, which is what football scoring looks
// like - most players land near projection and occasionally one goes off.
// TAIL bends the standard normal upward beyond c standard deviations: z + a(z-c)^2. Below c nothing
// changes at all, so the cash line is untouched, and the mean is put back by tailFactor so the draw
// stays mean-preserving. Cost is one comparison per player per draw.
// Empty on purpose, and the reasoning is worth keeping. The sim's expected WINNING score came in
// 15.9 points under what actually won across 60 contests while its cash line was within a point
// (bench/winning-score.mjs), which looks like a tail that is too thin. Two things say otherwise.
// bench/fit-tail.mjs measures the real residual quantiles: the gap to the normal saturates around
// +0.78 from the 90th percentile up instead of diverging, and the median sits at -0.264 rather than
// 0, which is the signature of a plain mean-preserving lognormal with sigma about 1.3x ours - no
// bend, just more spread. And grading that wider sigma is a disaster for what the app is for:
// lineup rank correlation 0.229 -> 0.165, player 0.425 -> 0.362, cash hits -4.9 per contest.
// The resolution is that the sim under-disperses the field and the candidate equally, so the
// comparison that sets ROI stays consistent - which is why predicted-minus-actual ROI is already
// within 0.1 of zero. A simulated score and a real score are different distributions, and the gap
// between them is not by itself a pricing error. The tight sigma is shrinkage against noisy
// projections, and grading keeps choosing it.
export const TAIL = {};
// Zero-inflated draw. A real MLB hitter-game is nothing like a lognormal around the projection: over
// 8,468 starter player-games (bench/fit-bust-mlb.mjs, 2026-09-30) a 5-7 point hitter scores exactly 0
// in 25% of games (the lognormal draws 0%), and the games that are not zero run wider than the model
// (q90 of actual/projected 2.58 vs 1.92). The fit is a bust mass at zero that shrinks with the
// projection, P(0) = a * (ref / proj)^b, and a mean-preserving lognormal for the rest with its own sigma.
// Starting pitchers show the same shape at a lower rate (early exits, blow-ups floored at zero).
// Off by default until graded: buildModel takes opts.bust (true for BUST[sport], or an object).
// NBA busts (under 25% of projection: early injury exits, blowout benchings) fall off with the projection: 16% under a
// 15-point projection, 3.5% at 15-25, 1.5% at 25-35, 1% above (bench/fit-nba.mjs) -> a 0.035, ref 20, b 2.1.
// Graded off: on 336 classic contests the bust draw cut lineup rank correlation 0.149 -> 0.137 and player 0.422 -> 0.406.
export const BUST = { nba: { PG: { a: 0.035, b: 2.1, ref: 20, max: 0.5 }, SG: { a: 0.035, b: 2.1, ref: 20, max: 0.5 }, SF: { a: 0.035, b: 2.1, ref: 20, max: 0.5 },
  PF: { a: 0.035, b: 2.1, ref: 20, max: 0.5 }, C: { a: 0.035, b: 2.1, ref: 20, max: 0.5 }, hit: { a: 0.035, b: 2.1, ref: 20, max: 0.5 } }, mlb: { hit: { a: 0.258, b: 1.32, ref: 6, max: 0.6 }, pit: { a: 0.077, b: 1.94, ref: 15, max: 0.5 } } };
// NFL bust tables are per position (bench/fit-dist-nfl.mjs); MLB has one for hitters and one for pitchers
export function bustProb(p, tbl) { if (!tbl || !(p.proj > 0)) return 0; const t = tbl[p.pos] || (p.isP ? tbl.pit : tbl.hit); if (!t) return 0; return Math.min(t.max ?? 0.6, t.a * Math.pow(t.ref / p.proj, t.b)); }
// standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7) and quantile (Acklam), for the bust split
export function pnorm(z) { const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return z >= 0 ? 0.5 + 0.5 * y : 0.5 - 0.5 * y; }
const QA = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239], QB = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1], QC = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], QD = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
export function qnorm(p) {
  if (p <= 1e-9) return -6; if (p >= 1 - 1e-9) return 6;
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((QC[0] * q + QC[1]) * q + QC[2]) * q + QC[3]) * q + QC[4]) * q + QC[5]) / ((((QD[0] * q + QD[1]) * q + QD[2]) * q + QD[3]) * q + 1); }
  if (p <= 0.97575) { const q = p - 0.5, r = q * q; return (((((QA[0] * r + QA[1]) * r + QA[2]) * r + QA[3]) * r + QA[4]) * r + QA[5]) * q / (((((QB[0] * r + QB[1]) * r + QB[2]) * r + QB[3]) * r + QB[4]) * r + 1); }
  const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((QC[0] * q + QC[1]) * q + QC[2]) * q + QC[3]) * q + QC[4]) * q + QC[5]) / ((((QD[0] * q + QD[1]) * q + QD[2]) * q + QD[3]) * q + 1);
}
// capped at 5 sigma: a quadratic bend left unbounded sends a 15-point projection to four figures
export const BEND_MAX = 5;
export function bendZ(z, c, a) { if (!a || z <= c) return z; const d = z - c; return Math.min(BEND_MAX, z + a * d * d); }
// E[exp(sg*bend(z) - sg^2/2)] by Simpson over the normal density, cached: sigma takes few distinct
// values in a pool, so this runs a handful of times per contest and never inside the draw loop.
const facCache = new Map();
export function tailFactor(sg, c, a) {
  if (!a) return 1;
  const key = sg.toFixed(4) + "|" + c + "|" + a;
  const hit = facCache.get(key); if (hit !== undefined) return hit;
  const lo = -6, hi = 9, n = 600, h = (hi - lo) / n, k = 1 / Math.sqrt(2 * Math.PI);
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const z = lo + i * h, w = i === 0 || i === n ? 1 : (i % 2 ? 4 : 2);
    s += w * k * Math.exp(-z * z / 2) * Math.exp(sg * bendZ(z, c, a) - sg * sg / 2);
  }
  const e = s * h / 3, f = e > 0 ? 1 / e : 1;
  facCache.set(key, f);
  return f;
}

// mu overrides the projection the draw is centred on, for grading a recalibration of the projections
// themselves. The draw is mean-preserving, so mu is exactly the player's expected score.
export function toScore(p, z, sg, mu, tc, ta, p0 = 0) {
  const m = mu == null ? p.proj : mu;
  if (m <= 0) return 0;
  if (p.pos === "DST") { const sd = p.sd && p.sd > 0 ? p.sd : Math.max(2, m * 0.8); return Math.max(-4, m + sd * z); }
  if (p0 > 0) {
    // bust split on the same correlated normal: the bottom p0 of the distribution is a zero, the rest is
    // the lognormal re-centred so the overall mean stays m
    const u = pnorm(z); if (u < p0) return 0;
    const z2 = qnorm((u - p0) / (1 - p0));
    return m / (1 - p0) * Math.exp(sg * z2 - sg * sg / 2);
  }
  return m * Math.exp(sg * (ta ? bendZ(z, tc, ta) : z) - sg * sg / 2);
}

// Fill `out` with one correlated draw of every player's score.
export function drawScores(model, pool, rng, out, scratch) {
  const P = pool.players, n = model.n, sig = model.sig, mu = model.mu, tc = model.tc, ta = model.ta, p0 = model.p0;
  if (model.type === "chol") {
    const z = scratch.z;
    for (let j = 0; j < n; j++) z[j] = rng.gauss();
    for (let j = 0; j < n; j++) {
      let s = 0; const Lj = model.L[j];
      for (let k = 0; k <= j; k++) s += Lj[k] * z[k];
      out[j] = toScore(P[j], s, sig[j], mu ? mu[j] : undefined, tc, ta, p0 ? p0[j] : 0);
    }
  } else {
    const gF = scratch.gF, tF = scratch.tF, teams = pool.teams;
    for (let j = 0; j < gF.length; j++) gF[j] = rng.gauss();
    for (let j = 0; j < tF.length; j++) tF[j] = rng.gauss();
    for (let j = 0; j < n; j++) {
      const p = P[j], l = model.L[j], oppTi = teams.indexOf(p.opp);
      const s = l.g * gF[p.gi || 0] + l.t * tF[p.ti < 0 ? 0 : p.ti] + (oppTi >= 0 ? l.o * tF[oppTi] : 0) + l.e * rng.gauss();
      out[j] = toScore(p, s, sig[j], mu ? mu[j] : undefined, tc, ta, p0 ? p0[j] : 0);
    }
  }
}
export function makeScratch(model, pool) {
  return { z: new Float64Array(model.n), gF: new Float64Array(pool.games.length || 1), tF: new Float64Array(pool.teams.length || 1) };
}

// How much a lineup moves as one bet: its variance under the correlation model divided by
// the variance it would have if its players were independent. 1 = independent pieces,
// above 1 = the players rise and fall together (one story), below 1 = they hedge each other.
export function lineupCoherence(model, pool, lu, mult) {
  const P = pool.players, w = lu.map((id, q) => (mult ? mult[q] : 1) * P[id].proj * model.sig[id]);
  let indep = 0; for (const x of w) indep += x * x;
  if (!indep) return 1;
  let v = 0;
  if (model.type === "chol") {
    for (let k = 0; k < model.n; k++) { let s = 0; lu.forEach((id, q) => { if (k <= id) s += model.L[id][k] * w[q]; }); v += s * s; }
  } else {
    const teams = pool.teams, g = {}, t = new Float64Array(teams.length || 1);
    lu.forEach((id, q) => { const p = P[id], l = model.L[id]; g[p.gi || 0] = (g[p.gi || 0] || 0) + l.g * w[q]; if (p.ti >= 0) t[p.ti] += l.t * w[q]; const oi = teams.indexOf(p.opp); if (oi >= 0) t[oi] += l.o * w[q]; v += (l.e * w[q]) ** 2; });
    for (const k in g) v += g[k] * g[k]; for (const x of t) v += x * x;
  }
  return v / indep;
}
