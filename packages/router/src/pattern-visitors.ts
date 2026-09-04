/**
 * Walking a route pattern's tree, ported from `ActionDispatch::Journey::Visitors`.
 *
 * `pattern.ts` owns the tree and the two traversals the router itself needs —
 * to a regexp, to a path. This is the dispatch layer under those: a visitor
 * with one method per node type, so a *new* traversal can be written without
 * touching the parser or the node type.
 *
 * That indirection earns its place for a reason specific to a tree with eight
 * node types and no closed set of uses. Every traversal has to handle all
 * eight, and a `switch` that quietly falls through on one produces output that
 * is *almost* right — a regexp missing an optional group, a path missing a
 * separator — which is far harder to notice than a crash. Dispatching by name
 * means an unhandled type is a missing method, and a missing method can be
 * reported by name at the moment it is reached.
 *
 * The visualizer is the reason the framework exists at all: a route pattern
 * that does not match what somebody expected is nearly impossible to reason
 * about from its source, and drawing the tree is the fastest way to see that a
 * group closed in the wrong place.
 */

import { type PatternNode, childrenOf, eachNode, toPath } from "./pattern.js";

// `accept` and its errors live in `pattern.ts`, with the node type they
// dispatch on and the traversals that use them. Re-exported here because this
// is where the reason for them is written down, and a second definition would
// let two visitors disagree about what an unhandled node type does.
export { UnhandledNodeType, accept } from "./pattern.js";
export type { VisitorMethods } from "./pattern.js";

// --- the shapes a node can have -----------------------------------------------------------

/**
 * Rails' `unary?` — a node wrapping exactly one child.
 *
 * `GROUP` and `STAR`. Worth asking because a visitor that treated one as
 * binary would read its single child as a left with no right, and produce a
 * pattern with the group's contents silently dropped.
 */
export function unary(node: PatternNode): boolean {
  return node.type === "GROUP" || node.type === "STAR";
}

/** Rails' `binary?` — a node joining two. */
export function binary(node: PatternNode): boolean {
  return node.type === "CAT" || node.type === "OR";
}

/**
 * Rails' `nary?` — a node with any number of children.
 *
 * Only a `CAT` built by folding several segments. Distinct from binary because
 * a fold produces a flat list and a parse produces a pair, and a visitor
 * assuming one shape drops everything past the second child of the other.
 */
export function nary(node: PatternNode): boolean {
  return node.children !== undefined && node.children.length > 2;
}

/** Rails' `terminal?` — a node with no children. */
export function star(node: PatternNode): boolean {
  return node.type === "STAR";
}

// --- what a pattern names -------------------------------------------------------------------

/**
 * Rails' `symbols` — every dynamic segment in the tree, in order.
 *
 * In order, because the order is what a positional helper call maps onto:
 * `post_comment_path(1, 2)` fills `:post_id` then `:id`, and a set would make
 * that depend on insertion order in a way nothing declares.
 */
export function symbols(node: PatternNode): string[] {
  // Symbols only. A glob is a STAR *wrapping* a SYMBOL, so counting both names
  // the segment twice — and a helper filling positionally would then expect an
  // extra argument for a segment that is not there.
  return eachNode(node)
    .filter((each) => each.type === "SYMBOL")
    .map((each) => nameOf(each))
    .filter((name): name is string => name !== undefined);
}

function nameOf(node: PatternNode): string | undefined {
  if (typeof node.left === "string") return node.left.replace(/^[:*]/, "");

  if (node.left !== undefined) return nameOf(node.left);

  return undefined;
}

/**
 * Rails' `valid_symbols?` — whether every dynamic segment has a usable name.
 *
 * A segment named with something that is not an identifier cannot be filled by
 * a helper — there is no keyword to pass — so the route can be declared and
 * never generated, and that only shows up when somebody tries.
 */
export function validSymbols(node: PatternNode): boolean {
  return symbols(node).every((name) => /^[A-Za-z_]\w*$/.test(name));
}

