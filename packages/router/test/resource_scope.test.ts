/**
 * How nested `resources` blocks build a route, ported from
 * `actionpack/test/dispatch/routing/route_set_test.rb`,
 * `actionpack/test/controller/resources_test.rb` and the polymorphic cases in
 * `actionpack/test/controller/routing_test.rb`.
 *
 * The cases worth having are the asymmetries — what concatenates, what merges,
 * what overrides — because getting any of them backwards produces routes that
 * exist and never match.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DuplicateRouteName,
  NoRoutes,
  type RouteSpec,
  addPolymorphicMapping,
  addRoute,
  fromRequirements,
  makeRoute,
  matchesFilter,
  memberScope,
  nestedScope,
  newScope,
  noRoutes,
  partitionRoute,
  polymorphicMethod,
  polymorphicUrl,
  postMatch,
  requiredDefault,
  requiredParts,
  requiresMatchingVerb,
  resetPolymorphicMappings,
  resourceMethodScope,
  resourcesPathNames,
  routeFor,
  routeUriPattern,
  scopeName,
  scopePath,
  shallow,
  withDefaultScope,
} from "../src/resource_scope.js";

afterEach(() => {
  resetPolymorphicMappings();
});

describe("combining scopes", () => {
  const outer = newScope({
    path: ["admin"],
    as: ["admin"],
    module: ["admin"],
    constraints: { id: /\d+/ },
    defaults: { format: "html" },
  });

  it("concatenates paths, names and modules", () => {
    const inner = withDefaultScope(outer, { path: ["posts"], as: ["posts"], module: ["blog"] });

    expect(scopePath(inner)).toBe("/admin/posts");
    expect(scopeName(inner)).toBe("admin_posts");
    expect(inner.module).toEqual(["admin", "blog"]);
  });

  /**
   * A nested constraint narrows rather than replaces — replacing would
   * silently widen a route an outer block deliberately restricted.
   */
  it("merges constraints", () => {
    const inner = withDefaultScope(outer, { constraints: { slug: /[a-z]+/ } });

    expect(Object.keys(inner.constraints)).toEqual(["id", "slug"]);
  });

  /**
   * Two values for one parameter is a contradiction rather than a narrowing,
   * and keeping both would make the route match neither.
   */
  it("overrides defaults", () => {
    expect(withDefaultScope(outer, { defaults: { format: "json" } }).defaults).toEqual({
      format: "json",
    });
  });

  it("gives an empty scope the root path", () => {
    expect(scopePath(newScope())).toBe("/");
  });

  it("inherits shallow from the parent unless the child says otherwise", () => {
    const shallowParent = newScope({ shallow: true });

    expect(withDefaultScope(shallowParent, {}).shallow).toBe(true);
    expect(withDefaultScope(shallowParent, { shallow: false }).shallow).toBe(false);
  });
});

describe("the scopes a resource declares in", () => {
  const root = newScope();

  it("puts the seven actions under the collection path", () => {
    expect(scopePath(resourceMethodScope(root, "posts"))).toBe("/posts");
  });

  it("adds an id for a member action", () => {
    expect(scopePath(memberScope(root, "posts"))).toBe("/posts/:id");
  });

  it("takes a differently named parameter", () => {
    expect(scopePath(memberScope(root, "posts", "slug"))).toBe("/posts/:slug");
  });

  /**
   * The child's own route already uses `:id`, so using it here too makes the
   * two collide — the child controller reads `params[:id]` and gets the
   * parent's.
   */
  it("names the parent explicitly for a nested scope", () => {
    expect(scopePath(nestedScope(root, "posts", "post"))).toBe("/posts/:post_id");
  });
});

describe("shallow nesting", () => {
  const nested = newScope({ path: ["posts", ":post_id", "comments"], as: ["post", "comments"] });

  it("changes nothing when shallow is off", () => {
    expect(shallow(nested, "member")).toBe(nested);
  });

  /**
   * `index` and `create` genuinely need to know which parent, so they keep it.
   */
  it("keeps the parent for a collection action", () => {
    const shallowNested = { ...nested, shallow: true };

    expect(shallow(shallowNested, "collection")).toBe(shallowNested);
  });

  /**
   * A member action already has an id that identifies the record uniquely, so
   * `/posts/1/comments/2` names the post as context nobody needs and a
   * parameter nothing reads.
   */
  it("drops the parent for a member action", () => {
    const dropped = shallow({ ...nested, shallow: true }, "member");

    expect(scopePath(dropped)).toBe("/comments");
    expect(scopeName(dropped)).toBe("comments");
  });
});

describe("the words new and edit appear as", () => {
  it("defaults to the English ones", () => {
    expect(resourcesPathNames()).toEqual({ new: "new", edit: "edit" });
  });

  /** Configurable because they are user-visible; the action names do not change. */
  it("takes overrides", () => {
    expect(resourcesPathNames({ new: "nuevo" })).toEqual({ new: "nuevo", edit: "edit" });
  });
});

