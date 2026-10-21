// Defense-vs-role pass-catching matchups (2026-10-14), ours from nflverse play-by-play. Each target is measured against what
// that receiver normally does (his own rates in his other games), so a defense isn't graded on who it happened to face.
// Roles per team-game from target share in the team's PRIOR games that season: WR1, WR2, WR3 (other WRs), TE1, RB.
// Components per defense x role: volume (role's share of team targets vs his usual), success (catch rate over expected),
// explosive (20+ yard catches per target over expected), red zone (RZ target share over expected), DK receiving points per
// target over expected. Predictive test: each defense's first-half-season number vs its second half (2025), which sets how
// much of the raw number to keep. Then the slate's two defenses vs the other side's roles, with that shrinkage.
//   node bench/matchups-nfl.mjs [--slate=2026-10-15-nfl-seaden]
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SLATE = arg("slate", "2026-10-15-nfl-seaden"), NV = "data/nflverse", W25 = 0.25;
const readCSV = f => { const b = fs.readFileSync(f), [h, ...rows] = parseCSV((f.endsWith(".gz") ? zlib.gunzipSync(b) : b).toString("utf8")); return rows.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const DK = { LA: "LAR" }, dk = t => DK[t] || t;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
const ROLES = ["WR1", "WR2", "WR3", "TE1", "RB"], COMP = ["volume", "success", "explosive", "redzone", "fpt"];

// ---------- targets ----------
const pos = {}; for (const y of [2025, 2026]) { const f = `${NV}/roster_${y}.csv`; if (fs.existsSync(f)) for (const r of readCSV(f)) if (r.gsis_id) pos[r.gsis_id] = r.position; }
for (const r of readCSV(`${NV}/stats_player_week_2025.csv`)) if (r.player_id && !pos[r.player_id]) pos[r.player_id] = r.position;
const T = [];   // one row per target
for (const y of [2025, 2026]) for (const r of readCSV(`${NV}/play_by_play_${y}.csv.gz`)) {
  if (r.season_type !== "REG" || r.play_type !== "pass" || !r.receiver_player_id || r.sack === "1" || r.qb_scramble === "1") continue;
  const yds = r.complete_pass === "1" ? +r.yards_gained : 0;
  T.push({ y, wk: +r.week, game: r.game_id, off: dk(r.posteam), def: dk(r.defteam), id: r.receiver_player_id, pos: pos[r.receiver_player_id] || "WR",
    c: r.complete_pass === "1" ? 1 : 0, exp: r.complete_pass === "1" && yds >= 20 ? 1 : 0, rz: +r.yardline_100 <= 20 ? 1 : 0,
    fp: r.complete_pass === "1" ? 1 + 0.1 * yds + (r.touchdown === "1" && r.td_team === dk(r.posteam) ? 6 : 0) : 0 });
}
console.error(`${T.length} targets`);

// ---------- roles: target share rank in the team's prior games that season ----------
const byTeamGame = {}; for (const t of T) (byTeamGame[`${t.y}|${t.off}|${t.game}`] ||= { y: t.y, off: t.off, game: t.game, wk: t.wk, list: [] }).list.push(t);
const role = {};   // `${y}|${game}|${id}` -> role
for (const g of Object.values(byTeamGame)) {
  const prior = T.filter(t => t.y === g.y && t.off === g.off && t.wk < g.wk), cnt = {}; for (const t of prior) cnt[t.id] = (cnt[t.id] || 0) + 1;
  const here = [...new Set(g.list.map(t => t.id))], rank = id => cnt[id] || 0;
  const wrs = here.filter(id => /WR/.test(pos[id] || "WR")).sort((a, b) => rank(b) - rank(a)), tes = here.filter(id => /TE/.test(pos[id] || "")).sort((a, b) => rank(b) - rank(a));
  for (const id of here) { const P = pos[id] || "WR"; role[`${g.y}|${g.game}|${id}`] = /RB|FB/.test(P) ? "RB" : /TE/.test(P) ? (id === tes[0] ? "TE1" : "WR3") : id === wrs[0] ? "WR1" : id === wrs[1] ? "WR2" : "WR3"; }
}

// ---------- each player's usual rates (season, leave-this-game-out) ----------
const ps = {}; for (const t of T) { const k = `${t.y}|${t.id}`; const s = ps[k] ||= { n: 0, c: 0, exp: 0, rz: 0, fp: 0, games: new Set(), byGame: {} }; s.n++; s.c += t.c; s.exp += t.exp; s.rz += t.rz; s.fp += t.fp; s.games.add(t.game); s.byGame[t.game] = (s.byGame[t.game] || 0) + 1; }
const teamTg = {}; for (const t of T) teamTg[`${t.y}|${t.game}|${t.off}`] = (teamTg[`${t.y}|${t.game}|${t.off}`] || 0) + 1;
const shareSum = {}; for (const t of T) { /* filled below */ }
// player's usual target share = his targets / team targets over his other games
const usualShare = {}; { const tt = {}; for (const t of T) { const k = `${t.y}|${t.id}`; (tt[k] ||= {}); tt[k][t.game] = teamTg[`${t.y}|${t.game}|${t.off}`]; }
  for (const [k, s] of Object.entries(ps)) usualShare[k] = { tg: s.n, team: Object.values(tt[k]).reduce((a, b) => a + b, 0), byGame: s.byGame, teamByGame: tt[k] }; }

// ---------- per defense-game-role observations over expected ----------
const obs = [];   // { y, wk, def, role, comp..., w }
for (const g of Object.values(byTeamGame)) {
  const def = g.list[0].def, tg = teamTg[`${g.y}|${g.game}|${g.off}`], ids = [...new Set(g.list.map(t => t.id))];
  for (const id of ids) {
    const k = `${g.y}|${id}`, s = ps[k], u = usualShare[k], mine = g.list.filter(t => t.id === id), n = mine.length;
    const oN = s.n - n, oTeam = u.team - tg; if (oN < 8 || oTeam < 30) continue;   // needs a usual to compare against
    const oc = (s.c - mine.reduce((a, t) => a + t.c, 0)) / oN, oe = (s.exp - mine.reduce((a, t) => a + t.exp, 0)) / oN, orz = (s.rz - mine.reduce((a, t) => a + t.rz, 0)) / oN, ofp = (s.fp - mine.reduce((a, t) => a + t.fp, 0)) / oN, osh = oN / oTeam;
    obs.push({ y: g.y, wk: g.wk, def, role: role[`${g.y}|${g.game}|${id}`], n,
      volume: n / tg - osh, success: mean(mine.map(t => t.c)) - oc, explosive: mean(mine.map(t => t.exp)) - oe, redzone: mean(mine.map(t => t.rz)) - orz, fpt: mean(mine.map(t => t.fp)) - ofp, baseFpt: ofp, baseShare: osh });
  }
}
console.error(`${obs.length} player-game observations`);

// ---------- predictive test: 2025 weeks 1-9 vs 10-18, per defense x role x component ----------
const agg = (rows, comp) => { let s = 0, w = 0; for (const r of rows) { const wt = comp === "volume" ? 1 : r.n; s += wt * r[comp]; w += wt; } return w ? s / w : null; };
const keep = {};
console.log("Predictive test (2025): does a defense's matchup in weeks 1-9 predict weeks 10-18? r = correlation across 32 defenses");
console.log(`${"role".padEnd(5)} ${COMP.map(c => c.padStart(10)).join("")}`);
for (const R of ROLES) {
  const line = [];
  for (const c of COMP) {
    const D = [...new Set(obs.map(o => o.def))], a = [], b = [];
    for (const d of D) { const x = agg(obs.filter(o => o.y === 2025 && o.def === d && o.role === R && o.wk <= 9), c), z = agg(obs.filter(o => o.y === 2025 && o.def === d && o.role === R && o.wk >= 10), c); if (x != null && z != null) { a.push(x); b.push(z); } }
    const r = corr(a, b); keep[`${R}|${c}`] = Math.max(0, r); line.push((isNaN(r) ? "-" : r.toFixed(2)).padStart(10));
  }
  console.log(`${R.padEnd(5)} ${line.join("")}`);
}
console.log("(keep = max(0, r) of the half-season number; a full season is worth more, so the slate table uses r scaled up by sample)");

// ---------- the slate: each defense vs the other side's roles, 2026 weighted ----------
const pool = readCSV(path.join("data", SLATE, fs.readdirSync(path.join("data", SLATE)).find(f => /Projections\.csv$/.test(f))));
const teams = [...new Set(pool.map(p => p.Team))];
console.log(`\nSlate ${SLATE}: matchups shrunk by the predictive test (2026 games weight 1, 2025 weight ${W25})`);
for (const def of teams) {
  const off = teams.find(t => t !== def);
  console.log(`\n${def} defense vs ${off} pass-catchers`);
  console.log(`${"role".padEnd(5)} ${"games".padStart(6)} | ${COMP.map(c => (c + " raw").padStart(13) + (c + " kept").padStart(13)).join("")}`);
  for (const R of ROLES) {
    const rows = obs.filter(o => o.def === def && o.role === R), w = r => (r.y === 2026 ? 1 : W25) * (true ? 1 : 0);
    const gEff = rows.reduce((s, r) => s + w(r), 0);
    const cells = COMP.map(c => { let s = 0, t = 0; for (const r of rows) { const wt = w(r) * (c === "volume" ? 1 : r.n); s += wt * r[c]; t += wt; } const raw = t ? s / t : null;
      // a half season (~8 games) earns weight keep; more games earn more (Spearman-Brown on the effective games)
      const k = keep[`${R}|${c}`], rel = k > 0 ? (gEff / 8 * k) / (1 + (gEff / 8 - 1) * k) : 0, kept = raw == null ? null : raw * Math.max(0, Math.min(1, rel));
      const f = v => v == null ? "—" : c === "fpt" ? (v >= 0 ? "+" : "") + v.toFixed(2) : (v >= 0 ? "+" : "") + (100 * v).toFixed(1) + "%";
      return f(raw).padStart(13) + f(kept).padStart(13); });
    console.log(`${R.padEnd(5)} ${gEff.toFixed(1).padStart(6)} | ${cells.join("")}`);
  }
}
console.log("\nvolume = share of team targets vs usual (points); success / explosive / redzone = rate per target vs usual; fpt = DK receiving points per target vs usual.");
