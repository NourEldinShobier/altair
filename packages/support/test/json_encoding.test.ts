/**
 * Turning a value into JSON and keeping out of it what should not be there,
 * ported from `activesupport/test/json/encoding_test.rb` and the filtering
 * cases in `activesupport/test/parameter_filter_test.rb`.
 *
 * The two cases worth testing hardest are the ones that are invisible until
 * they matter: a document embedded in a page, and a filter list rebuilt per
 * parameter.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type CompiledFilter,
  asJson,
  convert,
  currentPayloadFilter,
  dupValue,
  encodeWithoutEscape,
  encodeWithoutOptions,
  extractableOptions,
  filterParam,
  htmlEscape,
  jsonEncoder,
  precompileFilters,
  reloadPayloadFilter,
  reopen,
  resetPayloadFilter,
  safeRecord,
  toOptions,
} from "../src/json_encoding.js";

afterEach(() => {
  resetPayloadFilter();
});

describe("a document embedded in a page", () => {
  /**
   * `</script>` inside a string ends the script tag whatever the JSON says, so
   * a comment body containing it turns the rest of the page into markup the
   * browser executes.
   */
  it("escapes what would end a script block", () => {
    expect(htmlEscape('{"body":"</script>"}')).toContain("\\u003c/script\\u003e");
    expect(htmlEscape('{"body":"</script>"}')).not.toContain("</script>");
  });

  /**
   * An HTML entity inside the JSON would otherwise be decoded by the parser
   * before the script ran, so `&lt;` in a string becomes a real `<`.
   */
  it("escapes the ampersand too", () => {
    expect(htmlEscape('{"a":"&lt;"}')).toContain("\\u0026");
  });

  /** For anything not going into a page, escaping is noise every reader decodes. */
  it("leaves a document alone when it is not for a page", () => {
    expect(encodeWithoutEscape({ body: "<p>" })).toBe('{"body":"<p>"}');
    expect(encodeWithoutOptions({ body: "<p>" })).toBe('{"body":"<p>"}');
  });

  it("escapes only when asked", () => {
    expect(jsonEncoder({ escapeHtml: true })({ body: "<p>" })).toContain("\\u003c");
    expect(jsonEncoder()({ body: "<p>" })).toContain("<p>");
  });
});

describe("what the encoder keeps", () => {
  const record = { id: 1, title: "a", secret: "x" };

  it("takes only what was asked for", () => {
    expect(jsonEncoder({ only: ["title"] })(record)).toBe('{"title":"a"}');
  });

  it("drops what was excluded", () => {
    expect(jsonEncoder({ except: ["secret"] })(record)).toBe('{"id":1,"title":"a"}');
  });

  /**
   * Intersecting silently produces fewer fields than either asked for, and the
   * caller sees a document missing one with nothing to explain it.
   */
  it("lets only win over except", () => {
    expect(jsonEncoder({ only: ["title", "secret"], except: ["secret"] })(record)).toContain(
      "secret",
    );
  });

  it("descends into nested values", () => {
    expect(asJson({ post: { tags: ["a"] } })).toEqual({ post: { tags: ["a"] } });
  });

  /** With something that has to be converted, or the walk proves nothing. */
  it("descends far enough to convert a nested time", () => {
    const at = new Date("2026-01-01T12:00:00.000Z");

    expect(asJson({ post: { at } })).toEqual({ post: { at: "2026-01-01T12:00:00.000Z" } });
    expect(asJson({ posts: [{ at }] })).toEqual({ posts: [{ at: "2026-01-01T12:00:00.000Z" }] });
  });

  /**
   * Left to `JSON.stringify` a time is milliseconds always, so a column stored
   * at second precision round-trips with three zeros that were never in the
   * database.
   */
  it("writes a time at the configured precision", () => {
    const at = new Date("2026-01-01T12:00:00.123Z");

    expect(asJson(at, { timePrecision: 3 })).toBe("2026-01-01T12:00:00.123Z");
    expect(asJson(at, { timePrecision: 0 })).toBe("2026-01-01T12:00:00Z");
    expect(asJson(at, { timePrecision: 1 })).toBe("2026-01-01T12:00:00.1Z");
  });

  /**
   * Cut rather than rounded: rounding can move a timestamp past the moment it
   * describes, and a record whose stored time is after its own creation breaks
   * any ordering relying on it.
   */
  it("cuts rather than rounding", () => {
    expect(asJson(new Date("2026-01-01T12:00:00.900Z"), { timePrecision: 0 })).toBe(
      "2026-01-01T12:00:00Z",
    );
  });
});

