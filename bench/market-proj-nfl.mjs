// Market projection: Pinnacle prop lines -> expected DraftKings points per player. A line is a median;
// the de-vigged over price shifts it, a per-stat spread turns the median into a mean and gives the
// 100/300-yard bonus odds. Touchdowns are mostly unpriced, so each team's expected TDs come from its
// team total minus field goals, pass TDs from the QB's line, and the rest is shared out by yardage
// (an anytime-TD line pins that player). Kickers: FG line + XPs. DST: opponent team total and INT
// line only, the rest league averages. All constants are first guesses the scorecard calibrates.
//   node bench/market-proj-nfl.mjs [data/odds/nfl/<stamp>.json | latest]   -> <stamp>-proj.csv
import fs from "node:fs";
import path from "node:path";

// sdFrac*line (floored at sdMin) is the stat's spread; skew lifts median to mean; dk = points per unit
const STAT = {
  passYds: { sdFrac: 0.25, sdMin: 40, skew: 0.01, dk: 0.04, bonus: 300 },
  rushYds: { sdFrac: 0.45, sdMin: 12, skew: 0.05, dk: 0.1, bonus: 100 },
  recYds: { sdFrac: 0.55, sdMin: 12, skew: 0.06, dk: 0.1, bonus: 100 },
  rec: { sdFrac: 0.40, sdMin: 1.2, skew: 0.03, dk: 1 },
  passTD: { sdFrac: 0.60, sdMin: 1.0, skew: 0.03, dk: 4 },
  int: { sdFrac: 0.80, sdMin: 0.7, skew: 0.05, dk: -1 },
  fg: { sdFrac: 0.60, sdMin: 1.0, skew: 0.03, dk: 0 },
};
const TD_PER_SCORE = 6.97;       // TD + XP + occasional two-point try
const FG_PTS = 3.3;              // 3 plus the distance bonus on average
const ANYTIME_TO_MEAN = 1.18;    // E[TDs] / P(at least one)
const REC_TD_W = { TE: 1.25, WR: 1.0, RB: 0.7, QB: 0 }, RUSH_TD_W = { RB: 1.0, QB: 1.3, WR: 0.5, TE: 0.5 };
const DST_SD = 9.5, DST_SACKS = 2.4, DST_FUM = 0.7, DST_TD = 0.12, DST_SAF = 0.05;

