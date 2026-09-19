// Every live DraftKings contest for a sport, with the exact payout table for the ones you care
// about, so a slate and a contest can be picked instead of typing a field size and a rake.
//   node bench/dk-contests.mjs CFB [--minfee=5] [--payouts] [--max=40]
// Writes data/dk-lobby/<sport>.json: { fetched, draftGroups:[...], contests:[{id, name, fee, field,
// entered, cap, prizePool, draftGroup, start, payouts?}] }
//
// Why this is a local step and not something the app does itself: the lobby and the contest detail
// endpoint both answer from here, but neither sends CORS headers, and the detail endpoint returns
// 403 outright as soon as a browser Origin is present. The draftgroups host is the only part of
// DraftKings that allows a browser, and it serves the player pool rather than contests.
import fs from "node:fs";
import path from "node:path";
import { dkPayouts } from "./dk-payouts.mjs";

const SPORT = (process.argv[2] || "CFB").toUpperCase();
const flag = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? +a.slice(k.length + 3) : null; };
const MINFEE = flag("minfee") ?? 0, MAXPAY = flag("max") ?? 40, WANT_PAY = process.argv.includes("--payouts");

const j = await (await fetch(`https://www.draftkings.com/lobby/getcontests?sport=${SPORT}`)).json();
const groups = (j.DraftGroups || []).map(g => ({
  id: g.DraftGroupId, start: g.StartDateEst, tag: g.DraftGroupTag, games: g.GameCount ?? null,
  contestType: g.ContestTypeId, sport: g.Sport
}));
const all = (j.Contests || []).filter(c => !c.isSnakeDraft && (c.a || 0) >= MINFEE)
  .map(c => ({
    id: c.id, name: (c.n || "").trim(), fee: c.a, field: c.m, entered: c.nt, cap: c.mec,
    prizePool: c.po, draftGroup: c.dg, gameType: c.gameType, start: c.sdstring,
    guaranteed: (c.attr || {}).IsGuaranteed === "true"
  }))
  .sort((a, b) => b.prizePool - a.prizePool);

console.log(`${SPORT}: ${all.length} contests at $${MINFEE}+ across ${groups.length} draft groups`);
for (const g of groups.slice(0, 8)) {
  const n = all.filter(c => c.draftGroup === g.id).length;
  console.log(`  slate ${g.id}  ${String(g.start || "").slice(0, 16).replace("T", " ")}  ${g.tag || ""}  ${n} contests`);
}

// the payout table only for the biggest contests, since each is its own request
if (WANT_PAY) {
  const pick = all.slice(0, MAXPAY);
  console.log(`\nfetching payout tables for the ${pick.length} largest`);
  let ok = 0;
  for (const c of pick) {
    try {
      const p = await dkPayouts(c.id, 1);   // dollars, not entry fees: the app's payout box takes dollars
      if (p && p.length) {
        // run-length encode back into the "1-3, $500" lines the app's custom payout box parses
        const lines = []; let i = 0;
        while (i < p.length) {
          if (!(p[i] > 0)) { i++; continue; }
          let j = i; while (j + 1 < p.length && p[j + 1] === p[i]) j++;
          lines.push(`${i + 1}${j > i ? "-" + (j + 1) : ""}, $${p[i]}`);
          i = j + 1;
        }
        c.payText = lines.join("\n"); c.paid = p.filter(x => x > 0).length; ok++;
      }
    } catch { /* leave it off; the app falls back to the fitted curve */ }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`  ${ok} tables retrieved`);
}

fs.mkdirSync("data/dk-lobby", { recursive: true });
const out = path.join("data/dk-lobby", SPORT.toLowerCase() + ".json");
fs.writeFileSync(out, JSON.stringify({ fetched: new Date().toISOString(), sport: SPORT, draftGroups: groups, contests: all }, null, 1));
console.log(`\nwrote ${out}`);
const top = all.slice(0, 6);
if (top.length) {
  console.log("\nlargest contests:");
  console.log("  " + "contest".padEnd(46) + "fee".padEnd(7) + "field".padEnd(9) + "entered".padEnd(9) + "max/user".padEnd(10) + "prize pool");
  for (const c of top) console.log("  " + c.name.slice(0, 44).padEnd(46) + ("$" + c.fee).padEnd(7) + String(c.field).padEnd(9) + String(c.entered).padEnd(9) + String(c.cap).padEnd(10) + "$" + c.prizePool.toLocaleString());
}
