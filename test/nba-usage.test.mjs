import test from "node:test";
import assert from "node:assert/strict";
import { reproject, posDist, USAGE } from "../src/engine/nba-usage.mjs";

test("reproject: OUT zeroed, K x his projection to rotation teammates, same position first, other team untouched", () => {
  const P = [{ name: "Star Guard", team: "A", pos: "PG", proj: 40 }, { name: "Backup PG", team: "A", pos: "PG/SG", proj: 20 }, { name: "Big", team: "A", pos: "C", proj: 30 },
    { name: "Fringe", team: "A", pos: "SG", proj: 3 }, { name: "Other", team: "B", pos: "PG", proj: 35 }];
  const r = reproject(P, ["Star Guard"]);
  assert.equal(r.players[0].proj, 0);
  assert.equal(r.players[3].proj, 3);
  assert.equal(r.players[4].proj, 35);
  const gain = r.players[1].proj - 20 + r.players[2].proj - 30;
  assert.ok(Math.abs(gain - USAGE.K * 40) < 1e-9);
  assert.ok(r.players[1].proj - 20 > r.players[2].proj - 30);
  assert.equal(r.moves[0].name, "Backup PG");
  assert.equal(P[1].proj, 20);
  assert.equal(posDist("PG/SG", "C"), 3.5);
});
