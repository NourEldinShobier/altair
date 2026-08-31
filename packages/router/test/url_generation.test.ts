/**
 * Building a path from a named route and a set of values, ported from
 * `actionpack/test/journey/router/utils_test.rb`,
 * `actionpack/test/controller/url_for_test.rb` and the generation cases in
 * `actionpack/test/dispatch/routing_test.rb`.
 *
 * The failures worth testing are the ones that still produce a URL: a value
 * left over becoming a query parameter, a recalled value surviving past the
 * page it described, a route matched on declaration order rather than fit.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type GeneratableRoute,
  NoRouteMatches,
  clearMountedHelpers,
  defineMountedHelper,
  extractParameterizedParts,
  generate,
  generateUrlHelpers,
  hasNamedRoute,
  matchRoute,
  missingKeys,
  mountedHelpers,
  mountedPrefix,
  normalizeController,
  normalizeControllerActionId,
  optimizeHelper,
  optimizeRoutesGeneration,
  possibles,
  requiredDefaults,
  routeDefined,
  scoreRoute,
  urlFor,
  urlHelperNames,
  useRecallFor,
  useRelativeController,
} from "../src/url_generation.js";

const ROUTES: GeneratableRoute[] = [
  { name: "posts", pattern: "/posts", defaults: { controller: "posts", action: "index" } },
  { name: "post", pattern: "/posts/:id", defaults: { controller: "posts", action: "show" } },
  {
    name: "editPost",
    pattern: "/posts/:id/edit",
    defaults: { controller: "posts", action: "edit" },
  },
  {
    name: "comment",
    pattern: "/posts/:post_id/comments/:id",
    defaults: { controller: "comments", action: "show" },
  },
];

afterEach(() => {
  clearMountedHelpers();
});

describe("what a route needs", () => {
  it("reports its own defaults", () => {
    expect(requiredDefaults(ROUTES[1] as GeneratableRoute)).toEqual({
      controller: "posts",
      action: "show",
    });
  });

  it("reports none for a route with none", () => {
    expect(requiredDefaults({ pattern: "/x" })).toEqual({});
  });

  it("names what it was not given", () => {
    expect(missingKeys(ROUTES[1] as GeneratableRoute, {})).toEqual(["id"]);
  });

  it("names nothing when it has everything", () => {
    expect(missingKeys(ROUTES[1] as GeneratableRoute, { id: 7 })).toEqual([]);
  });

  it("counts a default as supplied", () => {
    expect(missingKeys({ pattern: "/posts/:id", defaults: { id: 1 } }, {})).toEqual([]);
  });

  it("says which names are defined", () => {
    expect(routeDefined(ROUTES, "post")).toBe(true);
    expect(hasNamedRoute(ROUTES, "nope")).toBe(false);
  });
});

describe("choosing a route", () => {
  it("lists the ones a set of values could generate", () => {
    expect(possibles(ROUTES, { controller: "posts", action: "show", id: 7 })).toHaveLength(1);
  });

  /** Generating it would produce a URL routing to an action nobody named. */
  it("leaves out one whose defaults disagree", () => {
    expect(possibles(ROUTES, { controller: "posts", action: "edit", id: 7 })[0]?.name).toBe(
      "editPost",
    );
  });

  it("leaves out one missing a required value", () => {
    expect(possibles(ROUTES, { controller: "comments", action: "show", id: 7 })).toEqual([]);
  });

  it("filters by name when given one", () => {
    expect(possibles(ROUTES, { id: 7 }, "post")).toHaveLength(1);
  });

  /**
   * A supplied value the route ignores becomes a query parameter, so a link
   * meant to be `/posts/7/edit` silently becomes `/posts?id=7`.
   */
  it("scores a route by how much of the input it uses", () => {
    expect(scoreRoute(ROUTES[2] as GeneratableRoute, { id: 7 })).toBe(1);
    expect(scoreRoute(ROUTES[0] as GeneratableRoute, { id: 7 })).toBe(0);
  });

  it("picks the one that uses the most", () => {
    const routes: GeneratableRoute[] = [
      { name: "posts", pattern: "/posts" },
      { name: "post", pattern: "/posts/:id" },
    ];

    expect(matchRoute(routes, { id: 7 }).name).toBe("post");
  });

  /** So the answer is deterministic rather than a function of file order. */
  it("breaks a tie on declaration order", () => {
    const routes: GeneratableRoute[] = [
      { name: "first", pattern: "/a/:id" },
      { name: "second", pattern: "/b/:id" },
    ];

    expect(matchRoute(routes, { id: 7 }).name).toBe("first");
  });

  it("refuses when nothing matches", () => {
    expect(() => matchRoute(ROUTES, { controller: "nope", action: "show" })).toThrow(
      NoRouteMatches,
    );
  });

  it("says what would have gone wrong", () => {
    expect(() => matchRoute(ROUTES, { controller: "nope" })).toThrow("query string");
  });
});

describe("splitting values from query parameters", () => {
  it("puts a named segment in the path", () => {
    const { parts } = extractParameterizedParts(ROUTES[1] as GeneratableRoute, { id: 7 });

    expect(parts["id"]).toBe(7);
  });

  it("puts anything else in the query", () => {
    const { query } = extractParameterizedParts(ROUTES[1] as GeneratableRoute, {
      id: 7,
      page: 2,
    });

    expect(query).toEqual({ page: 2 });
  });

  /** Echoing a route's own default back would put `?action=show` on every URL. */
  it("does not echo the route's own defaults into the query", () => {
    const { query } = extractParameterizedParts(ROUTES[1] as GeneratableRoute, {
      id: 7,
      controller: "posts",
      action: "show",
    });

    expect(query).toEqual({});
  });
});

