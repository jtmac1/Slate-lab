// Late swap: once early games have kicked off, every entry is re-simulated with its started players
// locked at their live points (foursim with opts.locked), and each still-open slot gets the best
// replacements that fit the salary left, ranked by the Lab/consensus projection with ownership
// alongside. With a DraftKings contest standings export loaded (server/standings.mjs), each entry
// also gets its duplicate check: the field entries that share its locked players, how many are likely
// to finish identical to it, and the same count for every swap. Entries come from the imported
// DKEntries file, or straight from the standings export for the user's DraftKings name when nothing
// was imported. Nothing is written: the pre-lock record in entries.json stays as it was.
import { hubData } from "./sources.mjs";
import { loadEntries, lobby } from "./entries.mjs";
import { fourSourceSim } from "./foursim.mjs";
import { liveActuals } from "./live.mjs";
import { loadStandings, pickUpStandings, summary } from "./standings.mjs";
import { dupeCheck } from "../src/engine/standings.mjs";
import { nrm } from "../src/engine/csv.mjs";
import { FORMATS } from "../src/engine/formats.mjs";

const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
const keyOf = (name, pos, team) => (isDst(pos) ? "dst" : nrm(name)) + "|" + team;
const liveKey = (name, pos, team) => (isDst(pos) ? "DST" : nrm(name)) + "|" + team;

// the user's entries rebuilt from a standings export: names to the slate's rows for team, position and salary
function fromStandings(hub, standings, user, sd) {
  const byName = new Map(); for (const r of hub.rows) byName.set(nrm(r.name), r);
  const L = lobby(), out = [], u = String(user || "").trim().toLowerCase(); if (!u) return out;
  for (const s of standings) for (const e of s.entries) {
    if (e.user.toLowerCase() !== u) continue;
    const players = e.lineup.map(x => { const r = x.name && byName.get(nrm(x.name)), cpt = x.slot === "CPT"; return r ? { name: r.name, pos: r.pos, team: r.team, slot: x.slot, isCpt: cpt, sal: Math.round((r.sal || 0) * (cpt ? 1.5 : 1)), own: cpt ? (r.stk?.cptOwn ?? null) : (r.own ?? null) } : null; });
    if (players.some(p => !p)) continue;
    // put them in the format's slot order (QB RB RB WR WR WR TE FLEX DST / CPT FLEX x5); late swap reads slots by position
    const want = (sd ? FORMATS.nfl_sd : FORMATS.nfl_cl).slots, left = players.slice(), ordered = want.map(sl => { const i = left.findIndex(p => p.slot === sl || (sd && sl === "FLEX" && p.slot !== "CPT")); return i < 0 ? null : left.splice(i, 1)[0]; });
    if (ordered.some(p => !p)) continue; players.splice(0, players.length, ...ordered);
    const c = L.get(String(s.contestId)) || {}, sal = players.reduce((a, p) => a + p.sal, 0);
    out.push({ ok: true, entryId: e.entryId, sig: players.map(p => p.name + (p.isCpt ? "*" : "")).sort().join("|"), contest: c.name || `Contest ${s.contestId}`, fee: c.fee ?? null, verdict: null, players, left: (sd ? FORMATS.nfl_sd : FORMATS.nfl_cl).cap - sal, fromStandings: true });
  }
  return out;
}

