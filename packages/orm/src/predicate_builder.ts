/**
 * Turning a `where` hash into predicates, ported from
 * `ActiveRecord::PredicateBuilder` and its `ArrayHandler`, `RangeHandler` and
 * `BasicObjectHandler`.
 *
 * `where({ id: 7 })` is one shape with a great many meanings: a scalar is an
 * equality, an array is an `IN`, a range is a `BETWEEN`, `null` is `IS NULL`,
 * and an array containing a `null` is both at once. Every one of those has a
 * wrong answer that produces valid SQL:
 *
 * - `id = NULL` is never true, for any row, including rows whose id *is* null.
 *   A hash asking for null has to become `IS NULL` or it silently matches
 *   nothing.
 * - `id IN ()` is a syntax error on most databases and matches everything on
 *   none of them. An empty array means "no possible match", which is a
 *   contradiction — `1 = 0` — and writing anything else here is how
 *   `where(id: [])` returns the whole table.
 * - A range with an excluded end (`1...5`) is `>= AND <`, not `BETWEEN`, which
 *   is inclusive. One row of difference, every time.
 *
 * The other half is the raw-SQL boundary. `order` and `pluck` take column names
 * that no binding can protect, so anything reaching them is checked against a
 * narrow pattern rather than trusted — `sanitization.ts` already owns that
 * check and this defers to it rather than writing a second one.
 */

import { disallowRawSql } from "./sanitization.js";

/** One condition, ready to be joined into a WHERE. */
export interface Predicate {
  sql: string;
  binds: unknown[];
}

/**
 * A value a `where` hash can hold, narrowed.
 *
 * `relation.ts` exports `WhereValue` as `unknown`, which is what a public
 * builder API has to accept. This is the set this file knows how to turn into
 * SQL, kept separate so the two do not quietly diverge.
 */
export type PredicateValue =
  | string
  | number
  | boolean
  | bigint
  | Date
  | null
  | undefined
  | readonly unknown[]
  | { from: unknown; to: unknown; excludeEnd?: boolean };

/**
 * A condition no row can satisfy. Rails' `contradiction`.
 *
 * `1 = 0` rather than an empty string, because an empty condition is dropped
 * by whatever joins the clauses together — and a dropped condition turns
 * `where(id: [])` from "nothing" into "everything", which is the single most
 * destructive form this bug takes when the relation is then deleted.
 */
export function contradiction(): Predicate {
  return { sql: "1 = 0", binds: [] };
}

/** Rails' `unboundable?` — a value that cannot be compared to a column at all. */
export function unboundable(value: unknown): boolean {
  return typeof value === "symbol" || typeof value === "function";
}

function isRange(value: unknown): value is { from: unknown; to: unknown; excludeEnd?: boolean } {
  return typeof value === "object" && value !== null && "from" in value && "to" in value;
}

/**
 * The predicate for an array. Rails' `ArrayHandler`.
 *
 * A `null` inside the list is pulled out and asked for separately, because
 * `IN (NULL)` never matches — SQL's three-valued logic makes every comparison
 * with null unknown. `where(parent_id: [1, null])` means "child of 1, or a
 * root", and without this it silently means only the first half.
 */
export function arrayPredicateFor(
  column: string,
  values: readonly unknown[],
  quote: (name: string) => string = (name) => `"${name}"`,
  placeholder: (index: number) => string = () => "?",
): Predicate {
  const present = values.filter((value) => value !== null && value !== undefined);
  const hasNull = present.length !== values.length;

  if (present.length === 0) {
    return hasNull ? { sql: `${quote(column)} IS NULL`, binds: [] } : contradiction();
  }

  const list = present.map((_value, index) => placeholder(index)).join(", ");
  const inClause =
    present.length === 1 ? `${quote(column)} = ${placeholder(0)}` : `${quote(column)} IN (${list})`;

  return hasNull
    ? { sql: `(${inClause} OR ${quote(column)} IS NULL)`, binds: [...present] }
    : { sql: inClause, binds: [...present] };
}

/**
 * The predicate for a range. Rails' `RangeHandler`.
 *
 * An excluded end is `<`, not `<=`. `BETWEEN` is always inclusive, so writing
 * a half-open range as one is off by exactly one row — which for a range of
 * dates is a whole day of records in the wrong report.
 */
export function rangePredicateFor(
  column: string,
  range: { from: unknown; to: unknown; excludeEnd?: boolean },
  quote: (name: string) => string = (name) => `"${name}"`,
  placeholder: (index: number) => string = () => "?",
): Predicate {
  const upper = range.excludeEnd ? "<" : "<=";

  if (range.from === null || range.from === undefined) {
    return { sql: `${quote(column)} ${upper} ${placeholder(0)}`, binds: [range.to] };
  }

  if (range.to === null || range.to === undefined) {
    return { sql: `${quote(column)} >= ${placeholder(0)}`, binds: [range.from] };
  }

  return {
    sql: `${quote(column)} >= ${placeholder(0)} AND ${quote(column)} ${upper} ${placeholder(1)}`,
    binds: [range.from, range.to],
  };
}

