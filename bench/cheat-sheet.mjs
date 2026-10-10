// Weekly cheat sheet (user-asked 2026-10-09): one phone-friendly page for an NFL classic slate, published as a private
// claude.ai artifact and republished to the same link each week after ETR's Wake and Rake is read on Sunday morning.
// Built from what the hub already has: data/<slate>/slate-guide.json (theses, stances, Lab likes and stacks), the hub's
// games/players/injuries (GET /api/hub, so the hub must be running), the report digests in data/<slate>/reads/*.md and the
// kept $100+ classic rules in data/reports/rulebook-nfl.json. Nothing here is scored; it only lays out what was read.
//   node bench/cheat-sheet.mjs data/2026-10-11-nfl-main      -> data/<slate>/cheat-sheet.html
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2]; if (!dir || !fs.existsSync(path.join(dir, "slate-guide.json"))) { console.error("usage: node bench/cheat-sheet.mjs data/<slate> (needs slate-guide.json)"); process.exit(1); }
const slate = path.basename(dir), readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const G = readJ(path.join(dir, "slate-guide.json")), H = await (await fetch(`http://localhost:8787/api/hub?dir=${slate}`)).json();
const RB = readJ("data/reports/rulebook-nfl.json") || { rows: [] }, reads = readJ(path.join(dir, "etr-reads.json")) || {};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nm = s => String(s || "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)$/, "").trim();
const rows = new Map(H.rows.map(r => [nm(r.name), r]));
const DST = { Cardinals: "ARI", Falcons: "ATL", Ravens: "BAL", Bills: "BUF", Panthers: "CAR", Bears: "CHI", Bengals: "CIN", Browns: "CLE", Cowboys: "DAL", Broncos: "DEN", Lions: "DET", Packers: "GB", Texans: "HOU", Colts: "IND", Jaguars: "JAX", Chiefs: "KC", Raiders: "LV", Chargers: "LAC", Rams: "LAR", Dolphins: "MIA", Vikings: "MIN", Patriots: "NE", Saints: "NO", Giants: "NYG", Jets: "NYJ", Eagles: "PHI", Steelers: "PIT", "49ers": "SF", Seahawks: "SEA", Buccaneers: "TB", Titans: "TEN", Commanders: "WAS" };
const rowOf = name => rows.get(nm(name)) || H.rows.find(r => r.pos === "DST" && (r.team === DST[name] || nm(r.name) === nm(name))) || null;
const pct = v => v == null ? "—" : `${(+v).toFixed(0)}%`, money = v => v ? `$${(v / 1000).toFixed(1)}K` : "—";
// split only where a sentence really ends: punctuation after a lowercase word of 2+ letters (or a closing bracket/quote),
// then a space and a capital. Keeps "54.5", "vs. a", "Jr. 5", "St. Brown", "No. 1" and "ESPN.com" in one piece.
const splitSentences = s => String(s || "").split(/(?<=(?:[a-z]{2}|[)\]'"’])[.!?])\s+(?=[A-Z"'])/);
const sentences = (s, n) => splitSentences(s).slice(0, n).join(" ").trim();
const kickoff = iso => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) + " CT";

// games, highest total first, each with the guide's thesis for that one game; theses spanning several games (or none) are
// slate-wide and shown once above the games. The call chip comes only from the guide's gameCalls (ETR Game Scores), never
// guessed from a thesis name.
const theses = G.theses || [], slateWide = theses.filter(t => (t.games || []).length !== 1);
const games = H.games.slice().sort((a, b) => b.total - a.total).map(g => {
  const fav = g.spread < 0 ? g.home : g.away, th = theses.filter(t => (t.games || []).length === 1 && t.games[0] === g.game);
  return { ...g, fav, line: `${fav} −${Math.abs(g.spread)}`, th, call: (G.gameCalls || {})[g.game] || null };
});
const CALL = { stack: ["stack", "Game stack"], mini: ["look", "Mini-stack"], pieces: ["", "Single players"], avoid: ["avoid", "Avoid"] };

