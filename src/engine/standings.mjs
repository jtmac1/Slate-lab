// DraftKings contest standings ("Export Lineups to CSV" on My Contests, contest-standings-<id>.csv or
// the .zip it comes in). Left table: Rank, EntryId, EntryName, TimeRemaining, Points, Lineup; after one
// blank column, the right table: Player, Roster Position, %Drafted, FPTS. Lineup is one string of
// "SLOT Name SLOT Name ..." in slot order. During a live contest DraftKings can hide players whose
// games have not started; any slot whose name is blank or LOCKED is kept as hidden (name null).
// Also the duplicate math late swap uses: which entries share your locked players, and how many are
// likely to finish identical to you.
import zlib from "node:zlib";
import { parseCSV, num, nrm } from "./csv.mjs";

const SLOTS = { nfl: ["CPT", "QB", "RB", "WR", "TE", "FLEX", "DST"], mlb: ["P", "C", "1B", "2B", "3B", "SS", "OF"], sd: ["CPT", "FLEX", "UTIL"] };
const HIDDEN = /^(locked|hidden|-+|\?+)?$/i;

// the first .csv inside a zip (stored or deflated); anything else is returned as text
export function standingsText(buf) {
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return buf.toString("utf8");
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a readable zip");
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
    if (!/\.csv$/i.test(name)) continue;
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + size);
    return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
  }
  throw new Error("no csv in the zip");
}

// "QB Jalen Hurts RB Saquon Barkley ... DST Eagles" -> [{ slot, name }]; slots outside the sport's set are part of a name
export function parseLineup(str, slots) {
  const re = new RegExp(`(?:^|\\s+)(${slots.join("|")})(?=\\s|$)`, "g"), s = String(str || "").trim(), marks = [];
  let m; while ((m = re.exec(s))) marks.push({ slot: m[1], at: m.index + m[0].length, from: m.index });
  return marks.map((k, i) => { const name = s.slice(k.at, i + 1 < marks.length ? marks[i + 1].from : s.length).trim(); return { slot: k.slot, name: HIDDEN.test(name) ? null : name }; });
}

export function parseStandings(text, sport = "nfl") {
  const rows = parseCSV(text); if (!rows.length) throw new Error("empty file");
  const h = rows[0].map(x => String(x).trim().toLowerCase()), col = k => h.indexOf(k);
  const iRank = col("rank"), iId = col("entryid"), iName = col("entryname"), iTime = col("timeremaining"), iPts = col("points"), iLu = col("lineup");
  if (iId < 0 || iLu < 0) throw new Error("not a DraftKings contest standings file (no EntryId/Lineup columns)");
  const iPl = col("player"), iRp = col("roster position"), iDr = col("%drafted"), iFp = col("fpts");
  const all = new Set([...SLOTS[sport] || SLOTS.nfl, ...SLOTS.sd]), slotList = [...all].sort((a, b) => b.length - a.length);
  const entries = [], players = [];
  for (const r of rows.slice(1)) {
    const id = String(r[iId] || "").trim();
    if (/^\d+$/.test(id)) {
      const name = String(r[iName] || "").trim();
      entries.push({ rank: num(r[iRank]), entryId: id, entryName: name, user: name.replace(/\s*\(\d+\/\d+\)\s*$/, ""), timeRemaining: num(r[iTime]), points: num(r[iPts]) ?? 0, lineup: parseLineup(r[iLu], slotList) });
    }
    if (iPl >= 0 && String(r[iPl] || "").trim()) players.push({ name: String(r[iPl]).trim(), pos: String(r[iRp] || "").trim(), drafted: num(r[iDr]), fpts: num(r[iFp]) });
  }
  if (!entries.length) throw new Error("no entries in the file");
  return { entries, players, showdown: entries.some(e => e.lineup.some(x => x.slot === "CPT")) };
}

// a lineup slot's identity for matching: captains count separately from the same player at FLEX
const keyOf = (slot, name) => (slot === "CPT" ? "CPT:" : "") + nrm(name);
const bag = list => { const m = new Map(); for (const k of list) m.set(k, (m.get(k) || 0) + 1); return m; };
const sameBag = (a, b) => { if (a.size !== b.size) return false; for (const [k, v] of a) if (b.get(k) !== v) return false; return true; };

// mine: { locked: [{slot,name}], open: [{slot,name,share}] } where share = chance a field entry with the same
// salary left puts that player in that slot (the player's ownership among the fits for the slot).
// field: other entries in the contest from parseStandings. lockedName(name) says whether a visible player's
// game has started. Returns the entries sharing your locked players and the expected count that finish
// identical, plus the same for each swap you could make.
export function dupeCheck(mine, field, lockedName) {
  const core = bag(mine.locked.map(p => keyOf(p.slot, p.name))), openKeys = mine.open.map(p => keyOf(p.slot, p.name));
  const shadows = [];
  for (const o of field) {
    const vis = o.lineup.filter(x => x.name), hidden = o.lineup.length - vis.length;
    const lk = vis.filter(x => lockedName(x.name)), op = vis.filter(x => !lockedName(x.name));
    if (lk.length + hidden + op.length !== mine.locked.length + mine.open.length) continue;
    if (!sameBag(bag(lk.map(x => keyOf(x.slot, x.name))), core)) continue;
    shadows.push({ entryId: o.entryId, user: o.user, points: o.points, hidden, open: op.map(x => keyOf(x.slot, x.name)) });
  }
  // chance a shadow ends with exactly this open set: its visible open players must all be in the set,
  // and each hidden slot is filled with one of the set's remaining players at that player's share
  const pSame = (o, keys, shares) => {
    const want = bag(keys); for (const k of o.open) { if (!want.get(k)) return 0; want.set(k, want.get(k) - 1); }
    if (o.hidden === 0) return [...want.values()].every(v => v === 0) ? 1 : 0;
    let p = 1; keys.forEach((k, i) => { if (want.get(k) > 0) { p *= shares[i]; want.set(k, want.get(k) - 1); } }); return p;
  };
  const shares = mine.open.map(p => Math.min(1, Math.max(0, p.share ?? 0)));
  const expected = shadows.reduce((s, o) => s + pSame(o, openKeys, shares), 0);
  const ifSwap = (idx, cand) => { const keys = openKeys.slice(), sh = shares.slice(); keys[idx] = keyOf(mine.open[idx].slot, cand.name); sh[idx] = Math.min(1, Math.max(0, cand.share ?? 0)); return shadows.reduce((s, o) => s + pSame(o, keys, sh), 0); };
  return { shadows: shadows.length, certain: shadows.filter(o => o.hidden === 0 && pSame(o, openKeys, shares) === 1).length, expected: +expected.toFixed(2), winShare: +(1 / (1 + expected)).toFixed(3), ifSwap, list: shadows };
}
