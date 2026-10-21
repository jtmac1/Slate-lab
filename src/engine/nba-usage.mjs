// NBA late scratch: when a player is ruled OUT and the projections have not caught up, hand K x his projection to teammates in
// proportion to w = proj^gamma x position factor (same position 1 / adjacent / far, by DK position distance), teammates projected
// over floor only. gamma 0 fitted: every rotation teammate gets an equal base share, tilted to the OUT player's position. Pure.
// Parameters fitted on 2025-26 ESPN box scores by bench/fit-usage-nba.mjs (odd dates; held-out check in data/reports/nba/usage-nba.txt).
const ORD = { PG: 1, SG: 2, SF: 3, PF: 4, C: 5, G: 1.5, F: 3.5 };
export const USAGE = { K: 0.5, same: 1, adj: 0.5, far: 0.25, gamma: 0, floor: 5 };
const nm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");

const posVal = pos => { const v = String(pos || "").split("/").map(x => ORD[x.trim().toUpperCase()]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
export const posDist = (a, b) => { const x = posVal(a), y = posVal(b); return x == null || y == null ? null : Math.abs(x - y); };
const factor = (d, P) => d == null ? P.adj : d <= 0.75 ? P.same : d <= 1.75 ? P.adj : P.far;

// players: [{name, team, pos, proj}] (other fields kept); outNames: names ruled OUT, their proj = what they were expected to score.
// Returns { players: copies in the same order (OUT -> proj 0, teammates -> proj + gain), moves: [{name, team, from, to, gain, out}] }.
export function reproject(players, outNames, P = USAGE) {
  const outs = new Set((outNames || []).map(nm)), res = players.map(p => ({ ...p })), moves = [];
  for (const o of players.filter(p => outs.has(nm(p.name)))) {
    const A = o.proj > 0 ? o.proj : 0; if (!A) continue;
    const mates = res.map((p, i) => i).filter(i => res[i].team === o.team && !outs.has(nm(res[i].name)) && players[i].proj > Math.max(0, P.floor || 0));
    const w = mates.map(i => Math.pow(players[i].proj, P.gamma) * factor(posDist(players[i].pos, o.pos), P)), W = w.reduce((a, b) => a + b, 0);
    if (!(W > 0)) continue;
    mates.forEach((i, k) => { const g = P.K * A * w[k] / W; if (g > 0) { res[i].proj += g; moves.push({ name: res[i].name, team: res[i].team, gain: g, out: o.name }); } });
  }
  res.forEach((p, i) => { if (outs.has(nm(p.name))) p.proj = 0; });
  const agg = new Map(); for (const m of moves) { const a = agg.get(m.name) || { name: m.name, team: m.team, gain: 0, out: [] }; a.gain += m.gain; a.out.push(m.out); agg.set(m.name, a); }
  const from = new Map(players.map(p => [p.name, p.proj]));
  return { players: res, moves: [...agg.values()].map(m => ({ ...m, from: from.get(m.name), to: from.get(m.name) + m.gain, out: [...new Set(m.out)].join("+") })).sort((a, b) => b.gain - a.gain) };
}
