/**
 * Turning a tree of association names into a set of joins, ported from
 * `ActiveRecord::Associations::JoinDependency` and `AliasTracker`.
 *
 * `associations.ts` preloads — one query per association, records stitched
 * together afterwards. That is the right default, but it cannot answer
 * `where("authors.name = ?")`: a condition on a joined table needs the join to
 * exist in the *same* statement. So `includes` has a second mode, and this is
 * the machinery under it.
 *
 * Almost all of the difficulty is naming. A query that reaches the same table
 * twice — `Post.joins(author: :company, editor: :company)` — produces two
 * `companies` in one statement, and SQL has no way to tell them apart without
 * aliases. Getting that wrong does not fail: the database picks one, the
 * condition applies to whichever it picked, and the query returns rows that
 * look plausible. Every rule here exists for that reason:
 *
 * - The first use of a table keeps its own name, so ordinary single joins
 *   produce readable SQL and existing conditions written by hand still match.
 * - Every use after the first is aliased, counted per table, so the second
 *   `companies` becomes `companies_2` rather than colliding.
 * - Aliases are truncated to the adapter's identifier limit *before* the
 *   counter is appended, because truncating afterwards would cut the digits
 *   off and reintroduce the collision the alias existed to prevent.
 */

/** How wide an identifier may be. Rails' `table_alias_length`. */
export const DEFAULT_ALIAS_LENGTH = 63;

/** MySQL is the tightest of the three. */
export const MYSQL_ALIAS_LENGTH = 64;

export interface AliasedTable {
  /** The real table. */
  name: string;
  /** What to call it in this statement — the same as `name` on first use. */
  alias: string;
}

/**
 * Hands out table aliases, remembering what it has already used. Rails'
 * `Associations::AliasTracker`.
 *
 * Counting rather than generating a unique suffix, because the count is what
 * makes the alias *stable*: the same query built twice produces the same SQL,
 * which is what lets a statement cache and a query log be useful at all.
 */
export class AliasTracker {
  readonly #counts = new Map<string, number>();

  constructor(readonly aliasLength: number = DEFAULT_ALIAS_LENGTH) {}

  /** Rails' `aliases`. */
  get aliases(): ReadonlyMap<string, number> {
    return this.#counts;
  }

  /** How many times a name has been handed out. Rails' `initial_count_for`. */
  countFor(name: string): number {
    return this.#counts.get(name) ?? 0;
  }

  /** Seeds a count, for joins the caller wrote by hand. Rails' `initial_count_for`. */
  seed(name: string, count = 1): void {
    this.#counts.set(name, Math.max(this.countFor(name), count));
  }

  /**
   * The name a table should go by in this statement. Rails'
   * `aliased_table_for`.
   *
   * `candidate` is what an alias would be *based* on — Rails uses the
   * association name, so the second `companies` in a query joined through
   * `editor` reads as `editors_companies` rather than `companies_2`. A name
   * that says where it came from is the difference between a readable query
   * plan and one nobody can follow.
   */
  aliasedTableFor(name: string, candidate: string = name): AliasedTable {
    const used = this.countFor(name);

    if (used === 0) {
      this.#counts.set(name, 1);

      return { name, alias: name };
    }

    const base = tableAliasFor(candidate, this.aliasLength);
    const count = this.countFor(base) + 1;
    this.#counts.set(base, count);

    // Truncated before the counter goes on, not after: cutting `_2` off the end
    // is exactly the collision the alias was there to prevent.
    const aliased = count > 1 ? `${truncate(base, this.aliasLength - 2)}_${count}` : base;

    return { name, alias: aliased };
  }

  clear(): void {
    this.#counts.clear();
  }
}

/** Rails' `table_alias_for` — a name the adapter will accept. */
export function tableAliasFor(name: string, aliasLength = DEFAULT_ALIAS_LENGTH): string {
  // Dots become underscores: a schema-qualified name is one identifier to the
  // adapter, and `public.users` as an alias is a syntax error.
  return truncate(name.replaceAll(".", "_"), aliasLength);
}

function truncate(name: string, width: number): string {
  return name.length <= width ? name : name.slice(0, width);
}

/** Rails' `alias_candidate` — the name an alias is derived from. */
export function aliasCandidate(reflectionName: string, table: string): string {
  return `${reflectionName}_${table}`;
}

