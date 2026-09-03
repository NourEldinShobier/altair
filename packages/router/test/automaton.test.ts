/**
 * Matching a path against every route at once, ported from
 * `actionpack/test/journey/gtg/builder_test.rb`,
 * `actionpack/test/journey/gtg/transition_table_test.rb` and
 * `actionpack/test/journey/nfa/simulator_test.rb`.
 *
 * The construction fails silently when it is wrong — the router simply answers
 * differently — so most of these check that a path matches exactly the routes
 * it should and no others, rather than that the table has some shape.
 */

import { describe, expect, it } from "bun:test";
import {
  END_NODE,
  INITIAL_STATE,
  Simulator,
  TransitionTable,
  buildTransitionTable,
  edgeOf,
  firstpos,
  followpos,
  lastpos,
  nullable,
  positions,
  simulator,
  tokenizePath,
} from "../src/automaton.js";
import { addMemo, buildAst, eachNode, isStar, parsePattern } from "../src/pattern.js";

const treeFor = (pattern: string, memo?: string) => {
  const ast = buildAst(parsePattern(pattern), false);

  if (memo !== undefined) addMemo(ast, memo);

  return ast.tree;
};

const routerFor = (routes: Record<string, string>) =>
  simulator(Object.entries(routes).map(([pattern, memo]) => treeFor(pattern, memo)));

describe("whether a node can match nothing", () => {
  it("says an optional group can", () => {
    expect(nullable(parsePattern("(.:format)"))).toBe(true);
  });

  it("says a literal cannot", () => {
    expect(nullable({ type: "LITERAL", left: "posts" })).toBe(false);
  });

  it("says a symbol cannot", () => {
    expect(nullable({ type: "SYMBOL", left: ":id" })).toBe(false);
  });

  /**
   * `*path` has to match something, so a wildcard is not nullable by default.
   * Asked of the star node itself: the whole tree starts with a non-nullable
   * `/`, so asking the root would answer `false` however the star behaved.
   */
  it("says a wildcard cannot", () => {
    const star = eachNode(treeFor("/*path")).find(isStar);

    expect(star).toBeDefined();
    expect(nullable(star as never)).toBe(false);
  });

  /** But a constraint can make one so, and assuming either way is a bug. */
  it("says a wildcard with a permissive constraint can", () => {
    expect(nullable({ type: "STAR", left: { type: "SYMBOL", left: "*p" }, regexp: /.*/ })).toBe(
      true,
    );
  });

  it("says a concatenation can only when both halves can", () => {
    expect(nullable(parsePattern("(a)(b)"))).toBe(true);
    expect(nullable(parsePattern("(a)b"))).toBe(false);
  });

  it("says an alternation can when any branch can", () => {
    expect(nullable(parsePattern("(a)|b"))).toBe(true);
  });

  /**
   * A nullable end marker makes `lastpos` of every concatenation empty, and
   * then nothing follows anything and the automaton has no transitions at all.
   */
  it("says the end marker cannot", () => {
    expect(nullable(END_NODE)).toBe(false);
  });
});

describe("first and last positions", () => {
  it("finds what a pattern can start with", () => {
    expect(firstpos(treeFor("/posts"))).toHaveLength(1);
  });

  /** An optional first half means the second half can start the match too. */
  it("looks past a nullable start", () => {
    expect(firstpos(parsePattern("(a)b"))).toHaveLength(2);
  });

  it("finds what a pattern can end with", () => {
    expect(lastpos(treeFor("/posts"))).toHaveLength(1);
  });

  /** Which is how `/posts(.:format)` still ends after `posts`. */
  it("looks back past a nullable end", () => {
    expect(lastpos(parsePattern("a(b)"))).toHaveLength(2);
  });

  it("collects every branch of an alternation", () => {
    expect(firstpos(parsePattern("a|b"))).toHaveLength(2);
  });

  it("lists the leaves of a tree", () => {
    expect(positions(treeFor("/posts")).length).toBeGreaterThan(1);
  });
});

describe("what may follow what", () => {
  it("records a successor for each position", () => {
    expect(followpos(treeFor("/posts")).size).toBeGreaterThan(0);
  });

  /**
   * Identity-keyed. Two `/` nodes in one pattern are different positions with
   * different successors, and merging them would match paths neither route
   * describes.
   */
  it("keeps two identical-looking nodes apart", () => {
    const table = followpos(treeFor("/a/b"));
    const slashes = [...table.keys()].filter((node) => node.left === "/");

    expect(slashes.length).toBeGreaterThan(1);
    expect(table.get(slashes[0] as never)).not.toEqual(table.get(slashes[1] as never));
  });
});

describe("splitting a path", () => {
  it("keeps the separators as tokens", () => {
    expect(tokenizePath("/posts/7")).toEqual(["/", "posts", "/", "7"]);
  });

  /** `/a.b` and `/a/b` are different routes; a split that dropped them could not tell. */
  it("keeps a dot apart from a slash", () => {
    expect(tokenizePath("/a.b")).toEqual(["/", "a", ".", "b"]);
  });

  it("splits nothing into nothing", () => {
    expect(tokenizePath("")).toEqual([]);
  });
});

describe("what a node consumes", () => {
  it("is the text of a literal", () => {
    expect(edgeOf({ type: "LITERAL", left: "posts" })).toBe("posts");
  });

  it("is the constraint of a symbol", () => {
    expect(edgeOf({ type: "SYMBOL", left: ":id", regexp: /\d+/ })).toEqual(/\d+/);
  });
});