export class UnboundableValue extends Error {
  constructor(column: string, value: unknown) {
    super(
      `Cannot compare ${JSON.stringify(column)} against a ${typeof value}. A value with no SQL ` +
        `representation would be bound as whatever the driver made of it, which is a condition ` +
        `nobody wrote.`,
    );
    this.name = "UnboundableValue";
  }
}

/**
 * One column and one value. Rails' `build`.
 *
 * `null` becomes `IS NULL`. `column = NULL` is never true for any row —
 * including rows whose column *is* null — so a hash asking for null would
 * otherwise silently match nothing.
 */
export function buildPredicate(
  column: string,
  value: PredicateValue,
  quote: (name: string) => string = (name) => `"${name}"`,
  placeholder: (index: number) => string = () => "?",
): Predicate {
  if (unboundable(value)) throw new UnboundableValue(column, value);

  if (value === null || value === undefined) {
    return { sql: `${quote(column)} IS NULL`, binds: [] };
  }

  if (Array.isArray(value)) return arrayPredicateFor(column, value, quote, placeholder);

  if (isRange(value)) return rangePredicateFor(column, value, quote, placeholder);

  return { sql: `${quote(column)} = ${placeholder(0)}`, binds: [value] };
}

/**
 * A whole hash. Rails' `build_from_hash`.
 *
 * Joined with `AND`, and an empty hash produces no condition at all rather
 * than a contradiction — `where({})` means "no additional restriction", which
 * is the opposite of `where(id: [])`.
 */
export function buildFromHash(
  conditions: Record<string, PredicateValue>,
  {
    quote = (name: string) => `"${name}"`,
    placeholder = (index: number) => `$${index + 1}`,
  }: { quote?: (name: string) => string; placeholder?: (index: number) => string } = {},
): Predicate {
  const parts: string[] = [];
  const binds: unknown[] = [];

  for (const [column, value] of Object.entries(conditions)) {
    const predicate = buildPredicate(column, value, quote, (index) =>
      placeholder(binds.length + index),
    );
    parts.push(predicate.sql);
    binds.push(...predicate.binds);
  }

  return { sql: parts.join(" AND "), binds };
}

// --- comparing text --------------------------------------------------------

/**
 * Whether a column can be compared without regard to case. Rails'
 * `can_perform_case_insensitive_comparison_for?`.
 *
 * Only text. Lowering a number or a date is either an error or a silent cast
 * to text, and a cast column cannot use its index — so a uniqueness validation
 * on an integer would quietly become a full table scan on every save.
 */
export function canPerformCaseInsensitiveComparisonFor(sqlType: string): boolean {
  return /char|text|string|clob/i.test(sqlType);
}

/** Rails' `case_sensitive_comparison`. */
export function caseSensitiveComparison(
  column: string,
  quote: (name: string) => string = (name) => `"${name}"`,
  placeholder = "?",
): string {
  return `${quote(column)} = ${placeholder}`;
}

/** How a uniqueness check compares one condition. */
export interface UniquenessComparisonOptions {
  /** Whether two values differing only in case collide. */
  caseSensitive?: boolean;
  /** Which database this is for; MySQL needs help either way. */
  adapter?: string;
  quote?: (name: string) => string;
  placeholder?: string;
}

/**
 * The comparison a uniqueness check uses for the attribute it validates.
 *
 * Both directions need help, on opposite databases, and getting either wrong
 * makes the option a lie:
 *
 * - **Case-insensitively**, `=` is exact on SQLite and PostgreSQL, so the
 *   values have to be folded with `LOWER`.
 * - **Case-sensitively**, `=` on MySQL is *not* exact: its default collation
 *   (`utf8mb4_0900_ai_ci`) ignores case, so `bob@example.com` already matches
 *   `Bob@example.com` there. `BINARY` forces the byte comparison the caller
 *   asked for. Without it a model declaring `caseSensitive: true` behaves one
 *   way in a SQLite test suite and the other way in MySQL production.
 *
 * Neither applies to a value that is not a string, and that guard is not
 * tidiness: `LOWER` on a numeric column is a hard error on PostgreSQL
 * (`function lower(integer) does not exist`). The column's own type is not to
 * hand where the validator runs — it has the record, not the schema — but the
 * value's is, and a value that is not a string has no case.
 */
export function uniquenessComparison(
  column: string,
  value: unknown,
  {
    caseSensitive = true,
    adapter = "sqlite",
    quote = (name) => `"${name}"`,
    placeholder = "?",
  }: UniquenessComparisonOptions = {},
): string {
  if (typeof value !== "string") return caseSensitiveComparison(column, quote, placeholder);

  if (!caseSensitive) {
    return caseInsensitiveComparison(column, "string", quote, placeholder);
  }

  if (adapter === "mysql") return `${quote(column)} = BINARY ${placeholder}`;

  return caseSensitiveComparison(column, quote, placeholder);
}

/**
 * Splits a uniqueness check's conditions into the ones compared as given and
 * the one compared with case in mind.
 *
 * Here rather than inline in the probe so the split is testable on its own:
 * whether the adapter reaches the comparison is exactly the kind of thing that
 * is invisible on SQLite and wrong on MySQL, which is to say invisible until
 * production.
 */
