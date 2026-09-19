import { num, nrm } from "./csv.mjs";

export const FORMATS = {
  nfl_sd: { key: "nfl_sd", label: "NFL Showdown", sport: "nfl",
    slots: ["CPT", "FLEX", "FLEX", "FLEX", "FLEX", "FLEX"], cap: 50000,
    mult: [1.5, 1, 1, 1, 1, 1], bothTeams: true, anySlot: true },
  nfl_cl: { key: "nfl_cl", label: "NFL Classic", sport: "nfl",
    slots: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"], cap: 50000,
    flexPos: ["RB", "WR", "TE"], minGames: 2 },
  // DraftKings college football: no TE/K/DST, a FLEX (RB/WR) and a superflex that can take a second QB
  cfb_cl: { key: "cfb_cl", label: "CFB Classic", sport: "cfb",
    slots: ["QB", "RB", "RB", "WR", "WR", "WR", "FLEX", "SFLEX"], cap: 50000,
    flexPos: ["RB", "WR"], sflexPos: ["QB", "RB", "WR"], minGames: 2 },
  mlb_cl: { key: "mlb_cl", label: "MLB Classic", sport: "mlb",
    slots: ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"], cap: 50000,
    maxHitPerTeam: 5, minGames: 2 }
};

export const FIELDS = [
  ["name", "Player name", ["name", "player"]],
  ["pos", "Position", ["roster position", "pos", "position"]],
  ["team", "Team", ["teamabbrev", "team", "tm"]],
  ["opp", "Opponent", ["opponent", "opp"]],
  ["sal", "Salary", ["flex $", "flex salary", "salary", "sal"]],
  ["proj", "Projection", ["projection", "proj", "fpts", "points", "my proj"]],
  ["own", "Ownership %", ["flex own", "ownership", "own%", "proj own", "pown", "large field", "own", "small field"]],
  ["cown", "CPT ownership %", ["cpt own", "captain own", "cpt ownership"]],
  ["ceil", "Ceiling", ["super ceiling", "ceiling", "ceil", "upside"]],
  ["sd", "Std deviation", ["std dev", "stdev", "sd", "std"]],
  ["csal", "CPT salary", ["cpt $", "cpt salary", "captain salary"]],
  ["ord", "Batting order", ["bat pos", "order", "batting order", "lineup slot"]],
  ["conf", "Confirmed", ["confirmed"]]
];

export function detect(headers) {
  const s = headers.map(x => String(x).toLowerCase().trim());
  if (s.includes("cpt gpp score")) return "Stokastic showdown";
  if (s.includes("p(expl)")) return "Stokastic MLB";
  if (s.includes("cpt dk id")) return "Stokastic Data Hub";
  if (s.includes("cpt ownership %")) return "Blick showdown";
  if (s.includes("cpt proj") && s.includes("total own")) return "ETR showdown";
  if (s.includes("bat pos.")) return "Data Hub MLB";
  if (s.includes("optimal %") && s.includes("boom")) return "Stokastic NFL";
  if (s.includes("small field") && s.includes("large field")) return "ETR NFL";
  if (s.includes("name + id")) return "DraftKings salaries";
  return "";
}

export function autoMap(headers) {
  const m = {}, used = {};
  for (const f of FIELDS) {
    let best = -1, bestScore = 1e9;
    headers.forEach((col, i) => {
      if (used[i]) return;
      const c = String(col).toLowerCase().trim();
      f[2].forEach((want, k) => {
        let score = -1;
        if (c === want) score = 0;
        else if (c.startsWith(want)) score = 1 + k;
        else if (c.includes(want)) score = 5 + k;
        if (score >= 0 && score < bestScore) { bestScore = score; best = i; }
      });
    });
    if (best >= 0) { m[f[0]] = best; used[best] = 1; }
  }
  // ETR lists two ownership columns; large-field is the one that matches GPP play
  const lf = headers.findIndex(h => String(h).toLowerCase().trim() === "large field");
  if (lf >= 0 && m.own != null && String(headers[m.own]).toLowerCase().trim() === "small field") m.own = lf;
  return m;
}

function normPos(s) {
  s = String(s || "").toUpperCase().replace(/\s/g, "");
  if (s === "D" || s === "DEF" || s === "D/ST") return "DST";
  return s;
}

