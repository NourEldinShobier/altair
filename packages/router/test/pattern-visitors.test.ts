/**
 * Walking a route pattern's tree, ported from
 * `actionpack/test/journey/nodes/symbol_test.rb`,
 * `actionpack/test/journey/path/pattern_test.rb` and the visitor cases in
 * `actionpack/test/journey/route_test.rb`.
 *
 * The dispatch layer exists because a traversal that silently skips a node
 * type produces output that is *almost* right, so the cases are mostly about
 * what a missing case would do.
 */

import { describe, expect, it } from "bun:test";
import { parsePattern } from "../src/pattern.js";
import {
  UnhandledNodeType,
  accept,
  binary,
  nary,
  spot,
  star,
  symbols,
  toSvg,
  unary,
  validSymbols,
  visualizer,
  writeln,
} from "../src/pattern-visitors.js";

const tree = (pattern: string) => parsePattern(pattern);

describe("dispatching to a visitor", () => {
  it("calls the method for the node's type", () => {
    const seen: string[] = [];

    accept<void>(tree("/posts"), {
      visit_CAT: (node, visit) => {
        seen.push("CAT");
        for (const child of [node.left, node.right]) {
          if (child !== undefined && typeof child !== "string") visit(child);
        }
      },
      visit_SLASH: () => void seen.push("SLASH"),
      visit_LITERAL: () => void seen.push("LITERAL"),
    });

    expect(seen).toContain("SLASH");
    expect(seen).toContain("LITERAL");
  });

  /**
   * A default is what turns a missing case into output that is nearly correct
   * — a regexp missing an optional group, a path missing a separator.
   */
  it("refuses a type it has no method for", () => {
    expect(() =>
      accept<void>(tree("/posts/:id"), { visit_CAT: (node, visit) => visit(node.right!) }, "Test"),
    ).toThrow(UnhandledNodeType);
  });

  it("names the type and the visitor", () => {
    let message = "";

    try {
      accept<void>(tree("/posts"), {}, "PathBuilder");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("PathBuilder");
    expect(message).toContain("visit_");
  });
});

describe("the shape of a node", () => {
  /**
   * A visitor treating a group as binary reads its single child as a left with
   * no right, and produces a pattern with the group's contents dropped.
   */
  it("tells a wrapper from a join", () => {
    const optional = tree("/posts(.:format)");
    const group = optional.right ?? optional;

    expect(binary(tree("/posts"))).toBe(true);
    expect(binary({ type: "GROUP" })).toBe(false);
    expect(binary({ type: "STAR" })).toBe(false);
    expect(unary({ type: "GROUP" })).toBe(true);
    expect(unary({ type: "STAR" })).toBe(true);
    expect(unary({ type: "CAT" })).toBe(false);
    expect(group).toBeDefined();
  });

  /**
   * A fold produces a flat list and a parse produces a pair, and a visitor
   * assuming one shape drops everything past the second child of the other.
   */
  it("tells a folded node from a paired one", () => {
    expect(
      nary({ type: "CAT", children: [{ type: "SLASH" }, { type: "SLASH" }, { type: "SLASH" }] }),
    ).toBe(true);
    expect(nary({ type: "CAT", children: [{ type: "SLASH" }, { type: "SLASH" }] })).toBe(false);
    expect(nary({ type: "CAT" })).toBe(false);
  });

  it("recognises a glob", () => {
    expect(star({ type: "STAR" })).toBe(true);
    expect(star({ type: "SYMBOL" })).toBe(false);
  });
});

describe("what a pattern names", () => {
  /**
   * The order is what a positional helper call maps onto:
   * `post_comment_path(1, 2)` fills `:post_id` then `:id`.
   */
  it("lists the dynamic segments in order", () => {
    expect(symbols(tree("/posts/:post_id/comments/:id"))).toEqual(["post_id", "id"]);
  });

  it("lists a glob too", () => {
    expect(symbols(tree("/files/*path"))).toEqual(["path"]);
  });

  it("lists nothing for a static pattern", () => {
    expect(symbols(tree("/posts"))).toEqual([]);
  });

  /**
   * A segment named with something that is not an identifier cannot be filled
   * by a helper — there is no keyword to pass — so the route can be declared
   * and never generated.
   */
  it("says whether every name is usable", () => {
    expect(validSymbols(tree("/posts/:id"))).toBe(true);
    expect(validSymbols({ type: "SYMBOL", left: ":9lives" })).toBe(false);
  });
});

describe("drawing a pattern", () => {
  it("renders an SVG with a node per tree node", () => {
    const svg = toSvg(tree("/posts/:id"));

    expect(svg).toStartWith("<svg");
    expect(svg).toContain("viewBox");
    expect(svg.match(/<circle/g)?.length).toBeGreaterThan(2);
  });

  it("draws an edge for every parent-child pair", () => {
    expect(toSvg(tree("/posts/:id")).match(/<line/g)?.length).toBeGreaterThan(0);
  });

  /**
   * A segment containing `<` would produce invalid SVG a browser refuses to
   * render at all, which is a worse failure for a debugging tool than a wrong
   * label.
   */
  it("escapes a label that would break the markup", () => {
    const svg = toSvg({ type: "LITERAL", left: "<script>" });

    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });

  /**
   * The shape is the information: a flat list says which nodes exist and not
   * how they nest, and how they nest is the question anybody looking at this
   * has.
   */
  it("indents the text form by depth", () => {
    const text = visualizer(tree("/posts/:id"));
    const indented = text.split("\n").filter((line) => line.startsWith("  "));

    expect(indented.length).toBeGreaterThan(0);
    expect(text.split("\n")[0]).not.toStartWith(" ");
  });

  it("writes one line at a depth", () => {
    expect(writeln(2, "SYMBOL", [])).toEqual(["    SYMBOL"]);
    expect(writeln(-1, "CAT", [])).toEqual(["CAT"]);
  });
});

describe("where a node came from", () => {
  /**
   * Found rather than recorded during the parse: recording it would put a
   * position on every node for the sake of the rare error that needs one.
   */
  it("finds the offset of a node's text", () => {
    const found = spot({ type: "LITERAL", left: "comments" }, "/posts/:id/comments");

    expect(found.text).toBe("comments");
    expect(found.offset).toBe(11);
  });

  it("reports the start for text it cannot find", () => {
    expect(spot({ type: "LITERAL", left: "absent" }, "/posts").offset).toBe(0);
  });
});
