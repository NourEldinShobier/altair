/**
 * The route-pattern language, ported from
 * `actionpack/test/journey/path/pattern_test.rb`,
 * `actionpack/test/journey/nodes/symbol_test.rb` and
 * `actionpack/test/journey/router/utils_test.rb`.
 *
 * A route pattern is a small language, and the tests that matter are the ones
 * where splitting on `/` gives a different answer from parsing: optional
 * groups, globs, alternations, and literals containing regexp metacharacters.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SEGMENT,
  Format,
  PatternSyntaxError,
  Scanner,
  addMemo,
  buildAst,
  buildFormatter,
  compilePattern,
  dedupRegexp,
  eachNode,
  isGroup,
  isStar,
  isSymbol,
  isTerminal,
  matchPattern,
  nodeName,
  optionalNamesOf,
  parsePattern,
  requiredNames,
  requiredPath,
  requiredSegment,
  requirementsAnchored,
  requirementsForMissingKeysCheck,
  toDot,
  toPath,
  toRegexpSource,
  toSym,
} from "../src/pattern.js";

const tokensOf = (pattern: string) => {
  const scanner = new Scanner();
  scanner.scanSetup(pattern);

  const found: string[] = [];
  let token = scanner.nextToken();

  while (token !== undefined) {
    found.push(token);
    token = scanner.nextToken();
  }

  return found;
};

describe("scanning", () => {
  it("finds the separators", () => {
    expect(tokensOf("/foo")).toEqual(["SLASH", "LITERAL"]);
  });

  it("finds a symbol", () => {
    expect(tokensOf("/:id")).toEqual(["SLASH", "SYMBOL"]);
  });

  it("finds a star", () => {
    expect(tokensOf("/*path")).toEqual(["SLASH", "STAR"]);
  });

  it("finds a group", () => {
    expect(tokensOf("(.:format)")).toEqual(["LPAREN", "DOT", "SYMBOL", "RPAREN"]);
  });

  it("finds an alternation", () => {
    expect(tokensOf("a|b")).toEqual(["LITERAL", "OR", "LITERAL"]);
  });

  it("hands back the text it read", () => {
    const scanner = new Scanner();
    scanner.scanSetup(":id");
    scanner.nextToken();

    expect(scanner.lastString()).toBe(":id");
  });

  /** `\(` is a literal parenthesis, not the start of an optional group. */
  it("drops escapes from a literal", () => {
    const scanner = new Scanner();
    scanner.scanSetup("a\\(b");
    scanner.nextToken();

    expect(scanner.lastLiteral()).toBe("a(b");
  });

  /**
   * `:` is only a symbol when a name follows it. A single regexp over the
   * pattern cannot make that call without lookahead.
   */
  it("does not read a colon before another token as a symbol", () => {
    expect(tokensOf("::")).toEqual(["LITERAL", "LITERAL"]);
  });

  it("peeks without consuming", () => {
    const scanner = new Scanner();
    scanner.scanSetup("/a");

    expect(scanner.peekByte()).toBe("/");
    expect(scanner.peekByte()).toBe("/");
  });

  it("knows when it is finished", () => {
    const scanner = new Scanner();
    scanner.scanSetup("/");

    expect(scanner.eos).toBe(false);
    scanner.nextToken();
    expect(scanner.eos).toBe(true);
  });

  /**
   * A byte that is neither a token nor literal-shaped is still one character
   * of literal. Refusing it would make an unusual byte a boot-time crash.
   */
  it("takes an unexpected character as a literal", () => {
    expect(tokensOf("/a b")).toEqual(["SLASH", "LITERAL", "LITERAL", "LITERAL"]);
  });
});

