// Contest picker (user, 2026-10-14: DraftKings only, a ranked list). Each lobby contest for the slate, ranked by what
// the archive backtest says predicts a skilled player's edge (bench/contest-picker-nfl.mjs):
//   1. entry cap - single entry > 2-3 max > 4-20 max > 21+ (proven players +19.5% in single entry vs -10.5% at 7-150)
//   2. unknown-entrant share - entrants with under 30 archive entries; the proven players' edge rose 9 -> 23 points with it
//   3. rake - a plain cost
// Field size and payout shape are shown, not ranked: they changed variance, not edge. Entrants come from the public
// contest page (first 99 users, earliest entrants; bench/dk-entrants.mjs), scored against data/reports/user-index-nfl.json.
// Tournaments only, 100+ max entries like the backtest: cash games and small multipliers are left out.
const NOT_GPP = /50-50|double.?up|triple.?up|quintuple|booster|winner.?take.?all|\bwta\b|\b\d+x\b/i;
const gpp = c => (c.field || 0) >= MIN_FIELD && !NOT_GPP.test(c.name);
import fs from "node:fs";
import { contestsFor } from "./contests.mjs";
import { fetchEntrants } from "../bench/dk-entrants.mjs";

const MIN_PRIOR = 30, PROVEN = 0.13, MIN_READ = 20, MIN_FIELD = 100, INDEX = "data/reports/user-index-nfl.json";
let index = null, indexAt = 0;
const users = () => { try { const t = fs.statSync(INDEX).mtimeMs; if (!index || t !== indexAt) { index = JSON.parse(fs.readFileSync(INDEX, "utf8")); indexAt = t; } } catch { index = null; } return index; };
const capTier = c => c == null ? 3 : c <= 1 ? 0 : c <= 3 ? 1 : c <= 20 ? 2 : 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function score(c, E, U) {
  const out = { listed: 0, unknown: null, proven: null, provenNames: [], badge5: null, epu: null, fetched: null, cap: null };
  if (!E) return out;
  out.fetched = E.fetched; out.cap = E.cap; out.listed = E.users.length; if (!E.users.length || !U) return out;
  const tot = E.users.reduce((t, x) => t + x.n, 0); let un = 0, pv = 0;
  for (const x of E.users) { const r = U.users[x.u]; if (!r || r[0] < MIN_PRIOR) un += x.n; else if (r[1] / r[0] >= PROVEN) { pv += x.n; out.provenNames.push({ u: x.u, n: x.n, entries: r[0], top10: +(r[1] / r[0]).toFixed(3) }); } }
  out.unknown = un / tot; out.proven = pv / tot; out.badge5 = E.users.filter(x => x.badge >= 5).length / E.users.length; out.epu = tot / E.users.length;
  out.provenNames.sort((a, b) => b.top10 - a.top10); out.provenNames = out.provenNames.slice(0, 8);
  return out;
}

// pull entrants for every contest at or above minFee (cached; older than maxAgeMin is fetched again)
export async function pullEntrants(slate, { draftGroup, minFee = 5, maxAgeMin = 30 } = {}) {
  const C = contestsFor(slate, { draftGroup }).contests.filter(c => c.fee >= minFee && gpp(c)), log = { fetched: 0, cached: 0, failed: [] };
  for (const c of C) {
    const f = `data/dk-entrants/${c.id}.json`, fresh = fs.existsSync(f) && Date.now() - Date.parse(JSON.parse(fs.readFileSync(f, "utf8")).fetched) < maxAgeMin * 60000;
    if (fresh) { log.cached++; continue; }
    try { await fetchEntrants(c.id, { refresh: true }); log.fetched++; await sleep(400); } catch (e) { log.failed.push(`${c.id}: ${e.message}`); }
  }
  return log;
}

export function pickerFor(slate, { draftGroup, minFee = 0 } = {}) {
  const L = contestsFor(slate, { draftGroup }), U = users();
  const rows = L.contests.filter(c => c.fee >= minFee && gpp(c)).map(c => {
    const f = `data/dk-entrants/${c.id}.json`, E = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null, s = score(c, E, U);
    const cap = s.cap ?? c.cap, entered = E && E.current != null ? E.current : c.entered, gross = c.fee * (c.field || 0);
    return { id: c.id, name: c.name, fee: c.fee, field: c.field, entered, fill: c.field ? entered / c.field : null, cap, capTier: capTier(cap), start: c.start,
      prizePool: c.prizePool, top: c.top, topShare: c.topShare, rake: gross && c.prizePool ? 1 - c.prizePool / gross : null,
      overlay: c.prizePool && entered != null ? Math.max(0, c.prizePool - entered * c.fee) : null, ...s };
  });
  // rank: cap tier, then unknown share (fewer than 20 entrants read is too few to rank on; those sort after the read ones in
  // the same tier), then rake
  const uk = r => r.listed >= MIN_READ && r.unknown != null ? r.unknown : -1;
  rows.sort((a, b) => a.capTier - b.capTier || uk(b) - uk(a) || (a.rake ?? 1) - (b.rake ?? 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const read = rows.filter(r => r.listed >= MIN_READ && r.unknown != null).map(r => r.unknown).sort((a, b) => a - b);
  return { fetched: L.fetched, groups: L.groups, index: U ? { built: U.built, contests: U.contests } : null, median: read.length ? read[read.length >> 1] : null, minRead: MIN_READ, rows };
}
