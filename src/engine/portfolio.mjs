// Choosing a SET of entries for one contest (multi-entry): greedy on the sim's per-iteration payouts (simulate with
// keep: true). Each pick is the lineup that adds the most to the set's objective given the lineups already picked:
//   "ev"   E[sum of payouts]   - same as taking the top N by sim ROI (the baseline)
//   "max"  E[max payout]       - top-heavy contests: a second lineup only counts in draws where it beats the first
//   "cov"  P(any top 1%)       - covers draws (game scripts) the set hasn't won yet
//   "evdiv" top N by sim ROI, but no two picks share more than maxShare players (overlap cap, Hunter/Vielma/Zaman style)
// Draws are scored as if the set's lineups don't push each other down the standings (fine while N is small vs the field).
// Game scripts: per game, every draw is labelled by which team's offense scored more, whether that team's points came
// through the air or the ground, and whether the game's offense total was above its median; a lineup's scripts are the
// ones over-represented (1.5x the base rate, 20%+ share) in the draws where it finishes top 1% (payout-weighted when it
// rarely does).

const OFF = /^(QB|RB|WR|TE)$/;

export function selectPortfolio({ kept, cands, n, objective = "max", lineups, maxShare }) {
  const { pay, t1, stride, iters } = kept, picked = [], used = new Set();
  const cur = new Float64Array(iters), curT = new Uint8Array(iters);
  const ev = k => { let s = 0; const o = k * stride; for (let it = 0; it < iters; it++) s += pay[o + it]; return s / iters; };
  const evOf = new Map(cands.map(k => [k, ev(k)]));
  const share = (a, b) => { const s = new Set(lineups[a]); let c = 0; for (const x of lineups[b]) if (s.has(x)) c++; return c; };
  if (objective === "ev" || objective === "evdiv") {
    const order = cands.slice().sort((a, b) => evOf.get(b) - evOf.get(a));
    for (const k of order) {
      if (picked.length >= n) break;
      if (objective === "evdiv" && maxShare != null && picked.some(p => share(p, k) > maxShare)) continue;
      picked.push(k);
    }
    return picked.map(k => ({ k, gain: evOf.get(k) }));
  }
  const out = [];
  for (let s = 0; s < n; s++) {
    let best = -1, bestG = -Infinity;
    for (const k of cands) {
      if (used.has(k)) continue;
      const o = k * stride; let g = 0;
      if (objective === "max") { for (let it = 0; it < iters; it++) { const d = pay[o + it] - cur[it]; if (d > 0) g += d; } }
      else { for (let it = 0; it < iters; it++) if (t1[o + it] && !curT[it]) g++; }
      g /= iters;
      // ties (no remaining gain, e.g. every top-1% draw already covered): fall back to EV
      g += 1e-9 * evOf.get(k);
      if (g > bestG) { bestG = g; best = k; }
    }
    if (best < 0) break;
    used.add(best); out.push({ k: best, gain: bestG });
    const o = best * stride;
    for (let it = 0; it < iters; it++) { if (pay[o + it] > cur[it]) cur[it] = pay[o + it]; if (t1[o + it]) curT[it] = 1; }
  }
  return out;
}

