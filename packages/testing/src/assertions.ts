/**
 * The assertions Rails gives the people testing an application, ported from
 * `ActiveSupport::Testing::Assertions` and the per-component ones beside it.
 *
 * Each of these says what a test means rather than how to measure it:
 *
 *     await assertDifference(() => Post.count(), 1, async () => {
 *       await session.post("/posts", { params: { post: { title: "A" } } })
 *     })
 *
 * The hand-written version is three lines of before-and-after bookkeeping, and
 * the failure message it produces says "expected 4 to be 5" rather than which
 * count moved and by how much.
 */

import { AssertionFailed, notifications } from "@altair/support";

/**
 * Raised when an assertion does not hold, with a message a person can act on.
 *
 * Re-exported: it lives in `@altair/support` so the components can raise it
 * from their own assertions without depending on this package.
 */
export { AssertionFailed } from "@altair/support";

function fail(message: string): never {
  throw new AssertionFailed(message);
}

/**
 * Rails' `assert_difference`.
 *
 * Measures before and after, and says which way it went when it is wrong —
 * "went from 3 to 3" is a different bug from "went from 3 to 5".
 */
export async function assertDifference<T>(
  measure: () => number | Promise<number>,
  by: number,
  body: () => T | Promise<T>,
  label = "the value",
): Promise<T> {
  const before = await measure();
  const result = await body();
  const after = await measure();

  if (after - before !== by) {
    fail(
      `Expected ${label} to change by ${by}, but it went from ${before} to ${after} (a change of ${after - before}).`,
    );
  }

  return result;
}

/** Rails' `assert_no_difference`. */
export async function assertNoDifference<T>(
  measure: () => number | Promise<number>,
  body: () => T | Promise<T>,
  label = "the value",
): Promise<T> {
  return await assertDifference(measure, 0, body, label);
}

/**
 * Rails' `assert_changes`: something is different afterwards, whatever it is.
 *
 * For a value that is not a number — a state moving from "draft" to "live".
 */
export async function assertChanges<T, V>(
  measure: () => V | Promise<V>,
  body: () => T | Promise<T>,
  expected?: { from?: V; to?: V },
): Promise<T> {
  const before = await measure();

  if (expected && "from" in expected && before !== expected.from) {
    fail(
      `Expected it to start as ${JSON.stringify(expected.from)}, but it was ${JSON.stringify(before)}.`,
    );
  }

  const result = await body();
  const after = await measure();

  if (before === after) {
    fail(`Expected it to change, but it stayed ${JSON.stringify(after)}.`);
  }

  if (expected && "to" in expected && after !== expected.to) {
    fail(
      `Expected it to become ${JSON.stringify(expected.to)}, but it became ${JSON.stringify(after)}.`,
    );
  }

  return result;
}

/** Rails' `assert_no_changes`. */
export async function assertNoChanges<T, V>(
  measure: () => V | Promise<V>,
  body: () => T | Promise<T>,
): Promise<T> {
  const before = await measure();
  const result = await body();
  const after = await measure();

  if (before !== after) {
    fail(
      `Expected it not to change, but it went from ${JSON.stringify(before)} to ${JSON.stringify(after)}.`,
    );
  }

  return result;
}

/**
 * Rails' `assert_nothing_raised`.
 *
 * Worth having despite being what a test does anyway: the failure names the
 * error rather than letting it propagate as though the test itself broke.
 */
export async function assertNothingRaised<T>(body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    fail(`Expected nothing to be raised, but got ${(error as Error)?.message ?? String(error)}.`);
  }
}

/**
 * The queries a test did not write and cannot control.
 *
 * A model asks the database for its columns the first time it is used, so a
 * count taken with a cold cache is one higher than the same count taken with a
 * warm one — which would make every one of these assertions depend on what ran
 * before it. Rails ignores schema queries for exactly this reason.
 */
const SCHEMA_QUERY =
  /^\s*(PRAGMA|SELECT .* FROM information_schema|SELECT .* FROM pg_|SELECT .* FROM sqlite_master|SHOW )/i;