describe("building a route", () => {
  const scope = newScope({ path: ["admin", "posts"], as: ["admin", "posts"], module: ["admin"] });

  it("joins the scope's path with the action's segment", () => {
    const route = makeRoute(scope, {
      verb: "get",
      action: "edit",
      controller: "posts",
      segment: "edit",
      name: "edit",
    });

    expect(route.path).toBe("/admin/posts/edit");
    expect(route.verb).toBe("GET");
    expect(route.controller).toBe("admin/posts");
    expect(route.name).toBe("admin_posts_edit");
  });

  it("leaves a nameless route nameless", () => {
    expect(
      makeRoute(scope, { verb: "get", action: "index", controller: "posts" }).name,
    ).toBeUndefined();
  });

  /**
   * The root scope's path is already "/", so joining a segment onto it would
   * produce "//new" — a path that matches nothing and looks like a typo in the
   * routes file rather than in the framework.
   */
  it("does not double a slash", () => {
    expect(makeRoute(newScope(), { verb: "get", action: "index", controller: "posts" }).path).toBe(
      "/",
    );
    expect(
      makeRoute(newScope(), { verb: "get", action: "new", controller: "posts", segment: "new" })
        .path,
    ).toBe("/new");
  });

  /**
   * A second route with one name shadows the first for every helper, so one of
   * two routes becomes unreachable through its own name — and nothing reports
   * it until somebody notices a link going to the wrong place.
   */
  it("refuses a duplicate name", () => {
    const routes: RouteSpec[] = [];
    const route = (name: string): RouteSpec => ({
      name,
      verb: "GET",
      path: `/${name}`,
      controller: "posts",
      action: "index",
      constraints: {},
      defaults: {},
    });

    addRoute(routes, route("posts"));

    expect(() => addRoute(routes, route("posts"))).toThrow(DuplicateRouteName);
  });

  it("allows two nameless routes", () => {
    const routes: RouteSpec[] = [];
    const route: RouteSpec = {
      verb: "GET",
      path: "/a",
      controller: "posts",
      action: "index",
      constraints: {},
      defaults: {},
    };

    addRoute(routes, route);

    expect(() => addRoute(routes, { ...route })).not.toThrow();
  });
});

describe("what a route needs to be generated", () => {
  /**
   * A helper called without one of these has to raise: the gap produces a URL
   * routing somewhere else, and the router then reports a missing route for a
   * path the application generated itself.
   */
  it("names the dynamic segments", () => {
    expect(requiredParts("/posts/:id/comments/:comment_id")).toEqual(["id", "comment_id"]);
  });

  it("does not count an optional segment", () => {
    expect(requiredParts("/posts/:id(.:format)")).toEqual(["id"]);
  });

  it("counts a glob", () => {
    expect(requiredParts("/files/*path")).toEqual(["path"]);
  });

  /**
   * A default for something the path does not mention is a requirement:
   * `defaults: { format: "json" }` on a route with no `:format` means the
   * route only matches a request already asking for JSON.
   */
  it("tells a fallback default from a required one", () => {
    expect(requiredDefault("/posts/:id(.:format)", { format: "json", locale: "en" })).toEqual({
      locale: "en",
    });
  });

  it("finds none when every default names a segment", () => {
    expect(requiredDefault("/posts/:id", { id: 1 })).toEqual({});
  });
});

describe("verbs and constraints", () => {
  /**
   * A route declared with no verb answers every one, and a GET to a destroy
   * action is exactly the shape of a link a crawler follows.
   */
  it("says whether a route pins a verb", () => {
    expect(requiresMatchingVerb({ verb: "GET" })).toBe(true);
    expect(requiresMatchingVerb({ verb: "ANY" })).toBe(false);
    expect(requiresMatchingVerb({})).toBe(false);
    expect(requiresMatchingVerb({ verb: "" })).toBe(false);
  });

  it("takes a constraint's source", () => {
    expect(fromRequirements(/\d+/)).toBe("\\d+");
    expect(fromRequirements("[a-z]+")).toBe("[a-z]+");
  });

  /**
   * A segment constraint already applies to exactly one segment, so an anchor
   * either does nothing or makes the route match nothing — and a route that
   * cannot match reports itself as missing.
   */
  it("refuses an anchored constraint", () => {
    expect(() => fromRequirements(/^\d+$/)).toThrow("anchored");
    expect(() => fromRequirements("\\A\\d+\\z")).toThrow("reports itself as missing");
  });

  it("inlines a constraint into the pattern", () => {
    expect(routeUriPattern("/posts/:id", { id: /\d+/ })).toBe("/posts/:id<\\d+>");
    expect(routeUriPattern("/posts/:id")).toBe("/posts/:id");
  });

  /**
   * Anchored at match time rather than at declaration: an unanchored test
   * would accept a segment that merely contains a match — `/posts/12abc`
   * passing a numeric id constraint.
   */
  it("checks a constraint against the whole segment", () => {
    const route: RouteSpec = {
      verb: "GET",
      path: "/posts/:id",
      controller: "posts",
      action: "show",
      constraints: { id: /\d+/ },
      defaults: {},
    };

    expect(postMatch(route, { id: "12" })).toBe(true);
    expect(postMatch(route, { id: "12abc" })).toBe(false);
  });

  it("ignores a constraint for a parameter that is not there", () => {
    const route: RouteSpec = {
      verb: "GET",
      path: "/posts",
      controller: "posts",
      action: "index",
      constraints: { id: /\d+/ },
      defaults: {},
    };

    expect(postMatch(route, {})).toBe(true);
  });
});

