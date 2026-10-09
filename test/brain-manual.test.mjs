import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The manual Brain round trip on a throwaway slate folder: request out, Claude's answer back in.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-manual-")), DIR = "2026-10-11-nfl-main";
fs.mkdirSync(path.join(tmp, "data", DIR), { recursive: true });
const pl = (slot, name) => ({ slot, name, pos: slot, team: "AAA", sal: 5000, lab: 10, own: 10, fown: 12 });
const row = (sig, names) => ({ sig, players: names.map((n, i) => pl(["QB", "WR", "RB"][i % 3], n)), sal: 49500, left: 500, type: "QB+2",
  sim: { lab: 5, se: 3, sources: ["stk"], stk: { roi: 4, rank: 1 }, t10: 12, win: 0.1, dupN: 0.4 }, fieldOwn: 120 });
fs.writeFileSync(path.join(tmp, "data", DIR, "simrun.json"), JSON.stringify({ rows: [row("s1", ["Alpha", "Bravo"]), row("s2", ["Charlie", "Delta"]), row("s3", ["Echo", "Fox"])] }));
process.chdir(tmp);
const { manualRequest, manualAnswer, pickUpAnswer, loadBrain, brainStatus } = await import("../server/brain.mjs");

test("request lists each lineup once under a short id and saves the map", () => {
  const r = manualRequest(DIR, ["s1", "s2"], ["s2", "s3"]);
  assert.equal(r.lineups, 3); assert.equal(r.portfolio, true);
  assert.match(r.text, /\[L1\] .*Alpha/); assert.match(r.text, /\[L3\] .*Echo/); assert.match(r.text, /entered together: L2, L3/);
  assert.deepEqual(loadBrain(DIR).pending.ids, { L1: "s1", L2: "s2", L3: "s3" });
  assert.equal(brainStatus(DIR).pending.lineups, 3);
});
test("a pasted answer with code fences fills the reviews and the portfolio", () => {
  const ans = "Here you go:\n```json\n" + JSON.stringify({ reviews: [{ id: "L1", grade: "b+", thesis: "AAA shootout", take: "fine", for: ["x"], against: [] }, { id: "L9", grade: "A" }, { id: "L2", grade: "Z" }], portfolio: { take: "one bet", overlap: [], missing: [], swap: "none" } }) + "\n```";
  const r = manualAnswer(DIR, ans);
  assert.equal(r.reviewed, 1); assert.deepEqual(r.skipped, ["L9", "L2"]); assert.equal(r.missing, 2); assert.equal(r.portfolio, true); assert.equal(brainStatus(DIR).pending.lineups, 2);
  const B = loadBrain(DIR); assert.equal(B.reviews.s1.grade, "B+"); assert.deepEqual(B.portfolio.sigs, ["s2", "s3"]); assert.ok(B.pending);
});
test("Claude's answer file is picked up once, then the request closes", () => {
  const f = path.join("data", DIR, "brain-answer.json");
  fs.writeFileSync(f, JSON.stringify({ reviews: [{ id: "L2", grade: "A-" }, { id: "L3", grade: "C" }] }));
  const r = pickUpAnswer(DIR);
  assert.equal(r.reviewed, 2); assert.equal(r.missing, 0); assert.ok(!fs.existsSync(f));
  const B = loadBrain(DIR); assert.equal(B.reviews.s3.model, "Claude (project)"); assert.equal(B.pending, undefined);
  assert.equal(pickUpAnswer(DIR), null);
  assert.throws(() => manualAnswer(DIR, "{}"), /no open request/);
});
test("nothing to ask when every lineup is reviewed and there are no favorites", () => {
  assert.throws(() => manualRequest(DIR, ["s1", "s2"], []), /already has a review/);
});
test("the Brain sees each report's takeaways, Blick last, and the request carries them", async () => {
  const { readsText } = await import("../server/brain.mjs");
  const rd = path.join("data", DIR, "reads"); fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "blick.md"), "# Blick slate thoughts\n#\n- Charlie is the leverage QB");
  fs.writeFileSync(path.join(rd, "million.md"), "# The Million: Week 6\nDink | url\n- Alpha stack is the favorite build");
  const r = readsText(DIR, null); assert.equal(r.n, 2); assert.ok(r.text.indexOf("Million") < r.text.indexOf("Blick"));
  // a sub-slate with no reads of its own uses the slates its guide came from
  assert.equal(readsText("2026-10-11-nfl-early", { derived: true, from: [DIR] }).n, 2);
  const q = manualRequest(DIR, [], ["s1"]); assert.match(q.text, /WHAT EACH REPORT SAID[\s\S]*Alpha stack is the favorite build/);
});
