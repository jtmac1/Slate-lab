// Live contest standings for late swap: the user exports a contest from DraftKings My Contests
// ("Export Lineups to CSV"), then drops the file on the Late Swap tab or leaves it in Downloads. Each
// contest is kept as data/<slate>/standings/<contestId>.json, replaced by every newer export.
import fs from "node:fs";
import path from "node:path";
import { DIRS } from "../bench/ingest.mjs";
import { standingsText, parseStandings } from "../src/engine/standings.mjs";

const dirOf = dir => path.join("data", dir, "standings");
const idOf = name => (String(name).match(/(\d{6,})/) || [])[1] || "contest";

export function saveStandings(dir, buf, name = "") {
  const S = parseStandings(standingsText(buf)), id = idOf(name), out = Object.assign({ contestId: id, file: path.basename(name), at: new Date().toISOString() }, S);
  fs.mkdirSync(dirOf(dir), { recursive: true }); fs.writeFileSync(path.join(dirOf(dir), id + ".json"), JSON.stringify(out));
  return summary(out);
}
export function loadStandings(dir) {
  const d = dirOf(dir); if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); } catch { return null; } }).filter(Boolean);
}
export const summary = s => ({ contestId: s.contestId, file: s.file, at: s.at, entries: s.entries.length, hidden: s.entries.reduce((n, e) => n + e.lineup.filter(x => !x.name).length, 0), users: new Set(s.entries.map(e => e.user)).size });

// newest contest-standings export in Downloads or data/inbox from the last 12 hours that is newer than what is saved
export function pickUpStandings(dir) {
  const have = new Map(loadStandings(dir).map(s => [s.contestId, Date.parse(s.at)])), got = [];
  for (const d of DIRS) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/^contest-standings-\d+\.(csv|zip)$/i.test(f)) continue;
      const p = path.join(d, f), st = fs.statSync(p), id = idOf(f);
      if (Date.now() - st.mtimeMs > 12 * 3600e3 || (have.get(id) || 0) >= st.mtimeMs) continue;
      try { got.push(saveStandings(dir, fs.readFileSync(p), f)); have.set(id, Date.now()); } catch {}
    }
  }
  return got;
}