describe("finding a route", () => {
  const routes: RouteSpec[] = [
    {
      name: "posts",
      verb: "GET",
      path: "/posts",
      controller: "posts",
      action: "index",
      constraints: {},
      defaults: {},
    },
    {
      name: "post",
      verb: "GET",
      path: "/posts/:id",
      controller: "posts",
      action: "show",
      constraints: {},
      defaults: {},
    },
  ];

  /**
   * A dynamic route declared first would swallow a static path declared later
   * — `/posts/:id` matching `/posts/new` — which is the most common routing
   * surprise there is.
   */
  it("checks static paths before dynamic ones", () => {
    const { static: fixed, dynamic } = partitionRoute(routes);

    expect(fixed.map((route) => route.path)).toEqual(["/posts"]);
    expect(dynamic.map((route) => route.path)).toEqual(["/posts/:id"]);
  });

  it("finds a route by name", () => {
    expect(routeFor(routes, "post")?.path).toBe("/posts/:id");
    expect(routeFor(routes, "absent")).toBeUndefined();
  });

  /**
   * Somebody grepping routes has one of the three in hand and rarely knows
   * which of them the framework calls it.
   */
  it("filters on path, name or controller#action", () => {
    expect(matchesFilter(routes[0]!, "/posts")).toBe(true);
    expect(matchesFilter(routes[0]!, "posts#index")).toBe(true);
    expect(matchesFilter(routes[0]!, "POSTS")).toBe(true);
    expect(matchesFilter(routes[0]!, "comments")).toBe(false);
  });

  it("raises with what was asked for", () => {
    expect(() => noRoutes("GET /nowhere")).toThrow(NoRoutes);
    expect(() => noRoutes("GET /nowhere")).toThrow("GET /nowhere");
  });
});

describe("polymorphic routes", () => {
  it("derives a helper from the class name", () => {
    expect(polymorphicMethod({ constructorName: "Post" })).toBe("post_path");
    expect(polymorphicMethod({ constructorName: "BlogPost" })).toBe("blog_post_path");
  });

  /**
   * A model's class name and its route name diverge often enough to matter —
   * a namespaced model, a model whose route lives under another resource.
   */
  it("prefers a registered mapping over the derived name", () => {
    expect(polymorphicMethod({ constructorName: "Article" })).toBe("article_path");

    addPolymorphicMapping("Article", "blog_post");

    expect(polymorphicMethod({ constructorName: "Article" })).toBe("blog_post_path");
  });

  /**
   * A subclass with no routes of its own is the normal case rather than an
   * error — `polymorphic_url` is how a shared partial links to whatever it was
   * given.
   */
  it("falls back to the base class for a subclass", () => {
    addPolymorphicMapping("Post", "post");

    expect(polymorphicMethod({ constructorName: "SpecialPost", baseName: "Post" })).toBe(
      "post_path",
    );
  });

  /**
   * A new record links to the collection — that is where a form posts. The
   * member route would build a path with no id in it.
   */
  it("links a new record to the collection", () => {
    expect(polymorphicMethod({ constructorName: "Post", persisted: false })).toBe("posts_path");
  });

  it("takes the url suffix", () => {
    expect(polymorphicMethod({ constructorName: "Post" }, "url")).toBe("post_url");
  });

  it("passes the id for a persisted record and nothing for a new one", () => {
    expect(polymorphicUrl({ constructorName: "Post", persisted: true, id: 7 })).toEqual({
      helper: "post_path",
      args: [7],
    });
    // The new record is given an id on purpose: a form's model often carries
    // one from a failed create, and passing it would build a member path for a
    // record the database has never seen.
    expect(polymorphicUrl({ constructorName: "Post", persisted: false, id: 7 })).toEqual({
      helper: "posts_path",
      args: [],
    });
  });
});
