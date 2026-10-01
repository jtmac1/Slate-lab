// Late swap: once early games have kicked off, every entry is re-simulated with its started players
// locked at their live points (foursim with opts.locked), and each still-open slot gets the best
// replacements that fit the salary left, ranked by the Lab/consensus projection with ownership
// alongside. Nothing is written: the pre-lock record in entries.json stays as it was.
import { hubData } from "./sources.mjs";
import { loadEntries } from "./entries.mjs";
import { fourSourceSim } from "./foursim.mjs";
import { liveActuals } from "./live.mjs";
import { nrm } from "../src/engine/csv.mjs";
import { FORMATS } from "../src/engine/formats.mjs";

const isDst = p => /^(DST|D|DEF)$/i.test(p || "");
const keyOf = (name, pos, team) => (isDst(pos) ? "dst" : nrm(name)) + "|" + team;
const liveKey = (name, pos, team) => (isDst(pos) ? "DST" : nrm(name)) + "|" + team;

export async function lateSwap(dir) {
  const hub = hubData(dir), sd = hub.slate.type === "SHOWDOWN", f = FORMATS[sd ? "nfl_sd" : "nfl_cl"];
  const E = loadEntries(dir), good = E.entries.filter(e => e.ok); if (!good.length) throw new Error("no entries imported");
  const teams = new Set(hub.rows.map(r => r.team).filter(Boolean));
  const live = await liveActuals(hub.slate.date, teams);
  const started = new Set(), finals = new Set(); for (const g of live.games) if (g.started) { started.add(g.away); started.add(g.home); if (g.final) { finals.add(g.away); finals.add(g.home); } }
  // lock every player on a started team at live points (0 if the box score has no line for him)
  const locked = {}; for (const r of hub.rows) if (started.has(r.team)) locked[keyOf(r.name, r.pos, r.team)] = live.byKey[liveKey(r.name, r.pos, r.team)] ?? 0;
  const simmed = started.size ? fourSourceSim(dir, { locked, noSave: true }) : null;
  const projOf = r => r.lab ?? r.cons ?? r.stk?.proj ?? 0;
  const open = hub.rows.filter(r => !started.has(r.team) && (r.sal || 0) > 0 && projOf(r) > 0);
  const out = good.map(e => {
    const se = simmed ? simmed.entries.find(x => x.entryId === e.entryId && x.sig === e.sig) : null;
    const players = e.players.map((p, j) => { const lk = started.has(p.team), pts = lk ? (live.byKey[liveKey(p.name, p.pos, p.team)] ?? 0) * (p.isCpt ? 1.5 : 1) : null; const row = hub.rows.find(r => keyOf(r.name, r.pos, r.team) === keyOf(p.name, p.pos, p.team)); return Object.assign({}, p, { locked: lk, final: finals.has(p.team), pts: pts == null ? null : +pts.toFixed(1), proj: row ? +((p.isCpt ? 1.5 : 1) * projOf(row)).toFixed(1) : p.proj, slotIdx: j }); });
    const lockedPts = players.reduce((s, p) => s + (p.pts || 0), 0), openProj = players.filter(p => !p.locked).reduce((s, p) => s + (p.proj || 0), 0);
    // swap candidates per open slot: same slot eligibility, fits the cap with the salary left, not already in the lineup
    const inLu = new Set(players.map(p => keyOf(p.name, p.pos, p.team)));
    const swaps = players.filter(p => !p.locked).map(p => {
      const slot = f.slots[p.slotIdx], elig = r => sd ? true : slot === "FLEX" ? /^(RB|WR|TE)$/.test(r.pos.split("/")[0]) : r.pos.split("/")[0] === slot;
      const budget = (p.sal || 0) + e.left, mult = p.isCpt ? 1.5 : 1;
      const cands = open.filter(r => elig(r) && !inLu.has(keyOf(r.name, r.pos, r.team)) && Math.round((r.sal || 0) * mult) <= budget && !(r.inj && /Out|Doubtful|IR/i.test(r.inj.status)))
        .map(r => ({ name: r.name, pos: r.pos, team: r.team, opp: r.opp, sal: Math.round((r.sal || 0) * mult), own: p.isCpt ? (r.stk?.cptOwn ?? null) : (r.own ?? null), proj: +(mult * projOf(r)).toFixed(1), gain: +(mult * projOf(r) - (p.proj || 0)).toFixed(1), inj: r.inj ? r.inj.status : "" }))
        .sort((a, b) => b.proj - a.proj).slice(0, 6);
      return { slot, current: p.name, currentProj: p.proj, currentOwn: p.own, budget, cands };
    });
    return { entryId: e.entryId, contest: e.contest, fee: e.fee, verdict: e.verdict, players, lockedPts: +lockedPts.toFixed(1), openProj: +openProj.toFixed(1), total: +(lockedPts + openProj).toFixed(1), left: e.left, sim: se ? se.sim : null, swaps };
  });
  return { at: live.at, games: live.games, started: [...started], locked: Object.keys(locked).length, entries: out, sources: simmed ? simmed.sim.sources : [] };
}
