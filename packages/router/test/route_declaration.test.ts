/**
 * What the router checks and fills in when a route is declared, ported from
 * `actionpack/test/dispatch/mapper_test.rb` and the resource cases in
 * `routing_test.rb`.
 *
 * Each of these is silent when it goes wrong: a route that answers a method it
 * should not, one that matches a path nobody asked for, and one that matches
 * nothing at all.
 */

import { describe, expect, it } from "bun:test";
import {
  MissingVia,
  buildConditions,
  checkVia,
  optionalFormat,
  pathWithFormat,
} from "../src/route_declaration.js";
import { Router, UnknownResourceAction, defaultActions } from "../src/router.js";

describe("the methods a match answers", () => {
  it("is what the declaration named", () => {
    expect(checkVia(["get", "post"])).toEqual(["get", "post"]);
  });

  it("does not care about case", () => {
    expect(checkVia(["GET"])).toEqual(["get"]);
  });

  /**
   * Refused rather than defaulted. Answering every method means a link a
   * crawler follows runs the action that takes the payment; defaulting to GET
   * quietly breaks the routes that meant both.
   */
  it("is refused when the declaration named none", () => {
    expect(() => checkVia([])).toThrow(MissingVia);
  });

  it("says the two ways to write it", () => {
    expect(() => checkVia([])).toThrow("via:");
    expect(() => checkVia([])).toThrow('get("/pay")');
  });
});

describe("the format suffix", () => {
  it("is appended to an ordinary path", () => {
    expect(optionalFormat("/posts")).toBe(true);
    expect(pathWithFormat("/posts")).toBe("/posts(.:format)");
  });

  /**
   * `/feed.:format(.:format)` matches `/feed.rss.rss` and not `/feed.rss` — a
   * 404 on the route somebody just wrote.
   */
  it("is not appended to a path that already has one", () => {
    expect(optionalFormat("/feed.:format")).toBe(false);
    expect(pathWithFormat("/feed.:format")).toBe("/feed.:format");
    expect(pathWithFormat("/posts(.:format)")).toBe("/posts(.:format)");
  });

  it("is left off when the declaration says so", () => {
    expect(optionalFormat("/posts", false)).toBe(false);
    expect(pathWithFormat("/posts", false)).toBe("/posts");
  });

  /**
   * Required rather than optional is what an API route that must not answer a
   * bare path wants: `/posts/1` with no extension should be a 404 there.
   */
  it("is required when the declaration says so", () => {
    expect(pathWithFormat("/posts", true)).toBe("/posts.:format");
  });
});

describe("the constraints a request can be asked about", () => {
  it("keeps the ones it can answer", () => {
    expect(buildConditions({ subdomain: "admin", method: "GET" }, ["subdomain", "method"])).toEqual(
      {
        subdomain: "admin",
        method: "GET",
      },
    );
  });

  /**
   * Kept, the route matches nothing at all — and a route that never matches is
   * a 404 with no explanation, since the declaration is right there and looks
   * correct.
   */
  it("drops one it cannot", () => {
    expect(buildConditions({ subdomain: "admin", nonsense: 1 }, ["subdomain"])).toEqual({
      subdomain: "admin",
    });
  });

  it("keeps nothing when it can answer nothing", () => {
    expect(buildConditions({ subdomain: "admin" }, [])).toEqual({});
  });
});

describe("the actions a resource draws", () => {
  it("is the seven", () => {
    expect(defaultActions()).toEqual([
      "index",
      "create",
      "new",
      "show",
      "update",
      "destroy",
      "edit",
    ]);
  });

  /** There is one of it, so a collection route would list one thing. */
  it("has no index for a singular resource", () => {
    expect(defaultActions({ singleton: true })).not.toContain("index");
  });

  /**
   * `new` and `edit` exist to render a form, and an API renders nothing —
   * drawn anyway they answer with a missing-template error, which reads as a
   * broken application.
   */
  it("drops the form actions for an api", () => {
    expect(defaultActions({ apiOnly: true })).toEqual([
      "index",
      "create",
      "show",
      "update",
      "destroy",
    ]);
    expect(defaultActions({ apiOnly: true, singleton: true })).toEqual([
      "show",
      "create",
      "update",
      "destroy",
    ]);
  });
});

describe("declaring a resource", () => {
  const drawn = (options: Record<string, unknown> = {}): string[] => {
    const router = new Router();
    router.draw((r) => {
      r.resources("posts", options);
    });

    return router.routes.map((route) => route.action);
  };

  it("draws the seven by default", () => {
    expect(new Set(drawn())).toEqual(
      new Set(["index", "create", "new", "show", "update", "destroy", "edit"]),
    );
  });

  it("draws no form actions for an api", () => {
    expect(drawn({ apiOnly: true })).not.toContain("new");
    expect(drawn({ apiOnly: true })).not.toContain("edit");
    expect(drawn({ apiOnly: true })).toContain("index");
  });

  /**
   * `only` is a whitelist, so an unrecognised name there draws nothing at all
   * rather than adding something — the routes it was meant to keep are simply
   * missing.
   */
  it("refuses a name that is not an action", () => {
    expect(() => drawn({ only: ["idnex"] })).toThrow(UnknownResourceAction);
    expect(() => drawn({ except: ["destory"] })).toThrow(UnknownResourceAction);
  });

  it("names what it did not recognise", () => {
    expect(() => drawn({ only: ["idnex"] })).toThrow("idnex");
  });

  it("still takes the names that are actions", () => {
    expect(new Set(drawn({ only: ["index", "show"] }))).toEqual(new Set(["index", "show"]));
  });
});
