// Your-lineup builder: greedy value picks with randomness, exposure caps, uniqueness,
// force / exclude lists and (MLB) a primary stack size.
import { eligible } from "./formats.mjs";
import { lineupOK, sigOf, overlap } from "./lineups.mjs";

export function buildLineups(pool, cfg, rng) {
  const P = pool.players, f = pool.format, slots = f.slots, ns = slots.length, np = P.length, teams = pool.teams;
  const force = new Set((cfg.force || []).map(Number)), exclude = new Set((cfg.exclude || []).map(Number));
  const el = [], cheap = [];
  for (let s = 0; s < ns; s++) {
    const list = []; let mn = Infinity;
    for (let i = 0; i < np; i++) {
      if (exclude.has(i) || P[i].proj <= 0 || !eligible(P[i], slots[s], f)) continue;
      list.push(i); const c = (f.mult && s === 0) ? P[i].csal : P[i].sal; if (c < mn) mn = c;
    }
    el.push(list); cheap.push(mn === Infinity ? 0 : mn);
  }
  for (let s = 0; s < ns; s++) if (!el[s].length) return { lineups: [], err: "No eligible players for slot " + slots[s] + "." };
  const suf = new Float64Array(ns + 1); for (let s = ns - 1; s >= 0; s--) suf[s] = suf[s + 1] + cheap[s];
  const baseVal = p => { const ceil = p.ceil != null && p.ceil > 0 ? p.ceil : p.proj * 1.6; return cfg.obj === "ceil" ? ceil : cfg.obj === "blend" ? (p.proj + ceil) / 2 : p.proj; };
  const out = [], sig = {}, expo = {}; let tries = 0; const max = cfg.n * 120;
  const maxUse = Math.max(1, Math.ceil(cfg.n * (cfg.maxExp || 100) / 100));
  const v = new Float64Array(np);
  const stackSize = f.sport === "mlb" ? (cfg.stackSize || 0) : 0;
  const stackTeams = cfg.stackTeams && cfg.stackTeams.length ? cfg.stackTeams : teams;
  while (out.length < cfg.n && tries < max) {
    tries++;
    for (let i = 0; i < np; i++) v[i] = baseVal(P[i]) * (1 + (cfg.rand || 0) * (rng() * 2 - 1));
    let stackTeam = null;
    if (stackSize) { stackTeam = stackTeams[Math.floor(rng() * stackTeams.length)]; for (let i = 0; i < np; i++) if (!P[i].isP && P[i].team === stackTeam) v[i] *= 1.6; }
    const used = new Uint8Array(np), lu = []; let sal = 0, ok = true; const tc = {}, pitchOpp = {};
    for (let s = 0; s < ns; s++) {
      const budget = f.cap - sal - suf[s + 1], m = f.mult ? f.mult[s] : 1;
      let best = -1, bv = -1e18;
      for (const id of el[s]) {
        if (used[id]) continue;
        const p = P[id];
        if (!force.has(id) && (expo[id] || 0) >= maxUse) continue;
        const cost = (f.mult && s === 0) ? p.csal : p.sal;
        if (cost > budget) continue;
        if (f.maxHitPerTeam && !p.isP && (tc[p.team] || 0) >= f.maxHitPerTeam) continue;
        if (f.sport === "mlb" && !p.isP && pitchOpp[p.team]) continue;
        let val = v[id] * m; if (force.has(id)) val += 1e6;
        if (val > bv) { bv = val; best = id; }
      }
      if (best < 0) { ok = false; break; }
      const bp = P[best]; used[best] = 1; lu.push(best); sal += (f.mult && s === 0) ? bp.csal : bp.sal;
      if (!bp.isP) tc[bp.team] = (tc[bp.team] || 0) + 1;
      if (f.sport === "mlb" && bp.isP && bp.opp) pitchOpp[bp.opp] = 1;
    }
    if (!ok || sal < (cfg.minSal || 0)) continue;
    if (!lineupOK(lu, P, f, teams)) continue;
    if (force.size && ![...force].every(id => lu.includes(id))) continue;
    if (stackSize && stackTeam && (tc[stackTeam] || 0) < stackSize) continue;
    const k = sigOf(lu, f); if (sig[k]) continue;
    if (cfg.minUniq > 0 && out.some(o => ns - overlap(lu, o) < cfg.minUniq)) continue;
    sig[k] = 1; out.push(lu); for (const id of lu) expo[id] = (expo[id] || 0) + 1;
  }
  return { lineups: out, tries };
}
