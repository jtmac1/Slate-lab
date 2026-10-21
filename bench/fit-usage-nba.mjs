// Fit + held-out check of the NBA "player ruled OUT -> teammates gain" rule in src/engine/nba-usage.mjs (built 2026-10-21).
// ESPN box scores (data/nba-pbp, 2025-26) in date order. A regular = 5+ prior games, season-to-date avg 24+ min, last game for this
// team. FRESH absence = he played the team's previous game and has no minutes today (the late-scratch case: teammates' season
// averages do not include it yet). Teammates who play today with 3+ prior games: base = season-to-date avg DK points (earlier
// dates only), actual = today's DK points. Rule gain_i = K x A x w_i / sum(w), A = absent's season avg DK, w_i = base_i x pos factor
// (same / adjacent / far position, DK positions from the Stokastic slates via bench/nba-player-rows.mjs). K and the factors fitted
// on odd dates (MAE grid), reported on even dates. Stokastic check: late scratches = absent player still projected > 0 at lock.
//   node bench/fit-usage-nba.mjs   -> data/reports/nba/usage-nba.json + .txt
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadRows, nm, bucketOf } from "./nba-player-rows.mjs";
import { reproject, posDist, USAGE } from "../src/engine/nba-usage.mjs";

const OUT = "data/reports/nba"; fs.mkdirSync(OUT, { recursive: true });
const gzr = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
const dk = s => { const tens = [s.pts, s.reb, s.ast, s.stl, s.blk].filter(x => x >= 10).length;
  return s.pts + 0.5 * s.tpm + 1.25 * s.reb + 1.5 * s.ast + 2 * s.stl + 2 * s.blk - 0.5 * s.to + (tens >= 2 ? 1.5 : 0) + (tens >= 3 ? 3 : 0); };

const { rows } = loadRows();
const posBy = new Map(), stok = new Map(), gamesOn = new Map();
for (const r of rows) { if (!posBy.has(nm(r.name))) posBy.set(nm(r.name), r.posStr); const k = r.date + "|" + nm(r.name); if (!stok.has(k)) stok.set(k, r); gamesOn.set(r.date, Math.max(gamesOn.get(r.date) || 0, r.games)); }

const games = fs.readdirSync("data/nba-pbp").filter(f => /^g-/.test(f)).map(f => gzr(path.join("data/nba-pbp", f))).filter(g => g.date >= "2025-10-01" && g.date < "2026-07-01")
  .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
const H = new Map(), teamPrev = new Map(), recs = [], ctrl = [];   // H: id -> {name, n, min, dk, lastDate, lastTeam}
for (const g of games) {
  const today = g.box.map(t => ({ team: t.team, P: t.ath.map(a => { const o = a.dnp ? null : Object.fromEntries(t.labels.map((l, i) => [l, a.stats[i]]));
    return { id: a.id, name: a.name, starter: a.starter, min: o ? +o.MIN || 0 : 0, dk: o ? dk({ pts: +o.PTS, tpm: +String(o["3PT"]).split("-")[0], reb: +o.REB, ast: +o.AST, to: +o.TO, stl: +o.STL, blk: +o.BLK }) : 0 }; }) }));
  for (const T of today) {
    const prevD = teamPrev.get(T.team), playing = new Set(T.P.filter(p => p.min > 0).map(p => p.id));
    const absent = prevD ? [...H.entries()].filter(([id, h]) => h.lastTeam === T.team && h.lastDate === prevD && h.n >= 5 && h.min / h.n >= 24 && !playing.has(id))
      .map(([id, h]) => ({ name: h.name, proj: h.dk / h.n, pos: posBy.get(nm(h.name)) || "" })) : [];
    const mates = T.P.filter(p => p.min > 0 && H.get(p.id)?.n >= 3).map(p => { const h = H.get(p.id);
      return { name: p.name, pos: posBy.get(nm(p.name)) || "", base: h.dk / h.n, baseMin: h.min / h.n, act: p.dk, min: p.min, starter: p.starter, st: stok.get(g.date + "|" + nm(p.name)) }; });
    if (mates.length >= 5) {
      const games_ = gamesOn.get(g.date) || 0, fold = 0;
      if (absent.length) recs.push({ date: g.date, team: T.team, games: games_, absent: absent.map(a => ({ ...a, st: stok.get(g.date + "|" + nm(a.name)) })), mates });
      else if (prevD) ctrl.push({ date: g.date, team: T.team, games: games_, mates });
    }
  }
  for (const T of today) { teamPrev.set(T.team, g.date);
    for (const p of T.P) if (p.min > 0) { const h = H.get(p.id) || { name: p.name, n: 0, min: 0, dk: 0 }; h.n++; h.min += p.min; h.dk += p.dk; h.lastDate = g.date; h.lastTeam = T.team; H.set(p.id, h); } }
}
const dates = [...new Set(games.map(g => g.date))].sort(), odd = new Set(dates.filter((d, i) => i % 2 === 1));
const train = recs.filter(r => odd.has(r.date)), test = recs.filter(r => !odd.has(r.date));
console.log(`${games.length} games, ${recs.length} team-games with a fresh absence (${recs.reduce((a, r) => a + r.absent.length, 0)} absences), ${ctrl.length} control team-games; train ${train.length} / test ${test.length}`);

