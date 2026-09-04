/**
 * Building one statement that writes many rows, ported from
 * `ActiveRecord::InsertAll` and the `insert_all` / `upsert_all` half of
 * `ActiveRecord::Persistence`.
 *
 * `bulk.ts` runs the statement. This is what the statement says, and the
 * decisions are all about a bulk write being a different thing from a loop of
 * single writes rather than a faster one:
 *
 * **It does not run callbacks or validations.** That is the point — a hundred
 * thousand rows cannot afford them — and it is also the hazard, because a
 * column a validation was guarding is now unguarded. So the API is named for
 * what it skips rather than for being fast.
 *
 * **Every row must have the same columns.** A loop can insert `{a, b}` then
 * `{a, c}`; one statement has one column list. Filling the gaps with `NULL`
 * would quietly write nulls over columns the caller never mentioned, and
 * defaults the database would otherwise have supplied are exactly what those
 * gaps usually mean.
 *
 * **A conflict target is required to update on conflict.** `ON CONFLICT DO
 * UPDATE` without one is a syntax error on Postgres and a full-table
 * upsert-by-primary-key on MySQL, which are different enough that guessing is
 * worse than asking.
 */

/** What to do when a row collides with one already there. */
export type ConflictAction = "raise" | "skip" | "update";

export interface InsertAllOptions {
  /** Rails' `unique_by` — the index or columns the conflict is detected on. */
  uniqueBy?: readonly string[];
  /** Rails' `on_duplicate_key_update` — which columns a conflict overwrites. */
  updateOnly?: readonly string[];
  /** Columns never overwritten by an upsert, even when they differ. */
  updateExcept?: readonly string[];
  /** Rails' `returning`. */
  returning?: readonly string[] | false;
  /** Rails' `record_timestamps`. */
  recordTimestamps?: boolean;
}

export class MismatchedColumns extends Error {
  constructor(missing: readonly string[], rowIndex: number) {
    super(
      `Row ${rowIndex} is missing ${missing.join(", ")}. One statement has one column list, so ` +
        `the gap would be written as NULL — over columns the caller never mentioned, and past ` +
        `the defaults the database would otherwise have supplied.`,
    );
    this.name = "MismatchedColumns";
  }
}

export class MissingConflictTarget extends Error {
  constructor() {
    super(
      `An upsert needs to know which columns identify a duplicate. Without one, Postgres ` +
        `refuses the statement and MySQL upserts on the primary key — different enough that ` +
        `guessing is worse than asking.`,
    );
    this.name = "MissingConflictTarget";
  }
}

/**
 * The columns a set of rows writes. Rails' `keys`.
 *
 * Taken from the first row and then *checked* against the rest, rather than
 * unioned. A union would silently accept rows that disagree and fill the
 * difference with nulls.
 */
export function insertColumns(rows: readonly Record<string, unknown>[]): string[] {
  const first = rows[0];

  if (!first) return [];

  const columns = Object.keys(first);
  const expected = new Set(columns);

  rows.forEach((row, index) => {
    const missing = columns.filter((column) => !(column in row));
    const extra = Object.keys(row).filter((column) => !expected.has(column));

    if (missing.length > 0 || extra.length > 0) {
      throw new MismatchedColumns([...missing, ...extra], index);
    }
  });

  return columns;
}

/** Rails' `values_list` — the rows, in column order. */
export function valuesList(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): unknown[][] {
  return rows.map((row) => columns.map((column) => row[column]));
}

/**
 * Which columns an upsert overwrites. Rails' `updatable_columns`.
 *
 * Everything except the conflict target by default: the columns that
 * *identify* the row are how it was found, and setting them to themselves is
 * at best noise and at worst a no-op update that still takes a row lock.
 */
export function updatableColumns(
  columns: readonly string[],
  { uniqueBy = [], updateOnly, updateExcept = [] }: InsertAllOptions = {},
): string[] {
  if (updateOnly) return columns.filter((column) => updateOnly.includes(column));

  const excluded = new Set([...uniqueBy, ...updateExcept]);

  return columns.filter((column) => !excluded.has(column));
}

/**
 * Timestamps a bulk write should set itself. Rails' `record_timestamps`.
 *
 * Both on insert; only `updated_at` on the update half of an upsert, because
 * `created_at` describes when the row first existed and an upsert that
 * overwrote it would make every touched row look newly created — which is the
 * column most reports group by.
 */
