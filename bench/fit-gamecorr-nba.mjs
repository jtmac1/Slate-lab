// NBA classic game-level correlation (2026-10-21): a shared per-game factor (pace, overtime: both teams' players move together) and
// a blowout factor (a big final margin takes minutes from the big-minute players on BOTH sides and gives them to the bench), fitted
// from the ESPN box scores joined to pre-lock Stokastic projections (bench/fit-spread-nba.mjs loadPlayerGames).
// Each player-game becomes a normal score z = qnorm(PIT) under the role-spread marginal (--mopt file, default the A candidate), which
// is exactly the scale the sim's Cholesky correlations act on. Role at lock: team projection rank 1-5 = "S" (big minutes), 6+ = "B".
//  1. blowout loading by role: corr(z, standardized blowout size max(0, |margin| - M)) on the fit half, M swept
//  2. game (pace) loading by role: opposing-pair correlations minus the blowout part, g_S, g_B by least squares over the classes
//  3. teammate residual by role pair: same-team pair correlation minus both factor parts (one usage pie)
// Checked on the other half of the dates: pair correlations by class (observed vs implied by the factors, by NBAC, by none) and
// the variance of each game's summed z over its S players (the quantity a game stack bets on), by slate size.
//   node bench/fit-gamecorr-nba.mjs [--mopt=data/reports/nba/sc/mopt-A.json]  -> data/reports/nba/gamecorr-nba.json
import fs from "node:fs";
import { loadPlayerGames, sizeOf, SIZES } from "./fit-spread-nba.mjs";
import { pnorm, qnorm, NBAC, corrOf, NBA_SPREAD, nbaSpreadSigma, nbaSpreadBust, NBA_GAME, nbaGameCorr } from "../src/engine/model.mjs";

const MOPT = (process.argv.find(a => a.startsWith("--mopt=")) || "--mopt=data/reports/nba/sc/mopt-A.json").slice(7);
const T = fs.existsSync(MOPT) ? JSON.parse(fs.readFileSync(MOPT, "utf8")).spread || NBA_SPREAD : NBA_SPREAD;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const corr = xs => { if (xs.length < 3) return NaN; const ma = mean(xs.map(x => x[0])), mb = mean(xs.map(x => x[1])); let c = 0, va = 0, vb = 0; for (const [a, b] of xs) { c += (a - ma) * (b - mb); va += (a - ma) ** 2; vb += (b - mb) ** 2; } return c / Math.sqrt(va * vb); };

const D = loadPlayerGames(), rows = D.rows.filter(r => !r.dnp);
for (const r of rows) { const s = nbaSpreadSigma(r, T), p0 = nbaSpreadBust(r, T), u = r.act <= 0 ? p0 / 2 : p0 + (1 - p0) * pnorm((Math.log(r.act * (1 - p0) / r.proj) + s * s / 2) / s);
  r.z = qnorm(Math.min(0.999, Math.max(0.001, u))); r.role = r.rank <= 5 ? "S" : "B"; r.posList = r.pos.split("/"); }
const games = new Map(); for (const r of rows) { if (!games.has(r.gkey)) games.set(r.gkey, { key: r.gkey, di: r.di, slate: sizeOf(r.games), margin: Math.abs(r.margin), ot: r.ot, ps: [] }); games.get(r.gkey).ps.push(r); }
const G = [...games.values()], fitG = G.filter(g => g.di % 2 === 1), testG = G.filter(g => g.di % 2 === 0);
const lines = [`player-games ${rows.length} in ${G.length} games (fit: odd dates ${fitG.length} games, check: even ${testG.length}); marginal ${JSON.stringify(T)}`,
  `games by slate size (players' biggest slate): ` + SIZES.map(s => `${s}: ${G.filter(g => g.slate === s).length}`).join(", ") + `; final margin 15+ in ${(100 * mean(G.map(g => g.margin >= 15 ? 1 : 0))).toFixed(0)}% of games, OT ${(100 * mean(G.map(g => g.ot ? 1 : 0))).toFixed(1)}%`];