// rule applied to a team-game: players = mates (proj = base) + absent (proj = their avg)
const apply = (r, P, key = "base") => { const players = [...r.mates.map(m => ({ name: m.name, pos: m.pos, team: r.team, proj: m[key] })), ...r.absent.map(a => ({ name: a.name, pos: a.pos, team: r.team, proj: key === "base" ? a.proj : a.st?.proj || a.proj }))];
  const o = reproject(players, r.absent.map(a => a.name), P); return r.mates.map((m, i) => o.players[i].proj); };
const mae = (R, P, key = "base") => { let s = 0, n = 0; for (const r of R) { const p = apply(r, P, key); r.mates.forEach((m, i) => { s += Math.abs(m.act - p[i]); n++; }); } return s / n; };
const grid = { K: [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2], same: [1], adj: [0.25, 0.5, 0.75, 1, 1.5], far: [0, 0.1, 0.25, 0.5, 0.75, 1], gamma: [0, 0.25, 0.5, 1, 1.5], floor: [5] };   // floor fixed at 5: the fit sees only teammates who played; live, Stokastic projects fringe players who may not (train MAE 8.252 at 0, 8.273 at 5, 8.356 at 10)
let PB = { ...USAGE }, best = mae(train, PB);
for (let it = 0; it < 3; it++) for (const k of Object.keys(grid)) for (const v of grid[k]) { const t = { ...PB, [k]: v }, m = mae(train, t); if (m < best - 1e-6) { best = m; PB = t; } }
const sens = Object.fromEntries(Object.entries(grid).map(([k, a]) => [k, a.map(v => [v, +mae(train, { ...PB, [k]: v }).toFixed(3)])]));
console.log(`fit (train MAE ${best.toFixed(3)}): ${JSON.stringify(PB)}`);

// held-out stats: none vs rule, by bucket and by absent usage
const st = (R, P, key = "base", filt = () => true) => { const e0 = [], e1 = [], g = []; for (const r of R) { const p = apply(r, P, key); r.mates.forEach((m, i) => { if (!filt(r, m)) return; e0.push(m.act - m[key]); e1.push(m.act - p[i]); g.push(p[i] - m[key]); }); }
  const M = a => a.reduce((x, y) => x + y, 0) / (a.length || 1); return { n: e0.length, maeNone: +M(e0.map(Math.abs)).toFixed(2), biasNone: +M(e0).toFixed(2), maeRule: +M(e1.map(Math.abs)).toFixed(2), biasRule: +M(e1).toFixed(2), avgGain: +M(g).toFixed(2) }; };
const cuts = { all: () => true, "small 2-4": r => r.games && bucketOf(r.games) === "small", "medium 5-7": r => r.games && bucketOf(r.games) === "medium", "large 8+": r => r.games && bucketOf(r.games) === "large",
  "absent A<30": r => sum(r.absent) < 30, "absent A 30-45": r => sum(r.absent) >= 30 && sum(r.absent) < 45, "absent A 45+": r => sum(r.absent) >= 45,
  "starters": (r, m) => m.starter, "bench": (r, m) => !m.starter, "1 absent": r => r.absent.length === 1, "2+ absent": r => r.absent.length >= 2 };
function sum(a) { return a.reduce((x, y) => x + y.proj, 0); }
const held = Object.fromEntries(Object.entries(cuts).map(([k, f]) => [k, st(test, PB, "base", f)]));
const trainAll = st(train, PB);
// control: no absence, baseline bias only
const ctrlBias = (() => { const e = ctrl.filter(r => !odd.has(r.date)).flatMap(r => r.mates.map(m => m.act - m.base)); return { n: e.length, mae: +(e.reduce((a, x) => a + Math.abs(x), 0) / e.length).toFixed(2), bias: +(e.reduce((a, x) => a + x, 0) / e.length).toFixed(2) }; })();
// minutes: actual minus avg minutes for teammates, by position match to the (largest) absent
const minMove = { same: [], adj: [], far: [] }; for (const r of test) { const a = [...r.absent].sort((x, y) => y.proj - x.proj)[0]; for (const m of r.mates) { const d = posDist(m.pos, a.pos); if (d == null) continue; minMove[d <= 0.75 ? "same" : d <= 1.75 ? "adj" : "far"].push([m.min - m.baseMin, m.act - m.base]); } }
const minTab = Object.fromEntries(Object.entries(minMove).map(([k, a]) => [k, { n: a.length, dMin: +(a.reduce((s, x) => s + x[0], 0) / a.length).toFixed(2), dDk: +(a.reduce((s, x) => s + x[1], 0) / a.length).toFixed(2) }]));

