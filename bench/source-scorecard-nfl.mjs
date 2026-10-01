// Which projection source tracked actual DraftKings points? For every NFL slate folder that has an
// actuals.csv (bench/actuals-nfl.mjs), Stokastic (Data Hub), ETR, Blick and the market projection
// (data/odds/nfl, newest Pinnacle snapshot before kickoff) are scored on the players every available
// source covers: correlation, rank correlation, mean absolute error, bias, and how many of the
// slate's top actual scorers each source had in its own top group. A consensus (mean of the sources)
// is scored alongside. Folders for the same date + slate code are merged (the -sd- copies).
//   node bench/source-scorecard-nfl.mjs [from] [to]   -> data/reports/source-scorecard-nfl.md and .json
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";

const FROM = process.argv[2] || "2026-09-01", TO = process.argv[3] || "2099-12-31";
const TM = { LA: "LAR", WSH: "WAS", JAC: "JAX", LVR: "LV", KCC: "KC", NOS: "NO", TBB: "TB", GBP: "GB", SFO: "SF", NEP: "NE", ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU" };
const tm = t => { const a = String(t || "").toUpperCase().replace(/^@/, "").trim(); return TM[a] || a; };
const isDst = p => /^(DST|D|DEF|D\/ST)$/i.test(String(p || "").trim());
const key = (name, team, pos) => (isDst(pos) ? "DST" : nrm(name)) + "|" + tm(team);
const num = v => { const x = parseFloat(String(v ?? "").replace(/[%$,]/g, "")); return isNaN(x) ? null : x; };

// generic projection-file reader: returns Map key -> { proj, pos, sal, name }
function readProj(file, opts = {}) {
  const all = parseCSV(fs.readFileSync(file, "utf8")), H = all[0].map(h => h.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } for (const n of names) { const i = H.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };
  const cN = col("player", "name"), cT = col("team"), cP = col("position", "pos", "roster position"), cS = col("salary", "flex $", "$"), cJ = col(...(opts.projCols || ["projection", "proj", "fpts"]));
  const m = new Map(); if (cN < 0 || cT < 0 || cJ < 0) return m;
  for (const r of all.slice(1)) { if (r.length <= cJ) continue; const proj = num(r[cJ]); if (proj == null) continue; m.set(key(r[cN], r[cT], cP >= 0 ? r[cP] : ""), { proj, pos: cP >= 0 ? String(r[cP]).toUpperCase() : "", sal: cS >= 0 ? num(r[cS]) : null, name: r[cN] }); }
  return m;
}
const stampDate = s => { const m = s.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/); return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); };
// market snapshots: [{ stamp, date, rows: Map key -> {proj,pos,start} }]
const ODDS = []; const oddsDir = "data/odds/nfl";
if (fs.existsSync(oddsDir)) for (const f of fs.readdirSync(oddsDir).filter(f => /-proj\.csv$/.test(f)).sort()) {
  const all = parseCSV(fs.readFileSync(path.join(oddsDir, f), "utf8")), H = all[0], c = n => H.indexOf(n), rows = new Map();
  for (const r of all.slice(1)) if (r.length > 6) rows.set(key(r[c("Player")], r[c("Team")], r[c("Pos")]), { proj: num(r[c("Proj")]), pos: r[c("Pos")], start: r[c("Start")], team: tm(r[c("Team")]) });
  ODDS.push({ stamp: f.slice(0, 15), date: stampDate(f), rows });
}
function marketFor(teams, date) {
  // newest snapshot pulled before the slate's first kickoff that covers its teams, and whose games
  // for those teams are the slate's games (kickoff on the slate date or the next UTC day)
  let best = null;
  const lo = new Date(date + "T00:00:00"), hi = new Date(new Date(lo).setDate(lo.getDate() + 2));
  for (const o of ODDS) {
    const rows = [...o.rows.values()].filter(r => teams.has(r.team)); if (!rows.length) continue;
    const covered = new Set(rows.map(r => r.team)); if (covered.size < teams.size * 0.8) continue;
    const starts = rows.map(r => new Date(r.start)), kick = new Date(Math.min(...starts));
    if (kick < lo || kick > hi || o.date > kick) continue;
    best = o;
  }
  if (!best) return null;
  const m = new Map(); for (const [k, r] of best.rows) if (teams.has(r.team)) m.set(k, r); return { stamp: best.stamp, m };
}