export function timestampColumns(
  columns: readonly string[],
  { forUpdate = false }: { forUpdate?: boolean } = {},
): string[] {
  const available = ["created_at", "updated_at"].filter((column) => columns.includes(column));

  return forUpdate ? available.filter((column) => column !== "created_at") : available;
}

/** Rails' `empty_insert_statement_value` — inserting a row that names no columns. */
export function emptyInsertStatementValue(adapter: string): string {
  // Postgres and SQLite spell this differently, and MySQL differently again.
  // A row of pure defaults is rare and entirely legitimate — a join table with
  // only auto-populated columns — so it needs to be expressible.
  return adapter === "mysql" ? "() VALUES ()" : "DEFAULT VALUES";
}

/** Rails' `default_insert_value`. */
export function defaultInsertValue(): string {
  return "DEFAULT";
}

export interface InsertStatement {
  sql: string;
  binds: unknown[];
}

/**
 * The whole statement. Rails' `build_insert_sql`.
 *
 * Values are bound, never interpolated — a bulk insert is usually the path
 * that carries imported data, which is to say data from somewhere else.
 */
export function buildInsertSql(
  table: string,
  rows: readonly Record<string, unknown>[],
  {
    conflict = "raise" as ConflictAction,
    adapter = "postgres",
    quote = (name: string) => `"${name}"`,
    placeholder = (index: number) => `$${index + 1}`,
    ...options
  }: InsertAllOptions & {
    conflict?: ConflictAction;
    adapter?: string;
    quote?: (name: string) => string;
    placeholder?: (index: number) => string;
  } = {},
): InsertStatement {
  const columns = insertColumns(rows);

  if (columns.length === 0) {
    return { sql: `INSERT INTO ${quote(table)} ${emptyInsertStatementValue(adapter)}`, binds: [] };
  }

  const binds: unknown[] = [];
  const tuples = valuesList(rows, columns).map(
    (values) =>
      `(${values
        .map((value) => {
          binds.push(value);

          return placeholder(binds.length - 1);
        })
        .join(", ")})`,
  );

  const head = `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${tuples.join(", ")}`;

  const returning =
    options.returning === false || options.returning === undefined
      ? ""
      : ` RETURNING ${options.returning.map(quote).join(", ")}`;

  return { sql: head + conflictClause(conflict, columns, options, quote) + returning, binds };
}

function conflictClause(
  conflict: ConflictAction,
  columns: readonly string[],
  options: InsertAllOptions,
  quote: (name: string) => string,
): string {
  if (conflict === "raise") return "";

  if (conflict === "skip") {
    // A skip needs no target: "any conflict" is unambiguous, which is why this
    // is the one case that can be written without `uniqueBy`.
    const target = options.uniqueBy?.length ? ` (${options.uniqueBy.map(quote).join(", ")})` : "";

    return ` ON CONFLICT${target} DO NOTHING`;
  }

  if (!options.uniqueBy?.length) throw new MissingConflictTarget();

  const updates = updatableColumns(columns, options);

  // Nothing left to update means the caller excluded everything, which is a
  // skip written the long way round — and `DO UPDATE SET` with no assignments
  // is a syntax error.
  if (updates.length === 0) {
    return ` ON CONFLICT (${options.uniqueBy.map(quote).join(", ")}) DO NOTHING`;
  }

  const assignments = updates
    .map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`)
    .join(", ");

  return ` ON CONFLICT (${options.uniqueBy.map(quote).join(", ")}) DO UPDATE SET ${assignments}`;
}

/** Rails' `skip_duplicates?`. */
export function skipDuplicates(conflict: ConflictAction): boolean {
  return conflict === "skip";
}

/** Rails' `update_duplicates?`. */
export function updateDuplicates(conflict: ConflictAction): boolean {
  return conflict === "update";
}

/**
 * What an insert can read back. Rails' `return_value_after_insert`.
 *
 * Only where the adapter supports `RETURNING`. Asking for it elsewhere would
 * produce a statement the database refuses, and the fallback — a second query
 * for the ids just written — cannot identify them reliably in a bulk write.
 */
export function returnValueAfterInsert(
  supportsReturning: boolean,
  requested: readonly string[] | false | undefined,
): string[] | undefined {
  if (requested === false || requested === undefined) return undefined;

  return supportsReturning ? [...requested] : undefined;
}

/** Rails' `return_value_after_update`. */
export function returnValueAfterUpdate(
  supportsUpdateReturning: boolean,
  requested: readonly string[] | false | undefined,
): string[] | undefined {
  return returnValueAfterInsert(supportsUpdateReturning, requested);
}