/** Counts the queries a block runs, off the instrumentation bus. */
async function queriesDuring<T>(body: () => T | Promise<T>): Promise<[T, string[]]> {
  const seen: string[] = [];
  const subscription = notifications.subscribe("sql.altair", (event) => {
    const sql = String((event.payload as { sql?: unknown }).sql ?? "");

    if (!SCHEMA_QUERY.test(sql)) seen.push(sql);
  });

  try {
    return [await body(), seen];
  } finally {
    subscription.unsubscribe();
  }
}

/**
 * Rails' `assert_queries_count`.
 *
 * What catches an N+1 before it reaches production: the page still renders, so
 * nothing else notices that it took forty queries to do it.
 */
export async function assertQueriesCount<T>(count: number, body: () => T | Promise<T>): Promise<T> {
  const [result, queries] = await queriesDuring(body);

  if (queries.length !== count) {
    fail(
      `Expected ${count} ${count === 1 ? "query" : "queries"}, got ${queries.length}:\n` +
        queries.map((sql) => `  ${sql}`).join("\n"),
    );
  }

  return result;
}

export async function assertNoQueries<T>(body: () => T | Promise<T>): Promise<T> {
  return await assertQueriesCount(0, body);
}

/** Rails' `assert_queries_match`: at least one query looked like this. */
export async function assertQueriesMatch<T>(
  pattern: RegExp,
  body: () => T | Promise<T>,
): Promise<T> {
  const [result, queries] = await queriesDuring(body);

  if (!queries.some((sql) => pattern.test(sql))) {
    fail(
      `Expected a query matching ${pattern}, but none of the ${queries.length} run did:\n` +
        queries.map((sql) => `  ${sql}`).join("\n"),
    );
  }

  return result;
}

export async function assertNoQueriesMatch<T>(
  pattern: RegExp,
  body: () => T | Promise<T>,
): Promise<T> {
  const [result, queries] = await queriesDuring(body);
  const matched = queries.filter((sql) => pattern.test(sql));

  if (matched.length > 0) {
    fail(
      `Expected no query matching ${pattern}, but ${matched.length} did:\n` +
        matched.map((sql) => `  ${sql}`).join("\n"),
    );
  }

  return result;
}

/** What a response has to look like. Rails' `assert_response`. */
export type ResponseKind = "success" | "redirect" | "missing" | "error" | number;

export function assertResponse(response: Response, kind: ResponseKind): void {
  const status = response.status;

  const ok =
    typeof kind === "number"
      ? status === kind
      : kind === "success"
        ? status >= 200 && status < 300
        : kind === "redirect"
          ? status >= 300 && status < 400
          : kind === "missing"
            ? status === 404
            : status >= 500;

  if (!ok) fail(`Expected the response to be ${kind}, but it was ${status}.`);
}

/**
 * Rails' `assert_redirected_to`.
 *
 * Compares the path rather than the whole URL when given one, because a test
 * should not have to know the host it was served from.
 */
export function assertRedirectedTo(response: Response, target: string | RegExp): void {
  const location = response.headers.get("location");

  if (!location) {
    fail(`Expected a redirect, but the response was ${response.status} with no location.`);
  }

  const matches =
    target instanceof RegExp
      ? target.test(location)
      : location === target || new URL(location, "https://x.example").pathname === target;

  if (!matches) fail(`Expected a redirect to ${target}, but it went to ${location}.`);
}

/** Rails' `assert_emails`, against whatever the test delivery collected. */
export async function assertEmails<T>(
  deliveries: { length: number },
  count: number,
  body: () => T | Promise<T>,
): Promise<T> {
  return await assertDifference(() => deliveries.length, count, body, "the number of emails");
}

export async function assertNoEmails<T>(
  deliveries: { length: number },
  body: () => T | Promise<T>,
): Promise<T> {
  return await assertEmails(deliveries, 0, body);
}
