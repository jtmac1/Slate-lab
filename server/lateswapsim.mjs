// Late swap sim, the Stokastic late-swap shape: one of your entries, its started players locked at
// live points, is completed every sensible way (the best fits for each open slot that keep the salary
// under the cap) and every version is simmed against the REAL contest field from the DraftKings
// standings export, with DraftKings' own payout table. Players the export hides (games not started)
// are filled the way the field would fill them: drawn by ownership among the fits for that slot with
// the salary that entry has left. Copies of your lineup in that field split the prize, so a swap off a
// duplicated lineup shows up as ROI. Runs once per projection source, like the pre-lock sim.
import { nrm } from "../src/engine/csv.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { loadPool, simLineups, keyOf } from "./foursim.mjs";
import { liveActuals } from "./live.mjs";
import { loadStandings } from "./standings.mjs";
import { lobby } from "./entries.mjs";

const MAX_FIELD = 4000, MAX_CANDS = 60, PER_SLOT = 8;
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
  const teams = new Set(hub.rows.map(r => r.team).filter(Boolean)), live = await liveActuals(hub.slate.date, teams);
  const started = new Set(); for (const g of live.games) if (g.started) { started.add(g.away); started.add(g.home); }
  const locked = {}; for (const p of P) if (started.has(p.team)) locked[keyOf(p.name, p.pos, p.team)] = live.byKey[liveKey(p.name, p.pos, p.team)] ?? 0;

  // standings names to pool rows (DST by team nickname as a fallback)
  const byName = new Map(); P.forEach((p, i) => { const k = nrm(p.name); if (!byName.has(k)) byName.set(k, i); });
  const idxOf = name => { const i = byName.get(nrm(name)); if (i != null) return i; const j = P.findIndex(p => isDst(p.pos) && nrm(p.name).endsWith(nrm(name))); return j < 0 ? null : j; };
  const salAt = (i, slot) => slot === "CPT" ? (P[i].csal || Math.round(1.5 * P[i].sal)) : P[i].sal;
  const elig = (i, slot) => sd ? true : slot === "FLEX" ? /^(RB|WR|TE)$/.test(pos0(P[i])) : pos0(P[i]) === slot;
  const openPool = P.map((p, i) => i).filter(i => !started.has(P[i].team) && P[i].sal > 0);
  const minSal = Math.min(...openPool.map(i => P[i].sal));
  // DraftKings lists slots in its own order; the engine wants captain first in showdown and any order in classic (sigOf sorts)
  const order = lu => sd ? [...lu.filter(x => x.slot === "CPT"), ...lu.filter(x => x.slot !== "CPT")] : lu;

  // the field: every other entry (yours left out, so every copy found there is someone else), hidden slots drawn by ownership within that entry's salary left
  const rng = mulberry32(29); let unmatched = 0, filled = 0;
  const fill = lu => {
    const ids = lu.map(x => x.name ? idxOf(x.name) : -1); if (ids.some(i => i == null)) return null;
    const hidden = lu.map((x, k) => k).filter(k => ids[k] === -1); if (!hidden.length) return ids;
    for (let tries = 0; tries < 25; tries++) {
      const out = ids.slice(), used = new Set(out.filter(i => i >= 0)); let left = f.cap - out.reduce((s, i, k) => s + (i >= 0 ? salAt(i, lu[k].slot) : 0), 0), ok = true;
      hidden.forEach((k, h) => {
        if (!ok) return; const slot = lu[k].slot, room = left - (hidden.length - h - 1) * minSal;
        const c = openPool.filter(i => !used.has(i) && elig(i, slot) && salAt(i, slot) <= room), w = c.map(i => Math.max(0.05, slot === "CPT" ? (P[i].cown || P[i].own / 6) : P[i].own));
        const tot = w.reduce((s, x) => s + x, 0); if (!c.length || !(tot > 0)) { ok = false; return; }
        let u = rng() * tot, j = 0; while (j < c.length - 1 && (u -= w[j]) > 0) j++;
        out[k] = c[j]; used.add(c[j]); left -= salAt(c[j], slot);
      });
      if (ok) { filled++; return out; }
    }
    return null;
  };
  let field = []; for (const e of S.entries) { if (e.entryId === me.entryId) continue; const lu = fill(order(e.lineup)); if (lu) field.push(lu); else unmatched++; }
  const N = S.entries.length;
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
  let real = null; try { const { dkPayouts } = await import("../bench/dk-payouts.mjs"); real = await dkPayouts(S.contestId, fee); } catch {}
  const payouts = real ? scalePayouts(real, N, field.length) : null;
  const sim = simLineups(L, lus, { fee, N, contestName: c.name || "", prizePool: c.prizePool, locked, field, payouts, calibrate: false, iters: opts.iters });

  const rows = lus.map((lu, q) => {
    const by = {}; for (const s of sim.sources) by[s] = sim.per[s][q];
    const rois = sim.sources.map(s => by[s].roi), swaps = open.filter(k => lu[k] !== myIds[k]).map(k => ({ slot: mine[k].slot, out: P[myIds[k]].name, in: P[lu[k]].name }));
    return { current: q === 0, swaps, players: lu.map((i, k) => ({ slot: mine[k].slot, name: P[i].name, team: P[i].team, locked: started.has(P[i].team) })), proj: +projSum(lu).toFixed(1), sal: lu.reduce((s, i, k) => s + salAt(i, mine[k].slot), 0),
      roi: Object.fromEntries(sim.sources.map(s => [s, by[s].roi])), mean: +(rois.reduce((a, b) => a + b, 0) / rois.length).toFixed(1), worst: Math.min(...rois), win: +(sim.sources.reduce((a, s) => a + by[s].win, 0) / sim.sources.length).toFixed(3), t1: +(sim.sources.reduce((a, s) => a + by[s].t1, 0) / sim.sources.length).toFixed(2), cash: +(sim.sources.reduce((a, s) => a + by[s].cash, 0) / sim.sources.length).toFixed(1), copies: by[sim.sources[0]].dupN };
  });
  rows.sort((a, b) => b.mean - a.mean);
  return { entryId: me.entryId, contestId: S.contestId, contest: c.name || `Contest ${S.contestId}`, fee, N, fieldN: field.length, unmatched, filledHidden: filled, payouts: real ? "DraftKings" : "fitted curve", sources: sim.sources, candidates: cands.length, rows, ms: Date.now() - t0, at: new Date().toISOString() };
}
