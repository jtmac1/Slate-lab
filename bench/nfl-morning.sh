#!/usr/bin/env bash
# Assembles every overnight result into one file. Safe to run at any time - it reports whatever has
# finished and says plainly what has not.
set -u
cd "$(dirname "$0")/.."
O=data/reports
sec(){ echo; echo "=============================================================="; echo "$1"; echo "=============================================================="; }
have(){ [ -s "$1" ] && cat "$1" || echo "(not finished)"; }

sec "1. WHAT CHANGED TONIGHT"
cat <<'TXT'
game-logs.mjs had no DST handling at all (written for CFB). Every generated NFL lineup scored zero
for one of nine slots - 11% missing, just under the 15% guard, so nothing tripped. Only 37 of 317
classic contests cleared that guard.
  - ported DK DST scoring from actuals-nfl.mjs; verified 24/24 teams against it on 2026-09-13
  - rebuilt all 65 log dates (+582 DST rows, no data lost)
  - usable nfl_cl contests: 37 -> 286, median player miss 17% -> 5%
  - added the +3 at 300 passing yards that NFL needs and CFB does not
New: bench/win-big.mjs, the first test that uses the generated field as the CANDIDATE set (the
workflow actually used) and scores it on tier hit rate rather than mean return.
TXT

sec "2. DOES THE WORKFLOW WIN BIG? (shipped engine)"
have "$O/winbig/shipped.txt"

sec "3. SEED NOISE FLOOR for win-big (same config, different seed)"
for f in shipped-s1 shipped-s2; do echo "--- $f"; have "$O/winbig/$f.txt" | sed -n '1,9p'; done

sec "4. DECOMPOSITION: which fitted component helped or hurt?"
for f in only-sigma only-tilt only-ctable sigma+tilt fitted; do
  echo "--- $f"; have "$O/winbig/$f.txt" | sed -n '1,9p'; done

sec "5. STRATIFIED: does the lift hold across fee and field size?"
have "$O/winbig/shipped-strat.txt" | sed -n '/does the lift hold/,$p'

sec "6. GRADING ARMS (ranking real entries) - noise floor then arms"
have "$O/nfl-overnight/SUMMARY.txt"

sec "7. FIELD REALISM - the generated NFL field is too weak"
echo "baseline gap (positive = real field stronger):"
echo "  mean proj 4.78   99th proj 5.61   salary 267   ownership sum 16.4   (280 contests)"
echo "fieldProfile() returns null for every format except cfb_cl, so NFL has no skill classes."
echo; echo "sweep results:"; have "$O/field-nfl-sweep.txt"

sec "8. THE OPEN QUESTION"
cat <<'TXT'
The archive is $100-499 in fields under 10k. The DK entry history is 27,372 NFL entries, mostly
under $25 (22,050 under $5 at +4.6% ROI; 3,461 at $5-24 at +13.3%) and 18,406 in fields over 10k.
179 large-field contests ARE on disk but were pulled with --max, so they hold players and stacks
but no lineups, and listContests() drops them. Median own-entries per contest is 1, too sparse to
rebuild the field's score distribution. Validating on the population actually played needs those
contests re-pulled WITH lineups - a heavy pull (fields up to 190k) and the main open item.
TXT
echo
