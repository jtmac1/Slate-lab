// Lab NBA DK classic projection: projected minutes x DK points per minute, from box-score history only (no news). Pure.
// Minutes: recency-weighted minutes in games played (half-life HM games, last season x WS), shrunk toward a salary prior (KM pseudo
// games); + S x (started the team's previous game - recent start share); x (1 - B2B) on the second night of a back-to-back; starters
// x (1 - BL x (|expected margin| - 5)+) with expected margin from recency-weighted team point margins (+-HCA). Rate: recency-weighted
// DK pts / minute (half-life HR) shrunk toward a salary + position prior (KR pseudo-minutes), x (opponent DK allowed / league)^OPP.
// Availability: a player who missed his team's last c games plays with P(play) = PPLAY[min(c, 4)] (fair); oracle = who played.
// Absent players' points go to teammates by the fitted rule in nba-usage.mjs (K, position factors), scaled by how much of the
// recent sample they were present for (a long absence is already in the teammates' averages); a returning player takes it back.
// Parameters fitted on odd 2025-26 dates by bench/fit-proj-nba.mjs (held-out check: data/reports/nba/proj-lab.txt).
import { USAGE, posDist } from "./nba-usage.mjs";

export const PROJ = { HM: 3, HR: 8, KM: 1.5, KR: 100, WS: 0.05, S: 2, B2B: 0, BL: 0, HCA: 2.5, OPP: 0.75, HT: 20, PPLAY: [1, 0.56, 0.38, 0.22, 0.17], RET: 1,
  minPrior: { a: 10.24, b: 2.771 }, ratePrior: { G: [0.439, 0.0906], F: [0.383, 0.0993], C: [0.57, 0.0905] } };
export const DK2ESPN = { NYK: "NY", GSW: "GS", NOP: "NO", UTA: "UTAH", WAS: "WSH", SAS: "SA" };
export const ESPN2DK = Object.fromEntries(Object.entries(DK2ESPN).map(([k, v]) => [v, k]));
export const espnTeam = t => DK2ESPN[t] || t;
export const nm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");
export const seasonOf = d => +d.slice(0, 4) - (+d.slice(5, 7) < 8 ? 1 : 0);
const posGroup = pos => { const p = String(pos || "").split("/").map(s => s.trim()); return p.includes("C") ? "C" : p.some(x => x === "PG" || x === "SG" || x === "G") ? "G" : "F"; };
const addDay = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const before = (arr, date) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].date < date) lo = m + 1; else hi = m; } return lo; };

// games: [{ id, date, home, teams: { ABBR: { opp, pts, players: [{ id, name, starter, dnp, min, dk }] } } }] (ESPN abbreviations)
export function indexHistory(games) {
  const cnt = {}; for (const g of games) for (const t in g.teams) cnt[t] = (cnt[t] || 0) + 1;
  const byPlayer = new Map(), byTeam = new Map(), nameToId = new Map();
  for (const g of games) { const ts = Object.keys(g.teams); if (ts.some(t => cnt[t] < 20)) continue;
    for (const t of ts) { const T = g.teams[t], O = g.teams[T.opp], played = new Set();
      for (const p of T.players) { if (!p.id) continue; nameToId.set(nm(p.name), p.id);
        (byPlayer.get(p.id) || byPlayer.set(p.id, []).get(p.id)).push({ date: g.date, team: t, min: p.dnp ? 0 : p.min, dk: p.dk, starter: !p.dnp && p.starter, name: p.name });
        if (!p.dnp && p.min > 0) played.add(p.id); }
      (byTeam.get(t) || byTeam.set(t, []).get(t)).push({ date: g.date, opp: T.opp, home: g.home === t, margin: T.pts - O.pts, dkAllowed: O.players.reduce((a, p) => a + (p.dnp ? 0 : p.dk), 0), played }); } }
  return { byPlayer, byTeam, nameToId };
}

// team form before date: recency-weighted margin and DK allowed
function teamForm(H, t, date, P) {
  const L = H.byTeam.get(t) || [], i = before(L, date), s = seasonOf(date); let w = 0, m = 0, a = 0;
  for (let k = i - 1, j = 0; k >= 0 && j < 40; k--, j++) { const x = Math.pow(0.5, j / P.HT) * Math.pow(P.WS, s - seasonOf(L[k].date)); w += x; m += x * L[k].margin; a += x * L[k].dkAllowed; }
  return { w, margin: w ? m / w : 0, allowed: w ? a / w : null, games: L.slice(0, i) };
}

