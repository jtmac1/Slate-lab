// NBA classic rulebook with t-stats, by slate size (small 2-4 games, medium 5-7, large 8+, and all). Every rule compares a lineup
// with its own contest's field: per-contest follower-minus-rest difference, weighted min(cap, nf*nn/(nf+nn)), pooled across
// contests, t clustered by date. Halves: alternate dates (A/B). A rule HOLDS when both halves agree in sign with |t| >= 2 on top-10%;
// KEPT overall when it holds and |t| >= 3 on all data; a bucket version is kept only if it holds inside that bucket.
// Noise floor: user-level placebo rules (random 30% of usernames), and our sim run with a second seed.
// Pick loop on held-out halves: sim-ROI top decile vs kept-rule filter then sim-ROI top decile, realized top-10/top-1/cash/ROI.
// Sim ROI per real entry from grade-all --rows (data/reports/nba/cal/s1.* seed 1, s2.* seed 2).
//   node bench/fit-rulebook-nba.mjs [--sim=data/reports/nba/cal/s1.0.jsonl,...] [--sim2=...] [--until=2026-08-01] [--minfee=20]
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const CAL = "data/reports/nba/cal/", SIM = arg("sim", `${CAL}s1.0.jsonl,${CAL}s1.1.jsonl`).split(","), SIM2 = arg("sim2", `${CAL}s2.0.jsonl,${CAL}s2.1.jsonl`).split(",");
const UNTIL = arg("until", "2026-08-01"), MINFEE = +arg("minfee", 20), OUT = arg("out", "data/reports/nba/rulebook-nba"), WCAP = 250, TH = 2, TK = 3;
const BUCKETS = ["all", "small", "medium", "large"], bucketOf = g => g <= 4 ? "small" : g <= 7 ? "medium" : "large";
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const pct = arr => { const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]), out = new Float64Array(arr.length); let k = 0; while (k < idx.length) { let e = k; while (e + 1 < idx.length && arr[idx[e + 1]] === arr[idx[k]]) e++; const r = arr.length > 1 ? (k + e) / 2 / (arr.length - 1) : 0.5; for (let q = k; q <= e; q++) out[idx[q]] = r; k = e + 1; } return out; };
const median = a => { const v = a.slice().sort((x, y) => x - y); return v.length ? (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2 : 0; };

// sim rows: contest dir -> [{u, fin, roi}] in entry order
async function loadSim(files) {
  const m = new Map();
  for (const f of files) { const txt = fs.readFileSync(f, "utf8"); let i = 0;
    while (i < txt.length) { let e = txt.indexOf("\n", i); if (e < 0) e = txt.length; if (e > i) { const r = JSON.parse(txt.slice(i, e)); if (r.fkey === "nba_cl") (m.get(r.c) || m.set(r.c, []).get(r.c)).push([r.user, r.finish, r.roi]); } i = e + 1; } }
  return m;
}
const S1 = await loadSim(SIM), S2 = await loadSim(SIM2);

// per-lineup features from the post files, joined to sim rows
const C = []; let joinMiss = 0, joinTot = 0;
for (const file of listPost("nba")) {
  const dir = "post/nba/" + file.split(/[\\/]/).pop().replace(/\.json(\.gz)?$/, ""), s1 = S1.get(dir); if (!s1) continue;
  const j = readPost(file), c = j.contest; if (/showdown/i.test(c.type) || c.fee < MINFEE || c.date >= UNTIL || !j.lineups?.length) continue;
  const P = new Map(); for (const p of j.players) if (p.id) P.set(p.id, p);
  const gk = p => p.team && p.opp ? [p.team, p.opp].sort().join("@") : p.team, games = new Set([...P.values()].map(gk)).size;
  const chalk = new Set([...P.values()].sort((a, b) => b.pown - a.pown).slice(0, 8).map(p => p.id));
  const s2 = S2.get(dir), L = [];
  let k1 = 0, k2 = 0;
  for (const l of j.lineups) {
    const ps = l.ids.map(id => P.get(id)); if (ps.length !== 8 || ps.some(p => !p)) continue;
    const fin = l.fin ?? j.lineups.length; let roi = null, roi2 = null;
    if (k1 < s1.length && s1[k1][0] === l.u && s1[k1][1] === fin) roi = s1[k1++][2];
    if (s2 && k2 < s2.length && s2[k2][0] === l.u && s2[k2][1] === fin) roi2 = s2[k2++][2];
    joinTot++; if (roi == null) { joinMiss++; continue; }
    const tc = {}, gc = {}; for (const p of ps) { tc[p.team] = (tc[p.team] || 0) + 1; gc[gk(p)] = (gc[gk(p)] || 0) + 1; }
    L.push({ u: l.u, fin, aroi: l.aroi ?? -1, roi, roi2, sroi: l.sroi, dup: l.dup || 0, left: 50000 - l.sal,
      own: ps.reduce((s, p) => s + p.pown, 0) * 100, proj: ps.reduce((s, p) => s + p.proj, 0),
      studs: ps.filter(p => p.sal >= 9000).length, punts: ps.filter(p => p.sal <= 4000).length, sub5: ps.filter(p => p.pown < 0.05).length,
      chalk: ps.filter(p => chalk.has(p.id)).length, maxTeam: Math.max(...Object.values(tc)), maxGame: Math.max(...Object.values(gc)), gUsed: Object.keys(gc).length });
  }
  if (L.length < 50) continue;
  const N = L.length, paid = j.lineups.filter(l => (l.aroi ?? -1) > -1).length, c1 = Math.max(1, Math.round(N * 0.01)), c10 = Math.max(1, Math.round(N * 0.1));
  const op = pct(L.map(x => x.own)), pp = pct(L.map(x => x.proj)), sp = pct(L.map(x => -x.roi)), kp = pct(L.map(x => -(x.sroi ?? -9))), s2p = s2 ? pct(L.map(x => -(x.roi2 ?? x.roi))) : null;
  const mOwn = mean(L.map(x => x.own)), med = { studs: median(L.map(x => x.studs)), punts: median(L.map(x => x.punts)), chalk: median(L.map(x => x.chalk)), gUsed: median(L.map(x => x.gUsed)), maxTeam: median(L.map(x => x.maxTeam)) };
  L.forEach((x, i) => { x.ownPct = op[i]; x.projPct = pp[i]; x.simPct = sp[i]; x.stkPct = kp[i]; x.sim2Pct = s2p ? s2p[i] : sp[i]; x.ownVs = x.own - mOwn; x.med = med; x.games = games;
    x.top1 = x.fin <= c1 ? 1 : 0; x.top10 = x.fin <= c10 ? 1 : 0; x.cash = x.aroi > -1 ? 1 : 0; });
  C.push({ dir, date: c.date, fee: c.fee, N, games, bucket: bucketOf(games), L, paid });
}
const dates = [...new Set(C.map(c => c.date))].sort(), half = d => dates.indexOf(d) % 2 ? "B" : "A";
for (const c of C) c.half = half(c.date);
console.log(`${C.length} contests, ${C.reduce((s, c) => s + c.N, 0)} lineups, ${dates.length} dates ${dates[0]}..${dates.at(-1)}; sim join miss ${joinMiss}/${joinTot}`);

const RULES = [
  ["own sum top 30% of contest", x => x.ownPct >= 0.7], ["own sum bottom 30% of contest", x => x.ownPct <= 0.3], ["own sum above contest median", x => x.ownPct > 0.5],
  ["own sum >= field avg +20", x => x.ownVs >= 20], ["own sum <= field avg -20", x => x.ownVs <= -20],
  ["chalk (top-8 proj own) above contest median", x => x.chalk > x.med.chalk], ["chalk below contest median", x => x.chalk < x.med.chalk],
  ["no player under 5% proj own", x => x.sub5 === 0], ["2+ players under 5% proj own", x => x.sub5 >= 2],
  ["salary left $0", x => x.left === 0], ["salary left >= $200", x => x.left >= 200], ["salary left >= $500", x => x.left >= 500],
  ["0 studs ($9K+)", x => x.studs === 0], ["2+ studs", x => x.studs >= 2], ["3+ studs", x => x.studs >= 3], ["studs above contest median", x => x.studs > x.med.studs],
  ["0-1 punts (<=$4K)", x => x.punts <= 1], ["2+ punts", x => x.punts >= 2], ["3+ punts", x => x.punts >= 3],
  ["stars-and-scrubs (2+ studs and 2+ punts)", x => x.studs >= 2 && x.punts >= 2],
  ["3+ from one team", x => x.maxTeam >= 3], ["4+ from one team", x => x.maxTeam >= 4], ["max team above contest median", x => x.maxTeam > x.med.maxTeam],
  ["4+ from one game", x => x.maxGame >= 4], ["5+ from one game", x => x.maxGame >= 5],
  ["games used below contest median", x => x.gUsed < x.med.gUsed], ["games used above contest median", x => x.gUsed > x.med.gUsed],
  ["uses every game (slates <= 6 games)", x => x.gUsed === x.games, x => x.games <= 6],
  ["projection top 10% of contest", x => x.projPct >= 0.9], ["projection top 30%", x => x.projPct >= 0.7], ["projection bottom half", x => x.projPct < 0.5],
  ["leverage: proj pct - own pct >= 0.25", x => x.projPct - x.ownPct >= 0.25], ["chalk-heavy: own pct - proj pct >= 0.25", x => x.ownPct - x.projPct >= 0.25],
  ["duplicated (post-hoc)", x => x.dup > 0, null, 1], ["duplicated 5+ (post-hoc)", x => x.dup >= 5, null, 1],
  ["our sim ROI top decile", x => x.simPct < 0.1, null, 1], ["our sim ROI top half", x => x.simPct < 0.5, null, 1], ["our sim ROI bottom quarter", x => x.simPct >= 0.75, null, 1],
  ["our sim ROI top decile (seed 2)", x => x.sim2Pct < 0.1, null, 1],
  ["Stokastic sim top decile (ref)", x => x.stkPct < 0.1, null, 1], ["Stokastic sim top half (ref)", x => x.stkPct < 0.5, null, 1],
].map(([name, f, scope, sim]) => ({ name, f, scope: scope || (() => true), sim: !!sim }));
const OUTS = ["top10", "top1", "cash", "aroi"];

// effect of pred on outcome across contests cs: per-contest diff, weight min(cap, harmonic), date-clustered t
function effect(cs, pred, scope, out) {
  const byD = new Map(); let nf = 0, nn = 0, nc = 0;
  for (const c of cs) { let sf = 0, cf = 0, sn = 0, cn = 0;
    for (const x of c.L) { if (!scope(x)) continue; const y = out === "aroi" ? Math.min(x.aroi, 100) : x[out]; if (pred(x)) { sf += y; cf++; } else { sn += y; cn++; } }
    if (!cf || !cn) continue; nf += cf; nn += cn; nc++;
    const w = Math.min(WCAP, cf * cn / (cf + cn)), d = sf / cf - sn / cn, g = byD.get(c.date) || byD.set(c.date, { S: 0, W: 0, B: 0 }).get(c.date); g.S += w * d; g.W += w; g.B += w * sn / cn; }
  const G = [...byD.values()]; if (G.length < 3) return { d: NaN, t: NaN, nc, nf, nn };
  const SW = G.reduce((s, g) => s + g.W, 0), th = G.reduce((s, g) => s + g.S, 0) / SW, base = G.reduce((s, g) => s + g.B, 0) / SW;
  const v = G.length / (G.length - 1) * G.reduce((s, g) => s + (g.S - th * g.W) ** 2, 0) / SW ** 2;
  return { d: th, t: th / Math.sqrt(v), base, lift: out !== "aroi" && base > 0 ? (base + th) / base : null, nc, nf, nn, share: nf / (nf + nn) };
}
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2), r4 = x => x == null || !isFinite(x) ? null : +x.toFixed(4);
const sub = (b, h) => C.filter(c => (b === "all" || c.bucket === b) && (!h || c.half === h));