// Turn mapped CSV rows into the player pool for a format.
export function buildPool(headers, rows, fkey, map) {
  const f = FORMATS[fkey];
  const src = detect(headers) || "custom CSV";
  const M = map || autoMap(headers);
  if (M.name == null || M.proj == null || M.sal == null) throw new Error("Map name, projection and salary.");
  const P = [];
  for (const r of rows) {
    const nm = String(r[M.name] || "").trim(); if (!nm) continue;
    const sal = num(r[M.sal]); if (!sal) continue;
    const proj = Math.max(0, num(r[M.proj]) ?? 0);
    const praw = M.pos != null ? normPos(r[M.pos]) : "";
    const plist = praw ? praw.split("/") : ["FLEX"];
    let own = M.own != null ? num(r[M.own]) : null; if (own == null) own = 0;
    const cown = M.cown != null ? (num(r[M.cown]) ?? Math.max(0.1, own / 6)) : Math.max(0.1, own / 6);
    const oppRaw = String(M.opp != null ? r[M.opp] || "" : "").trim().toUpperCase();
    P.push({
      name: nm, key: nrm(nm), pos: plist[0] || "FLEX", posList: plist,
      team: String(M.team != null ? r[M.team] || "" : "").trim().toUpperCase(),
      opp: oppRaw.replace(/^(@|VS\.?|V)\s*/, "").replace(/[^A-Z0-9]/g, ""),
      home: /^@/.test(oppRaw) ? false : /^VS?\.?\s/.test(oppRaw) ? true : null,   // "@DAL" means this team is away
      sal, csal: M.csal != null ? (num(r[M.csal]) || sal * 1.5) : sal * 1.5,
      proj, own, cown,
      ceil: M.ceil != null ? num(r[M.ceil]) : null,
      sd: M.sd != null ? num(r[M.sd]) : null,
      ord: M.ord != null ? num(r[M.ord]) : null,
      conf: M.conf != null ? /^(c|y|yes|true|1)$/i.test(String(r[M.conf] || "").trim()) : null
    });
  }
  // drop stray rows: a team with only one or two players is not on this slate
  const tcount = {}; P.forEach(p => { if (p.team) tcount[p.team] = (tcount[p.team] || 0) + 1; });
  const stray = Object.keys(tcount).filter(t => tcount[t] < 3);
  if (stray.length && Object.keys(tcount).length > 2) { const keep = P.filter(p => !stray.includes(p.team)); P.length = 0; keep.forEach(p => P.push(p)); }
  const tset = {}; P.forEach(p => { if (p.team) tset[p.team] = 1; });
  const teams = Object.keys(tset).sort();
  if (M.opp == null && teams.length === 2) P.forEach(p => { if (p.team) p.opp = teams[0] === p.team ? teams[1] : teams[0]; });
  const g = {}, games = [];
  P.forEach((p, i) => {
    const k = p.team && p.opp ? [p.team, p.opp].sort().join("@") : (p.team || "?");
    if (g[k] == null) { g[k] = games.length; games.push(k); }
    p.i = i; p.gi = g[k]; p.ti = teams.indexOf(p.team);
    p.isP = f.sport === "mlb" ? (p.posList.includes("P") || p.pos === "SP" || p.pos === "RP") : p.pos === "DST";
    p.fown = (f.mult && src === "ETR showdown") ? Math.max(0, p.own - p.cown) : p.own;
  });
  // showdown: which side is away, when the opponent column said so ("@DAL" / "vs NYG")
  let away = null, home = null;
  if (teams.length === 2) { const a = P.find(p => p.home === false), h = P.find(p => p.home === true); away = a ? a.team : h ? h.opp : null; home = away ? teams.find(t => t !== away) || null : null; }
  return { players: P, teams, games, src, map: M, format: f, away, home };
}

export function eligible(p, slot, f) {
  if (f.anySlot) return true;
  if (slot === "FLEX" && f.flexPos) return f.flexPos.includes(p.pos);
  if (slot === "SFLEX" && f.sflexPos) return f.sflexPos.includes(p.pos);
  if (slot === "P") return p.isP;
  return p.posList.includes(slot);
}
