// "Lab likes" (user-asked 2026-10-07): a few players per position the Lab likes this week, and why, from transparent
// inputs - the Lab projection and value, leverage (projection rank vs ownership rank within the position), ETR's
// Defense vs. Position for the opponent, ETR's expected-fantasy-points gap (usage better than results), team pass rate
// over expectation (QB/WR/TE), the market's implied team total, and the slate guide's stance.
// Score (2026-10-07, bench/likes-backtest-nfl.mjs): 2x value + projection + implied team total, z-scores within the
// position; leverage, DvP, XFP, PROE and the stance are shown as reasons only. Fades keep the older equal-weight mean. ETR tables come from
// guide.data (server/etrdata.mjs), so only tables published before the slate are used. XFP older than 14 days is skipped.
// Saved as guide.likes in data/<slate>/slate-guide.json (other guide keys untouched).
import fs from "node:fs";
import path from "node:path";
import { hubData } from "./sources.mjs";
import { slateData } from "./etrdata.mjs";

const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const nrm = s => String(s || "").toLowerCase().replace(/[.'`’]/g, "").replace(/\s+(jr|sr|ii|iii|iv|v)$/, "").replace(/\s+/g, " ").trim();
const XFP_MAX_DAYS = 14;
// guide stance nudge, in z units (small: stances were no better than chance on 2026-10-04, value the exception)
const STANCE = { core: 0.25, value: 0.4, leverage: 0.25, caution: -0.3, fade: -0.5 };
const LIKE_W = { value: 2, proj: 1, tt: 1 };
// classic floors so punts with one good signal don't make the list
const FLOOR = { QB: 12, RB: 8, WR: 7, TE: 5, DST: 4, K: 4 };
const r1 = x => Math.round(x * 10) / 10;
const posOf = p => { const s = String(p || "").toUpperCase(); return s === "D" || s === "DEF" ? "DST" : s.split("/")[0]; };

function zs(vals) {
  const v = vals.filter(x => x != null && Number.isFinite(x)); if (v.length < 3) return vals.map(() => null);
  const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  return vals.map(x => x == null || !Number.isFinite(x) ? null : (x - m) / sd);
}
const rankOf = (vals, desc = true) => { const idx = vals.map((v, i) => i).filter(i => vals[i] != null).sort((a, b) => desc ? vals[b] - vals[a] : vals[a] - vals[b]); const r = vals.map(() => null); idx.forEach((i, k) => r[i] = k + 1); return r; };

// one position group: attach z components and score
function scoreGroup(list, own) {
  const comps = {
    proj: zs(list.map(x => x.proj)),
    value: zs(list.map(x => x.value)),
    // leverage: owned lower than projected rank suggests (positive = underowned for his projection)
    lev: zs((() => { const pr = rankOf(list.map(x => x.proj)), or = rankOf(list.map(x => own(x))); return list.map((x, i) => pr[i] != null && or[i] != null ? or[i] - pr[i] : null); })()),
    dvp: zs(list.map(x => x.dvp)),
    xfp: zs(list.map(x => x.xfpEdge)),
    proe: zs(list.map(x => x.proe)),
    tt: zs(list.map(x => x.tt))
  };
  list.forEach((x, i) => {
    x.z = {}; const vals = [];
    for (const [k, a] of Object.entries(comps)) if (a[i] != null) { x.z[k] = +a[i].toFixed(2); vals.push(a[i]); }
    // fades keep the original equal-weight mean + stance nudge (fades lost money 81% / 56% of the time in 2025 / 2026)
    x.fadeScore = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length + (STANCE[x.stance] || 0)).toFixed(2) : null;
    // likes: 2x value + projection + implied total (bench/likes-backtest-nfl.mjs: hit rate about 2x baseline at every
    // position in 2025 and 2026; weights picked after seeing both years). Leverage ran below baseline alone at every
    // position in 2026, so it is a displayed reason only. DvP, XFP, PROE and the guide stance have no history yet:
    // reasons only, weight 0 until bench/signal-tracker-nfl.mjs / likes-tracker-nfl.mjs show they predict.
    let s = 0, w = 0; for (const [k, wt] of Object.entries(LIKE_W)) if (x.z[k] != null) { s += wt * x.z[k]; w += wt; }
    x.score = w ? +(s / w).toFixed(2) : null;
  });
}

// plain-English reasons from the strongest components (good ones for likes, bad ones for fades)
function reasons(x, sign, ctx) {
  const pct = v => `${v > 0 ? "+" : ""}${r1(v)}%`, o = x.useCpt ? x.cptOwn : x.own, ownS = o != null ? `${r1(o)}% ${x.useCpt ? "captain-" : ""}owned` : "ownership n/a", grp = x.grp || x.pos;
  const say = {
    proj: () => `Lab projects ${r1(x.proj)} pts (#${x.projRank} ${grp})`,
    value: () => `${x.value.toFixed(2)} pts per $1K at $${x.sal}`,
    lev: () => sign > 0 ? `projected #${x.projRank} ${grp} but #${x.ownRank} in ownership (${ownS})` : `#${x.ownRank} ${grp} in ownership (${ownS}) for the #${x.projRank} projection`,
    dvp: () => `faces ${x.opp}, who ${x.dvp >= 0 ? "inflate" : "deflate"} ${x.pos === "DST" ? "opposing defenses" : x.pos + "s"} ${pct(x.dvp)} (ETR DvP)`,
    xfp: () => x.xfpEdge > 0 ? `XFP ${r1(x.xfp.xfp)}/game vs ${r1(x.xfp.actual)} actual - usage outran results (${ownS})` : `scoring ${r1(x.xfp.actual)}/game on ${r1(x.xfp.xfp)} expected - results ahead of usage`,
    proe: () => `${x.team} ${pct(x.proe)} pass rate over expectation (ETR)`,
    tt: () => x.pos === "DST" ? `opponent ${x.opp} implied for only ${r1(-x.tt)} pts` : `${x.team} implied for ${r1(x.tt)} pts${x.total != null ? ` (game total ${x.total})` : ""}`
  };
  const keys = Object.entries(x.z).filter(([, z]) => sign > 0 ? z > 0.3 : z < -0.3).sort((a, b) => sign > 0 ? b[1] - a[1] : a[1] - b[1]).map(([k]) => k);
  const out = keys.slice(0, 3).map(k => say[k]());
  if (x.stance && STANCE[x.stance] && Math.sign(STANCE[x.stance]) === sign && out.length < 3) out.push(`guide: ${x.stance}${x.stanceSrc ? ` (${x.stanceSrc.split(/[\/;]/)[0].trim()})` : ""}`);
  if (sign > 0 && !keys.includes("lev") && x.own != null && out.length < 3) out.push(ownS);
  return out.length ? out : [sign > 0 ? `balanced profile, score ${x.score}` : `weak across the board, score ${x.score}`];
}

export function buildLikes(dir) {
  const hub = hubData(dir), meta = hub.slate || {}, sd = meta.type === "SHOWDOWN", date = meta.date || String(dir).slice(0, 10);
  const guide = readJ(path.join("data", dir, "slate-guide.json")) || {};
  const D = slateData(dir) || {};
  // XFP freshness
  const xfpAge = D.xfp ? Math.round((Date.parse(date) - Date.parse(D.xfp.published)) / 864e5) : null, useXfp = D.xfp && xfpAge <= XFP_MAX_DAYS;
  const xfpBy = new Map(useXfp ? Object.entries(D.xfp.players).map(([n, v]) => [nrm(n), v]) : []);
  const stanceBy = new Map(Object.entries(guide.stances || {}).map(([n, s]) => [nrm(n), s]));
  const tt = {}, tot = {}; for (const g of hub.games || []) { if (g.ttAway != null) { tt[g.away] = g.ttAway; tt[g.home] = g.ttHome; } if (g.total != null) { tot[g.away] = g.total; tot[g.home] = g.total; } }
  const players = hub.rows.filter(r => r.lab != null && r.sal > 0 && !(r.inj && /out|ir|injured reserve|doubtful/i.test(r.inj.status || ""))).map(r => {
    const pos = posOf(r.pos), xf = pos !== "DST" ? xfpBy.get(nrm(r.name)) : null, st = stanceBy.get(nrm(r.name));
    const dvpVs = D.dvp && D.dvp.vs[r.opp] ? D.dvp.vs[r.opp] : null;
    return {
      name: r.name, pos, team: r.team, opp: r.opp, sal: r.sal, proj: r.lab, value: r.lab / (r.sal / 1000),
      own: r.labOwn ?? r.vown ?? r.own ?? null, cptOwn: r.labCptOwn ?? null,
      // DST: the offense it faces - ETR's DST column on the opponent's row is not "vs" data, so use the opponent's QB DvP flipped is wrong; skip
      dvp: pos !== "DST" && dvpVs ? dvpVs[pos] ?? null : null,
      // XFP edge only for real roles (6+ expected per game); tiny usage makes the gap meaningless
      xfp: xf || null, xfpEdge: xf && xf.games >= 1 && xf.xfp >= 6 ? -xf.gap : null,
      proe: /QB|WR|TE/.test(pos) && D.proe && D.proe.teams[r.team] ? D.proe.teams[r.team].proe : null,
      tt: pos === "DST" ? (tt[r.opp] != null ? -tt[r.opp] : null) : tt[r.team] ?? null, total: tot[r.team] ?? null,
      stance: st ? st.stance : null, stanceSrc: st ? st.source : null
    };
  });
  const out = { generatedAt: new Date().toISOString(), format: sd ? "showdown" : "classic",
    inputs: { proj: "Lab blend", own: sd ? "Lab own (flex) / Lab captain own" : "Lab own", dvp: D.dvp ? `ETR wk${D.dvp.week} (${D.dvp.published})` : "none published before this slate", xfp: D.xfp ? (useXfp ? `ETR wk${D.xfp.week} (${D.xfp.published})` : `skipped: ETR wk${D.xfp.week} is ${xfpAge} days old`) : "none published before this slate", proe: D.proe ? `ETR wk${D.proe.week} (${D.proe.published})` : "none published before this slate", lines: (hub.games || []).some(g => g.ttAway != null) ? "Pinnacle implied totals" : "none", stances: Object.keys(guide.stances || {}).length },
    method: "likes: weighted within-position z-scores, 2x value + projection + implied total (backtested 2025-26); leverage, DvP, XFP edge, PROE and guide stance shown as reasons, weight 0. Fades: equal-weight mean of all inputs + stance nudge. Tracked by bench/likes-tracker-nfl.mjs.",
    picks: {}, fades: [] };
  const pack = x => ({ name: x.name, pos: x.pos, team: x.team, opp: x.opp, sal: x.sal, proj: r1(x.proj), own: x.own != null ? r1(x.own) : null, score: x.score, z: x.z });
  if (!sd) {
    for (const pos of ["QB", "RB", "WR", "TE", "DST"]) {
      const list = players.filter(x => x.pos === pos && x.proj >= (FLOOR[pos] || 0)); if (list.length < 3) continue;
      scoreGroup(list, x => x.own);
      const pr = rankOf(list.map(x => x.proj)), or = rankOf(list.map(x => x.own)); list.forEach((x, i) => { x.projRank = pr[i]; x.ownRank = or[i]; });
      out.picks[pos] = list.filter(x => x.score != null).sort((a, b) => b.score - a.score).slice(0, 3).map(x => ({ ...pack(x), reasons: reasons(x, 1) }));
    }
    // fades: chalk (top-12 owned on the slate, 15%+) with the worst scores and at least one bad signal
    const scored = players.filter(x => x.fadeScore != null && x.own >= 15).sort((a, b) => b.own - a.own).slice(0, 12);
    out.fades = scored.filter(x => x.fadeScore < 0 && Object.values(x.z).some(z => z < -0.5)).sort((a, b) => a.fadeScore - b.fadeScore).slice(0, 2).map(x => ({ ...pack(x), reasons: reasons(x, -1) }));
  } else {
    // captain candidates: everyone with real volume, leverage against captain ownership
    const cap = players.filter(x => x.proj >= 8); scoreGroup(cap, x => x.cptOwn ?? x.own);
    let pr = rankOf(cap.map(x => x.proj)), or = rankOf(cap.map(x => x.cptOwn ?? x.own)); cap.forEach((x, i) => { x.projRank = pr[i]; x.ownRank = or[i]; x.grp = "in the game"; x.useCpt = x.cptOwn != null; });
    out.picks.CPT = cap.filter(x => x.score != null).sort((a, b) => b.score - a.score).slice(0, 3).map(x => ({ ...pack(x), cptOwn: x.cptOwn != null ? r1(x.cptOwn) : null, reasons: reasons(x, 1) }));
    // flex values: $6,000 and under with a real projection
    const flex = players.filter(x => x.sal <= 6000 && x.proj >= 2).map(x => Object.assign({}, x, { useCpt: false })); scoreGroup(flex, x => x.own);
    pr = rankOf(flex.map(x => x.proj)); or = rankOf(flex.map(x => x.own)); flex.forEach((x, i) => { x.projRank = pr[i]; x.ownRank = or[i]; x.grp = "of the $6K-and-under plays"; });
    out.picks.FLEX = flex.filter(x => x.score != null).sort((a, b) => b.score - a.score).slice(0, 3).map(x => ({ ...pack(x), reasons: reasons(x, 1) }));
    const chalk = cap.filter(x => x.fadeScore != null && (x.cptOwn ?? 0) >= 15);
    out.fades = chalk.filter(x => x.fadeScore < 0).sort((a, b) => a.fadeScore - b.fadeScore).slice(0, 1).map(x => ({ ...pack(x), cptOwn: r1(x.cptOwn), reasons: reasons(x, -1) }));
  }
  return out;
}

// build and merge into slate-guide.json as guide.likes; a slate without its own guide (sub-slates read the Main guide
// through server/subguide.mjs) gets data/<slate>/likes.json instead, so writing likes never replaces that fallback
export function saveLikes(dir) {
  const f = path.join("data", dir, "slate-guide.json"), likes = buildLikes(dir), g = readJ(f);
  if (g) { g.likes = likes; fs.writeFileSync(f, JSON.stringify(g, null, 1)); }
  else fs.writeFileSync(path.join("data", dir, "likes.json"), JSON.stringify(likes, null, 1));
  return likes;
}
export const loadLikes = dir => (readJ(path.join("data", dir, "slate-guide.json")) || {}).likes || readJ(path.join("data", dir, "likes.json")) || null;
// short text for the Brain prompt
export function likesText(likes) {
  if (!likes || !likes.picks) return "";
  const line = p => `${p.name} (${p.team} $${p.sal}, proj ${p.proj}, own ${p.own ?? "?"}%${p.cptOwn != null ? `, CPT own ${p.cptOwn}%` : ""}): ${p.reasons.join("; ")}`;
  return Object.entries(likes.picks).map(([pos, l]) => `${pos}:\n${l.map(p => `  - ${line(p)}`).join("\n")}`).join("\n") + (likes.fades.length ? `\nFADES:\n${likes.fades.map(p => `  - ${line(p)}`).join("\n")}` : "");
}