// group slate folders by date + slate code
const groups = {};
for (const d of fs.readdirSync("data").filter(d => /^\d{4}-\d{2}-\d{2}-nfl-/.test(d) && !/-post$/.test(d)).sort()) {
  const date = d.slice(0, 10); if (date < FROM || date > TO) continue;
  const files = fs.readdirSync(path.join("data", d)), hub = files.find(f => /^DK_NFL_.*_Data_Hub_Projections\.csv$/i.test(f));
  const code = hub ? hub.match(/^DK_NFL_(.*?)_Data_Hub/i)[1] : (files.map(f => (f.match(/showdown-([A-Za-z]+)/i) || [])[1]).find(Boolean) || (/main/.test(d) ? "Main" : null));
  if (!code) continue;
  const g = groups[date + "|" + code.toUpperCase()] = groups[date + "|" + code.toUpperCase()] || { date, code, dirs: [], files: [] };
  g.dirs.push(d); g.files.push(...files.map(f => path.join("data", d, f)));
}
const pearson = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN; };
const ranks = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const rk = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = rk; i = j + 1; } return r; };
const spearman = (x, y) => pearson(ranks(x), ranks(y));
const f2 = x => isNaN(x) || x == null ? "-" : x.toFixed(2), f1 = x => isNaN(x) || x == null ? "-" : x.toFixed(1);

