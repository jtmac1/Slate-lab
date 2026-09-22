// Portfolio audit: does an entry file actually match the rules, before it is uploaded?
// Pure functions over a pool and a parsed entries CSV, so the same code serves the CLI
// (bench/audit-entries.mjs) and the app modal. No DOM, no fetch.
import { parseCSV, nrm } from "./csv.mjs";
import { matchLineups, salOf, projOf, stackTeams, stackOf, sigOf } from "./lineups.mjs";

const isPitcher = p => p.isP || /^(P|SP|RP)$/.test(String(p.pos || ""));

// DraftKings entry files (and the Stokastic export of them) carry Entry ID, Contest Name,
// Contest ID, Entry Fee, then one column per roster slot holding "Name (12345)". Plain lineup
// files carry only the slots. Locate the slot block by finding the format's first two slot names
// side by side in the header; fall back to a header that is nothing but slot names.
export function parseEntries(text, f) {
  const rows = parseCSV(text); if (!rows.length) return { entries: [], header: null };
  const up = r => r.map(s => String(s).trim().toUpperCase());
  const h = up(rows[0]), need = f.slots.length;
  let start = h.findIndex((x, i) => x === f.slots[0].toUpperCase() && h[i + 1] === f.slots[1].toUpperCase());
  const slotsOnly = h.length >= need && h.slice(0, need).every(x => /^(CPT|CAPTAIN|FLEX|QB|RB|WR|TE|DST|K|P|SP|RP|C|1B|2B|3B|SS|OF|UTIL|S-FLEX|SFLEX)$/.test(x));
  const hasHeader = start >= 0 || slotsOnly;
  if (start < 0) start = slotsOnly ? 0 : 4;   // no header: assume the DraftKings layout
  const meta = start >= 4;
  const entries = [];
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const names = r.slice(start, start + need).map(s => String(s || "").trim());
    if (names.filter(Boolean).length < need) continue;   // reservations and instruction rows
    entries.push({ entryId: meta ? String(r[0] || "").trim() : "", contest: meta ? String(r[1] || "").trim() : "", cid: meta ? String(r[2] || "").trim() : "",
      fee: meta ? String(r[3] || "").trim() : "", names });
  }
  return { entries, header: rows[0] };
}

// Rule checks are data-driven where they can be. `rules` is the parsed rules/<format>.json;
// `fieldOwn` is an optional array of ownership sums from a generated field for the ownership
// window; without it that rule reports unknown rather than pretending.
export function auditPortfolio(parsed, P, f, rules, fieldOwn) {
  const need = f.slots.length;
  const m = matchLineups(parsed.entries.map(e => e.names), P, f);
  // matchLineups drops unmatched rows silently; re-run per row so each entry keeps its own verdict
  const byKey = {}; P.forEach((p, i) => { if (byKey[p.key] == null) byKey[p.key] = i; });
  const pitchers = P.map((p, i) => ({ i, p })).filter(x => isPitcher(x.p)).sort((a, b) => b.p.proj - a.p.proj);
  const pRank = Object.fromEntries(pitchers.map((x, k) => [x.i, k + 1]));
  const ruleBy = Object.fromEntries((rules && rules.rules || []).map(r => [r.id, r]));
  const minSal = (() => { const r = ruleBy.salary; const mm = r && String(r.rule).match(/\$?([\d,]{5,})/); return mm ? +mm[1].replace(/,/g, "") : null; })();
  const ownFloor = fieldOwn && fieldOwn.length >= 30 ? fieldOwn.slice().sort((a, b) => a - b)[Math.floor(fieldOwn.length / 3)] : null;
  const sigs = {}, lineups = [];
  parsed.entries.forEach((e, n) => {
    const ids = []; const missing = [];
    for (const nm of e.names) { const idx = byKey[nrm(nm)]; if (idx == null) missing.push(nm); else ids.push(idx); }
    if (missing.length) { lineups.push({ n, entryId: e.entryId, contest: e.contest, fee: e.fee, ok: false, missing, checks: [] }); return; }
    const sal = salOf(ids, P, f), proj = projOf(ids, P, f);
    const own = ids.reduce((s, id, j) => s + ((f.mult && j === 0) ? (P[id].cown || 0) : (P[id].own || 0)), 0);
    const st = stackTeams(ids, P, f), primary = st[0] || ["-", 0], shape = stackOf(ids, P, f);
    const pits = ids.filter(id => isPitcher(P[id])), pr = pits.map(id => pRank[id] || 99);
    const sig = sigOf(ids, f), dupKey = (e.contest || "") + "|" + sig; sigs[dupKey] = (sigs[dupKey] || 0) + 1;
    const checks = [];
    const add = (id, pass, detail) => { if (ruleBy[id]) checks.push({ id, hard: !!ruleBy[id].hard, pass, detail }); };
    if (f.sport === "mlb") {
      add("stack5", primary[1] >= 5, `primary stack ${primary[0]} x${primary[1]} (${shape})`);
      add("pitcher_top3", pr.length > 0 && Math.min(...pr) <= 3, `pitcher ranks ${pr.join("/")}`);
      if (pr.some(r => r > 3) && ruleBy.pitcher_top3) checks.push({ id: "pitcher_off_board", hard: false, pass: false, detail: `a pitcher outside the top 3 (rank ${pr.filter(r => r > 3).join("/")})` });
    }
    if (f.sport === "nfl" && f.mult) {
      const cpt = P[ids[0]]; const rank = [...P].sort((a, b) => b.proj - a.proj).findIndex(p => p === cpt) + 1;
      add("captain_top3", rank <= 3, `captain ${cpt.name} is #${rank} projected`);
      add("captain_qb_rb", cpt.pos === "QB" || cpt.pos === "RB", `captain position ${cpt.pos}`);
    }
    // the cap is not a rulebook opinion, it is DraftKings rejecting the upload
    if (f.cap) checks.push({ id: "salary_cap", hard: true, pass: sal <= f.cap, detail: `$${sal.toLocaleString()} of $${f.cap.toLocaleString()}` });
    if (minSal) add("salary", sal >= minSal, `$${sal.toLocaleString()}`);
    if (ruleBy.own_window) checks.push({ id: "own_window", hard: false, pass: ownFloor == null ? null : own > ownFloor, detail: ownFloor == null ? `own sum ${own.toFixed(0)} (generate a contest to check against the field)` : `own sum ${own.toFixed(0)} vs field bottom-third line ${ownFloor.toFixed(0)}` });
    if (ruleBy.sim_band) checks.push({ id: "sim_band", hard: false, pass: null, detail: "needs Stokastic sim ROI for these lineups" });
    lineups.push({ n, entryId: e.entryId, contest: e.contest, fee: e.fee, ok: true, ids, sal, proj, own, primary: primary[0], primarySize: primary[1], shape, pitcherRanks: pr, sig, dupKey, checks });
  });
  // self-duplicates: same lineup twice in the same contest can only split with itself
  for (const l of lineups) if (l.ok && ruleBy.no_self_dupe) l.checks.push({ id: "no_self_dupe", hard: true, pass: sigs[l.dupKey] === 1, detail: sigs[l.dupKey] > 1 ? `${sigs[l.dupKey]} identical entries in this contest` : "unique in its contest" });
  const good = lineups.filter(l => l.ok);
  // exposure: how often each player appears, against his projected ownership
  const cnt = {}; for (const l of good) for (const id of l.ids) cnt[id] = (cnt[id] || 0) + 1;
  const exposure = Object.entries(cnt).map(([id, c]) => { const p = P[+id]; return { id: +id, name: p.name, team: p.team, pos: p.pos, count: c, pct: 100 * c / good.length, own: p.own || 0, delta: 100 * c / good.length - (p.own || 0), pitcher: isPitcher(p) }; })
    .sort((a, b) => b.count - a.count || b.delta - a.delta);
  const teams = {}; for (const l of good) teams[l.primary] = (teams[l.primary] || 0) + 1;
  const hardFails = good.filter(l => l.checks.some(c => c.hard && c.pass === false));
  const summary = { lineups: lineups.length, matched: good.length, unmatched: lineups.length - good.length,
    contests: new Set(good.map(l => l.contest)).size, primaryStacks: Object.entries(teams).sort((a, b) => b[1] - a[1]),
    selfDupes: good.filter(l => sigs[l.dupKey] > 1).length, hardFails: hardFails.length,
    maxExposure: exposure[0] || null, pitcherExposure: exposure.filter(x => x.pitcher).slice(0, 6),
    avgSal: good.length ? good.reduce((s, l) => s + l.sal, 0) / good.length : 0, avgOwn: good.length ? good.reduce((s, l) => s + l.own, 0) / good.length : 0,
    avgProj: good.length ? good.reduce((s, l) => s + l.proj, 0) / good.length : 0 };
  return { lineups, exposure, summary };
}

