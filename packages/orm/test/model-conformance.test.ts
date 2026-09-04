/**
 * Whether an object is usable as a model, ported from
 * `activemodel/test/cases/lint_test.rb`,
 * `activemodel/test/cases/serialization_test.rb` and the validator cases in
 * `activemodel/test/cases/validations/with_validation_test.rb`.
 *
 * Each check exists because the failure it replaces happens somewhere else —
 * inside a form builder, a router, or a template — with a message about `nil`
 * rather than about the class that caused it.
 */

import { describe, expect, it } from "bun:test";
import {
  type LintableModel,
  accessed,
  eachValue,
  errorOptions,
  forgetReads,
  fromJson,
  hasBeenRead,
  hasDelegatedJson,
  hasJson,
  initializeCopy,
  lintModel,
  lookupAncestors,
  testErrorsAref,
  testModelNaming,
  testPersisted,
  testToKey,
  testToParam,
  testToPartialPath,
  toHash,
  uniq,
} from "../src/model-conformance.js";

function model(overrides: Partial<LintableModel> = {}): LintableModel {
  return {
    toKey: () => [1],
    toParam: () => "1",
    toPartialPath: () => "posts/post",
    persisted: () => true,
    errors: { get: () => [] },
    modelName: { name: "Post", singular: "post", plural: "posts", param: "post", route: "posts" },
    ...overrides,
  };
}

