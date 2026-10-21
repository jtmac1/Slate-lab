// Backtest of the in-game "points still to come" model in bench/lateswap-nba.mjs on 2025-26 NBA games (built 2026-10-21).
// ESPN public scoreboard + summary (box score and play-by-play) for every game on the dates we have Stokastic classic contests
// for, cached trimmed + gzipped in data/nba-pbp/ so reruns are offline. From the play-by-play, each player's minutes, DK points
// and fouls at the end of Q1, halftime and the end of Q3 (substitutions; a period's starters = players whose first event in it is
// not checking in). Final DK points from the box score. Pre-lock projection = Stokastic projection on the slate (data/post/nba).
// No historical Blick minutes: mplay = the player's season-to-date average minutes in games he played (our sample, earlier
// dates, 3+ games). Players with no minutes in the game (DNP, known before tip) are left out.
// Variants scored on predicted final DK points: (a) the current locked block, (b) pure pace, (c) projection x share of game left,
// (d) blend of a and b, (e) shrunk minutes share + shrunk per-minute rate + blowout cut, fitted. Free parameters are fitted on
// the even-indexed games and reported on the odd ones.
//   node bench/backtest-lateswap-nba.mjs [--fetch]   -> data/reports/nba/lateswap-backtest.json + .txt
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { listPost, readPost } from "./post-store.mjs";
import { SIGMA_DEF, SIGMA_TILT, SIGMA_TILT_REF } from "../src/engine/model.mjs";

const CACHE = "data/nba-pbp", OUT = "data/reports/nba", FETCH = process.argv.includes("--fetch");
const nm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");
const gzr = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8")), gzw = (f, o) => fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(o), { level: 6 }));
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });

// projections: date|name -> Stokastic projection, classic slates
const proj = new Map();
for (const f of listPost("nba")) { const j = readPost(f), c = j.contest; if (/showdown/i.test(c.type + " " + c.name)) continue;
  for (const p of j.players || []) { const k = c.date + "|" + nm(p.name); if (p.proj > 0 && !proj.has(k)) proj.set(k, p.proj); } }
const dates = [...new Set([...proj.keys()].map(k => k.split("|")[0]))].filter(d => d >= "2025-10-01" && d < "2026-07-01").sort();   // 2025-26 season

// ESPN fetch (sequential scoreboard, 4 concurrent summaries); a summary keeps the box score, the plays and the header only
const get = async u => { for (let t = 0; t < 3; t++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {} await new Promise(r => setTimeout(r, 1500)); } return null; };
const trimPlay = p => ({ t: p.type?.text || "", x: p.text || "", per: p.period?.number, clk: p.clock?.displayValue, sv: p.scoringPlay ? p.scoreValue : 0, h: p.homeScore, a: p.awayScore, ids: (p.participants || []).map(q => q.athlete?.id) });
const trimBox = b => (b?.players || []).map(t => { const s = t.statistics[0]; return { team: t.team.abbreviation, labels: s.labels || s.names,
  ath: s.athletes.map(a => ({ id: a.athlete.id, name: a.athlete.displayName, starter: !!a.starter, dnp: !!a.didNotPlay || !a.stats?.length, stats: a.stats })) }; });
if (FETCH) {
  let nNew = 0;
  for (const d of dates) {
    const sf = path.join(CACHE, `sb-${d}.json.gz`);
    if (!fs.existsSync(sf)) { const sb = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d.replace(/-/g, "")}`); if (!sb) { console.log("scoreboard failed " + d); continue; }
      gzw(sf, (sb.events || []).map(e => ({ id: e.id, final: !!e.competitions[0].status.type.completed, teams: e.competitions[0].competitors.map(c => ({ abbr: c.team.abbreviation, ha: c.homeAway })) }))); }
    const todo = gzr(sf).filter(e => e.final && !fs.existsSync(path.join(CACHE, `g-${e.id}.json.gz`)));
    for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(async e => {
      const s = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${e.id}`); if (!s?.plays?.length) { console.log("no pbp " + e.id); return; }
      gzw(path.join(CACHE, `g-${e.id}.json.gz`), { id: e.id, date: d, teams: e.teams, box: trimBox(s.boxscore), plays: s.plays.map(trimPlay) }); nNew++; }));
    process.stdout.write(`\r${d} fetched ${nNew}   `);
  }
  console.log();
}

