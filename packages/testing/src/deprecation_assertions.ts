/**
 * Assertions about deprecation warnings, ported from
 * `ActiveSupport::Testing::Deprecation`.
 *
 * These are what make "we deprecated it" a fact rather than an intention. A
 * deprecation nobody asserts on is one that can be deleted, renamed, or
 * silently stop firing, and the first anyone hears of it is when the removal
 * lands on a caller who never saw a warning.
 */

import { AssertionFailed, type Deprecator } from "@altair/support";

/**
 * Everything the deprecator warned about during the block, and the block's
 * own result. Rails' `collect_deprecations`.
 *
 * The behaviour is swapped for a collector and put back afterwards, so the
 * warnings do not also reach stderr and make a passing test look noisy.
 */
export function collectDeprecations<T>(
  deprecator: Deprecator,
  body: () => T,
): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const previous = deprecator.behavior;

  deprecator.behavior = (message: string) => {
    warnings.push(message);
  };

  try {
    return { result: body(), warnings };
  } finally {
    // In a finally, so a block that throws still restores the behaviour.
    // Without it one failing test leaves every later deprecation collected
    // into an array nobody reads, and stderr goes quiet for the whole file.
    deprecator.behavior = previous;
  }
}

/**
 * Asserts the block emitted a matching deprecation. Rails' `assert_deprecated`.
 *
 * The match may be a string that must appear in the message, a regular
 * expression, or nothing at all — in which case any warning satisfies it.
 * Returns the block's result, so the assertion can wrap the call under test
 * rather than sitting beside it.
 */
export function assertDeprecated<T>(
  deprecator: Deprecator,
  matchOrBody: string | RegExp | (() => T),
  maybeBody?: () => T,
): T {
  const match = typeof matchOrBody === "function" ? undefined : matchOrBody;
  const body = typeof matchOrBody === "function" ? matchOrBody : maybeBody!;

  const { result, warnings } = collectDeprecations(deprecator, body);

  if (warnings.length === 0) {
    throw new AssertionFailed("Expected a deprecation warning within the block but received none");
  }

  if (match !== undefined) {
    const matched = warnings.some((one) =>
      typeof match === "string" ? one.includes(match) : match.test(one),
    );

    if (!matched) {
      throw new AssertionFailed(
        `No deprecation warning matched ${String(match)}: ${warnings.join(", ")}`,
      );
    }
  }

  return result;
}

/**
 * Asserts the block emitted none. Rails' `assert_not_deprecated`.
 *
 * Scoped to one deprecator, which is the point: a test can assert its own code
 * is clean while a dependency goes on warning.
 */
export function assertNotDeprecated<T>(deprecator: Deprecator, body: () => T): T {
  const { result, warnings } = collectDeprecations(deprecator, body);

  if (warnings.length > 0) {
    throw new AssertionFailed(
      `Expected no deprecation warning within the block but received ${warnings.length}:\n  ` +
        warnings.join("\n  "),
    );
  }

  return result;
}
