/**
 * Generated path helpers.
 *
 * Rails defines `edit_post_path` at boot by metaprogramming: the name exists,
 * its arity does not, and a missing argument is a 404 in production rather
 * than an error in the editor. These tests are about the arity.
 */

import { describe, expect, it } from "bun:test";
import { Router } from "../src/router.js";
import { dumpRouteHelpers, helperSignature, requiredSegments } from "../src/dump.js";

function routerFor(draw: Parameters<Router["draw"]>[0]): Router {
  return new Router().draw(draw);
}

const resources = routerFor((r) => r.resources("posts"));

describe("required segments", () => {
  it("are none for a collection route", () => {
    expect(requiredSegments(resources.routeNamed("posts")!)).toEqual([]);
  });

  it("are the id for a member route", () => {
    expect(requiredSegments(resources.routeNamed("post")!)).toEqual(["id"]);
    expect(requiredSegments(resources.routeNamed("edit_post")!)).toEqual(["id"]);
  });

  it("include the parent for a nested route", () => {
    const nested = routerFor((r) => r.resources("posts", (n) => n.resources("comments")));

    expect(requiredSegments(nested.routeNamed("post_comment")!)).toEqual(["post_id", "id"]);
  });

  // `format` is optional in Rails and never a positional argument.
  it("leave format out", () => {
    const withFormat = routerFor((r) => r.get("/feed.:format", { to: "feed#show", as: "feed" }));
    expect(requiredSegments(withFormat.routeNamed("feed")!)).not.toContain("format");
  });
});

describe("signatures", () => {
  it("take nothing but a query for a collection", () => {
    const signature = helperSignature(resources.routeNamed("posts")!, "postsPath");
    expect(signature).toContain("postsPath(query?: QueryParams): string;");
  });

  it("take the id for a member", () => {
    const signature = helperSignature(resources.routeNamed("post")!, "postPath");
    expect(signature).toContain("postPath(id: ParamValue, query?: QueryParams): string;");
  });

  it("name a nested segment in camel case", () => {
    const nested = routerFor((r) => r.resources("posts", (n) => n.resources("comments")));
    const signature = helperSignature(nested.routeNamed("post_comment")!, "postCommentPath");

    expect(signature).toContain("postCommentPath(postId: ParamValue, id: ParamValue");
  });

  it("say which route the helper is for", () => {
    expect(helperSignature(resources.routeNamed("post")!, "postPath")).toContain("GET /posts/:id");
  });
});

describe("the generated module", () => {
  const source = dumpRouteHelpers(resources);

  it("says it is generated", () => {
    expect(source).toContain("do not edit by hand");
  });

  it("declares the types the signatures use", () => {
    expect(source).toContain("export type ParamValue");
    expect(source).toContain("export type QueryParams");
  });

  it("declares a helper per named route", () => {
    for (const name of ["postsPath", "newPostPath", "editPostPath", "postPath"]) {
      expect(source).toContain(`  ${name}(`);
    }
  });

  // Named exports rather than one object: an editor completes them from a bare
  // import, and a bundler drops the ones a page never calls.
  it("exports each helper by name", () => {
    expect(source).toContain("export const editPostPath = helpers.editPostPath");
  });

  it("exports them together as well", () => {
    expect(source).toContain("export const paths: PathHelpers = helpers;");
  });

  it("imports the application's own routes", () => {
    expect(dumpRouteHelpers(resources, { routesModule: "../config/routes.js" })).toContain(
      'import { router } from "../config/routes.js";',
    );
  });

  it("handles a route table with nothing named", () => {
    const anonymous = routerFor((r) => r.get("/health", { to: "health#show" }));
    const generated = dumpRouteHelpers(anonymous);

    expect(generated).toContain("export interface PathHelpers {");
    expect(generated).toContain("export const paths");
  });
});

// The generated signatures have to describe what the runtime actually does, or
// the types are a second source of truth that drifts.
describe("agreeing with the runtime", () => {
  const nested = routerFor((r) => r.resources("posts", (n) => n.resources("comments")));
  const helpers = nested.pathHelpers();

  it("builds a collection path", () => {
    expect(helpers.postsPath!()).toBe("/posts");
  });

  it("builds a member path from an id", () => {
    expect(helpers.postPath!(1)).toBe("/posts/1");
  });

  it("builds a member path from a record", () => {
    expect(helpers.editPostPath!({ id: 7 })).toBe("/posts/7/edit");
  });

  it("builds a nested path in the declared order", () => {
    expect(helpers.postCommentPath!(1, 2)).toBe("/posts/1/comments/2");
  });

  it("turns anything left over into a query string", () => {
    expect(helpers.postsPath!({ page: 2 })).toBe("/posts?page=2");
  });

  it("has a helper for every name the dump declares", () => {
    for (const name of nested.routeNames) {
      const camel = name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      expect(typeof helpers[`${camel}Path`]).toBe("function");
    }
  });
});
