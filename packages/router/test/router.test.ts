/**
 * Routing parity suite.
 *
 * Mirrors actionpack/test/controller/resources_test.rb and
 * actionpack/test/dispatch/routing_test.rb. Rails' routing tests assert on
 * recognition and on generated helpers, so these do the same, and each case
 * names the Rails test it corresponds to.
 */

import { describe, expect, it } from "bun:test";
import { Router } from "../src/router.js";

function draw(body: Parameters<Router["draw"]>[0]): Router {
  return new Router().draw(body);
}

/** Compact view of a route table: "VERB /path -> controller#action (name)". */
function table(router: Router): string[] {
  return router.routes.map(
    (r) => `${r.method} ${r.pattern} -> ${r.controller}#${r.action}${r.name ? ` (${r.name})` : ""}`,
  );
}

describe("resources", () => {
  // Rails: test_default_restful_routes
  it("draws the seven RESTful routes", () => {
    const router = draw((r) => r.resources("posts"));

    expect(table(router)).toEqual([
      "GET /posts -> posts#index (posts)",
      "POST /posts -> posts#create (posts)",
      "GET /posts/new -> posts#new (new_post)",
      "GET /posts/:id/edit -> posts#edit (edit_post)",
      "GET /posts/:id -> posts#show (post)",
      "PATCH /posts/:id -> posts#update (post)",
      "PUT /posts/:id -> posts#update",
      "DELETE /posts/:id -> posts#destroy (post)",
    ]);
  });

  // Rails: test_default_restful_routes — recognition
  it("recognizes each RESTful route", () => {
    const router = draw((r) => r.resources("posts"));

    expect(router.recognize("GET", "/posts")).toMatchObject({ action: "index" });
    expect(router.recognize("POST", "/posts")).toMatchObject({ action: "create" });
    expect(router.recognize("GET", "/posts/new")).toMatchObject({ action: "new" });
    expect(router.recognize("GET", "/posts/1")).toMatchObject({
      action: "show",
      params: { id: "1" },
    });
    expect(router.recognize("GET", "/posts/1/edit")).toMatchObject({
      action: "edit",
      params: { id: "1" },
    });
    expect(router.recognize("PATCH", "/posts/1")).toMatchObject({ action: "update" });
    expect(router.recognize("PUT", "/posts/1")).toMatchObject({ action: "update" });
    expect(router.recognize("DELETE", "/posts/1")).toMatchObject({ action: "destroy" });
  });

  // Rails: /posts/new must not be read as /posts/:id with id "new"
  it("prefers the static new route over the member route", () => {
    const router = draw((r) => r.resources("posts"));
    expect(router.recognize("GET", "/posts/new")).toMatchObject({ action: "new" });
  });

  // Rails: test_with_custom_conditions — only:
  it("honours only:", () => {
    const router = draw((r) => r.resources("posts", { only: ["index", "show"] }));

    expect(table(router)).toEqual([
      "GET /posts -> posts#index (posts)",
      "GET /posts/:id -> posts#show (post)",
    ]);
  });

  // Rails: except:
  it("honours except:", () => {
    const router = draw((r) => r.resources("posts", { except: ["destroy", "new", "edit"] }));
    const actions = router.routes.map((r) => r.action);

    expect(actions).not.toContain("destroy");
    expect(actions).not.toContain("new");
    expect(actions).not.toContain("edit");
    expect(actions).toContain("index");
  });

  // Rails: test_irregular_id_with_constraints_should_pass — param:
  it("supports a custom param", () => {
    const router = draw((r) => r.resources("posts", { param: "slug" }));

    expect(router.recognize("GET", "/posts/hello-world")).toMatchObject({
      action: "show",
      params: { slug: "hello-world" },
    });
    expect(router.routeNamed("post")!.pattern).toBe("/posts/:slug");
  });

  // Rails: test_override_paths_for_member_and_collection_methods — path:
  it("supports a custom path without changing route names", () => {
    const router = draw((r) => r.resources("posts", { path: "articles" }));

    expect(router.recognize("GET", "/articles/1")).toMatchObject({
      controller: "posts",
      action: "show",
    });
    expect(router.routeNamed("post")).toBeDefined();
  });

  // Rails: controller:
  it("supports a custom controller", () => {
    const router = draw((r) => r.resources("posts", { controller: "articles" }));
    expect(router.recognize("GET", "/posts")).toMatchObject({ controller: "articles" });
  });

  // Rails: Resource#collection_name — the uncountable case
  it("names the index route <plural>_index when singular and plural collide", () => {
    const router = draw((r) => r.resources("series"));

    expect(router.routeNamed("series_index")).toBeDefined();
    expect(router.routeNamed("series_index")!.action).toBe("index");
    expect(router.routeNamed("series")!.action).toBe("show");
  });
});

