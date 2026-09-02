/**
 * The routing DSL, ported from `ActionDispatch::Routing::Mapper`.
 *
 * `resources`, `resource`, `namespace`, `scope`, `member`, `collection` and the
 * verb methods behave as they do in Rails, down to the route names — including
 * the uncountable case where `resources("series")` names its index route
 * `series_index` because the singular and plural forms collide.
 *
 * What Rails cannot do, and this does: every named route also produces a path
 * helper, so `paths.editPost(post)` is a checked call rather than a string
 * assembled at render time.
 */

import { camelize, pluralize, singularize } from "@altair/support/inflector";
import { type HttpMethod, Route, type RouteOptions } from "./route.js";

export type { HttpMethod } from "./route.js";
export { Route } from "./route.js";

/** Rails: `Resource.default_actions`. `api` drops the two form-rendering actions. */
const DEFAULT_RESOURCE_ACTIONS = ["index", "create", "new", "show", "update", "destroy", "edit"];
const DEFAULT_SINGLETON_ACTIONS = ["show", "create", "update", "destroy", "new", "edit"];

export type ResourceAction = "index" | "create" | "new" | "edit" | "show" | "update" | "destroy";

/**
 * The actions a `resources` or `resource` declaration draws. Rails'
 * `default_actions`.
 *
 * A singular resource has no `index`: there is one of it, so a collection
 * route would answer a list of one thing at a path that promises many.
 *
 * An API-only application drops `new` and `edit`, because those exist to
 * render a form and an API renders nothing. Drawn anyway they are two routes
 * per resource that answer with a missing-template error, which reads as a
 * broken application rather than a route that should not be there.
 */
export function defaultActions({
  apiOnly = false,
  singleton = false,
}: { apiOnly?: boolean; singleton?: boolean } = {}): ResourceAction[] {
  const all = (
    singleton ? DEFAULT_SINGLETON_ACTIONS : DEFAULT_RESOURCE_ACTIONS
  ) as ResourceAction[];

  return apiOnly ? all.filter((action) => action !== "new" && action !== "edit") : all;
}

export class UnknownResourceAction extends Error {
  constructor(given: readonly string[]) {
    super(
      `${given.join(", ")} ${given.length === 1 ? "is not an action" : "are not actions"} a ` +
        `resource draws. One of: ${DEFAULT_RESOURCE_ACTIONS.join(", ")}. \`only\` is a ` +
        `whitelist, so an unrecognised name there draws nothing at all rather than adding ` +
        `something — the routes it was meant to keep are simply missing.`,
    );
    this.name = "UnknownResourceAction";
  }
}

/** Refuses a name that is not an action, in either list. */
export function checkResourceActions(only: readonly string[], except: readonly string[]): void {
  const unknown = [...only, ...except].filter(
    (action) => !DEFAULT_RESOURCE_ACTIONS.includes(action),
  );

  if (unknown.length > 0) throw new UnknownResourceAction(unknown);
}

/** Anything that can answer a request under a mount point. */
export type MountedApp = (request: Request) => Response | Promise<Response>;

/** One mounted application and where it lives. */
export interface Mounted {
  at: string;
  handler: MountedApp;
  name?: string;
}

export interface ResourceOptions {
  only?: ResourceAction | ResourceAction[];
  except?: ResourceAction | ResourceAction[];
  /** The dynamic segment used for members. Rails' `param:`, defaulting to `id`. */
  param?: string;
  /** Override the URL segment without changing the route names. */
  path?: string;
  /** Override the controller name. */
  controller?: string;
  /** Override the name used in route names and helpers. */
  as?: string;
  /**
   * Draws no `new` or `edit`. Rails' `config.api_only`.
   *
   * Those two exist to render a form, and an API renders nothing — drawn
   * anyway they are two routes per resource that answer with a
   * missing-template error, which reads as a broken application rather than a
   * route that should not be there.
   */
  apiOnly?: boolean;
}

