import test from "node:test";
import assert from "node:assert/strict";
import { recoverContest } from "../src/engine/recover.mjs";
import { assignSlots } from "../src/engine/lineups.mjs";
import { FORMATS } from "../src/engine/formats.mjs";

// Six showdown players with known projections and salaries; lineups list the captain first.
const PL = [
  ["Quarterback A", "QB", "AAA", 20, 10000], ["Receiver B", "WR", "AAA", 15, 8000], ["Back C", "RB", "BBB", 12, 7000],
  ["Receiver D", "WR", "BBB", 10, 6000], ["Tight E", "TE", "AAA", 8, 4000], ["Kicker F", "K", "BBB", 7, 3000], ["Defense G", "DST", "AAA", 6, 2500],
  ["Deep H", "WR", "BBB", 3, 1000]
];
const teamOf = nm => { const p = PL.find(x => x[0] === nm); return p ? { team: p[2], opp: p[2] === "AAA" ? "BBB" : "AAA", pos: p[1] } : null; };
const proj = names => names.reduce((s, n, q) => s + (q === 0 ? 1.5 : 1) * PL.find(x => x[0] === n)[3], 0);
const sal = names => names.reduce((s, n, q) => s + (q === 0 ? 1.5 : 1) * PL.find(x => x[0] === n)[4], 0);
const csv = rows => rows.map(r => r.map(v => `"${v}"`).join(",")).join("\n");

function files() {
  const core = PL.slice(0, 7).map(p => p[0]), L = [["User", "Sim Lineup ROI", "Actual Lineup ROI", "Sim Avg FP", "Actual FP", "OwnSum", "Actual Finish Position", "Duplicates", "Salary", "Lineups"]];
  let finish = 1;
  for (let c = 0; c < 7; c++) for (let drop = 0; drop < 7; drop++) {           // every captain, every 5-of-the-other-6
    if (drop === c) continue;
    const names = [core[c]].concat(core.filter((n, i) => i !== c && i !== drop));
    L.push([`u${finish}`, "10%", finish <= 8 ? "50%" : "-100%", proj(names).toFixed(2), "100", "80%", String(finish++), "0", sal(names).toLocaleString(), names.join(", ")]);
  }
  // one lineup with the rarely used player, always alongside the same five others
  const rare = ["Deep H"].concat(core.slice(0, 5));
  L.push(["rare", "5%", "-100%", proj(rare).toFixed(2), "60", "40%", String(finish++), "0", sal(rare).toLocaleString(), rare.join(", ")]);
  const P = [["Player", "Position", "Sim Player ROI", "Actual Player ROI", "Field own %"]];
  for (const p of PL) { P.push([p[0], "CPT", "5%", "10%", p[3] + "%"]); P.push([p[0], "FLEX", "8%", "12%", (p[3] * 3) + "%"]); }
  return { lineup: csv(L), player: csv(P) };
}

test("assignSlots keeps the given order for showdown", () => {
  const P = PL.map(p => ({ name: p[0], pos: p[1], posList: [p[1]] }));
  assert.deepEqual(assignSlots([3, 1, 0, 2, 4, 5], P, FORMATS.nfl_sd), [3, 1, 0, 2, 4, 5]);
});

test("showdown recovery: captain first, real positions, captain-weighted projections", () => {
  const { lineup, player } = files();
  const rc = recoverContest(lineup, player, teamOf, "nfl_sd");
  assert.equal(rc.entries.length, 43);
  for (const e of rc.entries) assert.equal(rc.pool.players[e.lu[0]].name, e.names[0]);
  const byName = {}; for (const p of rc.pool.players) byName[p.name] = p;
  assert.equal(byName["Quarterback A"].pos, "QB");
  assert.equal(byName["Kicker F"].pos, "K");
  assert.equal(byName["Defense G"].isP, true, "DST is the NFL 'pitcher' flag");
  assert.equal(rc.pool.players.length, 8, "each player appears once despite CPT and FLEX rows");
  assert.equal(byName["Quarterback A"].cown, 20);
  assert.equal(byName["Quarterback A"].own, 60);
  for (const p of PL.slice(0, 7)) {
    assert.ok(Math.abs(byName[p[0]].proj - p[3]) < 0.25, `${p[0]} projection ${byName[p[0]].proj.toFixed(2)} vs ${p[3]}`);
    assert.ok(Math.abs(byName[p[0]].sal - p[4]) <= 100, `${p[0]} salary ${byName[p[0]].sal} vs ${p[4]}`);
  }
  // the rarely used player is not identifiable from one lineup; it must not inherit the pool average
  assert.ok(byName["Deep H"].proj < 8, `rare player projection ${byName["Deep H"].proj.toFixed(2)} should stay low`);
  assert.equal(rc.paid, 8);
});

test("tied finishes each count as paid", () => {
  const { lineup, player } = files();
  const tied = lineup.split("\n").map((row, i) => i >= 1 && i <= 3 ? row.replace(/"(\d+)","0"/, '"1","0"') : row).join("\n");
  const rc = recoverContest(tied, player, teamOf, "nfl_sd");
  assert.equal(rc.paid, 8);
});