/** A column, qualified by whatever its table is called here. */
export function columnAlias(table: AliasedTable, column: string): string {
  return `${table.alias}.${column}`;
}

/**
 * Rails' `column_aliases` — one alias per selected column, per joined table.
 *
 * Every column is renamed rather than only the ambiguous ones. Selecting
 * `id` from three joined tables gives three columns called `id`, and the row
 * that comes back keeps whichever the driver saw last — so the record built
 * from it silently carries another table's primary key.
 */
export function columnAliases(
  tables: readonly { table: AliasedTable; columns: readonly string[] }[],
): { expression: string; as: string }[] {
  const aliases: { expression: string; as: string }[] = [];

  for (const [index, { table, columns }] of tables.entries()) {
    for (const column of columns) {
      aliases.push({ expression: columnAlias(table, column), as: `t${index}_r${aliases.length}` });
    }
  }

  return aliases;
}

/** Rails' `apply_column_aliases` — the SELECT list those aliases produce. */
export function applyColumnAliases(
  aliases: readonly { expression: string; as: string }[],
  quote: (name: string) => string = (name) => `"${name}"`,
): string {
  return aliases
    .map(({ expression, as }) => {
      const [table, column] = expression.split(".");

      return `${quote(table as string)}.${quote(column as string)} AS ${quote(as)}`;
    })
    .join(", ");
}

// --- the tree --------------------------------------------------------------

/**
 * What `joins`/`includes` was *given*, before anything is resolved.
 *
 * Distinct from `relation.ts`'s `JoinSpec`, which is one resolved join with its
 * table and columns already known. This is the nested argument the caller
 * writes; that is what this turns into.
 */
export type AssociationSpec =
  | string
  | { [association: string]: AssociationSpec | AssociationSpec[] }
  | AssociationSpec[];

/** One node of the join tree. Rails' `JoinAssociation`. */
export interface JoinNode {
  /** The association name on the parent. */
  name: string;
  children: JoinNode[];
}

/**
 * Normalises whatever shape the caller passed. Rails' `build`.
 *
 * `joins(:author)`, `joins([:author, :comments])` and
 * `joins(author: :company)` are the same language with three surface forms,
 * and every consumer downstream would otherwise reimplement the flattening.
 */
export function buildJoinTree(spec: AssociationSpec | undefined): JoinNode[] {
  if (spec === undefined) return [];
  if (typeof spec === "string") return [{ name: spec, children: [] }];
  if (Array.isArray(spec)) return spec.flatMap((each) => buildJoinTree(each));

  return Object.entries(spec).map(([name, nested]) => ({
    name,
    children: buildJoinTree(nested),
  }));
}

/** Rails' `add_child`. */
export function addChild(parent: JoinNode, child: JoinNode): JoinNode {
  const existing = parent.children.find((each) => each.name === child.name);

  if (!existing) {
    parent.children.push(child);

    return child;
  }

  // Merged rather than appended. `includes(author: :company).includes(author:
  // :posts)` names `author` twice and means one join with two children; adding
  // it twice would join `authors` twice and double every row.
  for (const grandchild of child.children) addChild(existing, grandchild);

  return existing;
}

/** Every node, parents before children. Rails' `each_children`. */
export function eachChildren(nodes: readonly JoinNode[]): JoinNode[] {
  return nodes.flatMap((node) => [node, ...eachChildren(node.children)]);
}

/** How deep the tree goes — one join per level. */
export function joinDepth(nodes: readonly JoinNode[]): number {
  return nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((node) => joinDepth(node.children)));
}

/** What one association contributes to the statement. */
export interface JoinConstraint {
  type: "INNER" | "LEFT OUTER";
  table: AliasedTable;
  /** `left` is on the parent's table, `right` on this one. */
  on: { left: string; right: string }[];
}

/**
 * Where a name resolves to: the table it lives on and the keys that reach it.
 *
 * Deliberately not `reflection.ts`'s `Reflection`, which is the full
 * association object with its validity checks and its owner. Joining needs
 * three strings, and asking for the whole object would make this unusable from
 * anywhere that has a schema but not a model.
 */
