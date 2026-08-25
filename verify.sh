#!/usr/bin/env bash
# One gate before every commit. Added after I twice pushed a red build by
# checking these separately and misreading a grep exit code. It names the step
# that failed, because a bare exit code cost a round trip to diagnose.
cd "$(dirname "$0")"

step() {
  local name="$1"; shift
  local out
  if ! out=$("$@" 2>&1); then
    echo "FAILED: $name"
    echo "$out" | tail -25
    exit 1
  fi
}

step "format" bunx oxfmt .
step "typecheck" bun run typecheck
step "lint" bunx oxlint --deny-warnings
step "format check" bunx oxfmt --check .

OUT=$(bun test 2>&1)
echo "$OUT" | grep -E "^ [0-9]+ (pass|fail)" || true

if ! echo "$OUT" | grep -qE "^ 0 fail"; then
  echo "FAILED: tests"
  echo "$OUT" | grep -A6 "^(fail)" | head -40
  exit 1
fi

# The public claim about how far along this is, checked against the suite that
# produced it. It had drifted three times before anything checked.
if ! PARITY=$(bun run tools/check-parity.ts 2>&1); then
  echo "FAILED: parity numbers"
  echo "$PARITY"
  exit 1
fi

echo "ALL GREEN"
