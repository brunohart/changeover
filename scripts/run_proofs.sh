#!/usr/bin/env bash
# Runs every proof. Exit 0 only if all of them hold.
#
# Three outcomes, deliberately distinct: 0 holds, 1 FAILS, 2 CANNOT PROVE.
# A precondition that is missing is not a pass — a suite that reports "green"
# when it could not reach the thing it tests is worse than no suite.
#
# Proofs are DISCOVERED, not listed. Dropping scripts/prove_x.sh into this
# directory puts it in the suite, which means a new proof cannot be forgotten
# and no two authors contend on one registry file. A proof that is broken on
# arrival turns the suite red immediately, which is the point.
#
# --allow-unprovable maps a whole-suite exit 2 to 0, and is for CI ONLY, where
# no Postgres and no Docker daemon exist. It never hides a FAILURE, it prints
# the unprovable inventory loudly, and the script's own exit codes stay honest.
# The alternative — softening exit 2 inside the script — would buy a green badge
# by making the suite lie, which is the thing this repository exists not to do.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

ALLOW_UNPROVABLE=0
[ "${1:-}" = "--allow-unprovable" ] && ALLOW_UNPROVABLE=1

declare -a HELD=() FAILED=() UNPROVABLE=()

# Portable across bash 3.2 (macOS) and bash 5 (CI). `mapfile` is bash 4+ only,
# and a suite that runs on one developer's machine is not a suite.
PROOFS=""
while IFS= read -r p; do PROOFS="$PROOFS$p"$'\n'; done < <(find scripts -maxdepth 1 -name 'prove_*.sh' -type f | sort)
[ -n "$PROOFS" ] || { echo "cannot prove — no scripts/prove_*.sh found"; exit 2; }

while IFS= read -r path; do
  [ -n "$path" ] || continue
  name=$(basename "$path" .sh)
  OUT=$(bash "$path" 2>&1); CODE=$?
  SUMMARY=$(echo "$OUT" | grep -c '^ok — ' || true)
  case $CODE in
    0) HELD+=("$name");       printf 'ok   — %-28s %s checks\n' "$name" "$SUMMARY" ;;
    2) UNPROVABLE+=("$name"); printf 'skip — %-28s cannot prove\n' "$name" ;;
    *) FAILED+=("$name");     printf 'FAIL — %-28s\n' "$name" ;;
  esac
  echo "$OUT" | sed 's/^/         /'
done <<EOF
$PROOFS
EOF

echo
echo "PASS=${#HELD[@]}  FAIL=${#FAILED[@]}  UNPROVABLE=${#UNPROVABLE[@]}"
if [ ${#UNPROVABLE[@]} -gt 0 ]; then
  echo
  echo "CANNOT PROVE (${#UNPROVABLE[@]}): ${UNPROVABLE[*]}"
  echo "  These did not fail. They could not be reached. Each names the command that would"
  echo "  make it provable — most need a real multi-connection Postgres via CHANGEOVER_PG_URL."
fi
[ ${#FAILED[@]} -gt 0 ] && { echo "failed: ${FAILED[*]}"; exit 1; }
if [ ${#UNPROVABLE[@]} -gt 0 ]; then
  [ "$ALLOW_UNPROVABLE" = 1 ] && { echo "  (--allow-unprovable: reporting success despite the above)"; exit 0; }
  exit 2
fi
exit 0
