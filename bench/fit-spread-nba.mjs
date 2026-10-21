// NBA classic outcome spread by player role (2026-10-21). How wide and how right-skewed a player's actual DK score is around
// his pre-lock Stokastic projection, by role, and a sigma model built only from what the pool has at lock (projection,
// salary, his projection rank on his team). Player-games: every player with a projection on a pulled classic slate
// (data/post/nba; the biggest slate of the date when he is on several) joined by date + name to the ESPN box score cache
// (data/nba-pbp, bench/backtest-lateswap-nba.mjs --fetch) for his real DK points, minutes, start, and the final margin.
// DNPs (no minutes) are counted apart and left out: the pool zeroes known outs, and late scratches are P(play)'s job.
// Lognormal fitted by maximum likelihood with games under 25% of projection left-censored (busts stay in the likelihood
// without their log blowing up). Fit on odd date indexes, checked on even ones: PIT coverage of the central 50/80/95%
// intervals, how often a player doubles his projection or falls under half of it, by role and by slate size.
//   node bench/fit-spread-nba.mjs   -> data/reports/nba/spread-nba.json (+ the role table in stdout)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { listPost, readPost } from "./post-store.mjs";
import { SIGMA_DEF, SIGMA_TILT, SIGMA_TILT_REF, SIGMA_MAX, pnorm, NBA_SPREAD, nbaSpreadSigma, nbaSpreadBust } from "../src/engine/model.mjs";

const CACHE = "data/nba-pbp";
const nm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|ii|iii|iv)$/, "");
const gzr = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
const dk = s => { const tens = [s.pts, s.reb, s.ast, s.stl, s.blk].filter(x => x >= 10).length;
  return s.pts + 0.5 * s.tpm + 1.25 * s.reb + 1.5 * s.ast + 2 * s.stl + 2 * s.blk - 0.5 * s.to + (tens >= 2 ? 1.5 : 0) + (tens >= 3 ? 3 : 0); };
export const sizeOf = g => g <= 1 ? "1" : g <= 4 ? "2-4" : g <= 7 ? "5-7" : "8+";
export const SIZES = ["2-4", "5-7", "8+"];

