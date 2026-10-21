// CFB cheat sheet (user-asked 2026-10-10 for the $555 CFB Mid-Season Main Event): one phone page for a CFB classic slate,
// published as a private claude.ai artifact. Built from the Stokastic projections file, data/<slate>/slate-guide.json (the
// show's calls, in the NFL guide's schema), the latest bench/build-slate.mjs output (the sim's ranking of a generated field
// sized to the contest), and data/reports/cfb-highstakes.json when the CFB backtest has written it (kept rules).
// Each lineup gets a brain-fit score from the guide (same points as the NFL Notes part: core/value 1, leverage 1.5, caution
// -0.5, fade -2; a core play under 10% owned counts as leverage; +1 per thesis it bets on) and any conflicts are spelled out.
//   node bench/cfb-sheet.mjs data/2026-10-10-cfb-main [contest label]      -> data/<slate>/cfb-sheet.html
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2], label = process.argv[3] || "CFB $300K Mid-Season Main Event · $555 · 600 entries · $100K to 1st";
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const G = readJ(path.join(dir, "slate-guide.json")), slate = readJ(path.join(dir, "slate.json")) || {};
if (!G) { console.error("usage: node bench/cfb-sheet.mjs data/<slate> (needs slate-guide.json)"); process.exit(1); }
const builds = fs.readdirSync(dir).filter(f => /^build-\d+-seed\d+\.json$/.test(f)).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
const B = builds.length ? readJ(path.join(dir, builds[0].f)) : null;
const RB = readJ("data/reports/cfb-highstakes.json");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nm = s => String(s || "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();
const csvF = fs.readdirSync(dir).find(f => /^DK_CFB_.*Projections\.csv$/.test(f));
const L = fs.readFileSync(path.join(dir, csvF), "utf8").trim().split(/\r?\n/), HD = L[0].split(",");
const P = new Map(L.slice(1).map(l => { const c = l.match(/("[^"]*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, "").replace(/"/g, "")); const o = Object.fromEntries(HD.map((k, i) => [k, c[i]])); return [nm(o.Player), { name: o.Player, pos: o.Position, team: o.Team, opp: o.Opponent, sal: +o.Salary, proj: +o.Projection, own: +o["Ownership %"] || 0, inj: o.Injury || "" }]; }));
const pOf = n => P.get(nm(n)) || null;

// brain fit for one lineup: the guide's stances and theses (players must be on the slate file)
const PTS = { core: 1, value: 1, leverage: 1.5, caution: -0.5, fade: -2 };
const stanceOf = n => { const k = Object.keys(G.stances || {}).find(s => nm(s) === nm(n)); return k ? G.stances[k] : null; };
function fit(names, teams) {
  let s = 0; const pro = [], con = [];
  names.forEach(n => { const st = stanceOf(n); if (!st) return; const p = pOf(n), lowCore = st.stance === "core" && p && p.own < 10, w = lowCore ? PTS.leverage : PTS[st.stance] ?? 0; s += w; (w > 0 ? pro : con).push(`${n} (${lowCore ? "core, low-owned" : st.stance})`); });
  const T = new Set(teams);
  // a thesis only earns its point when the show likes its games (stack or mini-stack); warning theses (weather) don't
  const liked = t => (t.games || []).length && t.games.every(g => /^(stack|mini)$/.test(((G.gameCalls || {})[g] || {}).call || ""));
  for (const t of (G.theses || []).filter(liked)) { const tt = t.games.flatMap(g => g.split("@")), inT = names.filter((n, i) => tt.includes(teams[i])).length; if (inT >= 3) { s += 1; pro.push(`bets on "${t.name}"`); } }
  // the CFB rulebook's strongest calls for $100+ fields (bench/rulebook-cfb.mjs, 80 contests): 3+ under 5% owned avoid
  // (t -5.3), 0-1 at 20%+ owned avoid (t -3.4), 3+ at 20%+ follow (t 3.1), two QBs follow (t 2.2)
  const own = names.map(n => (pOf(n) || {}).own ?? 0), qbs = names.filter(n => /QB/.test((pOf(n) || {}).pos || "")).length;
  const sub5 = own.filter(o => o < 5).length, chalk = own.filter(o => o >= 20).length;
  if (sub5 >= 3) { s -= 1.5; con.push(`${sub5} players under 5% owned (CFB rule: avoid)`); }
  if (chalk <= 1) { s -= 1; con.push(`only ${chalk} player at 20%+ owned (CFB rule: avoid)`); } else if (chalk >= 3) { s += 0.5; pro.push(`${chalk} players at 20%+ owned (CFB rule)`); }
  if (qbs < 2) { s -= 0.5; con.push("one QB (CFB rule: play two)"); }
  for (const [g, c] of Object.entries(G.gameCalls || {})) if (c.call === "avoid") { const tt = g.split("@"), k = names.filter((n, i) => tt.includes(teams[i])).length; if (k >= 2) { s -= 1; con.push(`${k} players from ${g} (show: avoid)`); } }
  return { s: +s.toFixed(1), pro, con };
}
const field = B ? B.field : [], N = field.length;
const scored = field.map((e, i) => ({ ...e, i, fit: fit(e.names, e.teams) }));
const rank = (arr, key) => { const o = arr.slice().sort((a, b) => key(b) - key(a)); const m = new Map(o.map((e, i) => [e.i, 1 - i / Math.max(1, o.length - 1)])); return e => m.get(e.i); };
const simPct = rank(scored, e => e.roi), fitPct = rank(scored, e => e.fit.s);
scored.forEach(e => { e.simP = Math.round(100 * simPct(e)); e.fitP = Math.round(100 * fitPct(e)); e.both = Math.round(0.5 * e.simP + 0.5 * e.fitP); });
const topBy = (k, n) => scored.slice().sort((a, b) => b[k] - a[k]).slice(0, n);
const playerROI = new Map(((B && B.playerROI) || []).map(r => [nm(r.name), r]));

const POS = ["QB", "RB", "WR"], ORDER = { core: 0, leverage: 1, value: 2, caution: 3, fade: 4 };
const players = Object.entries(G.stances || {}).map(([n, s]) => ({ n, ...s, p: pOf(n) })).filter(x => x.p);
const chip = (cls, t) => `<span class="chip ${cls}">${esc(t)}</span>`;
const CALL = { stack: ["stack", "Game stack"], mini: ["look", "Mini-stack"], pieces: ["", "Single players"], avoid: ["avoid", "Avoid"] };
const lu = e => e.names.map((n, i) => `<span>${esc(n)} <i>${esc(e.teams[i])}</i></span>`).join("");
const luRow = (e, why) => `<div class="lu"><div class="top"><b>Sim ${e.simP}</b><b>Brain ${e.fitP}</b><span class="meta">Lab ROI ${(+e.roi).toFixed(0)}% · own ${(+e.own).toFixed(0)}% · $${e.sal.toLocaleString()} · ${esc(e.stack)}${e.dup ? ` · ${e.dup} dupes` : ""}</span></div><div class="pl">${lu(e)}</div>${why ? `<div class="why">${e.fit.pro.length ? `<span class="pro">For: ${esc(e.fit.pro.join("; "))}</span>` : ""}${e.fit.con.length ? `<span class="con">Against: ${esc(e.fit.con.join("; "))}</span>` : ""}</div>` : ""}</div>`;
const rules = RB && RB.rules ? RB.rules.filter(r => r.keep || Math.abs(r.t) >= 2).slice(0, 10) : [];
const stamp = s => s ? new Date(String(s).endsWith("Z") ? s : s + "Z").toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) + " CT" : "—";

const html = `<title>CFB Cheat Sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Roboto:wght@400;500;700&display=swap">
<style>
:root{color-scheme:dark;--bg:#06070d;--bg2:#0a0c15;--field:#0e1222;--line:#171b2c;--line2:#242a42;--ink:#eef1ff;--ink2:#b7bfdc;--muted:#7f88a8;--neon:#19e6ff;--neonrgb:25,230,255;--green:#19ff8c;--pink:#ff3ded;--yellow:#ffd93d;--red:#ff4d6d;--sans:"Roboto",system-ui,-apple-system,"Segoe UI",sans-serif;--cond:"Rajdhani","Roboto Condensed","Arial Narrow",sans-serif}
html,body{background:var(--bg)}
body{color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;padding-inline:16px;padding-block:0 48px;-webkit-font-smoothing:antialiased;background-image:radial-gradient(900px 320px at 0 -80px,rgba(var(--neonrgb),.08),transparent 60%)}
.wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
header{padding-top:18px;display:flex;flex-direction:column;gap:6px}
.brand{font-family:var(--cond);font-weight:700;letter-spacing:.14em;font-size:13px;color:var(--neon);text-transform:uppercase}
h1{font-family:var(--cond);font-weight:700;font-size:28px;line-height:1.05;margin:0;text-wrap:balance}
h2{font-family:var(--cond);font-weight:700;font-size:19px;letter-spacing:.06em;text-transform:uppercase;margin:0}
h2 small{font-family:var(--sans);font-weight:400;font-size:12px;letter-spacing:0;text-transform:none;color:var(--muted);margin-left:8px}
h3{font-family:var(--cond);font-size:15px;letter-spacing:.08em;color:var(--muted);margin:6px 0 0}
.stamps{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted)} .stamps b{color:var(--ink2);font-weight:500}
nav{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:rgba(6,7,13,.92);backdrop-filter:blur(6px);margin-inline:-16px;padding:8px 16px;border-bottom:1px solid var(--line);display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
nav a{flex:none;font-family:var(--cond);font-weight:700;letter-spacing:.06em;font-size:14px;color:var(--ink2);text-decoration:none;padding:4px 10px;border:1px solid var(--line2);border-radius:14px}
nav a:hover,nav a:focus-visible{color:var(--neon);border-color:var(--neon)}
section{display:flex;flex-direction:column;gap:10px;scroll-margin-top:52px}
p{margin:0} .note{font-size:12.5px;color:var(--ink2)}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:10px;border:1px solid currentColor;white-space:nowrap}
.chip.stack,.chip.core{color:var(--green)} .chip.look,.chip.leverage{color:var(--neon)} .chip.avoid,.chip.fade{color:var(--red)} .chip.value{color:var(--yellow)} .chip.caution{color:#ffa94d}
.game{border:1px solid var(--line2);background:var(--bg2);border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:4px}
.game.stack{border-color:rgba(25,255,140,.45)} .game .mu{font-family:var(--cond);font-weight:700;font-size:18px;margin-right:8px}
.game p{color:var(--ink2);font-size:13px}
.lu{border:1px solid var(--line2);background:var(--bg2);border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:5px}
.lu .top{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
.lu .top b{font-family:var(--cond);font-size:16px;letter-spacing:.04em;color:var(--neon)} .lu .top b+b{color:var(--green)}
.lu .meta{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.lu .pl{display:flex;flex-wrap:wrap;gap:3px 12px;font-size:13px} .lu .pl i{color:var(--muted);font-style:normal;font-size:11px}
.lu .why{display:flex;flex-direction:column;gap:2px;font-size:12px} .why .pro{color:var(--green)} .why .con{color:#ffa94d}
.prow{display:grid;grid-template-columns:minmax(0,1fr) 46px 50px 42px 40px auto;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px}
.prow .num{text-align:right;font-variant-numeric:tabular-nums} .prow .tm{color:var(--muted);font-size:12px}
.prow.hdr{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border:0}
.prow.hdr span:nth-child(n+2){text-align:right}
.pwhy{font-size:12.5px;color:var(--ink2);padding:0 8px 8px;border-bottom:1px solid var(--line)}
.rule{display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;font-size:13px;padding:5px 0;border-bottom:1px solid var(--line)}
.rule .v{font-family:var(--cond);font-weight:700;letter-spacing:.06em} .rule .v.f{color:var(--green)} .rule .v.a{color:var(--red)} .rule small{color:var(--muted);display:block}
ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px} li{color:var(--ink2);font-size:13px}
footer{font-size:12px;color:var(--muted)}
:focus-visible{outline:2px solid var(--neon);outline-offset:2px}
@media (max-width:480px){.prow{grid-template-columns:minmax(0,1fr) 44px 38px 36px auto}.prow .tm{display:none}.prow.hdr span:nth-child(2){display:none}h1{font-size:24px}}
</style>
<div class="wrap">
<header>
  <div class="brand">Slate Lab · CFB cheat sheet</div>
  <h1>Week 6 CFB Main · ${(slate.games || []).length} games</h1>
  <div class="stamps"><span><b>Contest</b> ${esc(label)}</span><span><b>Lock</b> ${slate.start ? esc(new Date(slate.start + "-04:00").toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) + " CT") : "—"}</span><span><b>Projections</b> ${esc(stamp(slate.projectionsUpdated))}</span><span><b>Ownership</b> ${esc(stamp(slate.ownershipUpdated))}</span>${B ? `<span><b>Sim</b> ${N} lineups · ${(B.iters || 0).toLocaleString()} draws</span>` : ""}</div>
</header>
<nav aria-label="Sections"><a href="#lineups">Lineups</a><a href="#games">Games</a><a href="#players">Players</a><a href="#rules">Rules</a><a href="#notes">Notes</a></nav>
<section id="lineups"><h2>Top lineups <small>Sim and Brain are 0-100 ranks in a ${N}-lineup field</small></h2>
<p class="note">Sim = the Lab ROI rank against a field built like this contest. Brain = how well it matches the show's calls. Lab ROI levels run high; compare ranks, not the percent.</p>
<h3>Best on both</h3>${topBy("both", 6).map(e => luRow(e, true)).join("")}
<h3>Sim's top 3 (check the conflicts)</h3>${topBy("simP", 3).map(e => luRow(e, true)).join("")}
</section>
<section id="games"><h2>Games <small>the show's calls</small></h2>
${Object.entries(G.gameCalls || {}).sort((a, b) => ["stack", "mini", "pieces", "avoid"].indexOf(a[1].call) - ["stack", "mini", "pieces", "avoid"].indexOf(b[1].call)).map(([g, c]) => `<div class="game ${(CALL[c.call] || [""])[0]}"><div><span class="mu">${esc(g.replace("@", " @ "))}</span>${chip((CALL[c.call] || ["", c.call])[0], (CALL[c.call] || ["", c.call])[1])}</div><p>${esc(c.why)}</p>${(G.theses || []).filter(t => (t.games || []).includes(g)).map(t => `<p><b>${esc(t.name)}.</b> ${esc(t.summary)}</p>`).join("")}</div>`).join("\n")}
</section>
<section id="players"><h2>Players <small>the show's calls · Stokastic salary, projection, ownership · sim ROI</small></h2>
<div class="prow hdr"><span>Player</span><span>Team</span><span>Salary</span><span>Proj</span><span>Own</span><span></span></div>
${POS.map(pos => { const l = players.filter(x => x.p.pos.split("/")[0] === pos).sort((a, b) => (ORDER[a.stance] ?? 9) - (ORDER[b.stance] ?? 9) || b.p.sal - a.p.sal); return l.length ? `<h3>${pos}</h3>` + l.map(x => { const r = playerROI.get(nm(x.n)); return `<div class="prow"><span>${esc(x.n)}</span><span class="tm">${esc(x.p.team)}</span><span class="num">$${(x.p.sal / 1000).toFixed(1)}K</span><span class="num">${x.p.proj.toFixed(1)}</span><span class="num">${x.p.own.toFixed(0)}%</span>${chip(x.stance, x.stance)}</div><div class="pwhy">${esc(x.why)}${r ? ` <span style="color:var(--muted)">Sim: field ${r.exp.toFixed(0)}%, ROI ${r.roi > 0 ? "+" : ""}${r.roi.toFixed(0)}%.</span>` : ""}</div>`; }).join("") : ""; }).join("\n")}
</section>
<section id="rules"><h2>Contest rules <small>${RB ? "from last season's CFB contests like this one" : "backtest still running"}</small></h2>
${rules.length ? rules.map(r => { const fol = r.follow ?? r.lift >= 1; return `<div class="rule"><span class="v ${fol ? "f" : "a"}">${fol ? "DO" : "AVOID"}</span><span>${esc(r.rule)}<small>top-1% ×${(+r.lift).toFixed(2)} · t ${(+r.t).toFixed(1)}${r.n ? ` · n ${r.n}` : ""}</small></span></div>`; }).join("") : `<p class="note">${RB ? "No rule cleared the bar in the CFB sample." : "The CFB backtest hasn't finished; this section fills in when it does."}</p>`}
${RB && RB.takeaways ? `<ul>${RB.takeaways.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
</section>
<section id="notes"><h2>Notes</h2><ul>${(G.notes || []).map(n => `<li>${esc(n)}</li>`).join("")}</ul><p class="note">${esc(G.environment || "")}</p></section>
<footer>Sources: ${(G.sources || []).map(s => esc(s.name)).join(" · ")}. Projections and ownership: Stokastic.</footer>
</div>
`;
fs.writeFileSync(path.join(dir, "cfb-sheet.html"), html);
const conflicts = topBy("simP", 10).filter(e => e.fit.con.length).length;
console.log(`wrote ${path.join(dir, "cfb-sheet.html")}: ${N} lineups scored, ${players.length} player calls, ${rules.length} rules; ${conflicts} of the sim's top 10 conflict with the show`);
