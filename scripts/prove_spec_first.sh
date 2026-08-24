#!/usr/bin/env bash
# Asserts a property of the ROOT COMMIT: the thing that decides predates the
# thing that executes. Written against `git rev-list --max-parents=0`, so it
# passes at commit one, keeps passing forever, and can never be satisfied by
# rearranging a later commit.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
git rev-parse --git-dir >/dev/null 2>&1 || { echo "cannot prove — not a git repository"; exit 2; }
ROOT=$(git rev-list --max-parents=0 HEAD 2>/dev/null) || { echo "cannot prove — no commits yet"; exit 2; }
FILES=$(git show --pretty=format: --name-only "$ROOT" | sed '/^$/d')
[ -n "$FILES" ] || { echo "cannot prove — root commit lists no files"; exit 2; }

FAIL=0
OFFENDING=$(echo "$FILES" | grep -E '^src/|^packages/[^/]+/src/|^adapters/|^corpus/|^migrations/|^evals/' || true)
if [ -n "$OFFENDING" ]; then
  echo "FAIL — root commit contains implementation paths:"; echo "$OFFENDING" | sed 's/^/         /'; FAIL=1
else
  echo "ok — root commit contains no path under src/, packages/*/src/, adapters/, corpus/, migrations/ or evals/"
fi
CODE=$(echo "$FILES" | grep -E '\.(ts|sql)$' || true)
if [ -n "$CODE" ]; then
  echo "FAIL — root commit contains .ts or .sql files:"; echo "$CODE" | sed 's/^/         /'; FAIL=1
else
  echo "ok — root commit contains no .ts and no .sql file"
fi
if echo "$FILES" | grep -qx 'SPEC.md' && echo "$FILES" | grep -qx 'DECISIONS.md'; then
  echo "ok — root commit contains SPEC.md and DECISIONS.md"
else
  echo "FAIL — root commit is missing SPEC.md or DECISIONS.md"; FAIL=1
fi
echo "PASS=$([ $FAIL -eq 0 ] && echo 3 || echo 0)"
exit $FAIL