describe("singular resource", () => {
  // Rails: test_session_singleton_resource
  it("draws the singular routes with no index and no :id", () => {
    const router = draw((r) => r.resource("session"));

    expect(table(router)).toEqual([
      "POST /session -> sessions#create (session)",
      "GET /session/new -> sessions#new (new_session)",
      "GET /session/edit -> sessions#edit (edit_session)",
      "GET /session -> sessions#show (session)",
      "PATCH /session -> sessions#update (session)",
      "PUT /session -> sessions#update",
      "DELETE /session -> sessions#destroy (session)",
    ]);
  });

  // Rails: a singular resource is served by the pluralized controller
  it("routes to the pluralized controller", () => {
    const router = draw((r) => r.resource("session"));
    expect(router.recognize("GET", "/session")).toMatchObject({
      controller: "sessions",
      action: "show",
    });
  });
});

describe("nesting", () => {
  // Rails: test_nested_resource_routes
  it("nests under the parent member scope", () => {
    const router = draw((r) => r.resources("posts", (rr) => rr.resources("comments")));

    expect(router.recognize("GET", "/posts/1/comments")).toMatchObject({
      controller: "comments",
      action: "index",
      params: { post_id: "1" },
    });
    expect(router.recognize("GET", "/posts/1/comments/2")).toMatchObject({
      action: "show",
      params: { post_id: "1", id: "2" },
    });
  });

  // Rails: nested route names are prefixed with the parent's singular name
  it("prefixes nested route names", () => {
    const router = draw((r) => r.resources("posts", (rr) => rr.resources("comments")));

    expect(router.routeNamed("post_comments")).toBeDefined();
    expect(router.routeNamed("post_comment")).toBeDefined();
    expect(router.routeNamed("new_post_comment")).toBeDefined();
    expect(router.routeNamed("edit_post_comment")).toBeDefined();
  });

  // Rails: the parent's own routes are unaffected by the nested block
  it("still draws the parent's routes", () => {
    const router = draw((r) => r.resources("posts", (rr) => rr.resources("comments")));

    expect(router.recognize("GET", "/posts/1")).toMatchObject({
      controller: "posts",
      action: "show",
    });
  });

  // Rails: nesting under a singular resource uses its path with no id segment
  it("nests under a singular resource", () => {
    const router = draw((r) => r.resource("account", (rr) => rr.resources("invoices")));

    expect(router.recognize("GET", "/account/invoices")).toMatchObject({
      controller: "invoices",
      action: "index",
    });
    expect(router.routeNamed("account_invoices")).toBeDefined();
  });
});

describe("member and collection", () => {
  // Rails: test_with_member_action
  it("adds a member route named <action>_<singular>", () => {
    const router = draw((r) => r.resources("posts", (rr) => rr.member((m) => m.get("preview"))));

    expect(router.recognize("GET", "/posts/1/preview")).toMatchObject({
      controller: "posts",
      action: "preview",
      params: { id: "1" },
    });
    expect(router.routeNamed("preview_post")).toBeDefined();
  });

  // Rails: test_with_collection_actions
  it("adds a collection route named <action>_<plural>", () => {
    const router = draw((r) => r.resources("posts", (rr) => rr.collection((c) => c.get("search"))));

    expect(router.recognize("GET", "/posts/search")).toMatchObject({
      controller: "posts",
      action: "search",
    });
    expect(router.routeNamed("search_posts")).toBeDefined();
  });

  // Rails: test_with_two_member_actions_with_same_method
  it("supports several member actions", () => {
    const router = draw((r) =>
      r.resources("posts", (rr) =>
        rr.member((m) => {
          m.post("publish");
          m.post("archive");
        }),
      ),
    );

    expect(router.recognize("POST", "/posts/1/publish")).toMatchObject({ action: "publish" });
    expect(router.recognize("POST", "/posts/1/archive")).toMatchObject({ action: "archive" });
  });

  // Rails: member routes on a singular resource have no id segment
  it("adds member routes to a singular resource", () => {
    const router = draw((r) => r.resource("session", (rr) => rr.member((m) => m.get("refresh"))));

    expect(router.recognize("GET", "/session/refresh")).toMatchObject({
      controller: "sessions",
      action: "refresh",
    });
    expect(router.routeNamed("refresh_session")).toBeDefined();
  });

  it("refuses member() outside a resource block", () => {
    expect(() => draw((r) => r.member(() => {}))).toThrow(
      "Cannot use member() outside of a resource block",
    );
  });
});

