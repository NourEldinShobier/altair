/**
 * Building a path from a named route and a set of values, ported from
 * `ActionDispatch::Journey::Formatter` and `Routing::RouteSet#url_for`.
 *
 * `pattern.ts` fills one pattern's holes. This is the step above: given
 * `{controller: "posts", action: "show", id: 7}` and a table of routes, find
 * which route was meant and generate its path.
 *
 * That lookup is the whole difficulty, and it is where a router quietly does
 * the wrong thing. A set of values usually matches several routes —
 * `/posts/:id` and `/posts/:id/edit` both accept `{id: 7}` — so "the first one
 * that matches" is a coin toss decided by declaration order. Rails scores
 * candidates instead, and the rules that produce the score are all about
 * generating the *most specific* route the values can fill:
 *
 * - A route needing a value that was not supplied is out. Filling it from
 *   somewhere else is how `link_to` on one page produces a URL containing the
 *   *current* page's id.
 * - Among the rest, the one using the most of what was supplied wins, because
 *   a supplied value the route ignores becomes a query parameter, and a link
 *   that was meant to be `/posts/7/edit` silently becomes `/posts?id=7&…`.
 * - Ties break on declaration order, so the answer is at least stable.
 *
 * The other half is **recall**: the values from the request currently being
 * served, so `link_to "Next", page: 2` keeps the controller and action it is
 * already in. Recall is a convenience that has to be bounded — a recalled
 * value that survives past the segment it belongs to is how a link on
 * `/posts/7` ends up pointing at `/comments/7`.
 */

import { type CompiledPattern, buildFormatter, compilePattern, parsePattern } from "./pattern.js";

/** A route as the generator needs to see it. */
export interface GeneratableRoute {
  name?: string;
  /** The raw pattern, e.g. `/posts/:id(.:format)`. */
  pattern: string;
  /** Values the route supplies itself: `{controller: "posts", action: "show"}`. */
  defaults?: Record<string, unknown>;
  /** Declaration order, used only to break ties. */
  precedence?: number;
}

interface PreparedRoute extends GeneratableRoute {
  compiled: CompiledPattern;
  required: string[];
  optional: string[];
  precedence: number;
}

/**
 * Rails' `required_defaults` — the defaults a caller has to agree with.
 *
 * A route with `action: "show"` baked in cannot generate a link asking for
 * `action: "edit"`, and treating the mismatch as "close enough" produces a URL
 * that routes back to the wrong action.
 */
export function requiredDefaults(route: GeneratableRoute): Record<string, unknown> {
  return route.defaults ?? {};
}

/** Rails' `route_defined?`. */
export function routeDefined(routes: readonly GeneratableRoute[], name: string): boolean {
  return routes.some((route) => route.name === name);
}

/** Rails' `has_named_route?`. */
export function hasNamedRoute(routes: readonly GeneratableRoute[], name: string): boolean {
  return routeDefined(routes, name);
}

/**
 * Rails' `normalize_controller!` — a controller relative to the current one.
 *
 * `controller: "comments"` inside `admin/posts` means `admin/comments`, and
 * `controller: "/comments"` means the top level. Without the distinction there
 * is no way to link out of a namespace at all.
 */
export function normalizeController(controller: string, current?: string): string {
  if (controller.startsWith("/")) return controller.slice(1);
  if (!current) return controller;
  if (!useRelativeController(controller)) return controller;

  const namespace = current.split("/").slice(0, -1);

  return [...namespace, controller].join("/");
}

/** Rails' `use_relative_controller!` — only a bare name is relative. */
export function useRelativeController(controller: string): boolean {
  return !controller.startsWith("/") && !controller.includes("/");
}

/** Rails' `normalize_controller_action_id!`. */
export function normalizeControllerActionId(
  values: Record<string, unknown>,
  recall: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...values };

  if (normalized["controller"] === undefined && recall["controller"] !== undefined) {
    normalized["controller"] = recall["controller"];
  }

  if (normalized["controller"] !== undefined && typeof normalized["controller"] === "string") {
    normalized["controller"] = normalizeController(
      normalized["controller"],
      recall["controller"] as string | undefined,
    );
  }

  return normalized;
}

