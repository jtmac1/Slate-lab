// Blick's Conditional Ownership (user-asked 2026-10-07): blickanalytics.com/nfl/conditional-ownership (classic) and
// /nfl/conditional-ownership-showdown. Each page loads a weighted simulated field per contest from Blick's API
// (players + `rows` of k player indices per lineup + weight `w`). That field is behind his Discord login, so the
// vendor pull reads it in his Chrome, computes the combos we use there, and posts a compact text to /api/blick-cond:
//   EVENT ... | BUILT ... | CONTEST key | ENTRIES contest size | N lineups | W total weight
//   P idx~name~team~pos~own[~cptOwn]^...                       (players referenced below; showdown adds captain own)
//   classic:  Q<qb>|qbOwn|x:pct,...(QB + one same-game player)|x.y:pct,...(QB + two catchers)|x.z:pct,...(QB + catcher + opponent)
//   showdown: S side:pct,...                                   (5-1 / 4-2 / 3-3 by majority team)
//             C<cpt>|cptOwn|x:pct,...                           (captain + flex player)
// pct = % of Blick's field lineups (weighted) containing every player named. Saved as data/<slate>/blick-conditional.raw.txt
// and flattened to blick-conditional.csv (kind,a,b,c,pct). Used by Lab stacks (server/stacks.mjs) as combo ownership.
import fs from "node:fs";
import path from "node:path";

const nrm = s => String(s || "").toLowerCase().replace(/[.'`’]/g, "").replace(/\s+(jr|sr|ii|iii|iv|v)$/, "").replace(/\s+/g, " ").trim();

export function parseBlickCond(text) {
  const L = String(text).trim().split(/\r?\n/), head = L[0] || "", meta = {};
  for (const part of head.split("|")) { const m = part.trim().match(/^(\w+)\s+(.*)$/); if (m) meta[m[1].toLowerCase()] = m[2].trim(); }
  const P = new Map();
  const pl = L.find(l => l.startsWith("P ")); if (!pl) throw new Error("no player line");
  for (const e of pl.slice(2).split("^")) { const [i, name, team, pos, own, cpt] = e.split("~"); P.set(i, { name, team, pos, own: +own, cptOwn: cpt != null ? +cpt : null }); }
  const out = { meta, players: [...P.values()], rows: [], sides: {} };
  const nm = i => (P.get(String(i)) || {}).name;
  for (const l of L) {
    if (/^Q\d/.test(l)) { const [q, qo, one, two, tri] = l.slice(1).split("|"); const Q = nm(q); out.rows.push({ kind: "own", a: Q, pct: +qo });
      for (const s of (one || "").split(",").filter(Boolean)) { const [x, v] = s.split(":"); out.rows.push({ kind: "pair", a: Q, b: nm(x), pct: +v }); }
      for (const s of (two || "").split(",").filter(Boolean)) { const [xy, v] = s.split(":"), [x, y] = xy.split("."); out.rows.push({ kind: "stack2", a: Q, b: nm(x), c: nm(y), pct: +v }); }
      for (const s of (tri || "").split(",").filter(Boolean)) { const [xz, v] = s.split(":"), [x, z] = xz.split("."); out.rows.push({ kind: "bring", a: Q, b: nm(x), c: nm(z), pct: +v }); } }
    else if (/^C\d/.test(l)) { const [c, co, pairs] = l.slice(1).split("|"); const C = nm(c); out.rows.push({ kind: "cpt", a: C, pct: +co });
      for (const s of (pairs || "").split(",").filter(Boolean)) { const [x, v] = s.split(":"); out.rows.push({ kind: "cptflex", a: C, b: nm(x), pct: +v }); } }
    else if (l.startsWith("S ")) for (const s of l.slice(2).split(",")) { const [k, v] = s.split(":"); out.sides[k.trim()] = +v; }
  }
  return out;
}
const csvOf = (o) => ["contest,built,kind,a,b,c,pct", ...o.rows.map(r => [o.meta.contest, o.meta.built, r.kind, r.a, r.b || "", r.c || "", r.pct].map(v => /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")), ...Object.entries(o.sides).map(([k, v]) => [o.meta.contest, o.meta.built, "side", k, "", "", v].join(","))].join("\n");

export function saveBlickCond(dir, text) {
  const o = parseBlickCond(text), d = path.join("data", dir);
  fs.writeFileSync(path.join(d, "blick-conditional.raw.txt"), String(text).trim() + "\n");
  fs.writeFileSync(path.join(d, "blick-conditional.csv"), csvOf(o));
  return { contest: o.meta.contest, built: o.meta.built, players: o.players.length, rows: o.rows.length, sides: Object.keys(o.sides).length };
}

// lookup: combo(namesArray) -> % of Blick's field with all of them (only for combos the pull computed), null otherwise
export function loadBlickCond(dir) {
  const f = path.join("data", dir, "blick-conditional.raw.txt"); if (!fs.existsSync(f)) return null;
  let o; try { o = parseBlickCond(fs.readFileSync(f, "utf8")); } catch { return null; }
  const key = names => names.map(nrm).sort().join("|"), M = new Map(), CF = new Map();
  for (const r of o.rows) { if (r.kind === "cpt") CF.set("cpt|" + nrm(r.a), r.pct); else if (r.kind === "cptflex") CF.set("cpt|" + nrm(r.a) + "|" + nrm(r.b), r.pct); else M.set(key([r.a, r.b, r.c].filter(Boolean)), r.pct); }
  return { meta: o.meta, sides: o.sides, players: o.players,
    combo: names => { const v = M.get(key(names)); return v == null ? null : v; },
    cpt: (c, flex) => { const v = CF.get("cpt|" + nrm(c) + (flex ? "|" + nrm(flex) : "")); return v == null ? null : v; } };
}
