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

# --threads=1 on purpose. oxfmt runs its formatting in a worker pool, and
# spawning one of those workers fails intermittently on Windows when this
# script has its output on a pipe: "UNKNOWN, spawn" out of tinypool, about
# one verify run in three. It never happened running oxfmt straight from a
# terminal, which is why it looked like a test failure the first two times.
# One thread has no pool to spawn, and costs 0.4s on this repository.
step "format" bunx oxfmt --threads=1 .
step "typecheck" bun run typecheck
step "lint" bunx oxlint --deny-warnings
step "format check" bunx oxfmt --threads=1 --check .

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
