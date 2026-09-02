/**
 * The relational algebra a relation compiles into, ported from Arel's node
 * types and `ActiveRecord::Relation::WhereClause`.
 *
 * `relation.ts` builds a query from clauses and `predicate_builder.ts` turns a
 * hash into conditions. Both of those produce SQL text. This is the layer Rails
 * keeps *underneath* them — conditions as a tree of nodes rather than as a
 * string — and the difference is not stylistic. Three things are possible with
 * a tree and not with text:
 *
 * - **A condition can be removed.** `Post.where(draft: true).unscope(:where)`
 *   has to find and drop one condition and keep the rest. Over text that means
 *   parsing SQL an application generated, and the parse has to be exactly right
 *   or it removes the wrong thing silently.
 * - **Two relations can be merged.** `Post.where(a: 1).merge(Post.where(a: 2))`
 *   has to notice that both constrain `a` and keep only the second. Over text
 *   the two conditions are both appended, and the query matches nothing.
 * - **A condition can be inverted.** `where.not` on a compound condition is not
 *   the same as negating each part — `NOT (a AND b)` is `NOT a OR NOT b` — and
 *   getting that wrong produces a query that runs and returns the wrong rows.
 *
 * Each of those failures is silent. That is what pays for the extra layer.
 */

// --- what a node can be --------------------------------------------------------------------

export interface ArelTable {
  name: string;
  alias?: string;
}

export interface ArelAttribute {
  table: ArelTable;
  name: string;
}

export type ArelOperator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "IN"
  | "NOT IN"
  | "IS NULL"
  | "IS NOT NULL"
  | "BETWEEN"
  | "LIKE";

export type ArelNode =
  | { kind: "comparison"; attribute: ArelAttribute; operator: ArelOperator; value: unknown }
  | { kind: "and"; children: ArelNode[] }
  | { kind: "or"; children: ArelNode[] }
  | { kind: "not"; child: ArelNode }
  | { kind: "sql"; sql: string; binds: unknown[] };

/** Rails' `arel_table`. */
export function arelTable(name: string, alias?: string): ArelTable {
  return alias === undefined ? { name } : { name, alias };
}

/**
 * Rails' `arel_attribute` — one column of one table.
 *
 * Carries the table, not just the name. A bare column name in a query joining
 * two tables that both have `id` is ambiguous, and the database says so — but
 * only sometimes, because a name that is ambiguous in one join is fine in
 * another, so the failure appears when somebody adds a join months later.
 */
export function arel(table: ArelTable, name: string): ArelAttribute {
  return { table, name };
}

/** Rails' `arel_columns` — several at once. */
export function arelColumns(table: ArelTable, names: readonly string[]): ArelAttribute[] {
  return names.map((name) => arel(table, name));
}

/**
 * Rails' `resolve_arel_attribute` — a string like `posts.title` into a node.
 *
 * An unqualified name takes the given table. Guessing a table from the column
 * would pick whichever was registered first, and that is load order.
 */
export function resolveArelAttribute(reference: string, defaultTable: ArelTable): ArelAttribute {
  const dot = reference.lastIndexOf(".");

  if (dot === -1) return arel(defaultTable, reference);

  return arel(arelTable(reference.slice(0, dot)), reference.slice(dot + 1));
}

// --- building a condition -------------------------------------------------------------------

/**
 * Rails' `predicate_for` — one attribute and value into a node.
 *
 * The operator comes from the *value's shape*, which is what makes
 * `where(id: 1)`, `where(id: [1, 2])` and `where(id: nil)` all work. Choosing
 * `=` for every one of them produces `id = NULL`, which is never true — so a
 * query looking for records with no author silently returns none.
 */
export function predicateFor(attribute: ArelAttribute, value: unknown): ArelNode {
  if (value === null || value === undefined) {
    return { kind: "comparison", attribute, operator: "IS NULL", value: null };
  }

  if (Array.isArray(value)) {
    // An empty list is a contradiction rather than `IN ()`, which is a syntax
    // error on most servers and matches everything on one.
    if (value.length === 0) return contradictionNode();

    return { kind: "comparison", attribute, operator: "IN", value };
  }

  if (isRangeValue(value)) {
    return { kind: "comparison", attribute, operator: "BETWEEN", value };
  }

  return { kind: "comparison", attribute, operator: "=", value };
}

function isRangeValue(value: unknown): value is { begin: unknown; end: unknown } {
  return typeof value === "object" && value !== null && "begin" in value && "end" in value;
}

/** A condition that is never true, as a node. */
export function contradictionNode(): ArelNode {
  return { kind: "sql", sql: "1=0", binds: [] };
}

/**
 * Rails' `PredicateBuilder#build_from_hash` at the node level.
 *
 * One node per key, joined with AND. Joined with OR would make
 * `where(a: 1, b: 2)` mean "either", which is the opposite of what every
 * caller expects and produces more rows rather than fewer — so nothing fails,
 * there are just extra records.
 */
