// Contest selection from the complete DraftKings entry history. Which contests has this account
// actually beaten, which has it bled in, and what does today's lobby look like through that record.
//
// This replaces two ad-hoc tier tables that were wrong for the same reason: a naive split(",") on
// a quoted CSV. Contest names like "[$10K to 1st, 20 Entry Max]" carry commas, so those rows read the
// PRIZE POOL as the entry fee and landed in a fictional "$500+" bucket with millions of dollars in it.
// Everything here goes through parseCSV.
//
// Significance is judged two ways, because tournament returns are heavy-tailed and a mean-ROI t is
// often meaningless: (1) per-CONTEST mean ROI, so the five entries on one slate count as one draw,
// and (2) first-place COUNT against the field-rate expectation (sum of 1/field over entries), as a
// Poisson tail. Counts are what stayed stable all season when means flipped sign.
//
//   node bench/contest-select.mjs MLB                  families + structural buckets
//   node bench/contest-select.mjs MLB --lobby          ... and tag today's data/dk-lobby/mlb.json
//   node bench/contest-select.mjs NFL --min=10         lower the contests-required floor
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";

const SPORT = (process.argv[2] || "MLB").toUpperCase();
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const LOBBY = process.argv.includes("--lobby"), MINC = flag("min") ?? 15;

const histDir = "data/dk-history";
const files = fs.readdirSync(histDir).filter(f => /\.csv$/i.test(f)).sort();
const latest = files[files.length - 1];
const rows = parseCSV(fs.readFileSync(path.join(histDir, latest), "utf8"));
const H = rows[0].map(s => String(s).trim()), ix = n => H.indexOf(n);
const num = v => parseFloat(String(v ?? "").replace(/[$,]/g, "")) || 0;

// One entry per row. `Entry` is the contest name with the user's "(k/n)" entry index appended.
const E = rows.slice(1).map(c => ({
  sport: String(c[ix("Sport")] || "").toUpperCase(), gt: String(c[ix("Game_Type")] || ""),
  name: String(c[ix("Entry")] || "").replace(/\s*\(\d+\/\d+\)\s*$/, ""), key: String(c[ix("Contest_Key")] || ""),
  date: String(c[ix("Contest_Date_EST")] || ""), place: +c[ix("Place")] || 0,
  win: num(c[ix("Winnings_Non_Ticket")]) + num(c[ix("Winnings_Ticket")]),
  n: +String(c[ix("Contest_Entries")] || "").replace(/,/g, "") || 0, fee: num(c[ix("Entry_Fee")]), paid: +c[ix("Places_Paid")] || 0
})).filter(r => r.sport === SPORT && r.fee > 0 && r.n > 0);