// players by position from the stances, ordered core > leverage > value > caution > fade, then salary
const ORDER = { core: 0, leverage: 1, value: 2, caution: 3, fade: 4 }, POS = ["QB", "RB", "WR", "TE", "DST"];
const likeSet = new Set(Object.values((G.likes || {}).picks || {}).flat().map(p => nm(p.name))), fadeSet = new Set(((G.likes || {}).fades || []).map(p => nm(p.name || p)));
const players = Object.entries(G.stances || {}).map(([name, s]) => { const r = rowOf(name); return { name, ...s, r, pos: r ? r.pos.split("/")[0] : "?" }; });
const byPos = POS.map(p => [p, players.filter(x => x.pos === p).sort((a, b) => (ORDER[a.stance] ?? 9) - (ORDER[b.stance] ?? 9) || ((b.r && b.r.sal) || 0) - ((a.r && a.r.sal) || 0))]).filter(([, l]) => l.length);
const other = players.filter(x => !POS.includes(x.pos));

// late news: questionable / doubtful / out among the players the guide talks about, plus the guide's notes
const inj = players.filter(x => x.r && x.r.inj && /question|doubt|out/i.test(x.r.inj.status)).map(x => ({ name: x.name, team: x.r.team, status: x.r.inj.status, note: x.r.inj.note }));