// Game-script collector: pass as simulate({ onIter: sc.onIter, maxIters }) and call sc.finish() afterwards.
export function scriptCollector(pool, maxIters) {
  const P = pool.players, games = [], gi = new Map();
  for (const p of P) { if (!p.team || !p.opp) continue; const key = [p.team, p.opp].sort().join("@"); if (!gi.has(key)) { gi.set(key, games.length); games.push({ key, teams: [p.team, p.opp].sort() }); } }
  const G = games.length, off = new Float32Array(maxIters * G * 2), air = new Float32Array(maxIters * G * 2);
  const slot = P.map(p => { const g = gi.get([p.team, p.opp].sort().join("@")); if (g == null || !OFF.test(p.pos)) return -1; return g * 2 + (games[g].teams[0] === p.team ? 0 : 1); });
  const isAir = P.map(p => /^(QB|WR|TE)$/.test(p.pos));
  let n = 0;
  const onIter = (it, sc) => { const o = it * G * 2; for (let j = 0; j < P.length; j++) { const s = slot[j]; if (s < 0) continue; off[o + s] += sc[j]; if (isAir[j]) air[o + s] += sc[j]; } n = it + 1; };
  const finish = () => {
    const lab = new Uint8Array(n * G), names = [];
    for (let g = 0; g < G; g++) {
      const tot = [], share = [[], []];
      for (let it = 0; it < n; it++) { const o = it * G * 2 + g * 2; tot.push(off[o] + off[o + 1]); for (const t of [0, 1]) share[t].push(off[o + t] > 0 ? air[o + t] / off[o + t] : 0); }
      const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1], mt = med(tot), ms = [med(share[0]), med(share[1])];
      for (let it = 0; it < n; it++) { const o = it * G * 2 + g * 2, lead = off[o] >= off[o + 1] ? 0 : 1, style = share[lead][it] >= ms[lead] ? 0 : 1, env = tot[it] >= mt ? 0 : 1; lab[it * G + g] = lead * 4 + style * 2 + env; }
      const nm = []; for (const lead of [0, 1]) for (const style of [0, 1]) for (const env of [0, 1]) nm.push(`${games[g].teams[lead]} ${style ? "run" : "pass"}-led ${env ? "low-scoring" : "shootout"}`);
      names.push(nm);
    }
    return { games, lab, names, iters: n, G };
  };
  return { onIter, finish };
}

// a lineup's main game: the QB's game (classic) or the only game (showdown); falls back to the game with most players
export function mainGame(lu, pool, sc) {
  const P = pool.players, count = new Map();
  const gOf = p => sc.games.findIndex(x => x.teams.includes(p.team) && x.teams.includes(p.opp));
  const qb = lu.map(i => P[i]).find(p => p.pos === "QB"); if (qb) return gOf(qb);
  for (const i of lu) { const g = gOf(P[i]); if (g >= 0) count.set(g, (count.get(g) || 0) + 1); }
  let best = -1, bc = 0; for (const [g, c] of count) if (c > bc) { bc = c; best = g; } return best;
}

export function lineupScripts(k, lu, pool, kept, sc) {
  const g = mainGame(lu, pool, sc); if (g < 0) return { game: null, scripts: [] };
  const { pay, t1, stride } = kept, it0 = Math.min(kept.iters, sc.iters), base = new Float64Array(8), hit = new Float64Array(8), o = k * stride;
  let tw = 0, nT = 0; for (let it = 0; it < it0; it++) if (t1[o + it]) nT++;
  for (let it = 0; it < it0; it++) { const s = sc.lab[it * sc.G + g]; base[s]++; const w = nT >= 10 ? t1[o + it] : pay[o + it]; hit[s] += w; tw += w; }
  const scripts = [];
  if (tw > 0) for (let s = 0; s < 8; s++) { const sh = hit[s] / tw, b = base[s] / it0; if (sh >= 0.2 && b > 0 && sh / b >= 1.5) scripts.push({ name: sc.names[g][s], share: +(100 * sh).toFixed(0), lift: +(sh / b).toFixed(1) }); }
  scripts.sort((a, b) => b.share - a.share);
  return { game: sc.games[g].key, scripts };
}

// which scripts the set covers: per script, the share of its draws in which some lineup of the set finishes top 1%
export function setCoverage(picks, pool, kept, sc, lineups) {
  const { t1, stride } = kept, it0 = Math.min(kept.iters, sc.iters), out = [];
  const games = new Set(picks.map(p => mainGame(lineups[p.k], pool, sc)).filter(g => g >= 0));
  for (const g of games) for (let s = 0; s < 8; s++) {
    let n = 0, hit = 0;
    for (let it = 0; it < it0; it++) { if (sc.lab[it * sc.G + g] !== s) continue; n++; if (picks.some(p => t1[p.k * stride + it])) hit++; }
    if (n) out.push({ game: sc.games[g].key, script: sc.names[g][s], draws: n, top1: +(100 * hit / n).toFixed(1) });
  }
  return out;
}