/**
 * Which recalled values may be carried into a generation. Rails'
 * `use_recall_for`.
 *
 * A recalled value is dropped as soon as the caller supplies anything *earlier*
 * in the same path — supply a new `controller` and the recalled `action` and
 * `id` go with it, because they described a page that no longer applies. That
 * cascade is what stops a link on `/posts/7` pointing at `/comments/7`.
 */
export const RECALL_CASCADE = ["controller", "action", "id"] as const;

export function useRecallFor(
  values: Record<string, unknown>,
  recall: Record<string, unknown>,
  cascade: readonly string[] = RECALL_CASCADE,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  let superseded = false;

  for (const key of cascade) {
    if (values[key] !== undefined) {
      superseded = true;
      continue;
    }

    if (!superseded && recall[key] !== undefined) kept[key] = recall[key];
  }

  return kept;
}

// --- choosing a route ------------------------------------------------------

function prepare(route: GeneratableRoute, index: number): PreparedRoute {
  const compiled = compilePattern(route.pattern);

  return {
    ...route,
    compiled,
    required: compiled.requiredNames,
    optional: compiled.optionalNames,
    precedence: route.precedence ?? index,
  };
}

/** Rails' `missing_keys` — what a route needs and was not given. */
export function missingKeys(route: GeneratableRoute, values: Record<string, unknown>): string[] {
  const compiled = compilePattern(route.pattern);

  return compiled.requiredNames.filter(
    (name) => values[name] === undefined && requiredDefaults(route)[name] === undefined,
  );
}

/**
 * The routes a set of values could generate. Rails' `possibles`.
 *
 * A route whose baked-in defaults disagree with what was asked for is not a
 * candidate at all: generating it would produce a URL that routes to a
 * different action than the caller named.
 */
export function possibles(
  routes: readonly GeneratableRoute[],
  values: Record<string, unknown>,
  name?: string,
): GeneratableRoute[] {
  return routes.filter((route) => {
    if (name !== undefined && route.name !== name) return false;

    for (const [key, expected] of Object.entries(requiredDefaults(route))) {
      if (values[key] !== undefined && values[key] !== expected) return false;
    }

    return missingKeys(route, values).length === 0;
  });
}

/**
 * How well a route uses what it was given. Higher is better.
 *
 * Counting the *supplied* values a route consumes, because anything left over
 * becomes a query string — and a link meant to be `/posts/7/edit` silently
 * becoming `/posts?id=7` is the failure this ordering exists to prevent.
 */
export function scoreRoute(route: GeneratableRoute, values: Record<string, unknown>): number {
  const compiled = compilePattern(route.pattern);
  const names = new Set([...compiled.requiredNames, ...compiled.optionalNames]);

  return Object.keys(values).filter((key) => names.has(key)).length;
}

export class NoRouteMatches extends Error {
  constructor(values: Record<string, unknown>, name?: string) {
    super(
      `No route generates ${name ? `${JSON.stringify(name)} with ` : ""}` +
        `${JSON.stringify(values)}. Falling back to a route that ignores some of these would ` +
        `put them in the query string, producing a URL that looks right and routes somewhere ` +
        `else.`,
    );
    this.name = "NoRouteMatches";
  }
}

/**
 * Picks the route to generate. Rails' `match_route`.
 *
 * Most values consumed first, declaration order to break ties — so the answer
 * is deterministic rather than a function of which route happened to be
 * declared first.
 */
export function matchRoute(
  routes: readonly GeneratableRoute[],
  values: Record<string, unknown>,
  name?: string,
): PreparedRoute {
  const candidates = possibles(routes, values, name).map((route) =>
    prepare(route, routes.indexOf(route)),
  );

  const best = candidates.sort((left, right) => {
    const difference = scoreRoute(right, values) - scoreRoute(left, values);

    return difference !== 0 ? difference : left.precedence - right.precedence;
  })[0];

  if (!best) throw new NoRouteMatches(values, name);

  return best;
}

/** What generation produced, and what was left over. */
export interface GeneratedUrl {
  path: string;
  /** Values no segment consumed. Rails puts these in the query string. */
  query: Record<string, unknown>;
}