const ip = a => a < 0 ? -a / (-a + 100) : 100 / (a + 100);
export const devig = (over, under) => { const o = ip(over), u = ip(under); return o / (o + u); };
export function qnorm(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239], b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1], c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  p = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) return -qnorm(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export function pnorm(z) { const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return z < 0 ? 0.5 * (1 - y) : 0.5 * (1 + y); }

// line + prices -> { mean, sd, pBonus }
function fromLine(stat, line, over, under) {
  const s = STAT[stat], q = devig(over, under), sd = Math.max(s.sdMin, s.sdFrac * line), median = line + sd * qnorm(q), mean = Math.max(0, median * (1 + s.skew));
  return { mean, sd, pBonus: s.bonus ? 1 - pnorm((s.bonus - 0.5 - mean) / sd) : 0 };
}

export function marketProj(snap) {
  const games = new Map(snap.games.map(g => [g.id, g]));
  const P = new Map();   // name|team -> player
  for (const p of snap.props) {
    if (!p.team) continue;
    const k = p.name + "|" + p.team, r = P.get(k) || { name: p.name, team: p.team, pos: p.pos, game: p.game, stats: {}, lines: {} };
    r.lines[p.stat] = `${p.line}@${p.over}/${p.under}`;
    if (p.stat === "td") r.stats.td = { pAny: devig(p.over, p.under) };
    else if (STAT[p.stat]) r.stats[p.stat] = fromLine(p.stat, p.line, p.over, p.under);
    P.set(k, r);
  }
  // team-level expectations
  const T = {};
  for (const g of snap.games) { T[g.home] = { game: g, tt: g.ttHome, opp: g.away, players: [] }; T[g.away] = { game: g, tt: g.ttAway, opp: g.home, players: [] }; }
  for (const r of P.values()) if (T[r.team]) T[r.team].players.push(r);
  for (const [team, t] of Object.entries(T)) {
    const kicker = t.players.find(r => r.stats.fg), fg = kicker ? kicker.stats.fg.mean : 1.7;
    const tt = t.tt ?? (t.game.total != null ? t.game.total / 2 : 22);
    t.td = Math.max(0.8, (tt - FG_PTS * fg) / TD_PER_SCORE);
    const qbs = t.players.filter(r => r.stats.passTD);
    t.passTD = qbs.length ? qbs.reduce((s, r) => s + r.stats.passTD.mean, 0) : 0.55 * t.td;
    t.rushTD = Math.max(0.2, t.td - t.passTD);
    t.fg = fg; t.ttUsed = tt;
    // pinned players (anytime line) take their share first, split rush/rec by their own yardage
    let recPool = t.passTD, rushPool = t.rushTD;
    for (const r of t.players) {
      if (!r.stats.td) continue;
      const e = r.stats.td.pAny * ANYTIME_TO_MEAN, ry = r.stats.rushYds ? r.stats.rushYds.mean : 0, cy = r.stats.recYds ? r.stats.recYds.mean : 0, sh = ry + cy > 0 ? ry / (ry + cy) : 0;
      r.rushTD = e * sh; r.recTD = e * (1 - sh); rushPool -= r.rushTD; recPool -= r.recTD;
    }
    recPool = Math.max(0, recPool); rushPool = Math.max(0, rushPool);
    const open = t.players.filter(r => !r.stats.td);
    const wRec = open.map(r => (r.stats.recYds ? r.stats.recYds.mean : 0) * (REC_TD_W[r.pos] ?? 0.8)), wRush = open.map(r => (r.stats.rushYds ? r.stats.rushYds.mean : 0) * (RUSH_TD_W[r.pos] ?? 0.5));
    const sRec = wRec.reduce((a, b) => a + b, 0), sRush = wRush.reduce((a, b) => a + b, 0);
    open.forEach((r, i) => { r.recTD = sRec ? recPool * wRec[i] / sRec : 0; r.rushTD = sRush ? rushPool * wRush[i] / sRush : 0; });
  }
  const rows = [];
  for (const r of P.values()) {
    const t = T[r.team]; if (!t) continue;
    const g = t.game, s = r.stats, parts = {};
    if (r.pos === "K" || s.fg) {
      parts.fg = FG_PTS * (s.fg ? s.fg.mean : t.fg); parts.xp = 0.94 * t.td;
      rows.push(fin(r, g, t, "K", parts)); continue;
    }
    if (s.passYds) { parts.passYds = STAT.passYds.dk * s.passYds.mean; parts.bonus = (parts.bonus || 0) + 3 * s.passYds.pBonus; }
    if (s.passTD) parts.passTD = STAT.passTD.dk * s.passTD.mean;
    if (s.int) parts.int = STAT.int.dk * s.int.mean;
    if (s.rushYds) { parts.rushYds = STAT.rushYds.dk * s.rushYds.mean; parts.bonus = (parts.bonus || 0) + 3 * s.rushYds.pBonus; }
    if (s.rec) parts.rec = STAT.rec.dk * s.rec.mean;
    if (s.recYds) { parts.recYds = STAT.recYds.dk * s.recYds.mean; parts.bonus = (parts.bonus || 0) + 3 * s.recYds.pBonus; }
    if (r.rushTD) parts.rushTD = 6 * r.rushTD;
    if (r.recTD) parts.recTD = 6 * r.recTD;
    if (!Object.keys(parts).length) continue;   // attempts/completions only
    rows.push(fin(r, g, t, r.pos || "?", parts));
  }
  // DST: opponent's team total through DK's points-allowed table + opposing QB INT line
  for (const [team, t] of Object.entries(T)) {
    const o = T[t.opp]; if (!o) continue;
    const m = o.ttUsed, cdf = x => pnorm((x - m) / DST_SD);
    const pa = 10 * cdf(0.5) + 7 * (cdf(6.5) - cdf(0.5)) + 4 * (cdf(13.5) - cdf(6.5)) + 1 * (cdf(20.5) - cdf(13.5)) + 0 - 1 * (cdf(34.5) - cdf(27.5)) - 4 * (1 - cdf(34.5));
    const ints = o.players.filter(r => r.stats.int).reduce((s, r) => s + r.stats.int.mean, 0.0) || 0.8;
    const parts = { pa, sacks: DST_SACKS, int: 2 * ints, fum: 2 * DST_FUM, td: 6 * DST_TD, saf: 2 * DST_SAF };
    rows.push(fin({ name: team + " DST", team, lines: { oppTT: String(m) } }, t.game, t, "DST", parts));
  }
  return rows.sort((a, b) => b.proj - a.proj);
}
function fin(r, g, t, pos, parts) {
  const proj = Object.values(parts).reduce((a, b) => a + b, 0);
  return { name: r.name, team: r.team, pos, opp: t.opp, game: `${g.away}@${g.home}`, start: g.start, proj: +proj.toFixed(2), parts, lines: r.lines };
}
const COLS = ["passYds", "passTD", "int", "rushYds", "rushTD", "rec", "recYds", "recTD", "bonus", "fg", "xp", "pa", "sacks"];
export function writeProj(rows, file) {
  const out = [["Player", "Team", "Pos", "Opp", "Game", "Start", "Proj", ...COLS, "Lines"].join(",")];
  for (const r of rows) out.push([r.name, r.team, r.pos, r.opp, r.game, r.start, r.proj, ...COLS.map(c => r.parts[c] != null ? r.parts[c].toFixed(2) : ""), Object.entries(r.lines).map(([k, v]) => `${k} ${v}`).join(" ")].map(v => /,/.test(String(v)) ? `"${v}"` : v).join(","));
  fs.writeFileSync(file, out.join("\n") + "\n");
}
if (process.argv[1] && /market-proj-nfl\.mjs$/.test(process.argv[1])) {
  const dir = "data/odds/nfl";
  let f = process.argv[2] || "latest";
  if (f === "latest") { const fs_ = fs.readdirSync(dir).filter(x => /^\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(x)).sort(); f = path.join(dir, fs_[fs_.length - 1]); }
  const snap = JSON.parse(fs.readFileSync(f, "utf8")), rows = marketProj(snap), out = f.replace(/\.json$/, "-proj.csv");
  writeProj(rows, out);
  console.log(`${rows.length} players -> ${out}`);
  const top = n => rows.filter(r => r.pos === n).slice(0, 5).map(r => `${r.name} ${r.proj}`).join(", ");
  for (const p of ["QB", "RB", "WR", "TE", "K", "DST"]) console.log(`  ${p}: ${top(p)}`);
}
