/**
 * Collection and object helpers, ported from
 * `activesupport/test/core_ext/enumerable_test.rb`, `array_ext_test.rb`,
 * `hash_ext_test.rb` and `object/blank_test.rb`.
 *
 * Only the ones JavaScript does not already have. A wrapper around `map` is a
 * name to learn for nothing.
 */

import { describe, expect, it } from "bun:test";
import {
  compactBlank,
  deepDup,
  deepTransformKeys,
  deepTransformValues,
  dig,
  except,
  excluding,
  inGroups,
  inGroupsOf,
  inOrderOf,
  including,
  indexBy,
  indexWith,
  isBlank,
  isPresent,
  presence,
  presenceIn,
  slice,
  toSentence,
  valuesAt,
  wrap,
} from "../src/enumerable.js";

describe("blank and present", () => {
  it("agrees with Rails on every shape", () => {
    for (const blank of [null, undefined, false, "", "   ", [], {}, new Map(), new Set()]) {
      expect(isBlank(blank)).toBe(true);
    }

    for (const present of [0, true, "x", [null], { a: 1 }, new Date()]) {
      expect(isBlank(present)).toBe(false);
    }
  });

  it("is the opposite of present", () => {
    expect(isPresent("x")).toBe(true);
    expect(isPresent("")).toBe(false);
  });

  it("hands back the value or nothing", () => {
    expect(presence("x")).toBe("x");
    expect(presence("  ")).toBeUndefined();
  });

  /**
   * Written for the case it names: a parameter that may only be one of a few
   * things, without an `includes` and a ternary at every call site.
   */
  it("takes a value only if it is allowed", () => {
    expect(presenceIn("date", ["name", "date"])).toBe("date");
    expect(presenceIn("passwords", ["name", "date"])).toBeUndefined();
    expect(presenceIn("passwords", ["name", "date"]) ?? "name").toBe("name");
  });

  it("drops the blanks from a list", () => {
    expect(compactBlank([1, null, "", 2, "  ", 3, false])).toEqual([1, 2, 3]);
  });
});

describe("keying a list", () => {
  it("indexes by something taken from each", () => {
    const users = [
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ];

    expect(indexBy(users, (user) => user.id).get(2)?.name).toBe("Grace");
  });

  it("indexes each with something derived", () => {
    expect(indexWith(["a", "bb"], (one) => one.length).get("bb")).toBe(2);
  });

  // The last one wins, as a Map does and as Rails' index_by does.
  it("keeps the last of a repeated key", () => {
    const rows = [
      { k: 1, v: "first" },
      { k: 1, v: "second" },
    ];

    expect(indexBy(rows, (row) => row.k).get(1)?.v).toBe("second");
  });
});

