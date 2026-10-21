// Data check for a play-by-play NFL game sim (2026-10-14): what nflverse gives us, how complete it is, and how stable the
// inputs are year to year. Reads data/nflverse (play_by_play_<y>.csv.gz, pbp_participation_<y>.csv, ftn_charting_<y>.csv).
//   node bench/pbp-datacheck-nfl.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import { parseCSV } from "../src/engine/csv.mjs";

const D = "data/nflverse", YEARS = [2023, 2024, 2025, 2026];
const read = f => { const p = `${D}/${f}`; if (!fs.existsSync(p)) return null; const b = fs.readFileSync(p); const [h, ...rows] = parseCSV((p.endsWith(".gz") ? zlib.gunzipSync(b) : b).toString("utf8")); return rows.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "—";
const key = r => `${r.game_id || r.nflverse_game_id}|${r.play_id || r.nflverse_play_id}`;

const P = {}, PART = {}, FTN = {};
for (const y of YEARS) {
  P[y] = read(`play_by_play_${y}.csv.gz`); PART[y] = read(`pbp_participation_${y}.csv`); FTN[y] = read(`ftn_charting_${y}.csv`);
  console.error(`${y}: pbp ${P[y]?.length ?? "none"}, participation ${PART[y]?.length ?? "none"}, ftn ${FTN[y]?.length ?? "none"}`);
}
const isDrop = r => r.play_type === "pass" || r.qb_dropback === "1";

// 1. coverage of each input on dropbacks
console.log("\n1. Fill rate on dropbacks (regular season)");
for (const y of YEARS) {
  const drops = P[y].filter(r => r.season_type === "REG" && isDrop(r)), part = PART[y] ? new Map(PART[y].map(r => [key(r), r])) : null, ftn = FTN[y] ? new Map(FTN[y].map(r => [key(r), r])) : null;
  let cov = 0, mz = 0, pres = 0, ttt = 0, route = 0, fb = 0, nb = 0;
  for (const r of drops) { const a = part && part.get(key(r)); if (a) { if (a.defense_coverage_type) cov++; if (a.defense_man_zone_type) mz++; if (a.was_pressure !== "" && a.was_pressure != null) pres++; if (+a.time_to_throw > 0) ttt++; if (a.route) route++; }
    const f = ftn && ftn.get(key(r)); if (f) { fb++; if (+f.n_pass_rushers > 0) nb++; } }
  console.log(`  ${y}: ${drops.length} dropbacks | coverage type ${pct(cov, drops.length)}, man/zone ${pct(mz, drops.length)}, pressure ${pct(pres, drops.length)}, time to throw ${pct(ttt, drops.length)}, route ${pct(route, drops.length)} | FTN row ${pct(fb, drops.length)}, pass rushers charted ${pct(nb, drops.length)}`);
}

// 2. team defense tendencies: man rate and blitz rate, 2024 -> 2025 stability (participation) and 2025 -> 2026 (FTN blitz)
console.log("\n2. Team defense tendencies, year to year (correlation across 32 teams)");
const defRate = (y, test) => { const part = new Map(PART[y].map(r => [key(r), r])), t = {}; for (const r of P[y]) { if (r.season_type !== "REG" || !isDrop(r)) continue; const a = part.get(key(r)); if (!a || !a.defense_man_zone_type) continue; const x = (t[r.defteam] ??= [0, 0]); x[1]++; if (test(a)) x[0]++; } return t; };
const ftnBlitz = y => { const f = new Map(FTN[y].map(r => [key(r), r])), t = {}; for (const r of P[y]) { if (r.season_type !== "REG" || !isDrop(r)) continue; const a = f.get(key(r)); if (!a || !(+a.n_pass_rushers > 0)) continue; const x = (t[r.defteam] ??= [0, 0]); x[1]++; if (+a.n_blitzers > 0) x[0]++; } return t; };
const yy = (A, B, lab) => { const tm = Object.keys(A).filter(k => B[k]); const a = tm.map(k => A[k][0] / A[k][1]), b = tm.map(k => B[k][0] / B[k][1]); console.log(`  ${lab}: r ${corr(a, b).toFixed(2)} (${tm.length} teams, mean ${(100 * mean(a)).toFixed(0)}% -> ${(100 * mean(b)).toFixed(0)}%)`); };
yy(defRate(2024, a => /MAN/i.test(a.defense_man_zone_type)), defRate(2025, a => /MAN/i.test(a.defense_man_zone_type)), "man coverage rate 2024 -> 2025");
yy(defRate(2023, a => /MAN/i.test(a.defense_man_zone_type)), defRate(2024, a => /MAN/i.test(a.defense_man_zone_type)), "man coverage rate 2023 -> 2024");
yy(ftnBlitz(2024), ftnBlitz(2025), "blitz rate (FTN) 2024 -> 2025");
{ const A = ftnBlitz(2025), B = ftnBlitz(2026); yy(A, B, "blitz rate (FTN) 2025 -> 2026 so far"); }

// 3. player splits: receiving yards per dropback on the field, vs man and vs zone; 2024 -> 2025 stability of the man-minus-zone gap
console.log("\n3. Receiver man-vs-zone split stability (yards per dropback on field), 2024 -> 2025");
const split = y => { const part = new Map(PART[y].map(r => [key(r), r])), S = {};
  for (const r of P[y]) { if (r.season_type !== "REG" || !isDrop(r)) continue; const a = part.get(key(r)); if (!a || !a.defense_man_zone_type) continue; const man = /MAN/i.test(a.defense_man_zone_type);
    const yds = +r.receiving_yards || 0, rec = r.receiver_player_id;
    for (const id of (a.offense_players || "").split(";")) { const s = (S[id] ??= { m: 0, z: 0, ym: 0, yz: 0 }); if (man) { s.m++; if (id === rec) s.ym += yds; } else { s.z++; if (id === rec) s.yz += yds; } } }
  return S; };
const S24 = split(2024), S25 = split(2025);
for (const minMan of [50, 100, 150]) {
  const ids = Object.keys(S25).filter(id => S24[id] && S24[id].m >= minMan && S25[id].m >= minMan && S24[id].z >= 3 * minMan && S25[id].z >= 3 * minMan && (S24[id].ym + S24[id].yz) / (S24[id].m + S24[id].z) > 0.6);
  const gap = s => s.ym / s.m - s.yz / s.z, lvl = s => (s.ym + s.yz) / (s.m + s.z);
  console.log(`  ${minMan}+ man dropbacks both years (${ids.length} players): overall yards/dropback r ${corr(ids.map(i => lvl(S24[i])), ids.map(i => lvl(S25[i]))).toFixed(2)}, man-minus-zone gap r ${corr(ids.map(i => gap(S24[i])), ids.map(i => gap(S25[i]))).toFixed(2)}`);
}

// 4. pace: offensive seconds per play in neutral situations (score within 7, quarters 1-3), by team; stability and range
console.log("\n4. Pace: seconds per offensive play, neutral situations (score within 7, Q1-Q3, same drive)");
const pace = (y, half) => { const T = {}; const rows = P[y].filter(r => r.season_type === "REG");
  for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], b = rows[i]; if (a.game_id !== b.game_id || a.drive !== b.drive || a.posteam !== b.posteam || !a.posteam) continue; if (!/pass|run/.test(a.play_type) || !/pass|run/.test(b.play_type)) continue;
    if (+a.qtr > 3 || Math.abs(+a.score_differential) > 7 || +a.qtr !== +b.qtr) continue; const dt = +a.game_seconds_remaining - +b.game_seconds_remaining; if (!(dt > 0 && dt < 60)) continue;
    if (half != null && (+a.week % 2) !== half) continue; const x = (T[a.posteam] ??= []); x.push(dt); }
  return Object.fromEntries(Object.entries(T).map(([k, v]) => [k, mean(v)])); };
