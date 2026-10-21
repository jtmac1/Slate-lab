// NBA outcome model fit from pulled Stokastic post-contest data (data/post/nba). The API stores no
// per-player actual points, but every lineup's actual total is the sum of its players' (classic), so
// a least-squares solve over a contest's lineups recovers each rostered player's actual score.
//   node bench/fit-nba.mjs            -> data/nba-fit/actuals.json + printed sigma / correlation fit
// Per player-game: proj, actual, pos, salary, team, opp, date. Then:
//  - log-residual spread by position and projection bucket (lognormal sigma), and how often a player
//    with a projection scores under 25% of it (busts: injury exits, blowout benchings)
//  - Pearson correlation of residuals (actual/proj - 1) for same-team and opposing pairs by position
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
import { solveLS } from "../src/engine/recover.mjs";

const games = new Map();   // date|player id -> record (one per player-game, first contest wins)
for (const f of listPost("nba")) {
  const j = readPost(f), c = j.contest; if (/showdown/i.test(c.type + " " + c.name) || !j.lineups?.length || !j.players?.length) continue;
  const idx = new Map(j.players.map((p, i) => [p.id, i]));
  const lus = [], tgt = [];
  for (const l of j.lineups) { if (l.afp == null) continue; const ix = l.ids.map(id => idx.get(id)); if (ix.length !== 8 || ix.some(x => x == null)) continue; lus.push(ix); tgt.push(l.afp); if (lus.length >= 4000) break; }
  if (lus.length < 200) continue;
  const used = new Set(lus.flat()), cnt = new Map(); for (const x of lus.flat()) cnt.set(x, (cnt.get(x) || 0) + 1);
  const sol = solveLS(lus, j.players.length, tgt, 1e-4);
  // fit check: lineup totals reproduced?
  let err = 0; lus.forEach((lu, r) => { err = Math.max(err, Math.abs(lu.reduce((s, x) => s + sol[x], 0) - tgt[r])); });
  if (err > 1) { console.log(`skip ${c.date} ${c.key}: max lineup error ${err.toFixed(2)}`); continue; }
  for (const i of used) {
    const p = j.players[i]; if ((cnt.get(i) || 0) < 3) continue;
    const k = c.date + "|" + p.id; if (games.has(k)) continue;
    games.set(k, { date: c.date, id: p.id, name: p.name, pos: p.pos, team: p.team, opp: p.opp, sal: p.sal, proj: p.proj, pown: p.pown, act: Math.round(sol[i] * 100) / 100 });
  }
}
const G = [...games.values()].filter(g => g.proj > 0);
fs.mkdirSync("data/nba-fit", { recursive: true });
fs.writeFileSync("data/nba-fit/actuals.json", JSON.stringify(G));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length, sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
console.log(`player-games ${G.length}, dates ${new Set(G.map(g => g.date)).size}, actual/proj ${(mean(G.map(g => g.act)) / mean(G.map(g => g.proj))).toFixed(3)}`);
const prim = p => p.pos.split("/")[0];
// lognormal sigma: sd of log((act+1)/(proj+1)) on non-busts; bust = under 25% of projection
console.log("\npos / proj bucket: n, bust% (<25% of proj), sigma(log, non-bust), resid sd (act/proj-1)");
const bk = [[0, 15], [15, 25], [25, 35], [35, 45], [45, 99]];
for (const pos of ["PG", "SG", "SF", "PF", "C", "ALL"]) {
  for (const [lo, hi] of bk) {
    const s = G.filter(g => (pos === "ALL" || prim(g) === pos) && g.proj >= lo && g.proj < hi); if (s.length < 40) continue;
    const bust = s.filter(g => g.act < 0.25 * g.proj), nb = s.filter(g => g.act >= 0.25 * g.proj);
    console.log(`${pos.padEnd(4)} ${String(lo).padStart(2)}-${String(hi).padEnd(2)} n ${String(s.length).padStart(5)}  bust ${(100 * bust.length / s.length).toFixed(1).padStart(4)}%  sigma ${sd(nb.map(g => Math.log(g.act / g.proj))).toFixed(3)}  sd ${sd(s.map(g => g.act / g.proj - 1)).toFixed(3)}  act/proj ${(mean(s.map(g => g.act)) / mean(s.map(g => g.proj))).toFixed(3)}`);
  }
}
// pair correlations of residuals, same game date
const byGame = new Map(); for (const g of G) { const k = g.date + "|" + [g.team, g.opp].sort().join("@"); if (!byGame.has(k)) byGame.set(k, []); byGame.get(k).push(g); }
const pr = {}; const add = (k, a, b) => { (pr[k] ||= []).push([a, b]); };
const res = g => g.act / g.proj - 1;
for (const ps of byGame.values()) for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
  const a = ps[i], b = ps[j], rel = a.team === b.team ? "same" : "opp";
  add(rel, res(a), res(b));
  const ga = a.pos.includes("C") && !a.pos.includes("G") ? "big" : a.pos.includes("G") ? "guard" : "wing", gb = b.pos.includes("C") && !b.pos.includes("G") ? "big" : b.pos.includes("G") ? "guard" : "wing";
  add(rel + " " + [ga, gb].sort().join("-"), res(a), res(b));
  const ta = a.proj >= 30 ? "star" : a.proj >= 18 ? "mid" : "low", tb = b.proj >= 30 ? "star" : b.proj >= 18 ? "mid" : "low";
  add(rel + " " + [ta, tb].sort().join("-"), res(a), res(b));
}
const corr = xs => { const ma = mean(xs.map(x => x[0])), mb = mean(xs.map(x => x[1])); let c = 0, va = 0, vb = 0; for (const [a, b] of xs) { c += (a - ma) * (b - mb); va += (a - ma) ** 2; vb += (b - mb) ** 2; } return c / Math.sqrt(va * vb); };
console.log("\nresidual correlation (actual/proj - 1), pairs in the same game:");
for (const k of Object.keys(pr).sort()) if (pr[k].length >= 100) console.log(`  ${k.padEnd(20)} n ${String(pr[k].length).padStart(6)}  r ${corr(pr[k]).toFixed(3)}  (se ~${(1 / Math.sqrt(pr[k].length)).toFixed(3)})`);
