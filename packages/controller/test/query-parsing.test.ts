/**
 * Turning a query string into parameters, ported from
 * `actionpack/test/dispatch/request_test.rb`,
 * `actionpack/test/dispatch/query_string_parsing_test.rb` and the limit cases
 * in Rack's `utils_spec.rb` that Rails relies on.
 *
 * The input here is entirely the sender's, so most of these are about limits:
 * a request that costs nothing to write must not cost the server an unbounded
 * amount to parse.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_DEPTH_LIMIT,
  InvalidParameterEncoding,
  LEGACY_SEPARATOR,
  ParamsTooDeep,
  TooManyParams,
  checkParamDepth,
  checkParamEncoding,
  clearParamEncodings,
  deepTransformKeys,
  deleteIf,
  eachPair,
  eachParamValue,
  fromHash,
  fromPairs,
  fromQueryString,
  ignoreLeadingBrackets,
  keyDepth,
  nestedAttribute,
  nestedParam,
  paramEncoding,
  queryParameterNames,
  rewriteParamValues,
  setBinaryEncoding,
  skipParameterEncoding,
  toUnsafeH,
} from "../src/query-parsing.js";

afterEach(() => {
  clearParamEncodings();
});

describe("splitting a query string", () => {
  it("reads a pair", () => {
    expect(fromQueryString("a=1")).toEqual([["a", "1"]]);
  });

  it("reads several", () => {
    expect(fromQueryString("a=1&b=2")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("ignores a leading question mark", () => {
    expect(fromQueryString("?a=1")).toEqual([["a", "1"]]);
  });

  it("reads nothing from nothing", () => {
    expect(fromQueryString("")).toEqual([]);
    expect(fromQueryString("?")).toEqual([]);
  });

  it("reads a key with no value", () => {
    expect(fromQueryString("a")).toEqual([["a", ""]]);
    expect(fromQueryString("a=")).toEqual([["a", ""]]);
  });

  it("keeps everything after the first equals", () => {
    expect(fromQueryString("a=1=2")).toEqual([["a", "1=2"]]);
  });

  it("decodes percent escapes and plus signs", () => {
    expect(fromQueryString("a=one+two&b=%C3%A9")).toEqual([
      ["a", "one two"],
      ["b", "é"],
    ]);
  });

  /**
   * A malformed escape is a bad request, not a crash: the raw text will match
   * nothing and the request ends as the 400 it is.
   */
  it("keeps a malformed escape as text rather than throwing", () => {
    expect(fromQueryString("a=%zz")).toEqual([["a", "%zz"]]);
  });

  /**
   * `;` was removed from the URL spec. Honouring it lets one request be read
   * as two different parameter sets by two different parsers.
   */
  it("does not split on a semicolon", () => {
    expect(fromQueryString("a=1;b=2")).toEqual([["a", "1;b=2"]]);
  });

  it("splits on one when explicitly asked", () => {
    expect(fromQueryString("a=1;b=2", { separator: LEGACY_SEPARATOR })).toHaveLength(2);
  });

  it("lists the names present", () => {
    expect(queryParameterNames("a=1&b=2&a=3")).toEqual(["a", "b"]);
  });
});

describe("how deep a key goes", () => {
  it("counts a flat key as one", () => {
    expect(keyDepth("a")).toBe(1);
  });

  it("counts each bracket", () => {
    expect(keyDepth("a[b][c]")).toBe(3);
  });

  /**
   * A request can ask for arbitrary depth in a few bytes, and building it
   * costs a stack frame per level.
   */
  it("refuses one past the limit", () => {
    const deep = `a${"[b]".repeat(DEFAULT_DEPTH_LIMIT + 1)}`;

    expect(() => checkParamDepth(deep)).toThrow(ParamsTooDeep);
  });

  it("allows one at the limit", () => {
    const atLimit = `a${"[b]".repeat(DEFAULT_DEPTH_LIMIT - 1)}`;

    expect(() => checkParamDepth(atLimit)).not.toThrow();
  });

  it("takes a limit of its own", () => {
    expect(() => checkParamDepth("a[b][c]", 2)).toThrow(ParamsTooDeep);
  });

  it("refuses a deep key while parsing", () => {
    expect(() => fromQueryString(`a${"[b]".repeat(40)}=1`)).toThrow(ParamsTooDeep);
  });

  it("says what would have happened", () => {
    expect(() => checkParamDepth("a[b][c]", 1)).toThrow("ending the process");
  });
});

describe("how many parameters there may be", () => {
  /** The cost of parsing has to be proportional to something the server chose. */
  it("refuses more than the limit", () => {
    const many = Array.from({ length: 11 }, (_, index) => `a${index}=1`).join("&");

    expect(() => fromQueryString(many, { paramLimit: 10 })).toThrow(TooManyParams);
  });

  it("allows the limit itself", () => {
    const exact = Array.from({ length: 10 }, (_, index) => `a${index}=1`).join("&");

    expect(() => fromQueryString(exact, { paramLimit: 10 })).not.toThrow();
  });

  it("refuses too many pairs from elsewhere too", () => {
    const pairs = Array.from({ length: 11 }, (_, index) => [`a${index}`, "1"] as const);

    expect(() => fromPairs(pairs, { paramLimit: 10 })).toThrow(TooManyParams);
  });
});