/**
 * Rails' `extract_parameterized_parts` — split into what the path takes and
 * what becomes a query string.
 */
export function extractParameterizedParts(
  route: GeneratableRoute,
  values: Record<string, unknown>,
): { parts: Record<string, unknown>; query: Record<string, unknown> } {
  const compiled = compilePattern(route.pattern);
  const names = new Set([...compiled.requiredNames, ...compiled.optionalNames]);
  const parts: Record<string, unknown> = { ...requiredDefaults(route) };
  const query: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (names.has(key)) parts[key] = value;
    // A default the route bakes in is not a query parameter: `action: "show"`
    // belongs to the route, and echoing it back would put `?action=show` on
    // every generated URL.
    else if (requiredDefaults(route)[key] === undefined) query[key] = value;
  }

  return { parts, query };
}

/**
 * Rails' `generate` — a path from a set of values.
 */
export function generate(
  routes: readonly GeneratableRoute[],
  values: Record<string, unknown>,
  { name, recall = {} }: { name?: string; recall?: Record<string, unknown> } = {},
): GeneratedUrl {
  const withController = normalizeControllerActionId(values, recall);
  const merged = { ...useRecallFor(withController, recall), ...withController };
  const route = matchRoute(routes, merged, name);
  const { parts, query } = extractParameterizedParts(route, merged);

  return { path: buildFormatter(parsePattern(route.pattern)).evaluate(parts), query };
}

/** Rails' `url_for` — the path plus its query string. */
export function urlFor(
  routes: readonly GeneratableRoute[],
  values: Record<string, unknown>,
  options: { name?: string; recall?: Record<string, unknown> } = {},
): string {
  const { path, query } = generate(routes, values, options);
  const search = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString();

  return search ? `${path}?${search}` : path;
}

// --- named helpers ---------------------------------------------------------

/** The helper name a route gets. Rails' `generate_url_helpers`. */
export function urlHelperNames(route: GeneratableRoute): { path: string; url: string } | undefined {
  if (!route.name) return undefined;

  return { path: `${route.name}Path`, url: `${route.name}Url` };
}

export function generateUrlHelpers(routes: readonly GeneratableRoute[]): string[] {
  return routes.flatMap((route) => {
    const names = urlHelperNames(route);

    return names ? [names.path, names.url] : [];
  });
}

/**
 * Whether a route can skip the whole search. Rails' `optimize_helper?` and
 * `optimize_routes_generation?`.
 *
 * A named route with no optional segments and no defaults beyond its own
 * controller and action always generates the same shape, so the values can go
 * straight into the pattern. This is the difference between a `link_to` in a
 * loop costing a scored search per row and costing a string interpolation.
 *
 * Refused as soon as anything could change the answer — a recall to consider,
 * an optional group, a value the route does not name — because an optimised
 * path that is wrong is worse than a slow one that is right.
 */
export function optimizeHelper(
  route: GeneratableRoute,
  values: Record<string, unknown>,
  recall: Record<string, unknown> = {},
): boolean {
  if (!route.name) return false;
  if (Object.keys(recall).length > 0) return false;

  const compiled = compilePattern(route.pattern);

  if (compiled.optionalNames.length > 0) return false;

  const supplied = Object.keys(values);
  const defaults = requiredDefaults(route);

  return supplied.every(
    (key) => compiled.requiredNames.includes(key) || defaults[key] !== undefined,
  );
}

/** Rails' `optimize_routes_generation?` at the set level. */
export function optimizeRoutesGeneration(recall: Record<string, unknown>): boolean {
  return Object.keys(recall).length === 0;
}

// --- mounted engines -------------------------------------------------------

const mounted = new Map<string, string>();

/** Rails' `define_mounted_helper`. */
export function defineMountedHelper(name: string, prefix: string): void {
  mounted.set(name, prefix);
}

/** Rails' `mounted_helpers`. */
export function mountedHelpers(): string[] {
  return [...mounted.keys()].sort();
}

export function mountedPrefix(name: string): string | undefined {
  return mounted.get(name);
}

export function clearMountedHelpers(): void {
  mounted.clear();
}