describe("splitting a list", () => {
  it("takes fixed-size chunks", () => {
    expect(inGroupsOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  // Rails pads to a rectangle when given something to pad with, because the
  // caller is usually laying out a grid and a short last row breaks it.
  it("pads the last chunk when asked", () => {
    expect(inGroupsOf([1, 2, 3], 2, 0)).toEqual([
      [1, 2],
      [3, 0],
    ]);
  });

  it("refuses a size of nothing", () => {
    expect(() => inGroupsOf([1], 0)).toThrow(/at least 1/);
  });

  it("takes a fixed number of chunks", () => {
    expect(inGroups([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  // The first groups take the remainder, one each, so no group differs from
  // another by more than one.
  it("spreads the remainder rather than dumping it", () => {
    expect(inGroups([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("adding to and taking from a list", () => {
  it("leaves out what it is told to", () => {
    expect(excluding([1, 2, 3, 4], 2, 4)).toEqual([1, 3]);
  });

  it("takes a list to leave out", () => {
    expect(excluding([1, 2, 3], [1, 3] as never)).toEqual([2]);
  });

  it("adds to the end", () => {
    expect(including([1, 2], 3)).toEqual([1, 2, 3]);
  });

  /**
   * Anything whose key is not in the list is dropped, as Rails drops it: the
   * list is a statement about what you want as much as about the order.
   */
  it("sorts into the order it was given, dropping the rest", () => {
    const posts = [{ state: "live" }, { state: "archived" }, { state: "draft" }];

    expect(inOrderOf(posts, (post) => post.state, ["draft", "live"])).toEqual([
      { state: "draft" },
      { state: "live" },
    ]);
  });
});

describe("copying", () => {
  it("goes all the way down", () => {
    const original = { a: { b: [1, 2] }, when: new Date(0) };
    const copy = deepDup(original);

    copy.a.b.push(3);

    expect(original.a.b).toEqual([1, 2]);
    expect(copy.when).not.toBe(original.when);
    expect(copy.when.getTime()).toBe(0);
  });

  /**
   * Anything with a prototype of its own knows how to copy itself, and
   * guessing on its behalf makes a broken twin — a Map that is now a plain
   * object, a model instance with no methods.
   */
  it("leaves an object that is not plain alone", () => {
    class Thing {
      constructor(readonly name: string) {}
    }

    const original = { thing: new Thing("a") };

    expect(deepDup(original).thing).toBe(original.thing);
  });

  it("copies a map and a set by value", () => {
    const original = new Map([["a", { n: 1 }]]);
    const copy = deepDup(original);

    copy.get("a")!.n = 2;

    expect(original.get("a")!.n).toBe(1);
  });
});

describe("rewriting keys and values", () => {
  it("renames every key, all the way down", () => {
    const renamed = deepTransformKeys({ first_name: "Ada", at: { home_town: "London" } }, (key) =>
      key.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
    );

    expect(renamed).toEqual({ firstName: "Ada", at: { homeTown: "London" } });
  });

  it("changes every value, all the way down", () => {
    expect(deepTransformValues({ a: 1, b: { c: 2 } }, (one) => (one as number) * 10)).toEqual({
      a: 10,
      b: { c: 20 },
    });
  });

  it("reaches through arrays", () => {
    expect(deepTransformKeys({ a_b: [{ c_d: 1 }] }, (key) => key.toUpperCase())).toEqual({
      A_B: [{ C_D: 1 }],
    });
  });
});

describe("picking at an object", () => {
  it("keeps only what it is asked for", () => {
    expect(slice({ a: 1, b: 2, c: 3 }, "a", "c")).toEqual({ a: 1, c: 3 });
  });

  it("says nothing about a key that is not there", () => {
    expect(slice({ a: 1 }, "a", "z" as never)).toEqual({ a: 1 });
  });

  it("drops what it is asked to", () => {
    expect(except({ a: 1, b: 2 }, "b")).toEqual({ a: 1 });
  });

  it("takes values in the order asked", () => {
    expect(valuesAt({ a: 1, b: 2, c: 3 }, "c", "a")).toEqual([3, 1]);
  });

  it("reaches in without a chain of guards", () => {
    expect(dig({ a: { b: { c: 1 } } }, "a", "b", "c")).toBe(1);
    expect(dig({ a: null }, "a", "b")).toBeUndefined();
    expect(dig({ a: [{ b: 2 }] }, "a", 0, "b")).toBe(2);
  });
});

describe("miscellany", () => {
  it("wraps whatever it is given", () => {
    expect(wrap(1)).toEqual([1]);
    expect(wrap([1, 2])).toEqual([1, 2]);
    expect(wrap(null)).toEqual([]);
    expect(wrap(undefined)).toEqual([]);
  });

  it("writes a list as a sentence", () => {
    expect(toSentence([])).toBe("");
    expect(toSentence(["a"])).toBe("a");
    expect(toSentence(["a", "b"])).toBe("a and b");
    expect(toSentence(["a", "b", "c"])).toBe("a, b, and c");
  });

  it("takes different words when the list means something else", () => {
    expect(toSentence(["a", "b"], { twoWords: " or " })).toBe("a or b");
    expect(toSentence(["a", "b", "c"], { lastWord: " and " })).toBe("a, b and c");
  });
});
