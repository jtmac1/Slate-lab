// Stokastic Data Hub, read directly (no login; the API answers any origin). Used by the app's
// "Check Stokastic" button and by bench/pull-projections.mjs.
export const STK_API = "https://app-api-dfs-prod-main.azurewebsites.net/api/";
export async function stkGet(path) { const r = await fetch(STK_API + path); if (!r.ok) throw new Error(`Stokastic ${r.status} on ${path.split("?")[0]}`); return r.json(); }
// stamps come without a zone and are UTC
export const stkTime = s => new Date(typeof s === "string" && !/Z|[+-]\d\d:\d\d$/.test(s) ? s + "Z" : s);
export const hhmm = d => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
// DK slates for a sport on a date (YYYY-MM-DD local)
export async function stkSlates(sport, date) {
  const info = await stkGet("contests/getPreContestSlateInfo?app=DATAHUB");
  return info.filter(s => s.site === "DK" && s.sport === sport.toUpperCase() && s.startTime.startsWith(date))
    .map(s => ({ slateId: s.slateId, name: s.name, type: s.type, start: s.startTime, games: (s.matchupInfo || []).map(m => m.awayTeamAbbrev + "@" + m.homeTeamAbbrev) }))
    .sort((a, b) => a.start.localeCompare(b.start) || (a.type === "CLASSIC" ? -1 : 1));
}
export const stkUpdateInfo = slateId => stkGet(`slatedata/slateUpdateInfo?slateId=${slateId}`);
export const stkProjections = slateId => stkGet(`slatedata/projections?SlateId=${slateId}`);
export const STK_HEADER = "Player,Salary,Position,Bat Pos.,Team,Opponent,Projection,Value,Ownership %,Std Dev,Hand,Confirmed,Team Total,PPD,HR %,Top Pitcher %,Top Value %,DK ID";
// the Data Hub export layout the app already parses
export function stkToCSV(proj) {
  const esc = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = proj.map(p => [p.name, p.salary, p.position, p.lineupPosition ?? 0, p.team, p.opponent, p.projection, p.value, 100 * (p.ownership || 0), p.stdDev ?? "", p.hand ?? "", p.confirmedLineup ? "C" : "", p.projectedTeamTotal ?? "", p.postponed ?? 0, p.hrPercent ?? 0, p.topPitcherPercent ?? 0, p.topValuePercent ?? 0, (p.nameAndId || "").match(/\((\d+)\)/)?.[1] || ""].map(esc).join(","));
  return [STK_HEADER].concat(rows).join("\n") + "\n";
}
// slate start times come as US Eastern wall-clock (no zone), unlike the UTC update stamps
export function stkEastern(s) {
  const d = new Date(s.slice(0, 19) + "Z"), tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(d).find(p => p.type === "timeZoneName").value;
  return new Date(s.slice(0, 19) + (tz.replace("GMT", "") || "+00:00"));
}
