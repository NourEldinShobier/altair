/**
 * How nested `resources` blocks build a route, ported from
 * `ActionDispatch::Routing::Mapper::Scoping` and `Resources`.
 *
 * A routes file is a tree of blocks, and each one contributes a piece of every
 * route declared inside it — a path segment, a controller namespace, a
 * constraint, a name prefix. The whole feature is what happens when those
 * pieces combine, and the combining rules are not symmetric:
 *
 * - **Paths and name prefixes concatenate; constraints merge; defaults are
 *   overridden.** A nested block adding `format: :json` should replace an outer
 *   `format: :html` rather than producing both, while a nested constraint
 *   should narrow the outer one rather than replacing it. Getting either
 *   backwards produces routes that exist and never match.
 * - **A member scope and a nested scope differ by one segment and by meaning.**
 *   `member` acts on one record, `nested` acts on that record's children, and
 *   the difference is `/:id` versus `/:post_id`. Using the record's own `:id`
 *   for the nested case makes the child route's parameter collide with the
 *   child's own id — which reads as a routing bug and is a naming one.
 * - **Shallow nesting exists because deep URLs are unusable.**
 *   `/posts/1/comments/2/edit` names the post twice: once as context nobody
 *   needs and once as a parameter nothing reads. Shallow routes keep the parent
 *   only where it is load-bearing — the collection actions — and drop it from
 *   the member ones.
 */

export interface Scope {
  /** Path segments contributed by every enclosing block. */
  path: string[];
  /** The prefix a generated helper name gets. */
  as: string[];
  /** The controller namespace. */
  module: string[];
  constraints: Record<string, RegExp | string>;
  defaults: Record<string, unknown>;
  shallow: boolean;
}

export function newScope(overrides: Partial<Scope> = {}): Scope {
  return {
    path: [],
    as: [],
    module: [],
    constraints: {},
    defaults: {},
    shallow: false,
    ...overrides,
  };
}

/**
 * Rails' `scope` — one block's contribution merged onto its parent's.
 *
 * The asymmetry is the whole point. Paths, names and modules *concatenate*,
 * because each block adds a level. Constraints *merge*, because a nested
 * constraint narrows rather than replaces — replacing would silently widen a
 * route an outer block had deliberately restricted. Defaults are *overridden*,
 * because two values for one parameter is not a narrowing, it is a
 * contradiction, and keeping both would make the route match neither.
 */
export function withDefaultScope(parent: Scope, added: Partial<Scope>): Scope {
  return {
    path: [...parent.path, ...(added.path ?? [])],
    as: [...parent.as, ...(added.as ?? [])],
    module: [...parent.module, ...(added.module ?? [])],
    constraints: { ...parent.constraints, ...added.constraints },
    defaults: { ...parent.defaults, ...added.defaults },
    shallow: added.shallow ?? parent.shallow,
  };
}

/** The path a scope has accumulated. */
export function scopePath(scope: Scope): string {
  const joined = scope.path.filter((segment) => segment !== "").join("/");

  return joined === "" ? "/" : `/${joined}`;
}

/** The helper name prefix a scope has accumulated. */
export function scopeName(scope: Scope, ...extra: string[]): string {
  return [...scope.as, ...extra].filter((part) => part !== "").join("_");
}

/**
 * Rails' `resource_method_scope` — the scope the seven actions are declared in.
 *
 * The collection path, with no id. Every action then adds what it needs, which
 * is what keeps `index` and `show` from having to know about each other.
 */
export function resourceMethodScope(parent: Scope, name: string): Scope {
  return withDefaultScope(parent, { path: [name], as: [name] });
}

/**
 * Rails' `member_scope` — acting on one record.
 *
 * `/:id`. The parameter is the resource's own, because a member action reads
 * the record the route names.
 */
export function memberScope(parent: Scope, name: string, param = "id"): Scope {
  return withDefaultScope(parent, { path: [name, `:${param}`], as: [name] });
}

/**
 * Rails' `nested_scope` — acting on a record's children.
 *
 * `/:post_id`, not `/:id`. The child's own route already uses `:id`, so using
 * it here too makes the two collide — the child controller reads `params[:id]`
 * and gets the parent's. That reads as a routing bug and is a naming one, and
 * it is why every nested route in Rails names its parent explicitly.
 */
export function nestedScope(parent: Scope, name: string, singular: string): Scope {
  return withDefaultScope(parent, { path: [name, `:${singular}_id`], as: [singular] });
}

/**
 * Rails' `shallow` — drop the parent from routes that do not need it.
 *
 * A member action already has an id that identifies the record uniquely, so
 * the parent segment in `/posts/1/comments/2` is context nobody needs and a
 * parameter nothing reads. Collection actions keep it, because `index` and
 * `create` genuinely need to know which parent.
 */
