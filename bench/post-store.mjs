// Compact, gzipped storage for pulled post-contest data (data/post/<sport>/<date>-<key>.json.gz).
// Only the fields the analyses use are kept; that plus gzip is roughly a tenth of the raw API
// responses. Everything that reads pulled contests goes through readPost/listPost.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dkId = s => (String(s || "").match(/\((\d+)\)/) || [])[1] || null;

// raw API lineup -> compact
export function compactLineup(l) {
  return { u: l.user, ids: String(l.exportableLineup || "").split(",").map(dkId), sal: l.salary ?? 0, fin: l.actualFinishPosition ?? null,
    aroi: l.actualLineupRoi ?? null, sroi: l.simLineupRoi ?? null, sfp: l.simAverageFantasyPoints ?? null, afp: l.actualFantasyPoints ?? null,
    own: l.ownershipSum ?? null, dup: l.duplicates ?? 0, cash: l.cash ?? null, t10: l.top10 ?? null, win: l.win ?? null, stack: l.stackInfo || "" };
}
// raw API player -> compact
export function compactPlayer(p) {
  return { id: dkId(p.exportableNameAndId), name: p.player, pos: p.position || "", team: p.teamName || "", opp: p.opponentTeamName || "", sal: p.salary ?? 0,
    proj: p.projection ?? 0, pown: p.projectedOwnership ?? 0, aown: p.overallOwnership ?? 0, lev: p.leverage ?? null, sroi: p.simPlayerRoi ?? null, aroi: p.actualPlayerRoi ?? null };
}
export function compact(raw) {
  return { contest: raw.contest, pulledAt: raw.pulledAt, lineupsSkipped: !!raw.lineupsSkipped, lineups: (raw.lineups || []).map(compactLineup), players: (raw.players || []).map(compactPlayer), stacks: raw.stacks || [] };
}

export const postDir = sport => path.join("data/post", String(sport).toLowerCase());
export const postFile = c => path.join(postDir(c.sport), `${c.date}-${c.key}.json.gz`);
export function writePost(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(obj), { level: 6 })); }
export function readPost(file) { const buf = fs.readFileSync(file); return JSON.parse(file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8")); }
export function listPost(sport, filter) {
  const dir = postDir(sport); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.json(\.gz)?$/.test(f) && (!filter || filter(f))).sort().map(f => path.join(dir, f));
}
export const isPitcher = pos => /(^|\/)(SP|RP|P)($|\/)/.test(pos);
export const dateOf = file => path.basename(file).slice(0, 10);
