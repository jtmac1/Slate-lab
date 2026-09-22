#!/usr/bin/env bash
# The combined fitted config made selection WORSE than the shipped engine on win-big. Before that is
# believed it needs a noise floor (same config, different seed), and before it is acted on it needs
# decomposing - sigma, tilt and correlations were changed together.
set -u
cd "$(dirname "$0")/.."
O=data/reports/winbig; mkdir -p "$O"
SIG="QB:0.752,RB:0.696,WR:0.818,TE:0.712"
TILT="QB:-0.655,RB:-0.371,WR:-0.382,TE:-0.393"
CT=data/reports/corr-nfl.json
N=300; IT=1500
run(){ local name=$1; shift
  [ -s "$O/$name.txt" ] && { echo "[$(date +%H:%M:%S)] skip $name"; return; }
  echo "[$(date +%H:%M:%S)] start $name"
  node bench/win-big.mjs nfl_cl --n=$N --iters=$IT --split "$@" > "$O/$name.txt" 2>&1
  echo "[$(date +%H:%M:%S)] done  $name"; }

# noise floor: shipped engine, different seeds. shipped.txt is already seed 0.
run shipped-s1 --seed=1 &
run shipped-s2 --seed=2 &
wait
# decomposition: one change at a time, all on seed 0 so they pair with shipped.txt
run only-sigma  --nflsig="$SIG" &
run only-tilt   --sigtilt="$TILT" --sigref=11.5 &
wait
run only-ctable --ctable="$CT" &
run sigma+tilt  --nflsig="$SIG" --sigtilt="$TILT" --sigref=11.5 &
wait
echo "[$(date +%H:%M:%S)] queue complete"