export function predicateBuilder(
  table: ArelTable,
  conditions: Record<string, unknown>,
): ArelNode | undefined {
  const nodes = Object.entries(conditions).map(([name, value]) =>
    predicateFor(resolveArelAttribute(name, table), value),
  );

  return andNodes(nodes);
}

export function andNodes(nodes: readonly ArelNode[]): ArelNode | undefined {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];

  return { kind: "and", children: [...nodes] };
}

export function orNodes(nodes: readonly ArelNode[]): ArelNode | undefined {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];

  return { kind: "or", children: [...nodes] };
}

// --- the where clause as a value ----------------------------------------------------------------

export interface WhereClause {
  predicates: ArelNode[];
}

export function whereClauses(predicates: readonly ArelNode[] = []): WhereClause {
  return { predicates: [...predicates] };
}

/**
 * Rails' `WhereClause#to_h` — the conditions as a plain hash, where they can be.
 *
 * Only simple equality on this table. Anything else — a range, a negation, raw
 * SQL — has no hash form, and inventing one would let a caller read a
 * condition back as something that does not mean the same thing. So those are
 * left out, and a caller comparing the hash against what it passed can see
 * that something was dropped.
 */
export function whereHash(clause: WhereClause): Record<string, unknown> {
  const hash: Record<string, unknown> = {};

  for (const node of clause.predicates) {
    if (node.kind !== "comparison" || node.operator !== "=") continue;

    hash[node.attribute.name] = node.value;
  }

  return hash;
}

/**
 * Rails' `WhereClause#merge`.
 *
 * A condition on an attribute the other clause also constrains is *replaced*,
 * not added. `Post.where(a: 1).merge(Post.where(a: 2))` has to mean `a = 2`;
 * keeping both gives `a = 1 AND a = 2`, which matches nothing — and returning
 * no rows is a normal answer, so nothing reports it.
 */
export function mergeClauses(left: WhereClause, right: WhereClause): WhereClause {
  const replaced = new Set(
    right.predicates
      .filter((node) => node.kind === "comparison")
      .map((node) => attributeKey((node as { attribute: ArelAttribute }).attribute)),
  );

  const kept = left.predicates.filter((node) => {
    if (node.kind !== "comparison") return true;

    return !replaced.has(attributeKey(node.attribute));
  });

  return whereClauses([...kept, ...right.predicates]);
}

function attributeKey(attribute: ArelAttribute): string {
  return `${attribute.table.alias ?? attribute.table.name}.${attribute.name}`;
}

/**
 * Rails' `WhereClause#except` — drop conditions on named attributes.
 *
 * Over a tree rather than over text. Doing it over SQL means parsing what the
 * application generated, and a parse that is not exactly right removes the
 * wrong condition silently.
 */
export function exceptAttributes(clause: WhereClause, names: readonly string[]): WhereClause {
  return whereClauses(
    clause.predicates.filter((node) => {
      if (node.kind !== "comparison") return true;

      return !names.includes(node.attribute.name);
    }),
  );
}

/**
 * Rails' `WhereClause#invert`.
 *
 * De Morgan's law, applied properly: `NOT (a AND b)` is `NOT a OR NOT b`.
 * Negating each part and keeping the AND gives `NOT a AND NOT b`, which is a
 * *narrower* query — it runs, returns rows, and returns the wrong ones.
 */
export function invertNode(node: ArelNode): ArelNode {
  switch (node.kind) {
    case "comparison":
      return { ...node, operator: invertOperator(node.operator) };
    case "and":
      return { kind: "or", children: node.children.map((child) => invertNode(child)) };
    case "or":
      return { kind: "and", children: node.children.map((child) => invertNode(child)) };
    case "not":
      return node.child;
    case "sql":
      // Raw SQL is wrapped rather than rewritten: rewriting would mean parsing
      // it, and a fragment an application wrote is the one thing here that
      // cannot be assumed to be a simple comparison.
      return { kind: "not", child: node };
  }
}

function invertOperator(operator: ArelOperator): ArelOperator {
  switch (operator) {
    case "=":
      return "!=";
    case "!=":
      return "=";
    case "<":
      return ">=";
    case "<=":
      return ">";
    case ">":
      return "<=";
    case ">=":
      return "<";
    case "IN":
      return "NOT IN";
    case "NOT IN":
      return "IN";
    case "IS NULL":
      return "IS NOT NULL";
    case "IS NOT NULL":
      return "IS NULL";
    default:
      return operator;
  }
}

export function invertClause(clause: WhereClause): WhereClause {
  const joined = andNodes(clause.predicates);

  return joined === undefined ? clause : whereClauses([invertNode(joined)]);
}

// --- walking a tree -----------------------------------------------------------------------------

