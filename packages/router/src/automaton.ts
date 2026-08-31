/**
 * Matching a path against every route at once, ported from
 * `ActionDispatch::Journey::GTG` — the follow-position construction, the
 * transition table and the simulator that walks it.
 *
 * `pattern.ts` compiles one route to one regexp, which a router then runs
 * against the path once per route. That is linear in the size of the routes
 * file, on every request, and a large application has a few thousand routes —
 * so the first request to `/` runs a few thousand regexps to find the one that
 * matches on line four.
 *
 * This is the other way round: the patterns are compiled *together* into one
 * automaton, and matching walks the path once. The cost stops depending on how
 * many routes there are. That is the entire reason Rails does this rather than
 * looping, and it is why the construction is worth the code — it happens once
 * at boot and every request afterwards is cheaper for it.
 *
 * The construction is Aho's: `firstpos`, `lastpos` and `followpos` over the
 * parse tree, which turns a regular expression into a deterministic automaton
 * without going through an NFA. The subtlety is `nullable` — whether a node can
 * match nothing — because that is what decides whether an optional group's
 * successors belong in the set. Get it wrong and `/posts(.:format)` either
 * stops matching `/posts` or starts matching things that are not routes, and
 * both are silent: the router simply answers differently.
 */

import { type PatternNode, DEFAULT_SEGMENT, childrenOf, eachNode, isTerminal } from "./pattern.js";

/**
 * The node marking "the path ends here". Rails' `DUMMY_END_NODE`.
 *
 * It must not be nullable. Rails gives its dummy a value precisely so the
 * terminal case reports it non-nullable — a nullable end marker makes
 * `lastpos` of every concatenation empty, and then nothing follows anything
 * and the automaton has no transitions at all.
 */
export const END_NODE: PatternNode = { type: "LITERAL", left: "<end>" };

/**
 * Whether a node can match the empty string. Rails' `nullable?`.
 *
 * The load-bearing case is `STAR`: a wildcard is *not* nullable by default,
 * because `*path` must match something — but a constraint can make it so, and
 * assuming either way without checking the constraint is how an optional
 * trailing segment stops working.
 */
export function nullable(node: PatternNode): boolean {
  switch (node.type) {
    case "GROUP":
      return true;
    case "STAR":
      return node.regexp ? new RegExp(`^(?:${node.regexp.source})$`).test("") : false;
    case "OR":
      return (node.children ?? []).some(nullable);
    case "CAT":
      return nullable(node.left as PatternNode) && nullable(node.right as PatternNode);
    default:
      // A terminal is nullable only when it carries nothing to match.
      return isTerminal(node) ? node.left === undefined || node.left === "" : false;
  }
}

/** The nodes a subtree can start with. Rails' `firstpos`. */
export function firstpos(node: PatternNode): PatternNode[] {
  switch (node.type) {
    case "STAR":
    case "GROUP":
      return firstpos(node.left as PatternNode);
    case "CAT":
      return nullable(node.left as PatternNode)
        ? unique([...firstpos(node.left as PatternNode), ...firstpos(node.right as PatternNode)])
        : firstpos(node.left as PatternNode);
    case "OR":
      return unique((node.children ?? []).flatMap(firstpos));
    default:
      return nullable(node) ? [] : [node];
  }
}

