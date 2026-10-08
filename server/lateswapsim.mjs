// Late swap sim, the Stokastic late-swap shape: one of your entries, its started players locked at
// live points, is completed every sensible way (the best fits for each open slot that keep the salary
// under the cap) and every version is simmed against the REAL contest field from the DraftKings
// standings export, with DraftKings' own payout table. Players the export hides (games not started)
// are filled the way the field would fill them: drawn by ownership among the fits for that slot with
// the salary that entry has left. Copies of your lineup in that field split the prize, so a swap off a
// duplicated lineup shows up as ROI. Runs once per projection source, like the pre-lock sim.
//
// The export carries what no pre-lock sim has: DraftKings' own points so far and the real %Drafted of
// every player, including the ones still hidden. Started players are locked at the export's points
// (ESPN's box score only when a player is missing there), and hidden slots are filled against each
// player's real ownership still unaccounted for, so the filled field owns every late player at his
// real rate. A chalk player who busted early sinks every lineup that has him, which the sim sees, and
// the live view shows which late players the entries still in contention hold.
import { nrm } from "../src/engine/csv.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { loadPool, simLineups, keyOf } from "./foursim.mjs";
import { liveActuals } from "./live.mjs";
import { loadStandings } from "./standings.mjs";
import { playerTable } from "../src/engine/standings.mjs";
import { lobby } from "./entries.mjs";

const MAX_FIELD = 4000, MAX_CANDS = 60, PER_SLOT = 8, LEAVE = 2000;
const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
const liveKey = (name, pos, team) => (isDst(pos) ? "DST" : nrm(name)) + "|" + team;
const pos0 = p => String(p.pos || "").split("/")[0];

// DraftKings' payouts per place (fee units) squeezed onto a smaller field: each place gets the average of the places it stands for
export function scalePayouts(pay, N, n) {
  if (n >= N) return Float64Array.from(pay.length >= n ? pay.slice(0, n) : [...pay, ...new Array(n - pay.length).fill(0)]);
  const out = new Float64Array(n), w = N / n;
  for (let r = 0; r < n; r++) { const a = Math.floor(r * w), b = Math.max(a + 1, Math.floor((r + 1) * w)); let s = 0; for (let k = a; k < b; k++) s += pay[k] || 0; out[r] = s / (b - a); }
  return out;
}

