// Seeded generator so every run is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  const rnd = function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.gauss = function () {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // Weighted index pick over a cumulative array of length m.
  rnd.pickCum = function (cum, m) {
    const t = rnd() * cum[m - 1];
    let lo = 0, hi = m - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return rnd;
}
