// Data Hub sources for one NFL slate folder: pull Stokastic into it, pull ESPN injuries, and merge
// everything on disk (Stokastic, ETR, Blick, Pinnacle market, injuries) into one table per player
// plus one row per game. Everything here reads/writes the same files the bench scripts use, so the
// scorecard, vendor-index and the old app keep working unchanged.
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { stkGet, stkToCSV } from "../src/engine/stokastic.mjs";

const TM = { LA: "LAR", WSH: "WAS", JAC: "JAX", LVR: "LV", KCC: "KC", NOS: "NO", TBB: "TB", GBP: "GB", SFO: "SF", NEP: "NE" };
export const tm = t => { const a = String(t || "").toUpperCase().replace(/^@/, "").trim(); return TM[a] || a; };
const isDst = p => /^(DST|D|DEF|D\/ST)$/i.test(String(p || "").trim());
const key = (name, team, pos) => (isDst(pos) ? "DST" : nrm(name)) + "|" + tm(team);
const num = v => { const x = parseFloat(String(v ?? "").replace(/[%$,]/g, "")); return isNaN(x) ? null : x; };
const local = d => new Date(d).toLocaleString("sv-SE").slice(0, 16);
const utc = d => typeof d === "string" && !/Z|[+-]\d\d:\d\d$/.test(d) ? d + "Z" : d;
const hhmm = d => new Date(utc(d)).toLocaleString("sv-SE").slice(11, 16).replace(":", "");

function readTable(file) {
  const all = parseCSV(fs.readFileSync(file, "utf8")), H = all[0].map(h => String(h).trim()), h = H.map(x => x.toLowerCase());
  const col = (...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } for (const n of names) { const i = h.findIndex(x => x.includes(n)); if (i >= 0) return i; } return -1; };
  return { H, h, rows: all.slice(1).filter(r => r.length > 2), col, file, mtime: fs.statSync(file).mtime.toISOString() };
}
// slate folders that hold a Stokastic file or slate.json (the -sd- build copies and ETR-only folders are skipped)
export const slateDirs = () => fs.readdirSync("data").filter(d => /^\d{4}-\d{2}-\d{2}-nfl-/.test(d) && !/-post$/.test(d) && (fs.existsSync(path.join("data", d, "slate.json")) || fs.readdirSync(path.join("data", d)).some(f => /_Data_Hub_Projections\.csv$/i.test(f)))).sort().reverse();
export function slateMeta(d) {
  const dir = path.join("data", d), meta = path.join(dir, "slate.json");
  const m = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, "utf8")) : {};
  const hub = fs.readdirSync(dir).find(f => /^DK_NFL_.*_Data_Hub_Projections\.csv$/i.test(f));
  return { dir: d, date: d.slice(0, 10), code: hub ? hub.match(/^DK_NFL_(.*?)_Data_Hub/i)[1] : d.slice(15), name: m.name || null, type: m.type || (/-main$/.test(d) ? "CLASSIC" : "SHOWDOWN"), games: m.games || [], start: m.start || null, slateId: m.slateId || null };
}