// DK points from a stat line
const dk = s => { const tens = [s.pts, s.reb, s.ast, s.stl, s.blk].filter(x => x >= 10).length;
  return s.pts + 0.5 * s.tpm + 1.25 * s.reb + 1.5 * s.ast + 2 * s.stl + 2 * s.blk - 0.5 * s.to + (tens >= 2 ? 1.5 : 0) + (tens >= 3 ? 3 : 0); };
const clockMin = c => { c = String(c || "0"); if (c.includes(":")) { const [m, s] = c.split(":").map(Number); return m + s / 60; } return +c / 60; };
const perLen = p => p <= 4 ? 12 : 5, perStart = p => p <= 4 ? (p - 1) * 12 : 48 + (p - 5) * 5;
const CK = [12, 24, 36];

// one game -> per player: final DK, box minutes, and at each checkpoint {m, pts, fouls, margin (own team)}
function parseGame(g) {
  const team = new Map(), info = new Map(); let ok = true;
  for (const t of g.box) { const L = t.labels;
    for (const a of t.ath) { team.set(a.id, t.team); if (a.dnp) continue; const o = Object.fromEntries(L.map((l, j) => [l, a.stats[j]]));
      const fs_ = { pts: +o.PTS, tpm: +String(o["3PT"]).split("-")[0], reb: +o.REB, ast: +o.AST, to: +o.TO, stl: +o.STL, blk: +o.BLK };
      info.set(a.id, { id: a.id, name: a.name, team: t.team, starter: a.starter, min: +o.MIN || 0, pf: +o.PF || 0, box: fs_, final: dk(fs_) }); } }
  const home = g.teams.find(t => t.ha === "home")?.abbr;
  const st = new Map(), S = id => { if (!st.has(id)) st.set(id, { pts: 0, tpm: 0, reb: 0, ast: 0, to: 0, stl: 0, blk: 0, pf: 0, min: 0, on: null }); return st.get(id); };
  // period starters
  const byPer = new Map(); for (const p of g.plays) { if (!byPer.has(p.per)) byPer.set(p.per, []); byPer.get(p.per).push(p); }
  const snaps = {}; let lastScore = { h: 0, a: 0 };
  const onCourt = new Set(), clockOf = p => perStart(p.per) + perLen(p.per) - clockMin(p.clk);
  const off = (id, t) => { const s = S(id); if (s.on != null) { s.min += t - s.on; s.on = null; } onCourt.delete(id); }, on = (id, t) => { const s = S(id); if (s.on == null) s.on = t; onCourt.add(id); };
  const snap = t => { const o = {}; for (const id of info.keys()) { const s = S(id); const m = s.min + (s.on != null ? t - s.on : 0);
      const tm = info.get(id).team, mg = tm === home ? lastScore.h - lastScore.a : lastScore.a - lastScore.h; o[id] = { m, pts: dk(s), pf: s.pf, margin: mg }; } return o; };
  const prevEnd = new Set();
  for (const per of [...byPer.keys()].sort((a, b) => a - b)) {
    const ps = byPer.get(per), t0 = perStart(per), first = new Map();
    for (const p of ps) { const isSub = /substitution/i.test(p.t);
      p.ids.forEach((id, k) => { if (id && info.has(id) && !first.has(id)) first.set(id, isSub ? (k === 0 ? "in" : "out") : "ev"); }); }
    const starters = new Set([...first].filter(([, v]) => v !== "in").map(([id]) => id));
    if (per === 1) for (const a of info.values()) if (a.starter) starters.add(a.id);
    for (const tm of new Set([...info.values()].map(a => a.team))) {   // silent full-period players: fill to 5 from last period's end lineup
      const n = [...starters].filter(id => info.get(id).team === tm).length;
      if (n < 5) [...prevEnd].filter(id => info.get(id)?.team === tm && !starters.has(id) && first.get(id) !== "in").slice(0, 5 - n).forEach(id => starters.add(id)); }
    for (const id of starters) on(id, t0);
    for (const p of ps) { const t = clockOf(p), ty = p.t, [a, b] = p.ids, has = id => id && info.has(id);
      for (const c of CK) if (!snaps[c] && t > c + 1e-9 && per > (c / 12)) snaps[c] = snap(c);
      if (p.h != null) lastScore = { h: p.h, a: p.a };
      if (/substitution/i.test(ty)) { if (has(a)) on(a, t); if (has(b)) off(b, t); continue; }
      if (p.sv > 0 && has(a)) { S(a).pts += p.sv; if (p.sv === 3) S(a).tpm++; if (/assist/i.test(p.x) && has(b)) S(b).ast++; continue; }
      if (/blocks/.test(p.x) && has(b)) S(b).blk++;
      if (/rebound/i.test(ty) && has(a) && !/team rebound/i.test(p.x)) S(a).reb++;
      if (/turnover|traveling/i.test(ty + " " + p.x) && has(a) && !/team turnover|shot clock/i.test(p.x)) { S(a).to++; if (/steal/i.test(p.x) && has(b)) S(b).stl++; }
      if (/foul/i.test(ty) && !/turnover|technical/i.test(ty) && has(a)) S(a).pf++;
    }
    const tEnd = t0 + perLen(per); for (const c of CK) if (!snaps[c] && Math.abs(tEnd - c) < 1e-9) snaps[c] = snap(c);
    prevEnd.clear(); for (const id of onCourt) prevEnd.add(id);
    for (const id of [...onCourt]) off(id, tEnd);
  }
  const lastPer = Math.max(...byPer.keys());
  for (const id of info.keys()) { const s = S(id), a = info.get(id); a.pbpMin = s.min; a.pbpDk = dk(s); a.pbpPf = s.pf; }
  if (lastPer < 4 || CK.some(c => !snaps[c])) ok = false;
  return { ok, info, snaps, ot: lastPer > 4 };
}

