import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The grabber's files (src/grab/grab.js) filed by server/grab.mjs with no Claude.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grab-")); process.env.HOME = tmp; process.env.USERPROFILE = tmp;
fs.mkdirSync(path.join(tmp, "Downloads")); process.chdir(tmp);
const day = n => new Date(Date.now() + n * 864e5).toLocaleString("sv-SE").slice(0, 10);
const MAIN = `${day(2)}-nfl-main`, SD = `${day(3)}-nfl-kcbuf`;
for (const [d, m] of [[MAIN, { type: "CLASSIC", games: ["KC@BUF", "DAL@PHI"] }], [SD, { type: "SHOWDOWN", games: ["KC@BUF"] }]]) { fs.mkdirSync(path.join("data", d), { recursive: true }); fs.writeFileSync(path.join("data", d, "slate.json"), JSON.stringify(Object.assign({ date: d.slice(0, 10) }, m))); }
const { parseGrab, matchReport, ingestGrabs } = await import("../server/grab.mjs");
const REPORTS = [{ id: "million", menu: "Establish The Million: Week" }, { id: "top-plays", menu: "DFS Top Plays" }];
const TEAM = { KC: "Chiefs", BUF: "Bills" };

test("a grab file's header, title and body", () => {
  const g = parseGrab("#SLATELAB kind=article url=https://x.com/a source=ETR\nTITLE DFS Top Plays: Week 6\n\nBody text");
  assert.deepEqual([g.kind, g.url, g.source, g.title, g.body], ["article", "https://x.com/a", "ETR", "DFS Top Plays: Week 6", "Body text"]);
  assert.equal(parseGrab("player,team\n1,2"), null);
});
test("titles map to the report list and the right slate", () => {
  const dirs = [MAIN, SD];
  assert.deepEqual(matchReport("Establish The Million: Week 6 | NFL DFS", REPORTS, TEAM, dirs), { id: "million", known: true, dir: MAIN });
  assert.deepEqual(matchReport("Showdown Breakdown: Chiefs at Bills", REPORTS, TEAM, dirs), { id: "sd-breakdown", known: true, dir: SD });
  const o = matchReport("Some Other Piece", REPORTS, TEAM, dirs); assert.equal(o.known, false); assert.equal(o.id, "other-some-other-piece"); assert.equal(o.dir, MAIN);
});
test("Refresh files an article from Downloads into the Brain's reads and marks it read, once", async () => {
  fs.writeFileSync(path.join(tmp, "Downloads", "slatelab-etr-article-1.txt"), "#SLATELAB kind=article url=https://etr/top source=ETR\nTITLE DFS Top Plays: Week 6\n\nJosh Allen is the top QB play.\n");
  fs.writeFileSync(path.join(tmp, "Downloads", "slatelab-junk.txt"), "hello");
  const r = await ingestGrabs({ reports: REPORTS, team: TEAM });
  assert.equal(r.done.length, 1, JSON.stringify(r));
  const md = fs.readFileSync(path.join("data", MAIN, "reads", "top-plays.md"), "utf8"); assert.match(md, /^# DFS Top Plays: Week 6\nETR \| https:\/\/etr\/top\n\(full text/); assert.match(md, /Josh Allen/);
  assert.equal(JSON.parse(fs.readFileSync(path.join("data", MAIN, "etr-reads.json"), "utf8"))["top-plays"].status, "ok");
  assert.equal((await ingestGrabs({ reports: REPORTS, team: TEAM })).done.length, 0);
});
