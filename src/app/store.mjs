// Browser persistence. Small things in localStorage; the field itself is regenerated on demand.
const KEY = "slatelab:";
export function get(k, dflt) { try { const v = localStorage.getItem(KEY + k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } }
export function set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
export function del(k) { try { localStorage.removeItem(KEY + k); } catch (e) {} }
export function exportAll() {
  const out = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(KEY)) out[k.slice(KEY.length)] = JSON.parse(localStorage.getItem(k)); } } catch (e) {}
  return JSON.stringify({ slatelab: 1, exported: new Date().toISOString(), data: out });
}
export function importAll(text) {
  const j = JSON.parse(text); if (!j || !j.data) throw new Error("Not a Slate Lab export.");
  for (const k in j.data) set(k, j.data[k]);
}

// MLB reference (team by player, opponent by date) with a cache; used by Review.
export async function mlbTeamLookup(date) {
  const cacheKey = "mlbref:" + date, cached = get(cacheKey, null);
  let data = cached;
  if (!data) {
    const season = date.slice(0, 4), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    const getJ = u => fetch(u, { signal: ctl.signal }).then(r => { if (!r.ok) throw new Error("MLB API " + r.status); return r.json(); });
    let tj, pj, sj;
    try {
      [tj, pj, sj] = await Promise.all([
        getJ(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${season}`),
        getJ(`https://statsapi.mlb.com/api/v1/sports/1/players?season=${season}`),
        getJ(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`)
      ]);
    } finally { clearTimeout(timer); }
    const tmap = {}; for (const t of tj.teams) tmap[t.id] = t.abbreviation;
    const players = pj.people.map(p => [p.fullName, tmap[p.currentTeam && p.currentTeam.id] || ""]);
    const opp = {}; for (const d of sj.dates || []) for (const g of d.games) { const h = tmap[g.teams.home.team.id], a = tmap[g.teams.away.team.id]; opp[h] = a; opp[a] = h; }
    data = { players, opp }; set(cacheKey, data);
  }
  const norm = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.'`’]/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim().replace(/\s+(jr|sr|ii|iii|iv)$/, "");
  const loose = s => norm(s).split(" ").filter(w => w.length > 1).join(" ");
  const byKey = {}, byLoose = {};
  for (const [n, t] of data.players) { byKey[norm(n)] = t; byLoose[loose(n)] = t; }
  return name => { const t = byKey[norm(name)] ?? byLoose[loose(name)]; return t == null ? null : { team: t, opp: data.opp[t] || "" }; };
}