// buckets
const bucketInfo = {}; for (const b of BUCKETS) { const cs = sub(b); bucketInfo[b] = { contests: cs.length, dates: new Set(cs.map(c => c.date)).size, lineups: cs.reduce((s, c) => s + c.N, 0), A: sub(b, "A").length, B: sub(b, "B").length }; bucketInfo[b].thin = bucketInfo[b].contests < 40 || bucketInfo[b].dates < 20; }

// noise floor: placebo rules on usernames (users have styles, so this keeps the within-user clustering real rules have)
const hash = (s, k) => { let h = 2166136261 ^ k; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 1000) / 1000; };
const noise = {}; for (const b of BUCKETS) { const ts = []; for (let k = 0; k < 100; k++) ts.push(Math.abs(effect(sub(b), x => hash(x.u, k * 7919 + 1) < 0.3, () => true, "top10").t)); ts.sort((a, z) => a - z); noise[b] = { p50: r2(ts[49]), p95: r2(ts[94]), max: r2(ts[99]), over2: ts.filter(t => t >= 2).length, over3: ts.filter(t => t >= 3).length }; }

// rule table
const table = RULES.map(R => { const o = { rule: R.name, sim: R.sim };
  for (const b of BUCKETS) { const e = {}; for (const out of OUTS) { const z = effect(sub(b), R.f, R.scope, out); e[out] = { d: r4(z.d), t: r2(z.t), lift: r2(z.lift) }; if (out === "top10") { e.share = r2(z.share); e.nc = z.nc; e.base = r4(z.base); } }
    const a = effect(sub(b, "A"), R.f, R.scope, "top10"), bb = effect(sub(b, "B"), R.f, R.scope, "top10");
    e.tA = r2(a.t); e.tB = r2(bb.t); e.holds = Math.sign(a.t) === Math.sign(bb.t) && Math.abs(a.t) >= TH && Math.abs(bb.t) >= TH;
    e.kept = b === "all" ? e.holds && Math.abs(e.top10.t) >= TK : e.holds; e.aboveNoise = Math.abs(e.top10.t) > noise[b].max;
    const a1 = effect(sub(b, "A"), R.f, R.scope, "top1"), b1 = effect(sub(b, "B"), R.f, R.scope, "top1"); e.tA1 = r2(a1.t); e.tB1 = r2(b1.t);
    e.holds1 = Math.sign(a1.t) === Math.sign(b1.t) && Math.sign(a1.t) === Math.sign(e.top10.d) && Math.abs(a1.t) >= TH && Math.abs(b1.t) >= TH; e.dir = e.top10.d > 0 ? "FOLLOW" : "AVOID"; o[b] = e; }
  return o; });