// report digests, DFS sources only (user 2026-10-10: no season-long content; Matchups, Strength, Snaps and Pace, OL/DL and the
// Update Log feed facts into the guide but are not shown). Shows first, since that is where the late takes live.
const DFS_IDS = ["wake-rake", "lineup-build", "million", "show", "proj-context", "top-plays", "gpp-leverage", "game-scores", "leone-rb", "leone-wrte", "tourney-review", "cash-review", "blick"];
// team check: "Player (TEAM" in a digest must match the player's team on this slate; wrong ones are corrected and reported
const fixes = [];
const teamFix = s => s.replace(/([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+){1,3}) \(([A-Z]{2,3})\b/g, (m, name, tm) => { const r = rows.get(nm(name)); if (!r || !H.games.some(g => g.game.split("@").includes(tm)) || r.team === tm) return m; fixes.push(`${name}: ${tm} -> ${r.team}`); return `${name} (${r.team}`; });
const digests = fs.existsSync(path.join(dir, "reads")) ? fs.readdirSync(path.join(dir, "reads")).filter(f => f.endsWith(".md") && DFS_IDS.includes(f.replace(/\.md$/, ""))).map(f => {
  const t = fs.readFileSync(path.join(dir, "reads", f), "utf8").split(/\r?\n/), id = f.replace(/\.md$/, "");
  return { id, title: (t[0] || id).replace(/^#\s*/, ""), by: (t[1] || "").split("|")[0].trim(), bullets: t.filter(l => /^\s*-\s/.test(l)).map(l => teamFix(l.replace(/^\s*-\s*/, ""))) };
}).sort((a, b) => DFS_IDS.indexOf(a.id) - DFS_IDS.indexOf(b.id)) : [];
const missing = Object.keys(G.stances || {}).filter(n => !rowOf(n));

// $100+ classic checklist: the rulebook's kept rules for $100-299 and $300+, strongest first
const rules = RB.rows.filter(r => r.fmt === "classic" && r.kept && /^\$(100|300)/.test(r.seg)).sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
const checklist = [...new Map(rules.map(r => [r.rule, r])).values()].slice(0, 10);

const catalog = await (await fetch(`http://localhost:8787/api/etr-reads?dir=${slate}`)).json().then(r => r.catalog || []).catch(() => []);
const nameOf = id => (catalog.find(c => c.id === id) || {}).name || id;
const stacks = ((G.labStacks || {}).top || []).slice(0, 5), notReady = Object.entries(reads).filter(([k, v]) => v.status !== "ok" && (!catalog.length || catalog.some(c => c.id === k))).map(([k, v]) => ({ id: k, name: nameOf(k), note: v.note }));
const src = H.sources || {}, stamp = (label, v) => v ? `<span><b>${label}</b> ${esc(v)}</span>` : "";
const etrAt = src.etr && src.etr.checked, stkAt = src.stokastic && src.stokastic.projUpdated, blAt = src.blick && src.blick.checked;
const fmtAt = s => s ? new Date(s.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s) ? s : s + "Z").toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : null;
const week = (Object.values(reads).map(r => (String(r.title || "").match(/Week (\d+)/) || [])[1]).find(Boolean)) || "";

const chip = (cls, t) => `<span class="chip ${cls}">${esc(t)}</span>`;
const playerRow = x => { const r = x.r || {}, like = likeSet.has(nm(x.name)), lfade = fadeSet.has(nm(x.name));
  return `<details class="pl ${x.stance}"><summary><span class="nm">${esc(x.name)}${r.inj && /question|doubt|out/i.test(r.inj.status) ? ` <span class="q">${esc(r.inj.status[0])}</span>` : ""}</span><span class="tm">${esc(r.team || "")}</span><span class="num">${money(r.sal)}</span><span class="num">${r.lab != null ? (+r.lab).toFixed(1) : "—"}</span><span class="num">${pct(r.labOwn)}</span>${chip(x.stance, x.stance)}${like ? chip("lab", "Lab like") : lfade ? chip("labfade", "Lab fade") : ""}</summary><p>${esc(x.why)}</p><p class="by">${esc(x.source)}</p></details>`; };

const html = `<title>Slate Lab Cheat Sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Roboto:wght@400;500;700&display=swap">
<style>
:root{color-scheme:dark;--bg:#06070d;--bg2:#0a0c15;--field:#0e1222;--field2:#131833;--line:#171b2c;--line2:#242a42;--ink:#eef1ff;--ink2:#b7bfdc;--muted:#7f88a8;--neon:#19e6ff;--neonrgb:25,230,255;--green:#19ff8c;--greencell:#063a24;--pink:#ff3ded;--yellow:#ffd93d;--red:#ff4d6d;--redcell:#3a0f1c;
  --sans:"Roboto",system-ui,-apple-system,"Segoe UI",sans-serif;--cond:"Rajdhani","Roboto Condensed","Arial Narrow",sans-serif}
html,body{background:var(--bg)}
body{color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;padding-inline:16px;padding-block:0 48px;-webkit-font-smoothing:antialiased;background-image:radial-gradient(900px 320px at 0 -80px,rgba(var(--neonrgb),.08),transparent 60%)}
.wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
header{padding-top:18px;display:flex;flex-direction:column;gap:6px}
.brand{font-family:var(--cond);font-weight:700;letter-spacing:.14em;font-size:13px;color:var(--neon);text-transform:uppercase}
h1{font-family:var(--cond);font-weight:700;font-size:30px;line-height:1.05;margin:0;text-wrap:balance}
h2{font-family:var(--cond);font-weight:700;font-size:19px;letter-spacing:.06em;text-transform:uppercase;margin:0;color:var(--ink)}
h2 small{font-family:var(--sans);font-weight:400;font-size:12px;letter-spacing:0;text-transform:none;color:var(--muted);margin-left:8px}
.stamps{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted)} .stamps b{color:var(--ink2);font-weight:500}
nav{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:rgba(6,7,13,.92);backdrop-filter:blur(6px);margin-inline:-16px;padding:8px 16px;border-bottom:1px solid var(--line);display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
nav a{flex:none;font-family:var(--cond);font-weight:700;letter-spacing:.06em;font-size:14px;color:var(--ink2);text-decoration:none;padding:4px 10px;border:1px solid var(--line2);border-radius:14px}
nav a:hover,nav a:focus-visible{color:var(--neon);border-color:var(--neon)}
section{display:flex;flex-direction:column;gap:10px;scroll-margin-top:52px}
.warn{font-size:12.5px;color:var(--yellow);background:rgba(255,217,61,.07);border:1px solid rgba(255,217,61,.25);border-radius:6px;padding:8px 10px}
.game{border:1px solid var(--line2);background:var(--bg2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.game.stack{border-color:rgba(25,255,140,.45)} .game.avoid{opacity:.82}
.ghead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.ghead .mu{font-family:var(--cond);font-weight:700;font-size:20px;letter-spacing:.03em}
.ghead .ln{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
.ghead .ln b{color:var(--ink)}
.game p{margin:0;color:var(--ink2);font-size:13px}
.game p.call{color:var(--ink)} .game.wide{border-style:dashed}
details.more summary{cursor:pointer;font-size:12px;color:var(--neon);width:max-content} details.more p{margin-top:6px}
.legend{margin:0;font-size:12px;color:var(--muted);line-height:1.9}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:10px;border:1px solid currentColor;white-space:nowrap}
.chip.stack,.chip.core{color:var(--green)} .chip.look,.chip.leverage{color:var(--neon)} .chip.avoid,.chip.fade{color:var(--red)} .chip.value{color:var(--yellow)} .chip.caution{color:#ffa94d} .chip.lab{color:var(--pink)} .chip.labfade{color:var(--muted)}
.pos{display:flex;flex-direction:column;gap:2px}
.pos h3{font-family:var(--cond);font-size:15px;letter-spacing:.08em;color:var(--muted);margin:8px 0 2px}
.hdr,.pl summary{display:grid;grid-template-columns:minmax(0,1fr) 38px 50px 42px 40px auto;gap:6px;align-items:center}
.hdr{font-size:11px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;padding:0 8px}
.hdr span:nth-child(n+3){text-align:right}
.pl{border-bottom:1px solid var(--line)}
.pl summary{list-style:none;cursor:pointer;padding:7px 8px;border-left:3px solid transparent}
.pl summary::-webkit-details-marker{display:none}
.pl.core summary{border-left-color:var(--green)} .pl.leverage summary{border-left-color:var(--neon)} .pl.value summary{border-left-color:var(--yellow)} .pl.caution summary{border-left-color:#ffa94d} .pl.fade summary{border-left-color:var(--red)}
.pl summary:hover{background:var(--field)}
.nm{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .tm{color:var(--muted);font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
.q{display:inline-block;font-size:10px;font-weight:700;color:#0b0f14;background:var(--yellow);border-radius:3px;padding:0 4px;margin-left:4px;vertical-align:1px}
.pl p{margin:0 8px 8px 11px;font-size:13px;color:var(--ink2)} .pl p.by{font-size:11.5px;color:var(--muted)}
.stk{border:1px solid var(--line2);border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:3px;background:var(--bg2)}
.stk .top{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.stk b{font-family:var(--cond);font-size:17px;letter-spacing:.03em}
.stk .meta{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px} li{color:var(--ink2);font-size:13px}
.news li b{color:var(--ink)}
details.dg{border:1px solid var(--line2);border-radius:8px;background:var(--bg2)}
details.dg summary{cursor:pointer;padding:9px 12px;font-weight:500;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
details.dg summary span{font-size:12px;color:var(--muted);font-weight:400}
details.dg ul{padding:0 14px 12px 30px}
.rule{display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;font-size:13px;padding:5px 0;border-bottom:1px solid var(--line)}
.rule .v{font-family:var(--cond);font-weight:700;letter-spacing:.06em} .rule .v.f{color:var(--green)} .rule .v.a{color:var(--red)}
.rule small{color:var(--muted);display:block}
footer{font-size:12px;color:var(--muted)}
:focus-visible{outline:2px solid var(--neon);outline-offset:2px}
@media (max-width:480px){.hdr,.pl summary{grid-template-columns:minmax(0,1fr) 44px 38px 36px auto}.hdr span:nth-child(2),.pl summary .tm{display:none}h1{font-size:26px}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style>
<div class="wrap">
<header>
  <div class="brand">Slate Lab · cheat sheet</div>
  <h1>Week ${esc(week)} Main · ${esc(new Date(G.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }))} · ${H.games.length} games</h1>
  <div class="stamps">${stamp("Lock", kickoff(H.games.map(g => g.start).sort()[0]))}${stamp("ETR", fmtAt(etrAt))}${stamp("Stokastic", fmtAt(stkAt))}${stamp("Blick", fmtAt(blAt))}${stamp("Built", fmtAt(new Date().toISOString()))}</div>
</header>
<nav aria-label="Sections"><a href="#games">Games</a><a href="#players">Players</a><a href="#stacks">Stacks</a><a href="#news">Late news</a><a href="#shows">Shows</a><a href="#rules">$100+ rules</a></nav>
${notReady.length ? `<div class="warn">Not read yet: ${notReady.map(x => esc(x.name)).join(", ")}. This sheet updates after they are.</div>` : ""}
<section id="games"><h2>Games <small>highest total first · lines from Pinnacle</small></h2>
${slateWide.map(t => `<div class="game wide"><p><b>${esc(t.name)}.</b> ${esc(t.summary)}</p></div>`).join("\n")}
${games.map(g => { const c = g.call && CALL[g.call.call], more = g.th.map(t => splitSentences(t.summary)).filter(s => s.length > 2);
  return `<div class="game ${c ? c[0] : ""}"><div class="ghead"><span class="mu">${esc(g.away)} @ ${esc(g.home)}</span><span class="ln"><b>${g.total}</b> total · ${esc(g.line)} · ${esc(g.away)} ${g.ttAway} / ${esc(g.home)} ${g.ttHome}</span>${c ? chip(c[0], c[1]) : ""}</div>${g.call ? `<p class="call">${esc(g.call.why)}</p>` : ""}${g.th.map(t => `<p><b>${esc(t.name)}.</b> ${esc(sentences(t.summary, 2))}</p>`).join("")}${more.length ? `<details class="more"><summary>More on this game</summary>${g.th.map(t => `<p>${esc(splitSentences(t.summary).slice(2).join(" "))}</p>`).join("")}</details>` : ""}</div>`; }).join("\n")}
</section>
<section id="players"><h2>Players <small>tap a name for why</small></h2>
<p class="legend">${chip("core", "core")} ${chip("leverage", "leverage")} ${chip("value", "value")} ${chip("caution", "caution")} ${chip("fade", "fade")} are ETR's calls, as written up in the guide. ${chip("lab", "Lab like")} ${chip("labfade", "Lab fade")} is Slate Lab's own model, which can disagree. Calls come only from ETR's DFS pieces (core = their main GPP plays, at any ownership). Proj and Own are Slate Lab's blend.</p>
<div class="hdr"><span>Player</span><span>Team</span><span>Salary</span><span>Proj</span><span>Own</span><span></span></div>
${byPos.map(([p, l]) => `<div class="pos"><h3>${p}</h3>${l.map(playerRow).join("")}</div>`).join("\n")}
${other.length ? `<div class="pos"><h3>Not on the DK slate</h3>${other.map(playerRow).join("")}</div>` : ""}
</section>
<section id="stacks"><h2>Lab stacks <small>field share vs Blick's projection</small></h2>
${stacks.map(s => `<div class="stk"><div class="top"><b>${esc(s.qb)}</b><span>+ ${esc((s.catchers || []).join(", "))}${s.bringBack ? ` · bring back ${esc(s.bringBack.name)}` : ""}</span></div><div class="meta">${esc(s.team)} vs ${esc(s.opp)} · field ${s.freq != null ? (+s.freq).toFixed(1) + "%" : "—"} · Blick ${s.blick != null ? (+s.blick).toFixed(1) + "%" : "—"} · top-1% rate ${s.t1x != null ? (+s.t1x).toFixed(2) + "x" : "—"}</div></div>`).join("\n") || '<p class="by">No Lab stacks yet: run the sim on the Simulator first.</p>'}
</section>
<section id="news"><h2>Late news</h2>
<ul class="news">${inj.map(i => `<li><b>${esc(i.name)}</b> (${esc(i.team)}) ${esc(i.status)}: ${esc(sentences(i.note, 1))}</li>`).join("")}${(G.notes || []).filter(n => String(n).trim().length > 2).map(n => `<li>${esc(n)}</li>`).join("")}</ul>
${inj.length || (G.notes || []).some(n => String(n).trim().length > 2) ? "" : '<p class="by">Nothing flagged yet.</p>'}
</section>
<section id="shows"><h2>From the reports <small>${digests.length} read</small></h2>
${digests.map(d => `<details class="dg"${d.id === "wake-rake" ? " open" : ""}><summary>${esc(d.title)} <span>${esc(d.by)}</span></summary><ul>${d.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul></details>`).join("\n")}
</section>
<section id="rules"><h2>$100+ checklist <small>your contests, strongest first</small></h2>
<div>${checklist.map(r => `<div class="rule"><span class="v ${r.follow ? "f" : "a"}">${r.follow ? "DO" : "AVOID"}</span><span>${esc(r.rule.replace(/^ETR( BB)?: /, ""))}<small>${esc(r.seg)} · top-1% ×${(+r.lift).toFixed(2)} · t ${r.t}</small></span></div>`).join("")}</div>
</section>
<footer>Sources: ${(G.sources || []).map(s => esc(s.name)).join(" · ")}. Lab projection and ownership from Slate Lab's blend.</footer>
</div>
`;
const out = path.join(dir, "cheat-sheet.html"); fs.writeFileSync(out, html);
console.log(`wrote ${out}: ${games.length} games, ${players.length} players, ${stacks.length} stacks, ${digests.length} digests, ${checklist.length} rules${notReady.length ? `; not read yet: ${notReady.map(x => x.id).join(", ")}` : ""}`);
if (fixes.length) console.log(`corrected teams in digests: ${fixes.join("; ")}`);
if (missing.length) console.log(`stance players not on this DK slate: ${missing.join(", ")}`);
