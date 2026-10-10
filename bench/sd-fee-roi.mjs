// His DraftKings ROI by entry-fee tier and format (NFL showdown vs classic), from the DK contest history export
// (data/dk-history, newest file) plus Stokastic post-contest pulls after the export's last date (contest.mine).
// Per tier: entries, contests, fees, winnings (cash + tickets), ROI, cash rate, and how much of the profit or loss
// came from the single best result (a tier carried by one score is not a repeatable edge).
//   node bench/sd-fee-roi.mjs [--sport=NFL]      -> data/reports/fee-roi.json
import fs from "node:fs";
import path from "node:path";
import { listPost, readPost } from "./post-store.mjs";
const SPORT = (process.argv.find(a => a.startsWith("--sport=")) || "--sport=NFL").slice(8).toUpperCase();
const money = s => Number(String(s ?? "0").replace(/[$,"]/g, "")) || 0;
const tierOf = fee => fee < 5 ? "$0-4" : fee < 20 ? "$5-19" : fee < 100 ? "$20-99" : fee < 300 ? "$100-299" : "$300+";
const TIERS = ["$0-4", "$5-19", "$20-99", "$100-299", "$300+"];
const seasonOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m >= 8 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`; };

function parseCsv(txt) {
  const rows = [], re = /("([^"]|"")*"|[^,\r\n]*)(,|\r?\n|$)/g; let row = [], m;
  while ((m = re.exec(txt)) && m[0] !== "") { let v = m[1]; if (v.startsWith('"')) v = v.slice(1, -1).replace(/""/g, '"'); row.push(v); if (m[3] !== ",") { rows.push(row); row = []; } }
  const [h, ...r] = rows; return r.filter(x => x.length === h.length).map(x => Object.fromEntries(h.map((k, i) => [k, x[i]])));
}
const dir = "data/dk-history", file = fs.readdirSync(dir).filter(f => f.endsWith(".csv")).sort().pop();
const entries = [];
for (const r of parseCsv(fs.readFileSync(path.join(dir, file), "utf8"))) {
  if (r.Sport !== SPORT) continue;
  const fee = money(r.Entry_Fee); if (!fee) continue;
  entries.push({ src: "dk", date: r.Contest_Date_EST.slice(0, 10), key: r.Contest_Key, fmt: /showdown/i.test(r.Game_Type + " " + r.Entry) ? "showdown" : "classic", fee, won: money(r.Winnings_Non_Ticket) + money(r.Winnings_Ticket), field: +r.Contest_Entries || null });
}
const last = entries.reduce((m, e) => e.date > m ? e.date : m, "");
const seen = new Set(entries.map(e => e.key));
for (const f of listPost(SPORT.toLowerCase())) {
  const j = readPost(f), c = j.contest; if (!c || c.date <= last || seen.has(String(c.key)) || !c.mine?.length) continue;
  for (const m of c.mine) entries.push({ src: "stokastic", date: c.date, key: String(c.key), fmt: /showdown/i.test(c.type + " " + c.name) ? "showdown" : "classic", fee: c.fee, won: m.won || 0, field: c.entries });
}

function summarize(es) {
  const fees = es.reduce((s, e) => s + e.fee, 0), won = es.reduce((s, e) => s + e.won, 0), net = won - fees;
  const best = es.reduce((b, e) => e.won - e.fee > (b ? b.won - b.fee : -Infinity) ? e : b, null);
  return { entries: es.length, contests: new Set(es.map(e => e.key)).size, fees: Math.round(fees), won: Math.round(won), net: Math.round(net),
    roi: fees ? Math.round(1000 * net / fees) / 1000 : null, cashRate: es.length ? Math.round(1000 * es.filter(e => e.won > 0).length / es.length) / 1000 : null,
    netWithoutBest: best ? Math.round(net - (best.won - best.fee)) : null, best: best ? { date: best.date, fee: best.fee, won: Math.round(best.won) } : null };
}
const out = { sport: SPORT, file, dkThrough: last, through: entries.reduce((m, e) => e.date > m ? e.date : m, ""), tables: {} };
for (const fmt of ["showdown", "classic"]) for (const season of ["all", ...[...new Set(entries.map(e => seasonOf(e.date)))].sort()]) {
  const es = entries.filter(e => e.fmt === fmt && (season === "all" || seasonOf(e.date) === season)); if (!es.length) continue;
  out.tables[`${fmt} ${season}`] = { total: summarize(es), ...Object.fromEntries(TIERS.map(t => [t, summarize(es.filter(e => tierOf(e.fee) === t))]).filter(([, v]) => v.entries)) };
}
fs.writeFileSync("data/reports/fee-roi.json", JSON.stringify(out, null, 1));

const pc = x => x == null ? "-" : (x * 100).toFixed(1) + "%", usd = x => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString();
console.log(`${SPORT} ROI by entry fee: DK export ${file} (through ${out.dkThrough}) + Stokastic pulls through ${out.through}`);
for (const [k, t] of Object.entries(out.tables)) {
  console.log(`\n== ${k}`); console.log("tier".padEnd(10) + "entries contests      fees       won       net     ROI   cash%   net w/o best");
  for (const [tier, v] of Object.entries(t)) console.log(tier.padEnd(10) + String(v.entries).padStart(7) + String(v.contests).padStart(9) + usd(v.fees).padStart(10) + usd(v.won).padStart(10) + usd(v.net).padStart(10) + pc(v.roi).padStart(8) + pc(v.cashRate).padStart(8) + usd(v.netWithoutBest).padStart(15));
}
console.log("\nwrote data/reports/fee-roi.json");
