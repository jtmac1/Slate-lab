#!/usr/bin/env bash
# Overnight NFL fitting program: the college programme, run against the 317 pulled nfl_cl contests
# (plus a showdown pass), which is the sample SIGMA_DEF.nfl and the NFL correlation tables were
# never fitted on. SIGMA_DEF.nfl came from one slate (2026-09-13); CSAME/COPP for NFL are still the
# original hand-set values.
#
# Order matters and follows the measurement rules: the noise floor is measured FIRST, on the
# shipped engine with nothing changed, so every later arm can be read against the run-to-run swing
# rather than against zero. Every arm uses all 317 contests - no --n cap.
#
#   bash bench/nfl-overnight.sh
# Results land in data/reports/nfl-overnight/*.json, progress in that folder's log.txt.

set -u
cd "$(dirname "$0")/.."
OUT=data/reports/nfl-overnight
mkdir -p "$OUT"
LOG="$OUT/log.txt"
ITERS=${ITERS:-4000}
JOBS=${JOBS:-4}
CT=data/reports/corr-nfl.json

# Fitted from 2865 player-games in bench/fit-sigma.mjs. Shipped values are QB .55 RB .50 WR .60 TE .65.
SIG="QB:0.742,RB:0.696,WR:0.818,TE:0.712"
# Fitted exponents: sigma falls with projection size. Shipped NFL has no tilt at all.
TILT="QB:-0.662,RB:-0.371,WR:-0.382,TE:-0.393"
REF=11.5

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# run <name> <fkey> <extra flags...>
run() {
  local name=$1 fkey=$2; shift 2
  if [ -s "$OUT/$name.json" ]; then say "skip $name (already done)"; return; fi
  say "start $name"
  node bench/grade-all.mjs "$ITERS" "$fkey" --json="$OUT/$name.json" "$@" \
    > "$OUT/$name.txt" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then say "FAILED $name (exit $rc) - see $OUT/$name.txt"; else say "done  $name"; fi
}

# queue jobs JOBS-at-a-time
throttle() { while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n 2>/dev/null || sleep 5; done; }

say "=== NFL overnight programme: iters=$ITERS jobs=$JOBS ==="
say "sigma  $SIG"
say "tilt   $TILT  (ref $REF)"
say "ctable $CT"

# ---- Phase 0: noise floor. Same shipped config, five seeds. Nothing below is readable without it.
say "--- phase 0: noise floor (shipped engine, 5 seeds)"
for s in 1 2 3 4 5; do
  throttle; run "noise-seed$s" nfl_cl --seed="$s" &
done
wait
say "--- phase 0 complete"

# ---- Phase 1: the three corrections, alone and together, against the shipped baseline.
say "--- phase 1: correction arms"
throttle; run "A-base"      nfl_cl --seed=11 &
throttle; run "B-ctable"    nfl_cl --seed=11 --ctable="$CT" &
throttle; run "C-sigma"     nfl_cl --seed=11 --nflsig="$SIG" &
throttle; run "D-tilt"      nfl_cl --seed=11 --sigtilt="$TILT" --sigref=$REF &
wait
throttle; run "E-sigma+ct"  nfl_cl --seed=11 --nflsig="$SIG" --ctable="$CT" &
throttle; run "F-all"       nfl_cl --seed=11 --nflsig="$SIG" --sigtilt="$TILT" --sigref=$REF --ctable="$CT" &
wait
say "--- phase 1 complete"

# ---- Phase 2: is the winner robust to the seed, or did we pick a seed? Repeat the best two arms.
say "--- phase 2: seed robustness on the combined arms"
for s in 21 22 23; do
  throttle; run "F-all-seed$s" nfl_cl --seed="$s" --nflsig="$SIG" --sigtilt="$TILT" --sigref=$REF --ctable="$CT" &
  throttle; run "A-base-seed$s" nfl_cl --seed="$s" &
done
wait
say "--- phase 2 complete"

# ---- Phase 3: how much of the correlation correction matters, as a scale on the shipped table.
# If a plain scale recovers most of the fitted table's gain, the per-bucket fit is overkill.
say "--- phase 3: correlation scale grid"
for c in 0.4 0.6 0.8 1.0; do
  throttle; run "corr-x$c" nfl_cl --seed=11 --corr="$c" &
done
wait
say "--- phase 3 complete"

# ---- Phase 4: showdown. Half the pulled NFL sample and its own sigma table; correlations should
# transfer from the classic fit even though the sigma fit does not.
say "--- phase 4: showdown"
throttle; run "SD-base"   nfl_sd --seed=11 &
throttle; run "SD-ctable" nfl_sd --seed=11 --ctable="$CT" &
wait
say "--- phase 4 complete"

say "=== all phases complete: $(ls "$OUT"/*.json 2>/dev/null | wc -l) result files in $OUT ==="
