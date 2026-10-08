// Contest-selection report: his fee-weighted NFL ROI by contest STRUCTURE (format, fee tier, field size, entry style,
// slate type) from the DraftKings history ledger, topped up with the post-ledger entries in the grade-week scoreboard,
// with date-clustered bootstrap intervals (contests on the same date share outcomes), plus ETR's contest-selection
// notes. Writes data/reports/contest-report-nfl.md. No Contests tab: this picks by structure, never by contest name.
//   node bench/contest-report-nfl.mjs [--since 2025-08-01]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2), since = (args.find(a => a.startsWith("--since=")) || "--since=2025-08-01").slice(8);
const HIST = "data/dk-history", files = fs.readdirSync(HIST).filter(f => /contest-entry-history\.csv$/.test(f)).sort(), ledger = files[files.length - 1];
if (!ledger) { console.error("no DraftKings history CSV in data/dk-history"); process.exit(1); }
const split = l => { const o = []; let c = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(c); c = ""; } else c += ch; } o.push(c); return o; };
const money = s => +String(s || "0").replace(/[$,]/g, "") || 0;
const L = fs.readFileSync(path.join(HIST, ledger), "utf8").trim().split(/\r?\n/), H = split(L[0]), ix = n => H.indexOf(n);

// ---------- entries ----------
const rows = [];
for (const l of L.slice(1)) {
  const r = split(l); if (r[ix("Sport")] !== "NFL") continue;
  const gt = r[ix("Game_Type")]; if (!/^(Classic|Showdown Captain Mode)$/.test(gt)) continue;
  const name = r[ix("Entry")].replace(/\s*\(\d+\/\d+\)\s*$/, ""), when = r[ix("Contest_Date_EST")];
  rows.push({ src: "ledger", key: r[ix("Contest_Key")], name, date: when.slice(0, 10), time: when.slice(11, 16), sd: /Showdown/.test(gt), fee: money(r[ix("Entry_Fee")]), won: money(r[ix("Winnings_Non_Ticket")]) + money(r[ix("Winnings_Ticket")]), field: +r[ix("Contest_Entries")] || 0 });
}
const ledgerEnd = rows.reduce((m, r) => r.date > m ? r.date : m, "");
// scoreboard rows after the ledger (grade-week; ROI in %, contest size in "entries")
const sb = (() => { try { return JSON.parse(fs.readFileSync("data/reports/scoreboard-nfl.json", "utf8")).rows || []; } catch { return []; } })();
let added = 0;
for (const r of sb) {
  const date = String(r.slate || "").slice(0, 10); if (!(date > ledgerEnd) || !(r.fee > 0)) continue;
  rows.push({ src: "scoreboard", key: String(r.contest), name: r.name || "", date, time: "", sd: /Showdown/i.test(r.name || ""), fee: r.fee, won: r.fee * (1 + (r.roi || 0) / 100), field: r.entries || 0 }); added++;
}
// his entries per contest -> entry style
const per = new Map(); for (const r of rows) per.set(r.key, (per.get(r.key) || 0) + 1);
const dow = d => new Date(d + "T12:00:00Z").getUTCDay();
for (const r of rows) {
  r.mine = per.get(r.key);
  r.style = /Single Entry/i.test(r.name) ? "single-entry" : r.mine === 1 ? "1 entry (multi-entry contest)" : r.mine <= 20 ? "2-20 entries" : "21+ entries";
  r.feeTier = r.fee < 5 ? "under $5" : r.fee < 25 ? "$5-24" : r.fee < 100 ? "$25-99" : r.fee < 300 ? "$100-299" : "$300+";
  r.fieldTier = r.field <= 100 ? "<=100" : r.field <= 1000 ? "101-1,000" : r.field <= 10000 ? "1,001-10,000" : "10,000+";
  r.sat = /Satellite|Qualifier|Ticket/i.test(r.name);
  const d = dow(r.date), late = r.time >= "19:00";
  r.slate = r.sd ? (d === 1 || d === 4 || (d === 0 && late) ? "showdown: primetime" : "showdown: Sunday day / other") : /\((Early Only|Afternoon Only|Afternoon Turbo|Primetime|Sun-Mon|Mon-Thu|Thu-Mon|Turbo)[^)]*\)/i.test(r.name) ? "classic: " + (r.name.match(/\((Early Only|Afternoon Only|Afternoon Turbo|Primetime|Sun-Mon|Mon-Thu|Thu-Mon|Turbo)/i)[1]) : "classic: main";
}

