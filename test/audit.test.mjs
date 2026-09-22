import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS } from "../src/engine/formats.mjs";
import { parseEntries, auditPortfolio } from "../src/engine/audit.mjs";

// A small MLB pool: three pitchers, ten hitters on three teams. Names carry the shape DraftKings
// exports ("Name (id)"), and the pool keys must match after nrm() strips the parentheses.
const mk = (name, pos, team, proj, sal, own) => ({ name, key: name.toLowerCase(), pos, posList: [pos], team, proj, sal, csal: sal * 1.5, own, fown: own, cown: own / 6, isP: pos === "SP" });
const P = [
  mk("ace one", "SP", "AAA", 18, 9000, 30), mk("ace two", "SP", "BBB", 17, 9500, 25), mk("arm three", "SP", "CCC", 16, 10800, 15), mk("arm nine", "SP", "AAA", 9, 6000, 3),
  mk("cat a", "C", "AAA", 8, 3500, 10), mk("first a", "1B", "AAA", 8, 4000, 10), mk("second a", "2B", "AAA", 8, 3500, 10), mk("third a", "3B", "AAA", 8, 3000, 10), mk("short a", "SS", "AAA", 8, 3000, 10),
  mk("out a", "OF", "AAA", 8, 3500, 10), mk("out b1", "OF", "BBB", 9, 5000, 20), mk("out b2", "OF", "BBB", 9, 5000, 20), mk("out c1", "OF", "CCC", 7, 3500, 5), mk("short c", "SS", "CCC", 7, 2000, 5)
];
const f = FORMATS.mlb_cl;
const rules = { rules: [{ id: "stack5", hard: true, rule: "" }, { id: "pitcher_top3", hard: true, rule: "" }, { id: "salary", hard: false, rule: "use at least $48,500" }, { id: "no_self_dupe", hard: true, rule: "" }] };
const row = (id, names) => `${id},MLB $40K Full Count,195900001,$55,${names.join(",")}`;
const HDR = "Entry ID,Contest Name,Contest ID,Entry Fee,P,P,C,1B,2B,3B,SS,OF,OF,OF";
// 5 AAA hitters + 2 BBB + 1 CCC, both aces: legal, full stack, top pitchers, $49,000
const good = ["ace one (1)", "ace two (2)", "cat a (5)", "first a (6)", "second a (7)", "third a (8)", "short a (9)", "out c1 (13)", "out b1 (11)", "out b2 (12)"];
// same hitters but the second pitcher is the #4 arm: still passes pitcher_top3 (one top-3 arm), gets the off-board warning
const softP = ["ace one (1)", "arm nine (4)", "cat a (5)", "first a (6)", "second a (7)", "third a (8)", "short a (9)", "out c1 (13)", "out b1 (11)", "out b2 (12)"];
// only 4 AAA hitters: fails stack5; also under the salary floor
const thin = ["ace one (1)", "ace two (2)", "cat a (5)", "first a (6)", "second a (7)", "third a (8)", "short c (14)", "out c1 (13)", "out b1 (11)", "out b2 (12)"];

test("parseEntries finds the slot block in a DraftKings/Stokastic entry export and skips reservations", () => {
  const text = [HDR, row(1, good), "2,MLB $40K Full Count,195900001,$55,,,,,,,,,,", "3,,,,,,,,,,,,,,1. Column A lists all of your contest entries"].join("\n");
  const p = parseEntries(text, f);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].contest, "MLB $40K Full Count");
  assert.equal(p.entries[0].names.length, 10);
});

test("auditPortfolio checks stack, pitchers, cap, floor and self-duplicates, and builds exposure", () => {
  const text = [HDR, row(1, good), row(2, good), row(3, softP), row(4, thin)].join("\n");
  const a = auditPortfolio(parseEntries(text, f), P, f, rules, null);
  assert.equal(a.summary.matched, 4);
  const [l1, l2, l3, l4] = a.lineups;
  const failIds = l => l.checks.filter(c => c.pass === false).map(c => c.id);
  assert.deepEqual(failIds(l1), ["no_self_dupe"], "first copy of a duplicated lineup is flagged");
  assert.deepEqual(failIds(l2), ["no_self_dupe"]);
  assert.equal(a.summary.selfDupes, 2);
  assert.ok(failIds(l3).includes("pitcher_off_board") && !failIds(l3).includes("pitcher_top3"), "one top-3 arm passes the hard rule, the #4 arm warns");
  assert.ok(failIds(l4).includes("stack5"), "four-man stack fails the five-man rule");
  assert.ok(failIds(l4).includes("salary"), `${l4.sal} is under the $48,500 floor`);
  assert.equal(l1.primary, "AAA"); assert.equal(l1.primarySize, 5); assert.equal(l1.shape, "5-2-1");
  assert.deepEqual(l1.pitcherRanks, [1, 2]);
  assert.equal(a.summary.hardFails, 3, "two duplicates and one thin stack are hard failures");
  const ace = a.exposure.find(x => x.name === "ace one");
  assert.equal(ace.count, 4); assert.equal(Math.round(ace.pct), 100); assert.equal(Math.round(ace.delta), 70);
});

test("a lineup over the salary cap is a hard failure even with no rulebook", () => {
  const rich = ["ace one (1)", "arm three (3)", "cat a (5)", "first a (6)", "second a (7)", "third a (8)", "short a (9)", "out c1 (13)", "out b1 (11)", "out b2 (12)"];
  const a = auditPortfolio(parseEntries([HDR, row(1, rich)].join("\n"), f), P, f, null, null);
  const cap = a.lineups[0].checks.find(c => c.id === "salary_cap");
  assert.equal(a.lineups[0].sal, 50300);
  assert.equal(cap.pass, false); assert.equal(cap.hard, true);
  assert.equal(a.summary.hardFails, 1);
});