describe("scope and namespace", () => {
  // Rails: test_namespace_with_controller_segment
  it("prefixes path, controller and name", () => {
    const router = draw((r) => r.namespace("admin", (rr) => rr.resources("posts")));

    expect(router.recognize("GET", "/admin/posts")).toMatchObject({
      controller: "admin/posts",
      action: "index",
    });
    expect(router.routeNamed("admin_posts")).toBeDefined();
    expect(router.routeNamed("edit_admin_post")).toBeDefined();
  });

  // Rails: test_with_path_prefix — scope with only a path
  it("scopes the path without touching the controller", () => {
    const router = draw((r) => r.scope({ path: "api" }, (rr) => rr.resources("posts")));

    expect(router.recognize("GET", "/api/posts")).toMatchObject({
      controller: "posts",
      action: "index",
    });
  });

  // Rails: test_with_name_prefix
  it("scopes the route name without touching the path", () => {
    const router = draw((r) => r.scope({ as: "v1" }, (rr) => rr.resources("posts")));

    expect(router.routeNamed("v1_posts")).toBeDefined();
    expect(router.recognize("GET", "/posts")).toBeTruthy();
  });

  // Rails: nested namespaces compose
  it("nests namespaces", () => {
    const router = draw((r) =>
      r.namespace("admin", (a) => a.namespace("reports", (b) => b.resources("posts"))),
    );

    expect(router.recognize("GET", "/admin/reports/posts")).toMatchObject({
      controller: "admin/reports/posts",
    });
    expect(router.routeNamed("admin_reports_posts")).toBeDefined();
  });
});

describe("plain routes", () => {
  // Rails: test_match_shorthand
  it("draws a simple get route", () => {
    const router = draw((r) => r.get("about", { to: "pages#about", as: "about" }));

    expect(router.recognize("GET", "/about")).toMatchObject({
      controller: "pages",
      action: "about",
    });
    expect(router.routeNamed("about")).toBeDefined();
  });

  // Rails: root to:
  it("draws the root route", () => {
    const router = draw((r) => r.root("home#index"));

    expect(router.recognize("GET", "/")).toMatchObject({ controller: "home", action: "index" });
    expect(router.routeNamed("root")).toBeDefined();
  });

  // Rails: via: with several verbs
  it("draws one route per verb but names it once", () => {
    const router = draw((r) =>
      r.match("search", { to: "search#run", via: ["GET", "POST"], as: "search" }),
    );

    expect(router.recognize("GET", "/search")).toBeTruthy();
    expect(router.recognize("POST", "/search")).toBeTruthy();
    expect(router.routes.filter((route) => route.name === "search")).toHaveLength(1);
  });

  // Rails: HEAD falls back to the GET route
  it("answers HEAD with the GET route", () => {
    const router = draw((r) => r.get("about", { to: "pages#about" }));
    expect(router.recognize("HEAD", "/about")).toMatchObject({ action: "about" });
  });

  // Rails: an unmatched path recognizes as nothing
  it("returns null when nothing matches", () => {
    const router = draw((r) => r.resources("posts"));
    expect(router.recognize("GET", "/nope")).toBeNull();
    expect(router.recognize("DELETE", "/posts")).toBeNull();
  });

  it("requires a controller and action", () => {
    expect(() => draw((r) => r.get("about"))).toThrow("needs a controller and action");
  });

  // Altair-specific: Rails discovers a malformed `to:` when the route fails to
  // match. The template literal type catches it at the declaration.
  //
  // These are compile-time assertions — the closures are never called, because
  // running them would throw for the very reason the type rejects them.
  it("rejects a malformed to: at compile time", () => {
    const _typeErrors = () => {
      // @ts-expect-error "postsshow" is missing the # separator
      draw((r) => r.get("about", { to: "postsshow" }));

      // @ts-expect-error root() takes the same shape
      draw((r) => r.root("home"));
    };

    expect(typeof _typeErrors).toBe("function");
    expect(draw((r) => r.get("about", { to: "pages#about" })).routes).toHaveLength(1);
  });
});

