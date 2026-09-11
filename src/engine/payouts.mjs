import { num } from "./csv.mjs";

// Top-heavy power curve fitted so rank 1 pays `first` and the paid places sum to `pool`.
export function fitPayouts(entries, pool, first, paidPct) {
  const paid = Math.max(1, Math.min(entries, Math.round(entries * (paidPct || 20) / 100)));
  const arr = new Float64Array(entries);
  if (!pool || !first) return arr;
  let lo = 0.001, hi = 8, alpha = 2;
  for (let it = 0; it < 60; it++) {
    alpha = (lo + hi) / 2;
    let s = 0; for (let r = 1; r <= paid; r++) s += Math.pow(r, -alpha);
    if (pool / s < first) lo = alpha; else hi = alpha;
  }
  let sum = 0; for (let r = 1; r <= paid; r++) sum += Math.pow(r, -alpha);
  for (let r = 1; r <= paid; r++) arr[r - 1] = pool * Math.pow(r, -alpha) / sum;
  return arr;
}

// Accepts "rank,amount", "rank-rank amount", or DraftKings' pasted list where the
// rank line ("6th - 8th") is followed by the amount line ("$800").
export function parsePayoutTable(text, entries) {
  const arr = new Float64Array(entries);
  const rankRe = /^(\d+)(?:st|nd|rd|th)?(?:\s*[-–]\s*(\d+)(?:st|nd|rd|th)?)?/i;
  const lines = String(text).split(/\n+/).map(l => l.trim()).filter(Boolean);
  let pending = null;
  for (const line of lines) {
    const both = line.match(/^(\d+)(?:st|nd|rd|th)?(?:\s*[-–]\s*(\d+)(?:st|nd|rd|th)?)?\s*[,:\t ]\s*\$?([\d,.]+)\s*$/i);
    if (both) { fill(arr, +both[1], both[2] ? +both[2] : +both[1], num(both[3]), entries); pending = null; continue; }
    if (/^\$?[\d,.]+$/.test(line) && pending) { fill(arr, pending[0], pending[1], num(line), entries); pending = null; continue; }
    const r = line.match(rankRe);
    if (r && /^\d/.test(line)) pending = [+r[1], r[2] ? +r[2] : +r[1]];
  }
  return arr;
}
function fill(arr, a, b, amt, entries) {
  if (amt == null) return;
  for (let r = a; r <= b && r <= entries; r++) arr[r - 1] = amt;
}

export function paidCount(pay) { let n = 0; for (let i = 0; i < pay.length; i++) if (pay[i] > 0) n++; return n; }
export function payoutSum(pay) { let s = 0; for (let i = 0; i < pay.length; i++) s += pay[i]; return s; }
