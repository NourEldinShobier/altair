/**
 * Paths worked out from a record.
 *
 * Mirrors actionpack/test/controller/routing_test.rb's polymorphic section.
 * The new-versus-saved tests are the ones that matter: one form template both
 * creates and updates because the record decides where it posts, and reading
 * that from the record rather than from a flag is what stops the two drifting.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Router } from "../src/router.js";
import { NoRouteForRecord, polymorphicPath, routeForRecord } from "../src/polymorphic.js";

/** What a model looks like to the router. */
const record = (name: string, id: unknown, extra: { plural?: string; singular?: string } = {}) => ({
  modelName: {
    routeKey: extra.plural ?? `${name}s`,
    singularRouteKey: extra.singular ?? name,
  },
  id,
  persisted: id !== undefined && id !== null,
  toParam: () => String(id ?? ""),
});

let router: Router;

beforeEach(() => {
  router = new Router();
  router.draw((r) => {
    r.resources("posts", () => r.resources("comments"));
    r.resources("people");
  });
});

describe("choosing the route", () => {
  it("sends a saved record to its own path", () => {
    expect(routeForRecord(record("post", 1))).toEqual({ name: "post", values: ["1"] });
  });

  // The reason one form template can both create and update.
  it("sends a new record to the collection", () => {
    expect(routeForRecord(record("post", null))).toEqual({ name: "posts", values: [] });
  });

  it("takes an action", () => {
    expect(routeForRecord(record("post", 1), { action: "edit" })).toEqual({
      name: "edit_post",
      values: ["1"],
    });
  });

  // `new` is a collection action, so it never carries an id even when the
  // record it was called with has one.
  it("drops the id for new", () => {
    expect(routeForRecord(record("post", 1), { action: "new" })).toEqual({
      name: "new_post",
      values: [],
    });
  });

  it("nests under an owner", () => {
    expect(routeForRecord(record("comment", 2), { within: record("post", 1) })).toEqual({
      name: "post_comment",
      values: ["1", "2"],
    });
  });

  it("nests a new record under its owner's collection", () => {
    expect(routeForRecord(record("comment", null), { within: record("post", 1) })).toEqual({
      name: "post_comments",
      values: ["1"],
    });
  });

  it("follows the inflection the model name carries", () => {
    const person = record("person", 1, { plural: "people" });

    expect(routeForRecord({ ...person, persisted: false })).toEqual({
      name: "people",
      values: [],
    });
  });
});

describe("building the path", () => {
  it("gives a saved record its own path", () => {
    expect(polymorphicPath(router, record("post", 1))).toBe("/posts/1");
  });

  it("gives a new one the collection", () => {
    expect(polymorphicPath(router, record("post", null))).toBe("/posts");
  });

  it("takes edit and new", () => {
    expect(polymorphicPath(router, record("post", 1), { action: "edit" })).toBe("/posts/1/edit");
    expect(polymorphicPath(router, record("post", null), { action: "new" })).toBe("/posts/new");
  });

  it("nests", () => {
    expect(polymorphicPath(router, record("comment", 2), { within: record("post", 1) })).toBe(
      "/posts/1/comments/2",
    );
  });

  it("appends a query", () => {
    expect(polymorphicPath(router, record("post", 1), { query: { page: 2 } })).toBe(
      "/posts/1?page=2",
    );
  });

  it("uses the record's own toParam", () => {
    const slugged = { ...record("post", 1), toParam: () => "1-hello-world" };

    expect(polymorphicPath(router, slugged)).toBe("/posts/1-hello-world");
  });

  it("works from a class, for the collection", () => {
    expect(
      polymorphicPath(router, { modelName: { routeKey: "posts", singularRouteKey: "post" } }),
    ).toBe("/posts");
  });

  // A route table that nests some things and not others is the common shape,
  // so a nested record still resolves when only the flat route exists.
  it("falls back to the flat route when the nested one is absent", () => {
    const flat = new Router();
    flat.draw((r) => {
      r.resources("comments");
    });

    expect(polymorphicPath(flat, record("comment", 2), { within: record("post", 1) })).toBe(
      "/comments/2",
    );
  });

  it("says what it tried when nothing matches", () => {
    expect(() => polymorphicPath(router, record("widget", 1))).toThrow(NoRouteForRecord);
    expect(() => polymorphicPath(router, record("widget", 1))).toThrow(/r\.resources/);
  });
});

// A real ORM model satisfies this interface as it stands: `modelName` comes
// from ActiveModel and `isPersisted` from Model. Checked against one rather
// than assumed — an interface two packages agree on by coincidence is one that
// stops agreeing quietly.

// Anything with an id looks saved; a class has none, which is also the answer
// that sends it to the collection.
describe("deciding whether a record is saved", () => {
  it("believes an explicit flag", () => {
    const saved = { ...record("post", 1), persisted: false };

    expect(routeForRecord(saved).name).toBe("posts");
  });

  it("accepts the ORM's own spelling", () => {
    const orm = {
      modelName: { routeKey: "posts", singularRouteKey: "post" },
      id: 1,
      isPersisted: true,
      toParam: () => "1",
    };

    expect(routeForRecord(orm).name).toBe("post");
  });

  it("falls back to whether it has an id", () => {
    const bare = { modelName: { routeKey: "posts", singularRouteKey: "post" }, id: 7 };

    expect(routeForRecord(bare)).toEqual({ name: "post", values: ["7"] });
  });
});