describe("constraints and formats", () => {
  // Rails: test_irregular_id_with_constraints_should_pass
  it("applies a segment constraint", () => {
    const router = draw((r) =>
      r.resources("posts", { only: ["show"] }).get("posts/:id/stats", {
        to: "posts#stats",
        constraints: { id: /\d+/ },
        as: "post_stats",
      }),
    );

    expect(router.recognize("GET", "/posts/1/stats")).toMatchObject({ action: "stats" });
    expect(router.recognize("GET", "/posts/abc/stats")).toBeNull();
  });

  // Rails: routes accept an optional (.:format) suffix
  it("extracts the format", () => {
    const router = draw((r) => r.resources("posts"));

    expect(router.recognize("GET", "/posts/1.json")).toMatchObject({
      action: "show",
      params: { id: "1", format: "json" },
    });
    expect(router.recognize("GET", "/posts.json")).toMatchObject({
      action: "index",
      params: { format: "json" },
    });
  });

  // Rails: glob routes capture the rest of the path, slashes included
  it("matches a glob segment", () => {
    const router = draw((r) => r.get("files/*path", { to: "files#show", as: "file" }));

    expect(router.recognize("GET", "/files/a/b/c.txt")).toMatchObject({
      action: "show",
      params: { path: "a/b/c.txt" },
    });
  });

  // Rails: a trailing slash is the same route
  it("ignores a trailing slash", () => {
    const router = draw((r) => r.resources("posts"));
    expect(router.recognize("GET", "/posts/")).toMatchObject({ action: "index" });
  });

  // Rails: the query string is not part of matching
  it("ignores the query string", () => {
    const router = draw((r) => r.resources("posts"));
    expect(router.recognize("GET", "/posts?page=2")).toMatchObject({ action: "index" });
  });
});

describe("path helpers", () => {
  // This is surface Rails has no compile-time equivalent of.
  it("generates a helper per named route", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();

    expect(Object.keys(paths).sort()).toEqual([
      "editPostPath",
      "newPostPath",
      "postPath",
      "postsPath",
    ]);
  });

  it("builds collection and member paths", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();

    expect(paths.postsPath!()).toBe("/posts");
    expect(paths.postPath!(1)).toBe("/posts/1");
    expect(paths.newPostPath!()).toBe("/posts/new");
    expect(paths.editPostPath!(1)).toBe("/posts/1/edit");
  });

  // Rails: post_path(post) calls to_param on the record.
  //
  // The distinction Rails draws between a record and an options hash is the one
  // drawn here between a class instance and an object literal, so these use real
  // instances rather than literals.
  it("accepts a record", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();

    class Post {
      constructor(
        readonly id: number,
        readonly title: string,
      ) {}
    }
    class Slugged {
      toParam(): string {
        return "hello-world";
      }
    }

    expect(paths.postPath!(new Post(7, "hi"))).toBe("/posts/7");
    expect(paths.postPath!(new Slugged())).toBe("/posts/hello-world");
  });

  // An object literal is an options hash, as a Ruby Hash is in Rails.
  it("treats an object literal as params, not a record", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();
    expect(paths.postPath!({ id: 7, title: "hi" })).toBe("/posts/7?title=hi");
  });

  it("fills nested segments in order", () => {
    const paths = draw((r) => r.resources("posts", (rr) => rr.resources("comments"))).pathHelpers();

    expect(paths.postCommentsPath!(1)).toBe("/posts/1/comments");
    expect(paths.postCommentPath!(1, 2)).toBe("/posts/1/comments/2");
    expect(paths.editPostCommentPath!(1, 2)).toBe("/posts/1/comments/2/edit");
  });

  // Rails: posts_path(page: 2) appends a query string
  it("turns leftover keys into query parameters", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();

    expect(paths.postsPath!({ page: 2 })).toBe("/posts?page=2");
    expect(paths.postPath!(1, { anchor: "top" })).toBe("/posts/1?anchor=top");
    expect(paths.postPath!({ id: 1, page: 2 })).toBe("/posts/1?page=2");
  });

  it("encodes segment values", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();
    expect(paths.postPath!("a b/c")).toBe("/posts/a%20b%2Fc");
  });

  it("throws when a required segment is missing", () => {
    const paths = draw((r) => r.resources("posts")).pathHelpers();
    expect(() => paths.postPath!()).toThrow('Missing required parameter "id"');
  });

  it("names namespaced helpers", () => {
    const paths = draw((r) => r.namespace("admin", (rr) => rr.resources("posts"))).pathHelpers();

    expect(paths.adminPostsPath!()).toBe("/admin/posts");
    expect(paths.editAdminPostPath!(3)).toBe("/admin/posts/3/edit");
  });
});
