// Play-by-play NFL game sim, prototype (2026-10-14). One game, simulated play by play on the game clock: play count and pace
// come out of the clock rules and the game script, not a fixed number of plays. Built from nflverse play-by-play with 2026
// driving it (2026 games weight 1, 2025 games W25), roles from 2026 snap counts, anchored to the Pinnacle total and spread.
// Output per DK player: Proj (mean), Ceiling (average of the top 25% of sims), Super ceiling (top 10%), next to Stokastic and
// the market projection. Team-level coverage and weather are read from data/<slate>/free-inputs.json (weather: wind > 10 mph
// trims passing yards and 40+ yard field goals; coverage: shown, not used yet - the data check found it a small effect).
//   node bench/gamesim-nfl.mjs [--slate=2026-10-15-nfl-seaden] [--sims=10000] [--seed=1]
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SLATE = arg("slate", "2026-10-15-nfl-seaden"), SIMS = +arg("sims", 10000), SEED = +arg("seed", 1);
const W25 = 0.25, GDAY = +arg("gday", 0.12);   // GDAY: sd of each offense's day-to-day form (log scale)   // weight of a 2025 game vs a 2026 game: 17 games of 2025 count about as much as 4 games of 2026
const NV = "data/nflverse", t0 = Date.now();
const readCSV = f => { const b = fs.readFileSync(f), [h, ...rows] = parseCSV((f.endsWith(".gz") ? zlib.gunzipSync(b) : b).toString("utf8")); return rows.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const nrm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
const DK = { LA: "LAR", ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU" }, dk = t => DK[t] || t;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;

// ---------- slate inputs ----------
const sd = path.join("data", SLATE), projFile = fs.readdirSync(sd).find(f => /Projections\.csv$/.test(f));
const pool = readCSV(path.join(sd, projFile)).map(r => ({ name: r.Player, pos: r.Position, team: r.Team, opp: r.Opponent, sal: +r.Salary, proj: +r.Projection, own: +r["Ownership %"] }));
const TEAMS = [...new Set(pool.map(p => p.team))]; if (TEAMS.length !== 2) throw new Error("one game only: " + TEAMS.join(","));
const odds = fs.readdirSync("data/odds/nfl").filter(f => /^\d{4}-\d\d-\d\d-\d{4}\.json$/.test(f)).sort().reverse().map(f => JSON.parse(fs.readFileSync(path.join("data/odds/nfl", f), "utf8")));
const line = odds.map(o => o.games.find(g => TEAMS.includes(g.home) && TEAMS.includes(g.away))).find(Boolean);
if (!line) throw new Error("no Pinnacle line for " + TEAMS.join("@"));
const TARGET = { [line.home]: line.ttHome, [line.away]: line.ttAway };
const mktFile = fs.readdirSync("data/odds/nfl").filter(f => /-proj\.csv$/.test(f)).sort().pop(), market = {};
for (const r of readCSV(path.join("data/odds/nfl", mktFile))) if (TEAMS.includes(r.Team)) market[nrm(r.Player)] = +r.Proj;
const free = fs.existsSync(path.join(sd, "free-inputs.json")) ? JSON.parse(fs.readFileSync(path.join(sd, "free-inputs.json"), "utf8")) : null;
const wx = free && free.weather && free.weather.games[0] || null, WIND = wx && !wx.indoor ? wx.windMph || 0 : 0;

// ---------- play-by-play ----------
const plays = [];
for (const y of [2025, 2026]) for (const r of readCSV(`${NV}/play_by_play_${y}.csv.gz`)) if (r.season_type === "REG") { r._w = y === 2026 ? 1 : W25; r.posteam = dk(r.posteam); r.defteam = dk(r.defteam); plays.push(r); }
const snaps = [];
for (const y of [2025, 2026]) for (const r of readCSV(`${NV}/snap_counts_${y}.csv`)) if (r.game_type === "REG" && +r.offense_snaps > 0) snaps.push({ y, game: r.game_id, team: dk(r.team), key: nrm(r.player), snaps: +r.offense_snaps, pct: +r.offense_pct });
const roster = readCSV(`${NV}/roster_2026.csv`), idOf = {};
for (const r of roster) if (TEAMS.includes(dk(r.team)) && r.gsis_id) idOf[nrm(r.full_name)] = r.gsis_id;
console.error(`loaded ${plays.length} plays, ${snaps.length} snap rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- league tables (2025 + 2026, unweighted) ----------
const isPlay = r => r.play_type === "pass" || r.play_type === "run";
const distB = d => d <= 1 ? 1 : d <= 3 ? 3 : d <= 6 ? 6 : d <= 10 ? 10 : 99;
const fldB = y => y <= 5 ? 5 : y <= 10 ? 10 : y <= 20 ? 20 : y <= 50 ? 50 : y <= 80 ? 80 : 99;
const scB = s => s <= -17 ? -17 : s <= -9 ? -9 : s <= -4 ? -4 : s <= 3 ? 0 : s <= 8 ? 4 : s <= 16 ? 9 : 17;
const tmB = (q, half, gsr) => half <= 120 ? "2m" : q === 4 && gsr <= 300 ? "late" : "n";
const rzB = y => y <= 5 ? 5 : y <= 10 ? 10 : y <= 20 ? 20 : 0;
const counter = () => ({}), bump = (T, k, hit) => { const c = T[k] || (T[k] = [0, 0]); c[0] += hit; c[1]++; };
const PASS = counter();
const FOURTH = {}, FG = {}, CLOCK = {}, KO = [], PUNT = {}, SACK = [], SCR = [], INTSTART = [];
const POSPOOL = {}, RZPOOL = {}, CATCH = {};   // position yards on catch / rush (open field), red-zone (yards, td) pairs, catch rates by position x rz
let picks = 0, pick6 = 0, fumR = 0, rushN = 0, fumC = 0, recN = 0;
const OOB = { rec: [0, 0], rush: [0, 0] };   // clock stops when a ball carrier goes out of bounds (the sim had none: 2026-10-14 play-count fix)
const pos2 = {}; for (const r of roster) if (r.gsis_id) pos2[r.gsis_id] = r.position;
const allRoster = {}; // positions for every gsis seen in 2025/2026 rosters not loaded: fall back to the play's role
for (let i = 0; i < plays.length; i++) {
  const r = plays[i], n = plays[i + 1];
  if (isPlay(r) && +r.down >= 1 && +r.down <= 3 && r.qb_kneel !== "1" && r.qb_spike !== "1") {
    const k = [r.down, distB(+r.ydstogo), fldB(+r.yardline_100), scB(+r.score_differential), tmB(+r.qtr, +r.half_seconds_remaining, +r.game_seconds_remaining)], pass = r.play_type === "pass" ? 1 : 0;
    bump(PASS, k.join("|"), pass); bump(PASS, [k[0], k[1], k[3], k[4]].join("|"), pass); bump(PASS, [k[0], k[1], k[4]].join("|"), pass); bump(PASS, [k[0], k[1]].join("|"), pass);
  }
  if (+r.down === 4 && (isPlay(r) || r.play_type === "punt" || r.play_type === "field_goal")) {
    const yl = +r.yardline_100, f = yl <= 10 ? 10 : yl <= 20 ? 20 : yl <= 30 ? 30 : yl <= 40 ? 40 : yl <= 50 ? 50 : yl <= 65 ? 65 : 99, d = +r.ydstogo <= 1 ? 1 : +r.ydstogo <= 3 ? 3 : +r.ydstogo <= 6 ? 6 : 99;
    const late = +r.score_differential < 0 && (+r.qtr === 4 && +r.game_seconds_remaining <= 420) ? "trail" : "n", act = isPlay(r) ? "go" : r.play_type === "punt" ? "punt" : "fg";
    for (const k of [`${f}|${d}|${late}`, `${f}|${d}`]) { const c = FOURTH[k] || (FOURTH[k] = { go: 0, punt: 0, fg: 0, n: 0 }); c[act]++; c.n++; }
  }
  if (r.play_type === "field_goal" && r.kick_distance) bump(FG, Math.min(60, Math.floor(+r.kick_distance / 5) * 5), r.field_goal_result === "made" ? 1 : 0);
  if (r.play_type === "kickoff" && r._w === 1 && n && n.game_id === r.game_id && isPlay(n) && r.touchdown !== "1") KO.push(+n.yardline_100);
  if (r.play_type === "punt" && n && n.game_id === r.game_id && isPlay(n) && n.posteam !== r.posteam && r.touchdown !== "1") { const b = Math.floor(+r.yardline_100 / 10); (PUNT[b] || (PUNT[b] = [])).push(+n.yardline_100); }
  if (r.interception === "1") { picks++; if (r.td_team === r.defteam) pick6++; else if (n && n.game_id === r.game_id && isPlay(n) && n.posteam === r.defteam) INTSTART.push([+r.yardline_100, +n.yardline_100]); }
  if (r.sack === "1") SACK.push([+r.yards_gained, r.fumble_lost === "1" ? 1 : 0]);
  if (r.qb_scramble === "1") SCR.push(+r.yards_gained);
  // clock: seconds from this snap to the next snap on the same drive
  if (isPlay(r) && n && n.game_id === r.game_id && n.drive === r.drive && isPlay(n) && +n.qtr === +r.qtr) {
    const dt = +r.game_seconds_remaining - +n.game_seconds_remaining;
    if (dt > 0 && dt <= 60) { const stop = r.incomplete_pass === "1" || r.out_of_bounds === "1" || r.penalty === "1", s = +r.score_differential, hurry = +r.half_seconds_remaining <= 120 && s <= 0 || +r.qtr === 4 && +r.game_seconds_remaining <= 300 && s < 0;
      const script = hurry ? "hurry" : s <= -9 ? "trail" : s >= 9 ? "lead" : "close", k = `${stop ? "stop" : "live"}|${script}`; (CLOCK[k] || (CLOCK[k] = [])).push(dt); }
  }
  // outcome pools by position (who: receiver for passes, rusher for runs)
  const yl = +r.yardline_100, rz = rzB(yl);
  if (r.play_type === "pass" && r.receiver_player_id && r.sack !== "1" && r.qb_scramble !== "1") {
    const p = pos2[r.receiver_player_id] || "WR", P = /TE/.test(p) ? "TE" : /RB|FB/.test(p) ? "RB" : "WR";
    bump(CATCH, `${P}|${rz}`, r.complete_pass === "1" ? 1 : 0);
    if (r.complete_pass === "1" && r.touchdown !== "1") { OOB.rec[1]++; if (r.out_of_bounds === "1") OOB.rec[0]++; }
    if (r.complete_pass === "1") { recN++; if (r.fumble_lost === "1") fumC++; if (rz) (RZPOOL[`${P}|rec|${rz}`] || (RZPOOL[`${P}|rec|${rz}`] = [])).push([+r.yards_gained, r.touchdown === "1" ? 1 : 0]); else (POSPOOL[`${P}|rec`] || (POSPOOL[`${P}|rec`] = [])).push(+r.yards_gained); }
  }
  if (r.play_type === "run" && r.rusher_player_id && r.qb_scramble !== "1" && r.qb_kneel !== "1") {
    const p = pos2[r.rusher_player_id] || "RB", P = p === "QB" ? "QB" : "RB"; rushN++; if (r.touchdown !== "1") { OOB.rush[1]++; if (r.out_of_bounds === "1") OOB.rush[0]++; } if (r.fumble_lost === "1") fumR++;
    if (rz) (RZPOOL[`${P}|rush|${rz}`] || (RZPOOL[`${P}|rush|${rz}`] = [])).push([+r.yards_gained, r.touchdown === "1" ? 1 : 0]); else (POSPOOL[`${P}|rush`] || (POSPOOL[`${P}|rush`] = [])).push(+r.yards_gained);
  }
}
const passLeague = (d, dist, yl, sc, tm) => { for (const k of [[d, distB(dist), fldB(yl), scB(sc), tm], [d, distB(dist), scB(sc), tm], [d, distB(dist), tm], [d, distB(dist)]]) { const c = PASS[k.join("|")]; if (c && c[1] >= 40) return c[0] / c[1]; } return 0.58; };
const fgMake = dist => { const c = FG[Math.min(60, Math.floor(dist / 5) * 5)]; let p = c && c[1] >= 20 ? c[0] / c[1] : dist < 40 ? 0.93 : dist < 50 ? 0.8 : 0.6; if (dist >= 40 && WIND > 10) p *= 1 - 0.012 * (WIND - 10); return p; };
const TRANS = { td: [], to: [], punt: [], fg: [], downs: [] };
for (let i = 0; i < plays.length; i++) { const a = plays[i]; if (!isPlay(a)) continue; let j = i + 1, punt = false, fg = false; while (j < plays.length && plays[j].game_id === a.game_id && !isPlay(plays[j])) { if (plays[j].play_type === "punt") punt = true; if (plays[j].play_type === "field_goal") fg = true; j++; }
  const c = plays[j]; if (!c || c.game_id !== a.game_id || c.posteam === a.posteam) continue; const hf = q => q <= 2 ? 1 : q <= 4 ? 2 : 3; if (hf(+a.qtr) !== hf(+c.qtr)) continue;
  const dt = +a.game_seconds_remaining - +c.game_seconds_remaining; if (dt < 0 || dt > 120) continue;
  TRANS[a.touchdown === "1" ? "td" : a.interception === "1" || a.fumble_lost === "1" ? "to" : punt ? "punt" : fg ? "fg" : "downs"].push(dt); }
const ST = { ko: [0, 0], pr: [0, 0], pb: [0, 0], fgb: [0, 0] };
for (const r of plays) { if (r.kickoff_attempt === "1") { ST.ko[1]++; if (r.return_touchdown === "1") ST.ko[0]++; }
  if (r.punt_attempt === "1") { ST.pb[1]++; if (r.punt_blocked === "1") ST.pb[0]++; else { ST.pr[1]++; if (r.return_touchdown === "1") ST.pr[0]++; } }
  if (r.play_type === "field_goal") { ST.fgb[1]++; if (r.field_goal_result === "blocked") ST.fgb[0]++; } }
const koTD = ST.ko[0] / ST.ko[1], prTD = ST.pr[0] / ST.pr[1], puntBlk = ST.pb[0] / ST.pb[1], fgBlk = ST.fgb[0] / ST.fgb[1];
const leagueNeutral = mean([...(CLOCK["live|close"] || [])]);
const oobRec = OOB.rec[0] / OOB.rec[1], oobRush = OOB.rush[0] / OOB.rush[1];
const pickRate6 = pick6 / picks, fumRush = fumR / rushN, fumRec = fumC / recN;

// ---------- team and player model (2026 weighted) ----------
const games = {}; for (const r of plays) if (isPlay(r) && r.posteam) (games[r.posteam] || (games[r.posteam] = new Set())).add(r.game_id);
const active = {}; for (const s of snaps) (active[s.key] || (active[s.key] = new Set())).add(`${s.game}|${s.team}`);
const team = {};
for (const T of TEAMS) {
  const mine = plays.filter(r => r.posteam === T && isPlay(r) && r.qb_kneel !== "1" && r.qb_spike !== "1");
  // pass rate over expected and neutral pace, both shrunk toward league average
  let pw = 0, ps = 0; for (const r of mine) if (r.pass_oe !== "" && r.pass_oe != null && +r.down <= 3) { pw += r._w; ps += r._w * +r.pass_oe; }
  const proe = ps / (pw + 300) / 100;
  let cw = 0, cs = 0; for (let i = 0; i < plays.length - 1; i++) { const r = plays[i], n = plays[i + 1]; if (r.posteam !== T || !isPlay(r) || !isPlay(n) || n.drive !== r.drive || n.game_id !== r.game_id || +r.qtr > 3 || Math.abs(+r.score_differential) > 7 || r.incomplete_pass === "1" || r.out_of_bounds === "1") continue; const dt = +r.game_seconds_remaining - +n.game_seconds_remaining; if (dt > 0 && dt <= 60) { cw += r._w; cs += r._w * dt; } }
  const pace = (cs + 150 * leagueNeutral) / (cw + 150) / leagueNeutral;
  // players: active DK players on this team (projection > 0)
  const act = pool.filter(p => p.team === T && p.proj > 0 && ["QB", "RB", "WR", "TE"].includes(p.pos)).map(p => Object.assign({}, p, { id: idOf[nrm(p.name)] || null, key: nrm(p.name) }));
  const qb = act.filter(p => p.pos === "QB").sort((a, b) => b.proj - a.proj)[0];
  // shares: targets / carries in games the player was active for THIS team (snap counts), 2026 weighted
  const share = (p, kind) => { let num = 0, den = 0; const g = active[p.key] || new Set();
    for (const r of mine) { if (!g.has(`${r.game_id}|${T}`)) continue; const tgt = r.play_type === "pass" && r.receiver_player_id && r.sack !== "1" && r.qb_scramble !== "1", car = r.play_type === "run" && r.qb_scramble !== "1";
      if (kind === "tgt" && tgt) { den += r._w; if (r.receiver_player_id === p.id) num += r._w; } if (kind === "car" && car) { den += r._w; if (r.rusher_player_id === p.id) num += r._w; } }
    return den ? num / den : 0; };
  for (const p of act) { p.tgt = Math.max(share(p, "tgt"), p.pos === "QB" ? 0 : 0.01); p.car = Math.max(share(p, "car"), 0); }
  const nt = act.reduce((s, p) => s + p.tgt, 0), nc = act.reduce((s, p) => s + p.car, 0) || 1; for (const p of act) { p.tgt /= nt; p.car /= nc; }
  // efficiency: player's own pools (any team, 2026 weighted) blended toward position pools by sample size
  for (const p of act) {
    const rec = [], rush = []; let tg = 0, cmp = 0;
    for (const r of plays) { if (!p.id) break; const rz = rzB(+r.yardline_100);
      if (r.receiver_player_id === p.id && r.play_type === "pass" && r.sack !== "1") { tg += r._w; if (r.complete_pass === "1") { cmp += r._w; if (!rz) rec.push([+r.yards_gained, r._w]); } }
      if (r.rusher_player_id === p.id && r.play_type === "run" && r.qb_scramble !== "1" && r.qb_kneel !== "1" && !rz) rush.push([+r.yards_gained, r._w]); }
    const P = p.pos === "QB" ? "QB" : p.pos, lc = CATCH[`${P === "QB" ? "WR" : P}|0`]; p.catchR = (cmp + 30 * lc[0] / lc[1]) / (tg + 30);
    p.recPool = rec; p.recA = rec.reduce((s, x) => s + x[1], 0) / (rec.reduce((s, x) => s + x[1], 0) + 30);
    p.rushPool = rush; p.rushA = rush.reduce((s, x) => s + x[1], 0) / (rush.reduce((s, x) => s + x[1], 0) + 50);
  }
  // QB: sacks, scrambles, interceptions, completion over expected
  let db = 0, sk = 0, sc = 0, att = 0, it = 0, cp = 0, cpw = 0; const scr = [];
  for (const r of plays) { if (!qb || !qb.id) break; if (r.passer_player_id === qb.id && r.play_type === "pass") { db += r._w; if (r.sack === "1") sk += r._w; else { att += r._w; if (r.interception === "1") it += r._w; if (r.cpoe !== "" && r.cpoe != null) { cp += r._w * +r.cpoe; cpw += r._w; } } }
    if (r.rusher_player_id === qb.id && r.qb_scramble === "1") { db += r._w; sc += r._w; scr.push([+r.yards_gained, r._w]); } }
  team[T] = { T, proe, pace, act, qb, sack: (sk + 150 * 0.07) / (db + 150), scr: (sc + 150 * 0.05) / (db + 150), int: (it + 200 * 0.023) / (att + 200), cpoe: cp / (cpw + 200) / 100, scrPool: scr,
    k: pool.find(p => p.team === T && p.pos === "K"), dst: pool.find(p => p.team === T && p.pos === "DST"), cov: free && free.coverage ? free.coverage.rows.find(r => r.team === T) : null, mult: 1 };
}
{ let lsk = 0, ldb = 0, lit = 0, lat = 0; for (const r of plays) if (r.play_type === "pass") { ldb++; if (r.sack === "1") lsk++; else if (r.qb_scramble !== "1") { lat++; if (r.interception === "1") lit++; } }
  for (const T of TEAMS) { let db = 0, sk = 0, at = 0, it = 0; for (const r of plays) if (r.defteam === T && r.play_type === "pass") { db += r._w; if (r.sack === "1") sk += r._w; else if (r.qb_scramble !== "1") { at += r._w; if (r.interception === "1") it += r._w; } }
    team[T].dSack = (sk + 300 * lsk / ldb) / (db + 300) / (lsk / ldb); team[T].dInt = (it + 400 * lit / lat) / (at + 400) / (lit / lat); } }
console.error(`model built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- sampling ----------
let rng = mulberry32(SEED);
const pickArr = a => a[Math.floor(rng() * a.length)];
const pickW = a => { let t = 0; for (const x of a) t += x[1]; let u = rng() * t; for (const x of a) { u -= x[1]; if (u <= 0) return x[0]; } return a[a.length - 1][0]; };
const choose = (list, key) => { let u = rng(); for (const p of list) { u -= p[key]; if (u <= 0) return p; } return list[list.length - 1]; };
const dtOf = (stop, script, T) => { const a = CLOCK[`${stop ? "stop" : "live"}|${script}`] || CLOCK[`${stop ? "stop" : "live"}|close`]; const d = pickArr(a); return stop || script === "hurry" ? d : d * team[T].pace; };

// ---------- one game ----------
function game(stat) {
  for (const T of TEAMS) { const z = Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng()); team[T].multG = team[T].mult * Math.exp(GDAY * z - GDAY * GDAY / 2); }
  const [A, B] = TEAMS, score = { [A]: 0, [B]: 0 }, dstS = { [A]: { sack: 0, int: 0, fr: 0, td: 0, sfty: 0, blk: 0 }, [B]: { sack: 0, int: 0, fr: 0, td: 0, sfty: 0, blk: 0 } };
  const add = (p, k, v) => { const s = stat[p.name] || (stat[p.name] = {}); s[k] = (s[k] || 0) + v; };
  const dg = { drives: 0, stop: 0, live: 0, stopT: 0, liveT: 0, kneel: 0, xfer: 0 }; let to = { [A]: 3, [B]: 3 }, lastDt = 0, half = 1, clock = 1800, recv = rng() < 0.5 ? A : B, firstRecv = recv, pos = recv, yl = pickArr(KO), down = 1, togo = 10, nplays = 0, ot = false, otPoss = { [A]: 0, [B]: 0 };
  const other = t => t === A ? B : A;
  const kickoff = to => { if (rng() < koTD) { dstS[to].td++; score[to] += 6; if (rng() < 0.95) { score[to] += 1; const k = team[to].k; if (k) add(k, "xp", 1); } clock -= 12; to = other(to); if (rng() < koTD) to = other(to); }
    dg.drives++; pos = to; yl = pickArr(KO); down = 1; togo = 10; if (ot) otPoss[to]++; };
  const turnover = (to, at) => { dg.drives++; pos = to; yl = Math.min(99, Math.max(1, at)); down = 1; togo = 10; if (ot) otPoss[to]++; };
  const scoreTD = T => { score[T] += 6; const k = team[T].k; if (rng() < 0.95) { score[T] += 1; if (k) add(k, "xp", 1); } };
  const qtrOf = () => half === 1 ? (clock > 900 ? 1 : 2) : half === 2 ? (clock > 900 ? 3 : 4) : 5;
  const gsr = () => half === 1 ? 1800 + clock : clock;
  while (true) {
    if (clock <= 0) {
      if (half === 1) { half = 2; clock = 1800; to = { [A]: 3, [B]: 3 }; kickoff(other(firstRecv)); continue; }
      if (half === 2 && score[A] === score[B]) { half = 3; ot = true; clock = 600; to = { [A]: 2, [B]: 2 }; kickoff(rng() < 0.5 ? A : B); continue; }
      break;
    }
    if (ot && score[A] !== score[B] && otPoss[A] >= 1 && otPoss[B] >= 1) break;
    const T = pos, D = other(T), M = team[T], diff = score[T] - score[D], q = qtrOf(), tm = tmB(q, clock, gsr());
    const script = (clock <= 120 && diff <= 0) || (q === 4 && clock <= 300 && diff < 0) ? "hurry" : diff <= -9 ? "trail" : diff >= 9 ? "lead" : "close";
    // run out the clock
    if (q === 4 && diff > 0 && clock <= 40 * (5 - down - to[D])) { dg.kneel++; clock -= 40; down++; nplays++; if (down > 4) turnover(D, 100 - yl); continue; }
    // end-of-half or game-winning field goal
    if (yl <= 40 && ((clock <= 8 && (half === 1 || (diff >= -3 && diff <= 0)))) ) { fieldGoal(T); continue; }
    if (down === 4) {
      const f = yl <= 10 ? 10 : yl <= 20 ? 20 : yl <= 30 ? 30 : yl <= 40 ? 40 : yl <= 50 ? 50 : yl <= 65 ? 65 : 99, d = togo <= 1 ? 1 : togo <= 3 ? 3 : togo <= 6 ? 6 : 99, late = diff < 0 && q === 4 && clock <= 420 ? "trail" : "n";
      const c = FOURTH[`${f}|${d}|${late}`] && FOURTH[`${f}|${d}|${late}`].n >= 20 ? FOURTH[`${f}|${d}|${late}`] : FOURTH[`${f}|${d}`]; const u = rng() * c.n;
      if (u < c.punt) { clock -= Math.max(0, pickArr(TRANS.punt) - lastDt);
        if (rng() < puntBlk) { dstS[D].blk++; turnover(D, Math.max(1, 100 - yl - 8)); continue; }
        if (rng() < prTD) { dstS[D].td++; score[D] += 6; if (rng() < 0.95) { score[D] += 1; const k = team[D].k; if (k) add(k, "xp", 1); } kickoff(T); continue; }
        const b = Math.floor(yl / 10), a = PUNT[b] || PUNT[Math.min(9, b + 1)] || [80]; turnover(D, pickArr(a)); continue; }
      if (u < c.punt + c.fg) { fieldGoal(T); continue; }
    }
    nplays++;
    let p = passLeague(down, togo, yl, diff, tm) + M.proe; p = Math.min(0.97, Math.max(0.05, p));
    let gain = 0, stop = false, td = false, lost = false, rz = rzB(yl);
    if (rng() < p) {
      if (rng() < M.sack * team[D].dSack) { const [y, f] = pickArr(SACK); gain = y; dstS[D].sack++; if (f) lost = true; }
      else if (rng() < M.scr / (1 - M.sack * team[D].dSack)) { const qb = M.qb; gain = M.scrPool.length && rng() < M.scrPool.length / (M.scrPool.length + 40) ? pickW(M.scrPool) : pickArr(SCR); gain = Math.round(gain * (gain > 0 ? M.multG : 1)); if (gain >= yl) { gain = yl; td = true; } if (qb) { add(qb, "rushYds", gain); if (td) add(qb, "rushTD", 1); } if (!td && rng() < oobRush * 1.5) stop = true; }
      else if (rng() < M.int * team[D].dInt) { dstS[D].int++; if (rng() < pickRate6) { dstS[D].td++; score[D] += 6; if (rng() < 0.95) { score[D] += 1; const k = team[D].k; if (k) add(k, "xp", 1); } clock -= pickArr(TRANS.to); kickoff(T); continue; } const near = INTSTART.filter(x => Math.abs(x[0] - yl) <= 10); turnover(D, near.length ? pickArr(near)[1] : 100 - yl + 10); clock -= pickArr(TRANS.to); continue; }
      else {
        const tgt = choose(M.act, "tgt"), P = tgt.pos === "QB" ? "WR" : tgt.pos, cr = CATCH[`${P}|${rz}`], base = CATCH[`${P}|0`];
        const cp = Math.min(0.95, Math.max(0.2, (tgt.catchR + M.cpoe) * (rz ? (cr[0] / cr[1]) / (base[0] / base[1]) : 1)));
        add(tgt, "tgt", 1);
        if (rng() < cp) {
          if (rz) { const [y, t] = pickArr(RZPOOL[`${P}|rec|${rz}`]); td = t === 1 ? (M.multG >= 1 || rng() < M.multG) : (M.multG > 1 && rng() < Math.min(0.5, (M.multG - 1) * 0.6)); gain = td ? yl : Math.min(y, yl - 1); }
          else { let y = tgt.recPool.length && rng() < tgt.recA ? pickW(tgt.recPool) : pickArr(POSPOOL[`${P}|rec`]); if (y > 0) y = Math.round(y * M.multG * (WIND > 10 ? 1 - 0.004 * (WIND - 10) : 1)); gain = y; if (gain >= yl) { gain = yl; td = true; } }
          add(tgt, "rec", 1); add(tgt, "recYds", gain); add(M.qb, "passYds", gain); if (td) { add(tgt, "recTD", 1); add(M.qb, "passTD", 1); }
          if (!td && rng() < fumRec) { lost = true; add(tgt, "fum", 1); }
          else if (!td && rng() < oobRec) stop = true;
        } else stop = true;
      }
    } else {
      const ru = choose(M.act, "car"), P = ru.pos === "QB" ? "QB" : "RB";
      if (rz) { const a = RZPOOL[`${P}|rush|${rz}`] || RZPOOL[`RB|rush|${rz}`]; const [y, t] = pickArr(a); td = t === 1 ? (M.multG >= 1 || rng() < M.multG) : (M.multG > 1 && rng() < Math.min(0.5, (M.multG - 1) * 0.6)); gain = td ? yl : Math.min(y, yl - 1); }
      else { let y = ru.rushPool.length && rng() < ru.rushA ? pickW(ru.rushPool) : pickArr(POSPOOL[`${P}|rush`] || POSPOOL["RB|rush"]); if (y > 0) y = Math.round(y * M.multG); gain = y; if (gain >= yl) { gain = yl; td = true; } }
      add(ru, "rushYds", gain); add(ru, "car", 1); if (td) add(ru, "rushTD", 1);
      if (!td && rng() < fumRush) { lost = true; add(ru, "fum", 1); }
      else if (!td && rng() < oobRush) stop = true;
    }
    const downsOut = !td && !lost && yl - gain < 100 && gain < togo && down === 4;
    if (td) clock -= pickArr(TRANS.td); else if (lost) clock -= pickArr(TRANS.to); else if (downsOut) clock -= pickArr(TRANS.downs);
    else if (!stop && to[D] > 0 && ((half >= 2 && q === 4 && clock <= 300 && diff > 0 && diff <= 16) || (half === 1 && clock <= 120 && rng() < 0.5))) { to[D]--; const dtv = dtOf(true, "hurry", T); lastDt = dtv; dg.to = (dg.to || 0) + 1; clock -= dtv; }
    else if (!stop && script === "hurry" && to[T] > 0 && clock <= 120 && rng() < 0.4) { to[T]--; const dtv = dtOf(true, "hurry", T); lastDt = dtv; dg.to = (dg.to || 0) + 1; clock -= dtv; }
    else { const dtv = dtOf(stop, script, T); lastDt = dtv; if (stop) { dg.stop++; dg.stopT += dtv; } else { dg.live++; dg.liveT += dtv; } clock -= dtv; }
    if (td) { scoreTD(T); kickoff(D); continue; }
    if (lost) { dstS[D].fr++; turnover(D, 100 - (yl - gain)); continue; }
    yl -= gain;
    if (yl >= 100) { score[D] += 2; dstS[D].sfty++; kickoff(T); continue; }   // safety: free kick, approximated as a kickoff to the scoring side's opponent
    if (gain >= togo) { down = 1; togo = Math.min(10, yl); } else { down++; togo -= gain; if (down > 4) turnover(D, 100 - yl); }
  }
  function fieldGoal(T) { const dist = yl + 17, k = team[T].k; clock -= Math.max(0, pickArr(TRANS.fg) - lastDt); if (rng() < fgBlk) { dstS[other(T)].blk++; turnover(other(T), Math.max(20, 100 - (yl + 7))); return; }
    if (rng() < fgMake(dist) / (1 - fgBlk)) { score[T] += 3; if (k) add(k, dist >= 50 ? "fg50" : dist >= 40 ? "fg40" : "fg0", 1); kickoff(other(T)); } else turnover(other(T), Math.max(20, 100 - (yl + 7))); }
  return { score, dstS, nplays, dg };
}

// ---------- DK scoring ----------
const dkPts = (p, s, g) => {
  if (p.pos === "K") return (s.xp || 0) + 3 * (s.fg0 || 0) + 4 * (s.fg40 || 0) + 5 * (s.fg50 || 0);
  if (p.pos === "DST") { const d = g.dstS[p.team], pa = g.score[p.opp]; return d.sack + 2 * d.int + 2 * d.fr + 6 * d.td + 2 * d.sfty + 2 * d.blk + (pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4); }
  const py = s.passYds || 0, ry = s.rushYds || 0, cy = s.recYds || 0;
  return 0.04 * py + 4 * (s.passTD || 0) - (s.int || 0) + (py >= 300 ? 3 : 0) + 0.1 * ry + 6 * (s.rushTD || 0) + (ry >= 100 ? 3 : 0) + (s.rec || 0) + 0.1 * cy + 6 * (s.recTD || 0) + (cy >= 100 ? 3 : 0) - (s.fum || 0);
};

// interceptions are charged to the QB inside game(); count them here from the DST side
function run(n, seed) {
  rng = mulberry32(seed); const pts = {}, tm = { [TEAMS[0]]: [], [TEAMS[1]]: [] }, np = [];
  const scored = pool.filter(p => p.proj > 0);
  for (let i = 0; i < n; i++) { const stat = {}, g = game(stat); (run.dg ||= []).push(g.dg); tm[TEAMS[0]].push(g.score[TEAMS[0]]); tm[TEAMS[1]].push(g.score[TEAMS[1]]); np.push(g.nplays);
    for (const T of TEAMS) { const q = team[T].qb; if (q) { const s = stat[q.name] || (stat[q.name] = {}); s.int = g.dstS[TEAMS.find(x => x !== T)].int; } }
    for (const p of scored) (pts[p.name] || (pts[p.name] = [])).push(dkPts(p, stat[p.name] || {}, g)); }
  return { pts, tm, np };
}

// ---------- market calibration: scale each offense until its mean points match the Pinnacle team total ----------
const tc = Date.now();
for (let it = 0; it < 6; it++) { const r = run(2000, 100 + it); for (const T of TEAMS) { const m = mean(r.tm[T]); team[T].mult *= Math.pow(TARGET[T] / m, 0.8); } }
const calMs = Date.now() - tc, ts = Date.now();
run.dg = []; const R = run(SIMS, SEED), simMs = Date.now() - ts;
{ const D = run.dg, m = k => (D.reduce((a, x) => a + x[k], 0) / D.length); console.log(`DIAG per game: plays ${mean(R.np).toFixed(1)}, drives ${m("drives").toFixed(1)}, kneels ${m("kneel").toFixed(1)}, timeouts ${(D.reduce((a, x) => a + (x.to || 0), 0) / D.length).toFixed(1)} | stop ${m("stop").toFixed(1)} plays avg ${(m("stopT") / m("stop")).toFixed(1)}s, live ${m("live").toFixed(1)} avg ${(m("liveT") / m("live")).toFixed(1)}s`); }

// ---------- report ----------
const tail = (a, f) => { const s = a.slice().sort((x, y) => y - x), k = Math.max(1, Math.floor(s.length * f)); return mean(s.slice(0, k)); };
const [A, B] = TEAMS, sa = R.tm[A], sb = R.tm[B], diffs = sa.map((x, i) => x - sb[i]);
console.log(`\n${A} @ ${B}? market ${line.away}@${line.home}: ${line.away} ${TARGET[line.away]} / ${line.home} ${TARGET[line.home]}, total ${line.total}, spread ${line.home} ${line.spread > 0 ? "+" : ""}${line.spread}`);
console.log(`sim (${SIMS}): ${A} ${mean(sa).toFixed(1)}, ${B} ${mean(sb).toFixed(1)}, total ${mean(sa.map((x, i) => x + sb[i])).toFixed(1)}; ${A} wins ${(100 * diffs.filter(d => d > 0).length / SIMS).toFixed(0)}%, ties ${(100 * diffs.filter(d => d === 0).length / SIMS).toFixed(1)}%`);
{ const tot = sa.map((x, i) => x + sb[i]), mt = mean(tot), sdt = Math.sqrt(mean(tot.map(x => (x - mt) ** 2))), ma = mean(sa), mb = mean(sb); let n = 0, da = 0, db = 0; for (let i = 0; i < sa.length; i++) { n += (sa[i] - ma) * (sb[i] - mb); da += (sa[i] - ma) ** 2; db += (sb[i] - mb) ** 2; } console.log(`game totals: sd ${sdt.toFixed(2)} (real vs closing line 13.11), team-score correlation ${(n / Math.sqrt(da * db)).toFixed(3)} (real 0.004)`); }
console.log(`plays per game (offensive snaps both teams): 10th ${R.np.slice().sort((a, b) => a - b)[Math.floor(SIMS * 0.1)]}, median ${R.np.slice().sort((a, b) => a - b)[SIMS >> 1]}, 90th ${R.np.slice().sort((a, b) => a - b)[Math.floor(SIMS * 0.9)]}`);
console.log(`defense factors: ${TEAMS.map(T => `${T} sack x${team[T].dSack.toFixed(2)} int x${team[T].dInt.toFixed(2)}`).join(", ")} | QB sack ${TEAMS.map(T => `${T} ${(100 * team[T].sack).toFixed(1)}%`).join(" ")} int ${TEAMS.map(T => `${T} ${(100 * team[T].int).toFixed(1)}%`).join(" ")}`);
console.log(`special teams: kickoff return TD ${(100 * koTD).toFixed(2)}%, punt return TD ${(100 * prTD).toFixed(2)}%, blocked punt ${(100 * puntBlk).toFixed(2)}%, blocked FG ${(100 * fgBlk).toFixed(2)}%`);
console.log(`out of bounds: catches ${(100 * oobRec).toFixed(1)}%, runs ${(100 * oobRush).toFixed(1)}%`);
console.log(`calibration multipliers: ${TEAMS.map(T => `${T} ${team[T].mult.toFixed(3)}`).join(", ")} | pace ${TEAMS.map(T => `${T} ${team[T].pace.toFixed(2)}`).join(", ")} | PROE ${TEAMS.map(T => `${T} ${(100 * team[T].proe).toFixed(1)}`).join(", ")} | wind ${WIND} mph`);
if (free && free.coverage) console.log(`coverage (Sharp, shown only): ${free.coverage.rows.map(r => `${r.team} man ${r["Man Rate"]}% zone ${r["Zone Rate"]}%`).join(", ")}`);
console.log(`timing: calibration ${(calMs / 1000).toFixed(1)}s (12,000 games), final ${(simMs / 1000).toFixed(1)}s (${SIMS} games, ${(simMs / SIMS).toFixed(2)} ms/game), total ${((Date.now() - t0) / 1000).toFixed(1)}s incl. loading`);
console.log(`\n${"player".padEnd(22)} pos team  sal   tgt%  car% | sim proj  ceil  super | Stok  market`);
const rows = pool.filter(p => p.proj > 0).map(p => ({ p, a: R.pts[p.name] })).sort((x, y) => mean(y.a) - mean(x.a));
for (const { p, a } of rows) { const m = team[p.team].act.find(x => x.name === p.name);
  console.log(`${p.name.padEnd(22)} ${p.pos.padEnd(3)} ${p.team.padEnd(4)} ${String(p.sal).padStart(5)} ${m ? (100 * m.tgt).toFixed(0).padStart(5) : "    -"} ${m ? (100 * m.car).toFixed(0).padStart(5) : "    -"} | ${mean(a).toFixed(1).padStart(8)} ${tail(a, 0.25).toFixed(1).padStart(5)} ${tail(a, 0.1).toFixed(1).padStart(6)} | ${p.proj.toFixed(1).padStart(4)} ${market[nrm(p.name)] != null ? market[nrm(p.name)].toFixed(1).padStart(7) : "      -"}`); }
// who booms together: correlation of DK points across sims, and how often B has a top-25% game when A does (base 25%)
const key = rows.filter(r => mean(r.a) >= 4).map(r => r.p.name), corrOf = (x, y) => { const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0; for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; } return n / Math.sqrt(dx * dy); };
const top = {}; for (const n of key) { const a = R.pts[n], cut = a.slice().sort((x, y) => y - x)[Math.floor(a.length * 0.25)]; top[n] = a.map(v => v > cut); }
const C = {}, pairs = []; for (let i = 0; i < key.length; i++) for (let j = i + 1; j < key.length; j++) { const a = key[i], b = key[j], r = corrOf(R.pts[a], R.pts[b]); let both = 0, ta = 0; for (let k = 0; k < SIMS; k++) if (top[a][k]) { ta++; if (top[b][k]) both++; } (C[a] ||= {})[b] = +r.toFixed(3); (C[b] ||= {})[a] = +r.toFixed(3); pairs.push({ a, b, r, cond: both / ta }); }
const tOf = n => pool.find(p => p.name === n).team;
console.log("\nWho booms together (correlation of DK points; 'both' = how often B has a top-25% game when A does, base 25%)");
console.log("  same team, strongest:"); for (const x of pairs.filter(x => tOf(x.a) === tOf(x.b)).sort((u, v) => v.r - u.r).slice(0, 8)) console.log(`    ${x.a} + ${x.b}: r ${x.r.toFixed(2)}, both ${(100 * x.cond).toFixed(0)}%`);
console.log("  same team, most negative (compete for the same volume):"); for (const x of pairs.filter(x => tOf(x.a) === tOf(x.b)).sort((u, v) => u.r - v.r).slice(0, 5)) console.log(`    ${x.a} + ${x.b}: r ${x.r.toFixed(2)}, both ${(100 * x.cond).toFixed(0)}%`);
console.log("  bring-backs (opposing teams), strongest:"); for (const x of pairs.filter(x => tOf(x.a) !== tOf(x.b)).sort((u, v) => v.r - u.r).slice(0, 8)) console.log(`    ${x.a} + ${x.b}: r ${x.r.toFixed(2)}, both ${(100 * x.cond).toFixed(0)}%`);
const out = { built: new Date().toISOString(), corr: C, slate: SLATE, sims: SIMS, w25: W25, market: line, mult: Object.fromEntries(TEAMS.map(T => [T, team[T].mult])), players: rows.map(({ p, a }) => ({ name: p.name, pos: p.pos, team: p.team, sal: p.sal, proj: +mean(a).toFixed(2), ceil: +tail(a, 0.25).toFixed(2), superCeil: +tail(a, 0.1).toFixed(2), stokastic: p.proj, market: market[nrm(p.name)] ?? null })) };
fs.writeFileSync(path.join(sd, "gamesim.json"), JSON.stringify(out, null, 1)); console.log(`\n-> ${path.join(sd, "gamesim.json")}`);