// Family: the branded name with the prize amount, brackets and matchup stripped. "MEGA 8's" and
// "Mega 8's" are one family. Cap comes from the brackets; single entry is a cap of 1.
export const family = name => String(name).replace(/^(MLB|NFL|CFB|NBA|NHL|PGA)\s+/i, "").replace(/^(Showdown|Classic|In-Game|Single Stat)\s+/i, "")
  .replace(/^\$[\d.,]+[KM]?\s+/, "").split(/\s+[\[(]|\s+-\s+/)[0].replace(/\$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export const capOf = name => { const s = String(name); if (/single entry/i.test(s)) return 1; const m = s.match(/(\d+)\s*Entry\s*Max/i); return m ? +m[1] : null; };
const capClass = c => c === 1 ? "single" : c != null && c <= 5 ? "cap 2-5" : c != null && c <= 24 ? "cap 6-24" : "cap 25+/none";
const feeTier = f => f < 5 ? "<$5" : f < 25 ? "$5-24" : f < 100 ? "$25-99" : f < 500 ? "$100-499" : "$500+";
const fieldTier = n => n < 500 ? "<500" : n < 2000 ? "500-2k" : n < 10000 ? "2k-10k" : "10k+";
for (const r of E) { r.fam = family(r.name); r.cap = capOf(r.name); r.sd = /showdown|captain/i.test(r.gt + " " + r.name); }

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
// P(X >= k) for Poisson(lambda)
const poisTail = (k, lam) => { if (k <= 0) return 1; let p = Math.exp(-lam), cdf = p; for (let i = 1; i < k; i++) { p *= lam / i; cdf += p; } return Math.max(0, 1 - cdf); };

export function stats(a) {
  const byC = {}; for (const r of a) (byC[r.key] = byC[r.key] || []).push(r);
  const perC = Object.values(byC).map(g => mean(g.map(r => r.win / r.fee - 1)));
  const fee = a.reduce((s, r) => s + r.fee, 0), win = a.reduce((s, r) => s + r.win, 0);
  const wins = a.filter(r => r.place === 1).length, expWins = a.reduce((s, r) => s + 1 / r.n, 0);
  const noWin = a.filter(r => r.place !== 1);
  return { n: a.length, contests: perC.length, fee, win, roi: win / fee - 1,
    t: perC.length > 1 ? mean(perC) / (sd(perC) / Math.sqrt(perC.length)) : NaN,
    wins, expWins, pWins: poisTail(wins, expWins),
    roiExWins: noWin.length ? noWin.reduce((s, r) => s + r.win, 0) / noWin.reduce((s, r) => s + r.fee, 0) - 1 : NaN,
    top1: mean(a.map(r => r.place && r.place <= Math.max(1, r.n * 0.01) ? 1 : 0)), top10: mean(a.map(r => r.place && r.place <= r.n * 0.1 ? 1 : 0)),
    avgFee: mean(a.map(r => r.fee)), avgN: mean(a.map(r => r.n)), cap: a[0].cap, perContest: a.length / perC.length };
}
// Verdict needs enough contests to mean anything, then either the clustered t or the win count.
export function verdict(s) {
  if (s.contests < MINC) return "few";
  if (s.roi > 0 && (s.t >= 2 || (s.wins >= 3 && s.pWins < 0.05))) return "PLAY";
  if (s.roi < 0 && s.t <= -2) return "AVOID";
  return "neutral";
}
const pc = v => (100 * v).toFixed(1) + "%", pad = (s, w) => String(s).padEnd(w), rp = (s, w) => String(s).padStart(w);
const line = (label, s) => console.log(`  ${pad(label, 26)} ${rp(s.n, 5)} ent ${rp(s.contests, 4)} ctst ${rp("$" + s.avgFee.toFixed(0), 6)} ${rp(s.avgN.toFixed(0), 6)} fld ${rp(s.cap ?? "-", 4)} cap  ${rp("$" + s.fee.toFixed(0), 8)} in  ROI ${rp(pc(s.roi), 8)}  t ${rp(isFinite(s.t) ? s.t.toFixed(2) : "-", 6)}  wins ${rp(s.wins, 2)}/${s.expWins.toFixed(1)} p ${s.pWins.toFixed(3)}  ex-wins ${rp(pc(s.roiExWins), 7)}  top1 ${pc(s.top1)}  ${verdict(s)}`);
const header = () => console.log("  " + pad("contest", 26) + rp("entries", 9) + rp("contests", 9) + rp("fee", 7) + rp("field", 10) + rp("cap", 9) + rp("$ in", 10) + rp("ROI", 13) + rp("t(contest)", 11) + "  wins/exp   p       ROI ex-wins  top1%  verdict");

console.log(`${SPORT}: ${E.length} entries, ${new Set(E.map(r => r.key)).size} contests, from ${latest}`);
const all = stats(E); console.log(`  overall: $${all.fee.toFixed(0)} in, $${all.win.toFixed(0)} out, ROI ${pc(all.roi)}, ${all.wins} wins vs ${all.expWins.toFixed(1)} expected at field rate (p ${all.pWins.toFixed(3)})`);

for (const [title, split] of [["CLASSIC", E.filter(r => !r.sd)], ["SHOWDOWN", E.filter(r => r.sd)]]) {
  if (!split.length) continue;
  console.log(`\n=== ${title} FAMILIES (by $ in, ${MINC}+ contests for a verdict) ===`); header();
  const F = {}; for (const r of split) (F[r.fam] = F[r.fam] || []).push(r);
  for (const [k, a] of Object.entries(F).sort((x, y) => y[1].reduce((s, r) => s + r.fee, 0) - x[1].reduce((s, r) => s + r.fee, 0)).slice(0, 30)) line(k, stats(a));
  console.log(`\n=== ${title} STRUCTURE: fee tier x field size ===`); header();
  const S = {}; for (const r of split) { const k = `${feeTier(r.fee)} / ${fieldTier(r.n)}`; (S[k] = S[k] || []).push(r); }
  for (const [k, a] of Object.entries(S).sort((x, y) => y[1].reduce((s, r) => s + r.fee, 0) - x[1].reduce((s, r) => s + r.fee, 0))) if (a.length >= 20) line(k, stats(a));
  console.log(`\n=== ${title} STRUCTURE: entry cap ===`); header();
  const C = {}; for (const r of split) (C[capClass(r.cap)] = C[capClass(r.cap)] || []).push(r);
  for (const k of ["single", "cap 2-5", "cap 6-24", "cap 25+/none"]) if (C[k]) line(k, stats(C[k]));
}

// Today's lobby, each contest tagged with the record in its family (and the structural bucket when
// the family is new to this account).
if (LOBBY) {
  const lf = path.join("data/dk-lobby", SPORT.toLowerCase() + ".json");
  if (!fs.existsSync(lf)) { console.log(`\nno lobby file at ${lf} - run: node bench/dk-contests.mjs ${SPORT} --payouts`); process.exit(0); }
  const j = JSON.parse(fs.readFileSync(lf, "utf8")); const arr = Array.isArray(j) ? j : (j.contests || Object.values(j).find(Array.isArray) || []);
  const F = {}; for (const r of E) (F[r.fam] = F[r.fam] || []).push(r);
  const S = {}; for (const r of E) { const k = `${feeTier(r.fee)} / ${fieldTier(r.n)}`; (S[k] = S[k] || []).push(r); }
  const live = arr.filter(c => c.guaranteed && c.field >= 50 && !/in-game|tiers|pick.?em|double up|50\/50|h2h|head-to-head/i.test(c.name)).sort((a, b) => b.prizePool - a.prizePool);
  console.log(`\n=== TODAY'S ${SPORT} LOBBY (${live.length} tournaments) tagged with your record ===`);
  console.log("  " + pad("fee", 6) + pad("field", 8) + pad("cap", 5) + pad("contest", 46) + pad("family record", 34) + "verdict   (structural bucket fallback)");
  for (const c of live.slice(0, 40)) {
    const fam = family(c.name), cap = capOf(c.name) ?? c.cap ?? null, a = F[fam], sb = S[`${feeTier(c.fee)} / ${fieldTier(c.field)}`];
    const s = a && a.length ? stats(a) : null, ss = sb && sb.length ? stats(sb) : null;
    const rec = s ? `${s.n} ent/${s.contests} ctst ROI ${pc(s.roi)} t ${isFinite(s.t) ? s.t.toFixed(1) : "-"} W${s.wins}` : "never entered";
    const v = s ? verdict(s) : "-", vs = ss ? `${verdict(ss)} (${feeTier(c.fee)} / ${fieldTier(c.field)}: ROI ${pc(ss.roi)}, t ${isFinite(ss.t) ? ss.t.toFixed(1) : "-"}, n ${ss.n})` : "";
    console.log(`  ${pad("$" + c.fee, 6)}${pad(c.field, 8)}${pad(cap ?? "-", 5)}${pad(c.name.slice(0, 44), 46)}${pad(rec, 34)}${pad(v, 10)}${vs}`);
  }
}
