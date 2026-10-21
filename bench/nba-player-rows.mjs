// Shared loader for the NBA classic player-level fits (fit-own-error-nba, fit-proj-bias-nba): one row per player per
// slate (2025-26). Slate = date + team set; projected / actual ownership pooled over the slate's classic contests,
// entries-weighted (absent from a contest = 0). Actual DK points, minutes and recent history from the ESPN box
// score cache data/nba-pbp (bench/backtest-lateswap-nba.mjs --fetch). Everything but act/dnp/aown is known pre-lock.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { listPost, readPost } from "./post-store.mjs";

export const nm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");
export const bucketOf = g => g <= 4 ? "small" : g <= 7 ? "medium" : "large";
export const BUCKETS = ["small", "medium", "large"];
const gzr = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
const dk = s => { const tens = [s.pts, s.reb, s.ast, s.stl, s.blk].filter(x => x >= 10).length;
  return s.pts + 0.5 * s.tpm + 1.25 * s.reb + 1.5 * s.ast + 2 * s.stl + 2 * s.blk - 0.5 * s.to + (tens >= 2 ? 1.5 : 0) + (tens >= 3 ? 3 : 0); };

export function loadRows({ from = "2025-10-01", to = "2026-07-01" } = {}) {
  // slates
  const S = new Map();
  for (const f of listPost("nba")) {
    const j = readPost(f), c = j.contest; if (/showdown/i.test(c.type + " " + c.name) || c.date < from || c.date >= to || !j.players?.length) continue;
    const P = j.players.filter(p => p.sal > 0 && p.pos && p.pos !== "CPT"); if (P.length < 16) continue;
    const teams = [...new Set(P.map(p => p.team))].sort(), k = c.date + "|" + teams.join(",");
    const s = S.get(k) || { key: k, date: c.date, games: teams.length / 2, contests: [] }; s.contests.push({ e: Math.max(1, c.entries || j.lineups.length), fee: c.fee, P }); S.set(k, s);
  }
  // box scores: per normalized name, games in date order {date, team, min, starter, dk}; per ESPN team, game dates
  const box = new Map(), teamDates = new Map(), byLast = new Map(), last = n => nm(String(n).replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, "").split(" ").pop());
  for (const f of fs.readdirSync("data/nba-pbp").filter(f => /^g-/.test(f))) {
    const g = gzr(path.join("data/nba-pbp", f));
    for (const t of g.box) { (teamDates.get(t.team) || teamDates.set(t.team, new Set()).get(t.team)).add(g.date); const L = t.labels;
      for (const a of t.ath) { const o = a.dnp ? null : Object.fromEntries(L.map((l, i) => [l, a.stats[i]]));
        const r = { date: g.date, team: t.team, starter: a.starter, dnp: a.dnp, min: o ? +o.MIN || 0 : 0,
          dk: o ? dk({ pts: +o.PTS, tpm: +String(o["3PT"]).split("-")[0], reb: +o.REB, ast: +o.AST, to: +o.TO, stl: +o.STL, blk: +o.BLK }) : 0 };
        const k = nm(a.name); (box.get(k) || box.set(k, []).get(k)).push(r); (byLast.get(g.date + "|" + t.team) || byLast.set(g.date + "|" + t.team, []).get(g.date + "|" + t.team)).push([last(a.name), k]); } }
  }
  for (const l of box.values()) l.sort((a, b) => a.date.localeCompare(b.date));
  for (const [t, d] of teamDates) teamDates.set(t, [...d].sort());
  // DK -> ESPN team abbreviation by co-occurrence
  const co = {};
  for (const s of S.values()) for (const p of s.contests[0].P) { const g = (box.get(nm(p.name)) || []).find(b => b.date === s.date); if (g) { const m = co[p.team] || (co[p.team] = {}); m[g.team] = (m[g.team] || 0) + 1; } }
  const espnTeam = Object.fromEntries(Object.entries(co).map(([k, m]) => [k, Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]]));
  // nickname mismatches (Nic/Nicolas Claxton): same team + last name, unique on that date
  const alias = new Map();
  for (const s of S.values()) for (const p of s.contests[0].P) { if (box.has(nm(p.name)) || alias.has(nm(p.name))) continue;
    const c = (byLast.get(s.date + "|" + espnTeam[p.team]) || []).filter(x => x[0] === last(p.name)); if (c.length === 1) alias.set(nm(p.name), c[0][1]); }
  const key = n => alias.get(nm(n)) || nm(n);
  // rows
  const lastSal = new Map(), rows = [], slates = [...S.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of slates) {
    const E = s.contests.reduce((a, c) => a + c.e, 0), acc = new Map();
    for (const c of s.contests) for (const p of c.P) { const r = acc.get(p.id) || acc.set(p.id, { ...p, pw: 0, aw: 0 }).get(p.id); r.pw += c.e * p.pown; r.aw += c.e * p.aown; }
    const P = [...acc.values()].map(p => ({ ...p, pown: 100 * p.pw / E, aown: 100 * p.aw / E })).filter(p => p.proj > 0);
    const chalkN = P.filter(p => p.pown >= 20).length, teamProj = {}, teamOwn = {};
    for (const t of new Set(P.map(p => p.team))) { const tp = P.filter(p => p.team === t).map(p => p.proj).sort((a, b) => b - a); teamProj[t] = tp.slice(0, 8).reduce((a, b) => a + b, 0); }
    const meanTP = Object.values(teamProj).reduce((a, b) => a + b, 0) / Object.keys(teamProj).length;
    for (const p of P) teamOwn[p.team] = (teamOwn[p.team] || 0) + p.pown;
    const byOwn = [...P].sort((a, b) => b.pown - a.pown); byOwn.forEach((p, i) => { p.chalkRank = i; });
    const byVal = [...P].sort((a, b) => b.proj / b.sal - a.proj / a.sal); byVal.forEach((p, i) => { p.valRank = i; });
    for (const p of P) {
      const hist = (box.get(key(p.name)) || []), prior = hist.filter(b => b.date < s.date), played = prior.filter(b => !b.dnp && b.min > 0), l5 = played.slice(-5);
      const today = hist.find(b => b.date === s.date), et = espnTeam[p.team], td = et ? (teamDates.get(et) || []) : [], prevTeamDate = td.filter(d => d < s.date).pop();
      const prevG = prevTeamDate ? prior.find(b => b.date === prevTeamDate) : null;
      const ls = lastSal.get(nm(p.name));
      rows.push({ slate: s.key, date: s.date, games: s.games, bucket: bucketOf(s.games), entries: E, nContests: s.contests.length, id: p.id, name: p.name, pos: p.pos.split("/")[0], posStr: p.pos, team: p.team, opp: p.opp,
        sal: p.sal, proj: p.proj, pown: p.pown, aown: p.aown, value: p.proj / (p.sal / 1000), chalkRank: p.chalkRank, valRank: p.valRank, chalkN, nPlayers: P.length,
        teamOwnOther: teamOwn[p.team] - p.pown, teamProjRel: teamProj[p.team] / meanTP, oppProjRel: (teamProj[p.opp] || meanTP) / meanTP,
        priceChg: ls && ls.date < s.date ? (p.sal - ls.sal) / 1000 : 0, hasPrevSal: !!(ls && ls.date < s.date),
        gp: played.length, l5Min: l5.length ? l5.reduce((a, b) => a + b.min, 0) / l5.length : null, l5Dk: l5.length ? l5.reduce((a, b) => a + b.dk, 0) / l5.length : null,
        missedPrev: prevTeamDate ? (!prevG || prevG.dnp || prevG.min === 0) : false, startedPrev: !!(prevG && prevG.starter && !prevG.dnp), knownPrev: !!prevTeamDate,
        act: today ? today.dk : null, dnp: today ? (today.dnp || today.min === 0) : null, min: today ? today.min : null, starter: today ? today.starter : null });
    }
    for (const p of P) lastSal.set(nm(p.name), { date: s.date, sal: p.sal });
  }
  return { rows, slates: slates.length };
}