// load games in date order, season-to-date average minutes (games played) before each date
const files = fs.readdirSync(CACHE).filter(f => /^g-/.test(f)).map(f => gzr(path.join(CACHE, f))).filter(g => dates.includes(g.date)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
const hist = new Map(), recs = []; let nG = 0, nBad = 0, minErr = [], dkErr = [], pfErr = [];
for (let gi = 0; gi < files.length; gi++) {
  const g = files[gi], r = parseGame(g); if (!r.ok) { nBad++; continue; } nG++;
  for (const a of r.info.values()) { minErr.push(Math.abs(a.pbpMin - a.min)); dkErr.push(Math.abs(a.pbpDk - a.final)); pfErr.push(Math.abs(a.pbpPf - a.pf)); }
  for (const a of r.info.values()) {
    const h = hist.get(a.id), pr = proj.get(g.date + "|" + nm(a.name));
    if (a.min > 0 && pr > 0 && h && h.n >= 3) {
      const mplay = h.sum / h.n;
      recs.push({ g: nG, date: g.date, name: a.name, starter: a.starter, proj: pr, mplay, final: a.final, ot: r.ot,
        ck: CK.map(c => ({ c, ...r.snaps[c][a.id] })) });
    }
  }
  for (const a of r.info.values()) if (a.min > 0 && g.date) { const h = hist.get(a.id) || { sum: 0, n: 0, date: "" }; if (h.date !== g.date) { h.sum += a.min; h.n++; h.date = g.date; } hist.set(a.id, h); }
}
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1), q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const recon = { games: nG, skipped: nBad, playerGames: minErr.length, minAbsErrMean: +mean(minErr).toFixed(3), minAbsErrP95: +q(minErr, 0.95).toFixed(2), dkAbsErrMean: +mean(dkErr).toFixed(3), dkExactShare: +(dkErr.filter(x => x < 0.01).length / dkErr.length).toFixed(3), pfAbsErrMean: +mean(pfErr).toFixed(3) };
console.log(`games ${nG} (skipped ${nBad}), records ${recs.length}; play-by-play vs box: |min| ${recon.minAbsErrMean} (p95 ${recon.minAbsErrP95}), |DK| ${recon.dkAbsErrMean} (exact ${(100 * recon.dkExactShare).toFixed(0)}%), |PF| ${recon.pfAbsErrMean}`);

// full-game spread: lognormal with the tilted NBA sigma (the sim's default when the file has no Std Dev)
const fullSd = p => { const s = Math.min(1.2, SIGMA_DEF.nba.PG * Math.pow(Math.max(3, p) / SIGMA_TILT_REF.nba, SIGMA_TILT.nba)); return p * Math.sqrt(Math.exp(s * s) - 1); };

