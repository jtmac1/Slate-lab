// Scores the Lab likes (server/likes.mjs) after a slate (user-asked 2026-10-07). For every pick and fade:
//   pts = actual DK points - the Lab projection the pick was made on   (data/<slate>/actuals-dk.csv or actuals.csv)
//   own = actual ownership - projected ownership                      (the day's stored contests on the slate, data/post/nfl)
//   roi = the player's actual ROI in those contests                    (captain rows for showdown captain picks)
// Each is compared with the slate baseline: every player in the same group (classic position; showdown captain pool or
// $6K-and-under flex) owned 0.5%+ in those contests. Running record by position and for fades in
// data/reports/likes-tracker-nfl.json. A likes run made after the slate started is flagged "backfill".
// stacks key: the Lab stacks (server/stacks.mjs) - each recommended stack's actual points, how often the real field played
// it, and the real lineups' ROI with it vs all lineups; whether the recommended bring-back outscored the alternatives.
// blickCond key: Blick's conditional (combo) ownership vs the real contest's combo ownership, next to our generated field's.
//   node bench/likes-tracker-nfl.mjs data/<slate> [more slate dirs...]   (no args: just print the running table)
import fs from "node:fs";
import path from "node:path";
import { parseCSV, nrm } from "../src/engine/csv.mjs";
import { listPost, readPost } from "./post-store.mjs";
import { loadBlickCond, parseBlickCond } from "../server/blickcond.mjs";
import { fieldFreq } from "../server/stacks.mjs";

const OUT = "data/reports/likes-tracker-nfl.json";
const ab = t => { t = String(t || "").toUpperCase().replace(/^@/, ""); return t === "LA" ? "LAR" : t === "WSH" ? "WAS" : t; };
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

