/**
 * Assertions about a route table, ported from
 * `ActionDispatch::Assertions::RoutingAssertions`.
 *
 *     assertRouting(router, { method: "GET", path: "/posts/1" }, {
 *       controller: "posts",
 *       action: "show",
 *       params: { id: "1" },
 *     })
 *
 * Routes are the one part of an application every request passes through and
 * almost nobody tests, because testing them through a request means standing
 * up a controller and asserting on a response — which fails for a dozen
 * reasons that have nothing to do with routing.
 *
 * These ask the table directly. `assertRecognizes` checks a path reaches the
 * action; `assertGenerates` checks the helper produces the path; `assertRouting`
 * checks both, which is what catches the pair drifting apart — a route renamed
 * on one side and not the other still recognises and still generates, just not
 * the same path.
 */

import { AssertionFailed } from "@altair/support";

/** The slice of a router these need. Structural, so a double can stand in. */
export interface RoutableTable {
  recognize(
    method: string,
    path: string,
  ): { controller: string; action: string; params: Record<string, string> } | null;
  pathHelpers(): Record<string, (...args: never[]) => string>;
}

/** A request, as far as routing is concerned. */
export interface RoutedRequest {
  method: string;
  path: string;
}

/** Where a request should land. */
export interface RoutedTo {
  controller: string;
  action: string;
  /** The segment values, if any. Compared exactly when given. */
  params?: Record<string, string>;
}

function describe(request: RoutedRequest): string {
  return `${request.method.toUpperCase()} ${request.path}`;
}

/**
 * Rails' `assert_recognizes`: this path reaches this action.
 *
 * The failure names what it did reach, because "did not recognise" and
 * "recognised something else" are different bugs and only one of them is about
 * the path being missing.
 */
export function assertRecognizes(
  router: RoutableTable,
  request: RoutedRequest,
  expected: RoutedTo,
): void {
  const found = router.recognize(request.method, request.path);

  if (!found) {
    throw new AssertionFailed(
      `No route recognises ${describe(request)}. Expected ${expected.controller}#${expected.action}.`,
    );
  }

  if (found.controller !== expected.controller || found.action !== expected.action) {
    throw new AssertionFailed(
      `${describe(request)} reaches ${found.controller}#${found.action}, ` +
        `not ${expected.controller}#${expected.action}.`,
    );
  }

  if (expected.params === undefined) return;

  const actual = JSON.stringify(found.params);
  const wanted = JSON.stringify(expected.params);

  if (actual !== wanted) {
    throw new AssertionFailed(
      `${describe(request)} reaches ${found.controller}#${found.action} with ${actual}, not ${wanted}.`,
    );
  }
}

/**
 * Rails' `assert_generates`: this helper produces this path.
 *
 * Named by the helper rather than by controller and action, because that is
 * what an application actually calls — a view writes `postPath(post)`, and a
 * helper that silently produces the wrong path is a link to the wrong page.
 */
export function assertGenerates(
  router: RoutableTable,
  path: string,
  helper: string,
  ...args: unknown[]
): void {
  const helpers = router.pathHelpers();
  const build = helpers[helper];

  if (!build) {
    const available = Object.keys(helpers).sort().slice(0, 8).join(", ");

    throw new AssertionFailed(
      `There is no "${helper}" path helper.` + (available ? ` Some that exist: ${available}.` : ""),
    );
  }

  const generated = build(...(args as never[]));

  if (generated !== path) {
    throw new AssertionFailed(`${helper} generates "${generated}", not "${path}".`);
  }
}

/**
 * Rails' `assert_routing`: both directions at once.
 *
 * The pair drifting apart is the failure worth catching. A route renamed on one
 * side and not the other still recognises and still generates — just not the
 * same path — and each half passes its own test.
 */
export function assertRouting(
  router: RoutableTable,
  request: RoutedRequest,
  expected: RoutedTo & { helper: string; args?: unknown[] },
): void {
  assertRecognizes(router, request, expected);
  assertGenerates(router, request.path, expected.helper, ...(expected.args ?? []));
}

/** Rails' `assert_no_route`: nothing answers this. */
export function assertNoRoute(router: RoutableTable, request: RoutedRequest): void {
  const found = router.recognize(request.method, request.path);

  if (found) {
    throw new AssertionFailed(
      `${describe(request)} reaches ${found.controller}#${found.action}, and should reach nothing.`,
    );
  }
}
