// Late swap for a DraftKings classic entry, NFL or CFB (built 2026-10-10 on the CFB Main Event; the user asked for NFL too).
// Started players count at their live points: a FINISHED game locks at its points, a game IN PROGRESS is live points plus the
// projection still to come by the game clock, with the full-game spread scaled by sqrt(share left). Your lineup and each
// alternative are simmed ALONE against the contest field (simming near-copies together lets them split each other's wins).
// The field is the REAL one from DraftKings' contest-standings export when given (--standings): every entry's visible players
// kept, players in unstarted games (shown as LOCKED to other users) filled from the unstarted players that fit the slot and
// the lineup's salary, weighted by projected ownership. Without it, the generator's field (build-slate settings, seed 1).
//   node bench/lateswap-dk.mjs data/<date>-<nfl|cfb>-<slate> <entries> <pct to 1st> <rake> "<names in DK slot order>"
//        [--standings=<contest-standings-<id>.csv>] [--top=6] [--replace=TEAM,TEAM] [--reopt=400] [--dupes] [--nolive] [--user=jtmac1999]
// Slot order: NFL QB|RB|RB|WR|WR|WR|TE|FLEX|DST (DST by team nickname, e.g. Cowboys); CFB QB|RB|RB|WR|WR|WR|FLEX|SFLEX.
// Modes: default = every single swap of an open slot (top --top per slot by projection); --replace = swap all open slots held by
// those teams together (e.g. off a weather game); --reopt = K random rebuilds of every open slot. --dupes lists entries that
// could still be your exact lineup. NFL projections and ownership come from the hub's Lab blend when the hub is running.
// DK saves the export to %TEMP% as contest-standings-<contestId>.csv; copy it into the slate folder right away.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseCSV } from "../src/engine/csv.mjs";
import { buildPool } from "../src/engine/formats.mjs";
import { genField } from "../src/engine/field.mjs";
import { buildModel, SIGMA_DEF } from "../src/engine/model.mjs";
import { simulate } from "../src/engine/sim.mjs";
import { fitPayouts } from "../src/engine/payouts.mjs";
import { mulberry32 } from "../src/engine/rng.mjs";