describe("parsing", () => {
  it("builds a concatenation", () => {
    expect(parsePattern("/foo").type).toBe("CAT");
  });

  it("names a symbol without its sigil", () => {
    const tree = parsePattern("/:id");
    const symbol = eachNode(tree).find(isSymbol);

    expect(nodeName(symbol as never)).toBe("id");
    expect(toSym(symbol as never)).toBe("id");
  });

  it("names a star without its sigil", () => {
    const star = eachNode(parsePattern("/*path")).find(isStar);

    expect(nodeName(star as never)).toBe("path");
  });

  /** The thing splitting on `/` cannot see at all. */
  it("builds a group for an optional part", () => {
    expect(eachNode(parsePattern("/posts(.:format)")).some(isGroup)).toBe(true);
  });

  it("builds an alternation", () => {
    expect(eachNode(parsePattern("a|b")).some((node) => node.type === "OR")).toBe(true);
  });

  it("marks the terminals", () => {
    expect(eachNode(parsePattern("/a")).filter(isTerminal)).toHaveLength(2);
  });

  /**
   * Closing the group for the author would produce a route that exists but is
   * not the one they wrote.
   */
  it("refuses an unbalanced parenthesis", () => {
    expect(() => parsePattern("/posts(.:format")).toThrow(PatternSyntaxError);
  });

  it("says which pattern was wrong", () => {
    expect(() => parsePattern("/posts(.:format")).toThrow("/posts(.:format");
  });

  it("refuses an empty pattern", () => {
    expect(() => parsePattern("")).toThrow(PatternSyntaxError);
  });

  it("reproduces the pattern it parsed", () => {
    for (const pattern of ["/posts/:id", "/posts(.:format)", "/*path", "/a/b"]) {
      expect(toPath(parsePattern(pattern))).toBe(pattern);
    }
  });

  it("draws the tree", () => {
    const dot = toDot(parsePattern("/:id"));

    expect(dot).toStartWith("digraph pattern {");
    expect(dot).toContain("->");
  });
});

describe("what a tree knows about itself", () => {
  it("lists the parameter names", () => {
    expect(buildAst(parsePattern("/posts/:id/:slug")).names).toEqual(["id", "slug"]);
  });

  it("says when it has a glob", () => {
    expect(buildAst(parsePattern("/*path")).glob).toBe(true);
    expect(buildAst(parsePattern("/posts")).glob).toBe(false);
  });

  /**
   * A greedy wildcard swallows the trailing `.json`, and then every such
   * request renders HTML.
   */
  it("makes a glob non-greedy so a format can follow it", () => {
    expect(buildAst(parsePattern("/*path")).wildcardOptions["path"]).toBeDefined();
  });

  it("leaves it greedy when the route has no format", () => {
    expect(buildAst(parsePattern("/*path"), false).wildcardOptions).toEqual({});
  });

  it("hangs the route off every terminal", () => {
    const ast = buildAst(parsePattern("/a/:id"));
    addMemo(ast, "the-route");

    expect(ast.terminals.every((node) => node.memo === "the-route")).toBe(true);
  });

  it("finds the names inside optional groups", () => {
    expect(optionalNamesOf(parsePattern("/posts/:id(.:format)"))).toEqual(["format"]);
  });
});

describe("compiling to a regexp", () => {
  it("matches a static path", () => {
    const compiled = compilePattern("/posts");

    expect(compiled.regexp.test("/posts")).toBe(true);
  });

  /**
   * Unanchored, `/admin` matches `/public/admin` — a route matching more than
   * it says, on the part of an application where that matters most.
   */
  it("anchors at both ends", () => {
    const compiled = compilePattern("/admin");

    expect(compiled.regexp.test("/public/admin")).toBe(false);
    expect(compiled.regexp.test("/admin/users")).toBe(false);
  });

  it("leaves it open when asked", () => {
    const compiled = compilePattern("/engine", {}, { anchored: false });

    expect(compiled.regexp.test("/engine/inner")).toBe(true);
  });

  /**
   * An unescaped `.` is a wildcard, so `/robots.txt` would also serve
   * `/robotsXtxt`.
   */
  it("escapes a literal dot", () => {
    const compiled = compilePattern("/robots.txt");

    expect(compiled.regexp.test("/robots.txt")).toBe(true);
    expect(compiled.regexp.test("/robotsXtxt")).toBe(false);
  });

  it("escapes other metacharacters in a literal", () => {
    expect(toRegexpSource({ type: "LITERAL", left: "a+b" })).toBe("a\\+b");
  });

  it("captures a segment", () => {
    const compiled = compilePattern("/posts/:id");

    expect(matchPattern(compiled, "/posts/7")?.params).toEqual({ id: "7" });
  });

  /** A segment stops at the separator, or `:id` would swallow the rest of the path. */
  it("stops a segment at the separator", () => {
    const compiled = compilePattern("/posts/:id");

    expect(compiled.regexp.test("/posts/7/comments")).toBe(false);
  });

  it("makes an optional group optional", () => {
    const compiled = compilePattern("/posts/:id(.:format)");

    expect(compiled.regexp.test("/posts/7")).toBe(true);
    expect(matchPattern(compiled, "/posts/7.json")?.params).toEqual({ id: "7", format: "json" });
  });

  /** An unmatched group is not an empty value — leaving the key out lets a default fill it. */
  it("leaves an unmatched optional name out", () => {
    const compiled = compilePattern("/posts/:id(.:format)");

    expect(Object.keys(matchPattern(compiled, "/posts/7")?.params ?? {})).toEqual(["id"]);
  });

  it("lets a glob take slashes", () => {
    const compiled = compilePattern("/files/*path", {}, { formatted: false });

    expect(matchPattern(compiled, "/files/a/b/c")?.params).toEqual({ path: "a/b/c" });
  });

  /**
   * One node per branch, the same as Rails: `a|b` alternates the two literals
   * rather than everything either side of the bar.
   */
  it("matches an alternation either way", () => {
    const compiled = compilePattern("a|b");

    expect(compiled.regexp.test("a")).toBe(true);
    expect(compiled.regexp.test("b")).toBe(true);
    expect(compiled.regexp.test("c")).toBe(false);
  });

  it("applies a declared constraint", () => {
    const compiled = compilePattern("/posts/:id", { id: /\d+/ });

    expect(compiled.regexp.test("/posts/7")).toBe(true);
    expect(compiled.regexp.test("/posts/abc")).toBe(false);
  });

  it("does not match at all when nothing matches", () => {
    expect(matchPattern(compilePattern("/posts"), "/other")).toBeNull();
  });

  it("separates required names from optional ones", () => {
    const compiled = compilePattern("/posts/:id(.:format)");

    expect(requiredNames(compiled)).toEqual(["id"]);
    expect(compiled.optionalNames).toEqual(["format"]);
  });

  it("hands back the same regexp object for the same source", () => {
    expect(dedupRegexp("^/a$")).toBe(dedupRegexp("^/a$"));
  });

  it("says what a bare symbol matches", () => {
    expect(DEFAULT_SEGMENT.test("abc")).toBe(true);
    expect(DEFAULT_SEGMENT.test("/")).toBe(false);
  });
});

