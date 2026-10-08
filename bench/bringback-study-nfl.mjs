// Bring-back and primary-pair study for NFL classic (overnight job 2026-10-07, after the Stroud + Collins + Lamb lesson).
// For every stored classic contest with lineups (data/post/nfl), lineups that stack a QB with 1-2 of his pass catchers
// are grouped by the primary pair (QB+WR1 / QB+WR2 / QB+TE / two catchers) and by the bring-back (none, opponent WR1,
// opponent WR2/3, opponent TE, opponent RB, 2+ players), then split by game environment and favourite/dog.
// Ranks come from the contest's projection table (post-contest "proj", near the pre-lock numbers for NFL classic);
// no Vegas lines are stored, so the game total and spread are proxies: the sum of both teams' projected points
// (QB + top-2 RB + top-3 WR + top TE) and the difference between the two teams' sums.
// Each contest counts once (lineup rates are averaged within the contest), dates are the independent units for t.
//   node bench/bringback-study-nfl.mjs [--year=2025] [--minfield=100]
import fs from "node:fs";
import zlib from "node:zlib";
const D = "data/post/nfl/";
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=")[1];
const YEARS = arg("year", "2025,2026").split(","), MINFIELD = +arg("minfield", 100);

const files = fs.readdirSync(D).filter(f => f.endsWith(".json.gz") && YEARS.includes(f.slice(0, 4))).sort();
// cell key -> date -> { contests, sumT1Diff, sumT10Diff, sumRoiDiff, n }
const cells = {};
const add = (key, date, c) => { const k = cells[key] || (cells[key] = {}); const d = k[date] || (k[date] = { contests: 0, t1: 0, t10: 0, roi: 0, n: 0, share: 0 }); d.contests++; d.t1 += c.t1; d.t10 += c.t10; d.roi += c.roi; d.n += c.n; d.share += c.share; };
let used = 0;
for (const f of files) {
  let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(D + f))); } catch { continue; }
  const C = j.contest || {};
  if (/Showdown|Captain/i.test(C.name + C.type) || !Array.isArray(j.lineups) || j.lineups.length < MINFIELD) continue;
  const N = C.entries || j.lineups.length, date = f.slice(0, 10);
  const P = new Map(j.players.map(p => [String(p.id), p]));
  // team pass-catcher ranks and team strength proxy
  const byTeam = {};
  for (const p of j.players) { if (!p.team || p.pos === "DST") continue; (byTeam[p.team] = byTeam[p.team] || []).push(p); }
  const rk = {}, str = {};
  for (const [t, ps] of Object.entries(byTeam)) {
    const top = (pos, k) => ps.filter(p => p.pos === pos).sort((a, b) => b.proj - a.proj).slice(0, k);
    const wr = top("WR", 3), te = top("TE", 1), rb = top("RB", 2), qb = top("QB", 1);
    wr.forEach((p, i) => rk[p.id] = "WR" + (i + 1)); te.forEach(p => rk[p.id] = "TE1"); rb.forEach((p, i) => rk[p.id] = "RB" + (i + 1));
    const catchers = [...wr, ...te].sort((a, b) => b.proj - a.proj); if (catchers[0]) rk[catchers[0].id + "|topPC"] = true;
    str[t] = [...qb, ...rb, ...wr, ...te].reduce((s, p) => s + p.proj, 0);
  }
  const totals = Object.values(str).map((v, i, a) => v).sort((a, b) => a - b);
  const gameTot = t => str[t] + (str[(byTeam[t] || [])[0]?.opp] || 0);
  const allTot = Object.keys(str).map(gameTot).sort((a, b) => a - b), q = x => x <= allTot[Math.floor(allTot.length / 3)] ? "low" : x >= allTot[Math.floor(2 * allTot.length / 3)] ? "high" : "mid";
  // per-contest group outcomes
  const g = {}, put = (key, lu) => { const o = g[key] || (g[key] = { n: 0, t1: 0, t10: 0, roi: 0 }); o.n++; if (lu.fin <= Math.max(1, N * 0.01)) o.t1++; if (lu.fin <= N * 0.1) o.t10++; o.roi += lu.aroi; };
  let fieldT1 = 0, fieldT10 = 0, fieldRoi = 0, LN = 0;
  for (const lu of j.lineups) {
    if (lu.fin == null) continue; LN++; if (lu.fin <= Math.max(1, N * 0.01)) fieldT1++; if (lu.fin <= N * 0.1) fieldT10++; fieldRoi += lu.aroi;
    const ps = lu.ids.map(id => P.get(String(id))).filter(Boolean); const qb = ps.find(p => p.pos === "QB"); if (!qb) continue;
    const mates = ps.filter(p => p !== qb && p.team === qb.team && (p.pos === "WR" || p.pos === "TE"));
    if (mates.length < 1 || mates.length > 2) { put("primary:" + (mates.length ? "QB+3" : "naked QB"), lu); continue; }
    const opp = ps.filter(p => p.team === qb.opp && p.pos !== "DST");
    const primary = mates.length === 2 ? "QB+2" : "QB+" + (rk[mates[0].id] || mates[0].pos + "x");
    const bb = !opp.length ? "none" : opp.length >= 2 ? "2+" : (() => { const r = rk[opp[0].id] || opp[0].pos + "x"; return r === "WR1" ? "oppWR1" : /^WR/.test(r) ? "oppWR2/3" : r === "TE1" ? "oppTE" : /^RB/.test(r) ? "oppRB" : "oppOther"; })();
    const topPC = opp.length === 1 && rk[opp[0].id + "|topPC"] ? "bb=opp top catcher" : opp.length === 1 && /WR|TE/.test(opp[0].pos) ? "bb=other catcher" : null;
    const env = q(gameTot(qb.team)), fav = str[qb.team] >= (str[qb.opp] || 0) ? "QB fav" : "QB dog";
    put("primary:" + primary, lu); put("bb:" + bb, lu); put("bb:" + bb + "|" + env + " total", lu); put("bb:" + bb + "|" + fav, lu);
    if (topPC) { put(topPC, lu); put(topPC + "|" + env + " total", lu); }
    if (mates.length === 1) put("pair:" + primary + "|bb:" + bb, lu);
  }
  if (!LN) continue; used++;
  const base = { t1: fieldT1 / LN, t10: fieldT10 / LN, roi: fieldRoi / LN };
  for (const [key, o] of Object.entries(g)) if (o.n >= 3) add(key, date, { t1: o.t1 / o.n - base.t1, t10: o.t10 / o.n - base.t10, roi: o.roi / o.n - base.roi, n: o.n, share: o.n / LN });
}
// date-clustered summary
const out = { built: new Date().toISOString(), years: YEARS, contests: used, note: "rates are group minus contest field, averaged within date then across dates; t over dates. Ranks from post-contest proj; game total/spread are projection-sum proxies (no stored lines).", cells: {} };
const rows = [];
for (const [key, byDate] of Object.entries(cells)) {
  const ds = Object.values(byDate).map(d => ({ t1: d.t1 / d.contests, t10: d.t10 / d.contests, roi: d.roi / d.contests, share: d.share / d.contests, n: d.n }));
  if (ds.length < 3) continue;
  const stat = k => { const v = ds.map(d => d[k]), m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)); return { mean: m, t: sd ? m / (sd / Math.sqrt(v.length)) : 0, pos: v.filter(x => x > 0).length }; };
  const r = { key, dates: ds.length, lineups: ds.reduce((a, d) => a + d.n, 0), share: ds.reduce((a, d) => a + d.share, 0) / ds.length, t1: stat("t1"), t10: stat("t10"), roi: stat("roi") };
  out.cells[key] = r; rows.push(r);
}
const fmt = r => `${r.key.padEnd(38)} dates ${String(r.dates).padStart(2)} share ${(100 * r.share).toFixed(1).padStart(5)}% | top1 ${(100 * r.t1.mean).toFixed(2).padStart(6)}pp t ${r.t1.t.toFixed(1).padStart(5)} | top10 ${(100 * r.t10.mean).toFixed(2).padStart(6)}pp t ${r.t10.t.toFixed(1).padStart(5)} (${r.t10.pos}/${r.dates}) | ROI ${(100 * r.roi.mean).toFixed(1).padStart(6)}pp t ${r.roi.t.toFixed(1).padStart(5)}`;
for (const grp of ["primary:", "bb:", "bb=", "pair:"]) { console.log("\n" + grp); rows.filter(r => r.key.startsWith(grp)).sort((a, b) => a.key.localeCompare(b.key)).forEach(r => console.log(fmt(r))); }
const of = arg("out", "");
if (of) fs.writeFileSync(of, JSON.stringify(out, null, 1));
console.log(`\ncontests ${used}`);