describe("the table", () => {
  it("records a transition", () => {
    const table = new TransitionTable();
    table.set(0, 1, "posts");

    expect(table.transitions()).toEqual([{ from: 0, to: 1, edge: "posts" }]);
  });

  it("moves along it", () => {
    const table = new TransitionTable();
    table.set(0, 1, "posts");

    expect(table.move([0], "posts")).toEqual([1]);
    expect(table.move([0], "other")).toEqual([]);
  });

  it("moves along a constraint", () => {
    const table = new TransitionTable();
    table.set(0, 1, /\d+/);

    expect(table.move([0], "7")).toEqual([1]);
    expect(table.move([0], "abc")).toEqual([]);
  });

  /**
   * Anchored, or a constraint means "contains" and `\d+` would accept `12abc`
   * — which is how a route constrained to numeric ids starts taking anything
   * with a digit in it.
   */
  it("anchors a constraint", () => {
    const table = new TransitionTable();
    table.set(0, 1, /\d+/);

    expect(table.move([0], "12abc")).toEqual([]);
  });

  /**
   * A set of states, not one: two routes can agree on a prefix and disagree
   * later, and collapsing at the first fork makes the second unreachable.
   */
  it("moves to every state a token allows", () => {
    const table = new TransitionTable();
    table.set(0, 1, "a");
    table.set(0, 2, /\w+/);

    expect(table.move([0], "a").sort((a, b) => a - b)).toEqual([1, 2]);
  });

  /**
   * And moves from every state it is currently in, not just the first. Two
   * routes that agreed on a prefix leave the walk in two states at once, and
   * only considering one of them makes the other route unreachable.
   */
  it("moves from every state it is in", () => {
    const table = new TransitionTable();
    table.set(0, 2, "b");
    table.set(1, 3, "b");

    expect(table.move([0, 1], "b").sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("marks accepting states", () => {
    const table = new TransitionTable();
    table.addAccepting(3);

    expect(table.accepting(3)).toBe(true);
    expect(table.accepting(4)).toBe(false);
    expect(table.acceptingStates()).toEqual([3]);
  });

  it("hangs memos off them", () => {
    const table = new TransitionTable();
    table.addMemo(3, "posts#index");
    table.addMemo(3, "posts#index");

    expect(table.memos(3)).toEqual(["posts#index"]);
  });

  it("ignores a missing memo", () => {
    const table = new TransitionTable();
    table.addMemo(3, undefined);

    expect(table.memos(3)).toEqual([]);
  });

  it("draws itself", () => {
    const table = buildTransitionTable([treeFor("/posts", "posts#index")]);

    expect(table.toDot()).toContain("digraph");
    expect(table.toDot()).toContain("doublecircle");
  });
});

describe("matching", () => {
  const routes = routerFor({
    "/posts": "index",
    "/posts/new": "new",
    "/posts/:id": "show",
    "/comments/:id": "comment",
  });

  it("finds a static route", () => {
    expect(routes.memos("/posts")).toEqual(["index"]);
  });

  it("finds a dynamic one", () => {
    expect(routes.memos("/posts/7")).toEqual(["show"]);
  });

  /**
   * The case a single collapsed state gets wrong: `/posts/new` matches the
   * literal route and the dynamic one, and both have to come back so the
   * caller can apply declaration order.
   */
  it("finds every route a path matches", () => {
    expect(routes.memos("/posts/new").sort()).toEqual(["new", "show"]);
  });

  it("keeps two prefixes apart", () => {
    expect(routes.memos("/comments/7")).toEqual(["comment"]);
  });

  it("finds nothing for a path nothing describes", () => {
    expect(routes.memos("/other")).toEqual([]);
    expect(routes.matches("/other")).toBe(false);
  });

  it("does not match a prefix of a route", () => {
    expect(routes.memos("/post")).toEqual([]);
  });

  /** A route must not match something longer than itself. */
  it("does not match past the end", () => {
    expect(routes.memos("/posts/7/comments")).toEqual([]);
  });

  it("matches an optional group both ways", () => {
    const withFormat = routerFor({ "/posts/:id(.:format)": "show" });

    expect(withFormat.memos("/posts/7")).toEqual(["show"]);
    expect(withFormat.memos("/posts/7.json")).toEqual(["show"]);
  });

  it("honours a constraint", () => {
    const numeric = simulator([
      (() => {
        const ast = buildAst(parsePattern("/posts/:id"), false);
        for (const node of [ast.tree]) void node;
        const symbol = ast.terminals.find((each) => each.type === "SYMBOL");

        if (symbol) symbol.regexp = /\d+/;

        addMemo(ast, "show");

        return ast.tree;
      })(),
    ]);

    expect(numeric.memos("/posts/7")).toEqual(["show"]);
    expect(numeric.memos("/posts/abc")).toEqual([]);
  });

  it("matches a glob across separators", () => {
    const glob = routerFor({ "/files/*path": "files" });

    expect(glob.memos("/files/a")).toEqual(["files"]);
  });

  it("starts where it says it does", () => {
    expect(INITIAL_STATE).toBe(0);
  });

  it("can be built from a table directly", () => {
    const table = buildTransitionTable([treeFor("/posts", "index")]);

    expect(new Simulator(table).memos("/posts")).toEqual(["index"]);
  });

  it("handles an empty routing table", () => {
    expect(simulator([]).memos("/posts")).toEqual([]);
  });
});
