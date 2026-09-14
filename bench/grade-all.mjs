// Grade every post-contest export under data/ the way the Review screen does, and benchmark
// the engine against Stokastic's own sim on the same contests.
//   node bench/grade-all.mjs [iters] [filter]      e.g. node bench/grade-all.mjs 4000 nfl
// Each folder holding DK_<SPORT>_<Slate>_Data_Hub_Lineup.csv + _Player.csv is one contest.
// Format comes from the folder name (-sd- = showdown). Teams/positions come from data/mlb-ref
// and data/nfl-ref (bench/nfl-ref.mjs builds the NFL one).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nrm } from "../src/engine/csv.mjs";
import { recoverContest } from "../src/engine/recover.mjs";
import { buildModel } from "../src/engine/model.mjs";
import { simulate, playerROI } from "../src/engine/sim.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { featurize, gradeRules, spearman, RULES } from "../src/engine/select.mjs";

const SEED = 1;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const topOf = (arr, k) => arr.map((v, i) => i).sort((a, b) => arr[b] - arr[a]).slice(0, k);
const loose = s => nrm(s).split(" ").filter(w => w.length > 1).join(" ");

// name -> {team, opp, pos} from a reference folder and a game date
function refLookup(refDir, date, mlb) {
  const pf = path.join(refDir, "players-2026.json"), sf = path.join(refDir, `schedule-${date}.json`);
  if (!fs.existsSync(pf)) return null;
  const players = JSON.parse(fs.readFileSync(pf, "utf8"));
  const sched = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : [];
  const opp = {}; for (const g of sched) { opp[g.home] = g.away; opp[g.away] = g.home; }
  const byKey = {}, byLoose = {};
  for (const p of players) { byKey[nrm(p.name)] = p; if (!byLoose[loose(p.name)]) byLoose[loose(p.name)] = p; }
  return name => { const p = byKey[nrm(name)] || byLoose[loose(name)]; return p ? { team: p.team, opp: opp[p.team] || "", pos: mlb ? "" : p.pos } : null; };
}

export function listContests() {
  const out = [];
  for (const dir of fs.readdirSync("data").sort()) {
    const D = path.join("data", dir); if (!fs.statSync(D).isDirectory()) continue;
    const lf = fs.readdirSync(D).find(f => /^DK_(MLB|NFL)_\w+_Data_Hub_Lineup\.csv$/.test(f)); if (!lf) continue;
    const sport = lf.slice(3, 6).toLowerCase(), pf = lf.replace("Lineup", "Player"); if (!fs.existsSync(path.join(D, pf))) continue;
    const fkey = sport === "mlb" ? "mlb_cl" : /-sd-|showdown/i.test(dir) ? "nfl_sd" : "nfl_cl";
    out.push({ dir, sport, fkey, date: (dir.match(/\d{4}-\d{2}-\d{2}/) || [""])[0], lineup: path.join(D, lf), player: path.join(D, pf) });
  }
  return out;
}

// Rebuild one contest from its export; cached so parameter sweeps do not re-solve it.
const recovered = {};
export function recover(c) {
  if (recovered[c.dir]) return recovered[c.dir];
  const teamOf = refLookup(c.sport === "mlb" ? "data/mlb-ref" : "data/nfl-ref", c.date, c.sport === "mlb");
  return recovered[c.dir] = recoverContest(fs.readFileSync(c.lineup, "utf8"), fs.readFileSync(c.player, "utf8"), teamOf, c.fkey);
}

export function gradeContest(c, opts = {}) {
  const iters = opts.iters || 4000, rc = recover(c);
  const { pool, entries, payouts, paid } = rc, P = pool.players, N = entries.length, lus = entries.map(e => e.lu);
  const t0 = Date.now();
  const model = buildModel(pool, opts.model || {});
  const res = simulate({ pool, model, field: [], lineups: lus, payouts, entries: N, fee: 1, iters, rng: mulberry32(SEED), fieldMode: true });
  const feats = featurize(res.rows.map((r, i) => { const e = entries[i]; return { proj: e.stkFP, roi: r.roi, cash: r.cash, t10: r.t10, avgRank: r.avgRank, own: e.own, stkROI: e.stkROI, actFP: e.actFP, actROI: e.actROI, finish: e.finish }; }));
  const grades = gradeRules(feats, paid, { "Stokastic ROI": f => f.stkROI });
  const actFP = entries.map(e => e.actFP), stk = entries.map(e => e.stkROI), mine = res.rows.map(r => r.roi);
  const cashSet = new Set(entries.map((e, i) => e.finish <= paid ? i : -1).filter(i => i >= 0));
  const k = Math.max(3, Math.round(N * 0.1));
  const pr = {}; playerROI(res, P, pool.format).forEach(r => pr[r.id] = r.roi);
  const pp = P.filter(p => (p.own > 0 || p.cown > 0) && pr[p.i] != null);
  const mult = pool.format.mult, resid = Math.sqrt(mean(entries.map(e => (e.stkFP - e.lu.reduce((s, id, q) => s + (mult ? mult[q] : 1) * P[id].proj, 0)) ** 2)));
  return { ...c, N, rows: rc.rows, paid, unmatched: rc.unmatched, players: P.length, teams: pool.teams.length, games: pool.games.length, ms: Date.now() - t0, resid,
    fieldROI: mean(entries.map(e => e.actROI)), grades,
    sStk: spearman(stk, actFP), sMine: spearman(mine, actFP), sProj: spearman(entries.map(e => e.stkFP), actFP), agree: spearman(mine, stk),
    cashStk: topOf(stk, paid).filter(i => cashSet.has(i)).length, cashMine: topOf(mine, paid).filter(i => cashSet.has(i)).length, cashRand: paid * paid / N,
    roiStk: mean(topOf(stk, k).map(i => entries[i].actROI)), roiMine: mean(topOf(mine, k).map(i => entries[i].actROI)),
    pStk: spearman(pp.map(p => p.stkROI), pp.map(p => p.actROI)), pMine: spearman(pp.map(p => pr[p.i]), pp.map(p => p.actROI)), pAgree: spearman(pp.map(p => pr[p.i]), pp.map(p => p.stkROI)) };
}

