#!/usr/bin/env bash
# One gate before every commit. Added after I twice pushed a red build by
# checking these separately and misreading a grep exit code.
set -e
cd "$(dirname "$0")"
bunx oxfmt . > /dev/null
bun run typecheck > /dev/null
bunx oxlint --deny-warnings > /dev/null
OUT=$(bun test 2>&1)
echo "$OUT" | grep -E "^ [0-9]+ (pass|fail)"
echo "$OUT" | grep -qE "^ 0 fail" || { echo "TESTS FAILED"; echo "$OUT" | grep -A5 "^(fail)" | head -30; exit 1; }
bunx oxfmt --check . > /dev/null
echo "ALL GREEN"