const args = process.argv.slice(2), flag = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const [dir, nArg = "600", pctArg = "20", rakeArg = "10", mine] = args.filter(a => !a.startsWith("--"));
if (!dir || !mine) { console.error("usage: see the header of bench/lateswap-dk.mjs"); process.exit(1); }
const N = +nArg, PCT = +pctArg, RAKE = +rakeArg, SEED = 1, ITERS = 10000, TOP = +(flag("top") || 6), USER = new RegExp(flag("user") || "jtmac1999", "i");
const slateName = path.basename(dir), date = slateName.slice(0, 10), NFL = /-nfl-/.test(slateName), FKEY = NFL ? "nfl_cl" : "cfb_cl", NOLIVE = args.includes("--nolive");
const nm = s => String(s || "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();
const isDst = p => /^(DST|D|DEF)$/i.test(p.pos || "");

// pool: the slate's Stokastic projections; for NFL, the hub's Lab projection and Lab ownership replace them when available
const file = fs.readdirSync(dir).find(f => /Data_Hub_Projections\.csv$/i.test(f));
const all = parseCSV(fs.readFileSync(path.join(dir, file), "utf8"));
const pool = buildPool(all[0], all.slice(1).filter(r => r.length > 1), FKEY), P = pool.players, f = pool.format, SL = f.slots;
if (NFL) { try { const H = await (await fetch(`http://localhost:8787/api/hub?dir=${slateName}`)).json(); let k = 0;
  const by = new Map(H.rows.map(r => [(r.pos === "DST" ? "dst" : nm(r.name)) + "|" + r.team, r]));
  for (const p of P) { const r = by.get((isDst(p) ? "dst" : nm(p.name)) + "|" + p.team); if (r && r.lab != null) { p.proj = r.lab; if (r.labOwn != null) p.own = r.labOwn; k++; } }
  console.log(`hub Lab projections and ownership for ${k} of ${P.length} players`); } catch { console.log("hub not running: Stokastic projections"); } }

// --own="Name:pct,Name:pct": real ownership read off DraftKings (it shows each of your players' % drafted, even before his game);
// it replaces the projection when filling opponents' hidden slots
for (const kv of (flag("own") || "").split(",").filter(Boolean)) { const [n, v] = kv.split(":"); const p = P.find(q => nm(q.name) === nm(n)); if (p && isFinite(+v)) p.own = +v; else console.log(`--own: not on slate: ${n}`); }

// live points and how much of each game is played
const live = new Map(), started = new Set(), done = {};
if (!NOLIVE) {
  if (NFL) { const { liveActuals } = await import("../server/live.mjs"); const L = await liveActuals(date, new Set(P.map(p => p.team)));
    for (const g of L.games) if (g.started) for (const t of [g.away, g.home]) { started.add(t); done[t] = g.final ? 1 : g.elapsed ?? 0.5; }
    for (const p of P) if (started.has(p.team)) live.set(p.i, L.byKey[(isDst(p) ? "DST" : nm(p.name)) + "|" + p.team] ?? 0);
  } else {
    execFileSync("node", ["bench/actuals-cfb.mjs", date, dir], { encoding: "utf8" });
    const act = parseCSV(fs.readFileSync(path.join(dir, "actuals.csv"), "utf8")), AH = act[0], ai = k => AH.indexOf(k), byNT = new Map();
    for (const r of act.slice(1)) { if (r[ai("Final")] === "" || r[ai("Final")] == null) continue; started.add(r[ai("Team")]); byNT.set(nm(r[ai("Player")]) + "|" + r[ai("Team")], +r[ai("Actual")] || 0); }
    const espn = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=200&groups=";
    const boards = await Promise.all(["80", "81"].map(g => fetch(espn + g + "&dates=" + date.replace(/-/g, "")).then(r => r.json()).catch(() => ({ events: [] }))));
    const ALIAS = { MIZ: "MIZZ", FLA: "UF", VAN: "VAND", ILL: "IL", HOU: "UH", SC: "SCAR", KST: "KSU" };
    for (const b of boards) for (const e of b.events || []) { const c = e.competitions[0], st = c.status, t = st.type, [cm, cs] = String(st.displayClock || "15:00").split(":").map(Number);
      const fr = t.completed ? 1 : t.state === "in" ? Math.min(0.98, Math.max(0, ((st.period - 1) * 15 + 15 - (cm || 0) - (cs || 0) / 60) / 60)) : 0;
      for (const k of c.competitors) { const d = ALIAS[k.team.abbreviation] || k.team.abbreviation; if (fr > 0) done[d] = Math.max(done[d] || 0, fr); } }
    for (const p of P) if (started.has(p.team)) live.set(p.i, byNT.get(nm(p.name) + "|" + p.team) ?? 0);
  }
}
const sport = NFL ? "nfl" : "cfb";
const lockedP = P.map(p => { if (!started.has(p.team)) return p; const pts = live.get(p.i) ?? 0, d = done[p.team] ?? 0.25;
  if (d >= 1) return Object.assign({}, p, { proj: pts, sd: 0.01, ceil: undefined });
  const s = (SIGMA_DEF[sport] || SIGMA_DEF.nfl)[p.pos.split("/")[0]] ?? 0.45, full = p.sd > 0 ? p.sd : p.proj * Math.sqrt(Math.exp(s * s) - 1);
  return Object.assign({}, p, { proj: pts + p.proj * (1 - d), sd: Math.max(0.01, full * Math.sqrt(1 - d)), ceil: undefined }); });
const lpool = Object.assign({}, pool, { players: lockedP });

// your lineup
const byName = new Map(); P.forEach((p, i) => { byName.set(nm(p.name), i); if (isDst(p)) byName.set(nm(p.team), i); });
const idx = n => { const i = byName.get(nm(n)); if (i == null) throw new Error("not on slate: " + n); return i; };
const cur = mine.split("|").map(idx); if (cur.length !== SL.length) throw new Error(`lineup needs ${SL.length} players in slot order ${SL.join("|")}`);
const posOf = i => P[i].pos.split("/")[0];
const fits = (slot, i) => slot === "FLEX" ? (NFL ? /^(RB|WR|TE)$/ : /^(RB|WR)$/).test(posOf(i)) : slot === "SFLEX" ? /^(QB|RB|WR|TE)$/.test(posOf(i)) : posOf(i) === slot;
const salOf = lu => lu.reduce((s, i) => s + P[i].sal, 0), left = 50000 - salOf(cur);
if (left < 0) throw new Error(`lineup is $${salOf(cur)}, over the $50,000 cap: check the names and slot order`);

// the field
let field = genField(pool, N, NFL ? { conc: 1.25, minSal: 48000, boost: 1.0, rounds: 3, nflStacks: { 1: 45, 2: 41, 3: 5, bring: 62 } } : { conc: 1.0, minSal: 49000, boost: 1.0, rounds: 3, nflStacks: { 1: 43, 2: 32, 3: 8, bring: 50 } }, mulberry32(SEED)).field;
let real = null;
const STAND = flag("standings");
if (STAND) {
  const S = parseCSV(fs.readFileSync(STAND, "utf8")), SH = S[0], ci = k => SH.indexOf(k), rng = mulberry32(99), LAB = NFL ? "QB|RB|WR|TE|FLEX|DST" : "S-FLEX|FLEX|QB|RB|WR";
  const re = new RegExp(`(?:^| )(${LAB}) (.+?)(?= (?:${LAB}) |$)`, "g");
  const toks = s => [...String(s).matchAll(re)].map(m => [m[1] === "S-FLEX" ? "SFLEX" : m[1], m[2].trim()]);
  real = [];
  for (const r of S.slice(1)) { const lu = r[ci("Lineup")]; if (!r[ci("EntryId")] || !lu) continue;
    const slots = SL.map(() => null), used = new Set();
    for (const [slot, name] of toks(lu)) { const k = SL.findIndex((s, j) => s === slot && slots[j] === null); if (k < 0) continue; if (name === "LOCKED") { slots[k] = -1; continue; } const i = byName.get(nm(name)); slots[k] = i ?? -1; if (i != null) { used.add(i); if (!NOLIVE) started.add(P[i].team); } }
    real.push({ user: r[ci("EntryName")], raw: lu, slots: slots.slice(), visible: slots.filter(v => v != null && v >= 0), used });
  }
  let filled = 0;
  for (const e of real) { const hid = e.slots.map((v, j) => v == null || v < 0 ? j : -1).filter(j => j >= 0); if (!hid.length) continue;
    const vis = salOf(e.visible); let best = null;
    for (let t = 0; t < 300; t++) { const pick = [], taken = new Set(e.used); let ok = true, s = vis;
      for (const j of hid) { const c = P.map((p, i) => i).filter(i => !started.has(P[i].team) && !taken.has(i) && P[i].proj > 0 && fits(SL[j], i) && s + P[i].sal <= 50000);
        if (!c.length) { ok = false; break; } const w = c.map(i => Math.max(0.2, P[i].own || 0)), tot = w.reduce((a, b) => a + b, 0); let x = rng() * tot, k = 0; while ((x -= w[k]) > 0 && k < c.length - 1) k++;
        pick.push(c[k]); taken.add(c[k]); s += P[c[k]].sal; }
      if (ok && (!best || Math.abs(50000 - s) < Math.abs(50000 - best.s))) best = { pick, s }; if (best && best.s >= 49500) break; }
    if (best) { hid.forEach((j, q) => e.slots[j] = best.pick[q]); filled++; } }
  field = real.filter(e => e.slots.every(v => v != null && v >= 0)).map(e => USER.test(e.user) ? cur : e.slots);
  console.log(`real field: ${real.length} entries from ${path.basename(STAND)} (${new Set(real.map(e => e.user.replace(/ \(.*/, ""))).size} users), ${filled} with hidden slots filled`);
}

// alternatives
const variants = [{ label: "current lineup", lu: cur }];
const open = cur.map((pid, s) => started.has(P[pid].team) ? -1 : s).filter(s => s >= 0);
const REPL = (flag("replace") || "").split(",").filter(Boolean), REOPT = +(flag("reopt") || 0);
if (REOPT) {
  const pool2 = P.map((p, i) => i).filter(i => !started.has(P[i].team) && P[i].proj > 2), r2 = mulberry32(7), seen = new Set([cur.slice().sort().join(",")]);
  const fixedSal = salOf(cur.filter(i => started.has(P[i].team))), cheapest = s => Math.min(...pool2.filter(i => fits(SL[s], i)).map(i => P[i].sal));
  for (let t = 0; t < REOPT * 20 && variants.length <= REOPT; t++) {
    const lu = cur.slice(), order = open.slice().sort(() => r2() - 0.5); let sal = fixedSal, ok = true; const used = new Set(cur.filter(i => started.has(P[i].team)));
    for (let q = 0; q < order.length; q++) { const s = order[q], restMin = order.slice(q + 1).reduce((a, x) => a + cheapest(x), 0);
      const c = pool2.filter(i => !used.has(i) && fits(SL[s], i) && sal + P[i].sal + restMin <= 50000); if (!c.length) { ok = false; break; }
      const w = c.map(i => P[i].proj ** 2), tot = w.reduce((a, b) => a + b, 0); let x = r2() * tot, k = 0; while ((x -= w[k]) > 0 && k < c.length - 1) k++;
      lu[s] = c[k]; used.add(c[k]); sal += P[c[k]].sal; }
    const key = lu.slice().sort().join(","); if (!ok || sal < 49000 || seen.has(key)) continue; seen.add(key);
    variants.push({ label: open.map(s => `${SL[s]} ${P[lu[s]].name} (${P[lu[s]].team} $${P[lu[s]].sal}, ${(P[lu[s]].own || 0).toFixed(0)}%)`).join(", ") + ` | $${sal}`, lu });
  }
  console.log(`rebuilt the ${open.length} open slots: ${variants.length - 1} distinct lineups, $${50000 - fixedSal} to spend`);
} else if (REPL.length) {
  const out = open.filter(s => REPL.includes(P[cur[s]].team)), budget = out.reduce((t, s) => t + P[cur[s]].sal, 0) + left;
  const cands = out.map(s => P.map((p, i) => i).filter(i => !started.has(P[i].team) && !REPL.includes(P[i].team) && !cur.includes(i) && fits(SL[s], i) && P[i].proj > 0).sort((a, b) => P[b].proj - P[a].proj).slice(0, 12));
  const combos = [], walk = (k, pick, sal) => { if (k === out.length) { combos.push(pick.slice()); return; } for (const i of cands[k]) { if (pick.includes(i) || sal + P[i].sal > budget) continue; pick.push(i); walk(k + 1, pick, sal + P[i].sal); pick.pop(); } };
  walk(0, [], 0); combos.sort((a, b) => b.reduce((t, i) => t + P[i].proj, 0) - a.reduce((t, i) => t + P[i].proj, 0));
  for (const c of combos.slice(0, 40)) { const lu = cur.slice(); out.forEach((s, q) => lu[s] = c[q]); variants.push({ label: out.map((s, q) => `${SL[s]} ${P[cur[s]].name} -> ${P[c[q]].name} (${P[c[q]].team} $${P[c[q]].sal}, proj ${P[c[q]].proj.toFixed(1)}, own ${(P[c[q]].own || 0).toFixed(0)}%)`).join("; "), lu }); }
  console.log(`replacing ${out.map(s => P[cur[s]].name).join(", ")}: $${budget} to spend, ${combos.length} combinations fit, simming the best ${Math.min(40, combos.length)}`);
} else {
  for (const s of open) { const pid = cur[s], budget = P[pid].sal + left;
    P.map((p, i) => i).filter(i => !started.has(P[i].team) && !cur.includes(i) && fits(SL[s], i) && P[i].sal <= budget && P[i].proj > 0).sort((a, b) => P[b].proj - P[a].proj).slice(0, TOP)
      .forEach(i => { const lu = cur.slice(); lu[s] = i; variants.push({ label: `${SL[s]}: ${P[pid].name} -> ${P[i].name} (${P[i].team}, $${P[i].sal}, proj ${P[i].proj.toFixed(1)}, own ${(P[i].own || 0).toFixed(0)}%)`, lu }); }); }
}

const pay = fitPayouts(N, N * (1 - RAKE / 100), N * (1 - RAKE / 100) * PCT / 100, 22);
const res = simulate({ pool: lpool, model: buildModel(lpool, {}), field, lineups: variants.map(v => v.lu), payouts: pay, entries: N, fee: 1, iters: ITERS, maxIters: ITERS * 4, rng: mulberry32(SEED), solo: true });
console.log(`started teams (${started.size}): ${[...started].sort().join(" ") || "none"} | your started players: ${cur.filter(i => started.has(P[i].team)).map(i => `${P[i].name} ${(live.get(i) ?? 0).toFixed(1)}${(done[P[i].team] ?? 0) >= 1 ? " (final)" : ""}`).join(", ") || "none"}`);
const out = variants.map((v, k) => ({ ...v, win: res.rows[k].win ?? 0, t1: res.rows[k].t1 ?? null, roi: res.rows[k].roi, cash: res.rows[k].cash, t10: res.rows[k].t10 })), base = out[0];
// judge by win % only when wins are common enough to compare (30+ winning draws); otherwise by top-1% rate (big NFL fields)
const winDraws = base.win / 100 * res.iters, key = winDraws >= 30 || base.t1 == null ? "win" : "t1", lab = key === "win" ? "win %" : "top-1% rate";
console.log(`\ncurrent: win ${base.win.toFixed(2)}%${base.t1 != null ? `, top-1% ${base.t1.toFixed(2)}%` : ""}, top-10% ${base.t10.toFixed(1)}%, cash ${base.cash.toFixed(1)}% (Lab ROI ${base.roi.toFixed(0)}%; compare, don't read the level)`);
if (key === "t1") console.log(`  wins are too rare to compare (${Math.round(winDraws)} winning draws of ${res.iters}), so alternatives are judged by top-1% rate`);
const better = out.slice(1).filter(v => v[key] > base[key]).sort((a, b) => b[key] - a[key]);
console.log(`\nalternatives that beat it on ${lab} (${out.length - 1} tried):`); if (!better.length) console.log("  none: keep the lineup");
better.slice(0, 10).forEach(v => console.log(`  ${lab} ${v[key].toFixed(2)}% (+${(v[key] - base[key]).toFixed(2)}) win ${v.win.toFixed(2)}% cash ${v.cash.toFixed(1)}% | ${v.label}`));
if (args.includes("--dupes") && real) {
  const me = real.find(e => USER.test(e.user)), mineSet = new Set(cur), myVis = me ? new Set(me.visible) : new Set(cur.filter(i => started.has(P[i].team)));
  const could = real.filter(e => e !== me && e.visible.every(i => mineSet.has(i)) && [...myVis].every(i => e.visible.includes(i) || !started.has(P[i].team)));
  console.log(`\ndupes: ${could.length} other entr${could.length === 1 ? "y" : "ies"} could still be your exact lineup${could.length ? ": " + could.map(e => e.user).join(", ") : ""}`);
}
