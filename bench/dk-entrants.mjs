// DraftKings contest entrants as the public contest page shows them: the first 99 users (earliest entrants,
// before and after lock alike) with their entry counts and DK experience badge, plus the page's current and max
// entries and per-user cap. Cached per contest in data/dk-entrants/<key>.json.
//   node bench/dk-entrants.mjs <key...> | --from-report=data/reports/contest-picker-nfl.json [--refresh] [--delay=900]
import fs from "node:fs";
import path from "node:path";

const DIR = "data/dk-entrants";

export function parseEntrants(html) {
  const users = [...html.matchAll(/data-un="([^"]+)"([\s\S]*?)<\/td>/g)].map(m => ({
    u: m[1].toLowerCase(), n: +((m[2].match(/title="(\d+) entries"/) || [])[1] || 1), badge: +((m[2].match(/icon-experienced-user-(\d)/) || [])[1] || 0) }));
  const num = k => { const m = html.match(new RegExp(k + ":\\s*([\\d.]+)")); return m ? +m[1] : null; };
  return { users, current: num("currentEntries"), max: num("maxEntries"), cap: num("maxUserEntries"), fee: num("contestCost") };
}

export async function fetchEntrants(key, { refresh = false, maxAgeMin = 0 } = {}) {
  const f = path.join(DIR, `${key}.json`);
  if (!refresh && fs.existsSync(f)) { const c = JSON.parse(fs.readFileSync(f, "utf8")); if (!maxAgeMin || Date.now() - Date.parse(c.fetched) < maxAgeMin * 60000) return c; }
  throw new Error("DraftKings requests disabled (account locked 10/17): nothing in Slate Lab contacts DraftKings");
  const r = await fetch(`https://www.draftkings.com/contest/detailspop?contestId=${key}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`DK ${r.status} for contest ${key}`);
  const out = Object.assign({ key: String(key), fetched: new Date().toISOString() }, parseEntrants(await r.text()));
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(out)); return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const rep = arg("from-report"), delay = +arg("delay", 900), refresh = process.argv.includes("--refresh");
  const keys = rep ? JSON.parse(fs.readFileSync(rep, "utf8")).rows.map(r => r.dir.split("-").pop()) : process.argv.slice(2).filter(x => /^\d+$/.test(x));
  let n = 0;
  for (const k of keys) {
    const cached = fs.existsSync(path.join(DIR, `${k}.json`));
    try { const e = await fetchEntrants(k, { refresh }); n++; if (!cached || refresh) { console.error(`${k} ${e.users.length} users, ${e.current} entries`); await new Promise(r => setTimeout(r, delay)); } }
    catch (e) { console.error(`${k} ERROR ${e.message}`); await new Promise(r => setTimeout(r, delay * 3)); }
  }
  console.log(`${n}/${keys.length} contests cached in ${DIR}`);
}
