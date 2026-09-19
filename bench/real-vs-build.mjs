// The real contest field (pulled from Stokastic's API) against a bench/build-slate.mjs build:
// real cash line, your entry's finish and duplicates, the sim's picks scored inside the REAL
// field, what the winners built, and generated-vs-real field shape.
//   node bench/real-vs-build.mjs data/2026-09-16-mlb-early 195709688 build-270-seed1.json [user=jtmac1999]
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listPost } from "./post-store.mjs";
import { loadPulled } from "./grade-all.mjs";
import { stackOf, sigOf } from "../src/engine/lineups.mjs";
const [dir, key, bf, YOU = "jtmac1999"] = process.argv.slice(2);
const file = fs.readdirSync("data/post").flatMap(sp => listPost(sp, f => f.includes(key)))[0];   // any sport if (!file) { console.error("no pulled contest " + key); process.exit(1); }
const rc = loadPulled(file), { pool, entries, contest } = rc, P = pool.players, f = pool.format, N = entries.length;
const B = JSON.parse(fs.readFileSync(path.join(dir, bf), "utf8"));
const A = parseCSV(fs.readFileSync(path.join(dir, "actuals.csv"), "utf8")), act = {}, actT = {}, dupName = {};
for (const r of A.slice(1)) if (r.length > 6 && r[6] !== "") { const k = nrm(r[0]); actT[k + "|" + r[1]] = +r[6]; if (k in act) dupName[k] = true; act[k] = +r[6]; }
// two players can share a name on one slate (two Max Muncys on 2026-09-17): prefer name|team, refuse a bare name that is ambiguous
const score = (names, teams) => names.reduce((s, n, i) => { const k = nrm(n); const v = teams && teams[i] != null ? actT[k + "|" + teams[i]] : (dupName[k] ? undefined : act[k]); return s + (v == null ? NaN : v); }, 0);
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1), key10 = names => names.map(nrm).sort().join("|");
const byFP = entries.slice().sort((a, b) => b.actFP - a.actFP), paidEntries = entries.filter(e => e.actROI > -100), cashLine = Math.min(...paidEntries.map(e => e.actFP));
console.log(`${contest.name}: ${N} entries, $${contest.fee}, ${paidEntries.length} paid, cash line ${cashLine.toFixed(1)} FP, field mean ${mean(entries.map(e => e.actFP)).toFixed(1)} (proj ${mean(entries.map(e => e.stkFP)).toFixed(1)}), duplicated entries ${(100 * entries.filter(e => e.dupes > 0).length / N).toFixed(0)}%`);
console.log(`generated field (build): mean actual ${mean(B.field.map(r => score(r.names, r.teams)).filter(x => !isNaN(x))).toFixed(1)} (proj ${mean(B.field.map(r => r.proj)).toFixed(1)}), duplicated ${(100 * B.field.filter(r => r.dup > 0).length / B.field.length).toFixed(0)}%, ownsum ${mean(B.field.map(r => r.own)).toFixed(0)} vs real ${mean(entries.map(e => e.own)).toFixed(0)}`);
const sigReal = {}; for (const e of entries) { const k = key10(e.names); sigReal[k] = (sigReal[k] || 0) + 1; }
const finishOf = fp => entries.filter(e => e.actFP > fp).length + 1;
const payoutAt = fp => { const same = entries.filter(e => Math.abs(e.actFP - fp) < 0.01); if (same.length) return mean(same.map(e => e.actROI)); const below = entries.filter(e => e.actFP < fp).sort((a, b) => b.actFP - a.actFP)[0]; return below ? below.actROI : -100; };
console.log(`\nyour entries (${YOU}):`);
for (const e of entries.filter(e => e.user === YOU)) console.log(`  ${e.actFP.toFixed(1)} FP, finish ${e.finish}/${N}, ROI ${e.actROI >= 0 ? "+" : ""}${e.actROI.toFixed(0)}%, copies in real field ${sigReal[key10(e.names)]}, Stokastic sim ROI ${e.stkROI >= 0 ? "+" : ""}${e.stkROI.toFixed(0)}% (rank ${entries.filter(x => x.stkROI > e.stkROI).length + 1}), proj ${e.stkFP.toFixed(1)} (rank ${entries.filter(x => x.stkFP > e.stkFP).length + 1}), ${stackOf(e.lu, P, f)}`);
console.log(`\nthe sim's picks scored inside the REAL field:`);
for (const p of B.picks) { const fp = score(p.names, p.playerTeams), copies = sigReal[key10(p.names)] || 0; console.log(`  #${p.rank} sim ROI ${p.roi >= 0 ? "+" : ""}${p.roi.toFixed(0)}%  ${fp.toFixed(1)} FP -> finish ${finishOf(fp)}/${N}, would pay ${payoutAt(fp) > -100 ? (payoutAt(fp) >= 0 ? "+" : "") + payoutAt(fp).toFixed(0) + "%" : "-"}, copies already in field ${copies}  ${p.stack} ${p.teams}`); }
console.log(`\nStokastic's own ranking on this field: top-10% by its sim ROI realized ${mean(entries.slice().sort((a, b) => b.stkROI - a.stkROI).slice(0, Math.max(3, Math.round(N / 10))).map(e => e.actROI)).toFixed(0)}%; top-10% by projection ${mean(entries.slice().sort((a, b) => b.stkFP - a.stkFP).slice(0, Math.max(3, Math.round(N / 10))).map(e => e.actROI)).toFixed(0)}%; field ${mean(entries.map(e => e.actROI)).toFixed(0)}%`);
console.log(`\ntop 5 real finishers:`);
for (const e of byFP.slice(0, 5)) console.log(`  ${String(e.finish).padStart(3)}  ${e.actFP.toFixed(1)} FP  ROI +${e.actROI.toFixed(0)}%  proj ${e.stkFP.toFixed(1)} (rank ${entries.filter(x => x.stkFP > e.stkFP).length + 1})  own ${e.own.toFixed(0)}  ${stackOf(e.lu, P, f).padEnd(8)} ${e.user.padEnd(16)} ${e.names.join(", ")}`);
const dist = list => { const d = {}; for (const l of list) { const k = stackOf(l, P, f).split("-").slice(0, 2).join("-"); d[k] = (d[k] || 0) + 100 / list.length; } return d; };
const dr = dist(entries.map(e => e.lu)); console.log(`\nreal field stack shapes (primary-secondary): ` + Object.entries(dr).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => `${k} ${v.toFixed(0)}%`).join("  "));
const teamShare = list => { const t = {}; for (const l of list) for (const [tm, n] of Object.entries(l.reduce((acc, id) => { const p = P[id]; if (!p.isP) acc[p.team] = (acc[p.team] || 0) + 1; return acc; }, {}))) if (n >= 4) t[tm] = (t[tm] || 0) + 100 / list.length; return t; };
console.log(`real field 4+ stacks by team: ` + Object.entries(teamShare(entries.map(e => e.lu))).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}%`).join("  "));
const bTeam = {}; for (const r of B.field) for (const [tm, n] of Object.entries(r.names.reduce((acc, n) => { const p = P.find(q => nrm(q.name) === nrm(n)); if (p && !p.isP) acc[p.team] = (acc[p.team] || 0) + 1; return acc; }, {}))) if (n >= 4) bTeam[tm] = (bTeam[tm] || 0) + 100 / B.field.length;
console.log(`generated field 4+ stacks by team: ` + Object.entries(bTeam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}%`).join("  "));
