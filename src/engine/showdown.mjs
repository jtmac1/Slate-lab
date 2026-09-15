// Showdown structures: what a lineup looks like before you look at the names.
// Structure = captain position | team split of all six | kicker+defense count | QB count.
import { FORMATS } from "./formats.mjs";
import { sigOf } from "./lineups.mjs";

export function structureOf(lu, P) {
  const tc = {}; let kd = 0, qb = 0;
  for (const id of lu) { const p = P[id]; tc[p.team] = (tc[p.team] || 0) + 1; if (p.pos === "K" || p.pos === "DST") kd++; if (p.pos === "QB") qb++; }
  const split = Object.values(tc).sort((a, b) => b - a).join("-");
  return `${P[lu[0]].pos}|${split}|${kd}K/D|${qb}QB`;
}

// Every legal showdown lineup (six distinct players, captain 1.5x salary, under the cap, both
// teams present), bucketed by structure and keeping the top `perStructure` by projection.
// Players with no ownership and no projection are skipped: they are not in anyone's pool.
// Returns { [structure]: [{ lu, proj, sal, own }] } sorted best first.
export function enumerateShowdown(pool, opts = {}) {
  const f = pool.format || FORMATS.nfl_sd, cap = f.cap, per = opts.perStructure || 1, minFrac = opts.minFrac || 0, P = pool.players;
  const ids = P.map((p, i) => i).filter(i => (P[i].own > 0 || P[i].cown > 0 || P[i].proj > 0) && P[i].sal > 0).sort((a, b) => P[a].sal - P[b].sal);
  const n = ids.length, sal = ids.map(i => P[i].sal), proj = ids.map(i => P[i].proj), csal = ids.map(i => P[i].csal || P[i].sal * 1.5);
  const own = ids.map(i => P[i].fown ?? P[i].own ?? 0), cown = ids.map(i => P[i].cown ?? 0);
  // loose upper bound on what `need` more players plus the captain bonus can add: the largest projections overall
  const topProj = proj.slice().sort((a, b) => b - a), topSum = [0]; for (let q = 0; q < 6; q++) topSum.push(topSum[q] + (topProj[q] || 0));
  const out = {}, pick = new Int32Array(6); let globalBest = 0;
  const consider = (structure, lu, pr, sl, ow) => {
    if (pr > globalBest) globalBest = pr;
    const arr = out[structure] || (out[structure] = []);
    if (arr.length < per) { arr.push({ lu, proj: pr, sal: sl, own: ow }); arr.sort((a, b) => b.proj - a.proj); }
    else if (pr > arr[arr.length - 1].proj) { arr[arr.length - 1] = { lu, proj: pr, sal: sl, own: ow }; arr.sort((a, b) => b.proj - a.proj); }
  };
  const rec = (start, depth, sumSal, sumProj) => {
    if (depth === 6) {
      // choose the captain among the six; salary with captain = sum + 0.5 * captain salary
      for (let c = 0; c < 6; c++) {
        const k = pick[c], total = sumSal + csal[k] - sal[k]; if (total > cap) continue;
        const lu = [ids[k]]; for (let q = 0; q < 6; q++) if (q !== c) lu.push(ids[pick[q]]);
        const tc = {}; for (const id of lu) tc[P[id].team] = (tc[P[id].team] || 0) + 1;
        if (Object.keys(tc).length < 2) continue;
        let ow = cown[k]; for (let q = 0; q < 6; q++) if (q !== c) ow += own[pick[q]];
        consider(structureOf(lu, P), lu, sumProj + 0.5 * proj[k], total, ow);
      }
      return;
    }
    const need = 6 - depth;
    if (minFrac && sumProj + topSum[need] + 0.5 * topProj[0] < minFrac * globalBest) return;
    for (let k = start; k < n; k++) {
      // remaining slots must at least afford the cheapest remaining players; sorted so sal[k..] ascending
      if (k + need - 1 >= n) break;
      let minRest = 0; for (let q = 1; q < need; q++) minRest += sal[k + q];
      if (sumSal + sal[k] + minRest > cap) break;
      pick[depth] = k; rec(k + 1, depth + 1, sumSal + sal[k], sumProj + proj[k]);
    }
  };
  rec(0, 0, 0, 0);
  if (minFrac) for (const k in out) out[k] = out[k].filter(b => b.proj >= minFrac * globalBest);
  return out;
}