function scoreSlate(dir) {
  const slug = path.basename(dir), meta = readJ(path.join(dir, "slate.json")) || {}, date = meta.date || slug.slice(0, 10), sd = meta.type === "SHOWDOWN";
  const likes = (readJ(path.join(dir, "slate-guide.json")) || {}).likes || readJ(path.join(dir, "likes.json"));
  if (!likes || !likes.picks) return { slate: slug, date, skipped: "no Lab likes saved for this slate" };
  const start = meta.start ? Date.parse(meta.start + (/[zZ]|[+-]\d\d:?\d\d$/.test(meta.start) ? "" : "-04:00")) : Date.parse(date + "T13:00:00-04:00");
  const backfill = Date.parse(likes.generatedAt) > start;
  const teams = new Set((meta.games || []).flatMap(g => String(g).split("@").map(ab)));
  // positions, salaries (projections file) and actual points
  const pos = new Map(), sal = new Map(), act = new Map();
  for (const f of fs.readdirSync(dir).filter(f => /Projections\.csv$/i.test(f))) { const P = parseCSV(fs.readFileSync(path.join(dir, f), "utf8")), h = P[0].map(x => x.trim()); for (const r of P.slice(1)) if (r[h.indexOf("Player")]) { const k = nrm(r[h.indexOf("Player")]); pos.set(k, String(r[h.indexOf("Position")] || "").toUpperCase().split("/")[0]); sal.set(k, +r[h.indexOf("Salary")]); } }
  for (const f of ["actuals-dk.csv", "actuals.csv"]) { const p = path.join(dir, f); if (!fs.existsSync(p)) continue; const A = parseCSV(fs.readFileSync(p, "utf8")), h = A[0]; for (const r of A.slice(1)) { const k = nrm(r[h.indexOf("Player")]); if (!act.has(k) && r[h.indexOf("Actual")] !== "") act.set(k, +r[h.indexOf("Actual")]); } }
  // the day's stored contests on this slate, per player (flex and captain separately for showdown)
  const agg = new Map(); let contests = 0; const real = [];   // real lineups as name sets (+ captain), per contest
  for (const f of listPost("nfl").filter(x => path.basename(x).startsWith(date))) {
    const j = readPost(f); if (/showdown/i.test(j.contest.type + " " + j.contest.name) !== sd) continue;
    const ct = new Set(j.players.map(p => ab(p.team)).filter(Boolean)); if (ct.size !== teams.size || [...ct].some(t => !teams.has(t))) continue;
    contests++;
    const byId = new Map(j.players.map(p => [String(p.id), p])); real.push({ entries: j.contest.entries, fee: j.contest.fee, key: j.contest.key, lus: (j.lineups || []).map(l => { const ps = l.ids.map(i => byId.get(String(i))).filter(Boolean); const c = sd ? ps.find(p => p.pos === "CPT") : null; return { set: new Set(ps.map(p => nrm(p.name))), cpt: c ? nrm(c.name) : null, roi: l.aroi }; }) });
    for (const p of j.players) { const cpt = sd && p.pos === "CPT", k = (cpt ? "cpt|" : "") + nrm(p.name), a = agg.get(k) || { roi: [], aown: [], pown: [] }; if (p.aroi != null) a.roi.push(p.aroi); if (p.aown != null) a.aown.push(p.aown); if (p.pown != null) a.pown.push(p.pown); agg.set(k, a); }
  }
  if (!contests && !act.size) return { slate: slug, date, skipped: "no stored contests or actual points for this slate yet" };
  const outOf = (name, proj, cpt) => { const k = nrm(name), a = agg.get((cpt ? "cpt|" : "") + k) || { roi: [], aown: [], pown: [] }, ac = act.has(k) ? act.get(k) * (cpt ? 1.5 : 1) : null;
    return { pts: ac != null && proj != null ? r2(ac - proj * (cpt ? 1.5 : 1)) : null, own: a.aown.length ? r2((mean(a.aown) - mean(a.pown)) * 100) : null, roi: a.roi.length ? r2(mean(a.roi)) : null }; };
  // baseline group per pick group
  const groupOf = g => [...new Set([...agg.keys()].filter(k => g === "CPT" ? k.startsWith("cpt|") : !k.startsWith("cpt|")).map(k => k.replace(/^cpt\|/, "")))].filter(k => {
    const a = agg.get((g === "CPT" ? "cpt|" : "") + k); if (!a || !(mean(a.pown) * 100 >= 0.5)) return false;
    if (g === "CPT") return true; if (g === "FLEX") return (sal.get(k) || 0) <= 6000; return pos.get(k) === (g === "DST" ? "DST" : g); });
  // baseline points use the Stokastic projection in the contests (the Lab projection isn't stored for every player)
  const projBy = new Map(); for (const f of fs.readdirSync(dir).filter(f => /Projections\.csv$/i.test(f))) { const P = parseCSV(fs.readFileSync(path.join(dir, f), "utf8")), h = P[0].map(x => x.trim()); for (const r of P.slice(1)) if (r[h.indexOf("Player")]) projBy.set(nrm(r[h.indexOf("Player")]), +r[h.indexOf("Projection")]); }
  const base = g => { const ks = groupOf(g), o = ks.map(k => outOf(k, projBy.get(k), g === "CPT")); const m = f => r2(mean(o.map(x => x[f]).filter(v => v != null))); return { n: ks.length, pts: m("pts"), own: m("own"), roi: m("roi") }; };
  const groups = {};
  for (const [g, l] of Object.entries(likes.picks)) { const b = base(g); const picks = l.map(p => ({ name: p.name, proj: p.proj, ...outOf(p.name, p.proj, g === "CPT") })); groups[g] = { base: b, picks }; }
  const fades = (likes.fades || []).map(p => ({ name: p.name, pos: p.pos, proj: p.proj, ...outOf(p.name, p.proj, sd) }));
  const stacks = scoreStacks(dir, sd, real, act), blickCond = scoreBlick(dir, sd, real, date);
  return { slate: slug, date, format: sd ? "showdown" : "classic", backfill, generatedAt: likes.generatedAt, inputs: likes.inputs, contests, actuals: act.size, groups, fades, stacks, blickCond };
}