const slates = [], pooled = {}, byPos = {};
for (const g of Object.values(groups).sort((a, b) => a.date.localeCompare(b.date))) {
  const actF = g.files.find(f => /actuals\.csv$/.test(f)), hubF = g.files.find(f => /_Data_Hub_Projections\.csv$/i.test(f));
  if (!actF || !hubF) { slates.push({ date: g.date, code: g.code, note: !actF ? "no actuals.csv (run bench/actuals-nfl.mjs)" : "no Data Hub file" }); continue; }
  const act = readProj(actF, { projCols: ["actual"] }), hub = readProj(hubF);
  const etrF = g.files.find(f => /[\\/]ETR[^\\/]*\.csv$/i.test(f)) || (g.code.toUpperCase() === "MAIN" && fs.existsSync(`data/etr/${g.date}-nfl-main-dk.csv`) ? `data/etr/${g.date}-nfl-main-dk.csv` : null);
  const blickF = g.files.find(f => /[\\/]nfl-[^\\/]*\.csv$/i.test(f));
  const src = { stokastic: hub };
  if (etrF) src.etr = readProj(etrF, { projCols: ["projection", "proj"] });
  if (blickF) { const b = readProj(blickF, { projCols: ["proj"] }); if ([...b.values()].some(v => v.proj > 0)) src.blick = b; }
  const teams = new Set([...hub.values()].map(() => null)); teams.clear(); for (const k of hub.keys()) teams.add(k.split("|")[1]);
  const mk = marketFor(teams, g.date); if (mk) src.market = mk.m;
  // universe: scored players (final games) with a real salary, main positions
  const finalCol = (() => { const all = parseCSV(fs.readFileSync(actF, "utf8")), H = all[0].map(h => h.trim().toLowerCase()), cF = H.indexOf("final"), cN = H.indexOf("player"), cT = H.indexOf("team"), cP = H.indexOf("position"); const s = new Set(); for (const r of all.slice(1)) if (cF < 0 || r[cF] === "1") s.add(key(r[cN], r[cT], r[cP])); return s; })();
  const uni = [...act.keys()].filter(k => finalCol.has(k) && hub.has(k) && (hub.get(k).sal ?? 0) >= 3000 && /^(QB|RB|WR|TE|K|DST|D|DEF)$/.test(hub.get(k).pos.split("/")[0]));
  const names = Object.keys(src).filter(s => uni.filter(k => src[s].has(k)).length >= 0.3 * uni.length);
  const common = uni.filter(k => names.every(s => src[s].has(k)));
  const K = teams.size >= 8 ? 12 : 6, topAct = new Set(common.slice().sort((a, b) => act.get(b).proj - act.get(a).proj).slice(0, K));
  const row = { date: g.date, code: g.code, games: teams.size / 2, universe: uni.length, n: common.length, sources: {}, files: { etr: etrF ? path.basename(etrF) : null, blick: blickF ? path.basename(blickF) : null, market: mk ? mk.stamp : null }, dropped: Object.keys(src).filter(s => !names.includes(s)) };
  const score = (name, projOf) => {
    const x = common.map(projOf), y = common.map(k => act.get(k).proj);
    const top = new Set(common.slice().sort((a, b) => projOf(b) - projOf(a)).slice(0, K));
    const r = { n: x.length, r: pearson(x, y), rho: spearman(x, y), mae: x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0) / x.length, bias: y.reduce((s, v, i) => s + v - x[i], 0) / x.length, hits: [...top].filter(k => topAct.has(k)).length, K };
    row.sources[name] = r;
    const p = pooled[name] = pooled[name] || { x: [], y: [], rho: [], hits: 0, K: 0, slates: 0 }; p.x.push(...x); p.y.push(...y); p.rho.push([r.rho, x.length]); p.hits += r.hits; p.K += K; p.slates++;
    common.forEach((k, i) => { const pos = isDst(hub.get(k).pos) ? "DST" : hub.get(k).pos.split("/")[0]; const b = byPos[pos] = byPos[pos] || {}; const q = b[name] = b[name] || { x: [], y: [] }; q.x.push(x[i]); q.y.push(y[i]); });
  };
  for (const s of names) score(s, k => src[s].get(k).proj);
  if (names.length > 1) score("consensus", k => names.reduce((a, s) => a + src[s].get(k).proj, 0) / names.length);
  slates.push(row);
}
const md = [`# NFL projection source scorecard (${FROM}..${TO})`, "", `Built ${new Date().toISOString().slice(0, 16)}Z. Players scored: every source present on that slate covers them, salary >= $3,000, game final. hits = how many of the slate's top-${"K"} actual scorers (12 classic, 6 showdown) sat in the source's own top group. bias = actual minus projected.`, ""];
const line = (name, r) => `| ${name} | ${r.n} | ${f2(r.r)} | ${f2(r.rho)} | ${f1(r.mae)} | ${f1(r.bias)} | ${r.hits}/${r.K} |`;
md.push("## Pooled", "", "| source | n | r | rho | MAE | bias | top hits |", "|---|---|---|---|---|---|---|");
for (const [name, p] of Object.entries(pooled)) { const w = p.rho.reduce((s, [, n]) => s + n, 0); md.push(line(`${name} (${p.slates} slates)`, { n: p.x.length, r: pearson(p.x, p.y), rho: p.rho.reduce((s, [r, n]) => s + (isNaN(r) ? 0 : r * n), 0) / w, mae: p.x.reduce((s, v, i) => s + Math.abs(v - p.y[i]), 0) / p.x.length, bias: p.y.reduce((s, v, i) => s + v - p.x[i], 0) / p.x.length, hits: p.hits, K: p.K })); }
md.push("", "## By position (pooled r / MAE)", "", "| pos | " + Object.keys(pooled).join(" | ") + " |", "|---|" + Object.keys(pooled).map(() => "---|").join(""));
for (const [pos, b] of Object.entries(byPos).sort()) md.push(`| ${pos} (${Object.values(b)[0].x.length}) | ` + Object.keys(pooled).map(s => b[s] ? `${f2(pearson(b[s].x, b[s].y))} / ${f1(b[s].x.reduce((t, v, i) => t + Math.abs(v - b[s].y[i]), 0) / b[s].x.length)}` : "-").join(" | ") + " |");
md.push("", "## Per slate", "");
for (const s of slates) {
  if (s.note) { md.push(`### ${s.date} ${s.code}: ${s.note}`, ""); continue; }
  md.push(`### ${s.date} ${s.code} (${s.games} games, ${s.n} of ${s.universe} players scored${s.dropped.length ? "; dropped for low coverage: " + s.dropped.join(", ") : ""})`, "", `files: ETR ${s.files.etr || "-"}, Blick ${s.files.blick || "-"}, market ${s.files.market || "-"}`, "", "| source | n | r | rho | MAE | bias | top hits |", "|---|---|---|---|---|---|---|");
  for (const [name, r] of Object.entries(s.sources)) md.push(line(name, r));
  md.push("");
}
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/source-scorecard-nfl.md", md.join("\n") + "\n");
// byPos feeds the Lab blend (server/sources.mjs): weights per position are 1/MAE^2 of each source
const byPosOut = {}; for (const [pos, b] of Object.entries(byPos)) { byPosOut[pos] = {}; for (const [s, q] of Object.entries(b)) byPosOut[pos][s] = { n: q.x.length, r: +pearson(q.x, q.y).toFixed(3), mae: +(q.x.reduce((t, v, i) => t + Math.abs(v - q.y[i]), 0) / q.x.length).toFixed(3) }; }
fs.writeFileSync("data/reports/source-scorecard-nfl.json", JSON.stringify({ built: new Date().toISOString(), slates, byPos: byPosOut }, null, 1));
console.log(md.slice(0, md.indexOf("## Per slate")).join("\n"));
console.log(`\n${slates.filter(s => !s.note).length} slates scored, ${slates.filter(s => s.note).length} skipped -> data/reports/source-scorecard-nfl.md`);
