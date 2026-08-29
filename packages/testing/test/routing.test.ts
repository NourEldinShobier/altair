/**
 * Assertions about a route table, ported from
 * `actionpack/test/controller/routing_test.rb`.
 *
 * Routes are the one part of an application every request passes through and
 * almost nobody tests, because testing them through a request means standing up
 * a controller and asserting on a response — which fails for a dozen reasons
 * that have nothing to do with routing.
 */

import { describe, expect, it } from "bun:test";
import { AssertionFailed } from "@altair/support";
import { Router } from "@altair/router";
import { assertGenerates, assertNoRoute, assertRecognizes, assertRouting } from "../src/routing.js";

const router = new Router();
router.draw((r) => {
  r.resources("posts");
});

describe("recognising a path", () => {
  it("passes when it reaches the action", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "GET", path: "/posts" },
        { controller: "posts", action: "index" },
      ),
    ).not.toThrow();
  });

  it("checks the segment values when it is given them", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "GET", path: "/posts/7" },
        { controller: "posts", action: "show", params: { id: "7" } },
      ),
    ).not.toThrow();
  });

  it("fails when nothing recognises the path", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "GET", path: "/nope" },
        { controller: "posts", action: "index" },
      ),
    ).toThrow(AssertionFailed);
  });

  /**
   * "Did not recognise" and "recognised something else" are different bugs,
   * and only one of them is about the path being missing.
   */
  it("says what it did reach when that is the problem", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "GET", path: "/posts" },
        { controller: "posts", action: "show" },
      ),
    ).toThrow(/reaches posts#index, not posts#show/);
  });

  it("says nothing recognised it when nothing did", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "GET", path: "/nope" },
        { controller: "posts", action: "index" },
      ),
    ).toThrow(/No route recognises/);
  });

  it("fails when the segment values differ", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "GET", path: "/posts/7" },
        { controller: "posts", action: "show", params: { id: "8" } },
      ),
    ).toThrow(AssertionFailed);
  });

  it("tells the verbs apart", () => {
    expect(() =>
      assertRecognizes(
        router,
        { method: "POST", path: "/posts" },
        { controller: "posts", action: "create" },
      ),
    ).not.toThrow();

    expect(() =>
      assertRecognizes(
        router,
        { method: "POST", path: "/posts" },
        { controller: "posts", action: "index" },
      ),
    ).toThrow(AssertionFailed);
  });
});

describe("generating a path", () => {
  it("passes when the helper produces it", () => {
    expect(() => assertGenerates(router, "/posts", "postsPath")).not.toThrow();
  });

  it("passes for a helper that takes a segment", () => {
    expect(() => assertGenerates(router, "/posts/7", "postPath", "7")).not.toThrow();
  });

  it("fails when the helper produces something else", () => {
    expect(() => assertGenerates(router, "/articles", "postsPath")).toThrow(
      /generates "\/posts", not "\/articles"/,
    );
  });

  /**
   * A typo in a helper name is the commonest way this assertion is written
   * wrong, so the failure lists a few that do exist rather than only saying no.
   */
  it("says which helpers exist when the name is wrong", () => {
    expect(() => assertGenerates(router, "/posts", "postsPathh")).toThrow(/Some that exist/);
  });
});

/**
 * The pair drifting apart is the failure worth catching: a route renamed on one
 * side and not the other still recognises and still generates — just not the
 * same path — and each half passes its own test.
 */
describe("both directions at once", () => {
  it("passes when they agree", () => {
    expect(() =>
      assertRouting(
        router,
        { method: "GET", path: "/posts/7" },
        {
          controller: "posts",
          action: "show",
          params: { id: "7" },
          helper: "postPath",
          args: ["7"],
        },
      ),
    ).not.toThrow();
  });

  it("fails when recognition is wrong", () => {
    expect(() =>
      assertRouting(
        router,
        { method: "GET", path: "/posts/7" },
        { controller: "posts", action: "edit", helper: "postPath", args: ["7"] },
      ),
    ).toThrow(AssertionFailed);
  });

  it("fails when generation is wrong", () => {
    expect(() =>
      assertRouting(
        router,
        { method: "GET", path: "/posts/7" },
        { controller: "posts", action: "show", helper: "postsPath" },
      ),
    ).toThrow(AssertionFailed);
  });
});

describe("asserting nothing answers", () => {
  it("passes when nothing does", () => {
    expect(() => assertNoRoute(router, { method: "GET", path: "/nope" })).not.toThrow();
  });

  it("fails when something does, and says what", () => {
    expect(() => assertNoRoute(router, { method: "GET", path: "/posts" })).toThrow(
      /reaches posts#index/,
    );
  });

  /**
   * The one people reach for: proving a destructive route is not reachable by
   * a verb it should not answer.
   */
  it("catches a route answering a verb it should not", () => {
    expect(() => assertNoRoute(router, { method: "DELETE", path: "/posts/7" })).toThrow(
      AssertionFailed,
    );
  });
});
