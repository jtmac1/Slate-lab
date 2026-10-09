// Lab rules Brain (user-asked 2026-10-09, "a brain independent of Claude"): the same card the Slate Brain writes (letter
// grade, the bet, a short take, for / against) built only from what the hub already measured for each lineup: the 0-100
// grade (sim percentile + the rulebook from the user's past contests + the slate guide and the user's own reads), field vs
// sites ownership, expected duplicates and the game scripts it wins in. No model call, same answer every time, so the
// weekly scoreboard (bench/grade-picks-nfl.mjs, strategy "rulesbrain") can show whether its A lineups beat its C lineups.
// Saved apart from Claude's reviews: data/<slate>/brain-rules.json.
import fs from "node:fs";
import path from "node:path";
import { loadSimRun } from "./contestsim.mjs";

export const MODEL_RULES = "Lab rules";
const LETTERS = [[90, "A"], [80, "A-"], [70, "B+"], [60, "B"], [50, "B-"], [40, "C+"], [30, "C"], [15, "D"], [-1, "F"]];
export const letterOf = g => LETTERS.find(([min]) => g >= min)[1];
const isD = p => /^(DST|D|DEF)$/i.test(p.pos || "");
const short = n => String(n).split(" ").slice(-1)[0];

// the bet in a few words: the slate guide's thesis when the lineup fits one, else its stack
function thesisOf(e, sd) {
  if (e.theses && e.theses.length) return String(e.theses[0]);
  const P = e.players || [];
  if (sd) { const c = P[0], tc = {}; for (const p of P) tc[p.team] = (tc[p.team] || 0) + 1; const split = Object.entries(tc).sort((a, b) => b[1] - a[1]); return c ? `${short(c.name)} captain, ${split.map(([, n]) => n).join("-")} ${split[0][0]}` : "showdown build"; }
  const qb = P.find(p => p.pos === "QB"); if (!qb) return "no QB";
  const stack = P.filter(p => p !== qb && p.team === qb.team && /^(WR|TE|RB)$/.test(p.pos)).length, bring = P.filter(p => p.team === qb.opp && !isD(p)).length;
  return stack ? `${qb.team} ${short(qb.name)} + ${stack}${bring ? `, ${bring} bring-back` : ", no bring-back"}` : `naked ${short(qb.name)}`;
}
export function rulesReview(e, sd) {
  const G = e.grade; if (!G) return null;
  const pro = [], con = [], n = e.notes || { for: [], against: [] }, s = e.sim || {};
  for (const r of (G.rules || []).slice().sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))) (r.pts > 0 ? pro : con).push(`Your contests: ${r.name} (top-1% lift ${(+r.lift || 0).toFixed(2)}x)`);
  for (const x of n.for) pro.push(`${x.kind}: ${x.names.join(", ")}${x.note ? ` (${String(x.note).slice(0, 80)})` : ""}`);
  for (const x of n.against) con.push(`${x.kind}: ${x.names.join(", ")}${x.note ? ` (${String(x.note).slice(0, 80)})` : ""}`);
  if (e.fieldDelta != null && e.fieldDelta <= -5) pro.push(`Field plays it ${Math.abs(e.fieldDelta)} points lighter than the sites say`);
  if (e.fieldDelta != null && e.fieldDelta >= 5) con.push(`Field plays it ${e.fieldDelta} points heavier than the sites say`);
  if (s.dupN != null && s.dupN < 0.3) pro.push("Rarely duplicated"); else if (s.dupN >= 1.5) con.push(`Expect ${(+s.dupN).toFixed(1)} copies in the field`);
  if (G.parts.sim >= 80) pro.push(`Sim ROI in the top ${100 - G.parts.sim || 1}% of this pool`); else if (G.parts.sim <= 30) con.push("Sim ROI in the bottom third of this pool");
  if (e.wins && e.wins.length) pro.push(`Wins when ${e.wins[0].name}`);
  const take = `${G.grade}/100: sim ${G.parts.sim}, your rulebook ${G.parts.rules}${G.parts.guide == null ? "" : `, notes ${G.parts.guide}`}. ${pro[0] ? `Best case for it: ${pro[0]}.` : ""} ${con[0] ? `Biggest worry: ${con[0]}.` : ""}`.replace(/\s+/g, " ").trim();
  return { grade: letterOf(G.grade), thesis: thesisOf(e, sd), take, for: pro.slice(0, 5), against: con.slice(0, 5), model: MODEL_RULES };
}
export const loadRules = dir => { try { return JSON.parse(fs.readFileSync(path.join("data", dir, "brain-rules.json"), "utf8")); } catch { return { reviews: {} }; } };
// review the lineups by signature (same set as the Claude Brain: favorites + top 50) and save them
export function reviewByRules(dir, sigs) {
  const R = loadSimRun(dir); if (!R || !R.rows) throw new Error("run the Pre-Contest Simulator first");
  const sd = R.format === "nfl_sd", by = new Map(R.rows.map(e => [e.sig, e])), at = new Date().toISOString(), out = {};
  if (!R.rows.some(e => e.grade)) throw new Error("no lineup grades yet: the rulebook report (data/reports/rulebook-nfl.json) is missing");
  for (const s of new Set(sigs)) { const e = by.get(s), r = e && rulesReview(e, sd); if (r) out[s] = Object.assign(r, { at }); }
  const B = { at, reviews: out };
  fs.writeFileSync(path.join("data", dir, "brain-rules.json"), JSON.stringify(B));
  return { reviews: out, done: Object.keys(out).length, model: MODEL_RULES };
}
