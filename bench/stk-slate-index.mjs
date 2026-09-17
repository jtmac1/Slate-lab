// Index Stokastic slate ids: for each id in a range, record sport, type (showdown when captain
// fields exist), teams, first game time, row count and last-updated stamp. Old slates are still
// served with their final pre-lock numbers, so this is how past showdowns get their vendor files.
// Resumable: ids already in the index are skipped.  Output: data/stk-slates.json
//   node bench/stk-slate-index.mjs <fromId> <toId> [par=8]
import fs from "node:fs";
import { stkGet } from "../src/engine/stokastic.mjs";
const [from, to, parArg = "8"] = process.argv.slice(2).map(Number), PAR = parArg || 8, OUT = "data/stk-slates.json";
const idx = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const ids = []; for (let i = from; i <= to; i++) if (!idx[i]) ids.push(i);
console.log(`${ids.length} ids to scan (${Object.keys(idx).length} already indexed)`);
const sportOf = p => { const pos = new Set(p.map(r => String(r.position || "").toUpperCase())); if ([...pos].some(x => /^(SP|RP|P|C|1B|2B|3B|SS|OF)$/.test(x)) && !pos.has("QB")) return "MLB"; if ([...pos].some(x => /^(QB|RB|WR|TE|DST|K)$/.test(x))) return "NFL"; if ([...pos].some(x => /^(PG|SG|SF|PF|C\/PF|G|F)$/.test(x)) && !pos.has("W")) return "NBA"; if ([...pos].some(x => /^(W|D|G)$/.test(x))) return "NHL"; return "?"; };
let done = 0, live = 0, next = 0; const t0 = Date.now();
const save = () => fs.writeFileSync(OUT, JSON.stringify(idx));
async function one(id) {
  try {
    const u = await stkGet(`slatedata/slateUpdateInfo?slateId=${id}`);
    if (!u.projectionsLastUpdated || u.projectionsLastUpdated.startsWith("0001")) { idx[id] = { dead: true }; return; }
    const p = await stkGet(`slatedata/projections?SlateId=${id}`);
    if (!p.length) { idx[id] = { dead: true }; return; }
    const teams = [...new Set(p.map(r => r.team).filter(Boolean))].sort(), games = [...new Set(p.map(r => r.gameTime).filter(Boolean))].sort();
    idx[id] = { sport: sportOf(p), type: "cptOwnership" in p[0] ? "SHOWDOWN" : "CLASSIC", teams, first: games[0], games: games.length, rows: p.length, sd: p.filter(r => r.stdDev != null).length, updated: u.projectionsLastUpdated }; live++;
  } catch (e) { idx[id] = { err: e.message.slice(0, 60) }; }
  finally { done++; if (done % 100 === 0) { save(); console.log(`${done}/${ids.length} scanned, ${live} live, ${((Date.now() - t0) / 1000).toFixed(0)}s`); } }
}
await Promise.all(Array.from({ length: PAR }, async () => { while (next < ids.length) await one(ids[next++]); }));
save(); console.log(`done: ${done} scanned, ${live} live slates, index has ${Object.keys(idx).length} ids`);