export function printSummary(rows) {
  const names = Object.keys(RULES).concat(["Stokastic ROI"]);
  for (const fkey of ["mlb_cl", "nfl_cl", "nfl_sd"]) {
    const rs = rows.filter(r => r.fkey === fkey); if (!rs.length) continue;
    console.log(`\n=== ${fkey}: ${rs.length} contests ===`);
    console.log("contest".padEnd(40) + "N     paid  StkROI  MyROI  Proj   Agree | cash Stk/Me/rand  | top10% Stk / Me / field | playerROI Stk/Me");
    for (const r of rs) console.log(r.dir.padEnd(40) + String(r.N).padEnd(6) + String(r.paid).padEnd(6) + r.sStk.toFixed(3).padEnd(8) + r.sMine.toFixed(3).padEnd(7) + r.sProj.toFixed(3).padEnd(7) + r.agree.toFixed(3).padEnd(6) + " | " + `${r.cashStk}/${r.cashMine}/${r.cashRand.toFixed(1)}`.padEnd(18) + " | " + `${r.roiStk.toFixed(0)}% / ${r.roiMine.toFixed(0)}% / ${r.fieldROI.toFixed(0)}%`.padEnd(24) + " | " + `${r.pStk.toFixed(2)}/${r.pMine.toFixed(2)}`);
    const avg = f => mean(rs.map(r => r[f]));
    console.log("AVERAGE".padEnd(52) + avg("sStk").toFixed(3).padEnd(8) + avg("sMine").toFixed(3).padEnd(7) + avg("sProj").toFixed(3).padEnd(7) + avg("agree").toFixed(3).padEnd(6) + " | " + `${avg("cashStk").toFixed(1)}/${avg("cashMine").toFixed(1)}/${avg("cashRand").toFixed(1)}`.padEnd(18) + " | " + `${avg("roiStk").toFixed(0)}% / ${avg("roiMine").toFixed(0)}% / ${avg("fieldROI").toFixed(0)}%`.padEnd(24) + " | " + `${avg("pStk").toFixed(2)}/${avg("pMine").toFixed(2)}`);
    console.log("\n  selection rules (avg over contests): Spearman vs actual | cash hits vs random | realized top-10% | realized top-3 | contests with top-3 profit");
    for (const nme of names) {
      const g = rs.map(r => r.grades[nme]);
      console.log("  " + nme.padEnd(28) + mean(g.map(x => x.spearman)).toFixed(3).padEnd(22) + mean(g.map(x => x.cashHits)).toFixed(2).padEnd(22) + (mean(g.map(x => x.real10)).toFixed(0) + "%").padEnd(19) + (mean(g.map(x => x.real3)).toFixed(0) + "%").padEnd(17) + g.filter(x => x.real3 > 0).length + "/" + g.length);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ITERS = +(process.argv[2] || 4000), FILTER = process.argv[3] || "";
  const contests = listContests().filter(c => !FILTER || c.dir.includes(FILTER) || c.fkey.includes(FILTER));
  const rows = [];
  for (const c of contests) {
    const r = gradeContest(c, { iters: ITERS }); rows.push(r);
    console.log(`\n=== ${c.dir} [${c.fkey}] ===`);
    console.log(`  ${r.N} entries of ${r.rows} rows, ${r.paid} paid, field ROI ${r.fieldROI.toFixed(0)}%; ${r.players} players, ${r.teams} teams, ${r.games} games; unmatched ${r.unmatched.length}${r.unmatched.length ? " (" + r.unmatched.slice(0, 5).join(", ") + ")" : ""}; projection residual ${r.resid.toFixed(2)} FP/lineup; sim ${r.ms} ms`);
    console.log(`  lineup ROI vs actual FP: Stokastic ${r.sStk.toFixed(3)}  mine ${r.sMine.toFixed(3)}  projection ${r.sProj.toFixed(3)}  (agree ${r.agree.toFixed(3)}) | top-${r.paid} cashed: Stk ${r.cashStk} / me ${r.cashMine} / rand ${r.cashRand.toFixed(1)} | top-10% realized: Stk ${r.roiStk.toFixed(0)}% / me ${r.roiMine.toFixed(0)}%`);
    console.log(`  player ROI vs actual: Stokastic ${r.pStk.toFixed(3)}  mine ${r.pMine.toFixed(3)}  (agree ${r.pAgree.toFixed(3)})`);
  }
  printSummary(rows);
}