export function shallow(scope: Scope, action: "collection" | "member"): Scope {
  if (!scope.shallow || action === "collection") return scope;

  // Only the trailing parent segments are dropped — the resource's own name
  // and id stay, since without them there is no route at all.
  const kept = scope.path.filter((segment) => !segment.startsWith(":") || segment === ":id");

  return { ...scope, path: kept.slice(-1), as: scope.as.slice(-1) };
}

/**
 * Rails' `resources_path_names` — the words `new` and `edit` appear as.
 *
 * Configurable because they are user-visible, and an application in another
 * language wants `/posts/nuevo`. The *action* names do not change, only the
 * segments — changing both would make every controller in the application
 * speak that language too.
 */
export function resourcesPathNames(overrides: Record<string, string> = {}): {
  new: string;
  edit: string;
} {
  return { new: "new", edit: "edit", ...overrides };
}

// --- building a route --------------------------------------------------------------

export interface RouteSpec {
  name?: string;
  verb: string;
  path: string;
  controller: string;
  action: string;
  constraints: Record<string, RegExp | string>;
  defaults: Record<string, unknown>;
}

export class DuplicateRouteName extends Error {
  constructor(name: string) {
    super(
      `There is already a route named ${JSON.stringify(name)}. A second one would shadow the ` +
        `first for every helper that names it, so one of two routes becomes unreachable through ` +
        `its own name — with nothing at boot to say which.`,
    );
    this.name = "DuplicateRouteName";
  }
}

/**
 * Rails' `add_route`.
 *
 * Refuses a duplicate name at declaration. A second route with the same name
 * shadows the first for every helper, so one of two routes becomes unreachable
 * through its own name — and nothing reports it until somebody notices a link
 * going to the wrong place.
 */
export function addRoute(routes: RouteSpec[], route: RouteSpec): RouteSpec[] {
  if (route.name !== undefined && routes.some((each) => each.name === route.name)) {
    throw new DuplicateRouteName(route.name);
  }

  routes.push(route);

  return routes;
}

/** Rails' `make_route` — a scope and an action become a route. */
export function makeRoute(
  scope: Scope,
  {
    verb,
    action,
    controller,
    segment,
    name,
  }: { verb: string; action: string; controller: string; segment?: string; name?: string },
): RouteSpec {
  const path = [scopePath(scope), segment].filter((part) => part !== undefined && part !== "");

  return {
    ...(name === undefined ? {} : { name: scopeName(scope, name) }),
    verb: verb.toUpperCase(),
    path: path.join("/").replaceAll(/\/+/g, "/"),
    controller: [...scope.module, controller].join("/"),
    action,
    constraints: { ...scope.constraints },
    defaults: { ...scope.defaults },
  };
}

/**
 * Rails' `required_parts` — the segments a route cannot be generated without.
 *
 * Dynamic segments outside optional groups. A helper called without one of
 * these has to raise rather than build a path with a gap in it: the gap
 * produces a URL that routes somewhere else, and the router then reports a
 * missing route for a path the application generated itself.
 */
export function requiredParts(pattern: string): string[] {
  const withoutOptional = pattern.replaceAll(/\([^()]*\)/g, "");

  return [...withoutOptional.matchAll(/[:*](\w+)/g)].map((match) => match[1]!);
}

/**
 * Rails' `required_defaults` — defaults that are part of matching, not just of
 * generation.
 *
 * A default for a segment the path contains is a fallback. A default for
 * something the path does *not* mention is a requirement: `defaults: { format:
 * "json" }` on a route with no `:format` segment means the route only matches
 * a request already asking for JSON.
 */
export function requiredDefault(
  pattern: string,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const parts = new Set(requiredParts(pattern));
  const optional = new Set([...pattern.matchAll(/[:*](\w+)/g)].map((match) => match[1]!));

  return Object.fromEntries(
    Object.entries(defaults).filter(([key]) => !parts.has(key) && !optional.has(key)),
  );
}

/**
 * Rails' `requires_matching_verb?`.
 *
 * A route declared with `match` and no `via:` answers every verb, which is
 * almost never wanted — a `GET` to a destroy action is exactly the shape of a
 * link a crawler follows. So a route with an explicit verb requires it, and
 * one without is reported as answering everything so a caller can decide
 * whether that is deliberate.
 */
export function requiresMatchingVerb(route: { verb?: string }): boolean {
  return route.verb !== undefined && route.verb !== "" && route.verb !== "ANY";
}

/**
 * Rails' `from_requirements` — a constraint's pattern as a source string.
 *
 * Anchors are refused. A segment constraint is applied to one segment already,
 * so `\A` and `\z` inside it either do nothing or make the route unmatchable —
 * and Rails raises rather than letting somebody debug a route that is correct
 * everywhere except in the one file that describes it.
 */
export function fromRequirements(constraint: RegExp | string): string {
  const source = typeof constraint === "string" ? constraint : constraint.source;

  if (/\\A|\\[zZ]|\^|\$/.test(source)) {
    throw new Error(
      `The constraint ${JSON.stringify(source)} is anchored. A segment constraint already applies ` +
        `to exactly one segment, so an anchor either does nothing or makes the route match ` +
        `nothing — and a route that cannot match reports itself as missing.`,
    );
  }

  return source;
}