// Plain-text report for the CLI and for pasting into chat.
export function auditReport(a, P) {
  const s = a.summary, out = [];
  out.push(`${s.matched}/${s.lineups} lineups matched across ${s.contests} contest(s) - avg $${Math.round(s.avgSal).toLocaleString()}, proj ${s.avgProj.toFixed(1)}, own sum ${s.avgOwn.toFixed(0)}`);
  out.push(`hard-rule failures: ${s.hardFails}   self-duplicates: ${s.selfDupes}   primary stacks: ${s.primaryStacks.map(([t, n]) => `${t} x${n}`).join(", ")}`);
  if (s.maxExposure) out.push(`highest exposure: ${s.maxExposure.name} in ${s.maxExposure.count}/${s.matched} (${s.maxExposure.pct.toFixed(0)}%, field ${s.maxExposure.own.toFixed(0)}%)`);
  out.push("");
  for (const l of a.lineups) {
    if (!l.ok) { out.push(`#${l.n + 1} ${l.contest}  UNMATCHED: ${l.missing.join(", ")}`); continue; }
    const fails = l.checks.filter(c => c.pass === false), unk = l.checks.filter(c => c.pass == null);
    const flag = fails.some(c => c.hard) ? "FAIL" : fails.length ? "warn" : "ok  ";
    out.push(`#${l.n + 1} ${flag} ${l.primary} x${l.primarySize} (${l.shape})  P ${l.pitcherRanks.join("/")}  $${l.sal.toLocaleString()}  proj ${l.proj.toFixed(1)}  own ${l.own.toFixed(0)}  ${l.contest ? "| " + l.contest.slice(0, 40) : ""}`);
    out.push(`     ${l.ids.map(id => P[id].name).join(", ")}`);
    for (const c of fails) out.push(`     ${c.hard ? "FAIL" : "warn"} ${c.id}: ${c.detail}`);
    for (const c of unk) out.push(`     ?    ${c.id}: ${c.detail}`);
  }
  out.push(""); out.push("EXPOSURE (count / % of lineups / field own% / over-exposure)");
  for (const x of a.exposure.slice(0, 20)) out.push(`  ${x.name.padEnd(24)} ${x.team.padEnd(4)} ${String(x.pos).padEnd(3)} ${String(x.count).padStart(3)}  ${x.pct.toFixed(0).padStart(4)}%  ${x.own.toFixed(0).padStart(4)}%  ${(x.delta >= 0 ? "+" : "") + x.delta.toFixed(0)}${x.delta > 40 ? "  <-- heavy" : ""}`);
  return out.join("\n");
}