// variants: each returns { mu, sd } given a record r and checkpoint k
const left = k => 48 - k.c;
const cur = (r, k, o = {}) => {
  if (k.m === 0 && k.c >= 24) return { mu: k.pts, sd: 0.01, mLeft: 0 };
  const pace = k.m / k.c * left(k), mLeft = Math.min(0.9 * left(k), Math.max(pace, r.mplay - k.m));
  return { mu: k.pts + r.proj / r.mplay * mLeft, sd: Math.max(0.01, fullSd(r.proj) * Math.sqrt(Math.min(1, mLeft / r.mplay))), mLeft };
};
const pace = (r, k) => { const mLeft = k.m / k.c * left(k); return { mu: k.pts + k.pts / k.c * left(k), sd: Math.max(0.01, fullSd(r.proj) * Math.sqrt(Math.min(1, mLeft / r.mplay))) }; };
const share = (r, k) => ({ mu: k.pts + r.proj * left(k) / 48, sd: Math.max(0.01, fullSd(r.proj) * Math.sqrt(left(k) / 48)) });
const blend = w => (r, k) => { const a = cur(r, k), b = pace(r, k); return { mu: w * a.mu + (1 - w) * b.mu, sd: a.sd }; };
// (e) minutes share of the rest of the game: prior share mplay/48 shrunk with the live share (K pseudo-minutes of prior), cut by
// B per point of margin past M (either side) for players over 24 mplay, 0 if not in by halftime; per-minute rate: projected rate
// shrunk with the live rate (R pseudo-minutes of prior). Spread: C x full sd x sqrt(minutes left / mplay).
const fixd = P => (r, k) => {
  if (k.m === 0 && k.c >= 24) return { mu: k.pts, sd: 0.01, mLeft: 0 };
  let sh = (r.mplay / 48 * P.K + k.m) / (P.K + k.c);
  const over = Math.max(0, Math.abs(k.margin) - P.M); if (r.mplay >= 24) sh *= Math.max(0, 1 - P.B * over);
  const mLeft = Math.min(P.cap, sh) * left(k), rate = (r.proj / r.mplay * P.R + k.pts) / (P.R + k.m);
  return { mu: k.pts + rate * mLeft, sd: Math.max(0.01, P.C * fullSd(r.proj) * Math.sqrt(Math.min(1, mLeft / r.mplay))), mLeft };
};

const train = recs.filter(r => r.g % 2 === 0), test = recs.filter(r => r.g % 2 === 1);
const maeOf = (fn, rs, ks = [0, 1, 2]) => { let s = 0, n = 0; for (const r of rs) for (const i of ks) { s += Math.abs(fn(r, r.ck[i]).mu - r.final); n++; } return s / n; };
// fit (d): w
let bw = 1, bm = 1e9; for (let w = 0; w <= 1.0001; w += 0.05) { const m = maeOf(blend(w), train); if (m < bm) { bm = m; bw = +w.toFixed(2); } }
// fit (e): coordinate descent on MAE, then C for 68% coverage on train
const grid = { K: [0, 3, 6, 12, 24, 36, 48, 72, 96, 144, 1e6], R: [0, 5, 10, 20, 30, 45, 60, 90, 120, 200, 1e6], M: [10, 12, 15, 18, 20, 25, 30], B: [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1] };   // cap is not binding on season-average minutes (MAE flat 0.7-1.0); fixed at 0.85 as in lateswap-nba.mjs
let PE = { K: 48, R: 60, M: 15, B: 0, cap: 0.85, C: 1 }, best = maeOf(fixd(PE), train);
for (let it = 0; it < 4; it++) for (const key of Object.keys(grid)) for (const v of grid[key]) { const t = { ...PE, [key]: v }, m = maeOf(fixd(t), train); if (m < best - 1e-6) { best = m; PE = t; } }
const cover = (fn, rs, z, ks = [0, 1, 2]) => { let n = 0, h = 0; for (const r of rs) for (const i of ks) { const o = fn(r, r.ck[i]); if (o.sd < 0.02) continue; n++; if (Math.abs(r.final - o.mu) <= z * o.sd) h++; } return h / (n || 1); };
{ let bc = 1, bd = 1; for (let c = 0.5; c <= 3.001; c += 0.05) { const d = Math.abs(cover(fixd({ ...PE, C: c }), train, 1) - 0.6827); if (d < bd) { bd = d; bc = +c.toFixed(2); } } PE.C = bc; }
console.log(`fit on ${train.length} train records: blend w(a) ${bw}; fixed ${JSON.stringify(PE)}`);
const sens = {}; for (const key of Object.keys(grid)) sens[key] = grid[key].map(v => [v, +maeOf(fixd({ ...PE, [key]: v }), train).toFixed(3)]);
console.log("train MAE around the fit: " + Object.entries(sens).map(([k, a]) => `${k} ` + a.map(([v, m]) => `${v >= 1e6 ? "inf" : v}:${m}`).join(" ")).join("\n  "));