export interface JoinReflection {
  table: string;
  /** The column on the *parent* table. */
  foreignKey: string;
  /** The column on this table. */
  primaryKey: string;
  /** Nested associations reachable from here. */
  associations?: Record<string, JoinReflection>;
}

export class UnknownAssociation extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No association called "${name}". This model has: ${known.join(", ") || "none"}. ` +
        `A join built from an unknown name would produce SQL referencing a table that is ` +
        `not there, which the database reports far from the line that asked for it.`,
    );
    this.name = "UnknownAssociation";
  }
}

/** Rails' `find_reflection`. */
export function findReflection(
  associations: Record<string, JoinReflection>,
  name: string,
): JoinReflection {
  const found = associations[name];

  if (!found) throw new UnknownAssociation(name, Object.keys(associations).sort());

  return found;
}

/**
 * Walks the tree and produces one constraint per node. Rails'
 * `make_constraints` / `join_constraints`.
 *
 * Depth first, and the alias tracker is threaded through the whole walk rather
 * than reset per branch — which is the entire point. Two branches that reach
 * the same table have to see each other's counts, or they both believe they are
 * the first and both take the unaliased name.
 */
export function joinConstraints(
  nodes: readonly JoinNode[],
  associations: Record<string, JoinReflection>,
  parent: AliasedTable,
  tracker: AliasTracker,
  type: JoinConstraint["type"] = "INNER",
): JoinConstraint[] {
  const constraints: JoinConstraint[] = [];

  for (const node of nodes) {
    const reflection = findReflection(associations, node.name);
    const table = tracker.aliasedTableFor(
      reflection.table,
      aliasCandidate(node.name, reflection.table),
    );

    constraints.push({
      type,
      table,
      on: [
        {
          left: `${parent.alias}.${reflection.foreignKey}`,
          right: `${table.alias}.${reflection.primaryKey}`,
        },
      ],
    });

    if (node.children.length > 0) {
      constraints.push(
        ...joinConstraints(node.children, reflection.associations ?? {}, table, tracker, type),
      );
    }
  }

  return constraints;
}

/** Rails' `construct_join_dependency` — the whole thing, from a spec. */
export function constructJoinDependency(
  spec: AssociationSpec | undefined,
  associations: Record<string, JoinReflection>,
  baseTable: string,
  { type = "INNER" as JoinConstraint["type"], aliasLength = DEFAULT_ALIAS_LENGTH } = {},
): { root: AliasedTable; constraints: JoinConstraint[]; tracker: AliasTracker } {
  const tracker = new AliasTracker(aliasLength);
  const root = tracker.aliasedTableFor(baseTable);
  const constraints = joinConstraints(buildJoinTree(spec), associations, root, tracker, type);

  return { root, constraints, tracker };
}

/** Rails' `join_constraints` rendered as SQL. */
export function joinSql(
  constraints: readonly JoinConstraint[],
  quote: (name: string) => string = (name) => `"${name}"`,
): string {
  return constraints
    .map(({ type, table, on }) => {
      const target =
        table.alias === table.name
          ? quote(table.name)
          : `${quote(table.name)} ${quote(table.alias)}`;

      const condition = on
        .map(({ left, right }) => `${qualified(left, quote)} = ${qualified(right, quote)}`)
        .join(" AND ");

      return `${type} JOIN ${target} ON ${condition}`;
    })
    .join(" ");
}

function qualified(reference: string, quote: (name: string) => string): string {
  const [table, column] = reference.split(".");

  return `${quote(table as string)}.${quote(column as string)}`;
}

/**
 * Whether an association can be eager loaded. Rails' `check_eager_loadable!`.
 *
 * A polymorphic association cannot: the table to join depends on a value in
 * each row, and a join is chosen once for the whole statement. Rails raises
 * here rather than joining the wrong table, and so does this — the alternative
 * is a query that silently returns only the rows whose type happened to match.
 */
export function checkEagerLoadable(name: string, reflection: { polymorphic?: boolean }): void {
  if (reflection.polymorphic === true) {
    throw new Error(
      `The association "${name}" is polymorphic and cannot be eager loaded with a join: the ` +
        `table to join depends on each row's type, and a statement joins one table. Preload it ` +
        `instead, which runs one query per type.`,
    );
  }
}