// Stokastic: teammates with a Stokastic projection; late = an absent player still projected > 0 at lock (Stokastic missed it)
const withSt = R => R.map(r => ({ ...r, mates: r.mates.filter(m => m.st?.proj > 0).map(m => ({ ...m, sp: m.st.proj })) })).filter(r => r.mates.length >= 5);
const late = withSt(recs.filter(r => r.absent.some(a => a.st?.proj > 0))).map(r => ({ ...r, absent: r.absent.map(a => ({ ...a, proj: a.st?.proj > 0 ? a.st.proj : a.proj })) }));
const known = withSt(recs.filter(r => r.absent.every(a => !(a.st?.proj > 0))));
const stokTab = { late_allDates: st(late, PB, "sp"), late_heldOut: st(late.filter(r => !odd.has(r.date)), PB, "sp"), known_allDates: st(known, PB, "sp") };
const lateAbs = recs.flatMap(r => r.absent.filter(a => a.st?.proj > 0)).length;

const L = [];
L.push(`NBA usage redistribution (player OUT -> teammates), built ${new Date().toISOString().slice(0, 10)}. ESPN box scores 2025-26, ${games.length} games.`,
  `Fresh absence = regular (5+ games, avg 24+ min) who played the team's previous game, no minutes today. ${recs.length} team-games; fit on odd dates (${train.length}), held out even (${test.length}).`,
  `Rule: gain_i = K x A x w_i / sum w, A = absent's expected DK pts, w_i = proj_i^gamma x pos factor (same 1 / adjacent / far, by DK position distance). Fit: ${JSON.stringify(PB)}`,
  `Baseline = teammate's season-to-date avg DK pts (earlier dates). MAE / bias are actual minus prediction. Control team-games (no absence), held-out: MAE ${ctrlBias.mae}, bias ${ctrlBias.bias} (n ${ctrlBias.n}).`, "",
  `HELD-OUT (even dates)      n      MAE none  bias none  MAE rule  bias rule  avg gain`);
for (const [k, s] of Object.entries(held)) L.push(`${k.padEnd(22)} ${String(s.n).padStart(6)}  ${s.maeNone.toFixed(2).padStart(8)}  ${s.biasNone.toFixed(2).padStart(9)}  ${s.maeRule.toFixed(2).padStart(8)}  ${s.biasRule.toFixed(2).padStart(9)}  ${s.avgGain.toFixed(2).padStart(8)}`);
L.push(`(train: MAE none ${trainAll.maeNone} -> rule ${trainAll.maeRule}, bias ${trainAll.biasNone} -> ${trainAll.biasRule})`, "",
  `Held-out teammate moves vs the biggest absent by position: ` + Object.entries(minTab).map(([k, v]) => `${k} n ${v.n} min ${v.dMin >= 0 ? "+" : ""}${v.dMin} dk ${v.dDk >= 0 ? "+" : ""}${v.dDk}`).join("; "), "",
  `Stokastic (baseline = Stokastic pre-lock proj, rule A = absent's Stokastic proj):`,
  `  late scratch (absent still projected > 0 at lock; ${lateAbs} absences): ` + JSON.stringify(stokTab.late_allDates) + `  held-out only: ` + JSON.stringify(stokTab.late_heldOut),
  `  known before lock (absent not projected): ` + JSON.stringify(stokTab.known_allDates) + `  <- rule on top of Stokastic double-counts when the news is already in`, "",
  `Train MAE sensitivity: ` + Object.entries(sens).map(([k, a]) => `${k} ` + a.map(([v, m]) => `${v}:${m}`).join(" ")).join(" | "));
const txt = L.join("\n"); console.log(txt);
fs.writeFileSync(path.join(OUT, "usage-nba.txt"), txt + "\n");
fs.writeFileSync(path.join(OUT, "usage-nba.json"), JSON.stringify({ built: new Date().toISOString(), params: PB, heldOut: held, train: trainAll, control: ctrlBias, minutesByPos: minTab, stokastic: stokTab, lateAbsences: lateAbs, trainSensitivity: sens }, null, 1));