// raw blowout effect: mean z and minutes by role and final margin band
const band = m => m < 6 ? "0-5" : m < 11 ? "6-10" : m < 16 ? "11-15" : m < 21 ? "16-20" : m < 26 ? "21-25" : "26+";
lines.push("", "mean z / minutes / act/proj by final margin (all dates):", "  band    n games  S: z    min   act/proj  | B: z    min   act/proj");
for (const b of ["0-5", "6-10", "11-15", "16-20", "21-25", "26+"]) { const gs = G.filter(g => band(g.margin) === b), S = gs.flatMap(g => g.ps.filter(p => p.role === "S")), B = gs.flatMap(g => g.ps.filter(p => p.role === "B"));
  lines.push(`  ${b.padEnd(7)} ${String(gs.length).padStart(5)}    ${mean(S.map(p => p.z)).toFixed(3).padStart(6)} ${mean(S.map(p => p.min)).toFixed(1).padStart(5)}  ${(mean(S.map(p => p.act)) / mean(S.map(p => p.proj))).toFixed(3)}     | ${mean(B.map(p => p.z)).toFixed(3).padStart(6)} ${mean(B.map(p => p.min)).toFixed(1).padStart(5)}  ${(mean(B.map(p => p.act)) / mean(B.map(p => p.proj))).toFixed(3)}`); }

// 1. blowout loadings: corr(z, blowout size), by role, threshold M swept on the fit half
const classOf = p => p.rank <= 2 ? "S1" : p.rank <= 5 ? "S2" : p.rank <= 8 ? "B1" : "B2";
const bScore = (g, M) => Math.max(0, g.margin - M);
let bestM = 15, bestR = 0; const sweep = [];
for (const M of [0, 5, 8, 10, 12, 15, 18, 20]) { const xs = fitG.flatMap(g => g.ps.filter(p => p.role === "S").map(p => [p.z, bScore(g, M)])), r = corr(xs); sweep.push([M, +r.toFixed(4)]); if (-r > -bestR) { bestR = r; bestM = M; } }
lines.push("", `blowout size max(0, |margin| - M): corr with S-player z on the fit half by M: ` + sweep.map(([m, r]) => `M${m} ${r}`).join("  ") + ` -> M ${bestM}`);
const sdB = Math.sqrt(mean(G.map(g => bScore(g, bestM) ** 2)) - mean(G.map(g => bScore(g, bestM))) ** 2);
const loadB = (gs, f) => corr(gs.flatMap(g => g.ps.filter(f).map(p => [p.z, bScore(g, bestM)])));
const bl = { S: loadB(fitG, p => p.role === "S"), B: loadB(fitG, p => p.role === "B") };
const blC = Object.fromEntries(["S1", "S2", "B1", "B2"].map(c => [c, +loadB(fitG, p => classOf(p) === c).toFixed(4)]));
lines.push(`blowout loading (corr of z with blowout size), fit half: S ${bl.S.toFixed(4)}  B ${bl.B.toFixed(4)}  by rank class ${JSON.stringify(blC)}; held-out: S ${loadB(testG, p => p.role === "S").toFixed(4)}  B ${loadB(testG, p => p.role === "B").toFixed(4)}`);

// pair correlations by class
const pairs = (gs, same) => { const o = { SS: [], SB: [], BB: [] }; for (const g of gs) { const ps = g.ps; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) { const a = ps[i], b = ps[j]; if ((a.team === b.team) !== same) continue;
  const k = a.role + b.role === "BS" ? "SB" : a.role + b.role; o[k].push([a, b]); } } return o; };
const pc = ps => corr(ps.map(([a, b]) => [a.z, b.z]));
// 2. game loadings from opposing pairs: c_opp(XY) - bX bY = gX gY  (least squares on the three classes, weighted by pair count)
const oppF = pairs(fitG, false), sameF = pairs(fitG, true);
const oppC = { SS: pc(oppF.SS), SB: pc(oppF.SB), BB: pc(oppF.BB) }, sameC = { SS: pc(sameF.SS), SB: pc(sameF.SB), BB: pc(sameF.BB) };
let gS = 0, gB = 0, best = 1e9;
for (let a = -0.1; a <= 0.4001; a += 0.005) for (let b = -0.1; b <= 0.4001; b += 0.005) { const e = oppF.SS.length * (oppC.SS - bl.S * bl.S - a * a) ** 2 + oppF.SB.length * (oppC.SB - bl.S * bl.B - a * b) ** 2 + oppF.BB.length * (oppC.BB - bl.B * bl.B - b * b) ** 2; if (e < best) { best = e; gS = a; gB = b; } }
// 3. teammate residual
const tm = { SS: sameC.SS - gS * gS - bl.S * bl.S, SB: sameC.SB - gS * gB - bl.S * bl.B, BB: sameC.BB - gB * gB - bl.B * bl.B };
const FIT = { gS: +gS.toFixed(3), gB: +gB.toFixed(3), bS: +bl.S.toFixed(3), bB: +bl.B.toFixed(3), tSS: +tm.SS.toFixed(3), tSB: +tm.SB.toFixed(3), tBB: +tm.BB.toFixed(3) };
lines.push("", `fit half pair correlations of z: opposing SS ${oppC.SS.toFixed(4)} (n ${oppF.SS.length}) SB ${oppC.SB.toFixed(4)} (${oppF.SB.length}) BB ${oppC.BB.toFixed(4)} (${oppF.BB.length}); same team SS ${sameC.SS.toFixed(4)} (${sameF.SS.length}) SB ${sameC.SB.toFixed(4)} (${sameF.SB.length}) BB ${sameC.BB.toFixed(4)} (${sameF.BB.length})`,
  `fitted factors: game g_S ${FIT.gS} g_B ${FIT.gB}; blowout b_S ${FIT.bS} b_B ${FIT.bB}; teammate residual SS ${FIT.tSS} SB ${FIT.tSB} BB ${FIT.tBB}`, `NBA_GAME in model.mjs now: ${JSON.stringify(NBA_GAME)}`);

