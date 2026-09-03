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
# A literal backspace in a source file, which is what a mangled `\b` leaves
# behind. It has happened six times, once to this check itself: a regex written
# through a shell heredoc arrives with the character where the escape should
# be, the file still parses, the formatter still passes, and the pattern
# silently matches nothing.
#
# Backspace only. A NUL is legitimate here, `dom.ts` joins cycle keys on one,
# and so is an ESC, which `logger.ts` writes ANSI colour with. Banning those
# would flag the intended ones, and a check that cries wolf is turned off.
#
# perl rather than grep, because GNU grep cannot match a NUL and reads a
# pattern containing one as ending there. The first version of this check was
# written through a heredoc, had its own pattern mangled into exactly the two
# bytes it was looking for, and so passed on every file that contained them.
BACKSPACED=$(find packages tools \( -name '*.ts' -o -name '*.tsx' \) \
  -exec perl -0777 -ne 'print "$ARGV\n" if /\x08/' {} +)
if [ -n "$BACKSPACED" ]; then
  echo "FAILED: a literal backspace in source, where an escape was meant"
  echo "$BACKSPACED"
  exit 1
fi

# What the formatter is about to change, recorded before it changes it.
#
# This script formats and then checks, so a run that reformats a file still
# ends in ALL GREEN — and the fix lives in the working tree rather than
# in the commit. Committing after a green verify then failed CI on the one
# file verify had silently fixed. Green now says whether anything was touched.
UNFORMATTED=$(bunx oxfmt --threads=1 --check . 2>&1 | grep -oE "[^ ]+\.(ts|tsx|md|json|css)" || true)

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

if [ -n "$UNFORMATTED" ]; then
  echo "ALL GREEN (reformatted, stage these before committing):"
  echo "$UNFORMATTED" | sed "s/^/  /"
else
  echo "ALL GREEN"
fi