// pick loop on held-out halves: rules picked on the other half (|t| >= 2.5 on top-10%; bucket version where the bucket's own t >= 2.5,
// otherwise the overall rule unless the bucket contradicts it), applied greedily by |t| while 20%+ of the field still passes
function selectRules(h, V) {
  const tr = h === "A" ? "B" : "A", res = {};
  const eff = RULES.filter(R => !R.sim).map(R => ({ R, all: effect(sub("all", tr), R.f, R.scope, V.target), by: Object.fromEntries(BUCKETS.slice(1).map(b => [b, effect(sub(b, tr), R.f, R.scope, V.target)])) }));
  for (const b of BUCKETS.slice(1)) {
    const cand = eff.map(e => { const bt = e.by[b].t, at = e.all.t;
      if (Math.abs(bt) >= 2.5) return { R: e.R, sgn: Math.sign(bt), t: Math.abs(bt), src: b };
      if (Math.abs(at) >= 2.5 && !(Math.sign(bt) === -Math.sign(at) && Math.abs(bt) >= 1)) return { R: e.R, sgn: Math.sign(at), t: Math.abs(at), src: "all" };
      return null; }).filter(r => r && (!V.avoidOnly || r.sgn < 0)).sort((p, q) => q.t - p.t);
    const cs = sub(b, tr), picked = [];
    for (const r of cand) { const trial = picked.concat(r), pass = x => trial.every(q => !q.R.scope(x) || (q.R.f(x) ? 1 : -1) === q.sgn);
      const share = mean(cs.map(c => c.L.filter(pass).length / c.N)); if (share >= 0.2) picked.push(r); }
    res[b] = picked;
  }
  return res;
}
const VARIANTS = [{ name: "top10 rules", target: "top10" }, { name: "top10 AVOID-only", target: "top10", avoidOnly: true }, { name: "top1 rules", target: "top1" }];
function loop() {
  const arms = ["field", "sim top decile", "sim2 top decile"].concat(VARIANTS.flatMap(v => [v.name + " filter", v.name + " + sim top decile"])), out = {}, rulesUsed = {};
  const per = []; // per held-out contest metrics per arm
  for (const h of ["A", "B"]) { const sels = VARIANTS.map(V => selectRules(h, V));
    VARIANTS.forEach((V, i) => { for (const [b, rs] of Object.entries(sels[i])) (rulesUsed[V.name] = rulesUsed[V.name] || {})[h + " " + b] = rs.map(r => `${r.sgn > 0 ? "FOLLOW" : "AVOID"} ${r.R.name}${r.src !== "all" ? " [" + r.src + "]" : ""}`); });
    for (const c of sub("all", h)) { const K = Math.max(1, Math.round(c.N * 0.1)), byS = a => a.slice().sort((p, q) => p.simPct - q.simPct).slice(0, K);
      const picks = { field: c.L, "sim top decile": byS(c.L), "sim2 top decile": c.L.slice().sort((p, q) => p.sim2Pct - q.sim2Pct).slice(0, K) }; let F;
      VARIANTS.forEach((V, i) => { const rs = sels[i][c.bucket], pass = x => rs.every(q => !q.R.scope(x) || (q.R.f(x) ? 1 : -1) === q.sgn), Fi = c.L.filter(pass); if (!i) F = Fi; picks[V.name + " filter"] = Fi; picks[V.name + " + sim top decile"] = byS(Fi); });
      const m = {}; for (const a of arms) { const L = picks[a]; m[a] = L.length ? { n: L.length, top10: mean(L.map(x => x.top10)), top1: mean(L.map(x => x.top1)), cash: mean(L.map(x => x.cash)), roi: mean(L.map(x => x.aroi)) } : null; }
      per.push({ date: c.date, bucket: c.bucket, passShare: F.length / c.N, m }); } }
  for (const b of BUCKETS) { const ps = per.filter(p => b === "all" || p.bucket === b); out[b] = { contests: ps.length, passShare: r2(mean(ps.map(p => p.passShare))) };
    for (const a of arms) { const v = ps.filter(p => p.m[a] && p.m["sim top decile"]); const o = { lineups: v.reduce((s, p) => s + p.m[a].n, 0) };
      for (const k of ["top10", "top1", "cash", "roi"]) { o[k] = r4(mean(v.map(p => p.m[a][k])));
        if (a !== "sim top decile") { const byD = new Map(); for (const p of v) { const g = byD.get(p.date) || byD.set(p.date, []).get(p.date); g.push(p.m[a][k] - p.m["sim top decile"][k]); }
          const ds = [...byD.values()].map(mean), md = mean(ds), sd = Math.sqrt(ds.reduce((s, x) => s + (x - md) ** 2, 0) / (ds.length - 1) / ds.length); o[k + "_vsSim"] = r4(md); o[k + "_t"] = r2(md / sd); } }
      out[b][a] = o; } }
  return { out, rulesUsed };
}
const LOOP = loop();

