// Stokastic Data Hub, read directly (no login; the API answers any origin). Used by the app's
// "Check Stokastic" button and by bench/pull-projections.mjs.
export const STK_API = "https://app-api-dfs-prod-main.azurewebsites.net/api/";
export async function stkGet(path) { const r = await fetch(STK_API + path); if (!r.ok) throw new Error(`Stokastic ${r.status} on ${path.split("?")[0]}`); return r.json(); }
// update stamps come without a zone and are UTC
export const stkTime = s => new Date(typeof s === "string" && !/Z|[+-]\d\d:\d\d$/.test(s) ? s + "Z" : s);
export const hhmm = d => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
// slate start times come as US Eastern wall-clock (no zone), unlike the UTC update stamps
export function stkEastern(s) {
  const d = new Date(s.slice(0, 19) + "Z"), tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(d).find(p => p.type === "timeZoneName").value;
  return new Date(s.slice(0, 19) + (tz.replace("GMT", "") || "+00:00"));
}
// DK slates for a sport on a date (YYYY-MM-DD, Eastern)
export async function stkSlates(sport, date) {
  const info = await stkGet("contests/getPreContestSlateInfo?app=DATAHUB");
  return info.filter(s => s.site === "DK" && s.sport === sport.toUpperCase() && s.startTime.startsWith(date))
    .map(s => ({ slateId: s.slateId, name: s.name, type: s.type, start: s.startTime, games: (s.matchupInfo || []).map(m => m.awayTeamAbbrev + "@" + m.homeTeamAbbrev) }))
    .sort((a, b) => a.start.localeCompare(b.start) || (a.type === "CLASSIC" ? -1 : 1));
}
export const stkUpdateInfo = slateId => stkGet(`slatedata/slateUpdateInfo?slateId=${slateId}`);
export const stkProjections = slateId => stkGet(`slatedata/projections?SlateId=${slateId}`);
export const STK_HEADER = "Player,Salary,Position,Bat Pos.,Team,Opponent,Projection,Value,Ownership %,Std Dev,Hand,Confirmed,Team Total,PPD,HR %,Top Pitcher %,Top Value %,DK ID";
// NFL rows carry captain ownership and the captain's DK id (showdown); classic rows leave them blank
export const STK_HEADER_NFL = "Player,Salary,Position,Team,Opponent,Projection,Value,Ownership %,CPT Ownership %,Std Dev,Team Total,Injury,DK ID,CPT DK ID";
const dkId = s => (s || "").match(/\((\d+)\)/)?.[1] || "";
const esc = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// the Data Hub export layout the app already parses (MLB), or an NFL layout its column mapper reads
export function stkToCSV(proj, sport = "mlb") {
  if (["nfl", "cfb"].includes(String(sport).toLowerCase())) {
    const rows = proj.map(p => [p.name, p.salary, p.position, p.team, p.opponent, p.projection, p.value, 100 * (p.ownership || 0), p.cptOwnership != null ? 100 * p.cptOwnership : "", p.stdDev ?? "", p.projectedTeamTotal ?? "", p.injuryStatus && p.injuryStatus !== "Unknown" ? p.injuryStatus : "", dkId(p.nameAndId), dkId(p.captainNameAndId)].map(esc).join(","));
    return [STK_HEADER_NFL].concat(rows).join("\n") + "\n";
  }
  const rows = proj.map(p => [p.name, p.salary, p.position, p.lineupPosition ?? 0, p.team, p.opponent, p.projection, p.value, 100 * (p.ownership || 0), p.stdDev ?? "", p.hand ?? "", p.confirmedLineup ? "C" : "", p.projectedTeamTotal ?? "", p.postponed ?? 0, p.hrPercent ?? 0, p.topPitcherPercent ?? 0, p.topValuePercent ?? 0, dkId(p.nameAndId)].map(esc).join(","));
  return [STK_HEADER].concat(rows).join("\n") + "\n";
}
