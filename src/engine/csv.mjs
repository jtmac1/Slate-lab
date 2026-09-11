export function parseCSV(text) {
  const t = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); f = ""; rows.push(row); row = []; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.length > 1 || String(r[0] || "").trim() !== "");
}

export function num(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/−/g, "-").replace(/[%$,]/g, "").replace(/\+/g, "");
  const m = s.match(/-?\d*\.?\d+/);
  return m ? parseFloat(m[0]) : null;
}

// Name key: strip accents, punctuation, suffixes, and anything in parentheses.
export function nrm(s) {
  return String(s == null ? "" : s)
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[.'`’]/g, "").replace(/-/g, " ")
    .replace(/\s+/g, " ").trim().replace(/\s+(jr|sr|ii|iii|iv)$/, "");
}