const json = { built: new Date().toISOString().slice(0, 10), method: { compare: "per-contest follower minus rest, weight min(250, nf*nn/(nf+nn)), date-clustered t", halves: "alternate dates A/B", holds: `both halves same sign, |t| >= ${TH} on top-10%`, kept: `holds and |t| >= ${TK} (all); bucket version kept if it holds in that bucket`, ownership: "projected ownership (pown), field-relative where noted", aroiCap: "ROI capped at +100x per lineup" },
  data: { contests: C.length, lineups: C.reduce((s, c) => s + c.N, 0), dates: dates.length, from: dates[0], to: dates.at(-1), simJoinMiss: joinMiss, simJoinTotal: joinTot }, buckets: bucketInfo, noise, rules: table, loop: LOOP.out, loopRules: LOOP.rulesUsed };
fs.writeFileSync(OUT + ".json", JSON.stringify(json, null, 1));

const L = [], fmt = (e) => `${(e.top10.d * 100).toFixed(1).padStart(5)}pp t${String(e.top10.t).padStart(6)} A${String(e.tA).padStart(6)} B${String(e.tB).padStart(6)} t1x${String(e.top1.lift ?? "-").padStart(5)}(${String(e.top1.t).padStart(5)} A${String(e.tA1).padStart(5)} B${String(e.tB1).padStart(5)}) ROI${(e.aroi.d * 100).toFixed(0).padStart(5)}%${e.kept ? " *" : "  "}${e.aboveNoise ? "!" : " "}${e.holds1 ? "1" : ""}`;
L.push(`NBA classic rulebook (${json.built}) - bench/fit-rulebook-nba.mjs`, `Data: ${C.length} contests $${MINFEE}+, ${json.data.lineups.toLocaleString()} real lineups, ${dates.length} dates ${dates[0]}..${dates.at(-1)}; sim join miss ${joinMiss}/${joinTot}`,
  `Effect = top-10% rate, follower minus rest in the same contest (pp), date-clustered t; A/B = alternate-date halves; t1x = top-1% lift (t); * = kept (holds both halves |t|>=${TH}${", all needs |t|>=" + TK}); ! = |t| above the placebo max; 1 = top-1% also holds both halves; ROI = follower minus rest`, "");