// Stokastic projections + ownership for a slate id into the slate folder (same layout as bench/pull-projections.mjs)
export async function pullStokastic(date, slateId, sport = "NFL") {
  const info = await stkGet("contests/getPreContestSlateInfo?app=DATAHUB");
  const slate = info.find(s => String(s.slateId) === String(slateId)); if (!slate) throw new Error(`Stokastic has no slate ${slateId}`);
  const slateName = slate.type === "SHOWDOWN" ? slate.name.replace(/\W+/g, "") : slate.name;
  const dir = path.join("data", `${date}-${sport.toLowerCase()}-${slateName.toLowerCase()}`), latest = path.join(dir, `DK_${sport.toUpperCase()}_${slateName}_Data_Hub_Projections.csv`), snapDir = path.join(dir, "snapshots"), meta = path.join(dir, "slate.json"), logFile = path.join(dir, "pulls.log");
  fs.mkdirSync(snapDir, { recursive: true });
  const now = new Date(), upd = await stkGet(`slatedata/slateUpdateInfo?slateId=${slate.slateId}`);
  const prev = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, "utf8")) : {};
  const changed = upd.projectionsLastUpdated !== prev.projectionsUpdated || upd.ownershipLastUpdated !== prev.ownershipUpdated || !fs.existsSync(latest);
  const proj = await stkGet(`slatedata/projections?SlateId=${slate.slateId}`), csv = stkToCSV(proj, sport);
  if (changed) fs.writeFileSync(path.join(snapDir, `${hhmm(now)}_proj${hhmm(upd.projectionsLastUpdated)}_own${hhmm(upd.ownershipLastUpdated)}.csv`), csv);
  fs.writeFileSync(latest, csv);
  fs.writeFileSync(meta, JSON.stringify({ slateId: slate.slateId, name: slate.name, type: slate.type, start: slate.startTime, games: (slate.matchupInfo || []).map(m => m.awayTeamAbbrev + "@" + m.homeTeamAbbrev), projectionsUpdated: upd.projectionsLastUpdated, ownershipUpdated: upd.ownershipLastUpdated, pulledAt: now.toISOString(), snapshots: fs.readdirSync(snapDir).length }, null, 2));
  fs.appendFileSync(logFile, `${local(now)} hub refresh  proj ${local(utc(upd.projectionsLastUpdated))}  own ${local(utc(upd.ownershipLastUpdated))}  ${changed ? "SAVED" : "no change"}  ${proj.filter(p => p.projection > 0).length} projected\n`);
  return { dir: path.basename(dir), file: path.basename(latest), changed, projUpdated: upd.projectionsLastUpdated, ownUpdated: upd.ownershipLastUpdated, rows: proj.length, projected: proj.filter(p => p.projection > 0).length };
}

// ESPN injury report, all teams -> data/nfl-ref/injuries.json
export async function pullInjuries() {
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"); if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const j = await r.json(), rows = [];
  for (const t of j.injuries || []) for (const i of t.injuries || []) rows.push({ name: i.athlete?.displayName, team: tm(i.athlete?.team?.abbreviation), pos: i.athlete?.position?.abbreviation, status: i.status, date: i.date, note: i.shortComment || "" });
  fs.mkdirSync("data/nfl-ref", { recursive: true });
  const out = { at: new Date().toISOString(), rows };
  fs.writeFileSync("data/nfl-ref/injuries.json", JSON.stringify(out));
  return { n: rows.length, notActive: rows.filter(x => x.status !== "Active").length };
}

// newest Pinnacle snapshot whose games for these teams fall on the slate date (or the next day), plus the oldest such snapshot for line movement
function marketFor(teams, date) {
  const dir = "data/odds/nfl"; if (!fs.existsSync(dir)) return null;
  const lo = new Date(date + "T00:00:00"), hi = new Date(new Date(lo).setDate(lo.getDate() + 2));
  const snaps = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(f)).sort();
  const fits = [];
  for (const f of snaps) {
    const snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const games = snap.games.filter(g => teams.has(g.home) || teams.has(g.away)); if (!games.length) continue;
    const kicks = games.map(g => new Date(g.start)), kick = new Date(Math.min(...kicks)), last = new Date(Math.max(...kicks));
    if (last < lo || kick > hi) continue;
    fits.push({ stamp: f.slice(0, 15), pulledAt: snap.pulledAt, games });
  }
  if (!fits.length) return null;
  const cur = fits[fits.length - 1], first = fits[0], projFile = path.join(dir, cur.stamp + "-proj.csv");
  const rows = new Map();
  if (fs.existsSync(projFile)) { const t = readTable(projFile); const cN = t.col("player"), cT = t.col("team"), cP = t.col("pos"), cJ = t.col("proj"), cL = t.col("lines"); for (const r of t.rows) if (teams.has(tm(r[cT]))) rows.set(key(r[cN], r[cT], r[cP]), { proj: num(r[cJ]), lines: r[cL] || "", pos: r[cP], name: r[cN] }); }
  return { stamp: cur.stamp, pulledAt: cur.pulledAt, games: cur.games, firstStamp: first.stamp, firstGames: first.games, rows, snapshots: fits.length };
}

