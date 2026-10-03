// How much does a real NFL field lean into chalk beyond projected ownership? The field generator
// raises projected ownership to the power conc and rescales each roster group, so this fits conc
// on every pulled NFL contest: for each contest and candidate conc, predicted = pown^conc rescaled
// to the same total as pown, scored by mean absolute error against actual ownership. Reported per
// format (classic / showdown) and fee tier, plus actual-over-projected by ownership bucket.
//   node bench/fit-conc-nfl.mjs [from] [to]   -> data/reports/conc-fit-nfl.json
import fs from "node:fs";
import { listPost, readPost } from "./post-store.mjs";
const FROM = process.argv[2] || "2026-09-01", TO = process.argv[3] || "2099-12-31";
const CONC = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
const tierOf = fee => fee < 100 ? "lo" : fee < 300 ? "mid" : "hi";
const acc = {}, buckets = {};
const B = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 45], [45, 100]];
let contests = 0;
for (const f of listPost("nfl")) {
  const j = readPost(f), c = j.contest; if (!j.players?.length || !j.lineups?.length || c.date < FROM || c.date > TO || c.fee < 20) continue;
  const sd = /showdown/i.test(c.type + " " + c.name), fmt = sd ? "showdown" : "classic", tier = tierOf(c.fee);
  // showdown: flex rows and CPT rows are separate groups; classic: one group
  const groups = sd ? [j.players.filter(p => p.pos !== "CPT"), j.players.filter(p => p.pos === "CPT")] : [j.players];
  for (const [gi, g] of groups.entries()) {
    const P = g.filter(p => p.pown > 0 && p.aown != null); if (P.length < 8) continue;
    const key = `${fmt}|${gi === 1 ? "cpt" : "flex"}`, tot = P.reduce((s, p) => s + p.pown, 0);
    for (const conc of CONC) {
      const raw = P.map(p => Math.pow(p.pown, conc)), rs = raw.reduce((s, x) => s + x, 0), k = tot / rs;
      const mae = P.reduce((s, p, i) => s + Math.abs(raw[i] * k - p.aown), 0) / P.length;
      for (const t of [tier, "all"]) { const a = acc[`${key}|${t}|${conc}`] = acc[`${key}|${t}|${conc}`] || { n: 0, mae: 0 }; a.n++; a.mae += mae; }
    }
    for (const p of P) { const b = B.find(([lo, hi]) => p.pown * 100 >= lo && p.pown * 100 < hi); if (!b) continue; for (const t of [tier, "all"]) { const bk = buckets[`${key}|${t}|${b[0]}-${b[1]}`] = buckets[`${key}|${t}|${b[0]}-${b[1]}`] || { n: 0, p: 0, a: 0 }; bk.n++; bk.p += p.pown; bk.a += p.aown; } }
  }
  contests++;
}
const out = { built: new Date().toISOString(), window: [FROM, TO], contests, fit: {}, buckets: {} };
for (const [k, a] of Object.entries(acc)) { const [fmt, grp, tier, conc] = k.split("|"); const key = `${fmt}|${grp}|${tier}`; (out.fit[key] = out.fit[key] || []).push({ conc: +conc, n: a.n, mae: +(100 * a.mae / a.n).toFixed(3) }); }
for (const [key, arr] of Object.entries(out.fit)) { arr.sort((x, y) => x.conc - y.conc); const best = arr.slice().sort((x, y) => x.mae - y.mae)[0]; out.fit[key] = { best: best.conc, n: best.n, byConc: arr }; }
for (const [k, b] of Object.entries(buckets)) { const [fmt, grp, tier, bucket] = k.split("|"); const key = `${fmt}|${grp}|${tier}`; (out.buckets[key] = out.buckets[key] || []).push({ bucket, n: b.n, proj: +(100 * b.p / b.n).toFixed(1), actual: +(100 * b.a / b.n).toFixed(1), ratio: +(b.a / b.p).toFixed(2) }); }
for (const arr of Object.values(out.buckets)) arr.sort((x, y) => +x.bucket.split("-")[0] - +y.bucket.split("-")[0]);
fs.mkdirSync("data/reports", { recursive: true });
fs.writeFileSync("data/reports/conc-fit-nfl.json", JSON.stringify(out, null, 1));
for (const [key, v] of Object.entries(out.fit).sort()) console.log(`${key.padEnd(22)} best conc ${v.best} (n ${v.n})  ` + v.byConc.map(x => `${x.conc}:${x.mae.toFixed(2)}`).join(" "));
console.log("\nactual / projected by projected-ownership bucket (all tiers):");
for (const [key, arr] of Object.entries(out.buckets).filter(([k]) => k.endsWith("|all")).sort()) console.log(`${key.padEnd(22)} ` + arr.map(b => `${b.bucket}%: ${b.proj}->${b.actual} (${b.ratio}x, n${b.n})`).join("  "));
console.log(`\n${contests} contests -> data/reports/conc-fit-nfl.json`);
