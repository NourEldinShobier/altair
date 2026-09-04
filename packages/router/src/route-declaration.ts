/**
 * What the router checks and fills in when a route is declared, ported from
 * `ActionDispatch::Routing::Mapper::Mapping` and `Resource`.
 *
 * `resource-scope.ts` works out what a nested `resources` block contributes to
 * a path. This is the step before that: the handful of decisions made about a
 * single declaration, each of which is silent when it goes wrong.
 *
 * - **A route with no HTTP method matches every method.** `match "/pay"` with
 *   no `via` answers a GET *and* a POST, so a link a crawler follows runs the
 *   action that takes the payment. Rails refuses the declaration rather than
 *   guessing, and says what to write instead.
 * - **A format suffix is appended, but not twice.** Almost every route ends in
 *   an optional `(.:format)`; a path that already names a format must not get
 *   a second one, because `/feed.rss(.:format)` matches `/feed.rss.rss` and
 *   not `/feed.rss`.
 * - **A constraint the request cannot answer is dropped.** A `constraints:`
 *   naming something the request object has no method for would never match,
 *   and a route that never matches is a 404 nobody can explain.
 */

export type Via = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export class MissingVia extends Error {
  constructor() {
    super(
      "A route declared with `match` has to say which HTTP methods it answers.\n" +
        "  For both: match(\"/pay\", { via: ['get', 'post'] })\n" +
        '  For one:  get("/pay")\n' +
        "Without it the route answers every method, so a link a crawler follows runs the " +
        "action that takes the payment.",
    );
    this.name = "MissingVia";
  }
}

/**
 * Rails' `check_via` — a `match` must name its methods.
 *
 * Refused rather than defaulted. Defaulting to GET would quietly break the
 * routes that meant both, and defaulting to all of them is the hazard above;
 * there is no safe guess, which is why the error names the two ways to say it.
 */
export function checkVia(via: readonly string[]): Via[] {
  if (via.length === 0) throw new MissingVia();

  return via.map((method) => method.toLowerCase() as Via);
}

/** A path that already ends in a format segment, in any of its spellings. */
const ALREADY_FORMATTED = /\(?\.:format\)?$/;

/**
 * Whether a path should get an optional format suffix. Rails'
 * `optional_format?`.
 *
 * Not when the declaration turned it off, and not when the path already ends
 * in one: `/feed.:format(.:format)` matches `/feed.rss.rss` and not
 * `/feed.rss`, which is a 404 on the route somebody just wrote.
 */
export function optionalFormat(path: string, format?: boolean): boolean {
  return format !== false && !ALREADY_FORMATTED.test(path);
}

/**
 * The path a declaration actually registers. Rails' `normalize_path`.
 *
 * `format: true` makes the suffix required, which is what an API route that
 * must not answer a bare path wants — `/posts/1` with no extension should be a
 * 404 there rather than HTML.
 */
export function pathWithFormat(path: string, format?: boolean): string {
  if (format === true) return `${path}.:format`;
  if (optionalFormat(path, format)) return `${path}(.:format)`;

  return path;
}

/**
 * Rails' `build_conditions` — the constraints a request can be asked about.
 *
 * A constraint on something the request has no answer for is dropped rather
 * than kept and evaluated as undefined. Kept, the route matches nothing at
 * all, and a route that never matches is a 404 with no explanation — the
 * declaration is right there in the file and looks correct.
 */
export function buildConditions(
  conditions: Readonly<Record<string, unknown>>,
  answerable: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(conditions).filter(([name]) => answerable.includes(name)),
  );
}
