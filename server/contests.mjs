// Contest selection: the DraftKings lobby for the loaded slate, each contest tagged with this
// account's record in that contest family and in its structural bucket (fee tier x field size),
// from the complete DK entry history in data/dk-history. Family/stats/verdict mirror
// bench/contest-select.mjs (per-contest clustered t, first-place count vs field-rate expectation).
import fs from "node:fs";
import path from "node:path";
import { parseCSV } from "../src/engine/csv.mjs";

const num = v => parseFloat(String(v ?? "").replace(/[$,]/g, "")) || 0;
export const family = name => String(name).replace(/^(MLB|NFL|CFB|NBA|NHL|PGA)\s+/i, "").replace(/^(Showdown|Classic|In-Game|Single Stat)\s+/i, "").replace(/^\$[\d.,]+[KM]?\s+/, "").split(/\s+[\[(]|\s+-\s+/)[0].replace(/\$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export const capOf = name => { const s = String(name); if (/single entry/i.test(s)) return 1; const m = s.match(/(\d+)\s*Entry\s*Max/i); return m ? +m[1] : null; };
const feeTier = f => f < 5 ? "<$5" : f < 25 ? "$5-24" : f < 100 ? "$25-99" : f < 500 ? "$100-499" : "$500+";
const fieldTier = n => n < 500 ? "<500" : n < 2000 ? "500-2k" : n < 10000 ? "2k-10k" : "10k+";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const poisTail = (k, lam) => { if (k <= 0) return 1; let p = Math.exp(-lam), cdf = p; for (let i = 1; i < k; i++) { p *= lam / i; cdf += p; } return Math.max(0, 1 - cdf); };
const money = t => { const m = String(t).match(/([\d.]+)\s*([KM]?)/i); return m ? +m[1] * (m[2].toUpperCase() === "K" ? 1e3 : m[2].toUpperCase() === "M" ? 1e6 : 1) : null; };
export const topPrize = name => { const t = (String(name).match(/\$\s*([\d.]+\s*[KM]?)\s*to\s*1st/i) || [])[1]; return t ? money(t) : null; };

let cache = null;
export function history(sport = "NFL") {
  const dir = "data/dk-history"; if (!fs.existsSync(dir)) return { entries: [], file: null };
  const files = fs.readdirSync(dir).filter(f => /\.csv$/i.test(f)).sort(), latest = files[files.length - 1]; if (!latest) return { entries: [], file: null };
  if (cache && cache.file === latest && cache.sport === sport) return cache;
  const rows = parseCSV(fs.readFileSync(path.join(dir, latest), "utf8")), H = rows[0].map(s => String(s).trim()), ix = n => H.indexOf(n);
  const entries = rows.slice(1).map(c => ({ sport: String(c[ix("Sport")] || "").toUpperCase(), gt: String(c[ix("Game_Type")] || ""), name: String(c[ix("Entry")] || "").replace(/\s*\(\d+\/\d+\)\s*$/, ""), key: String(c[ix("Contest_Key")] || ""), date: String(c[ix("Contest_Date_EST")] || ""), place: +c[ix("Place")] || 0, win: num(c[ix("Winnings_Non_Ticket")]) + num(c[ix("Winnings_Ticket")]), n: +String(c[ix("Contest_Entries")] || "").replace(/,/g, "") || 0, fee: num(c[ix("Entry_Fee")]), paid: +c[ix("Places_Paid")] || 0 }))
    .filter(r => r.sport === sport && r.fee > 0 && r.n > 0);
  for (const r of entries) { r.fam = family(r.name); r.cap = capOf(r.name); r.sd = /showdown|captain/i.test(r.gt + " " + r.name); r.bucket = `${feeTier(r.fee)} / ${fieldTier(r.n)}`; }
  return cache = { entries, file: latest, sport };
}
export function stats(a) {
  const byC = {}; for (const r of a) (byC[r.key] = byC[r.key] || []).push(r);
  const perC = Object.values(byC).map(g => mean(g.map(r => r.win / r.fee - 1)));
  const fee = a.reduce((s, r) => s + r.fee, 0), win = a.reduce((s, r) => s + r.win, 0), wins = a.filter(r => r.place === 1).length, expWins = a.reduce((s, r) => s + 1 / r.n, 0);
  const t = perC.length > 1 ? mean(perC) / (sd(perC) / Math.sqrt(perC.length)) : null;
  return { n: a.length, contests: perC.length, fee: +fee.toFixed(0), win: +win.toFixed(0), roi: +(win / fee - 1).toFixed(3), t: t == null || !isFinite(t) ? null : +t.toFixed(2), wins, expWins: +expWins.toFixed(2), pWins: +poisTail(wins, expWins).toFixed(3), top10: +mean(a.map(r => r.place && r.place <= r.n * 0.1 ? 1 : 0)).toFixed(3), cash: +mean(a.map(r => r.win > 0 ? 1 : 0)).toFixed(3), avgFee: +mean(a.map(r => r.fee)).toFixed(0), last: a.map(r => r.date).sort().pop() };
}
export function verdict(s, minC = 15) {
  if (!s || s.contests < minC) return "few";
  if (s.roi > 0 && ((s.t != null && s.t >= 2) || (s.wins >= 3 && s.pWins < 0.05))) return "PLAY";
  if (s.roi < 0 && s.t != null && s.t <= -2) return "AVOID";
  return "neutral";
}
// lobby contests that belong to this slate: showdowns by the "(AWAY @ HOME)" in the name, classic by
// start time, grouped by DK draft group so the main slate and the early-only slate stay apart
export function contestsFor(slate, opts = {}) {
  const lf = "data/dk-lobby/nfl.json"; if (!fs.existsSync(lf)) return { contests: [], groups: [], note: "no lobby file - press Refresh" };
  const j = JSON.parse(fs.readFileSync(lf, "utf8")), arr = j.contests || [], fetched = j.fetched;
  const sd = slate.type === "SHOWDOWN", teams = slate.games.flatMap(g => g.split("@"));
  let live = arr.filter(c => c.guaranteed !== false && !/in-game|tiers|pick.?em|double up|50\/50|h2h|head-to-head|satellite|qualifier/i.test(c.name));
  if (sd) live = live.filter(c => /showdown/i.test(c.gameType + " " + c.name) && teams.every(t => new RegExp("\\b" + t + "\\b").test(c.name)));
  else {
    live = live.filter(c => /classic/i.test(c.gameType));
    const groups = {}; for (const c of live) { const g = groups[c.draftGroup] = groups[c.draftGroup] || { draftGroup: c.draftGroup, start: c.start, n: 0, prize: 0 }; g.n++; g.prize += c.prizePool || 0; }
    const list = Object.values(groups).sort((a, b) => b.prize - a.prize);
    const pick = opts.draftGroup ? list.find(g => String(g.draftGroup) === String(opts.draftGroup)) : list[0];
    live = pick ? live.filter(c => c.draftGroup === pick.draftGroup) : [];
    var groupList = list.slice(0, 8).map(g => ({ draftGroup: g.draftGroup, start: g.start, n: g.n, prize: g.prize, picked: pick && g.draftGroup === pick.draftGroup }));
  }
  const H = history("NFL").entries, F = {}, B = {};
  for (const r of H) { (F[r.fam] = F[r.fam] || []).push(r); (B[(r.sd ? "sd " : "cl ") + r.bucket] = B[(r.sd ? "sd " : "cl ") + r.bucket] || []).push(r); }
  const contests = live.map(c => {
    const fam = family(c.name), cap = capOf(c.name) ?? c.cap ?? null, top = topPrize(c.name), a = F[fam], bk = B[(sd ? "sd " : "cl ") + `${feeTier(c.fee)} / ${fieldTier(c.field)}`];
    const rec = a && a.length ? stats(a) : null, brec = bk && bk.length ? stats(bk) : null;
    const v = verdict(rec), bv = verdict(brec, 20), score = ({ PLAY: 3, neutral: 2, few: 1, AVOID: 0 })[v] * 10 + ({ PLAY: 3, neutral: 2, few: 1, AVOID: 0 })[bv];
    return { id: c.id, name: c.name, fee: c.fee, field: c.field, entered: c.entered, cap, prizePool: c.prizePool, top, topShare: top && c.prizePool ? +(top / c.prizePool).toFixed(3) : null, start: c.start, fam, record: rec, verdict: v, bucket: `${feeTier(c.fee)} / ${fieldTier(c.field)}`, bucketRecord: brec, bucketVerdict: bv, score };
  }).sort((a, b) => b.score - a.score || (b.prizePool || 0) - (a.prizePool || 0));
  // where the money has come from and gone: families with enough contests, by format
  const fams = Object.entries(F).filter(([, a]) => a[0].sd === sd).map(([k, a]) => Object.assign({ fam: k, verdict: verdict(stats(a)) }, stats(a))).filter(s => s.contests >= 5).sort((x, y) => y.fee - x.fee).slice(0, 25);
  const buckets = Object.entries(B).filter(([k]) => k.startsWith(sd ? "sd " : "cl ")).map(([k, a]) => Object.assign({ bucket: k.slice(3), verdict: verdict(stats(a), 20) }, stats(a))).filter(s => s.n >= 20).sort((x, y) => y.fee - x.fee);
  return { fetched, contests, groups: groupList || [], families: fams, buckets, overall: H.length ? stats(H.filter(r => r.sd === sd)) : null, historyFile: history("NFL").file };
}