export interface ScopeOptions {
  path?: string;
  /** Prefix added to controller names, as Rails' `module:` does. */
  module?: string;
  /** Prefix added to route names. */
  as?: string;
  constraints?: Record<string, RegExp>;
}

/**
 * Rails' `to: "posts#show"`. Typed as a template literal so a missing `#` is a
 * compile error rather than a route that silently never matches.
 */
export type ControllerAction = `${string}#${string}`;

export interface MatchOptions extends RouteOptions {
  to?: ControllerAction;
  as?: string;
  via?: HttpMethod | HttpMethod[];
  controller?: string;
  action?: string;
}

interface ResourceScope {
  singleton: boolean;
  /** Rails' `member_name` — the singular form used in route names. */
  memberName: string;
  /** Rails' `collection_name` — plural, or `<plural>_index` when they collide. */
  collectionName: string;
  path: string;
  controller: string;
  param: string;
}

interface Scope {
  path: string[];
  module: string[];
  as: string[];
  constraints: Record<string, RegExp>;
  /** The resource whose block we are inside, if any. */
  resource?: ResourceScope | undefined;
  /** True directly inside a `resources` block, where nesting applies. */
  inResourceBlock?: boolean;
  /**
   * Set by `member`/`collection`. Rails names those routes
   * `<action>_<member-or-collection-name>`, with the action in front.
   */
  actionSuffix?: string | undefined;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function joinName(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.length > 0)).join("_");
}