// players: [{ name, team (ESPN), opp?, pos?, sal?, id? }] on the slate. opt.played: Set of ESPN ids who play (oracle availability); opt.out: ids known OUT;
// opt.home: Set of home teams. Earlier seasons weigh WS^(seasons back).
// Returns every rostered player of the slate's teams (input players first, roster-only players flagged extra) with minutes + proj.
export function projectSlate(H, date, players, P = PROJ, opt = {}) {
  const s = seasonOf(date), teams = new Set(players.map(p => p.team)), byId = new Map();
  for (const p of players) { const id = p.id || H.nameToId.get(nm(p.name)); byId.set(id || "n:" + nm(p.name), { ...p, id }); }
  // roster-only players: last record before date with this team, within the team's last 10 games
  const tf = new Map(); for (const t of teams) tf.set(t, teamForm(H, t, date, P));
  for (const t of teams) { const G = tf.get(t).games, since = G.length > 10 ? G[G.length - 10].date : "0";
    for (const g of G.slice(-10)) for (const id of g.played) if (!byId.has(id)) { const L = H.byPlayer.get(id), last = L[before(L, date) - 1];
      if (last && last.team === t && last.date >= since) byId.set(id, { name: last.name, team: t, id, extra: true }); } }
  let lw = 0, la = 0; for (const [, f] of tf) if (f.allowed != null) { lw += f.w; la += f.w * f.allowed; } const league = lw ? la / lw : null;
  const opps = new Map(); for (const p of players) if (p.opp) opps.set(p.team, p.opp);
  const oppF = new Map(); for (const [t, o] of opps) oppF.set(t, tf.get(o) || teamForm(H, o, date, P));
  const out = [];
  for (const p of byId.values()) {
    const L = p.id ? H.byPlayer.get(p.id) || [] : [], i = before(L, date), G = tf.get(p.team).games;
    let w = 0, wm = 0, wst = 0, wr = 0, rd = 0, rm = 0, n = 0;
    for (let k = i - 1; k >= 0 && n < 50; k--) { const g = L[k]; if (!(g.min > 0)) continue; const sw = Math.pow(P.WS, s - seasonOf(g.date));
      const x = Math.pow(0.5, n / P.HM) * sw, y = Math.pow(0.5, n / P.HR) * sw; w += x; wm += x * g.min; wst += x * (g.starter ? 1 : 0); rd += y * g.dk; rm += y * g.min; n++; }
    const sal = (p.sal || 0) / 1000, mp = Math.max(4, P.minPrior.a + P.minPrior.b * sal), rp = P.ratePrior[posGroup(p.pos)], rpr = rp[0] + rp[1] * sal;
    const hasSal = p.sal > 0, Km = hasSal ? P.KM : 0.25, Kr = hasSal ? P.KR : 10;
    let min = w ? (wm + Km * mp) / (w + Km) : hasSal ? mp : 0, rate = (rd + Kr * rpr) / (rm + Kr);
    const startShare = w ? wst / w : 0;
    // team's previous game: played / started / consecutive misses since last appearance
    const lastPlayed = (() => { for (let k = i - 1; k >= 0; k--) if (L[k].min > 0) return L[k]; return null; })();
    let miss = 0; for (let k = G.length - 1; k >= 0 && miss < 4; k--) { if (G[k].played.has(p.id) || seasonOf(G[k].date) < s) break; if (lastPlayed && G[k].date <= lastPlayed.date) break; miss++; }
    if (!lastPlayed) miss = 0;
    const prevT = G[G.length - 1], prevRec = prevT && L[i - 1] && L[i - 1].date === prevT.date ? L[i - 1] : null;
    if (prevRec && prevRec.min > 0) min += P.S * ((prevRec.starter ? 1 : 0) - startShare);
    if (prevT && prevT.date === addDay(date, -1)) min *= 1 - P.B2B;
    const of = oppF.get(p.team);
    if (of && startShare >= 0.5) { const home = opt.home ? opt.home.has(p.team) : null, e = tf.get(p.team).margin - of.margin + (home == null ? 0 : home ? P.HCA : -P.HCA); min *= 1 - P.BL * Math.max(0, Math.abs(e) - 5); }
    if (of && of.allowed && league) rate *= Math.pow(of.allowed / league, P.OPP);
    min = Math.max(0, Math.min(44, min));
    // presence: recency-weighted share of the team's last 10 games this season he played (none yet = treated as present)
    let pw = 0, pp = 0; G.slice(-10).filter(g => seasonOf(g.date) === s).forEach((g, j, a) => { const x = Math.pow(0.5, (a.length - 1 - j) / 5); pw += x; pp += x * (g.played.has(p.id) ? 1 : 0); });
    const pPlay = opt.out?.has(p.id) ? 0 : opt.played ? (opt.played.has(p.id) ? 1 : 0) : P.PPLAY[Math.min(miss, P.PPLAY.length - 1)];
    out.push({ ...p, minFull: min, projFull: min * rate, rate, miss, presence: pw ? pp / pw : 1, pPlay, gp: n });
  }
  // redistribution, by team (nba-usage rule): absent share leaves, returning share comes back
  const U = USAGE;
  for (const t of teams) {
    const T = out.filter(p => p.team === t);
    for (const o of T) {
      const A = o.projFull * ((1 - o.pPlay) * o.presence - P.RET * o.pPlay * (1 - o.presence)); if (!A || !(o.projFull > U.floor)) continue;
      const mates = T.filter(m => m !== o && m.pPlay > 0 && m.projFull > U.floor), wts = mates.map(m => { const d = posDist(m.pos, o.pos); return Math.pow(m.projFull, U.gamma) * (d == null ? U.adj : d <= 0.75 ? U.same : d <= 1.75 ? U.adj : U.far); }), W = wts.reduce((a, b) => a + b, 0);
      if (W > 0) mates.forEach((m, k) => { m.gain = (m.gain || 0) + U.K * A * wts[k] / W; });
    }
  }
  for (const p of out) { const full = Math.max(0, p.projFull + (p.gain || 0)); p.projection = p.pPlay * full; p.minutes = p.pPlay * (p.projFull > 0 ? p.minFull * full / p.projFull : p.minFull); }
  return out;
}
