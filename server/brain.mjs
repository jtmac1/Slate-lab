// Slate Brain: a live model reads the slate's knowledge (slate guide with theses and player
// stances, the Notes tab, lines, Model own, injuries) and writes a short review of each lineup
// the user is actually choosing between (favorites + the top of the Pre-Contest Simulator), plus a
// portfolio check across the favorites. Reviews are cached in data/<slate>/brain.json keyed by
// lineup signature and invalidated when the guide or notes change. Key: ANTHROPIC_API_KEY or
// data/anthropic.key (data/ is gitignored). Model: SLATELAB_BRAIN_MODEL or claude-sonnet-5.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hubData } from "./sources.mjs";
import { loadGuide } from "./entries.mjs";
import { slateData } from "./etrdata.mjs";
import { loadLikes, likesText } from "./likes.mjs";
import { loadStacks, stacksText } from "./stacks.mjs";
import { loadSimRun } from "./contestsim.mjs";

const MODEL = process.env.SLATELAB_BRAIN_MODEL || "claude-sonnet-5", BATCH = 8;
const keyOf = () => { if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY; try { return fs.readFileSync("data/anthropic.key", "utf8").trim(); } catch { return null; } };
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
// the user's free notes (older slates and showdown) plus the Blick slate thoughts he pastes in the Notes tab's report list
const readT = (dir, f) => { try { return fs.readFileSync(path.join("data", dir, f), "utf8").trim(); } catch { return ""; } };
const notesText = dir => { const n = readT(dir, "notes.md"), b = readT(dir, "blick-thoughts.md"); return [n, b && `BLICK SLATE THOUGHTS (pasted by the user):\n${b}`].filter(Boolean).join("\n\n"); };
const hash = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
export const brainStatus = dir => { const b = readJ(path.join("data", dir, "brain.json")); return { key: !!keyOf(), model: MODEL, reviews: b ? Object.keys(b.reviews || {}).length : 0, portfolio: b ? b.portfolio || null : null, at: b ? b.at : null }; };
export const loadBrain = dir => readJ(path.join("data", dir, "brain.json")) || { reviews: {}, portfolio: null };

