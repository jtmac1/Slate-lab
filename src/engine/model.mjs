// Outcome model: per-player skewed distributions tied together by a correlation matrix.

export const CSAME = { "QB|QB": 0.00, "QB|RB": 0.15, "QB|WR": 0.60, "QB|TE": 0.45, "QB|K": 0.30, "QB|DST": 0.10,
  "RB|RB": -0.20, "RB|WR": 0.02, "RB|TE": 0.02, "RB|K": 0.15, "RB|DST": 0.20,
  "WR|WR": 0.10, "WR|TE": 0.08, "WR|K": 0.10, "WR|DST": 0.05,
  "TE|TE": 0.10, "TE|K": 0.08, "TE|DST": 0.05, "K|K": -0.30, "K|DST": 0.15, "DST|DST": 0.00 };
export const COPP = { "QB|QB": 0.25, "QB|RB": 0.05, "QB|WR": 0.20, "QB|TE": 0.15, "QB|K": 0.15, "QB|DST": -0.45,
  "RB|RB": -0.05, "RB|WR": 0.03, "RB|TE": 0.03, "RB|K": 0.05, "RB|DST": -0.25,
  "WR|WR": 0.15, "WR|TE": 0.12, "WR|K": 0.12, "WR|DST": -0.35,
  "TE|TE": 0.12, "TE|K": 0.10, "TE|DST": -0.30, "K|K": 0.10, "K|DST": -0.15, "DST|DST": -0.30 };
export const MLBC = { hitSame: 0.15, hitOppSameGame: 0.10, hitOwnPitcher: 0.05, hitOppPitcher: -0.20,
  pitchPitchSameGame: -0.12, orderBonus: 0.08 };
export const LOAD = {
  nfl: { QB: [0.30, 0.70, 0.10], RB: [0.20, 0.48, 0.05], WR: [0.28, 0.62, 0.10], TE: [0.25, 0.55, 0.10], K: [0.20, 0.45, 0.05], DST: [-0.15, 0.30, -0.55] },
  mlb: { HIT: [0.25, 0.52, 0.08], PIT: [-0.30, 0.18, -0.55] }
};
const POSES = ["QB", "RB", "WR", "TE", "K", "DST"];
function ckey(a, b) { let i = POSES.indexOf(a), j = POSES.indexOf(b); if (i < 0) i = 99; if (j < 0) j = 99; return (i <= j ? a : b) + "|" + (i <= j ? b : a); }

// Lognormal sigma. Capped: a tiny projection with a large std dev would otherwise
// produce absurd tails (a 2-point hitter scoring 50).
export const SIGMA_MAX = 0.6;
export function sigmaFor(p, sport, sigmaMax) {
  const cap = sigmaMax ?? SIGMA_MAX;
  if (p.sd != null && p.sd > 0 && p.proj > 0) { const r = p.sd / p.proj; return Math.min(cap, Math.sqrt(Math.log(1 + r * r))); }
  if (p.ceil != null && p.ceil > p.proj) {
    const L = Math.log(p.ceil / p.proj), z = 1.036, d = z * z - 2 * L;
    if (d > 0) { const s = z - Math.sqrt(d); if (s > 0.05 && s < 2) return s; }
  }
  const def = sport === "mlb"
    ? { P: 0.55, SP: 0.55, RP: 0.60, C: 0.60, "1B": 0.60, "2B": 0.60, "3B": 0.60, SS: 0.60, OF: 0.60 }
    : { QB: 0.45, RB: 0.62, WR: 0.72, TE: 0.78, K: 0.42, DST: 0.85 };
  return def[p.pos] || 0.72;
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
  const P = pool.players, sport = pool.format.sport, n = P.length, cholMax = opts.cholMax ?? 220;
  const sig = new Float64Array(n); for (let i = 0; i < n; i++) sig[i] = sigmaFor(P[i], sport, opts.sigmaMax);
  if (n > cholMax) {
    const tbl = LOAD[sport], L = [];
    for (const p of P) {
      const l = sport === "mlb" ? (p.isP ? tbl.PIT : tbl.HIT) : (tbl[p.pos] || [0.22, 0.50, 0.05]);
      const ss = l[0] * l[0] + l[1] * l[1] + l[2] * l[2];
      L.push({ g: l[0], t: l[1], o: l[2], e: Math.sqrt(Math.max(0.02, 1 - ss)) });
    }
    return { type: "factor", L, sig, n };
  }
  const C = []; for (let i = 0; i < n; i++) C.push(new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) C[i][j] = i === j ? 1 : corrOf(P[i], P[j], sport, pool.games.length, opts.tables);
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
  return { type: "chol", L: Lm, sig, n };
}

export function toScore(p, z, sg) {
  if (p.proj <= 0) return 0;
  if (p.pos === "DST") { const sd = p.sd && p.sd > 0 ? p.sd : Math.max(2, p.proj * 0.8); return Math.max(-4, p.proj + sd * z); }
  return p.proj * Math.exp(sg * z - sg * sg / 2);
}

// Fill `out` with one correlated draw of every player's score.
export function drawScores(model, pool, rng, out, scratch) {
  const P = pool.players, n = model.n, sig = model.sig;
  if (model.type === "chol") {
    const z = scratch.z;
    for (let j = 0; j < n; j++) z[j] = rng.gauss();
    for (let j = 0; j < n; j++) {
      let s = 0; const Lj = model.L[j];
      for (let k = 0; k <= j; k++) s += Lj[k] * z[k];
      out[j] = toScore(P[j], s, sig[j]);
    }
  } else {
    const gF = scratch.gF, tF = scratch.tF, teams = pool.teams;
    for (let j = 0; j < gF.length; j++) gF[j] = rng.gauss();
    for (let j = 0; j < tF.length; j++) tF[j] = rng.gauss();
    for (let j = 0; j < n; j++) {
      const p = P[j], l = model.L[j], oppTi = teams.indexOf(p.opp);
      const s = l.g * gF[p.gi || 0] + l.t * tF[p.ti < 0 ? 0 : p.ti] + (oppTi >= 0 ? l.o * tF[oppTi] : 0) + l.e * rng.gauss();
      out[j] = toScore(p, s, sig[j]);
    }
  }
}
export function makeScratch(model, pool) {
  return { z: new Float64Array(model.n), gF: new Float64Array(pool.games.length || 1), tF: new Float64Array(pool.teams.length || 1) };
}
