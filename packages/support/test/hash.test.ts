/**
 * The Hash helpers, ported from `activesupport/test/core_ext/hash_ext_test.rb`
 * and `object/to_query_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  assertValidKeys,
  compact,
  deepMerge,
  deepStringifyKeys,
  extractOptions,
  fetchValues,
  renameKey,
  reverseMerge,
  stringifyKeys,
  toParam,
  toQuery,
  transformKeys,
  transformValues,
} from "../src/index.js";

describe("transforming", () => {
  it("renames every key", () => {
    expect(transformKeys({ a: 1, b: 2 }, (key) => key.toUpperCase())).toEqual({ A: 1, B: 2 });
  });

  it("changes every value", () => {
    expect(transformValues({ a: 1, b: 2 }, (value) => value * 10)).toEqual({ a: 10, b: 20 });
  });

  it("hands the key to the value transform too", () => {
    expect(transformValues({ a: 1 }, (value, key) => `${key}${value}`)).toEqual({ a: "a1" });
  });

  it("leaves the original alone", () => {
    const original = { a: 1 };
    transformKeys(original, (key) => key.toUpperCase());

    expect(original).toEqual({ a: 1 });
  });

  it("stringifies keys", () => {
    expect(stringifyKeys({ 1: "one", b: "two" })).toEqual({ "1": "one", b: "two" });
  });

  it("stringifies keys all the way down", () => {
    expect(deepStringifyKeys({ a: { 1: "one" }, b: [{ 2: "two" }] })).toEqual({
      a: { "1": "one" },
      b: [{ "2": "two" }],
    });
  });

  it("leaves non-objects alone when going deep", () => {
    const date = new Date(0);

    expect(deepStringifyKeys({ at: date })).toEqual({ at: date });
  });
});

describe("assertValidKeys", () => {
  it("passes when every key is expected", () => {
    expect(() => assertValidKeys({ only: "index" }, "only", "except")).not.toThrow();
  });

  it("passes for an empty object", () => {
    expect(() => assertValidKeys({}, "only")).not.toThrow();
  });

  /** The typo is the whole reason the method exists, so it has to name it. */
  it("names the key it did not recognise", () => {
    expect(() => assertValidKeys({ ony: "index" }, "only", "except")).toThrow(/"ony"/);
  });

  it("names the keys that would have been valid", () => {
    expect(() => assertValidKeys({ ony: "index" }, "only", "except")).toThrow(/"only", "except"/);
  });
});

describe("merging", () => {
  it("lets the receiver win", () => {
    expect(reverseMerge({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("recurses into nested objects", () => {
    const merged = deepMerge({ mailer: { host: "old", port: 25 } }, { mailer: { host: "new" } });

    expect(merged).toEqual({ mailer: { host: "new", port: 25 } });
  });

  it("replaces rather than merges when only one side is an object", () => {
    expect(deepMerge({ a: { b: 1 } } as Record<string, unknown>, { a: 5 })).toEqual({ a: 5 });
  });

  it("replaces arrays rather than concatenating them", () => {
    expect(deepMerge({ tags: ["a"] }, { tags: ["b"] })).toEqual({ tags: ["b"] });
  });

  it("leaves both originals alone", () => {
    const target = { a: { b: 1 } };
    deepMerge(target, { a: { c: 2 } });

    expect(target).toEqual({ a: { b: 1 } });
  });
});

describe("fetchValues", () => {
  it("gives the values in the order asked for", () => {
    expect(fetchValues({ a: 1, b: 2, c: 3 }, "c", "a")).toEqual([3, 1]);
  });

  /** The difference from valuesAt: this one stops where the mistake is. */
  it("throws on a key that is not there", () => {
    expect(() => fetchValues({ a: 1 } as Record<string, number>, "b")).toThrow(/"b"/);
  });

  it("gives an explicit undefined rather than throwing", () => {
    expect(fetchValues({ a: undefined }, "a")).toEqual([undefined]);
  });
});

describe("compact", () => {
  it("drops null and undefined", () => {
    expect(compact({ a: 1, b: null, c: undefined })).toEqual({ a: 1 });
  });

  it("keeps false, zero and the empty string", () => {
    expect(compact({ a: false, b: 0, c: "" })).toEqual({ a: false, b: 0, c: "" });
  });
});

describe("renameKey", () => {
  it("renames it", () => {
    expect(renameKey({ a: 1, b: 2 }, "a", "z")).toEqual({ z: 1, b: 2 });
  });

  /** Order is observable, so a rename must not shuffle the field to the end. */
  it("keeps the original position", () => {
    expect(Object.keys(renameKey({ a: 1, b: 2, c: 3 }, "b", "z"))).toEqual(["a", "z", "c"]);
  });

  it("does nothing when the key is absent", () => {
    expect(renameKey({ a: 1 }, "missing", "z")).toEqual({ a: 1 });
  });
});

describe("toParam", () => {
  it("stringifies a scalar", () => {
    expect(toParam(42)).toBe("42");
  });

  it("gives an empty string for nothing", () => {
    expect(toParam(null)).toBe("");
    expect(toParam(undefined)).toBe("");
  });

  it("joins an array with slashes", () => {
    expect(toParam(["a", "b"])).toBe("a/b");
  });
});

describe("toQuery", () => {
  it("builds a query string", () => {
    expect(toQuery({ b: 2, a: 1 })).toBe("a=1&b=2");
  });

  /** Sorted, so the same object always produces the same cache key. */
  it("sorts the keys", () => {
    expect(toQuery({ z: 1, a: 2 })).toBe("a=2&z=1");
  });

  it("nests with brackets", () => {
    expect(toQuery({ filter: { tag: "ruby" } })).toBe("filter%5Btag%5D=ruby");
  });

  it("repeats a key for each array element", () => {
    expect(toQuery({ ids: [1, 2] })).toBe("ids%5B%5D=1&ids%5B%5D=2");
  });

  it("escapes what needs escaping", () => {
    expect(toQuery({ q: "a b&c" })).toBe("q=a%20b%26c");
  });

  it("gives an empty string for an empty object", () => {
    expect(toQuery({})).toBe("");
  });
});

describe("extractOptions", () => {
  it("takes the trailing object as options", () => {
    expect(extractOptions(["Home", "/", { class: "nav" }])).toEqual({
      rest: ["Home", "/"],
      options: { class: "nav" },
    });
  });

  it("takes nothing when the last argument is not a plain object", () => {
    expect(extractOptions(["Home", "/"])).toEqual({ rest: ["Home", "/"], options: {} });
  });

  /** A Date is an object but is plainly an argument, not an options bag. */
  it("does not mistake a class instance for options", () => {
    const date = new Date(0);

    expect(extractOptions([date])).toEqual({ rest: [date], options: {} });
  });

  it("copes with no arguments at all", () => {
    expect(extractOptions([])).toEqual({ rest: [], options: {} });
  });
});