describe("compiling a filter list", () => {
  /**
   * A matcher per parameter turns filtering into a cost proportional to
   * parameters times patterns — and the parameters are user-controlled, so a
   * request with a thousand of them costs a thousand times as much to log.
   */
  it("compiles once", () => {
    const compiled = precompileFilters(["password", /token/i]);

    expect(compiled.patterns).toHaveLength(2);
    expect(compiled.exact.has("password")).toBe(true);
  });

  /** What makes `password` cover `password_confirmation`. */
  it("matches a plain string as a substring too", () => {
    const compiled = precompileFilters(["password"]);

    expect(filterParam("password", compiled)).toBe(true);
    expect(filterParam("password_confirmation", compiled)).toBe(true);
    expect(filterParam("PASSWORD", compiled)).toBe(true);
    expect(filterParam("email", compiled)).toBe(false);
  });

  it("matches a pattern", () => {
    expect(filterParam("reset_token", precompileFilters([/token/i]))).toBe(true);
  });

  /**
   * The substring pattern is case-insensitive too, not just the exact set: a
   * filter written `Password` has to cover `password_confirmation`, which the
   * exact lookup cannot answer.
   */
  it("matches a substring whatever the case", () => {
    expect(filterParam("password_confirmation", precompileFilters(["Password"]))).toBe(true);
  });

  /** A filter with regex characters in it is a plain string, not a pattern. */
  it("escapes a plain string with regex characters", () => {
    const compiled = precompileFilters(["a.b"]);

    expect(filterParam("a.b", compiled)).toBe(true);
    expect(filterParam("axb", compiled)).toBe(false);
  });

  /**
   * Explicit rather than automatic: the compiled form is what makes filtering
   * cheap, and rebuilding it on every read would undo that.
   */
  it("is rebuilt only when asked", () => {
    expect(currentPayloadFilter()).toBeUndefined();

    reloadPayloadFilter(["password"]);

    expect(currentPayloadFilter()).toBeDefined();
    expect(filterParam("password", currentPayloadFilter() as CompiledFilter)).toBe(true);
  });

  /**
   * Replaced rather than removed, so a reader can see the attribute exists and
   * was withheld — an omitted one reads as one the record does not have.
   */
  it("replaces a filtered value rather than dropping it", () => {
    const safe = safeRecord({ email: "a@b.c", password: "x" }, precompileFilters(["password"]));

    expect(safe).toEqual({ email: "a@b.c", password: "[FILTERED]" });
  });

  it("takes a different placeholder", () => {
    expect(safeRecord({ password: "x" }, precompileFilters(["password"]), "***")).toEqual({
      password: "***",
    });
  });
});

describe("whether something is an options hash", () => {
  /**
   * A method taking a trailing options hash cannot otherwise tell `find(1, 2)`
   * from `find(1, limit: 2)`, and guessing turns a positional argument into an
   * option that is silently ignored.
   */
  it("accepts a plain object", () => {
    expect(extractableOptions({ limit: 2 })).toBe(true);
    expect(extractableOptions(Object.create(null) as object)).toBe(true);
  });

  /**
   * A model instance is an object and is never options — treating one as
   * options would drop it from the arguments entirely.
   */
  it("refuses anything with a prototype of its own", () => {
    class Post {}

    expect(extractableOptions(new Post())).toBe(false);
    expect(extractableOptions(new Date())).toBe(false);
    expect(extractableOptions(new Map())).toBe(false);
    expect(extractableOptions([1])).toBe(false);
    expect(extractableOptions(null)).toBe(false);
    expect(extractableOptions(2)).toBe(false);
  });

  /**
   * Options are routinely mutated by whatever receives them — defaults merged
   * in, keys deleted after being read — and doing that to the caller's object
   * changes a value it still holds.
   */
  it("copies rather than handing the caller's object back", () => {
    const options = { limit: 2 };

    expect(toOptions(options)).not.toBe(options);
    expect(toOptions(options)).toEqual(options);
    expect(toOptions(7)).toEqual({});
  });

  /**
   * One level: a deeper copy would clone whatever a caller put inside,
   * including a connection — and a cloned connection is one nothing will
   * close.
   */
  it("copies one level", () => {
    const nested = { inner: { a: 1 } };
    const copy = dupValue(nested);

    expect(copy).not.toBe(nested);
    expect(copy.inner).toBe(nested.inner);
  });

  it("copies a list too", () => {
    const list = [{ a: 1 }];
    const copy = dupValue(list);

    expect(copy).not.toBe(list);
    expect(copy[0]).toBe(list[0]);
  });

  it("leaves a value that is not a container alone", () => {
    const date = new Date();

    expect(dupValue(date)).toBe(date);
    expect(dupValue(7)).toBe(7);
  });

  /**
   * Converting a model or a date would replace it with a shape that merely
   * resembles it.
   */
  it("converts nested plain objects and nothing else", () => {
    const date = new Date();
    const converted = convert({ a: { b: 1 }, at: date }) as { a: object; at: Date };

    expect(converted.a).toEqual({ b: 1 });
    expect(converted.at).toBe(date);
  });

  it("converts inside a list", () => {
    expect(convert([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
});

describe("merging options", () => {
  /**
   * The difference from a plain spread: `{ a: { b: 1 } }` reopened with
   * `{ a: { c: 2 } }` keeps both, where a spread drops `b` — silently, because
   * the result is still an object with an `a`.
   */
  it("merges nested objects rather than replacing them", () => {
    expect(reopen({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
  });

  it("replaces a value that is not an options hash", () => {
    expect(reopen({ a: { b: 1 } }, { a: 2 })).toEqual({ a: 2 });
    expect(reopen({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
  });

  it("keeps keys only one side has", () => {
    expect(reopen({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("does not edit either argument", () => {
    const base = { a: { b: 1 } };
    reopen(base, { a: { c: 2 } });

    expect(base).toEqual({ a: { b: 1 } });
  });
});