describe("checking constraints", () => {
  /**
   * An unanchored `\d+` says "contains a digit", so a constraint meant to
   * accept only numeric ids accepts `12abc` — and it reaches the action.
   */
  it("anchors each declared constraint", () => {
    const checks = requirementsForMissingKeysCheck({ id: /\d+/ });

    expect(checks["id"]?.test("12")).toBe(true);
    expect(checks["id"]?.test("12abc")).toBe(false);
  });

  it("leaves an already-anchored one alone", () => {
    expect(requirementsForMissingKeysCheck({ id: /^\d+$/ })["id"]?.test("12")).toBe(true);
  });

  it("says a plain pattern can be chunked", () => {
    expect(requirementsAnchored(buildAst(parsePattern("/posts/:id")))).toBe(true);
  });

  /** `/:idx` has no separator saying where the parameter stops. */
  it("says one cannot when a literal touches a symbol", () => {
    expect(requirementsAnchored(buildAst(parsePattern("/pre:id")))).toBe(false);
  });
});

describe("generating a path back", () => {
  it("fills a segment", () => {
    expect(buildFormatter(parsePattern("/posts/:id")).evaluate({ id: 7 })).toBe("/posts/7");
  });

  it("keeps the literals", () => {
    expect(buildFormatter(parsePattern("/a/b")).evaluate({})).toBe("/a/b");
  });

  /** How `(.:format)` disappears when no format was asked for. */
  it("drops an optional part with no value", () => {
    expect(buildFormatter(parsePattern("/posts/:id(.:format)")).evaluate({ id: 7 })).toBe(
      "/posts/7",
    );
  });

  it("keeps it when there is one", () => {
    expect(
      buildFormatter(parsePattern("/posts/:id(.:format)")).evaluate({ id: 7, format: "json" }),
    ).toBe("/posts/7.json");
  });

  /**
   * A slash inside a segment value would become an extra path segment, so a
   * record whose slug contains one generates a URL that routes elsewhere.
   */
  it("escapes a slash inside a segment", () => {
    expect(buildFormatter(parsePattern("/posts/:slug")).evaluate({ slug: "a/b" })).toBe(
      "/posts/a%2Fb",
    );
  });

  /** A glob is the case where slashes are part of the value. */
  it("keeps slashes inside a glob", () => {
    expect(buildFormatter(parsePattern("/files/*path")).evaluate({ path: "a/b" })).toBe(
      "/files/a/b",
    );
  });

  it("escapes other characters in a segment", () => {
    expect(requiredSegment("x").escape("a b")).toBe("a%20b");
    expect(requiredPath("x").escape("a b")).toBe("a%20b");
  });

  it("collapses to nothing when a required value is missing", () => {
    expect(new Format([requiredSegment("id")]).evaluate({})).toBe("");
  });

  it("takes the first branch of an alternation", () => {
    expect(buildFormatter(parsePattern("a|b")).evaluate({})).toBe("a");
  });
});
