// Pipeline audit (user-asked 2026-10-10: "can we ensure all of this is working as intended"). On a real slate, checks each
// step against what it is supposed to do and prints PASS / FAIL with the numbers:
//   1. Model projection = the four sources weighted 1/MAE^2 by position from data/reports/source-scorecard-nfl.json
//      (a position with fewer than 30 graded players gets equal weights), on every hub row
//   2. ownership tier by contest: real DK lobby contests of each kind pick the source ownTier says
//   3. the ownership the field is built from matches that source, player by player (Blick HS / ETR+Blick average)
//   4. the generated field: player exposure lands near the ownership it was built from (built in a temporary copy of the
//      slate folder, so the saved field.json is never touched)
//   5. Lab ROI in the saved sim run = the weighted average of the per-source ROIs with the run's own weights
//   node bench/audit-pipeline.mjs data/2026-10-11-nfl-main
import fs from "node:fs";
import path from "node:path";
import { hubData } from "../server/sources.mjs";
import { loadPool, ownOf } from "../server/foursim.mjs";
import { ownTier, fieldPool, buildField } from "../server/contestsim.mjs";

const dir = path.basename(process.argv[2] || ""); if (!dir || !fs.existsSync(path.join("data", dir))) { console.error("usage: node bench/audit-pipeline.mjs data/<slate>"); process.exit(1); }
const res = []; const check = (name, ok, detail) => { res.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`); };
const avg = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const isDst = p => /^(DST|D|DEF)$/i.test(p || "");

// 1. Model projection
{ const H = hubData(dir), bp = JSON.parse(fs.readFileSync("data/reports/source-scorecard-nfl.json", "utf8")).byPos || {}, key = { stokastic: "stk", etr: "etr", blick: "blick", market: "mkt" };
  const W = {}; for (const [pos, b] of Object.entries(bp)) { W[pos] = {}; for (const [s, q] of Object.entries(b)) if (q.mae > 0 && q.n >= 30 && key[s]) W[pos][key[s]] = 1 / (q.mae * q.mae); }
  let bad = 0, n = 0, worst = null;
  for (const r of H.rows) { const srcs = ["stk", "etr", "blick", "mkt"].filter(k => r[k] && r[k].proj != null); if (!srcs.length) continue; n++;
    const w = W[isDst(r.pos) ? "DST" : r.pos.split("/")[0]] || {}, fb = Object.keys(w).length ? 0.5 * Math.min(...Object.values(w)) : 1;
    let ws = 0, wp = 0; for (const k of srcs) { const wk = w[k] || fb; ws += wk; wp += wk * r[k].proj; } const want = wp / ws;
    if (Math.abs(want - r.lab) > 0.02) { bad++; if (!worst || Math.abs(want - r.lab) > worst.d) worst = { d: Math.abs(want - r.lab), name: r.name, want, got: r.lab }; } }
  const share = pos => { const w = W[pos] || {}, t = Object.values(w).reduce((a, b) => a + b, 0); return Object.keys(w).length ? Object.entries(w).map(([k, v]) => `${k} ${(100 * v / t).toFixed(0)}%`).join(" ") : "equal (under 30 graded)"; };
  check("1. Model projection = scorecard-weighted blend", bad === 0, `${n} players checked, ${bad} off${worst ? ` (worst ${worst.name}: ${worst.got} vs ${worst.want.toFixed(2)})` : ""}; weights QB ${share("QB")} | RB ${share("RB")} | WR ${share("WR")} | TE ${share("TE")} | DST ${share("DST")}`);
}

// 2-4 on real contests from the lobby
const L = loadPool(dir), meta = L.hub.slate, lobbyJ = JSON.parse(fs.readFileSync("data/dk-lobby/nfl.json", "utf8"));
const games = new Set(meta.games || []), sd = L.sd;
const onSlate = (lobbyJ.contests || []).filter(c => c.fee > 0 && c.field > 0 && c.field < 1e6 && (String(c.slateId || c.draftGroupId || "") === String(meta.slateId) || (c.games ? c.games.every(g => games.has(g)) && c.games.length === games.size : /\bMain\b|\(Sun\)|\bNFL \$/.test(c.name) && !/Showdown|Early|Afternoon|Primetime|Turbo|Tiers|Snake|Best Ball/i.test(c.name))));
const pick = (label, f) => { const c = onSlate.filter(f).sort((a, b) => b.prizePool - a.prizePool)[0]; return c ? { label, c: { cid: String(c.id), name: c.name, fee: c.fee, field: c.field, prizePool: c.prizePool } } : null; };
const tiers = [pick("$100+, 1,000 or fewer", c => c.fee >= 100 && c.field <= 1000), pick("over 10,000 entries", c => c.field > 10000), pick("in between", c => !(c.fee >= 100 && c.field <= 1000) && c.field <= 10000)].filter(Boolean);
console.log(`\ncontests from the lobby (${onSlate.length} on this slate): ${tiers.map(t => `${t.label}: $${t.c.fee} ${t.c.name.slice(0, 40)} (${t.c.field.toLocaleString()})`).join(" | ") || "none found"}`);
for (const { label, c } of tiers) {
  const t = ownTier(sd, c), want = sd ? "avg" : c.fee >= 100 && c.field <= 1000 ? "blickHS" : "vavg";
  check(`2. tier for ${label}`, t.src === want, `${t.tier} (src ${t.src}, model ${t.curve ? "on" : "off"})`);
  // 3. the field pool's ownership vs the source, for players ETR or Blick cover (model rows aside)
  const gp = fieldPool(L, { ownSrc: "auto", projSrc: "lab", contest: c }), P = gp.players;
  let n = 0, bad = 0, ex = null;
  P.forEach(p => { const r = L.hubBy.get((isDst(p.pos) ? "dst" : p.name.toLowerCase().replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim()) + "|" + p.team);
    if (!r || (r.etr?.own == null && r.blick?.own == null)) return; const exp = ownOf(r, t.src, L.vendors); if (exp == null) return; n++;
    if (Math.abs((p.own || 0) - exp) > 0.05) { bad++; if (!ex) ex = `${p.name}: field ${p.own?.toFixed(2)} vs ${t.src} ${exp.toFixed(2)}`; } });
  check(`3. field ownership = ${t.src} for ${label}`, n > 0 && bad === 0, `${n} players covered by ETR/Blick, ${bad} differ${ex ? ` (e.g. ${ex})` : ""}`);
}
// 4. generated field exposure vs target, in a temporary copy of the slate folder
{ const t = tiers.find(x => x.label.startsWith("$100+")) || tiers[0];
  if (t) { const tmp = dir + "-audit-tmp", src = path.join("data", dir), dst = path.join("data", tmp);
    fs.mkdirSync(dst, { recursive: true }); for (const f of fs.readdirSync(src)) { const s = path.join(src, f); if (fs.statSync(s).isFile() && !/^(simrun|field|gen)\.json$/.test(f)) fs.copyFileSync(s, path.join(dst, f)); }
    try { const out = buildField(tmp, { cid: t.c.cid, ownSrc: "auto", projSrc: "lab", sizeToContest: true });
      const top = out.players.filter(p => p.own >= 1).sort((a, b) => b.own - a.own), chalk = top.slice(0, 15);
      const mae = avg(top.map(p => Math.abs(p.exp - p.own))), cmae = avg(chalk.map(p => Math.abs(p.exp - p.own))), bias = avg(chalk.map(p => p.exp - p.own));
      check(`4. generated field (${out.N} lineups for ${t.label}) tracks its ownership`, mae < 4 && cmae < 10, `exposure vs target: MAE ${mae.toFixed(1)} pts on ${top.length} players owned 1%+; top-15 chalk MAE ${cmae.toFixed(1)}, bias ${bias >= 0 ? "+" : ""}${bias.toFixed(1)} (${chalk.slice(0, 4).map(p => `${p.name} ${p.own.toFixed(0)}%->${p.exp.toFixed(0)}%`).join(", ")})`);
    } finally { fs.rmSync(dst, { recursive: true, force: true }); } } }

// 5. Lab ROI in the saved sim run
{ const S = JSON.parse(fs.readFileSync(path.join("data", dir, "simrun.json"), "utf8")), W = S.weights || null; let n = 0, bad = 0;
  if (W) for (const e of S.rows || []) { const srcs = (e.sim && e.sim.sources) || []; if (!srcs.length || e.sim.lab == null) continue; n++;
    const ws = srcs.reduce((t, s) => t + (W[s] || 0), 0), lab = srcs.reduce((t, s) => t + (W[s] || 0) * e.sim[s].roi, 0) / ws; if (Math.abs(lab - e.sim.lab) > 0.25) bad++; }   // 0.25: the stored ROIs and weights are rounded
  check("5. Lab ROI = weighted average of the per-source ROIs", W && n > 0 && bad === 0, W ? `${n} lineups, ${bad} off; run weights ${Object.entries(W).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(" ")}; sim run built ${S.at || "?"}` : "the saved run has no weights");
}
console.log(`\n${res.filter(Boolean).length} of ${res.length} checks passed`);