// ---------- stats ----------
function stat(list) {
  const fee = list.reduce((s, r) => s + r.fee, 0), won = list.reduce((s, r) => s + r.won, 0);
  const byDate = new Map(); for (const r of list) { const d = byDate.get(r.date) || { f: 0, w: 0 }; d.f += r.fee; d.w += r.won; byDate.set(r.date, d); }
  const D = [...byDate.values()]; let lo = null, hi = null;
  if (D.length >= 5 && fee > 0) {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, bs = [];
    for (let b = 0; b < 600; b++) { let f = 0, w = 0; for (let i = 0; i < D.length; i++) { const x = D[Math.floor(rnd() * D.length)]; f += x.f; w += x.w; } if (f > 0) bs.push(w / f - 1); }
    bs.sort((a, b) => a - b); lo = bs[Math.floor(0.05 * bs.length)]; hi = bs[Math.floor(0.95 * bs.length)];
  }
  return { n: list.length, contests: new Set(list.map(r => r.key)).size, dates: D.length, fee, won, roi: fee > 0 ? won / fee - 1 : null, lo, hi };
}
const pct = x => x == null ? "-" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`, usd = x => "$" + Math.round(x).toLocaleString("en-US");
const verdict = s => s.fee < 2000 || s.dates < 8 ? "not enough data" : s.roi > 0.05 && s.lo > -0.15 ? "play more" : s.roi < -0.15 && s.hi < 0 ? "play less" : "neutral";
function table(title, list, keyFn, order) {
  const g = new Map(); for (const r of list) { const k = keyFn(r); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const ks = [...g.keys()].sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : g.get(b).reduce((s, r) => s + r.fee, 0) - g.get(a).reduce((s, r) => s + r.fee, 0));
  const out = [`### ${title}`, "", "| Group | Entries | Dates | Fees | Won | ROI | 90% range | Verdict |", "|---|---|---|---|---|---|---|---|"], res = [];
  for (const k of ks) { const s = stat(g.get(k)); res.push({ k, s }); out.push(`| ${k} | ${s.n} | ${s.dates} | ${usd(s.fee)} | ${usd(s.won)} | ${pct(s.roi)} | ${s.lo == null ? "-" : `${pct(s.lo)} to ${pct(s.hi)}`} | ${verdict(s)} |`); }
  return { md: out.join("\n"), res };
}

const recent = rows.filter(r => r.date >= since && !r.sat), all = rows.filter(r => !r.sat);
const FEE = ["under $5", "$5-24", "$25-99", "$100-299", "$300+"], FIELD = ["<=100", "101-1,000", "1,001-10,000", "10,000+"];
const sections = [], picks = [];
const add = (t, list, fn, order) => { const x = table(t, list, fn, order); sections.push(x.md, ""); return x.res; };
const tot = stat(recent), totAll = stat(all);
add("Format", recent, r => r.sd ? "showdown" : "classic");
const showFee = add("Showdown by fee tier", recent.filter(r => r.sd), r => r.feeTier, FEE);
const clFee = add("Classic by fee tier", recent.filter(r => !r.sd), r => r.feeTier, FEE);
const showField = add("Showdown by field size", recent.filter(r => r.sd), r => r.fieldTier, FIELD);
const clField = add("Classic by field size", recent.filter(r => !r.sd), r => r.fieldTier, FIELD);
const style = add("Entry style (both formats)", recent, r => `${r.sd ? "showdown" : "classic"}, ${r.style}`);
const slate = add("Slate type", recent, r => r.slate);
const combo = add("Format x fee tier x field size", recent, r => `${r.sd ? "SD" : "CL"} ${r.feeTier} / ${r.fieldTier} field`);
for (const grp of [showFee, clFee, showField, clField, style, slate, combo]) for (const { k, s } of grp) { const v = verdict(s); if (v === "play more" || v === "play less") picks.push({ v, k, s }); }
const seen = new Set(), uniq = picks.filter(p => !seen.has(p.v + p.k) && seen.add(p.v + p.k));
const more = uniq.filter(p => p.v === "play more").sort((a, b) => b.s.roi - a.s.roi), less = uniq.filter(p => p.v === "play less").sort((a, b) => b.s.fee - a.s.fee);
const thin = combo.filter(x => verdict(x.s) === "not enough data" && x.s.fee >= 500).map(x => x.k);