// share (%) of real lineups (all of the day's slate contests pooled) containing every name, and their mean ROI
function realCombo(real, names, cpt) {
  let n = 0, tot = 0, roi = 0, roiAll = 0, nAll = 0; const ks = names.map(nrm);
  for (const c of real) for (const l of c.lus) { tot++; if (l.roi != null) { roiAll += l.roi; nAll++; } if ((cpt ? l.cpt === nrm(cpt) : true) && ks.every(k => l.set.has(k))) { n++; if (l.roi != null) roi += l.roi; } }
  return { pct: tot ? r2(100 * n / tot) : null, n, roi: n ? r2(roi / n) : null, fieldRoi: nAll ? r2(roiAll / nAll) : null };
}
function scoreStacks(dir, sd, real, act) {
  const st = (readJ(path.join(dir, "slate-guide.json")) || {}).labStacks || readJ(path.join(dir, "lab-stacks.json"));
  if (!st) return null;
  const pts = names => { const v = names.map(n => act.get(nrm(n))); return v.every(x => x != null) ? r2(v.reduce((a, b) => a + b, 0)) : null; };
  if (st.format === "showdown") return { generatedAt: st.generatedAt, pairs: (st.pairs || []).map(p => ({ cpt: p.cpt, with: p.with, ...realCombo(real, [p.cpt, p.with], p.cpt), ptsCpt: act.has(nrm(p.cpt)) ? r2(1.5 * act.get(nrm(p.cpt))) : null, ptsWith: act.has(nrm(p.with)) ? act.get(nrm(p.with)) : null })) };
  const top = (st.top || []).map(x => { const names = [x.qb, ...x.catchers], bb = x.bringBack ? x.bringBack.name : null; return { qb: x.qb, catchers: x.catchers, bringBack: bb, pts: pts(names), ptsWithBB: bb ? pts([...names, bb]) : null, real: realCombo(real, names), realWithBB: bb ? realCombo(real, [...names, bb]) : null }; });
  const byQB = (st.byQB || []).map(b => { const opts = (b.options || []).map(o => ({ name: o.name, pts: act.has(nrm(o.name)) ? act.get(nrm(o.name)) : null })); const rec = opts.find(o => o.name === b.bringBack), others = opts.filter(o => o !== rec && o.pts != null);
    const rank = rec && rec.pts != null ? 1 + others.filter(o => o.pts > rec.pts).length : null;
    return { qb: b.qb, stack: b.stack, bringBack: b.bringBack, recPts: rec ? rec.pts : null, best: opts.filter(o => o.pts != null).sort((a, c) => c.pts - a.pts)[0] || null, rank, of: others.length + (rec && rec.pts != null ? 1 : 0), beatAvg: rec && rec.pts != null && others.length ? rec.pts > others.reduce((a, o) => a + o.pts, 0) / others.length : null }; });
  const avoid = (st.avoid || []).map(a => ({ qb: a.qb, catchers: a.catchers, pts: pts([a.qb, ...a.catchers]), real: realCombo(real, [a.qb, ...a.catchers]) }));
  return { generatedAt: st.generatedAt, top, byQB, avoid };
}
// Blick's combo ownership vs the real contest it modeled (same date, same entry count), and ours vs the same contest
function scoreBlick(dir, sd, real, date) {
  const f = path.join(dir, "blick-conditional.raw.txt"); if (!fs.existsSync(f)) return null;
  const o = parseBlickCond(fs.readFileSync(f, "utf8")), entries = +o.meta.entries || null;
  const c = real.find(x => entries && x.entries === entries); if (!c) return { contest: o.meta.contest, skipped: `no stored real contest with ${entries} entries on ${date}` };
  let ours = null; try { ours = fieldFreq(path.basename(dir)); } catch {}
  const rows = [];
  for (const r of o.rows) {
    const names = [r.a, r.b, r.c].filter(Boolean), cpt = r.kind === "cpt" || r.kind === "cptflex" ? r.a : null;
    const re = realCombo([c], cpt ? names.slice(1).length ? names : [] : names, cpt);
    const actual = cpt && r.kind === "cpt" ? realCombo([c], [], r.a).pct : re.pct;
    const mine = ours ? (cpt ? ours.cpt(r.a, r.b) : ours.combo(names)) : null;
    rows.push({ kind: r.kind, names, blick: r.pct, actual, ours: mine });
  }
  const pick = k => rows.filter(x => x[k] != null && x.actual != null), mae = k => { const v = pick(k); return v.length ? r2(v.reduce((a, x) => a + Math.abs(x[k] - x.actual), 0) / v.length) : null; };
  const byKind = {}; for (const k of [...new Set(rows.map(x => x.kind))]) { const v = rows.filter(x => x.kind === k && x.actual != null); byKind[k] = { n: v.length, blickMAE: v.length ? r2(v.reduce((a, x) => a + Math.abs(x.blick - x.actual), 0) / v.length) : null, oursMAE: v.filter(x => x.ours != null).length ? r2(v.filter(x => x.ours != null).reduce((a, x) => a + Math.abs(x.ours - x.actual), 0) / v.filter(x => x.ours != null).length) : null }; }
  return { contest: o.meta.contest, realKey: c.key, entries, n: rows.length, blickMAE: mae("blick"), oursMAE: mae("ours"), byKind, rows };
}