export async function lateSwap(dir, opts = {}) {
  const hub = hubData(dir), sd = hub.slate.type === "SHOWDOWN", f = FORMATS[sd ? "nfl_sd" : "nfl_cl"];
  try { pickUpStandings(dir); } catch {}
  const standings = loadStandings(dir);
  const E = loadEntries(dir); let good = E.entries.filter(e => e.ok);
  if (!good.length) good = fromStandings(hub, standings, opts.user, sd);
  if (!good.length) throw new Error(standings.length ? "no entries imported, and none in the standings for that DraftKings name" : "no entries imported and no contest standings loaded");
  const teams = new Set(hub.rows.map(r => r.team).filter(Boolean));
  const live = await liveActuals(hub.slate.date, teams);
  const started = new Set(), finals = new Set(); for (const g of live.games) if (g.started) { started.add(g.away); started.add(g.home); if (g.final) { finals.add(g.away); finals.add(g.home); } }
  // lock every player on a started team at live points (0 if the box score has no line for him)
  const locked = {}; for (const r of hub.rows) if (started.has(r.team)) locked[keyOf(r.name, r.pos, r.team)] = live.byKey[liveKey(r.name, r.pos, r.team)] ?? 0;
  const simmed = started.size && !good.some(e => e.fromStandings) ? fourSourceSim(dir, { locked, noSave: true }) : null;
  const projOf = r => r.lab ?? r.cons ?? r.stk?.proj ?? 0;
  const open = hub.rows.filter(r => !started.has(r.team) && (r.sal || 0) > 0 && projOf(r) > 0);
  // a visible player in the standings is locked when his team has started (names match the slate's rows)
  const teamByName = new Map(hub.rows.map(r => [nrm(r.name), r.team])), lockedName = n => started.has(teamByName.get(nrm(n)));
  const contestOf = new Map(); for (const s of standings) for (const e of s.entries) contestOf.set(e.entryId, s);
  const out = good.map(e => {
    const se = simmed ? simmed.entries.find(x => x.entryId === e.entryId && x.sig === e.sig) : null;
    const players = e.players.map((p, j) => { const lk = started.has(p.team), pts = lk ? (live.byKey[liveKey(p.name, p.pos, p.team)] ?? 0) * (p.isCpt ? 1.5 : 1) : null; const row = hub.rows.find(r => keyOf(r.name, r.pos, r.team) === keyOf(p.name, p.pos, p.team)); return Object.assign({}, p, { locked: lk, final: finals.has(p.team), pts: pts == null ? null : +pts.toFixed(1), proj: row ? +((p.isCpt ? 1.5 : 1) * projOf(row)).toFixed(1) : p.proj, slotIdx: j }); });
    const lockedPts = players.reduce((s, p) => s + (p.pts || 0), 0), openProj = players.filter(p => !p.locked).reduce((s, p) => s + (p.proj || 0), 0);
    // swap candidates per open slot: same slot eligibility, fits the cap with the salary left, not already in the lineup
    const inLu = new Set(players.map(p => keyOf(p.name, p.pos, p.team)));
    const swaps = players.filter(p => !p.locked).map(p => {
      const slot = f.slots[p.slotIdx], elig = r => sd ? true : slot === "FLEX" ? /^(RB|WR|TE)$/.test(r.pos.split("/")[0]) : r.pos.split("/")[0] === slot;
      const budget = (p.sal || 0) + e.left, mult = p.isCpt ? 1.5 : 1, ownOf = r => p.isCpt ? (r.stk?.cptOwn ?? null) : (r.own ?? null);
      const fits = open.filter(r => elig(r) && Math.round((r.sal || 0) * mult) <= budget && !(r.inj && /Out|Doubtful|IR/i.test(r.inj.status)));
      // share: a player's ownership among everyone who fits this slot, the chance a copy of your core picks him here
      const ownSum = fits.reduce((s, r) => s + (ownOf(r) || 0), 0);
      const shareOf = o => ownSum > 0 ? (o || 0) / ownSum : 0;
      const cands = fits.filter(r => !inLu.has(keyOf(r.name, r.pos, r.team)))
        .map(r => ({ name: r.name, pos: r.pos, team: r.team, opp: r.opp, sal: Math.round((r.sal || 0) * mult), own: ownOf(r), share: +shareOf(ownOf(r)).toFixed(3), proj: +(mult * projOf(r)).toFixed(1), gain: +(mult * projOf(r) - (p.proj || 0)).toFixed(1), inj: r.inj ? r.inj.status : "" }))
        .sort((a, b) => b.proj - a.proj).slice(0, 6);
      return { slot, slotIdx: p.slotIdx, current: p.name, currentProj: p.proj, currentOwn: p.own, share: +shareOf(p.own).toFixed(3), budget, cands };
    });
    // duplicate check against the contest's standings export, when one with this entry is loaded
    let dupes = null; const S = contestOf.get(String(e.entryId));
    if (S && swaps.length) {
      const me = S.entries.find(x => x.entryId === String(e.entryId)), field = S.entries.filter(x => x.entryId !== String(e.entryId) && x.user !== me.user), mineCopies = S.entries.filter(x => x.entryId !== String(e.entryId) && x.user === me.user);
      const slotName = p => p.isCpt ? "CPT" : (sd ? "FLEX" : f.slots[p.slotIdx]);
      const mine = { locked: players.filter(p => p.locked).map(p => ({ slot: slotName(p), name: p.name })), open: swaps.map(s => ({ slot: slotName(players[s.slotIdx]), name: s.current, share: s.share })) };
      const d = dupeCheck(mine, field, lockedName), own = dupeCheck(mine, mineCopies, lockedName);
      swaps.forEach((s, i) => s.cands.forEach(c => { c.dupes = +d.ifSwap(i, c).toFixed(2); }));
      dupes = { contestId: S.contestId, at: S.at, shadows: d.shadows, certain: d.certain, expected: d.expected, winShare: d.winShare, yours: own.shadows, rank: me.rank, points: me.points };
    }
    return { entryId: e.entryId, contest: e.contest, fee: e.fee, verdict: e.verdict, players, lockedPts: +lockedPts.toFixed(1), openProj: +openProj.toFixed(1), total: +(lockedPts + openProj).toFixed(1), left: e.left, sim: se ? se.sim : null, swaps, dupes };
  });
  return { at: live.at, games: live.games, started: [...started], locked: Object.keys(locked).length, entries: out, sources: simmed ? simmed.sim.sources : [], standings: standings.map(summary), fromStandings: good.some(e => e.fromStandings) };
}