// alternate dates: fold 0 / 1
export const foldOf = rows => { const d = [...new Set(rows.map(r => r.date))].sort(), m = new Map(d.map((x, i) => [x, i % 2])); return r => m.get(r.date); };
export function ols(X, Y, ridge = 1e-6, W) {
  const p = X[0].length, A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < X.length; i++) { const w = W ? W[i] : 1; for (let a = 0; a < p; a++) { A[a][p] += w * X[i][a] * Y[i]; for (let b = 0; b < p; b++) A[a][b] += w * X[i][a] * X[i][b]; } }
  for (let a = 1; a < p; a++) A[a][a] += ridge * X.length;
  for (let c = 0; c < p; c++) { let pv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r; [A[c], A[pv]] = [A[pv], A[c]]; const d = A[c][c] || 1e-9; for (let k = 0; k <= p; k++) A[c][k] /= d; for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c]; for (let k = 0; k <= p; k++) A[r][k] -= f * A[c][k]; } }
  return A.map(r => r[p]);
}
export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
// slate-block bootstrap of a per-row difference (mean over rows), 95% CI
export function bootCI(R, f, B = 1000) {
  const by = new Map(); for (const r of R) (by.get(r.slate) || by.set(r.slate, []).get(r.slate)).push(f(r));
  const G = [...by.values()].map(a => [a.reduce((x, y) => x + y, 0), a.length]); let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = []; for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < G.length; i++) { const g = G[Math.floor(rnd() * G.length)]; s += g[0]; n += g[1]; } out.push(s / n); }
  out.sort((a, b) => a - b); return [out[Math.floor(0.025 * B)], out[Math.floor(0.975 * B)]];
}