// player-games: { date, di (date index), id, name, team, opp, pos, sal, proj, own, rank (team proj rank), games (slate), gkey (ESPN game id),
//   act, min, starter, dnp, margin (own final), total, ot, mAvg/mCv/startShare/dkAvg (season to date, 3+ prior games) }
export function loadPlayerGames() {
  const slate = new Map();   // date|nm -> best record (biggest slate)
  for (const f of listPost("nba")) {
    const j = readPost(f), c = j.contest; if (/showdown/i.test(c.type + " " + c.name) || !j.players?.length) continue;
    if (c.date < "2025-10-01" || c.date >= "2026-07-01") continue;
    const P = j.players.filter(p => p.proj > 0), games = new Set(P.map(p => [p.team, p.opp].sort().join("@"))).size;
    const byTeam = {}; for (const p of P) (byTeam[p.team] ||= []).push(p);
    for (const t in byTeam) byTeam[t].sort((a, b) => b.proj - a.proj).forEach((p, i) => p._rank = i + 1);
    for (const p of P) { const k = c.date + "|" + nm(p.name), o = slate.get(k); if (o && o.games >= games) continue;
      slate.set(k, { date: c.date, id: p.id, name: p.name, team: p.team, opp: p.opp, pos: p.pos, sal: p.sal, proj: p.proj, own: 100 * (p.pown || 0), rank: p._rank, games }); }
  }
  const dates = [...new Set([...slate.values()].map(r => r.date))].sort(), dIdx = new Map(dates.map((d, i) => [d, i]));
  const files = fs.readdirSync(CACHE).filter(f => /^g-/.test(f)).map(f => gzr(path.join(CACHE, f))).filter(g => dIdx.has(g.date)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const hist = new Map(), out = [], seen = new Set(); let unmatchedBox = 0;
  for (const g of files) {
    const last = g.plays[g.plays.length - 1] || {}, home = g.teams.find(t => t.ha === "home")?.abbr, ot = Math.max(...g.plays.map(p => p.per || 0)) > 4;
    const ptsOf = {}; for (const t of g.box) ptsOf[t.team] = t.ath.reduce((s, a) => s + (a.dnp ? 0 : +a.stats[a.stats.length ? 1 : 0] || 0), 0);
    const hs = last.h ?? ptsOf[home], as = last.a ?? ptsOf[g.teams.find(t => t.ha === "away")?.abbr];
    const cur = [];
    for (const t of g.box) { const L = t.labels;
      for (const a of t.ath) { const o = a.dnp ? null : Object.fromEntries(L.map((l, j) => [l, a.stats[j]]));
        const min = o ? +o.MIN || 0 : 0, act = o ? dk({ pts: +o.PTS, tpm: +String(o["3PT"]).split("-")[0], reb: +o.REB, ast: +o.AST, to: +o.TO, stl: +o.STL, blk: +o.BLK }) : 0;
        const margin = t.team === home ? hs - as : as - hs, k = g.date + "|" + nm(a.name), s = slate.get(k), h = hist.get(a.id);
        if (s && !seen.has(k)) { seen.add(k);
          out.push({ ...s, di: dIdx.get(g.date), gkey: g.id, espnTeam: t.team, act, min, starter: !!a.starter, dnp: !(min > 0), margin, total: hs + as, ot,
            mAvg: h && h.n >= 3 ? h.m / h.n : null, mCv: h && h.n >= 3 ? Math.sqrt(Math.max(0, h.m2 / h.n - (h.m / h.n) ** 2)) / (h.m / h.n) : null,
            startShare: h && h.n >= 3 ? h.st / h.n : null, dkAvg: h && h.n >= 3 ? h.dk / h.n : null }); }
        if (min > 0) cur.push([a.id, min, act, a.starter]); } }
    for (const [id, m, a, st] of cur) { const h = hist.get(id) || { n: 0, m: 0, m2: 0, dk: 0, st: 0, date: "" }; if (h.date === g.date) continue; h.n++; h.m += m; h.m2 += m * m; h.dk += a; h.st += st ? 1 : 0; h.date = g.date; hist.set(id, h); }
  }
  for (const k of slate.keys()) if (!seen.has(k)) unmatchedBox++;
  return { rows: out, unmatchedBox, slatePlayers: slate.size, dates: dates.length, espnGames: files.length };
}

// the current default sigma (model.mjs sigmaFor for nba)
export const baseSigma = r => Math.min(SIGMA_MAX, SIGMA_DEF.nba.PG * Math.pow(Math.max(3, r.proj) / SIGMA_TILT_REF.nba, SIGMA_TILT.nba));
const CEN = 0.25, CEN_UP = 0.75;   // censoring points (share of projection): busts only, or the whole lower tail (fits the upper half)
// a model is r -> { s, p0 }: the sim's draw, a zero with probability p0 and otherwise a lognormal with mean proj / (1 - p0)
const lz = (r, s, p0 = 0) => (Math.log(Math.max(r.act, 1e-9) * (1 - p0) / r.proj) + s * s / 2) / s;
const nll = (rows, mf, cen = CEN) => { let L = 0; for (const r of rows) { const { s, p0 = 0 } = mf(r);
  if (r.act < cen * r.proj) L -= Math.log(Math.max(1e-12, p0 + (1 - p0) * pnorm((Math.log(cen * (1 - p0)) + s * s / 2) / s))); else { const z = lz(r, s, p0); L += Math.log(s) + z * z / 2 - Math.log(1 - p0); } } return L / rows.length; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const cdf = (r, m, x) => { const { s, p0 = 0 } = m(r); return x <= 0 ? p0 / 2 : p0 + (1 - p0) * pnorm((Math.log(x * (1 - p0) / r.proj) + s * s / 2) / s); };

// calibration of a model on a set of rows (busts drawn as zero sit at PIT p0/2)
export function calib(rows, m) {
  const pit = rows.map(r => cdf(r, m, r.act)), cov = w => mean(pit.map(u => Math.abs(u - 0.5) <= w / 2 ? 1 : 0)), pAbove = (r, k) => 1 - cdf(r, m, k * r.proj);
  return { n: rows.length, nll: +nll(rows, m).toFixed(4), c50: +cov(0.5).toFixed(3), c80: +cov(0.8).toFixed(3), c95: +cov(0.95).toFixed(3),
    hi5: +mean(pit.map(u => u > 0.95 ? 1 : 0)).toFixed(3), lo5: +mean(pit.map(u => u < 0.05 ? 1 : 0)).toFixed(3),
    x2: +mean(rows.map(r => r.act >= 2 * r.proj ? 1 : 0)).toFixed(4), x2m: +mean(rows.map(r => pAbove(r, 2))).toFixed(4),
    x15: +mean(rows.map(r => r.act >= 1.5 * r.proj ? 1 : 0)).toFixed(4), x15m: +mean(rows.map(r => pAbove(r, 1.5))).toFixed(4),
    h05: +mean(rows.map(r => r.act < 0.5 * r.proj ? 1 : 0)).toFixed(4), h05m: +mean(rows.map(r => 1 - pAbove(r, 0.5))).toFixed(4) };
}
// sigma of one group by ML: censored at 25% (busts in the lower tail) and at 75% (upper half only), with quantiles of actual/projected
function groupFit(rows) {
  let best = 0.3, bl = 1e9, bu = 0.3, blu = 1e9; for (let s = 0.1; s <= 1.5; s += 0.005) { const l = nll(rows, () => ({ s })); if (l < bl) { bl = l; best = s; } const lu = nll(rows, () => ({ s }), CEN_UP); if (lu < blu) { blu = lu; bu = s; } }
  const rat = rows.map(r => r.act / r.proj);
  return { n: rows.length, sig: +best.toFixed(3), sigUp: +bu.toFixed(3), sigBase: +mean(rows.map(baseSigma)).toFixed(3), bust: +mean(rat.map(x => x < CEN ? 1 : 0)).toFixed(3),
    ratio: +(mean(rows.map(r => r.act)) / mean(rows.map(r => r.proj))).toFixed(3), med: +q(rat, 0.5).toFixed(3), q90: +q(rat, 0.9).toFixed(3), q97: +q(rat, 0.97).toFixed(3) };
}
const mOf = T => r => ({ s: nbaSpreadSigma(r, T), p0: nbaSpreadBust(r, T) });
// coordinate descent on the NBA_SPREAD parameters (model.mjs nbaSpreadSigma / nbaSpreadBust) on the training rows; keys = which ones move
function fitParams(rows, start, cen, keys) {
  let P = { ...start }, best = nll(rows, mOf(P), cen);
  const grid = { s0: [0.26, 0.28, 0.30, 0.32, 0.34, 0.36, 0.38, 0.40, 0.42, 0.44], e: [-1, -0.9, -0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, 0], v: [-0.4, -0.2, -0.1, 0, 0.1, 0.2, 0.4], bench: [0.8, 0.9, 1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4],
    sal: [-0.4, -0.2, -0.1, 0, 0.1, 0.2], max: [0.6, 0.7, 0.8, 0.9, 1.0, 1.2], ba: [0, 0.01, 0.02, 0.03, 0.04, 0.06], bb: [0, 1, 1.5, 2, 2.5, 3], bbench: [0.5, 1, 1.5, 2, 3] };
  for (let it = 0; it < 4; it++) for (const k of keys) for (const v of grid[k]) { const t = { ...P, [k]: v }, l = nll(rows, mOf(t), cen); if (l < best - 1e-7) { best = l; P = t; } }
  for (let it = 0; it < 3; it++) for (const k of keys) for (const d of [-0.04, -0.02, -0.01, 0.01, 0.02, 0.04]) { const t = { ...P, [k]: +(P[k] + d).toFixed(3) }; if (k === "ba" && t.ba < 0) continue; const l = nll(rows, mOf(t), cen); if (l < best - 1e-7) { best = l; P = t; } }
  return P;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const D = loadPlayerGames(), all = D.rows, played = all.filter(r => !r.dnp);
  // harness check: ESPN DK points vs the lineup-recovered actuals of bench/fit-nba.mjs
  const rec = new Map(JSON.parse(fs.readFileSync("data/nba-fit/actuals.json", "utf8")).map(g => [g.date + "|" + nm(g.name), g.act]));
  const diffs = played.map(r => rec.has(r.date + "|" + nm(r.name)) ? Math.abs(rec.get(r.date + "|" + nm(r.name)) - r.act) : null).filter(x => x != null);
  const head = [`player-games ${all.length} (slate players ${D.slatePlayers}, no ESPN box ${D.unmatchedBox}), dates ${D.dates}, ESPN games ${D.espnGames}; DNP with a projection ${all.length - played.length} (${(100 * (1 - played.length / all.length)).toFixed(1)}%)`,
    `harness: ESPN DK vs lineup-recovered actuals on ${diffs.length} common player-games: median |diff| ${q(diffs, 0.5).toFixed(2)}, share within 0.5 ${mean(diffs.map(d => d <= 0.5 ? 1 : 0)).toFixed(3)}`];
  console.log(head.join("\n"));
  const train = played.filter(r => r.di % 2 === 1), test = played.filter(r => r.di % 2 === 0);
  const salT = r => r.sal < 4000 ? "<4K" : r.sal < 6000 ? "4-6K" : r.sal < 8000 ? "6-8K" : "8K+";
  const valT = r => { const v = r.proj / (r.sal / 1000); return v < 4.5 ? "val<4.5" : v < 5.5 ? "val4.5-5.5" : v < 6.5 ? "val5.5-6.5" : "val6.5+"; };
  const rankT = r => r.rank <= 3 ? "rank1-3" : r.rank <= 5 ? "rank4-5" : r.rank <= 8 ? "rank6-8" : "rank9+";
  const projT = r => r.proj < 15 ? "proj<15" : r.proj < 25 ? "proj15-25" : r.proj < 35 ? "proj25-35" : r.proj < 45 ? "proj35-45" : "proj45+";
  const cvT = r => r.mCv == null ? null : r.mCv < 0.15 ? "minCV<.15" : r.mCv < 0.25 ? "minCV.15-.25" : "minCV.25+";
  const upT = r => r.dkAvg == null || !(r.dkAvg > 0) ? null : r.proj / r.dkAvg >= 1.3 ? (r.sal < 5500 ? "stepUp cheap" : "stepUp $5.5K+") : r.proj / r.dkAvg <= 0.8 ? "projBelowAvg" : "projNearAvg";
  const roleSets = { "starter (ESPN, post-hoc)": r => r.starter ? "starter" : "bench", "start share prior": r => r.startShare == null ? null : r.startShare >= 0.7 ? "usual starter" : r.startShare <= 0.3 ? "usual bench" : "mixed",
    salary: salT, "proj per $1K": valT, "team proj rank": rankT, projection: projT, "minutes CV prior": cvT, "proj vs season DK avg": upT, "slate size": r => sizeOf(r.games) };
  const roleTab = {};
  console.log("\nrole groups (all dates, players who played): n, ML sigma censored at 25% / at 75% (upper half), current model mean sigma, bust<25%, act/proj, median, q90, q97 of act/proj");
  for (const [nmR, f] of Object.entries(roleSets)) { roleTab[nmR] = {}; const g = {}; for (const r of played) { const k = f(r); if (k != null) (g[k] ||= []).push(r); }
    for (const k of Object.keys(g).sort()) { if (g[k].length < 60) continue; const o = groupFit(g[k]); roleTab[nmR][k] = o; console.log(`  ${(nmR + ": " + k).padEnd(40)} n ${String(o.n).padStart(5)}  sig ${o.sig.toFixed(3)} / ${o.sigUp.toFixed(3)} (cur ${o.sigBase.toFixed(3)})  bust ${(100 * o.bust).toFixed(1)}%  act/proj ${o.ratio}  med ${o.med}  q90 ${o.q90}  q97 ${o.q97}`); } }
  // three fits on the odd dates, each also refitted on the even dates as a stability check
  const SK = ["s0", "e", "v", "sal", "bench", "max"], BK = ["ba", "bb", "bbench"], start = { ...NBA_SPREAD, ba: 0, bb: 2, bbench: 1 };
  const fits = { "role": [CEN, SK], "role upper": [CEN_UP, SK], "role+bust": [CEN, SK.concat(BK)] }, Pf = {}, Pr = {};
  console.log("");
  for (const [k, [cen, keys]] of Object.entries(fits)) { Pf[k] = fitParams(train, start, cen, keys); Pr[k] = fitParams(test, start, cen, keys);
    console.log(`fit ${k.padEnd(10)} odd dates: ${JSON.stringify(Pf[k])}\n  ${"".padEnd(12)}even dates: ${JSON.stringify(Pr[k])}`); }
  const models = { current: r => ({ s: baseSigma(r) }), ...Object.fromEntries(Object.keys(fits).map(k => [k, mOf(Pf[k])])) };
  const groups = { all: () => true, ...Object.fromEntries(SIZES.map(s => ["slate " + s, r => sizeOf(r.games) === s])), "rank1-3": r => r.rank <= 3, "rank4-5": r => r.rank > 3 && r.rank <= 5, "rank6+": r => r.rank > 5,
    "sal<4K": r => r.sal < 4000, "sal4-6K": r => r.sal >= 4000 && r.sal < 6000, "sal6K+": r => r.sal >= 6000, "val6.5+": r => r.proj / (r.sal / 1000) >= 6.5, "stepUp cheap": r => upT(r) === "stepUp cheap", "starter": r => r.starter, "bench": r => !r.starter };
  const held = {};
  console.log("\nheld-out (even dates): NLL, PIT coverage of 50/80/95 (target .50/.80/.95), PIT>.95 and <.05 (target .05), act>=2x proj actual/model, >=1.5x actual/model, <0.5x actual/model");
  for (const [gname, gf] of Object.entries(groups)) { const rs = test.filter(gf); if (rs.length < 50) continue; held[gname] = {};
    for (const [mn, mf] of Object.entries(models)) { const c = calib(rs, mf); held[gname][mn] = c;
      console.log(`  ${gname.padEnd(13)} ${mn.padEnd(10)} n ${String(c.n).padStart(5)}  nll ${c.nll.toFixed(4)}  cov ${c.c50}/${c.c80}/${c.c95}  hi ${c.hi5} lo ${c.lo5}  2x ${c.x2}/${c.x2m}  1.5x ${c.x15}/${c.x15m}  <.5x ${c.h05}/${c.h05m}`); } }
  // tail shape: PIT histogram on the held-out half (is the lognormal right tail too thin?)
  const bins = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1.0001].map((b, i, a) => i ? [a[i - 1], b] : null).filter(Boolean), pitHist = {};
  console.log("");
  for (const [mn, mf] of Object.entries(models)) { const pt = test.map(r => cdf(r, mf, r.act));
    pitHist[mn] = bins.map(([a, b]) => ({ bin: `${a}-${Math.min(1, b)}`, share: +mean(pt.map(u => u >= a && u < b ? 1 : 0)).toFixed(4), expect: +(Math.min(1, b) - a).toFixed(4) }));
    console.log(`held-out PIT histogram ${mn.padEnd(10)} (share/expected): ` + pitHist[mn].map(h => `${h.bin} ${h.share}/${h.expect}`).join("  ")); }
  const dnp = {}; for (const [k, f] of Object.entries({ all: () => true, "proj<15": r => r.proj < 15, "proj15-25": r => r.proj >= 15 && r.proj < 25, "proj25+": r => r.proj >= 25 })) { const rs = all.filter(f); dnp[k] = { n: rs.length, dnp: +mean(rs.map(r => r.dnp ? 1 : 0)).toFixed(4) }; }
  console.log("DNP with a projection (left out above): " + Object.entries(dnp).map(([k, v]) => `${k} ${(100 * v.dnp).toFixed(1)}% of ${v.n}`).join(", "));
  fs.mkdirSync("data/reports/nba", { recursive: true });
  fs.writeFileSync("data/reports/nba/spread-nba.json", JSON.stringify({ built: new Date().toISOString(), head, roles: roleTab, fits: Pf, reverseFits: Pr, heldOut: held, pitHist, dnp }, null, 1));
}
