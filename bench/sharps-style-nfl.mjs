// What play styles do the NFL sharps actually run? Takes the sharps roster (data/reports/sharps-nfl.json,
// users who finish top-10% far more than chance), profiles every roster user's lineups in the pulled
// $20+ contests by format (construction, contest shapes, volume, results), then clusters the users
// into styles with k-means on standardized construction features. Each cluster is a template:
// its mean construction, where it plays, how it did, and who is in it. The field and jtmac1999 are
// reported on the same features for comparison.
//   node bench/sharps-style-nfl.mjs [from] [to] [--min=50] [--k=4]   -> data/reports/sharps-style-nfl.json
import fs from "node:fs";
import { nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
const FROM = process.argv[2] || "2025-09-01", TO = process.argv[3] || "2099-12-31", MIN = +((process.argv.find(a => a.startsWith("--min=")) || "--min=50").slice(6)), K = +((process.argv.find(a => a.startsWith("--k=")) || "--k=4").slice(4)), YOU = "jtmac1999";
const roster = new Set(JSON.parse(fs.readFileSync("data/reports/sharps-nfl.json", "utf8")).map(u => String(u).toLowerCase()));
const REF = new Map(); try { for (const p of JSON.parse(fs.readFileSync("data/nfl-ref/players-2026.json", "utf8"))) REF.set(nrm(p.name), p.pos); } catch {}
const posOf = p => p.pos && p.pos !== "CPT" && p.pos !== "FLEX" ? p.pos : (REF.get(nrm(p.name)) || (/\s/.test(p.name) ? "?" : "DST"));
const tierOf = fee => fee < 100 ? "lo" : fee < 300 ? "mid" : "hi", sizeOf = n => n < 300 ? "<300" : n < 1500 ? "300-1.5K" : n < 10000 ? "1.5K-10K" : "10K+";
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const CL_F = ["own", "chalk", "left", "stack", "bring", "rbDst", "teams", "dup", "simPct", "perContest"], SD_F = ["own", "chalk", "left", "cptQB", "cptRB", "cptWR", "cptTE", "cptOwn", "s51", "s42", "s33", "hasK", "hasDST", "dup", "simPct", "perContest"];
const U = {}, FIELD = { classic: [], showdown: [] };
let contests = 0;
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.lineups?.length || !j.players?.length || c.date < FROM || c.date > TO || c.fee < 20) continue;
  const sd = /showdown/i.test(c.type + " " + c.name), fmt = sd ? "showdown" : "classic", N = j.lineups.length, tier = tierOf(c.fee), size = sizeOf(N);
  const byId = new Map(), cptOwn = new Map(); for (const p of j.players) { if (p.pos === "CPT") { cptOwn.set(p.id, p.aown); if (!byId.has(p.id)) byId.set(p.id, p); } else byId.set(p.id, Object.assign({}, p, { flexSal: p.sal })); }
  const order = j.lineups.slice().sort((a, b) => b.sroi - a.sroi), rank = new Map(order.map((l, i) => [l, i]));
  const perUser = {}; for (const l of j.lineups) perUser[l.u] = (perUser[l.u] || 0) + 1;
  const feats = l => {
    const ps = l.ids.map(id => byId.get(id)).filter(Boolean); if (ps.length < l.ids.length) return null;
    const tc = {}; for (const p of ps) tc[p.team] = (tc[p.team] || 0) + 1;
    const f = { own: l.own * 100, chalk: ps.filter(p => (p.aown || 0) >= 0.2).length, left: 50000 - l.sal, dup: l.dup > 0 ? 1 : 0, simPct: 100 * (1 - rank.get(l) / N), teams: Object.keys(tc).length, roi: l.aroi, top10: l.fin <= N * 0.1 ? 1 : 0, top1: l.fin <= Math.max(1, Math.ceil(N * 0.01)) ? 1 : 0, perContest: perUser[l.u], tier, size, fee: c.fee };
    if (sd) { const flexSum = ps.reduce((s, p) => s + (p.flexSal ?? p.sal), 0), cpt = ps.find(p => Math.abs(flexSum + 0.5 * (p.flexSal ?? p.sal) - l.sal) < 1) || ps[0], cp = posOf(cpt), split = Object.values(tc).sort((a, b) => b - a).join("-"); Object.assign(f, { cptQB: cp === "QB" ? 1 : 0, cptRB: cp === "RB" ? 1 : 0, cptWR: cp === "WR" ? 1 : 0, cptTE: cp === "TE" ? 1 : 0, cptOwn: (cptOwn.get(cpt.id) ?? cpt.aown ?? 0) * 100, s51: split === "5-1" ? 1 : 0, s42: split === "4-2" ? 1 : 0, s33: split === "3-3" ? 1 : 0, hasK: ps.some(p => posOf(p) === "K") ? 1 : 0, hasDST: ps.some(p => posOf(p) === "DST") ? 1 : 0 }); }
    else { const qb = ps.find(p => posOf(p) === "QB"); Object.assign(f, { stack: qb ? ps.filter(p => p !== qb && p.team === qb.team && /WR|TE|RB/.test(posOf(p))).length : 0, bring: qb && ps.some(p => p.team === qb.opp && posOf(p) !== "DST") ? 1 : 0, rbDst: ps.some(p => posOf(p) === "DST" && ps.some(q => posOf(q) === "RB" && q.team === p.team)) ? 1 : 0 }); }
    return f;
  };
  const step = Math.max(1, Math.floor(N / 150));
  j.lineups.forEach((l, i) => { const u = String(l.u).toLowerCase(); const isS = roster.has(u), isY = u === YOU; if (!isS && !isY && i % step !== 0) return; const f = feats(l); if (!f) return; if (isS || isY) { const key = u + "|" + fmt; (U[key] = U[key] || { u, fmt, rows: [], contests: new Set() }).rows.push(f); U[key].contests.add(c.key); } if (!isS && !isY) FIELD[fmt].push(f); });
  contests++;
}
const agg = rows => { const o = {}; for (const k of [...CL_F, ...SD_F, "roi", "top10", "top1", "fee"]) if (rows.some(r => r[k] != null)) o[k] = +mean(rows.filter(r => r[k] != null).map(r => r[k])).toFixed(3); const shapes = {}; for (const r of rows) { const k = `${r.tier}/${r.size}`; shapes[k] = (shapes[k] || 0) + 1; } o.shapes = Object.fromEntries(Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [k, +(100 * v / rows.length).toFixed(0)])); return o; };
const users = Object.values(U).filter(x => x.rows.length >= MIN || x.u === YOU).map(x => Object.assign({ u: x.u, fmt: x.fmt, n: x.rows.length, contests: x.contests.size }, agg(x.rows)));
// k-means per format on standardized construction features
function kmeans(items, keys, k) {
  if (items.length < k * 3) return items.map(() => 0);
  const mu = {}, sd = {}; for (const key of keys) { const v = items.map(i => i[key] ?? 0); mu[key] = mean(v); sd[key] = Math.sqrt(mean(v.map(x => (x - mu[key]) ** 2))) || 1; }
  const X = items.map(i => keys.map(key => ((i[key] ?? 0) - mu[key]) / sd[key]));
  let cent = []; const rng = (s => () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)(7);
  const used = new Set(); while (cent.length < k) { const i = Math.floor(rng() * X.length); if (!used.has(i)) { used.add(i); cent.push(X[i].slice()); } }
  let lab = new Array(X.length).fill(0);
  for (let it = 0; it < 50; it++) {
    const nl = X.map(x => { let b = 0, bd = Infinity; cent.forEach((c, ci) => { const d = x.reduce((s, v, q) => s + (v - c[q]) ** 2, 0); if (d < bd) { bd = d; b = ci; } }); return b; });
    if (nl.every((v, i) => v === lab[i])) break; lab = nl;
    cent = cent.map((c, ci) => { const m = X.filter((_, i) => lab[i] === ci); return m.length ? c.map((_, q) => mean(m.map(x => x[q]))) : c; });
  }
  return lab;
}
const out = { built: new Date().toISOString(), window: [FROM, TO], contests, roster: roster.size, minEntries: MIN, formats: {} };
for (const fmt of ["classic", "showdown"]) {
  const keys = fmt === "classic" ? CL_F : SD_F, sharps = users.filter(x => x.fmt === fmt && x.u !== YOU), you = users.find(x => x.fmt === fmt && x.u === YOU), field = agg(FIELD[fmt]);
  const lab = kmeans(sharps, keys, Math.min(K, Math.max(1, Math.floor(sharps.length / 4))));
  const clusters = []; for (let ci = 0; ci < Math.max(...lab, 0) + 1; ci++) { const m = sharps.filter((_, i) => lab[i] === ci); if (!m.length) continue; const rows = []; for (const x of m) rows.push(...Object.values(U).find(y => y.u === x.u && y.fmt === fmt).rows); clusters.push(Object.assign({ cluster: ci, users: m.length, entries: rows.length, members: m.slice().sort((a, b) => b.n - a.n).slice(0, 8).map(x => `${x.u} (${x.n}, ROI ${(100 * x.roi).toFixed(0)}%)`) }, agg(rows))); }
  clusters.sort((a, b) => b.roi - a.roi);
  out.formats[fmt] = { sharps: sharps.length, field, you, clusters };
}
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/sharps-style-nfl.json", JSON.stringify(out, null, 1));
const pc = v => v == null ? "-" : (100 * v).toFixed(0) + "%", f1 = v => v == null ? "-" : (+v).toFixed(1), f0 = v => v == null ? "-" : (+v).toFixed(0);
for (const fmt of ["classic", "showdown"]) {
  const F = out.formats[fmt], keys = fmt === "classic" ? CL_F : SD_F;
  console.log(`\n=== ${fmt}: ${F.sharps} sharps with ${MIN}+ entries, ${contests} contests ===`);
  const line = (name, o) => console.log(name.padEnd(14) + keys.map(k => (k === "own" || k === "left" || k === "cptOwn" || k === "simPct" ? f0(o[k]) : k === "chalk" || k === "stack" || k === "teams" || k === "perContest" ? f1(o[k]) : pc(o[k])).padStart(8)).join("") + `  | ROI ${pc(o.roi)} top10 ${pc(o.top10)} fee $${f0(o.fee)} | ${Object.entries(o.shapes || {}).map(([k, v]) => k + " " + v + "%").join(", ")}`);
  console.log("".padEnd(14) + keys.map(k => k.padStart(8)).join(""));
  line("field", F.field); if (F.you) line("you", F.you);
  for (const c of F.clusters) { line(`cluster ${c.cluster} (${c.users})`, c); console.log("   " + c.members.join("; ")); }
}
console.log(`\n-> data/reports/sharps-style-nfl.json`);
