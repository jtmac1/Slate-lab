import test from "node:test";
import assert from "node:assert/strict";
import { indexHistory, projectSlate, PROJ } from "../src/engine/nba-proj.mjs";

// two teams, 24 games each: star (36 min, 50 DK) and backup (20 min, 20 DK) on A; the star misses the last game
const pl = (id, min, dk, starter = true) => ({ id, name: "P" + id, starter, dnp: !min, min, dk, pts: 0 });
const H = indexHistory(Array.from({ length: 24 }, (_, i) => { const d = `2026-01-${String(i + 1).padStart(2, "0")}`, last = i === 23;
  return { id: "g" + i, date: d, home: "A", teams: { A: { opp: "B", pts: 110, players: [pl("s", last ? 0 : 36, last ? 0 : 50), pl("b", last ? 30 : 20, last ? 30 : 20, false)] },
    B: { opp: "A", pts: 105, players: [pl("o", 34, 40)] } } }; }));

test("nba-proj: minutes x rate from history; fair P(play) after a miss; oracle availability; teammates gain when he sits", () => {
  const slate = [{ name: "Ps", team: "A", opp: "B", pos: "PG", sal: 9000, id: "s" }, { name: "Pb", team: "A", opp: "B", pos: "PG", sal: 5000, id: "b" }, { name: "Po", team: "B", opp: "A", pos: "SF", sal: 8000, id: "o" }];
  const fair = projectSlate(H, "2026-01-26", slate), get = (r, id) => r.find(p => p.id === id);
  assert.equal(get(fair, "s").miss, 1);
  assert.equal(get(fair, "s").pPlay, PROJ.PPLAY[1]);
  assert.ok(get(fair, "o").minutes > 28 && get(fair, "o").minutes < 40);
  const on = projectSlate(H, "2026-01-26", slate, PROJ, { played: new Set(["s", "b", "o"]) }), off = projectSlate(H, "2026-01-26", slate, PROJ, { played: new Set(["b", "o"]) });
  assert.equal(get(off, "s").projection, 0);
  assert.ok(get(on, "s").projection > 30);
  assert.ok(get(off, "b").projection > get(on, "b").projection);
  assert.equal(get(off, "o").projection, get(on, "o").projection);
});