const V = { "a current": cur, "b pace": pace, "c proj share": share, [`d blend ${bw}a`]: blend(bw), e_fixed: fixd(PE), "e minus blowout": fixd({ ...PE, B: 0 }) };
const buckets = { all: () => true, starters: r => r.starter, bench: r => !r.starter, "foul3+": (r, k) => k.pf >= 3, "blowout15+": (r, k) => Math.abs(k.margin) >= 15, "close<15": (r, k) => Math.abs(k.margin) < 15 };
const stats = (fn, rs, ki, bf) => { const e = [], z = []; let in1 = 0, in80 = 0, nz = 0;
  for (const r of rs) { const k = r.ck[ki]; if (!bf(r, k)) continue; const o = fn(r, k), d = r.final - o.mu; e.push(d);
    if (o.sd >= 0.02) { nz++; if (Math.abs(d) <= o.sd) in1++; if (Math.abs(d) <= 1.2816 * o.sd) in80++; } }
  return { n: e.length, mae: +mean(e.map(Math.abs)).toFixed(2), bias: +mean(e).toFixed(2), in1sd: +(in1 / (nz || 1)).toFixed(3), in80: +(in80 / (nz || 1)).toFixed(3) }; };
const table = {}, lines = [];
lines.push(`NBA late-swap points-to-come backtest, ${new Date().toISOString().slice(0, 10)}. ${nG} games (${dates[0]} to ${dates[dates.length - 1]}), ${recs.length} player-games with a Stokastic projection and 3+ prior games;`,
  `fit on ${train.length} (even games), held-out ${test.length} (odd games). mplay = season-to-date avg minutes (no historical Blick). Full sd = lognormal tilted NBA sigma.`,
  `Play-by-play reconstruction vs box: mean |min| ${recon.minAbsErrMean}, |DK| ${recon.dkAbsErrMean}, |PF| ${recon.pfAbsErrMean}.`,
  `Predicted final DK points, HELD-OUT. MAE / bias (actual - predicted) / share inside +-1 sd (target .683) / inside 80% (target .80). d: w=${bw} on (a). e: ${JSON.stringify(PE)}`, "");
for (const [bn, bf] of Object.entries(buckets)) { table[bn] = {};
  lines.push(`-- ${bn}`); lines.push(`${"variant".padEnd(18)} ${CK.map(c => `${("@" + c + "m").padEnd(7)} n     MAE   bias  1sd   80%  `).join("| ")}`);
  for (const [vn, fn] of Object.entries(V)) { table[bn][vn] = CK.map((c, i) => ({ c, ...stats(fn, test, i, bf) }));
    lines.push(`${vn.padEnd(18)} ${table[bn][vn].map(s => `${" ".repeat(7)} ${String(s.n).padEnd(5)} ${s.mae.toFixed(2).padStart(5)} ${s.bias.toFixed(2).padStart(6)} ${s.in1sd.toFixed(2)} ${s.in80.toFixed(2)} `).join("| ")}`); }
  lines.push(""); }
const txt = lines.join("\n"); console.log(txt);
fs.writeFileSync(path.join(OUT, "lateswap-backtest.txt"), txt + "\n");
fs.writeFileSync(path.join(OUT, "lateswap-backtest.json"), JSON.stringify({ built: new Date().toISOString(), recon, games: nG, records: recs.length, train: train.length, test: test.length, blendW: bw, fixed: PE, trainSensitivity: sens, heldOut: table }, null, 1));