const p24 = pace(2024), p25 = pace(2025), p26 = pace(2026), odd = pace(2026, 1), even = pace(2026, 0);
const pr = (A, B, lab) => { const tm = Object.keys(A).filter(k => B[k] != null); console.log(`  ${lab}: r ${corr(tm.map(k => A[k]), tm.map(k => B[k])).toFixed(2)}`); };
const r25 = Object.values(p25).sort((a, b) => a - b); console.log(`  2025 range ${r25[0].toFixed(1)}s to ${r25[r25.length - 1].toFixed(1)}s per play, median ${r25[16].toFixed(1)}s`);
pr(p24, p25, "2024 -> 2025 team pace"); pr(p25, p26, "2025 -> 2026 so far"); pr(odd, even, "2026 odd weeks vs even weeks");
// plays per game by team-game, and how much the trailing team speeds up
const ppg = {}; for (const r of P[2025]) { if (r.season_type !== "REG" || !/pass|run/.test(r.play_type) || !r.posteam) continue; const k = r.game_id + "|" + r.posteam; ppg[k] = (ppg[k] || 0) + 1; }
const v = Object.values(ppg).sort((a, b) => a - b); console.log(`  2025 offensive plays per team-game: 10th pct ${v[Math.floor(v.length * 0.1)]}, median ${v[v.length >> 1]}, 90th ${v[Math.floor(v.length * 0.9)]}`);
const g = {}; for (const [k, n] of Object.entries(ppg)) { const gid = k.split("|")[0]; g[gid] = (g[gid] || 0) + n; } const gv = Object.values(g).sort((a, b) => a - b); console.log(`  2025 total plays per game: 10th pct ${gv[Math.floor(gv.length * 0.1)]}, median ${gv[gv.length >> 1]}, 90th ${gv[Math.floor(gv.length * 0.9)]}`);
const sc = { trail: [], lead: [], close: [] }; { const rows = P[2025].filter(r => r.season_type === "REG"); for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], b = rows[i]; if (a.game_id !== b.game_id || a.drive !== b.drive || !/pass|run/.test(a.play_type) || !/pass|run/.test(b.play_type) || +a.qtr !== +b.qtr || +a.qtr < 2) continue; const dt = +a.game_seconds_remaining - +b.game_seconds_remaining; if (!(dt > 0 && dt < 60)) continue; const sd = +a.score_differential; (sd <= -9 ? sc.trail : sd >= 9 ? sc.lead : sc.close).push(dt); } }
console.log(`  2025 seconds per play by score (Q2-Q4): trailing 9+ ${mean(sc.trail).toFixed(1)}s, within 8 ${mean(sc.close).toFixed(1)}s, leading 9+ ${mean(sc.lead).toFixed(1)}s`);

// 5. DK points from play-by-play: can we rebuild each player's DK score? (sanity: compare to nflverse 'fantasy' columns not needed; count fields present)
const need = ["passing_yards", "pass_touchdown", "interception", "rushing_yards", "rush_touchdown", "receiving_yards", "complete_pass", "fumble_lost", "two_point_conv_result", "receiver_player_id", "rusher_player_id", "passer_player_id"];
console.log(`\n5. DK scoring fields in pbp: ${need.map(f => f + (P[2026][0][f] !== undefined ? " ok" : " MISSING")).join(", ")}`);
