#!/usr/bin/env bash
# Runs every proof. Exit 0 only if all of them hold.
#
# Three outcomes, deliberately distinct: 0 holds, 1 FAILS, 2 CANNOT PROVE.
# A precondition that is missing is not a pass — a suite that reports "green"
# when it could not reach the thing it tests is worse than no suite.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

PROOFS=(prove_spec_first prove_spec_examples prove_etag_golden prove_member_manifest prove_no_settlement_verb)
declare -a HELD=() FAILED=() UNPROVABLE=()

for name in "${PROOFS[@]}"; do
  OUT=$(bash "scripts/$name.sh" 2>&1); CODE=$?
  SUMMARY=$(echo "$OUT" | grep -c '^ok — ' || true)
  case $CODE in
    0) HELD+=("$name"); printf 'ok   — %-24s %s checks\n' "$name" "$SUMMARY" ;;
    2) UNPROVABLE+=("$name"); printf 'skip — %-24s cannot prove\n' "$name" ;;
    *) FAILED+=("$name"); printf 'FAIL — %-24s\n' "$name" ;;
  esac
  echo "$OUT" | sed 's/^/         /'
done

echo
echo "PASS=${#HELD[@]}  FAIL=${#FAILED[@]}  UNPROVABLE=${#UNPROVABLE[@]}"
[ ${#UNPROVABLE[@]} -gt 0 ] && echo "cannot prove: ${UNPROVABLE[*]}"
[ ${#FAILED[@]} -gt 0 ] && { echo "failed: ${FAILED[*]}"; exit 1; }
[ ${#UNPROVABLE[@]} -gt 0 ] && exit 2
exit 0