describe("toKey", () => {
  it("accepts a persisted record with a key", () => {
    expect(testToKey(model())).toEqual([]);
  });

  it("accepts a new record with none", () => {
    expect(testToKey(model({ persisted: () => false, toKey: () => undefined }))).toEqual([]);
  });

  /**
   * An empty array is truthy, so a form builder treats the record as persisted
   * and builds an update form whose action has no id in it.
   */
  it("refuses a new record that answers with an empty array", () => {
    const problems = testToKey(model({ persisted: () => false, toKey: () => [] }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain("truthy");
  });

  it("refuses a persisted record with no key", () => {
    expect(testToKey(model({ toKey: () => undefined }))).toHaveLength(1);
  });

  /** An empty array is a key by length and not by meaning. */
  it("refuses a persisted record whose key is empty", () => {
    expect(testToKey(model({ toKey: () => [] }))).toHaveLength(1);
  });

  it("refuses a model without the method at all", () => {
    expect(testToKey(model({ toKey: undefined }))).toHaveLength(1);
  });
});

describe("toParam", () => {
  it("accepts a plain identifier", () => {
    expect(testToParam(model())).toEqual([]);
  });

  it("accepts a slug", () => {
    expect(testToParam(model({ toParam: () => "1-my-post" }))).toEqual([]);
  });

  /**
   * A slash produces a URL routing somewhere else, and the router then reports
   * a missing route for a path the application built itself.
   */
  it("refuses one containing a slash", () => {
    const problems = testToParam(model({ toParam: () => "posts/1" }));

    expect(problems[0]?.detail).toContain("routing somewhere else");
  });

  it("accepts nothing from a new record", () => {
    expect(testToParam(model({ persisted: () => false, toParam: () => undefined }))).toEqual([]);
  });

  it("refuses nothing from a persisted one", () => {
    expect(testToParam(model({ toParam: () => undefined }))).toHaveLength(1);
  });
});

describe("toPartialPath", () => {
  it("accepts a relative path", () => {
    expect(testToPartialPath(model())).toEqual([]);
  });

  /**
   * Rendering looks inside the view root, so an absolute path fails as a
   * missing template — which reads as one somebody forgot to write.
   */
  it("refuses an absolute one", () => {
    expect(testToPartialPath(model({ toPartialPath: () => "/posts/post" }))[0]?.detail).toContain(
      "absolute path",
    );
  });

  it("refuses something that is not a string", () => {
    expect(testToPartialPath(model({ toPartialPath: () => 7 as unknown as string }))).toHaveLength(
      1,
    );
  });
});

describe("persisted", () => {
  it("accepts a boolean", () => {
    expect(testPersisted(model())).toEqual([]);
    expect(testPersisted(model({ persisted: () => false }))).toEqual([]);
  });

  /**
   * Something truthy passes the branches that ask loosely and fails the ones
   * that ask strictly, so the record is persisted in half the framework and
   * new in the other half.
   */
  it("refuses something merely truthy", () => {
    const problems = testPersisted(model({ persisted: () => 1 as unknown as boolean }));

    expect(problems[0]?.detail).toContain("half the framework");
  });
});

describe("modelName", () => {
  it("accepts all five names", () => {
    expect(testModelNaming(model())).toEqual([]);
  });

  /**
   * Each is used by a different layer, so a missing one fails wherever the
   * application reaches first — which is not where the problem is.
   */
  it("names which are missing", () => {
    const problems = testModelNaming(
      model({
        modelName: { name: "Post", singular: "", plural: "posts", param: "post", route: "" },
      }),
    );

    expect(problems[0]?.detail).toContain("singular, route");
  });

  it("refuses a model with no naming at all", () => {
    expect(testModelNaming(model({ modelName: undefined }))).toHaveLength(1);
  });
});

describe("errors[:attribute]", () => {
  it("accepts an array for an attribute with no errors", () => {
    expect(testErrorsAref(model())).toEqual([]);
  });

  /**
   * Every view that renders errors iterates it, so this raises inside a
   * template and is reported against the template rather than the model.
   */
  it("refuses anything else", () => {
    const problems = testErrorsAref(
      model({ errors: { get: () => undefined as unknown as unknown[] } }),
    );

    expect(problems[0]?.detail).toContain("inside a");
  });

  it("refuses a model with no errors collection", () => {
    expect(testErrorsAref(model({ errors: undefined }))).toHaveLength(1);
  });
});

describe("running every check", () => {
  it("says nothing about a model that satisfies them all", () => {
    expect(lintModel(model())).toEqual([]);
  });

  /**
   * Collects rather than stopping: the alternative is a fix-and-rerun loop as
   * long as the list of problems.
   */
  it("reports everything wrong at once", () => {
    const checks = lintModel({}).map((problem) => problem.check);

    expect(checks).toEqual([
      "modelName",
      "persisted",
      "toKey",
      "toParam",
      "toPartialPath",
      "errors",
    ]);
  });
});

describe("reading a document", () => {
  it("takes the attributes as they are", () => {
    expect(fromJson('{"title":"a"}')).toEqual({ title: "a" });
  });

  it("unwraps a matching root", () => {
    expect(fromJson('{"post":{"title":"a"}}', { root: "post" })).toEqual({ title: "a" });
  });

  /** A document with two keys is not wrapped at all. */
  it("leaves a document with more than one key alone", () => {
    expect(fromJson('{"post":{"title":"a"},"meta":1}', { root: "post" })).toEqual({
      post: { title: "a" },
      meta: 1,
    });
  });

  it("leaves a document whose single key is not the root alone", () => {
    expect(fromJson('{"title":"a"}', { root: "post" })).toEqual({ title: "a" });
  });
});

describe("writing a document", () => {
  const attributes = { id: 1, title: "a", secret: "x" };

  it("takes everything by default", () => {
    expect(toHash(attributes)).toEqual(attributes);
  });

  it("copies rather than handing the attributes out", () => {
    expect(toHash(attributes)).not.toBe(attributes);
  });

  it("takes only what was asked for", () => {
    expect(toHash(attributes, { only: ["title"] })).toEqual({ title: "a" });
  });

  it("drops what was excluded", () => {
    expect(toHash(attributes, { except: ["secret"] })).toEqual({ id: 1, title: "a" });
  });

  /**
   * Intersecting would silently produce fewer attributes than either asked
   * for, and the caller sees a document missing a field with nothing to
   * explain it.
   */
  it("lets only win over except rather than intersecting", () => {
    expect(toHash(attributes, { only: ["title", "secret"], except: ["secret"] })).toEqual({
      title: "a",
      secret: "x",
    });
  });

  it("says which values serialize themselves", () => {
    expect(hasJson({ toJSON: () => 1 })).toBe(true);
    expect(hasJson({})).toBe(false);
    expect(hasJson(null)).toBe(false);
  });

  /**
   * A delegating toJSON returns a structure that will be serialized again, so
   * stringifying its result double-encodes — the document arrives as a string
   * containing JSON rather than as JSON.
   */
  it("tells a delegating toJSON from one that serializes", () => {
    expect(hasDelegatedJson({ toJSON: () => ({ a: 1 }) })).toBe(true);
    expect(hasDelegatedJson({ toJSON: () => '{"a":1}' })).toBe(false);
    expect(hasDelegatedJson({})).toBe(false);
  });
});

describe("tracking that an attribute was read", () => {
  /**
   * A null attribute and one nobody touched look identical, so the value alone
   * cannot say whether a read happened.
   */
  it("remembers which attributes were read", () => {
    const record = {};

    expect(hasBeenRead(record, "title")).toBe(false);

    accessed(record, "title");

    expect(hasBeenRead(record, "title")).toBe(true);
    expect(hasBeenRead(record, "body")).toBe(false);
  });

  it("keeps two records apart", () => {
    const first = {};
    const second = {};
    accessed(first, "title");

    expect(hasBeenRead(second, "title")).toBe(false);
  });

  it("forgets on request", () => {
    const record = {};
    accessed(record, "title");
    forgetReads(record);

    expect(hasBeenRead(record, "title")).toBe(false);
  });
});

describe("duplicating a record", () => {
  /**
   * Carrying the id across is the bug this exists to prevent: `post.dup.save`
   * would update the original rather than creating a second record.
   */
  it("drops the identity and keeps the attributes", () => {
    const copy = initializeCopy({ id: 7, title: "a", persisted: true });

    expect(copy["id"]).toBeUndefined();
    expect(copy["title"]).toBe("a");
    expect(copy["persisted"]).toBe(false);
  });

  it("drops a differently named primary key", () => {
    expect(
      initializeCopy({ uuid: "x", title: "a" }, { primaryKey: "uuid" })["uuid"],
    ).toBeUndefined();
  });
});

describe("lists", () => {
  /**
   * Most specific first, so a subclass's translation wins. The other order
   * makes every subclass inherit the base class's message, which reads as a
   * translation that was never added.
   */
  it("walks ancestors in order", () => {
    expect(lookupAncestors(["SpecialPost", "Post"])).toEqual(["SpecialPost", "Post"]);
  });

  /** Order matters: these become column lists and error orders. */
  it("deduplicates without reordering", () => {
    expect(uniq(["b", "a", "b", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("what a validator gets", () => {
  /**
   * The caller's options win, so a validator can override `message` without
   * losing `count` and `value`, which the message usually needs.
   */
  it("lets the caller override the defaults", () => {
    expect(errorOptions("title", "a", { message: "too short", count: 3 })).toEqual({
      attribute: "title",
      value: "a",
      message: "too short",
      count: 3,
    });
  });

  it("carries the attribute and value by default", () => {
    expect(errorOptions("title", "a")).toEqual({ attribute: "title", value: "a" });
  });

  /**
   * Including the value itself: a validator comparing against something
   * normalised needs the message to quote what it actually checked, not what
   * arrived.
   */
  it("lets the caller override the value too", () => {
    expect(errorOptions("title", "  a  ", { value: "a" })["value"]).toBe("a");
  });

  /**
   * Applying the validator to the array would compare its length against a
   * rule written about a single tag.
   */
  it("checks each element of a list", () => {
    const seen: unknown[] = [];

    expect(eachValue(["a", "b"], (value) => seen.push(value))).toBe(2);
    expect(seen).toEqual(["a", "b"]);
  });

  it("checks a single value once", () => {
    const seen: unknown[] = [];

    expect(eachValue("a", (value) => seen.push(value))).toBe(1);
    expect(seen).toEqual(["a"]);
  });
});
