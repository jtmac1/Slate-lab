import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parseLineup, parseStandings, standingsText, dupeCheck } from "../src/engine/standings.mjs";

const NFL = ["CPT", "QB", "RB", "WR", "TE", "FLEX", "DST"];

test("lineup string splits on slot tokens, keeps hidden slots", () => {
  const lu = parseLineup("QB Jalen Hurts RB Saquon Barkley RB D'Andre Swift WR A.J. Brown WR LOCKED WR  TE Dallas Goedert FLEX LOCKED DST Eagles ", NFL);
  assert.equal(lu.length, 9);
  assert.deepEqual(lu[0], { slot: "QB", name: "Jalen Hurts" });
  assert.equal(lu[2].name, "D'Andre Swift");
  assert.equal(lu[4].name, null); assert.equal(lu[5].name, null); assert.equal(lu[7].name, null);
  assert.deepEqual(lu[8], { slot: "DST", name: "Eagles" });
});

const CSV = [
  "Rank,EntryId,EntryName,TimeRemaining,Points,Lineup,,Player,Roster Position,%Drafted,FPTS",
  `1,111,jtmac1 (1/2),20,30.5,"CPT A One FLEX B Two FLEX C Three FLEX D Four FLEX E Five FLEX F Six",,A One,CPT,40.1%,12`,
  `2,222,shark,20,30.5,"CPT A One FLEX B Two FLEX C Three FLEX LOCKED FLEX LOCKED FLEX LOCKED",,B Two,FLEX,55%,9.5`,
  `3,333,fish,20,30.5,"CPT A One FLEX B Two FLEX C Three FLEX D Four FLEX E Five FLEX F Six",,,,,`,
  `4,444,other,10,20,"CPT B Two FLEX A One FLEX C Three FLEX LOCKED FLEX LOCKED FLEX LOCKED",,,,,`,
  `5,555,jtmac1 (2/2),20,30.5,"CPT A One FLEX B Two FLEX C Three FLEX LOCKED FLEX LOCKED FLEX LOCKED",,,,,`
].join("\n");

test("standings file: entries, user names, player table", () => {
  const S = parseStandings(CSV);
  assert.equal(S.entries.length, 5); assert.equal(S.entries[0].user, "jtmac1"); assert.equal(S.entries[0].entryId, "111");
  assert.equal(S.showdown, true); assert.equal(S.players.length, 2); assert.equal(S.players[0].drafted, 40.1);
  assert.equal(S.entries[1].lineup.filter(x => !x.name).length, 3);
});

test("zip export is unpacked", () => {
  const data = Buffer.from(CSV), def = zlib.deflateRawSync(data), name = Buffer.from("contest-standings-123.csv");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(def.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(def.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + def.length, eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
  const zip = Buffer.concat([local, name, def, cen, name, eocd]);
  assert.equal(standingsText(zip), CSV);
});

test("duplicate check: shadows, certain copies, expected identical, swaps", () => {
  const S = parseStandings(CSV), started = new Set(["A One", "B Two", "C Three"]);
  const me = S.entries[0], field = S.entries.filter(e => e.user !== me.user);
  const mine = { locked: [{ slot: "CPT", name: "A One" }, { slot: "FLEX", name: "B Two" }, { slot: "FLEX", name: "C Three" }],
    open: [{ slot: "FLEX", name: "D Four", share: 0.5 }, { slot: "FLEX", name: "E Five", share: 0.5 }, { slot: "FLEX", name: "F Six", share: 0.8 }] };
  const d = dupeCheck(mine, field, n => started.has(n));
  // shark shares the core with three hidden slots, fish is identical outright; "other" has a different captain
  assert.equal(d.shadows, 2); assert.equal(d.certain, 1);
  assert.equal(d.expected, +(1 + 0.5 * 0.5 * 0.8).toFixed(2));
  // swapping F Six for a 10% player drops fish to zero and shark to 0.5*0.5*0.1
  assert.equal(+d.ifSwap(2, { name: "G Seven", share: 0.1 }).toFixed(3), 0.025);
});
