/**
 * The pattern tree's traversals, ported from
 * `actionpack/test/journey/nodes/symbol_test.rb` and the visitor cases in
 * `actionpack/test/journey/path/pattern_test.rb`.
 *
 * The property under test is the one the dispatch layer exists for: a node type
 * a traversal has not been taught about is an error, not output that is almost
 * right.
 */

import { describe, expect, it } from "bun:test";
import {
  type PatternNode,
  UnhandledNodeType,
  accept,
  parsePattern,
  pathVisitor,
  regexpVisitor,
  toPath,
  toRegexpSource,
} from "../src/pattern.js";

const literal = (value: string): PatternNode => ({ type: "LITERAL", left: value });

describe("dispatching a node", () => {
  it("calls the method for its type", () => {
    expect(accept<string>(literal("posts"), { visit_LITERAL: (node) => String(node.left) })).toBe(
      "posts",
    );
  });

  /**
   * The whole point of the layer: a traversal that quietly skipped a type would
   * produce a regexp missing an optional group or a path missing a separator,
   * which is harder to notice than a crash.
   */
  it("refuses a type it has no method for", () => {
    expect(() => accept<string>(literal("posts"), {})).toThrow(UnhandledNodeType);
  });

  it("names the type and the visitor it was missing from", () => {
    expect(() => accept<string>(literal("posts"), {}, "The path visitor")).toThrow(
      "The path visitor has no visit_LITERAL",
    );
  });

  it("dispatches the children too", () => {
    const tree = parsePattern("/posts");

    expect(() =>
      accept<string>(tree, { visit_CAT: (node, visit) => visit(node.left as PatternNode) }),
    ).toThrow(UnhandledNodeType);
  });
});

describe("the path a tree came from", () => {
  it("is the pattern it was parsed from", () => {
    for (const pattern of ["/posts", "/posts/:id", "/posts/:id(.:format)", "/files/*path"]) {
      expect(toPath(parsePattern(pattern))).toBe(pattern);
    }
  });

  /** Written as a visitor, so every node type is named rather than defaulted. */
  it("handles every node type it can meet", () => {
    for (const type of ["CAT", "OR", "GROUP", "STAR", "SYMBOL", "SLASH", "DOT", "LITERAL"]) {
      expect(pathVisitor[`visit_${type}` as keyof typeof pathVisitor]).toBeDefined();
    }
  });

  it("is refused for a node type nobody taught it", () => {
    expect(() => toPath({ type: "MYSTERY" as never, left: "x" })).toThrow("The path visitor");
  });
});

describe("the regexp a tree compiles to", () => {
  /**
   * An unescaped `.` matches any character, so a route for `/robots.txt` would
   * also serve `/robotsXtxt` — and a literal containing `+` or `(` becomes a
   * quantifier or a capture group and quietly changes what the route accepts.
   */
  it("escapes a literal", () => {
    expect(toRegexpSource(literal("a+b"))).toBe("a\\+b");
    expect(toRegexpSource({ type: "DOT", left: "." })).toBe("\\.");
  });

  it("captures a segment, stopping at a separator", () => {
    expect(toRegexpSource(parsePattern("/:id"))).toBe("/([^./?]+)");
  });

  /**
   * A node built by hand carries no requirement, and the default is the one the
   * parser would have given it: "anything but a separator". Falling back to
   * "anything" would let a segment swallow the `.json` an optional format group
   * was there to catch, and every such request would render HTML.
   */
  it("defaults a symbol with no requirement of its own", () => {
    expect(toRegexpSource({ type: "SYMBOL", left: ":id" })).toBe("([^./?]+)");
  });

  it("captures a glob, and only as far as it must", () => {
    expect(toRegexpSource(parsePattern("/*path"))).toBe("/(.+?)");
  });

  it("makes a group optional and non-capturing", () => {
    expect(toRegexpSource(parsePattern("/posts(/:id)"))).toBe("/posts(?:/([^./?]+))?");
  });

  it("handles every node type it can meet", () => {
    for (const type of ["CAT", "OR", "GROUP", "STAR", "SYMBOL", "SLASH", "DOT", "LITERAL"]) {
      expect(regexpVisitor[`visit_${type}` as keyof typeof regexpVisitor]).toBeDefined();
    }
  });

  it("is refused for a node type nobody taught it", () => {
    expect(() => toRegexpSource({ type: "MYSTERY" as never, left: "x" })).toThrow(
      "The regexp visitor",
    );
  });

  /**
   * The two traversals go through one dispatch, so a node type added to the
   * parser cannot be handled by one and silently defaulted by the other.
   */
  it("shares its dispatch with the path traversal", () => {
    expect(Object.keys(regexpVisitor).sort()).toEqual(Object.keys(pathVisitor).sort());
  });
});
