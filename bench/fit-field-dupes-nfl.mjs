// How realistic is the generated NFL classic field on the things that set duplication: the share of
// entries that copy another entry, how chalky each lineup is (summed ACTUAL ownership, so the real and
// generated fields are measured on the same yardstick), and how strong it is (mean and 99th-percentile
// projection). Real field vs generator variants, per contest, same ownership the app uses (ownModel).
//   node bench/fit-field-dupes-nfl.mjs [--n=60] [--from=2025-09-01] [--shard=i/k]
import fs from "node:fs";
import { listContests, loadPulled } from "./grade-all.mjs";
import { genField } from "../src/engine/field.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";
import { sigOf } from "../src/engine/lineups.mjs";
import { ownModel } from "../server/sources.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MING = +arg("mingames", 0), MAXG = +arg("maxgames", 99), NC = +arg("n", 60), FROM = arg("from", "2025-09-01"), [SI, SN] = arg("shard", "0/1").split("/").map(Number);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0, q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const NFL_DEF = { 1: 45, 2: 41, 3: 5, bring: 62 };
export const VARIANTS = process.env.VARIANTS ? JSON.parse(process.env.VARIANTS) : {
  base: {},
  skill: { skill: [[0.05, 40], [0.25, 3]] },
  skill2: { skill: [[0.10, 40], [0.30, 4]] },
  skill3: { skill: [[0.15, 60], [0.35, 5]] },
};
const stats = (lus, P, N) => {
  const seen = {}; for (const l of lus) { const s = sigOf(l, { mult: null }); seen[s] = (seen[s] || 0) + 1; }
  const dupShare = lus.filter(l => seen[sigOf(l, { mult: null })] > 1).length / lus.length;
  const own = lus.map(l => l.reduce((t, i) => t + P[i].actOwn, 0)), proj = lus.map(l => l.reduce((t, i) => t + P[i].proj, 0));
  return { dup: dupShare, own: mean(own), proj: mean(proj), p99: q(proj, 0.99) };
};
const all = listContests().filter(c => c.json && c.sport === "nfl" && c.fkey === "nfl_cl" && c.fee >= 20 && c.entries >= 300 && c.date >= FROM).filter(c => { if (!MING && MAXG >= 99) return true; const g = loadPulled(c.json).pool.games.length; return g >= MING && g <= MAXG; });
const step = Math.max(1, Math.floor(all.length / NC)), pick = all.filter((c, i) => i % step === 0).slice(0, NC).filter((c, i) => i % SN === SI);
const rows = [];
for (const c of pick) {
  const rc = loadPulled(c.json), P = rc.pool.players, N = rc.entries.length, f = rc.pool.format;
  const r = ownModel("classic")(P.map(p => ({ pos: p.pos, team: p.team, sal: p.sal, proj: p.proj, vown: p.own })), { n: N, fee: c.fee });
  const gp = Object.assign({}, rc.pool, { players: P.map((p, i) => Object.assign({}, p, { own: r[i].labOwn ?? p.own, fown: r[i].labOwn ?? p.own })) });
  const real = stats(rc.entries.map(e => e.lu), P, N), row = { dir: c.dir, date: c.date, fee: c.fee, N, real, gen: {} };
  for (const [k, v] of Object.entries(VARIANTS)) row.gen[k] = stats(genField(gp, N, Object.assign({ conc: 1.1, minSal: 48000, boost: 1.0, rounds: 3, nflStacks: NFL_DEF }, v), mulberry32(1)).field, P, N);
  rows.push(row);
  console.error(`${c.dir} N ${N}  real dup ${(100 * real.dup).toFixed(1)}% own ${real.own.toFixed(0)} proj ${real.proj.toFixed(1)}/${real.p99.toFixed(1)} | ` + Object.entries(row.gen).map(([k, g]) => `${k} ${(100 * g.dup).toFixed(1)}% ${g.own.toFixed(0)} ${g.proj.toFixed(1)}/${g.p99.toFixed(1)}`).join(" | "));
}
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync(`data/reports/field-dupes-nfl${SN > 1 ? "-" + SI : ""}.json`, JSON.stringify(rows));
const size = n => n < 1500 ? "300-1.5K" : n < 10000 ? "1.5K-10K" : "10K+";
for (const g of ["all", "300-1.5K", "1.5K-10K", "10K+"]) {
  const R = rows.filter(r => g === "all" || size(r.N) === g); if (!R.length) continue;
  console.log(`\n${g} (${R.length} contests)          dup share   own sum   mean proj   p99 proj`);
  const line = (k, get) => console.log(`  ${k.padEnd(14)} ${(100 * mean(R.map(r => get(r).dup))).toFixed(1).padStart(8)}%  ${mean(R.map(r => get(r).own)).toFixed(0).padStart(8)}  ${mean(R.map(r => get(r).proj)).toFixed(1).padStart(10)}  ${mean(R.map(r => get(r).p99)).toFixed(1).padStart(9)}`);
  line("real", r => r.real); for (const k of Object.keys(VARIANTS)) line(k, r => r.gen[k]);
}
