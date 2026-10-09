import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The user's own reads stand in for the Claude-written slate guide's stances.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "my-reads-")), DIR = "2026-10-11-nfl-main";
fs.mkdirSync(path.join(tmp, "data", DIR), { recursive: true }); process.chdir(tmp);
const { parseReads, loadGuide } = await import("../server/entries.mjs");

test("each line format becomes a stance; unclear lines are reported", () => {
  const r = parseReads("Amon-Ra St. Brown: fade, chalk trap\n+Bijan Robinson: cheap usage\n-Ja'Marr Chase\nPuka Nacua like\nJosh Allen leverage - low owned\n# a comment\nrandom text");
  assert.deepEqual(Object.fromEntries(Object.entries(r.stances).map(([k, v]) => [k, v.stance])), { "Amon-Ra St. Brown": "fade", "Bijan Robinson": "like", "Ja'Marr Chase": "fade", "Puka Nacua": "like", "Josh Allen": "leverage" });
  assert.equal(r.stances["Josh Allen"].why, "low owned"); assert.deepEqual(r.bad, ["random text"]);
});
test("with no Claude guide, the reads alone make a guide", () => {
  assert.equal(loadGuide(DIR), null);
  fs.writeFileSync(path.join("data", DIR, "my-reads.txt"), "Puka Nacua like: target share");
  assert.equal(loadGuide(DIR).stances["Puka Nacua"].why, "target share");
});
test("the user's read wins over ETR's on the same player; ETR's others stay", () => {
  fs.writeFileSync(path.join("data", DIR, "slate-guide.json"), JSON.stringify({ theses: [{ id: "t1" }], stances: { "Puka Nacua": { stance: "fade", why: "etr" }, "Josh Allen": { stance: "core", why: "etr" } } }));
  const g = loadGuide(DIR);
  assert.equal(g.stances["Puka Nacua"].stance, "like"); assert.equal(g.stances["Josh Allen"].why, "etr"); assert.equal(g.theses.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join("data", DIR, "slate-guide.json"), "utf8")).stances["Puka Nacua"].stance, "fade");
});
