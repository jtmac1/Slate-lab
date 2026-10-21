// QB matchups by defense, walk-forward (method of bench/matchup-study2-nfl.mjs, where it held up: QBs vs defenses that give
// up more than expected won top-1% ~2.3x as often per unit of ownership in 2025-26, beyond the Vegas total). For every
// season-week: each defense's QB DK points allowed vs those QBs' own prior baselines, from games before that week (this season
// weight 1, last season 0.25), needing 4+ weighted games. The optimizer reads it for its QB tilt; the backtest reads history.
//   node bench/qb-matchups-nfl.mjs  -> data/reports/qb-matchups-nfl.json { built, current: { season, week, defs }, history: { "y|wk": { DEF: m } } }
import fs from "node:fs";
import zlib from "node:zlib";
import { parseCSV } from "../src/engine/csv.mjs";

const NV = "data/nflverse", LAST = 0.25, YEARS = [2024, 2025, 2026].filter(y => fs.existsSync(`${NV}/play_by_play_${y}.csv.gz`));
const readCSV = f => { const b = fs.readFileSync(f), [h, ...rows] = parseCSV((f.endsWith(".gz") ? zlib.gunzipSync(b) : b).toString("utf8")); return rows.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const DK = { LA: "LAR", OAK: "LV", SD: "LAC" }, dk = t => DK[t] || t;

// QB games: passing + rushing DK points
const G = {}, weeks = new Set();
for (const y of YEARS) for (const r of readCSV(`${NV}/play_by_play_${y}.csv.gz`)) {
  if (r.season_type !== "REG" || !r.posteam) continue; weeks.add(`${y}|${+r.week}`);
  const add = id => G[`${y}|${r.game_id}|${id}`] ||= { y, wk: +r.week, id, def: dk(r.defteam), db: 0, py: 0, ptd: 0, int: 0, ry: 0, rtd: 0, fum: 0 };
  if (r.play_type === "pass" && r.passer_player_id) { const s = add(r.passer_player_id); s.db++; s.py += +r.passing_yards || 0; if (r.pass_touchdown === "1") s.ptd++; if (r.interception === "1") s.int++; }
  if ((r.play_type === "run" || r.qb_scramble === "1") && r.rusher_player_id && G[`${y}|${r.game_id}|${r.rusher_player_id}`]) { const s = G[`${y}|${r.game_id}|${r.rusher_player_id}`]; s.ry += +r.rushing_yards || 0; if (r.rush_touchdown === "1") s.rtd++; }
  if (r.fumble_lost === "1" && r.fumbled_1_player_id && G[`${y}|${r.game_id}|${r.fumbled_1_player_id}`]) G[`${y}|${r.game_id}|${r.fumbled_1_player_id}`].fum++;
}
const pts = s => 0.04 * s.py + 4 * s.ptd - s.int + (s.py >= 300 ? 3 : 0) + 0.1 * s.ry + 6 * s.rtd + (s.ry >= 100 ? 3 : 0) - s.fum;
const QG = Object.values(G).filter(s => s.db >= 15).map(s => Object.assign(s, { pts: pts(s) })).sort((a, b) => a.y - b.y || a.wk - b.wk);
// strict prior baseline per QB game, then each defense's history of (expected, actual)
const hist = {}, DEF = {};
for (const s of QG) { const H = hist[s.id] || []; let W = 0, p = 0; for (const h of H) { const k = h.y === s.y ? 1 : h.y === s.y - 1 ? LAST : 0; W += k; p += k * h.pts; } if (W >= 3) (DEF[s.def] ||= []).push({ y: s.y, wk: s.wk, exp: p / W, act: s.pts }); (hist[s.id] = H).push(s); }
const at = (y, wk) => { const out = {}; for (const [d, H] of Object.entries(DEF)) { let W = 0, e = 0, a = 0; for (const h of H) { const k = h.y === y && h.wk < wk ? 1 : h.y === y - 1 ? LAST : 0; if (!k) continue; W += k; e += k * h.exp; a += k * h.act; } if (W >= 4 && e > 0) out[d] = +(a / e - 1).toFixed(4); } return out; };
const history = {}; for (const k of weeks) { const [y, wk] = k.split("|").map(Number); history[k] = at(y, wk); }
// the upcoming week: one past the last week with games in the newest season
const ys = Math.max(...YEARS), lastWk = Math.max(...[...weeks].filter(k => +k.split("|")[0] === ys).map(k => +k.split("|")[1])), cur = { season: ys, week: lastWk + 1, defs: at(ys, lastWk + 1) };
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/qb-matchups-nfl.json", JSON.stringify({ built: new Date().toISOString(), current: cur, history }));
const r = Object.entries(cur.defs).sort((a, b) => b[1] - a[1]);
console.log(`${ys} week ${cur.week}: softest ${r.slice(0, 4).map(([d, m]) => `${d} +${(100 * m).toFixed(0)}%`).join(", ")} | toughest ${r.slice(-3).map(([d, m]) => `${d} ${(100 * m).toFixed(0)}%`).join(", ")} -> data/reports/qb-matchups-nfl.json`);