/** The nodes a subtree can end with. Rails' `lastpos`. */
export function lastpos(node: PatternNode): PatternNode[] {
  switch (node.type) {
    case "STAR":
    case "GROUP":
      return lastpos(node.left as PatternNode);
    case "OR":
      return unique((node.children ?? []).flatMap(lastpos));
    case "CAT":
      return nullable(node.right as PatternNode)
        ? unique([...lastpos(node.left as PatternNode), ...lastpos(node.right as PatternNode)])
        : lastpos(node.right as PatternNode);
    default:
      return nullable(node) ? [] : [node];
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * What may follow each node. Rails' `build_followpos`.
 *
 * Identity-keyed, not value-keyed: two `SLASH` nodes in one pattern are
 * different positions with different successors, and a map that treated them
 * as the same key would merge their futures and match paths neither route
 * describes.
 */
export function followpos(tree: PatternNode): Map<PatternNode, PatternNode[]> {
  const table = new Map<PatternNode, PatternNode[]>();

  for (const node of eachNode(tree)) {
    if (node.type !== "CAT") continue;

    for (const last of lastpos(node.left as PatternNode)) {
      table.set(last, unique([...(table.get(last) ?? []), ...firstpos(node.right as PatternNode)]));
    }
  }

  return table;
}

/** What a node matches: fixed text, or a constraint. */
export type Edge = string | RegExp;

export function edgeOf(node: PatternNode): Edge {
  if (node.type === "SYMBOL") return node.regexp ?? DEFAULT_SEGMENT;
  if (node.type === "STAR") return node.regexp ?? /.+/;

  return String(node.left ?? "");
}

function edgeKey(edge: Edge): string {
  return typeof edge === "string" ? `s:${edge}` : `r:${edge.source}`;
}

/**
 * The automaton. Rails' `GTG::TransitionTable`.
 *
 * States are numbers and transitions are keyed by what they consume. Accepting
 * states carry memos — whatever the caller hung off the pattern's terminals,
 * which for a router is the route — because the point of matching is finding
 * out *which* route matched, not merely that one did.
 */
export class TransitionTable {
  readonly #transitions = new Map<number, Map<string, { to: number; edge: Edge }>>();
  readonly #accepting = new Set<number>();
  readonly #memos = new Map<number, unknown[]>();

  set(from: number, to: number, edge: Edge): void {
    const row = this.#transitions.get(from) ?? new Map();
    row.set(edgeKey(edge), { to, edge });
    this.#transitions.set(from, row);
  }

  /** Rails' `add_accepting`. */
  addAccepting(state: number): void {
    this.#accepting.add(state);
  }

  /** Rails' `accepting?`. */
  accepting(state: number): boolean {
    return this.#accepting.has(state);
  }

  /** Rails' `accepting_states`. */
  acceptingStates(): number[] {
    return [...this.#accepting].sort((left, right) => left - right);
  }

  /** Rails' `add_memo`. */
  addMemo(state: number, memo: unknown): void {
    if (memo === undefined) return;

    const held = this.#memos.get(state) ?? [];

    if (!held.includes(memo)) held.push(memo);

    this.#memos.set(state, held);
  }

  /** Rails' `memo`. */
  memos(state: number): unknown[] {
    return this.#memos.get(state) ?? [];
  }

  /** Rails' `transitions`. */
  transitions(): { from: number; to: number; edge: Edge }[] {
    const found: { from: number; to: number; edge: Edge }[] = [];

    for (const [from, row] of this.#transitions) {
      for (const { to, edge } of row.values()) found.push({ from, to, edge });
    }

    return found;
  }

  /**
   * Every state one token can move to. Rails' `move`.
   *
   * A *set* of states, not one: two routes can agree on a prefix and disagree
   * later, and collapsing to a single state at the first fork is how the
   * second of two similar routes becomes unreachable.
   */
  move(states: readonly number[], token: string): number[] {
    const next: number[] = [];

    for (const state of states) {
      for (const { to, edge } of this.#transitions.get(state)?.values() ?? []) {
        if (typeof edge === "string" ? edge === token : anchored(edge).test(token)) {
          if (!next.includes(to)) next.push(to);
        }
      }
    }

    return next;
  }

  /** The automaton as Graphviz source. Rails' `to_svg`/`visualizer`. */
  toDot(title = "routes"): string {
    const lines = [`digraph ${JSON.stringify(title)} {`, "  rankdir=LR;"];

    for (const state of this.acceptingStates()) lines.push(`  ${state} [shape=doublecircle];`);

    for (const { from, to, edge } of this.transitions()) {
      const label = typeof edge === "string" ? edge : edge.source;

      lines.push(`  ${from} -> ${to} [label=${JSON.stringify(label)}];`);
    }

    lines.push("}");

    return lines.join("\n");
  }

  get size(): number {
    return this.#transitions.size;
  }
}

const anchoredCache = new Map<string, RegExp>();

function anchored(constraint: RegExp): RegExp {
  const source = constraint.source.replace(/^\^/, "").replace(/\$$/, "");
  const held = anchoredCache.get(source);

  if (held) return held;

  // Anchored, or a constraint means "contains" and every token matches every
  // route whose segment constraint appears anywhere inside it.
  const built = new RegExp(`^(?:${source})$`);
  anchoredCache.set(source, built);

  return built;
}

/**
 * Builds the automaton from one or more parse trees. Rails' `GTG::Builder`.
 *
 * Every pattern is concatenated with an end marker first, which is what makes
 * "the path finished here" a position the construction can reason about rather
 * than a special case in the walk.
 */
export function buildTransitionTable(trees: readonly PatternNode[]): TransitionTable {
  const table = new TransitionTable();
  const combined: PatternNode[] = trees.map((tree) => ({
    type: "CAT",
    left: tree,
    right: END_NODE,
  }));

  const follow = new Map<PatternNode, PatternNode[]>();

  for (const tree of combined) {
    for (const [node, next] of followpos(tree)) {
      follow.set(node, unique([...(follow.get(node) ?? []), ...next]));
    }
  }

  const ids = new Map<string, number>();
  let nextState = 0;
  const freshState = () => nextState++;
  const idOf = (nodes: readonly PatternNode[]): number => {
    const key = nodes.map((node) => nodeIds.get(node)).join(",");
    const held = ids.get(key);

    if (held !== undefined) return held;

    const built = freshState();
    ids.set(key, built);

    return built;
  };

  const nodeIds = new Map<PatternNode, number>();

  for (const tree of combined) {
    for (const node of eachNode(tree)) {
      if (!nodeIds.has(node)) nodeIds.set(node, nodeIds.size);
    }
  }

  const start = unique(combined.flatMap(firstpos));
  const pending: PatternNode[][] = [start];
  const seen = new Set<string>();

  // Register the start state first so it is always 0.
  idOf(start);

  while (pending.length > 0) {
    const current = pending.shift() as PatternNode[];
    const currentKey = current.map((node) => nodeIds.get(node)).join(",");

    if (seen.has(currentKey)) continue;

    seen.add(currentKey);

    const grouped = new Map<string, { edge: Edge; nodes: PatternNode[] }>();

    for (const node of current) {
      if (node === END_NODE) continue;

      const edge = edgeOf(node);
      const key = edgeKey(edge);
      const group = grouped.get(key) ?? { edge, nodes: [] };
      group.nodes.push(node);
      grouped.set(key, group);
    }

    for (const { edge, nodes } of grouped.values()) {
      const target = unique(nodes.flatMap((node) => follow.get(node) ?? []));

      if (target.length === 0) continue;

      const from = idOf(current);

      // The end marker is one shared node, so a target consisting only of it
      // is the *same set* for every route that finishes here. Reusing a state
      // id for it merges every terminal state in the table, and then a match
      // for one route answers with the memos of all of them. Rails allocates a
      // fresh state for exactly this reason; nothing follows it, so it never
      // needs to be found again.
      if (target.every((node) => node === END_NODE)) {
        const to = freshState();
        table.set(from, to, edge);
        table.addAccepting(to);

        for (const node of nodes) table.addMemo(to, node.memo);

        continue;
      }

      const to = idOf(target);
      table.set(from, to, edge);

      if (target.includes(END_NODE)) {
        table.addAccepting(to);

        // Only the nodes that can actually *end* here contribute a route. A
        // state reached by two patterns where only one of them may stop there
        // must not answer with both.
        for (const node of nodes) {
          if ((follow.get(node) ?? []).includes(END_NODE)) table.addMemo(to, node.memo);
        }
      }

      pending.push(target);
    }
  }

  return table;
}

/** Where the walk starts. */
export const INITIAL_STATE = 0;

/** Bytes that end a token, so a path splits into segments. Rails' `STATIC_TOKENS`. */
const BOUNDARIES = new Set([".", "/", "?"]);

/**
 * Splits a path the way the automaton consumes it.
 *
 * Separators are tokens of their own rather than being stripped, because
 * `/a.b` and `/a/b` are different routes and a split that dropped them could
 * not tell the two apart.
 */
export function tokenizePath(path: string): string[] {
  const tokens: string[] = [];
  let buffer = "";

  for (const character of path) {
    if (BOUNDARIES.has(character)) {
      if (buffer) tokens.push(buffer);

      tokens.push(character);
      buffer = "";
      continue;
    }

    buffer += character;
  }

  if (buffer) tokens.push(buffer);

  return tokens;
}

/**
 * Walks a path through the automaton. Rails' `GTG::Simulator`.
 *
 * Returns the memos of every accepting state reached — every route that
 * matches, in the order they were declared, so the caller applies its own
 * precedence rather than this guessing one.
 */
export class Simulator {
  constructor(readonly table: TransitionTable) {}

  /** Rails' `memos`. */
  memos(path: string): unknown[] {
    let states = [INITIAL_STATE];

    for (const token of tokenizePath(path)) {
      states = this.table.move(states, token);

      // Nothing left to be: no route can match this path, and continuing would
      // walk the rest of it for an answer that cannot change.
      if (states.length === 0) return [];
    }

    return unique(
      states
        .filter((state) => this.table.accepting(state))
        .flatMap((state) => this.table.memos(state)),
    );
  }

  matches(path: string): boolean {
    return this.memos(path).length > 0;
  }
}

/** Rails' `Journey::Router#find_routes`, in the shape a caller wants. */
export function simulator(trees: readonly PatternNode[]): Simulator {
  return new Simulator(buildTransitionTable(trees));
}

/** Every node in a tree, in construction order — useful when debugging a table. */
export function positions(tree: PatternNode): PatternNode[] {
  return eachNode(tree).filter((node) => childrenOf(node).length === 0);
}
