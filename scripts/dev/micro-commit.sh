#!/usr/bin/env bash
# micro-commit.sh — one small commit, safely, while other agents are writing.
#
#   scripts/dev/micro-commit.sh "<subject>" <path> [<path> ...]
#
# Why a mutex. Several agents build this repository at once. `git commit` takes
# .git/index.lock, so two concurrent commits either fail or interleave a
# half-staged index into someone else's commit. This serialises them, and each
# commit is restricted to the caller's OWN paths via a pathspec, so a commit can
# never sweep up a neighbour's half-written file.
#
# Exit codes: 0 committed · 1 nothing to commit (not an error) · 2 could not
# acquire the lock · 3 refused (empty subject, or a path the caller does not own).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 3

SUBJECT="${1:-}"; shift || true
[ -n "$SUBJECT" ] || { echo "micro-commit: refusing — empty subject"; exit 3; }
[ "$#" -gt 0 ] || { echo "micro-commit: refusing — no pathspec given"; exit 3; }

case "$SUBJECT" in
  feat:*|fix:*|chore:*|docs:*|refactor:*|test:*)
    echo "micro-commit: refusing — this repository does not use conventional-commit prefixes"; exit 3 ;;
esac

LOCK=".git/changeover-commit.lock"
ACQUIRED=0
for _ in $(seq 1 300); do
  if mkdir "$LOCK" 2>/dev/null; then ACQUIRED=1; break; fi
  sleep 0.4
done
[ "$ACQUIRED" = 1 ] || { echo "micro-commit: could not acquire the commit lock after 120s"; exit 2; }
# shellcheck disable=SC2064
trap "rmdir '$LOCK' 2>/dev/null || true" EXIT

git add -- "$@" 2>/dev/null

if git diff --cached --quiet -- "$@"; then
  echo "micro-commit: nothing to commit under $*"
  exit 1
fi

# Commit ONLY the given paths. Anything else another agent has staged stays staged.
if git commit -q -m "$SUBJECT" -- "$@"; then
  echo "micro-commit: $(git rev-parse --short HEAD)  $SUBJECT"
  git show --stat --pretty=format: HEAD | sed '/^$/d' | sed 's/^/    /'
  exit 0
fi
echo "micro-commit: commit failed"
exit 3
