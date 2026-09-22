#!/usr/bin/env bash
# Runs after the grading arms and the win-big decomposition have drained, so we are not running
# nine node processes on four cores. Two jobs left:
#   1. win-big again, with the fee/field-size stratification, to ask whether the lift trends with
#      field size - the only evidence available about the 10k+ contests that are actually played,
#      short of re-pulling them with lineups.
#   2. the skill sweep for fieldProfile, which is null for every format except cfb_cl. The real NFL
#      field is 4.78 projected points stronger than the generated one and uses 267 more salary.
set -u
cd "$(dirname "$0")/.."
O=data/reports; mkdir -p "$O/winbig"
# wait for both queues to finish, up to 5 hours
for i in $(seq 1 600); do
  grep -q "all phases complete" "$O/nfl-overnight/log.txt" 2>/dev/null && a=1 || a=0
  grep -q "queue complete" "$O/winbig/queue.log" 2>/dev/null && b=1 || b=0
  [ "$a" -ge 1 ] && [ "$b" -ge 1 ] && break
  sleep 30
done
echo "[$(date +%H:%M:%S)] phase 3 starting"
node bench/win-big.mjs nfl_cl --n=300 --iters=1500 --split > "$O/winbig/shipped-strat.txt" 2>&1
echo "[$(date +%H:%M:%S)] stratified win-big done"
for s in "0.10:40,0.35:3" "0.25:40,0.50:3" "0.40:60,0.60:4"; do
  echo "--- skill=$s" >> "$O/field-nfl-sweep.txt"
  node bench/field-strength.mjs nfl_cl --n=150 --skill="$s" 2>&1 | tail -2 >> "$O/field-nfl-sweep.txt"
done
echo "[$(date +%H:%M:%S)] skill sweep done"
for m in 49200 49400 49600; do
  echo "--- minsal=$m" >> "$O/field-nfl-sweep.txt"
  node bench/field-strength.mjs nfl_cl --n=150 --minsal=$m 2>&1 | tail -2 >> "$O/field-nfl-sweep.txt"
done
echo "[$(date +%H:%M:%S)] phase 3 complete"