describe("generating", () => {
  it("builds a path", () => {
    expect(generate(ROUTES, { controller: "posts", action: "show", id: 7 }).path).toBe("/posts/7");
  });

  it("builds a nested one", () => {
    expect(
      generate(ROUTES, { controller: "comments", action: "show", post_id: 1, id: 7 }).path,
    ).toBe("/posts/1/comments/7");
  });

  it("hands back what it could not place", () => {
    expect(generate(ROUTES, { controller: "posts", action: "show", id: 7, page: 2 }).query).toEqual(
      { page: 2 },
    );
  });

  it("writes the query string", () => {
    expect(urlFor(ROUTES, { controller: "posts", action: "show", id: 7, page: 2 })).toBe(
      "/posts/7?page=2",
    );
  });

  it("writes no query string when there is nothing left over", () => {
    expect(urlFor(ROUTES, { controller: "posts", action: "show", id: 7 })).toBe("/posts/7");
  });

  it("leaves out a value that is nothing", () => {
    expect(urlFor(ROUTES, { controller: "posts", action: "index", page: undefined })).toBe(
      "/posts",
    );
  });

  it("generates by name", () => {
    expect(urlFor(ROUTES, { id: 7 }, { name: "editPost" })).toBe("/posts/7/edit");
  });
});

describe("carrying values from the current request", () => {
  it("keeps the controller and action being served", () => {
    expect(
      urlFor(ROUTES, { id: 9 }, { recall: { controller: "posts", action: "show", id: 7 } }),
    ).toBe("/posts/9");
  });

  /**
   * The cascade. A caller supplying a new controller means the recalled action
   * and id described a page that no longer applies — without this a link on
   * `/posts/7` points at `/comments/7`.
   */
  it("drops what a supplied value supersedes", () => {
    expect(
      useRecallFor({ controller: "comments" }, { controller: "posts", action: "show", id: 7 }),
    ).toEqual({});
  });

  it("keeps what comes before the supplied value", () => {
    expect(useRecallFor({ id: 9 }, { controller: "posts", action: "show", id: 7 })).toEqual({
      controller: "posts",
      action: "show",
    });
  });

  it("keeps everything when nothing is supplied", () => {
    expect(useRecallFor({}, { controller: "posts", action: "show", id: 7 })).toEqual({
      controller: "posts",
      action: "show",
      id: 7,
    });
  });

  it("keeps nothing when there is no recall", () => {
    expect(useRecallFor({ id: 9 }, {})).toEqual({});
  });

  it("takes the controller from the recall when none is given", () => {
    expect(normalizeControllerActionId({ id: 7 }, { controller: "posts" })["controller"]).toBe(
      "posts",
    );
  });
});

describe("naming a controller relative to the current one", () => {
  it("resolves a bare name inside a namespace", () => {
    expect(normalizeController("comments", "admin/posts")).toBe("admin/comments");
  });

  /** Without the leading slash there is no way to link out of a namespace. */
  it("takes a leading slash as the top level", () => {
    expect(normalizeController("/comments", "admin/posts")).toBe("comments");
  });

  it("leaves a qualified name alone", () => {
    expect(normalizeController("admin/comments", "admin/posts")).toBe("admin/comments");
  });

  it("leaves a bare name alone with no current controller", () => {
    expect(normalizeController("comments")).toBe("comments");
  });

  it("says which names are relative", () => {
    expect(useRelativeController("comments")).toBe(true);
    expect(useRelativeController("/comments")).toBe(false);
    expect(useRelativeController("admin/comments")).toBe(false);
  });
});

describe("named helpers", () => {
  it("names a path and a url helper", () => {
    expect(urlHelperNames({ name: "post", pattern: "/posts/:id" })).toEqual({
      path: "postPath",
      url: "postUrl",
    });
  });

  it("names none for an anonymous route", () => {
    expect(urlHelperNames({ pattern: "/posts" })).toBeUndefined();
  });

  it("lists every helper a route set defines", () => {
    expect(generateUrlHelpers(ROUTES)).toContain("editPostPath");
    expect(generateUrlHelpers(ROUTES)).toHaveLength(8);
  });
});

describe("skipping the search", () => {
  /** The difference between a `link_to` in a loop costing a search per row and an interpolation. */
  it("optimises a simple named route", () => {
    expect(optimizeHelper({ name: "post", pattern: "/posts/:id" }, { id: 7 })).toBe(true);
  });

  it("does not optimise an anonymous route", () => {
    expect(optimizeHelper({ pattern: "/posts/:id" }, { id: 7 })).toBe(false);
  });

  /** An optimised path that is wrong is worse than a slow one that is right. */
  it("does not optimise when there is a recall to consider", () => {
    expect(
      optimizeHelper({ name: "post", pattern: "/posts/:id" }, { id: 7 }, { controller: "posts" }),
    ).toBe(false);
  });

  it("does not optimise a route with an optional segment", () => {
    expect(optimizeHelper({ name: "post", pattern: "/posts/:id(.:format)" }, { id: 7 })).toBe(
      false,
    );
  });

  it("does not optimise when a value the route does not name is supplied", () => {
    expect(optimizeHelper({ name: "post", pattern: "/posts/:id" }, { id: 7, page: 2 })).toBe(false);
  });

  it("optimises the whole set only with no recall", () => {
    expect(optimizeRoutesGeneration({})).toBe(true);
    expect(optimizeRoutesGeneration({ controller: "posts" })).toBe(false);
  });
});

describe("mounted engines", () => {
  it("remembers a prefix", () => {
    defineMountedHelper("blog", "/blog");

    expect(mountedPrefix("blog")).toBe("/blog");
    expect(mountedHelpers()).toEqual(["blog"]);
  });

  it("has none to start with", () => {
    expect(mountedHelpers()).toEqual([]);
  });
});