// ETR's contest-selection notes, newest week
const etrDirs = fs.existsSync("data/etr-data") ? fs.readdirSync("data/etr-data").filter(d => fs.existsSync(path.join("data/etr-data", d, "contest-selection.md"))).sort() : [];
const etr = etrDirs.length ? fs.readFileSync(path.join("data/etr-data", etrDirs[etrDirs.length - 1], "contest-selection.md"), "utf8").trim() : "(no ETR contest-selection notes saved yet)";

const md = [
  `# NFL contest selection - by structure`, ``,
  `Built ${new Date().toISOString().slice(0, 10)} from \`${ledger}\` (ends ${ledgerEnd}) plus ${added} later entries from the grade-week scoreboard. Window: ${since} on (${tot.n} entries, ${usd(tot.fee)} in fees, ROI ${pct(tot.roi)}, 90% range ${pct(tot.lo)} to ${pct(tot.hi)}); all-time NFL ${totAll.n} entries, ${usd(totAll.fee)}, ROI ${pct(totAll.roi)}. Satellites/qualifiers are left out. ROI is fee-weighted (winnings / fees - 1); the range is a bootstrap over dates, since contests on the same date share outcomes. "Play more" needs ROI above +5% with the bottom of the range above -15%; "play less" needs ROI below -15% with the whole range below zero; under $2,000 in fees or 8 dates is "not enough data".`, ``,
  `**The DraftKings history file is from ${ledgerEnd}.** Re-export it (DraftKings > My Contests > History > Download) so the ledger covers everything since; the scoreboard only has contests Stokastic simulated.`, ``,
  `## Short list`, ``,
  `**Play more:** ${more.length ? more.slice(0, 6).map(p => `${p.k} (${pct(p.s.roi)} on ${usd(p.s.fee)}, ${p.s.dates} dates)`).join("; ") : "nothing clears the bar yet."}`, ``,
  `**Play less:** ${less.length ? less.slice(0, 6).map(p => `${p.k} (${pct(p.s.roi)} on ${usd(p.s.fee)}, ${p.s.dates} dates)`).join("; ") : "nothing clearly negative yet."}`, ``,
  `**Not enough data** (spent $500+ but too few dates to judge): ${thin.slice(0, 8).join("; ") || "-"}.`, ``,
  `## ETR's contest-selection notes (${etrDirs[etrDirs.length - 1] || "-"})`, ``, etr, ``,
  `## Tables (${since} on)`, ``, ...sections,
].join("\n");
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/contest-report-nfl.md", md);
console.log(`wrote data/reports/contest-report-nfl.md | window ${since}+: ${tot.n} entries, ${usd(tot.fee)}, ROI ${pct(tot.roi)} (${pct(tot.lo)} to ${pct(tot.hi)})`);
console.log("PLAY MORE:", more.slice(0, 6).map(p => `${p.k} ${pct(p.s.roi)} on ${usd(p.s.fee)}`).join(" | ") || "-");
console.log("PLAY LESS:", less.slice(0, 6).map(p => `${p.k} ${pct(p.s.roi)} on ${usd(p.s.fee)}`).join(" | ") || "-");
