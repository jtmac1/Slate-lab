import test from "node:test";
import assert from "node:assert/strict";
import { rulesFor, markOwnRelative } from "../src/engine/grade.mjs";

// Ownership rules follow the slate: concentrated slates use the concentrated segment, flat slates only the flat one.
const row = (rule, seg, kept, lift, t) => ({ fmt: "classic", rule, seg, kept, lift, t });
const RB = { rows: [
  row("own sum < 200%", "all", true, 0.8, -4), row("own sum < 200%", "concentrated slate (8+ players at 20%+)", true, 0.86, -3.7),
  row("chalk count above the contest median", "concentrated slate (8+ players at 20%+)", true, 1.31, 9),
  row("chalk count above the contest median", "flat slate (7 or fewer players at 20%+)", false, 0.62, -1.4),
  row("QB + 2 pass catchers or more", "all", true, 1.33, 5),
] };
const names = o => o.map(r => r.name + "@" + r.seg).sort();
test("concentrated slate: ownership rules from the concentrated segment", () => {
  assert.deepEqual(names(rulesFor(RB, { fee: 20, games: 11, chalkN: 9 })), ["QB + 2 pass catchers or more@all", "chalk count above the contest median@concentrated slate (8+ players at 20%+)", "own sum < 200%@concentrated slate (8+ players at 20%+)"].sort());
});
test("flat slate: no ownership rule unless kept on flat slates; other rules unchanged", () => {
  assert.deepEqual(names(rulesFor(RB, { fee: 20, games: 11, chalkN: 7 })), ["QB + 2 pass catchers or more@all"]);
});
test("unknown concentration keeps the old order", () => {
  assert.deepEqual(names(rulesFor(RB, { fee: 20, games: 11 })), ["QB + 2 pass catchers or more@all", "own sum < 200%@all"]);
});
test("pool-relative ownership features", () => {
  const f = markOwnRelative([{ ownSum: 100, chalk: 1 }, { ownSum: 150, chalk: 2 }, { ownSum: 200, chalk: 4 }, { ownSum: 250, chalk: 5 }]);
  assert.deepEqual(f.map(x => x.ownPct), [0, 0.25, 0.5, 0.75]); assert.equal(f[0].chalkMed, 4);
});
test("ownership relative to the contest field when one is given", () => {
  const field = [{ ownSum: 200, chalk: 3 }, { ownSum: 220, chalk: 4 }, { ownSum: 240, chalk: 4 }, { ownSum: 260, chalk: 5 }];
  const f = markOwnRelative([{ ownSum: 150, chalk: 2 }, { ownSum: 230, chalk: 5 }], field);
  assert.deepEqual(f.map(x => x.ownPct), [0, 0.5]); assert.equal(f[1].chalkMed, 4);
});