// what the brain knows about the slate, built once per call
function slateContext(dir) {
  const hub = hubData(dir), guide = loadGuide(dir), notes = notesText(dir), sd = hub.slate.type === "SHOWDOWN";
  const games = (hub.games || []).map(g => `${g.away}@${g.home}${g.spread != null ? ` home spread ${g.spread}` : ""}${g.total != null ? ` total ${g.total}` : ""}${g.ttAway != null ? ` team totals ${g.away} ${g.ttAway} / ${g.home} ${g.ttHome}` : ""}${g.dTotal ? ` (total moved ${g.dTotal > 0 ? "+" : ""}${g.dTotal})` : ""}${g.dSpread ? ` (spread moved ${g.dSpread > 0 ? "+" : ""}${g.dSpread})` : ""}`).join("\n");
  const top = hub.rows.filter(r => (r.labOwn ?? r.own ?? 0) >= 5 || (r.lab ?? 0) >= 12).sort((a, b) => (b.labOwn ?? b.own ?? 0) - (a.labOwn ?? a.own ?? 0)).slice(0, 45)
    .map(r => `${r.name} ${r.pos} ${r.team} $${r.sal} proj ${r.lab ?? r.cons ?? "?"} sites own ${(r.vown ?? r.own ?? 0).toFixed(0)}% model own ${(r.labOwn ?? r.own ?? 0).toFixed(0)}%${r.ownDelta != null && Math.abs(r.ownDelta) >= 2 ? ` (${r.ownDelta > 0 ? "field heavier" : "field lighter"} ${r.ownDelta > 0 ? "+" : ""}${r.ownDelta})` : ""}${r.spread >= 4 ? ` sources disagree by ${r.spread}` : ""}${r.inj ? ` INJ ${r.inj.status}` : ""}`).join("\n");
  const g = guide ? JSON.stringify({ lines: guide.lines, environment: guide.environment, theses: guide.theses, stances: guide.stances, topPlays: guide.topPlays, stacks: guide.stacks, games: guide.games, structure: guide.structure, construction: guide.construction, cptPool: guide.cptPool, simCpt: guide.simCpt, cptPairs: guide.cptPairs, notes: guide.notes }, null, 0) : "none";
  // evergreen classic playbook (data/strategy/nfl-classic-playbook.json): standing rules for every NFL classic slate
  const pb = !sd && /nfl/i.test(dir) ? readJ("data/strategy/nfl-classic-playbook.json") : null;
  const play = pb ? `\n\nEVERGREEN NFL CLASSIC PLAYBOOK (ETR: ${(pb.sources || [{ name: pb.source }]).map(s => s.name).join("; ")}.; the slate guide wins on conflicts, and flag any conflict with the user's measured rulebook):\n${pb.rules.map(r => `- ${r.rule}${r.measured && !/^Not measured/.test(r.measured) ? ` [Tested on the user's contest archive: ${r.measured}]` : ""}`).join("\n")}\n\nUSER'S MEASURED RULEBOOK (t-stats from 569 real DK NFL contests, 844k lineups):\n${(pb.measured || []).map(r => `- ${r}`).join("\n")}` : "";
  // ETR's data tables for this slate (guide.data, server/etrdata.mjs); context only - they are being tracked for predictive value
  const dd = (guide && guide.data) || slateData(dir), xfp = dd && dd.xfp ? Object.entries(dd.xfp.players).filter(([, v]) => v.xfp >= 8).sort((a, b) => a[1].gap - b[1].gap) : [];
  const data = dd ? `\n\nETR DATA TABLES (context, not yet validated on the user's results; weigh lightly):\n${dd.edges.map(e => `- ${e}`).join("\n")}${dd.dvp ? `\nDvP ${dd.dvp.note} (published ${dd.dvp.published}): ${Object.entries(dd.dvp.vs).map(([t, v]) => `${t} D QB ${v.QB} RB ${v.RB} WR ${v.WR} TE ${v.TE}`).join("; ")}` : ""}${xfp.length ? `\nXFP per game, gap = actual - expected (published ${dd.xfp.published}): ${xfp.slice(0, 12).map(([n, v]) => `${n} ${v.xfp}/${v.actual} (${v.gap > 0 ? "+" : ""}${v.gap})`).join("; ")}` : ""}${dd.proe ? `\nPROE % (published ${dd.proe.published}): ${Object.entries(dd.proe.teams).map(([t, v]) => `${t} ${v.proe}`).join(", ")}` : ""}${dd.contestSel ? `\nContest selection (Levitan): ${dd.contestSel.join(" | ")}` : ""}` : "";
  // the Lab likes (server/likes.mjs): unfitted, tracked by bench/likes-tracker-nfl.mjs
  const ls = loadStacks(dir), lk = loadLikes(dir), likes = (ls ? `\n\nLAB STACKS (from the simulator's field + sim and Blick's conditional ownership; unfitted, tracked):\n${stacksText(ls)}` : "") + (lk ? `\n\nLAB LIKES (the Lab's own unfitted picks by position from projection, value, leverage and ETR's tables; still being tracked, treat as a second opinion):\n${likesText(lk)}` : "");
  const text = `SLATE: ${hub.slate.name || dir} (${sd ? "DraftKings Showdown" : "DraftKings Classic"})\n\nGAMES AND LINES (Pinnacle):\n${games || "n/a"}${play}${data}${likes}\n\nSLATE GUIDE (from ETR's breakdown / sim analysis and Blick's notes; theses = the ways the slate can play out, stances = per-player reads):\n${g}\n\nUSER NOTES TAB (Blick Discord and the user's own notes, verbatim):\n${notes.trim() || "(empty)"}\n\nPLAYER TABLE (Lab projection, the sites' projected ownership, Model own = our prediction of the field's real ownership from 317 real contests):\n${top}`;
  return { hub, guide, sd, text, stamp: hash(text) };
}
const lineupText = e => `${e.players.map(p => `${p.slot} ${p.name} (${p.pos} ${p.team} $${p.sal}, proj ${p.lab ?? p.proj ?? "?"}, sites own ${(p.own ?? 0).toFixed(0)}%, model own ${(p.fown ?? p.own ?? 0).toFixed(0)}%)`).join("; ")}. Salary $${e.sal} ($${e.left} left). Stack: ${e.type}. Sim: Lab ROI ${e.sim.lab}% (${e.sim.sources.map(s => `${s} ${e.sim[s].roi}% #${e.sim[s].rank}`).join(", ")}), top-10% ${e.sim.t10}%, win ${e.sim.win}%, expected copies in the field ${e.sim.dupN}. Field ownership sum ${e.fieldOwn}%${e.fieldDelta != null ? `, field vs sites ${e.fieldDelta > 0 ? "+" : ""}${e.fieldDelta}` : ""}.${e.theses && e.theses.length ? ` Thesis tags: ${e.theses.join(", ")}.` : ""}${e.wins && e.wins.length ? ` Wins when (game scripts behind its top-1% sim finishes): ${e.wins.map(w => `${w.name} ${w.share}%`).join("; ")}.` : ""}`;