L.push("Buckets: " + BUCKETS.map(b => `${b} ${bucketInfo[b].contests} contests/${bucketInfo[b].dates} dates (A ${bucketInfo[b].A}, B ${bucketInfo[b].B})${bucketInfo[b].thin ? " THIN" : ""}`).join("; "));
L.push("Noise floor (100 username placebo rules, |t| top-10%): " + BUCKETS.map(b => `${b} p95 ${noise[b].p95} max ${noise[b].max} (>=3: ${noise[b].over3})`).join("; "), "");
for (const b of BUCKETS) { L.push(`== ${b} ==`); for (const r of table) L.push(`  ${r[b].dir.padEnd(6)} ${r.rule.padEnd(46)} ${fmt(r[b])}`); L.push(""); }
L.push("Pick loop on held-out halves (rules from the other half). Per-contest means; vs-sim t clustered by date.");
for (const b of BUCKETS) { const o = LOOP.out[b]; L.push(`  ${b} (${o.contests} contests, top10-rules filter keeps ${(o.passShare * 100).toFixed(0)}% of field)`);
  for (const a of Object.keys(o).filter(k => typeof o[k] === "object")) { const x = o[a]; L.push(`    ${a.padEnd(30)} top10 ${(x.top10 * 100).toFixed(1).padStart(5)}%${x.top10_t != null ? ` (${(x.top10_vsSim * 100).toFixed(1)}, t ${x.top10_t})` : ""}  top1 ${(x.top1 * 100).toFixed(2)}%${x.top1_t != null ? ` (t ${x.top1_t})` : ""}  cash ${(x.cash * 100).toFixed(1)}%  ROI ${(x.roi * 100).toFixed(0)}%${x.roi_t != null ? ` (t ${x.roi_t})` : ""}  n ${x.lineups}`); } }
L.push("", "Rules used in the loop (picked on the other half):"); for (const [v, o] of Object.entries(LOOP.rulesUsed)) for (const [k, rs] of Object.entries(o)) L.push(`  ${v} | held-out ${k}: ${rs.join("; ") || "(none)"}`);
fs.writeFileSync(OUT + ".txt", L.join("\n") + "\n"); console.log(L.join("\n"));