// held-out check: observed pair correlation by class vs implied by each candidate (pool-like players: proj, rank, pos, team)
const pl = p => ({ proj: p.proj, rank: p.rank, team: p.team, gi: 0, pos: p.posList[0], posList: p.posList });
const cands = { none: () => 0, NBAC: (a, b) => corrOf(pl(a), pl(b), "nba", 2), game: (a, b) => nbaGameCorr(pl(a), pl(b), a.team === b.team, FIT), "game+NBAC": (a, b) => nbaGameCorr(pl(a), pl(b), a.team === b.team, FIT) + corrOf(pl(a), pl(b), "nba", 2) };
const check = {};
const evalSet = (gs, label) => { const out = {}; for (const same of [false, true]) { const P = pairs(gs, same);
  for (const k of ["SS", "SB", "BB"]) { const ps = P[k]; if (ps.length < 50) continue; const o = { n: ps.length, obs: +pc(ps).toFixed(4), se: +(1 / Math.sqrt(ps.length)).toFixed(4) };
    for (const [cn, f] of Object.entries(cands)) o[cn] = +mean(ps.map(([a, b]) => f(a, b))).toFixed(4); out[(same ? "same " : "opp ") + k] = o; } }
  // game-sum variance: var of the summed z of a game's S players vs what each candidate implies (sum of its pair terms + n)
  const vr = {}; for (const [cn, f] of Object.entries(cands)) { let obs = 0, imp = 0, ng = 0; for (const g of gs) { const S = g.ps.filter(p => p.role === "S"); if (S.length < 4) continue; ng++;
      const s = S.reduce((x, p) => x + p.z, 0); obs += s * s; let v = S.length; for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) v += 2 * f(S[i], S[j]); imp += v; } vr[cn] = +(obs / imp).toFixed(3); vr.games = ng; }
  out["game S-sum var ratio obs/model"] = vr; check[label] = out; };
evalSet(testG, "held-out all"); for (const s of SIZES) evalSet(testG.filter(g => g.slate === s), "held-out " + s);
lines.push("", "held-out (even dates) pair correlation by class: observed (se) vs mean implied by none / NBAC / game factors / game+NBAC; and var(sum z of a game's S players) observed / implied (1 = right)");
for (const [lab, o] of Object.entries(check)) { lines.push(`  ${lab}`); for (const [k, v] of Object.entries(o)) { if (k.startsWith("game S-sum")) lines.push(`    S-sum var ratio over ${v.games} games: none ${v.none}  NBAC ${v.NBAC}  game ${v.game}  game+NBAC ${v["game+NBAC"]}`);
  else lines.push(`    ${k.padEnd(8)} n ${String(v.n).padStart(6)}  obs ${v.obs.toFixed(4)} (${v.se.toFixed(3)})  none 0  NBAC ${v.NBAC.toFixed(4)}  game ${v.game.toFixed(4)}  game+NBAC ${v["game+NBAC"].toFixed(4)}`); } }
const txt = lines.join("\n"); console.log(txt);
fs.writeFileSync("data/reports/nba/gamecorr-nba.json", JSON.stringify({ built: new Date().toISOString(), marginal: T, blowoutM: bestM, blowoutSweep: sweep, blowoutByClass: blC, fit: FIT, check, text: txt }, null, 1));