// How different a lineup is from a field: exact copies in it, and the fewest players it
// differs by from any field lineup (6 = shares nobody's build, 0 = a copy).
export function fieldIndex(field, f) {
  const sig = {}; for (const l of field) { const k = sigOf(l, f); sig[k] = (sig[k] || 0) + 1; }
  return { sig, field };
}
export function distinctness(lu, idx, f) {
  const dupes = idx.sig[sigOf(lu, f)] || 0;
  const set = new Set(lu); let best = 0;
  for (const l of idx.field) { let same = 0; for (const id of l) if (set.has(id)) same++; if (same > best) { best = same; if (best === lu.length) break; } }
  return { dupes, nearest: lu.length - best };
}

// The full report for the app: every structure (best `per` lineups each), its share of the
// field, how close its best is to the optimum, and how distinct those lineups are from the field.
export function structureReport(pool, field, opts = {}) {
  const f = pool.format || FORMATS.nfl_sd, P = pool.players, per = opts.perStructure || 40;
  const best = enumerateShowdown(pool, { perStructure: per, minFrac: opts.minFrac ?? 0.9 });
  const idx = fieldIndex(field, f), share = {};
  for (const l of field) { const k = structureOf(l, P); share[k] = (share[k] || 0) + 100 / field.length; }
  const top = Math.max(0, ...Object.values(best).map(b => b.length ? b[0].proj : 0));
  return Object.keys(best).filter(k => best[k].length).map(k => ({
    structure: k, share: share[k] || 0, optimal: top ? 100 * best[k][0].proj / top : 0,
    lineups: best[k].map((b, i) => Object.assign({}, b, i < (opts.distinctTop ?? 12) ? distinctness(b.lu, idx, f) : {}))
  })).sort((a, b) => (b.optimal - b.share) - (a.optimal - a.share));
}

// The game a lineup needs, read off the draws where it finishes top 1% (row.story from
// simulate with story: true): each team's total and passing or rushing game against
// expectation, and how many of the field's six chalkiest players fade in those draws.
export function storyText(pool, r) {
  const P = pool.players, m = r.story && r.story.mult; if (!m || !r.story.wins) return "";
  const agg = {}; const add = (k, id) => { const a = agg[k] || (agg[k] = { e: 0, w: 0 }); a.e += P[id].proj; a.w += P[id].proj * m[id]; };
  for (const p of P) { if (!p.team || p.proj <= 0 || (p.own <= 0 && p.cown <= 0)) continue; add(p.team, p.i); if (p.pos === "QB" || p.pos === "WR" || p.pos === "TE") add(p.team + " pass", p.i); if (p.pos === "RB") add(p.team + " run", p.i); }
  const pct = k => agg[k] && agg[k].e ? Math.round(100 * (agg[k].w / agg[k].e - 1)) : 0, sgn = v => (v >= 0 ? "+" : "") + v + "%";
  const parts = pool.teams.map(t => { const bits = [`${t} ${sgn(pct(t))}`]; const pa = pct(t + " pass"), ru = pct(t + " run"); if (Math.abs(pa - ru) >= 15) bits.push(pa > ru ? `pass ${sgn(pa)}` : `run ${sgn(ru)}`); return bits.join(" "); });
  const inLu = new Set(r.lu), chalk = P.filter(p => !inLu.has(p.i) && p.own > 0).sort((a, b) => (b.fown ?? b.own) - (a.fown ?? a.own)).slice(0, 6);
  const fades = chalk.filter(p => m[p.i] < 0.8).length;   // a hard fade: the chalk player lands 20%+ under his usual score
  return parts.join(" · ") + (chalk.length ? ` · chalk busts ${fades}/${chalk.length}` : "");
}

// Rank structures for "be different cheaply": rare in the field, yet close to the best
// projection available. field = array of lineups (real or generated); best = enumerateShowdown output.
export function rankStructures(field, P, best) {
  const share = {}; for (const lu of field) { const k = structureOf(lu, P); share[k] = (share[k] || 0) + 100 / field.length; }
  const top = Math.max(...Object.values(best).map(b => b[0].proj));
  return Object.keys(best).map(k => ({ structure: k, share: share[k] || 0, optimal: 100 * best[k][0].proj / top, best: best[k] }))
    .sort((a, b) => (b.optimal - b.share) - (a.optimal - a.share));
}