function trimPath(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

/** Rails names routes in snake_case; the helper is the camelCase of that name. */
export function helperName(routeName: string): string {
  return `${camelize(routeName, false)}Path`;
}

export class Mapper {
  readonly #routes: Route[];
  #scope: Scope;

  #concerns = new Map<string, (r: Mapper) => void>();
  #mounted: Mounted[] = [];

  constructor(routes: Route[], scope?: Scope) {
    this.#routes = routes;
    this.#scope = scope ?? { path: [], module: [], as: [], constraints: {} };
  }

  #withScope<T>(changes: Partial<Scope>, body: () => T): T {
    const previous = this.#scope;
    this.#scope = {
      path: [...previous.path, ...(changes.path ?? [])],
      module: [...previous.module, ...(changes.module ?? [])],
      as: [...previous.as, ...(changes.as ?? [])],
      constraints: { ...previous.constraints, ...changes.constraints },
      resource: "resource" in changes ? changes.resource : previous.resource,
      inResourceBlock:
        "inResourceBlock" in changes ? changes.inResourceBlock : previous.inResourceBlock,
      actionSuffix: "actionSuffix" in changes ? changes.actionSuffix : previous.actionSuffix,
    };
    try {
      return body();
    } finally {
      this.#scope = previous;
    }
  }

  #currentPath(...extra: string[]): string {
    const parts = [...this.#scope.path, ...extra].filter((part) => part.length > 0);
    return `/${parts.join("/")}`;
  }

  #currentController(name: string): string {
    return [...this.#scope.module, name].filter((part) => part.length > 0).join("/");
  }

  /**
   * Registers a route. `to` is Rails' `"controller#action"`.
   *
   * Inside a `member` or `collection` block the controller is inherited from
   * the surrounding resource and the action defaults to the path, so
   * `r.get("preview")` is enough.
   */
  match(pattern: string, options: MatchOptions = {}): this {
    const scope = this.#scope;
    // `"".split("#")` yields [""] rather than undefined, so an absent `to:` has
    // to be handled before the ?? chain or it silently wins.
    const [controllerFromTo, actionFromTo] = options.to ? options.to.split("#") : [];

    const controller = options.controller ?? controllerFromTo ?? scope.resource?.controller ?? "";
    const action = options.action ?? actionFromTo ?? trimPath(pattern).at(-1) ?? "";

    if (controller === "" || action === "") {
      throw new Error(`Route ${pattern} needs a controller and action, e.g. to: "posts#show"`);
    }

    const name =
      scope.actionSuffix !== undefined
        ? joinName([options.as ?? action, ...scope.as, scope.actionSuffix])
        : options.as
          ? joinName([...scope.as, options.as])
          : undefined;

    const methods = toArray(options.via ?? "GET");

    for (const [index, method] of methods.entries()) {
      this.#routes.push(
        new Route(
          method,
          this.#currentPath(...trimPath(pattern)),
          this.#currentController(controller),
          action,
          {
            // Rails names a multi-verb route once. PUT riding alongside PATCH
            // must not claim the name a second time.
            name: index === 0 ? name : undefined,
            constraints: { ...scope.constraints, ...options.constraints },
            defaults: options.defaults,
            format: options.format,
          },
        ),
      );
    }
    return this;
  }

  get(pattern: string, options: MatchOptions = {}): this {
    return this.match(pattern, { ...options, via: "GET" });
  }
  post(pattern: string, options: MatchOptions = {}): this {
    return this.match(pattern, { ...options, via: "POST" });
  }
  patch(pattern: string, options: MatchOptions = {}): this {
    return this.match(pattern, { ...options, via: "PATCH" });
  }
  put(pattern: string, options: MatchOptions = {}): this {
    return this.match(pattern, { ...options, via: "PUT" });
  }
  delete(pattern: string, options: MatchOptions = {}): this {
    return this.match(pattern, { ...options, via: "DELETE" });
  }

  /** The root route. Rails names it `root`. */
  root(to: ControllerAction): this {
    const [controller, action] = to.split("#");
    if (!controller || !action) throw new Error(`root() needs "controller#action", got "${to}"`);

    this.#routes.push(
      new Route("GET", this.#currentPath(), this.#currentController(controller), action, {
        name: joinName([...this.#scope.as, "root"]),
        format: false,
      }),
    );
    return this;
  }

  /** Rails' `scope`: adjust path, module and name prefixes without adding routes. */
  scope(options: ScopeOptions, body: (r: Mapper) => void): this {
    this.#withScope(
      {
        path: options.path ? trimPath(options.path) : [],
        module: options.module ? [options.module] : [],
        as: options.as ? [options.as] : [],
        constraints: options.constraints,
      },
      () => body(this),
    );
    return this;
  }

  /**
   * Names a block of routes so it can be drawn in several places. Rails'
   * `concern`.
   *
   *     router.concern("commentable", (r) => r.resources("comments"))
   *     router.resources("posts", (r) => r.concerns("commentable"))
   *     router.resources("photos", (r) => r.concerns("commentable"))
   *
   * The alternative is a helper function that takes the mapper, which works and
   * is what people write without this — but a named concern is discoverable
   * from the routes file, and `concerns("commentable")` reads as a declaration
   * rather than a call.
   */
  concern(name: string, body: (r: Mapper) => void): this {
    this.#concerns.set(name, body);
    return this;
  }

  /**
   * Draws named concerns here. Rails' `concerns`.
   *
   * An unknown name throws rather than being ignored, because a silently
   * skipped concern is a set of routes that simply are not there — and the
   * symptom is a 404 far from the typo.
   */
  concerns(...names: string[]): this {
    for (const name of names) {
      const body = this.#concerns.get(name);

      if (!body) {
        throw new Error(
          `No routing concern named "${name}". Declared: ${[...this.#concerns.keys()].join(", ") || "none"}`,
        );
      }

      body(this);
    }

    return this;
  }

  /**
   * Mounts another application under a path. Rails' `mount`.
   *
   * The mounted handler is given the request with the mount path still on it,
   * because a sub-application generally needs to know where it lives to build
   * its own URLs — Rails passes SCRIPT_NAME for the same reason.
   */
  mount(handler: MountedApp, options: { at: string; as?: string }): this {
    const at = `/${trimPath(options.at).join("/")}`;

    this.#mounted.push({ at, handler, name: options.as });
    return this;
  }

  /** Everything mounted, in declaration order. */
  get mountedApps(): readonly Mounted[] {
    return this.#mounted;
  }

  /** Rails' `namespace`: path, module and name prefix in one call. */
  namespace(name: string, body: (r: Mapper) => void): this {
    return this.scope({ path: name, module: name, as: name }, body);
  }

  /**
   * Rails' `resources`: the seven RESTful routes.
   *
   *     router.resources("posts", (r) => r.resources("comments"))
   */
  resources(
    name: string,
    optionsOrBody?: ResourceOptions | ((r: Mapper) => void),
    maybeBody?: (r: Mapper) => void,
  ): this {
    return this.#resource(name, optionsOrBody, maybeBody, false);
  }

  /**
   * Rails' `resource`: a singular resource, with no index and no `:id`.
   *
   *     router.resource("session")
   */
  resource(
    name: string,
    optionsOrBody?: ResourceOptions | ((r: Mapper) => void),
    maybeBody?: (r: Mapper) => void,
  ): this {
    return this.#resource(name, optionsOrBody, maybeBody, true);
  }

  #resource(
    name: string,
    optionsOrBody: ResourceOptions | ((r: Mapper) => void) | undefined,
    maybeBody: ((r: Mapper) => void) | undefined,
    singleton: boolean,
  ): this {
    const options = typeof optionsOrBody === "function" ? {} : (optionsOrBody ?? {});
    const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody;

    // A resource declared inside another resource's block nests under that
    // parent's member scope, which is how `/posts/:post_id/comments` arises.
    const parent = this.#scope.inResourceBlock ? this.#scope.resource : undefined;
    if (parent) {
      const nestedPath = parent.singleton
        ? parent.path
        : `${parent.path}/:${joinName([parent.memberName, parent.param])}`;

      this.#withScope(
        {
          path: trimPath(nestedPath),
          as: [parent.memberName],
          resource: undefined,
          inResourceBlock: false,
        },
        () => this.#drawResource(name, options, body, singleton),
      );
      return this;
    }

    this.#drawResource(name, options, body, singleton);
    return this;
  }

  #drawResource(
    entity: string,
    options: ResourceOptions,
    body: ((r: Mapper) => void) | undefined,
    singleton: boolean,
  ): void {
    const displayName = options.as ?? entity;

    // Rails: a plural resource is served by the controller of the same name; a
    // singular one by the pluralized name, so `resource :session` is handled by
    // SessionsController.
    const plural = singleton ? pluralize(displayName) : displayName;
    const singular = singleton ? displayName : singularize(displayName);

    const resource: ResourceScope = {
      singleton,
      memberName: singular,
      // Rails appends _index when the forms collide, so `resources :series`
      // names its index route series_index.
      collectionName: singleton ? singular : singular === plural ? `${plural}_index` : plural,
      path: options.path ?? entity,
      controller: options.controller ?? (singleton ? pluralize(entity) : entity),
      param: options.param ?? "id",
    };

    const only = toArray(options.only);
    const except = toArray(options.except);

    checkResourceActions(only, except);

    const defaults = defaultActions({ singleton, apiOnly: options.apiOnly ?? false });
    const available = only.length > 0 ? only : defaults;
    const actions = new Set(
      available.filter((action) => !except.includes(action as ResourceAction)),
    );

    const controller = resource.controller;
    const memberPath = singleton ? resource.path : `${resource.path}/:${resource.param}`;

    // Rails yields the resource block before drawing the default routes, and the
    // ordering is load-bearing: routes match in declaration order, so a
    // collection route like /posts/search has to be registered before /posts/:id
    // or `show` swallows it with id="search".
    if (body) {
      this.#withScope({ resource, inResourceBlock: true, actionSuffix: undefined }, () =>
        body(this),
      );
    }

    this.#withScope({ resource, inResourceBlock: false, actionSuffix: undefined }, () => {
      if (actions.has("index")) {
        this.match(resource.path, {
          via: "GET",
          to: `${controller}#index`,
          as: resource.collectionName,
        });
      }
      if (actions.has("create")) {
        this.match(resource.path, {
          via: "POST",
          to: `${controller}#create`,
          as: singleton ? resource.memberName : resource.collectionName,
        });
      }
      // `new` and `edit` put their prefix in front of any scope prefix, so a
      // namespaced resource yields edit_admin_post rather than admin_edit_post.
      // That is the same shape member/collection routes need, so it reuses the
      // actionSuffix machinery.
      if (actions.has("new")) {
        this.#withScope({ actionSuffix: resource.memberName }, () =>
          this.match(`${resource.path}/new`, {
            via: "GET",
            to: `${controller}#new`,
            as: "new",
            action: "new",
          }),
        );
      }
      if (actions.has("edit")) {
        this.#withScope({ actionSuffix: resource.memberName }, () =>
          this.match(`${memberPath}/edit`, {
            via: "GET",
            to: `${controller}#edit`,
            as: "edit",
            action: "edit",
          }),
        );
      }
      if (actions.has("show")) {
        this.match(memberPath, { via: "GET", to: `${controller}#show`, as: resource.memberName });
      }
      if (actions.has("update")) {
        this.match(memberPath, {
          via: ["PATCH", "PUT"],
          to: `${controller}#update`,
          as: resource.memberName,
        });
      }
      if (actions.has("destroy")) {
        this.match(memberPath, {
          via: "DELETE",
          to: `${controller}#destroy`,
          as: resource.memberName,
        });
      }
    });
  }

  /** Routes declared here act on one member: `/posts/:id/preview`. */
  member(body: (r: Mapper) => void): this {
    const resource = this.#requireResource("member");
    const path = resource.singleton ? resource.path : `${resource.path}/:${resource.param}`;

    this.#withScope(
      { path: trimPath(path), actionSuffix: resource.memberName, inResourceBlock: false },
      () => body(this),
    );
    return this;
  }

  /** Routes declared here act on the collection: `/posts/search`. */
  collection(body: (r: Mapper) => void): this {
    const resource = this.#requireResource("collection");

    this.#withScope(
      {
        path: trimPath(resource.path),
        actionSuffix: resource.collectionName,
        inResourceBlock: false,
      },
      () => body(this),
    );
    return this;
  }

  #requireResource(kind: string): ResourceScope {
    const resource = this.#scope.resource;
    if (!resource) throw new Error(`Cannot use ${kind}() outside of a resource block`);
    return resource;
  }
}

