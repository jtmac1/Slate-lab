import test from "node:test";
import assert from "node:assert/strict";
import { adjustOwn, adjustProj, nbaSlateInfo } from "../src/engine/nba-adjust.mjs";

test("nba adjustOwn lifts chalk, trims the low end, stays bounded; adjustProj is identity", () => {
  const P = [{ name: "A", pos: "PG", pown: 40, proj: 45 }, { name: "B", pos: "C", pown: 25, proj: 35 }, { name: "C", pos: "SF/PF", pown: 6, proj: 15 }];
  const si = nbaSlateInfo(P), a = adjustOwn(P[0], si), c = adjustOwn(P[2], si);
  assert.equal(si.chalkN, 2); assert.equal(si.rank.get("A"), 0);
  assert.ok(a > 40 && a <= 41 * 2 - 1); assert.ok(c < 6 && c >= 0);
  assert.equal(adjustProj(P[1], si), 35);
});
