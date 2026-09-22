#!/usr/bin/env bash
# Waits for bench/nfl-overnight.sh to finish, then writes the analysis so a summary is on disk by
# morning whether or not anyone is at the keyboard.
set -u
cd "$(dirname "$0")/.."
OUT=data/reports/nfl-overnight
for i in $(seq 1 960); do
  grep -q "all phases complete" "$OUT/log.txt" 2>/dev/null && break
  sleep 30
done
{
  echo "==================== NFL OVERNIGHT SUMMARY ===================="
  echo "generated $(date)"
  echo
  grep -E "FAILED|all phases complete" "$OUT/log.txt" 2>/dev/null || echo "(run did not report completion)"
  echo
  node bench/nfl-compare.mjs "$OUT" 2>&1
} > "$OUT/SUMMARY.txt" 2>&1
echo "summary written to $OUT/SUMMARY.txt"
