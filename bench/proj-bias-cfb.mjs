// How far off Stokastic's CFB projections were, by position, salary tier and projection size, from the pulled
// post-contest data alone. The compact files keep each lineup's actual fantasy points but not each player's, so a
// player's actual score is recovered by least squares from the lineup totals (conjugate gradient on the normal
// equations, one contest per slate - the one with the most lineups - players in 10+ lineups). The fit residual is
// printed so a slate whose totals do not pin the players down can be seen and dropped.
//   node bench/proj-bias-cfb.mjs [from] [to] [--json=data/reports/cfb-highstakes.json]
// Prints actual / projected by group, plain and ownership-weighted, with a date-clustered t on log(actual/proj).
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
const args = process.argv.slice(2).filter(a => !a.startsWith("--")), flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const FROM = args[0] || "2024-01-01", TO = args[1] || "2099-12-31", JSON_OUT = flag("json");
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN, sdv = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// one contest per slate: group by date + sorted player-id set signature, keep the most lineups
const best = new Map();
for (const f of listPost("cfb")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || /showdown/i.test(c.type) || c.date < FROM || c.date > TO) continue;
  const sig = c.date + "|" + j.players.map(p => p.team).filter(Boolean).sort().filter((x, i, a) => a.indexOf(x) === i).join(",");
  const cur = best.get(sig); if (!cur || j.lineups.length > cur.n) best.set(sig, { f, n: j.lineups.length });
}
const players = [];
let slates = 0;
for (const { f } of best.values()) {
  const j = readPost(f), c = j.contest, P = new Map(j.players.map(p => [p.id, p]));
  const L = j.lineups.filter(l => l.afp != null && l.ids.every(id => P.has(id)));
  const cnt = new Map(); for (const l of L) for (const id of l.ids) cnt.set(id, (cnt.get(id) || 0) + 1);
  const ids = [...cnt.keys()].filter(id => cnt.get(id) >= 10), ix = new Map(ids.map((id, i) => [id, i])), n = ids.length;
  const rows = L.filter(l => l.ids.every(id => ix.has(id))).map(l => ({ x: l.ids.map(id => ix.get(id)), y: l.afp }));
  if (rows.length < n * 3 || n < 10) continue;
  // CG on A'A x = A'y, start at projections
  const x = Float64Array.from(ids.map(id => P.get(id).proj || 0));
  const Av = v => rows.map(r => r.x.reduce((s, i) => s + v[i], 0)), Atv = w => { const o = new Float64Array(n); rows.forEach((r, k) => { for (const i of r.x) o[i] += w[k]; }); return o; };
  let rres = Atv(Av(x).map((v, k) => rows[k].y - v)), p = Float64Array.from(rres), rs = rres.reduce((s, v) => s + v * v, 0);
  for (let it = 0; it < 400 && rs > 1e-10; it++) { const Ap = Atv(Av(p)), a = rs / p.reduce((s, v, i) => s + v * Ap[i], 0); for (let i = 0; i < n; i++) { x[i] += a * p[i]; rres[i] -= a * Ap[i]; } const rs2 = rres.reduce((s, v) => s + v * v, 0); for (let i = 0; i < n; i++) p[i] = rres[i] + (rs2 / rs) * p[i]; rs = rs2; }
  const fit = Av(x), rmse = Math.sqrt(mean(fit.map((v, k) => (v - rows[k].y) ** 2)));
  if (rmse > 1) { console.log(`skip ${c.date} ${c.name}: residual ${rmse.toFixed(2)}`); continue; }
  slates++;
  ids.forEach((id, i) => { const q = P.get(id); if (!(q.proj > 0)) return; players.push({ date: c.date, name: q.name, pos: q.pos, sal: q.sal, proj: q.proj, act: Math.max(0, x[i]), own: q.aown || 0, pown: q.pown || 0 }); });
}
console.log(`${slates} slates, ${players.length} player-games recovered`);
const groups = {
  all: () => true, QB: p => p.pos === "QB", RB: p => p.pos === "RB", WR: p => p.pos === "WR",
  "salary < $5,000": p => p.sal < 5000, "salary $5,000-6,999": p => p.sal >= 5000 && p.sal < 7000, "salary $7,000+": p => p.sal >= 7000,
  "proj < 10": p => p.proj < 10, "proj 10-15": p => p.proj >= 10 && p.proj < 15, "proj 15-20": p => p.proj >= 15 && p.proj < 20, "proj 20+": p => p.proj >= 20,
  "QB $7,000+": p => p.pos === "QB" && p.sal >= 7000, "QB under $7,000": p => p.pos === "QB" && p.sal < 7000, "RB $6,000+": p => p.pos === "RB" && p.sal >= 6000, "RB under $6,000": p => p.pos === "RB" && p.sal < 6000,
  "WR $6,000+": p => p.pos === "WR" && p.sal >= 6000, "WR under $6,000": p => p.pos === "WR" && p.sal < 6000,
  "proj own 20%+": p => p.pown >= 0.2, "proj own under 5%": p => p.pown < 0.05
};
const out = {}, lines = ["| group | player-games | dates | actual / proj | own-weighted actual / proj | t (log ratio, by date) | half 1 | half 2 |", "|---|---|---|---|---|---|---|---|"];
const dates = [...new Set(players.map(p => p.date))].sort(), mid = dates[Math.floor(dates.length / 2)];
const tOf = ps => { const by = new Map(); for (const p of ps) (by.get(p.date) || by.set(p.date, []).get(p.date)).push(Math.log((p.act + 1) / (p.proj + 1))); const d = [...by.values()].map(mean); return d.length > 3 ? mean(d) / (sdv(d) / Math.sqrt(d.length)) : NaN; };
for (const [g, fn] of Object.entries(groups)) {
  const ps = players.filter(fn); if (ps.length < 30) continue;
  const ratio = ps.reduce((s, p) => s + p.act, 0) / ps.reduce((s, p) => s + p.proj, 0), wr = ps.reduce((s, p) => s + p.own * p.act, 0) / ps.reduce((s, p) => s + p.own * p.proj, 0);
  const h = k => { const q = ps.filter(p => k ? p.date >= mid : p.date < mid); return q.reduce((s, p) => s + p.act, 0) / q.reduce((s, p) => s + p.proj, 0); };
  out[g] = { n: ps.length, ratio: +ratio.toFixed(3), ownWeighted: +wr.toFixed(3), t: +tOf(ps).toFixed(2), half1: +h(0).toFixed(3), half2: +h(1).toFixed(3) };
  lines.push(`| ${g} | ${ps.length} | ${new Set(ps.map(p => p.date)).size} | ${ratio.toFixed(3)} | ${wr.toFixed(3)} | ${out[g].t} | ${out[g].half1} | ${out[g].half2} |`);
}
console.log(lines.join("\n"));
if (JSON_OUT) { let prev = {}; try { prev = JSON.parse(fs.readFileSync(JSON_OUT, "utf8")); } catch {} prev.projBias = { built: new Date().toISOString(), slates, playerGames: players.length, split: mid, groups: out }; fs.writeFileSync(JSON_OUT, JSON.stringify(prev, null, 1)); }