function running(slates) {
  const res = {};
  const add = (key, item, base) => { const r = res[key] || (res[key] = { n: 0, slates: new Set(), pts: [], own: [], roi: [], beatRoi: 0, roiN: 0 }); r.n++; r.slates.add(item.slate);
    for (const f of ["pts", "own", "roi"]) if (item[f] != null && base[f] != null) r[f].push(item[f] - base[f]);
    if (item.roi != null && base.roi != null) { r.roiN++; if (item.roi > base.roi) r.beatRoi++; } };
  for (const s of slates) {
    for (const [g, x] of Object.entries(s.groups)) for (const p of x.picks) add(g, { ...p, slate: s.slate }, x.base);
    for (const p of s.fades) { const g = s.groups[p.pos] || s.groups.CPT || Object.values(s.groups)[0]; add("FADES", { ...p, slate: s.slate }, g ? g.base : {}); }
  }
  const out = Object.fromEntries(Object.entries(res).map(([k, r]) => [k, { n: r.n, slates: r.slates.size, ptsVsBase: r2(mean(r.pts)), ownVsBase: r2(mean(r.own)), roiVsBase: r2(mean(r.roi)), beatBaseRoi: r.roiN ? `${r.beatRoi}/${r.roiN}` : null, noise: r.n < 30 }]));
  // stacks: top-stack lineups' real ROI minus the field's; bring-back picks that beat the average alternative
  const tops = slates.flatMap(s => (s.stacks && s.stacks.top) || []).filter(t => t.real && t.real.roi != null && t.real.fieldRoi != null);
  const bbs = slates.flatMap(s => (s.stacks && s.stacks.byQB) || []).filter(b => b.beatAvg != null);
  out.STACKS = { n: tops.length, roiVsField: r2(mean(tops.map(t => t.real.roi - t.real.fieldRoi))), bringBackBeatAvg: bbs.length ? `${bbs.filter(b => b.beatAvg).length}/${bbs.length}` : null, noise: tops.length < 30 };
  const bc = slates.map(s => s.blickCond).filter(b => b && b.blickMAE != null);
  out.BLICK_COND = { slates: bc.length, combos: bc.reduce((a, b) => a + b.n, 0), blickMAE: r2(mean(bc.map(b => b.blickMAE))), oursMAE: r2(mean(bc.map(b => b.oursMAE).filter(v => v != null))) };
  return out;
}

const prev = readJ(OUT) || { slates: {} };
for (const d of process.argv.slice(2)) {
  const s = scoreSlate(d); prev.slates[s.slate] = s;
  if (s.skipped) { console.log(`${s.slate}: skipped (${s.skipped})`); continue; }
  console.log(`${s.slate}${s.backfill ? " [backfill]" : ""}: ${s.contests} contests, ${s.actuals} players with actual points`);
  for (const [g, x] of Object.entries(s.groups)) { console.log(`  ${g.padEnd(4)} baseline (n=${x.base.n}): pts ${x.base.pts ?? "-"} own ${x.base.own ?? "-"} roi ${x.base.roi ?? "-"}`); for (const p of x.picks) console.log(`       ${p.name.padEnd(24)} pts ${p.pts ?? "-"} own ${p.own ?? "-"} roi ${p.roi ?? "-"}`); }
  for (const p of s.fades) console.log(`  FADE ${p.name.padEnd(24)} pts ${p.pts ?? "-"} own ${p.own ?? "-"} roi ${p.roi ?? "-"}`);
  if (s.stacks && s.stacks.top) { for (const t of s.stacks.top) console.log(`  STACK ${[t.qb, ...t.catchers].join(" + ")}${t.bringBack ? " | bb " + t.bringBack : ""}: pts ${t.pts ?? "-"}${t.ptsWithBB != null ? " (+bb " + t.ptsWithBB + ")" : ""} | real ${t.real.pct}% of lineups, ROI ${t.real.roi ?? "-"} vs field ${t.real.fieldRoi}`);
    for (const b of s.stacks.byQB) console.log(`  BB ${b.qb}: ${b.bringBack} ${b.recPts ?? "-"} pts, rank ${b.rank ?? "-"}/${b.of}; best ${b.best ? b.best.name + " " + b.best.pts : "-"}`); }
  if (s.stacks && s.stacks.pairs) for (const p of s.stacks.pairs) console.log(`  PAIR CPT ${p.cpt} + ${p.with}: real ${p.pct ?? "-"}% ROI ${p.roi ?? "-"}`);
  if (s.blickCond) console.log(s.blickCond.skipped ? `  BLICK COND: skipped (${s.blickCond.skipped})` : `  BLICK COND (${s.blickCond.contest} vs real ${s.blickCond.realKey}): ${s.blickCond.n} combos, MAE Blick ${s.blickCond.blickMAE} vs ours ${s.blickCond.oursMAE} pts of ownership | ${Object.entries(s.blickCond.byKind).map(([k, v]) => `${k} ${v.blickMAE}/${v.oursMAE} (n${v.n})`).join(", ")}`);
}
const list = Object.values(prev.slates).filter(s => !s.skipped);
prev.running = running(list); prev.updated = new Date().toISOString();
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(prev, null, 1));
console.log("running (pick minus same-group baseline; fades should be negative):");
for (const [k, r] of Object.entries(prev.running).filter(([k]) => !/STACKS|BLICK_COND/.test(k))) console.log(`  ${k.padEnd(6)} n=${r.n} slates ${r.slates} | pts ${r.ptsVsBase ?? "-"} own ${r.ownVsBase ?? "-"} roi ${r.roiVsBase ?? "-"} beat-base ROI ${r.beatBaseRoi ?? "-"}${r.noise ? " (noise: n<30)" : ""}`);
console.log("  STACKS", JSON.stringify(prev.running.STACKS), "| BLICK_COND", JSON.stringify(prev.running.BLICK_COND));