export function hubData(d) {
  const dir = path.join("data", d); if (!fs.existsSync(dir)) throw new Error(`no folder ${d}`);
  const meta = slateMeta(d), files = fs.readdirSync(dir), sources = {}, P = new Map();
  const get = (k, base) => { let r = P.get(k); if (!r) { r = Object.assign({ key: k, name: "", pos: "", team: "", opp: "", sal: null, stk: null, etr: null, blick: null, mkt: null, inj: null }, base); P.set(k, r); } return r; };
  const fill = (r, base) => { for (const k of ["name", "pos", "team", "opp", "sal"]) if ((r[k] == null || r[k] === "") && base[k] != null && base[k] !== "") r[k] = base[k]; };
  // Stokastic Data Hub
  const hubF = files.find(f => /^DK_NFL_.*_Data_Hub_Projections\.csv$/i.test(f));
  if (hubF) {
    const t = readTable(path.join(dir, hubF)), c = { n: t.col("player"), s: t.col("salary"), p: t.col("position"), tmc: t.col("team"), o: t.col("opponent"), j: t.col("projection"), own: t.col("ownership %"), cpt: t.col("cpt ownership %"), sd: t.col("std dev"), tt: t.col("team total"), inj: t.col("injury"), id: t.col("dk id"), cid: t.col("cpt dk id") };
    const slateJ = fs.existsSync(path.join(dir, "slate.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "slate.json"), "utf8")) : {};
    let n = 0;
    for (const r of t.rows) { const base = { name: r[c.n], pos: String(r[c.p] || "").toUpperCase(), team: tm(r[c.tmc]), opp: tm(r[c.o]), sal: num(r[c.s]) }; const x = get(key(r[c.n], r[c.tmc], r[c.p]), base); fill(x, base); x.stk = { proj: num(r[c.j]), own: num(r[c.own]), cptOwn: c.cpt >= 0 ? num(r[c.cpt]) : null, sd: num(r[c.sd]), tt: num(r[c.tt]), inj: c.inj >= 0 ? r[c.inj] : "", dkId: c.id >= 0 ? String(r[c.id] || "") : "", cptDkId: c.cid >= 0 ? String(r[c.cid] || "") : "" }; n++; }
    sources.stokastic = { file: hubF, mtime: t.mtime, rows: n, projUpdated: slateJ.projectionsUpdated ? utc(slateJ.projectionsUpdated) : null, ownUpdated: slateJ.ownershipUpdated ? utc(slateJ.ownershipUpdated) : null, pulledAt: slateJ.pulledAt || null };
  }
  const teams = new Set([...P.values()].map(r => r.team).filter(Boolean));
  for (const g of meta.games) for (const t of g.split("@")) teams.add(tm(t));
  // ETR (main or showdown layout)
  const etrF = files.find(f => /^ETR.*\.csv$/i.test(f)) || (meta.type === "CLASSIC" && fs.existsSync(`data/etr/${meta.date}-nfl-main-dk.csv`) ? `../etr/${meta.date}-nfl-main-dk.csv` : null);
  if (etrF) {
    const t = readTable(path.join(dir, etrF)), sd = t.h.includes("cpt own");
    const c = { n: t.col("player"), tmc: t.col("team"), p: t.col("position", "pos"), s: t.col("salary"), j: sd ? t.col("proj") : t.col("projection"), own: sd ? t.col("total own") : t.col("largeownership"), small: t.col("smallownership"), cpt: t.col("cpt own"), fl: t.col("floor"), ce: t.col("ceiling") };
    let n = 0;
    // ETR showdown "Total Own" is captain + flex combined (sums to ~600%); Stokastic and Blick report flex alone (~500%), so split it the same way
    for (const r of t.rows) { const base = { name: r[c.n], pos: String(r[c.p] || "").toUpperCase(), team: tm(r[c.tmc]), sal: c.s >= 0 ? num(r[c.s]) : null }; const x = get(key(r[c.n], r[c.tmc], r[c.p]), base); fill(x, base); const total = num(r[c.own]), cpt = c.cpt >= 0 ? num(r[c.cpt]) : null; x.etr = { proj: num(r[c.j]), own: sd && total != null && cpt != null ? +Math.max(0, total - cpt).toFixed(1) : total, ownTotal: sd ? total : null, ownSmall: c.small >= 0 ? num(r[c.small]) : null, cptOwn: cpt, floor: c.fl >= 0 ? num(r[c.fl]) : null, ceil: c.ce >= 0 ? num(r[c.ce]) : null }; n++; }
    sources.etr = { file: path.basename(etrF), mtime: t.mtime, rows: n };
  }
  // Blick (main or showdown layout)
  const blickF = files.find(f => /^nfl-.*\.csv$/i.test(f));
  if (blickF) {
    const t = readTable(path.join(dir, blickF)), sd = t.h.includes("flex own %");
    const c = { n: t.col("player"), tmc: t.col("team"), p: t.col("pos"), s: sd ? t.col("flex $") : t.col("$"), j: t.col("proj"), own: sd ? t.col("flex own %") : t.col("own mme %"), se: t.col("own se %"), hs: t.col("own hs %"), cpt: t.col("cpt own %"), gpp: sd ? t.col("flex gpp score") : t.col("gpp score"), ce: t.col("ceiling"), sce: t.col("super ceiling") };
    let n = 0;
    for (const r of t.rows) { const proj = num(r[c.j]); const base = { name: r[c.n], pos: String(r[c.p] || "").toUpperCase(), team: tm(r[c.tmc]), sal: c.s >= 0 ? num(r[c.s]) : null }; const x = get(key(r[c.n], r[c.tmc], r[c.p]), base); fill(x, base); x.blick = { proj, own: num(r[c.own]), ownSE: c.se >= 0 ? num(r[c.se]) : null, ownHS: c.hs >= 0 ? num(r[c.hs]) : null, cptOwn: c.cpt >= 0 ? num(r[c.cpt]) : null, gpp: num(r[c.gpp]), ceil: num(r[c.ce]), superCeil: c.sce >= 0 ? num(r[c.sce]) : null }; if (proj > 0) n++; }
    sources.blick = { file: blickF, mtime: t.mtime, rows: n, stale: n === 0 };
  }
  // Pinnacle market
  const mk = marketFor(teams, meta.date);
  if (mk) {
    for (const [k, v] of mk.rows) {
      if (v.pos === "K" && meta.type === "CLASSIC" && !P.has(k)) continue;   // no kicker slot in DK classic
      const team = k.split("|")[1], x = get(k, { name: v.name, pos: v.pos, team }); if (!x.name) x.name = v.name; x.mkt = { proj: v.proj, lines: v.lines };
    }
    sources.market = { stamp: mk.stamp, pulledAt: mk.pulledAt, rows: mk.rows.size, snapshots: mk.snapshots, firstStamp: mk.firstStamp };
  }
  // injuries
  if (fs.existsSync("data/nfl-ref/injuries.json")) {
    const inj = JSON.parse(fs.readFileSync("data/nfl-ref/injuries.json", "utf8")), byKey = new Map(inj.rows.map(r => [nrm(r.name) + "|" + r.team, r]));
    let n = 0; for (const x of P.values()) { const r = byKey.get(x.key); if (r && r.status !== "Active") { x.inj = { status: r.status, note: r.note, date: r.date }; n++; } }
    sources.injuries = { at: inj.at, flagged: n };
  }
  // Lab blend: per-position weights 1/MAE^2 from the scorecard (data/reports/source-scorecard-nfl.json byPos); equal weights until it exists
  const W = (() => { try { const bp = JSON.parse(fs.readFileSync("data/reports/source-scorecard-nfl.json", "utf8")).byPos || {}; const m = {}; for (const [pos, b] of Object.entries(bp)) { m[pos] = {}; for (const [s, q] of Object.entries(b)) if (q.mae > 0 && q.n >= 30) m[pos][{ stokastic: "stk", etr: "etr", blick: "blick", market: "mkt" }[s] || s] = 1 / (q.mae * q.mae); } return m; } catch { return {}; } })();
  // consensus and flags
  const rows = [];
  for (const x of P.values()) {
    const srcs = [["stk", x.stk], ["etr", x.etr], ["blick", x.blick], ["mkt", x.mkt]].filter(([, v]) => v && v.proj != null);
    const vendors = srcs.filter(([k]) => k !== "mkt").map(([, v]) => v.proj);
    x.cons = srcs.length ? +(srcs.reduce((s, [, v]) => s + v.proj, 0) / srcs.length).toFixed(2) : null;
    const w = W[isDst(x.pos) ? "DST" : x.pos.split("/")[0]] || {}; let ws = 0, wp = 0; for (const [k, v] of srcs) { const wk = w[k] || (Object.keys(w).length ? 0.5 * Math.min(...Object.values(w)) : 1); ws += wk; wp += wk * v.proj; }
    x.lab = ws ? +(wp / ws).toFixed(2) : null;
    x.nSrc = srcs.length;
    x.spread = srcs.length > 1 ? +(Math.max(...srcs.map(([, v]) => v.proj)) - Math.min(...srcs.map(([, v]) => v.proj))).toFixed(1) : null;
    x.mktGap = x.mkt && vendors.length ? +(x.mkt.proj - vendors.reduce((a, b) => a + b, 0) / vendors.length).toFixed(1) : null;
    x.own = x.stk?.own ?? x.etr?.own ?? x.blick?.own ?? null;
    x.value = x.cons != null && x.sal ? +(1000 * x.cons / x.sal).toFixed(2) : null;
    rows.push(x);
  }
  rows.sort((a, b) => (b.cons ?? -1) - (a.cons ?? -1));
  // games: slate games with Stokastic team totals and Pinnacle lines + movement since the first snapshot
  const stkTT = {}; for (const x of P.values()) if (x.stk && x.stk.tt > 0) stkTT[x.team] = Math.max(stkTT[x.team] || 0, x.stk.tt);
  const gameList = meta.games.length ? meta.games.map(g => { const [a, h] = g.split("@").map(tm); return { away: a, home: h }; }) : (mk ? mk.games.map(g => ({ away: g.away, home: g.home })) : []);
  const games = gameList.map(g => {
    const cur = mk && mk.games.find(x => x.home === g.home && x.away === g.away), first = mk && mk.firstGames.find(x => x.home === g.home && x.away === g.away);
    const mv = (k) => cur && first && cur[k] != null && first[k] != null ? +(cur[k] - first[k]).toFixed(1) : null;
    return { game: `${g.away}@${g.home}`, away: g.away, home: g.home, start: cur ? cur.start : null, spread: cur ? cur.spread : null, total: cur ? cur.total : null, ttAway: cur ? cur.ttAway : null, ttHome: cur ? cur.ttHome : null, mlHome: cur ? cur.mlHome : null, mlAway: cur ? cur.mlAway : null, dSpread: mv("spread"), dTotal: mv("total"), dTTAway: mv("ttAway"), dTTHome: mv("ttHome"), stkAway: stkTT[g.away] ?? null, stkHome: stkTT[g.home] ?? null };
  });
  return { dir: d, slate: meta, sources, rows, games, builtAt: new Date().toISOString() };
}