export function uniquenessConditions(
  conditions: Record<string, unknown>,
  comparison: { attribute: string; caseSensitive: boolean } | undefined,
  { adapter, quote }: { adapter: string; quote: (name: string) => string },
): { plain: Record<string, unknown>; fragments: { sql: string; value: unknown }[] } {
  const plain: Record<string, unknown> = {};
  const fragments: { sql: string; value: unknown }[] = [];

  for (const [column, value] of Object.entries(conditions)) {
    // The scope columns narrow the search and are compared as given. Only the
    // validated attribute is compared with case in mind.
    if (column !== comparison?.attribute) {
      plain[column] = value;
      continue;
    }

    fragments.push({
      sql: uniquenessComparison(column, value, {
        caseSensitive: comparison.caseSensitive,
        adapter,
        quote,
      }),
      value,
    });
  }

  return { plain, fragments };
}

/**
 * Rails' `case_insensitive_comparison`.
 *
 * Both sides lowered, not just the column. Lowering only the column compares
 * `lower(email)` against whatever case the caller happened to pass, which
 * makes the check pass or fail depending on how the form was filled in — the
 * exact thing a case-insensitive uniqueness validation exists to prevent.
 */
export function caseInsensitiveComparison(
  column: string,
  sqlType: string,
  quote: (name: string) => string = (name) => `"${name}"`,
  placeholder = "?",
): string {
  if (!canPerformCaseInsensitiveComparisonFor(sqlType)) {
    return caseSensitiveComparison(column, quote, placeholder);
  }

  return `LOWER(${quote(column)}) = LOWER(${placeholder})`;
}

/** Rails' `downcase` in the uniqueness path. */
export function downcase(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

// --- column names that reach SQL unbound -----------------------------------

/** A bare column, optionally table-qualified. Rails' `COLUMN_NAME`. */
export const COLUMN_NAME = /^\s*\w+(\.\w+)?\s*$/;

/** The same, allowing a direction. Rails' `COLUMN_NAME_WITH_ORDER`. */
export const COLUMN_NAME_WITH_ORDER =
  /^\s*\w+(\.\w+)?\s*(asc|desc)?\s*(nulls\s+(first|last))?\s*$/i;

/** Rails' `column_name_matcher`. */
export function columnNameMatcher(fragment: string): boolean {
  return COLUMN_NAME.test(fragment);
}

/** Rails' `column_name_with_order_matcher`. */
export function columnNameWithOrderMatcher(fragment: string): boolean {
  return COLUMN_NAME_WITH_ORDER.test(fragment);
}

/**
 * Checks fragments heading for an `ORDER BY`. Rails' `disallow_raw_sql!`.
 *
 * `sanitization.ts` owns the check; this is the name the query layer reaches
 * for. Two implementations of a security boundary means one that drifted and
 * still looks right.
 */
export function checkOrderFragments(fragments: readonly string[]): void {
  disallowRawSql(fragments);
}

/**
 * The columns a `DISTINCT` has to select. Rails' `columns_for_distinct`.
 *
 * Every ordering column joins the selection, because a database cannot order
 * by something the `DISTINCT` did not keep — Postgres refuses the query
 * outright, and the ones that allow it pick an arbitrary row per group.
 */
export function columnsForDistinct(
  columns: readonly string[],
  orders: readonly string[] = [],
): string[] {
  const selected = new Set(columns);

  return [...columns, ...orders.map(bareColumn).filter((column) => !selected.has(column))];
}

function bareColumn(fragment: string): string {
  return (fragment.trim().split(/\s+/)[0] ?? "").trim();
}

/** Rails' `deduplicate` — repeated conditions collapsed, order kept. */
export function deduplicate<T>(values: readonly T[], key: (value: T) => string = String): T[] {
  const seen = new Set<string>();

  return values.filter((value) => {
    const identity = key(value);

    if (seen.has(identity)) return false;

    seen.add(identity);

    return true;
  });
}

/** Rails' `compute_if_absent` over a plain map. */
export function computeIfAbsent<K, V>(cache: Map<K, V>, key: K, build: () => V): V {
  const held = cache.get(key);

  if (held !== undefined) return held;

  const built = build();
  cache.set(key, built);

  return built;
}

// --- reaching a column through an association -------------------------------

/** Rails' `associated_table` — the table a nested condition refers to. */
export function associatedTable(
  name: string,
  associations: Record<string, { table: string }>,
): string | undefined {
  return associations[name]?.table;
}

/** Rails' `associated_with?`. */
export function associatedWith(
  name: string,
  associations: Record<string, { table: string }>,
): boolean {
  return Object.hasOwn(associations, name);
}

/**
 * A column reference qualified by its table. Rails' `arel_attribute`.
 *
 * Qualified always, not only when ambiguous: a query that joins a table later
 * gaining a column of the same name would otherwise change meaning without
 * anything being edited.
 */
export function qualifiedColumn(table: string, column: string): string {
  return `${table}.${column}`;
}
