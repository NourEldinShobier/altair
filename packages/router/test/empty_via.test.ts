/**
 * A `match` that names no methods, ported from the `check_via` cases in
 * `actionpack/test/dispatch/routing_test.rb`.
 *
 * `via: []` used to draw a route that exists and answers nothing: it is in the
 * table, `url_for` finds it, and every request for it is a 404 with nothing to
 * say why. The declaration is where that is worth catching, because by the
 * time it is a 404 the route looks fine.
 */

import { describe, expect, it } from "bun:test";
import { Router } from "../src/router.js";
import { MissingVia } from "../src/route_declaration.js";

function drawn(body: Parameters<Router["draw"]>[0]): Router {
  return new Router().draw(body);
}

function methodsOf(router: Router): string[] {
  return router.routes.map((route) => route.method);
}

describe("a match that names no methods", () => {
  it("is refused", () => {
    expect(() => drawn((r) => r.match("/pay", { to: "payments#create", via: [] }))).toThrow(
      MissingVia,
    );
  });

  /** The message names what is wrong and both ways to say it. */
  it("says how to say it", () => {
    expect(() => drawn((r) => r.match("/pay", { to: "payments#create", via: [] }))).toThrow(
      "has to say which HTTP methods",
    );
    expect(() => drawn((r) => r.match("/pay", { to: "payments#create", via: [] }))).toThrow("via:");
    expect(() => drawn((r) => r.match("/pay", { to: "payments#create", via: [] }))).toThrow(
      'get("/pay")',
    );
  });

  it("draws nothing when it is refused", () => {
    const router = new Router();

    expect(() => router.draw((r) => r.match("/pay", { to: "payments#create", via: [] }))).toThrow();
    expect(router.routes).toHaveLength(0);
  });
});

describe("a match that names some", () => {
  it("draws one route per method", () => {
    expect(
      methodsOf(drawn((r) => r.match("/pay", { to: "payments#create", via: ["GET", "POST"] }))),
    ).toEqual(["GET", "POST"]);
  });

  it("takes a single method", () => {
    expect(
      methodsOf(drawn((r) => r.match("/pay", { to: "payments#create", via: "POST" }))),
    ).toEqual(["POST"]);
  });

  /** Stored as it was written: `Route` matches on the method the request has. */
  it("keeps the method the way it was spelled", () => {
    expect(
      drawn((r) => r.match("/pay", { to: "payments#create", via: ["GET"] })).routes[0]?.method,
    ).toBe("GET");
  });
});

describe("a match with no via at all", () => {
  /**
   * This router's own choice, and the reason the refusal above is only for an
   * explicit empty list. Rails refuses a bare `match` because there it answers
   * *every* method — a link a crawler follows would run the action that takes
   * the payment. Here it answers GET, which is safe, so there is nothing to
   * refuse.
   */
  it("answers GET", () => {
    expect(methodsOf(drawn((r) => r.match("/pay", { to: "payments#show" })))).toEqual(["GET"]);
  });

  it("is not refused", () => {
    expect(() => drawn((r) => r.match("/pay", { to: "payments#show" }))).not.toThrow();
  });
});