/** Rails' `route_uri_pattern` — the path with its constraints inlined. */
export function routeUriPattern(
  path: string,
  constraints: Record<string, RegExp | string> = {},
): string {
  return path.replaceAll(/:(\w+)/g, (whole, name: string) => {
    const constraint = constraints[name];

    return constraint === undefined ? whole : `:${name}<${fromRequirements(constraint)}>`;
  });
}

/**
 * Rails' `partition_route` — routes split by whether they can match a request.
 *
 * Static paths are checked before dynamic ones. A dynamic route declared first
 * would otherwise swallow a static path declared later — `/posts/:id` matching
 * `/posts/new` — which is the single most common routing surprise there is.
 */
export function partitionRoute(routes: readonly RouteSpec[]): {
  static: RouteSpec[];
  dynamic: RouteSpec[];
} {
  return {
    static: routes.filter((route) => !/[:*]/.test(route.path)),
    dynamic: routes.filter((route) => /[:*]/.test(route.path)),
  };
}

/** Rails' `route_for` — the first route answering a name. */
export function routeFor(routes: readonly RouteSpec[], name: string): RouteSpec | undefined {
  return routes.find((route) => route.name === name);
}

export class NoRoutes extends Error {
  constructor(detail: string) {
    super(
      `No route matches ${detail}. A path the application generated itself and cannot route back ` +
        `usually means a helper was called without a required segment.`,
    );
    this.name = "NoRoutes";
  }
}

/** Rails' `no_routes` — the error when nothing matched. */
export function noRoutes(detail: string): never {
  throw new NoRoutes(detail);
}

/** Rails' `matches_filter?` — whether a route passes a `rails routes` filter. */
export function matchesFilter(route: RouteSpec, filter: string): boolean {
  const lower = filter.toLowerCase();

  // Matched against the path, the name and the controller#action, because
  // somebody grepping routes has one of the three in hand and rarely knows
  // which of them the framework calls it.
  return (
    route.path.toLowerCase().includes(lower) ||
    (route.name ?? "").toLowerCase().includes(lower) ||
    `${route.controller}#${route.action}`.toLowerCase().includes(lower)
  );
}

// --- polymorphic routes ---------------------------------------------------------------

const polymorphicMappings = new Map<string, string>();

/**
 * Rails' `add_polymorphic_mapping` — which route a class maps to.
 *
 * Registered rather than derived, because a model's class name and its route
 * name diverge often enough to matter — a namespaced model, an STI subclass, a
 * model whose route lives under a different resource.
 */
export function addPolymorphicMapping(className: string, routeName: string): void {
  polymorphicMappings.set(className, routeName);
}

export function resetPolymorphicMappings(): void {
  polymorphicMappings.clear();
}

/**
 * Rails' `polymorphic_method` — the helper name for a record.
 *
 * An STI subclass falls back to its base class, because `polymorphic_url` is
 * how a shared partial links to whatever it was given — and a subclass with no
 * routes of its own is the normal case rather than an error.
 */
export function polymorphicMethod(
  record: { constructorName: string; baseName?: string; persisted?: boolean },
  suffix: "path" | "url" = "path",
): string {
  const mapped =
    polymorphicMappings.get(record.constructorName) ??
    (record.baseName === undefined ? undefined : polymorphicMappings.get(record.baseName));

  const base = mapped ?? underscoreName(record.constructorName);

  // A new record links to the collection — that is where a form posts. Linking
  // to the member route would build a path with no id in it.
  return record.persisted === false ? `${pluralize(base)}_${suffix}` : `${base}_${suffix}`;
}

/** Rails' `polymorphic_url`. */
export function polymorphicUrl(
  record: { constructorName: string; baseName?: string; persisted?: boolean; id?: unknown },
  { suffix = "path" }: { suffix?: "path" | "url" } = {},
): { helper: string; args: unknown[] } {
  const helper = polymorphicMethod(record, suffix);

  return { helper, args: record.persisted === false ? [] : [record.id] };
}

function underscoreName(name: string): string {
  return name
    .replaceAll(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll("::", "_")
    .toLowerCase();
}

function pluralize(name: string): string {
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`;

  return `${name}s`;
}

/** Rails' `post_match` — whether a matched route still satisfies its constraints. */
export function postMatch(route: RouteSpec, params: Record<string, string>): boolean {
  return Object.entries(route.constraints).every(([name, constraint]) => {
    const value = params[name];

    if (value === undefined) return true;

    const pattern = typeof constraint === "string" ? new RegExp(constraint) : constraint;

    // Anchored here rather than at declaration: the constraint describes a
    // whole segment, and an unanchored test would accept a segment that merely
    // contains a match — `/posts/12abc` passing a numeric id constraint.
    return new RegExp(`^(?:${pattern.source})$`).test(value);
  });
}