async function ask(key, system, user, maxTokens = 1800) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }) });
  if (!r.ok) throw new Error(`brain ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json(), text = (j.content || []).map(c => c.text || "").join("");
  const m = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/); if (!m) throw new Error("brain returned no JSON");
  return { data: JSON.parse(m[0]), usage: j.usage };
}
const SYSTEM = `You are the Slate Brain for a DraftKings NFL player who enters one to three lineups per contest and wants to play like the consistent winners: stack the QB, bring back the opponent, use the chalk the field underprices, avoid the duplicated near-optimal build, and bet a clear thesis about how the slate plays out. You are given everything known about the slate. Review lineups the way a sharp friend who read every article would: name the bet the lineup is making, say what the notes and the data support and what they argue against, and grade it. Be specific to this slate; never recite generic DFS advice. Treat the sim numbers as one input, not the verdict: a lineup can be +ROI in the sim and still be a bad bet if it is the field's obvious build or bets against the notes. Keep every take under 60 words. Answer only with JSON.`;

// review: the lineups by signature (favorites + top of the sim). Returns { reviews: {sig: {...}}, done, cached, usage }
export async function reviewLineups(dir, sigs, opts = {}) {
  const key = keyOf(); if (!key) throw new Error("no API key: set ANTHROPIC_API_KEY or write it to data/anthropic.key");
  const R = loadSimRun(dir); if (!R || !R.rows) throw new Error("run the Pre-Contest Simulator first");
  const ctx = slateContext(dir), B = loadBrain(dir); if (B.stamp !== ctx.stamp) { B.reviews = {}; B.portfolio = null; B.stamp = ctx.stamp; }
  const bySig = new Map(R.rows.map(e => [e.sig, e])), want = sigs.map(s => bySig.get(s)).filter(Boolean), todo = want.filter(e => !B.reviews[e.sig]).slice(0, opts.max || 80);
  let usage = { in: 0, out: 0 };
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const user = `${ctx.text}\n\nREVIEW THESE LINEUPS. For each, return {"i": index, "grade": "A"|"A-"|"B+"|"B"|"B-"|"C+"|"C"|"D"|"F", "thesis": "the bet in 3-8 words", "take": "under 60 words", "for": ["short point", ...], "against": ["short point", ...]}. Return a JSON array in the same order.\n\n${batch.map((e, k) => `[${k}] ${lineupText(e)}`).join("\n\n")}`;
    const { data, usage: u } = await ask(key, SYSTEM, user, 400 * batch.length);
    usage.in += u?.input_tokens || 0; usage.out += u?.output_tokens || 0;
    (Array.isArray(data) ? data : [data]).forEach((d, k) => { const e = batch[d.i ?? k]; if (e) B.reviews[e.sig] = { grade: d.grade, thesis: d.thesis, take: d.take, for: d.for || [], against: d.against || [], at: new Date().toISOString(), model: MODEL }; });
  }
  B.at = new Date().toISOString();
  fs.writeFileSync(path.join("data", dir, "brain.json"), JSON.stringify(B));
  return { reviews: Object.fromEntries(want.map(e => [e.sig, B.reviews[e.sig]]).filter(([, v]) => v)), done: todo.length, cached: want.length - todo.length, usage, model: MODEL };
}
// portfolio: the favorites as a set; what they bet on together, where they overlap, what they leave out
export async function reviewPortfolio(dir, sigs) {
  const key = keyOf(); if (!key) throw new Error("no API key: set ANTHROPIC_API_KEY or write it to data/anthropic.key");
  const R = loadSimRun(dir); if (!R || !R.rows) throw new Error("run the Pre-Contest Simulator first");
  const ctx = slateContext(dir), B = loadBrain(dir); if (B.stamp !== ctx.stamp) { B.reviews = {}; B.portfolio = null; B.stamp = ctx.stamp; }
  const bySig = new Map(R.rows.map(e => [e.sig, e])), favs = sigs.map(s => bySig.get(s)).filter(Boolean); if (!favs.length) throw new Error("no favorites to check");
  const user = `${ctx.text}\n\nPORTFOLIO CHECK. These are the lineups the user plans to enter together. Return {"take": "under 100 words on what this set bets on and whether it is one thesis or several", "overlap": ["players or stacks shared by most of them"], "missing": ["theses or leverage from the notes with no exposure"], "swap": "one concrete change that would improve the set, under 40 words"}.\n\n${favs.map((e, k) => `[${k}] ${lineupText(e)}`).join("\n\n")}`;
  const { data, usage } = await ask(key, SYSTEM, user, 900);
  B.portfolio = Object.assign({ sigs, at: new Date().toISOString(), model: MODEL }, data);
  fs.writeFileSync(path.join("data", dir, "brain.json"), JSON.stringify(B));
  return { portfolio: B.portfolio, usage: { in: usage?.input_tokens || 0, out: usage?.output_tokens || 0 } };
}
