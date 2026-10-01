#!/usr/bin/env bash
# Step 1 + 3 of the MLB sim scoreboard: baseline seed 1 (already started), seed 2 noise floor,
# fitted-correlation grade, then paired comparisons. Runs 4 shards per grade (one per core).
cd "$(dirname "$0")/.." || exit 1
R=data/reports/base
wait_for() { while :; do ok=1; for k in 0 1 2 3; do [ -s "$R/$1.p$k.json" ] || ok=0; done; [ $ok = 1 ] && break; sleep 30; done; }
run_grade() { name=$1; shift; for k in 0 1 2 3; do node bench/grade-all.mjs 4000 mlb --shard=$k/4 --json=$R/$name.p$k.json "$@" > $R/$name.p$k.log 2>&1 & done; wait; node bench/merge-json.mjs $R/$name.json $R/$name.p0.json $R/$name.p1.json $R/$name.p2.json $R/$name.p3.json; }
echo "waiting for seed-1 baseline shards $(date)"
wait_for mlb-s1
node bench/merge-json.mjs $R/mlb-s1.json $R/mlb-s1.p0.json $R/mlb-s1.p1.json $R/mlb-s1.p2.json $R/mlb-s1.p3.json
echo "seed-2 noise floor $(date)"; run_grade mlb-s2 --seed=2
echo "fitted correlations seed 1 $(date)"; run_grade mlb-fitcorr --seed=1 --ctable=data/reports/corr-mlb.json
echo "=== NOISE FLOOR: seed 1 vs seed 2 (same model)"; node bench/compare-grades.mjs $R/mlb-s1.json $R/mlb-s2.json
echo "=== FITTED CORR vs baseline (seed 1)"; node bench/compare-grades.mjs $R/mlb-s1.json $R/mlb-fitcorr.json
echo "done $(date)"