// `requiredParts` is not here: `resource-scope.ts` already answers it from the
// pattern string, and a second answer from the tree is a second thing to keep
// in step for no gain — both stop at a group, which is the only rule.

// --- drawing one ------------------------------------------------------------------------------

/**
 * Rails' `Visitors::Dot` output rendered as SVG.
 *
 * A picture because a route pattern that does not match what somebody expected
 * is nearly impossible to reason about from its source — and the usual cause,
 * a group closing in the wrong place, is immediately visible in a tree and
 * invisible in a string.
 *
 * Laid out by depth rather than by a real graph layout: the tree is small, and
 * a layout that needed a library would make the one tool for debugging routes
 * something nobody has installed.
 */
export function toSvg(node: PatternNode, { width = 720 }: { width?: number } = {}): string {
  const levels = levelsOf(node);
  const rowHeight = 64;
  const height = levels.length * rowHeight + 24;

  const lines: string[] = [];
  const positions = new Map<PatternNode, { x: number; y: number }>();

  levels.forEach((row, depth) => {
    row.forEach((each, index) => {
      positions.set(each, {
        x: ((index + 1) * width) / (row.length + 1),
        y: depth * rowHeight + 32,
      });
    });
  });

  for (const [each, position] of positions) {
    for (const child of childrenOf(each)) {
      const to = positions.get(child);

      if (to === undefined) continue;

      lines.push(
        `<line x1="${position.x}" y1="${position.y}" x2="${to.x}" y2="${to.y}" ` +
          `stroke="currentColor" stroke-opacity="0.4" />`,
      );
    }
  }

  for (const [each, position] of positions) {
    lines.push(
      `<circle cx="${position.x}" cy="${position.y}" r="6" fill="currentColor" />`,
      `<text x="${position.x}" y="${position.y - 12}" text-anchor="middle" font-size="11">` +
        `${escapeText(labelFor(each))}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}">`,
    ...lines.map((line) => `  ${line}`),
    "</svg>",
  ].join("\n");
}

function labelFor(node: PatternNode): string {
  return binary(node) ? node.type : toPath(node);
}

/**
 * Text put into markup is escaped.
 *
 * A route pattern comes from an application's own routes file, so this is not
 * an injection boundary — but a segment containing `<` would produce invalid
 * SVG that a browser refuses to render at all, which is a worse failure for a
 * debugging tool than a wrong label.
 */
function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function levelsOf(root: PatternNode): PatternNode[][] {
  const levels: PatternNode[][] = [];
  let current = [root];

  while (current.length > 0) {
    levels.push(current);
    current = current.flatMap((each) => childrenOf(each));
  }

  return levels;
}

/**
 * Rails' `Visitors::Formatter#writeln` — one line of a written traversal.
 *
 * Indented by depth, because the shape is the information: a flat list of node
 * types says which nodes exist and not how they nest, and how they nest is the
 * question anybody looking at this has.
 */
export function writeln(depth: number, text: string, into: string[]): string[] {
  into.push(`${"  ".repeat(Math.max(0, depth))}${text}`);

  return into;
}

/** Rails' `Visitors::Formatter` — the tree as indented text. */
export function visualizer(node: PatternNode): string {
  const lines: string[] = [];

  const walk = (each: PatternNode, depth: number): void => {
    writeln(depth, labelFor(each), lines);

    for (const child of childrenOf(each)) walk(child, depth + 1);
  };

  walk(node, 0);

  return lines.join("\n");
}

/**
 * Rails' `spot` — where in the original pattern a node came from.
 *
 * Found by matching the node's own text against the source rather than
 * recorded during the parse. Recording it would put a position on every node
 * for the sake of the rare error that needs one; finding it costs nothing
 * until something asks, and the only caller is an error message.
 */
export function spot(node: PatternNode, pattern: string): { offset: number; text: string } {
  const text = toPath(node);
  const offset = pattern.indexOf(text);

  return { offset: offset === -1 ? 0 : offset, text };
}