export interface RecognizedRoute {
  controller: string;
  action: string;
  params: Record<string, string>;
  route: Route;
}

/** A generated path helper: positional segment values, or a single params object. */
export type PathHelper = (...args: unknown[]) => string;

export class Router {
  readonly routes: Route[] = [];
  /** Routes bucketed by verb, so recognition never scans another verb's routes. */
  readonly #byMethod = new Map<HttpMethod, Route[]>();
  readonly #byName = new Map<string, Route>();
  readonly #mounted: Mounted[] = [];

  /**
   * Declares routes.
   *
   *     const router = new Router()
   *     router.draw((r) => r.resources("posts"))
   */
  draw(body: (r: Mapper) => void): this {
    const mapper = new Mapper(this.routes);
    body(mapper);

    // Mounted applications are collected on the mapper and kept here, because
    // dispatch asks the router, not the block that drew it.
    this.#mounted.push(...mapper.mountedApps);
    this.#index();

    return this;
  }

  /** Everything mounted, in declaration order. Rails' `mounted_helpers`. */
  get mountedApps(): readonly Mounted[] {
    return this.#mounted;
  }

  /**
   * The mounted application a path falls under, if any.
   *
   * Longest prefix first, so a more specific mount wins over a more general one
   * whatever order they were declared in — otherwise mounting /api before
   * /api/v2 would swallow every v2 request.
   */
  mountedFor(path: string): Mounted | undefined {
    return [...this.#mounted]
      .sort((a, b) => b.at.length - a.at.length)
      .find((one) => path === one.at || path.startsWith(`${one.at}/`));
  }

  #index(): void {
    this.#byMethod.clear();
    this.#byName.clear();
    for (const route of this.routes) {
      let bucket = this.#byMethod.get(route.method);
      if (!bucket) {
        bucket = [];
        this.#byMethod.set(route.method, bucket);
      }
      bucket.push(route);
      // Rails keeps the first route to claim a name.
      if (route.name && !this.#byName.has(route.name)) this.#byName.set(route.name, route);
    }
  }

  /**
   * Finds the route for a request, or null.
   *
   * Matching is in declaration order — first match wins, as in Rails.
   *
   * ponytail: linear scan within a verb bucket. Correct, and fine for hundreds
   * of routes; swap in a segment trie if a route table ever shows up in a
   * profile.
   */
  recognize(method: string, path: string): RecognizedRoute | null {
    const verb = method.toUpperCase() as HttpMethod;
    // Rails answers HEAD with the GET route when no HEAD route is declared.
    const buckets =
      verb === "HEAD"
        ? [this.#byMethod.get("HEAD"), this.#byMethod.get("GET")]
        : [this.#byMethod.get(verb)];

    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const route of bucket) {
        const params = route.match(path);
        if (params) {
          return { controller: route.controller, action: route.action, params, route };
        }
      }
    }
    return null;
  }

  /** The route registered under a Rails-style name, such as `edit_post`. */
  routeNamed(name: string): Route | undefined {
    return this.#byName.get(name);
  }

  /** Every route name that has a helper, in declaration order. */
  get routeNames(): string[] {
    return [...this.#byName.keys()];
  }

  /**
   * Builds the path helper table: `postPath`, `editPostPath`, `newPostPath`.
   *
   * Helpers accept positional segment values, model-like objects carrying an
   * `id` or `toParam()`, or a single object naming the segments. Leftover keys
   * become query parameters, as in Rails.
   */
  pathHelpers(): Record<string, PathHelper> {
    const helpers: Record<string, PathHelper> = {};
    for (const [name, route] of this.#byName) {
      helpers[helperName(name)] = (...args: unknown[]) => this.#buildPath(route, args);
    }
    return helpers;
  }

  #buildPath(route: Route, args: unknown[]): string {
    const required = route.requiredParams.filter((param) => param !== "format");
    const values: Record<string, unknown> = {};
    let query: Record<string, unknown> = {};

    const last = args.at(-1);
    const lastIsOptions = isPlainObject(last);

    if (lastIsOptions && args.length === 1 && required.length > 0) {
      // Single object form: segments come out of it, anything left is query.
      const rest: Record<string, unknown> = { ...(last as Record<string, unknown>) };
      for (const key of required) {
        if (key in rest) {
          values[key] = toParam(rest[key]);
          delete rest[key];
        }
      }
      query = rest;
    } else {
      const positional = lastIsOptions ? args.slice(0, -1) : args;
      if (lastIsOptions) query = last as Record<string, unknown>;
      required.forEach((key, index) => {
        if (index < positional.length) values[key] = toParam(positional[index]);
      });
    }

    const path = route.format(values);
    const search = buildQuery(query);
    return search ? `${path}?${search}` : path;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Rails' `to_param`: a model becomes its id unless it says otherwise. */
function toParam(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") {
    const record = value as { toParam?: () => unknown; id?: unknown };
    if (typeof record.toParam === "function") return record.toParam();
    if ("id" in record) return record.id;
  }
  return value;
}

function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(`${key}[]`, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}