describe("what a parameter may contain", () => {
  it("passes an ordinary string", () => {
    expect(checkParamEncoding("a", "hello")).toBe("hello");
  });

  it("passes text outside ASCII", () => {
    expect(checkParamEncoding("a", "héllo — 日本語")).toBe("héllo — 日本語");
  });

  /**
   * A lone surrogate round-trips through nothing: JSON, a database driver and
   * a log formatter each fail on it somewhere further from the cause than here.
   */
  it("refuses a lone high surrogate", () => {
    expect(() => checkParamEncoding("a", "\uD800")).toThrow(InvalidParameterEncoding);
  });

  it("refuses a lone low surrogate", () => {
    expect(() => checkParamEncoding("a", "\uDC00")).toThrow(InvalidParameterEncoding);
  });

  it("allows a proper surrogate pair", () => {
    expect(checkParamEncoding("a", "😀")).toBe("😀");
  });

  it("names the parameter it refused", () => {
    expect(() => checkParamEncoding("user[bio]", "\uD800")).toThrow("user[bio]");
  });
});

describe("actions whose parameters are bytes", () => {
  /** Decoding an upload as UTF-8 corrupts it, and the upload still succeeds. */
  it("reports an action that was declared binary", () => {
    setBinaryEncoding("uploads", "create");

    expect(paramEncoding("uploads", "create")).toBe("binary");
  });

  it("reports everything else as text", () => {
    expect(paramEncoding("posts", "create")).toBe("utf-8");
  });

  it("answers from a declared set", () => {
    const declared = new Set(["uploads#create"]);

    expect(skipParameterEncoding("uploads", "create", declared)).toBe(true);
    expect(skipParameterEncoding("posts", "create", declared)).toBe(false);
  });
});

describe("walking a parameter structure", () => {
  const params = { user: { name: "Ada", roles: ["admin", "dev"] }, page: 2 };

  it("visits the top level", () => {
    const seen: string[] = [];
    eachPair(params, (key) => seen.push(key));

    expect(seen).toEqual(["user", "page"]);
  });

  /**
   * A filter that only looked at the top level would miss
   * `user[profile][bio]`, which is where the interesting values usually are.
   */
  it("visits every scalar, however deep", () => {
    const seen: unknown[] = [];
    eachParamValue(params, (value) => seen.push(value));

    expect(seen).toEqual(["Ada", "admin", "dev", 2]);
  });

  it("says where each one was", () => {
    const paths: string[][] = [];
    eachParamValue(params, (_value, path) => paths.push(path));

    expect(paths).toContainEqual(["user", "roles", "0"]);
  });

  /**
   * The shape has to survive: a filter that flattened `user[roles][]` into a
   * string would change what the application sees, not only what the log shows.
   */
  it("rewrites values and keeps the shape", () => {
    const filtered = rewriteParamValues(params, () => "[FILTERED]") as typeof params;

    expect(filtered.user.roles).toEqual(["[FILTERED]", "[FILTERED]"]);
    expect(Array.isArray(filtered.user.roles)).toBe(true);
  });

  it("can rewrite only what it chooses", () => {
    const filtered = rewriteParamValues(params, (value, path) =>
      path.at(-1) === "name" ? "[FILTERED]" : value,
    ) as typeof params;

    expect(filtered.user.name).toBe("[FILTERED]");
    expect(filtered.page).toBe(2);
  });

  it("transforms keys all the way down", () => {
    const upper = deepTransformKeys({ a: { b: 1 } }, (key) => key.toUpperCase());

    expect(upper).toEqual({ A: { B: 1 } });
  });

  it("drops what it is told to", () => {
    expect(deleteIf({ a: 1, b: 2 }, (key) => key === "a")).toEqual({ b: 2 });
  });

  /** Named for what it is, so an unfiltered read is something a reader notices. */
  it("hands back a copy of the raw structure", () => {
    const raw = toUnsafeH(params);

    expect(raw).toEqual(params);
    expect(raw["user"]).not.toBe(params.user);
  });
});

describe("reading a nested key", () => {
  it("recognises a nested one", () => {
    expect(nestedParam("user[name]")).toBe(true);
    expect(nestedParam("user[profile][bio]")).toBe(true);
  });

  it("does not mistake a flat one", () => {
    expect(nestedParam("user")).toBe(false);
  });

  /**
   * `[a]=1` has no name before the bracket, so there is nothing to nest under.
   * Guessing is what lets two parsers read one request differently.
   */
  it("does not read a key that begins with a bracket", () => {
    expect(ignoreLeadingBrackets("[a]")).toBe(true);
    expect(nestedParam("[a]")).toBe(false);
  });

  it("names the attribute at the end", () => {
    expect(nestedAttribute("user[profile][bio]")).toBe("bio");
    expect(nestedAttribute("user[name]")).toBe("name");
  });

  it("names none for a flat key", () => {
    expect(nestedAttribute("user")).toBeUndefined();
  });
});

describe("pairs from elsewhere", () => {
  it("checks them the same way", () => {
    expect(() => fromPairs([["a", "\uD800"]])).toThrow(InvalidParameterEncoding);
    expect(() => fromPairs([[`a${"[b]".repeat(40)}`, "1"]])).toThrow(ParamsTooDeep);
  });

  it("takes an object", () => {
    expect(fromHash({ a: 1, b: "two" })).toEqual([
      ["a", "1"],
      ["b", "two"],
    ]);
  });
});