export async function lateSwapSim(dir, opts = {}) {
  const t0 = Date.now(), L = loadPool(dir), P = L.pool.players, f = L.pool.format, sd = L.sd, hub = L.hub;
  const S = loadStandings(dir).find(s => s.entries.some(e => e.entryId === String(opts.entryId)));
  if (!S) throw new Error("load the DraftKings standings export for this entry's contest first");
  const me = S.entries.find(e => e.entryId === String(opts.entryId));
  // standings names to pool rows (DST by team nickname as a fallback)
  const byName = new Map(); P.forEach((p, i) => { const k = nrm(p.name); if (!byName.has(k)) byName.set(k, i); });
  const idxOf = name => { const i = byName.get(nrm(name)); if (i != null) return i; const j = P.findIndex(p => isDst(p.pos) && nrm(p.name).endsWith(nrm(name))); return j < 0 ? null : j; };
  const T = playerTable(S), realBy = new Map(); for (const [, r] of T) { const i = idxOf(r.name); if (i != null && !realBy.has(i)) realBy.set(i, r); }
  // started: ESPN's scoreboard, plus any team with a player showing in someone else's lineup (DraftKings only shows started players)
  const teams = new Set(hub.rows.map(r => r.team).filter(Boolean)); let live = { games: [], byKey: {} }, espn = true;
  try { live = await liveActuals(hub.slate.date, teams); } catch { espn = false; }
  const started = new Set(); for (const g of live.games) if (g.started) { started.add(g.away); started.add(g.home); }
  for (const e of S.entries) if (e.user !== me.user) for (const x of e.lineup) if (x.name) { const i = idxOf(x.name); if (i != null) started.add(P[i].team); }
  const locked = {}, ptsFrom = { dk: 0, espn: 0, none: 0 };
  P.forEach((p, i) => { if (!started.has(p.team)) return; const dk = realBy.get(i)?.fpts, es = live.byKey[liveKey(p.name, p.pos, p.team)]; locked[keyOf(p.name, p.pos, p.team)] = dk ?? es ?? 0; ptsFrom[dk != null ? "dk" : es != null ? "espn" : "none"]++; });
  const ptsOf = i => locked[keyOf(P[i].name, P[i].pos, P[i].team)] || 0;
  const salAt = (i, slot) => slot === "CPT" ? (P[i].csal || Math.round(1.5 * P[i].sal)) : P[i].sal;
  const elig = (i, slot) => sd ? true : slot === "FLEX" ? /^(RB|WR|TE)$/.test(pos0(P[i])) : pos0(P[i]) === slot;
  const openPool = P.map((p, i) => i).filter(i => !started.has(P[i].team) && P[i].sal > 0);
  const minSal = Math.min(...openPool.map(i => P[i].sal)), openMax = Math.max(...openPool.map(i => P[i].sal));
  // DraftKings lists slots in its own order; the engine wants captain first in showdown and any order in classic (sigOf sorts)
  const order = lu => sd ? [...lu.filter(x => x.slot === "CPT"), ...lu.filter(x => x.slot !== "CPT")] : lu;

  // the field: every other entry (yours left out, so every copy found there is someone else). Each hidden
  // slot is drawn among the fits for the salary that entry has left, weighted by the player's real
  // ownership not yet placed (real %Drafted x entries, less the times he already shows), entries taken
  // in random order, so the filled field ends up owning each late player at his real rate. Without a
  // player table in the export, the projected ownership is the weight instead.
  const N = S.entries.length, rng = mulberry32(29), real = [...realBy].some(([i, r]) => !started.has(P[i].team) && r.own != null);
  const need = new Float64Array(P.length), needC = new Float64Array(P.length);
  if (real) for (const [i, r] of realBy) { need[i] = (r.own || 0) * N / 100; needC[i] = (r.cpt || 0) * N / 100; }
  if (real) for (const e of S.entries) for (const x of e.lineup) if (x.name) { const i = idxOf(x.name); if (i == null) continue; if (x.slot === "CPT") needC[i]--; else need[i]--; }
  const wOf = (i, slot) => real ? Math.max(0.02, slot === "CPT" ? needC[i] : need[i]) : Math.max(0.05, slot === "CPT" ? (P[i].cown || P[i].own / 6) : P[i].own);
  let unmatched = 0, filled = 0;
  const fill = lu => {
    const ids = lu.map(x => x.name ? idxOf(x.name) : -1); if (ids.some(i => i == null)) return null;
    const hidden = lu.map((x, k) => k).filter(k => ids[k] === -1); if (!hidden.length) return ids;
    for (let tries = 0; tries < 25; tries++) {
      const out = ids.slice(), used = new Set(out.filter(i => i >= 0)); let left = f.cap - out.reduce((s, i, k) => s + (i >= 0 ? salAt(i, lu[k].slot) : 0), 0), ok = true;
      // slots in a random order each try, so no slot always gets first pick of the salary
      const hs = hidden.slice(); for (let a = hs.length - 1; a > 0; a--) { const b = Math.floor(rng() * (a + 1)); [hs[a], hs[b]] = [hs[b], hs[a]]; }
      hs.forEach((k, h) => {
        if (!ok) return; const slot = lu[k].slot, room = left - (hidden.length - h - 1) * minSal, floor = left - (hidden.length - h - 1) * openMax - LEAVE;
        // entries spend nearly all their salary: the last slots take what keeps the lineup within LEAVE of the cap when something does
        let c = openPool.filter(i => !used.has(i) && elig(i, slot) && salAt(i, slot) <= room); const spend = c.filter(i => salAt(i, slot) >= floor); if (spend.length) c = spend;
        const w = c.map(i => wOf(i, slot));
        const tot = w.reduce((s, x) => s + x, 0); if (!c.length || !(tot > 0)) { ok = false; return; }
        let u = rng() * tot, j = 0; while (j < c.length - 1 && (u -= w[j]) > 0) j++;
        out[k] = c[j]; used.add(c[j]); left -= salAt(c[j], slot);
      });
      if (ok) { filled++; for (const k of hidden) { if (lu[k].slot === "CPT") needC[out[k]]--; else need[out[k]]--; } return out; }
    }
    return null;
  };
  const others = S.entries.filter(e => e.entryId !== me.entryId), perm = others.map((e, k) => k);
  for (let k = perm.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [perm[k], perm[j]] = [perm[j], perm[k]]; }
  const filledLu = new Array(others.length); for (const k of perm) { filledLu[k] = fill(order(others[k].lineup)); if (!filledLu[k]) unmatched++; }
  let field = filledLu.filter(Boolean);
  // the live field: where every entry stands now (DraftKings' points) and where it is headed (its points
  // plus what its open slots should score with the salary it has left: a least-squares line of
  // projection on salary across the late players, weighted by ownership, so a lineup's projection
  // never leans on how its hidden slots happened to be filled). Contenders are the top tenth by that.
  const fmult = k => sd && k === 0 ? 1.5 : 1, ownR = (i, cpt) => { const r = realBy.get(i); return r ? (cpt ? r.cpt : r.own) : null; };
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0; for (const i of openPool) { const w = Math.max(0.5, ownR(i) ?? P[i].own ?? 1), x = P[i].sal, y = P[i].proj || 0; sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; }
  const fb = sw && (sxx * sw - sx * sx) ? (sxy * sw - sx * sy) / (sxx * sw - sx * sx) : 0, fa = sw ? (sy - fb * sx) / sw : 0, maxSal = Math.max(...openPool.map(i => P[i].sal));
  const standing = (ids, lu) => { let now = 0, sal = 0, slots = 0; ids.forEach((i, k) => { if (i >= 0 && started.has(P[i].team)) { now += ptsOf(i) * fmult(k); sal += salAt(i, lu[k].slot); } else slots += fmult(k); }); const left = Math.min(f.cap - sal, slots * maxSal); return { now, fin: now + (slots ? Math.max(0, slots * fa + fb * left) : 0) }; };
  const pos = others.map((e, k) => { const lu = order(e.lineup), ids = lu.map(x => x.name ? (idxOf(x.name) ?? -1) : -1); return Object.assign(standing(ids, lu), { k }); });
  const mineLu = order(me.lineup), mineIds = mineLu.map(x => idxOf(x.name) ?? -1);
  const myNow = mineIds.reduce((s, i, k) => s + (i >= 0 && started.has(P[i].team) ? ptsOf(i) * fmult(k) : 0), 0), myFin = myNow + mineIds.reduce((s, i, k) => s + (i >= 0 && !started.has(P[i].team) ? (P[i].proj || 0) * fmult(k) : 0), 0);
  const byFin = pos.slice().sort((a, b) => b.fin - a.fin), nC = Math.max(1, Math.round(byFin.length / 10)), cont = byFin.slice(0, nC), cut = cont[cont.length - 1]?.fin ?? 0;
  const inMine = new Set(mineIds.filter(i => i >= 0));
  const startedRows = [], lateRows = [], held = (list, test) => list.reduce((n, c) => n + (test(c) ? 1 : 0), 0);
  for (const [i] of realBy) {
    const p = P[i], own = ownR(i) ?? 0, cpt = ownR(i, true) ?? 0; if (own + cpt < 3) continue;
    if (started.has(p.team)) {
      const has = c => order(others[c.k].lineup).some(x => x.name && idxOf(x.name) === i);
      startedRows.push({ name: p.name, team: p.team, pos: pos0(p), own: +(own + cpt).toFixed(1), pts: +ptsOf(i).toFixed(1), proj: +(p.proj || 0).toFixed(1), mine: inMine.has(i), contOwn: +(100 * held(cont, has) / nC).toFixed(1) });
    } else {
      const has = c => (filledLu[c.k] || []).includes(i);
      const fl = filledLu.filter(Boolean);
      lateRows.push({ name: p.name, team: p.team, pos: pos0(p), sal: p.sal, own: +(own + cpt).toFixed(1), filled: +(100 * held(fl, lu => lu.includes(i)) / Math.max(1, fl.length)).toFixed(1), proj: +(p.proj || 0).toFixed(1), mine: inMine.has(i), contOwn: +(100 * held(cont.filter(c => filledLu[c.k]), has) / Math.max(1, cont.filter(c => filledLu[c.k]).length)).toFixed(1) });
    }
  }
  startedRows.sort((a, b) => b.own - a.own); lateRows.sort((a, b) => b.own - a.own);
  const liveView = { real, ptsFrom, espn, now: +myNow.toFixed(1), fin: +myFin.toFixed(1), aheadNow: +(100 * held(pos, c => c.now < myNow) / Math.max(1, pos.length)).toFixed(0), aheadFin: +(100 * held(pos, c => c.fin < myFin) / Math.max(1, pos.length)).toFixed(0),
    contenders: nC, cut: +cut.toFixed(1), youContend: myFin >= cut, started: startedRows.slice(0, 15), late: lateRows.slice(0, 20) };

  if (field.length > MAX_FIELD) { const keep = []; const step = field.length / MAX_FIELD; for (let k = 0; k < MAX_FIELD; k++) keep.push(field[Math.floor(k * step)]); field = keep; }

  // your versions: started players stay, each open slot takes one of its best fits, salary under the cap
  const mine = order(me.lineup), myIds = mine.map(x => idxOf(x.name)); if (myIds.some(i => i == null)) throw new Error("a player in your lineup is not in the slate's pool: " + mine.filter((x, k) => myIds[k] == null).map(x => x.name).join(", "));
  const open = mine.map((x, k) => k).filter(k => !started.has(P[myIds[k]].team));
  if (!open.length) throw new Error("every slot in this entry is locked");
  const fixedSal = mine.reduce((s, x, k) => s + (open.includes(k) ? 0 : salAt(myIds[k], x.slot)), 0), mult = k => mine[k].slot === "CPT" ? 1.5 : 1;
  const choices = open.map(k => { const slot = mine[k].slot, c = openPool.filter(i => elig(i, slot)).sort((a, b) => mult(k) * P[b].proj - mult(k) * P[a].proj).slice(0, PER_SLOT); if (!c.includes(myIds[k])) c.push(myIds[k]); return c; });
  const cands = [], seen = new Set(), cur = myIds.slice();
  (function walk(d, lu, sal) {
    if (cands.length > 20000) return;
    if (d === open.length) { if (sal > f.cap) return; const s = sigOf(lu, f); if (seen.has(s)) return; seen.add(s); cands.push(lu.slice()); return; }
    const k = open[d]; for (const i of choices[d]) { if (lu.some((x, q) => q !== k && x === i)) continue; const prev = lu[k]; lu[k] = i; walk(d + 1, lu, sal + salAt(i, mine[k].slot)); lu[k] = prev; }
  })(0, cur.slice(), fixedSal);
  const projSum = lu => lu.reduce((s, i, k) => s + (started.has(P[i].team) ? (locked[keyOf(P[i].name, P[i].pos, P[i].team)] || 0) : P[i].proj) * mult(k), 0);
  cands.sort((a, b) => projSum(b) - projSum(a));
  const curSig = sigOf(myIds, f), lus = [myIds, ...cands.filter(lu => sigOf(lu, f) !== curSig).slice(0, MAX_CANDS - 1)];

  // DraftKings' payout table for the contest (public contest API), else the fitted curve from the lobby's prize pool
  const c = lobby().get(String(S.contestId)) || {}, fee = c.fee || opts.fee || 20;
  let dkPay = null; try { const { dkPayouts } = await import("../bench/dk-payouts.mjs"); dkPay = await dkPayouts(S.contestId, fee); } catch {}
  const payouts = dkPay ? scalePayouts(dkPay, N, field.length) : null;
  const sim = simLineups(L, lus, { fee, N, contestName: c.name || "", prizePool: c.prizePool, locked, field, payouts, calibrate: false, iters: opts.iters });

  const rows = lus.map((lu, q) => {
    const by = {}; for (const s of sim.sources) by[s] = sim.per[s][q];
    const rois = sim.sources.map(s => by[s].roi), swaps = open.filter(k => lu[k] !== myIds[k]).map(k => ({ slot: mine[k].slot, out: P[myIds[k]].name, in: P[lu[k]].name }));
    return { current: q === 0, swaps, players: lu.map((i, k) => ({ slot: mine[k].slot, name: P[i].name, team: P[i].team, locked: started.has(P[i].team) })), proj: +projSum(lu).toFixed(1), sal: lu.reduce((s, i, k) => s + salAt(i, mine[k].slot), 0),
      roi: Object.fromEntries(sim.sources.map(s => [s, by[s].roi])), mean: +(rois.reduce((a, b) => a + b, 0) / rois.length).toFixed(1), worst: Math.min(...rois), win: +(sim.sources.reduce((a, s) => a + by[s].win, 0) / sim.sources.length).toFixed(3), t1: +(sim.sources.reduce((a, s) => a + by[s].t1, 0) / sim.sources.length).toFixed(2), cash: +(sim.sources.reduce((a, s) => a + by[s].cash, 0) / sim.sources.length).toFixed(1), copies: by[sim.sources[0]].dupN, ownOpen: +open.reduce((a, k) => a + (ownR(lu[k], mine[k].slot === "CPT") ?? P[lu[k]].own ?? 0), 0).toFixed(1) };
  });
  rows.sort((a, b) => b.mean - a.mean);
  return { entryId: me.entryId, contestId: S.contestId, contest: c.name || `Contest ${S.contestId}`, fee, N, fieldN: field.length, unmatched, filledHidden: filled, payouts: dkPay ? "DraftKings" : "fitted curve", sources: sim.sources, candidates: cands.length, rows, live: liveView, ms: Date.now() - t0, at: new Date().toISOString() };
}
