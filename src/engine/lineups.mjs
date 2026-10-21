import { nrm } from "./csv.mjs";
import { eligible } from "./formats.mjs";

export function sigOf(lu, f) {
  return (f.mult ? lu[0] + "#" : "") + lu.slice(f.mult ? 1 : 0).slice().sort((a, b) => a - b).join(",");
}
export function salOf(lu, P, f) {
  let s = 0; lu.forEach((id, j) => { s += (f.mult && j === 0) ? P[id].csal : P[id].sal; }); return s;
}
export function projOf(lu, P, f) {
  let s = 0; lu.forEach((id, j) => { s += (f.mult ? f.mult[j] : 1) * P[id].proj; }); return s;
}
export function ownSum(lu, P, f) {
  let s = 0; lu.forEach((id, j) => { s += (f.mult && j === 0) ? P[id].cown : P[id].fown; }); return s;
}
// Hitter (or skill-player) counts by team, largest first: "5-3", "4-2-2".
export function stackOf(lu, P, f) {
  const tc = {};
  for (const id of lu) {
    const p = P[id];
    if (f.sport === "mlb" && p.isP) continue;
    if (f.sport === "nfl" && (p.pos === "DST" || p.pos === "K")) continue;
    if (!p.team) continue;
    tc[p.team] = (tc[p.team] || 0) + 1;
  }
  return Object.values(tc).sort((a, b) => b - a).join("-") || "-";
}
export function stackTeams(lu, P, f) {
  const tc = {};
  for (const id of lu) {
    const p = P[id];
    if (f.sport === "mlb" && p.isP) continue;
    if (!p.team) continue;
    tc[p.team] = (tc[p.team] || 0) + 1;
  }
  return Object.entries(tc).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
export function overlap(a, b) {
  const s = new Set(a); let n = 0; for (const x of b) if (s.has(x)) n++; return n;
}
export function lineupOK(lu, P, f, teams) {
  if (f.bothTeams && teams.length > 1) {
    let a = 0, b = 0;
    for (const id of lu) { if (P[id].ti === 0) a++; else b++; }
    if (!a || !b) return false;
  }
  if (f.minGames) {
    const g = {}; let n = 0;
    for (const id of lu) { if (!g[P[id].gi]) { g[P[id].gi] = 1; n++; } }
    if (n < f.minGames) return false;
  }
  if (f.maxHitPerTeam) {
    const tc = {};
    for (const id of lu) { const p = P[id]; if (p.isP) continue; tc[p.team] = (tc[p.team] || 0) + 1; if (tc[p.team] > f.maxHitPerTeam) return false; }
  }
  return true;
}

// Assign players to slots (bipartite matching). Returns ordered lineup or null.
export function assignSlots(ids, P, f) {
  const slots = f.slots, n = slots.length;
  if (ids.length !== n) return null;
  // Showdown: the given order is the slot order (captain first); matching would reverse it.
  if (f.anySlot) return ids.slice();
  const match = new Array(n).fill(-1); // slot -> player index in ids
  const tryPlayer = (k, seen) => {
    for (let s = 0; s < n; s++) {
      if (seen[s] || !eligible(P[ids[k]], slots[s], f)) continue;
      seen[s] = 1;
      if (match[s] < 0 || tryPlayer(match[s], seen)) { match[s] = k; return true; }
    }
    return false;
  };
  for (let k = 0; k < n; k++) if (!tryPlayer(k, new Uint8Array(n))) return null;
  return match.map(k => ids[k]);
}

// Late-swap order: the same players re-slotted so later tips sit in the flex slots (UTIL first, then
// G/F/FLEX), where a late scratch can be replaced by almost anyone; earlier tips take the fixed
// positions. tipOf(p) is minutes after midnight (null when unknown). Exhaustive over valid assignments,
// keeping the given order on ties; showdown and lineups with no known tips come back unchanged.
const SWAP_W = { UTIL: 2, FLEX: 1, SFLEX: 1, G: 1, F: 1 };
export function lateSwapOrder(lu, P, f, tipOf) {
  if (f.anySlot) return lu;
  const tip = lu.map(id => tipOf(P[id])); if (tip.every(t => t == null)) return lu;
  const t0 = Math.min(...tip.filter(t => t != null)), rel = tip.map(t => t == null ? 0 : t - t0);
  const n = f.slots.length, used = new Uint8Array(n), cur = new Array(n);
  let best = lu, bestV = -1;
  const value = order => order.reduce((s, k, i) => s + rel[k] * (SWAP_W[f.slots[i]] || 0), 0);
  bestV = value(lu.map((_, i) => i));
  const go = s => {
    if (s === n) { const v = value(cur); if (v > bestV + 1e-9) { bestV = v; best = cur.map(k => lu[k]); } return; }
    for (let k = 0; k < n; k++) if (!used[k] && eligible(P[lu[k]], f.slots[s], f)) { used[k] = 1; cur[s] = k; go(s + 1); used[k] = 0; }
  };
  go(0);
  return best;
}

// Match rows of names (optionally "Name (id)") to pool indices. Returns {lineups, missing}.
export function matchLineups(rows, P, f) {
  const need = f.slots.length, byKey = {};
  P.forEach((p, i) => { if (byKey[p.key] == null) byKey[p.key] = i; });
  const lineups = [], missing = {};
  for (const row of rows) {
    if (row.length < need) continue;
    const ids = []; let ok = true;
    for (let i = 0; i < need; i++) {
      const nm = String(row[i] || "").trim();
      const idx = byKey[nrm(nm)];
      if (idx == null) { ok = false; if (nm) missing[nm] = (missing[nm] || 0) + 1; break; }
      ids.push(idx);
    }
    if (ok) lineups.push(ids);
  }
  return { lineups, missing };
}