/**
 * Rails' `Arel::Visitors::DepthFirst` — every node, parents before children.
 *
 * Parents first because the usual question is "does this tree contain X", and
 * an answer found near the root stops the walk. Children first would visit
 * every leaf of a subtree before the node that could have answered.
 */
export function walkTree(node: ArelNode): ArelNode[] {
  const collected: ArelNode[] = [node];

  for (const child of branches(node)) collected.push(...walkTree(child));

  return collected;
}

/** Rails' `Arel::Nodes::Node#children`. */
export function branches(node: ArelNode): ArelNode[] {
  if (node.kind === "and" || node.kind === "or") return node.children;
  if (node.kind === "not") return [node.child];

  return [];
}

/**
 * Rails' `Arel::Nodes.build` — a tree from a nested description.
 *
 * Flattens a nested AND into one node. `a AND (b AND c)` and `(a AND b) AND c`
 * mean the same thing, and leaving them different shapes makes every later
 * comparison — a merge, an except, a test — depend on how the conditions
 * happened to be written.
 */
export function makeTree(nodes: readonly ArelNode[], kind: "and" | "or"): ArelNode | undefined {
  const flattened: ArelNode[] = [];

  for (const node of nodes) {
    if (node.kind === kind) flattened.push(...node.children);
    else flattened.push(node);
  }

  return kind === "and" ? andNodes(flattened) : orNodes(flattened);
}

/**
 * Rails' `Arel::Nodes::And#add` — one more condition on an existing tree.
 *
 * Returns a new tree. Mutating the existing one would change every relation
 * that was built from it, and relations are shared far more than they look:
 * a scope is one relation reused by every caller.
 */
export function addBack(tree: ArelNode | undefined, node: ArelNode): ArelNode {
  if (tree === undefined) return node;

  return makeTree([tree, node], "and") ?? node;
}

/**
 * Rails' `applied_to?` — whether a tree already constrains an attribute.
 *
 * What a merge and a default scope both need: applying a default `where` on top
 * of one a caller wrote should not produce two conditions on one column.
 */
export function appliedTo(tree: ArelNode | undefined, attribute: ArelAttribute): boolean {
  if (tree === undefined) return false;

  return walkTree(tree).some(
    (node) =>
      node.kind === "comparison" && attributeKey(node.attribute) === attributeKey(attribute),
  );
}

// --- rendering ------------------------------------------------------------------------------------

/**
 * The SQL a tree produces, with its values bound.
 *
 * Values are bound rather than interpolated, at every depth — a tree exists so
 * conditions can be manipulated, and a manipulation that had to re-interpolate
 * would be the moment a value written by a user reaches the text.
 */
export function toSql(
  node: ArelNode,
  quote: (name: string) => string = (name) => `"${name}"`,
): { sql: string; binds: unknown[] } {
  switch (node.kind) {
    case "sql":
      return { sql: node.sql, binds: [...node.binds] };

    case "not": {
      const inner = toSql(node.child, quote);

      return { sql: `NOT (${inner.sql})`, binds: inner.binds };
    }

    case "and":
    case "or": {
      const parts = node.children.map((child) => toSql(child, quote));
      const joiner = node.kind === "and" ? " AND " : " OR ";

      return {
        // Parenthesised: `a OR b AND c` binds as `a OR (b AND c)`, so a tree
        // that meant `(a OR b) AND c` would render as a different query that
        // runs and returns different rows.
        sql: parts.map((part) => `(${part.sql})`).join(joiner),
        binds: parts.flatMap((part) => part.binds),
      };
    }

    case "comparison":
      return comparisonSql(node, quote);
  }
}

function comparisonSql(
  node: Extract<ArelNode, { kind: "comparison" }>,
  quote: (name: string) => string,
): { sql: string; binds: unknown[] } {
  const table = node.attribute.table.alias ?? node.attribute.table.name;
  const column = `${quote(table)}.${quote(node.attribute.name)}`;

  switch (node.operator) {
    case "IS NULL":
    case "IS NOT NULL":
      return { sql: `${column} ${node.operator}`, binds: [] };

    case "IN":
    case "NOT IN": {
      const values = node.value as unknown[];

      return {
        sql: `${column} ${node.operator} (${values.map(() => "?").join(", ")})`,
        binds: [...values],
      };
    }

    case "BETWEEN": {
      const { begin, end } = node.value as { begin: unknown; end: unknown };

      return { sql: `${column} BETWEEN ? AND ?`, binds: [begin, end] };
    }

    default:
      return { sql: `${column} ${node.operator} ?`, binds: [node.value] };
  }
}

/** The whole clause as one statement fragment. */
export function clauseToSql(
  clause: WhereClause,
  quote?: (name: string) => string,
): { sql: string; binds: unknown[] } {
  const joined = andNodes(clause.predicates);

  return joined === undefined ? { sql: "", binds: [] } : toSql(joined, quote);
}
