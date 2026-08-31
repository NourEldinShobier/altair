/**
 * Checking what a migration asked for, ported from
 * `ActiveRecord::ConnectionAdapters::SchemaStatements`' `valid_*_options` and
 * `add_index_options`.
 *
 * `schema.ts` executes migrations. This is the layer that reads what one said
 * before it runs, and it exists for a bug class with no symptom:
 *
 *     t.string :name, limti: 40
 *
 * A migration with a misspelled option runs, reports success, and produces a
 * column without the limit. Nothing fails. The schema is subtly not what the
 * file says, and the difference is found months later by a value that should
 * have been rejected and was not. Rails added these checks for exactly that,
 * and the list of valid options is the whole feature — an allowlist is only
 * useful if it is complete and refuses everything else.
 *
 * The index half is different: there the defaults matter more than the
 * validation. An index whose name collides with another is a migration that
 * fails halfway on the machine that already had one, and an index name derived
 * from long column names silently exceeds the identifier limit on MySQL.
 */

/** Rails' `valid_column_definition_options`. */
export const VALID_COLUMN_OPTIONS: readonly string[] = [
  "limit",
  "precision",
  "scale",
  "default",
  "null",
  "collation",
  "comment",
  "primaryKey",
  "if_exists",
  "if_not_exists",
  "array",
  "using",
  "cast_as",
  "as",
  "type",
  "enum_type",
  "stored",
];

/** Rails' `valid_table_definition_options`. */
export const VALID_TABLE_OPTIONS: readonly string[] = [
  "temporary",
  "if_not_exists",
  "options",
  "as",
  "comment",
  "charset",
  "collation",
  "id",
  "primaryKey",
  "force",
];

/** Rails' `valid_primary_key_options`. */
export const VALID_PRIMARY_KEY_OPTIONS: readonly string[] = [
  "limit",
  "default",
  "precision",
  "type",
];

/** Rails' `valid_index_options`. */
export const VALID_INDEX_OPTIONS: readonly string[] = [
  "unique",
  "length",
  "order",
  "opclass",
  "where",
  "type",
  "using",
  "comment",
  "algorithm",
  "include",
  "nullsNotDistinct",
  "name",
  "internal",
  "if_not_exists",
];

export class UnknownOption extends Error {
  constructor(given: readonly string[], valid: readonly string[], kind: string) {
    super(
      `Unknown ${kind} option${given.length === 1 ? "" : "s"}: ${given.join(", ")}. Valid: ` +
        `${valid.join(", ")}. A misspelled option does not fail — the migration runs, reports ` +
        `success, and produces a schema that is quietly not what the file says.`,
    );
    this.name = "UnknownOption";
  }
}

/**
 * Rails' `validate_options`.
 *
 * An allowlist rather than a denylist, because the failure this prevents is a
 * name nobody anticipated — a denylist can only refuse the typos somebody
 * already thought of.
 */
export function validateOptions(
  options: Record<string, unknown>,
  valid: readonly string[],
  kind: string,
): void {
  const unknown = Object.keys(options).filter((name) => !valid.includes(name));

  if (unknown.length > 0) throw new UnknownOption(unknown, valid, kind);
}

export function validColumnDefinitionOptions(options: Record<string, unknown>): void {
  validateOptions(options, VALID_COLUMN_OPTIONS, "column");
}

export function validTableDefinitionOptions(options: Record<string, unknown>): void {
  validateOptions(options, VALID_TABLE_OPTIONS, "table");
}

export function validPrimaryKeyOptions(options: Record<string, unknown>): void {
  validateOptions(options, VALID_PRIMARY_KEY_OPTIONS, "primary key");
}

export function validIndexOptions(options: Record<string, unknown>): void {
  validateOptions(options, VALID_INDEX_OPTIONS, "index");
}

/** Rails' `valid_type?`. */
export function validType(type: string, known: readonly string[]): boolean {
  return known.includes(type);
}

// --- indexes ---------------------------------------------------------------

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  where?: string;
  using?: string;
  algorithm?: "default" | "concurrently";
  include?: readonly string[];
  nullsNotDistinct?: boolean;
  comment?: string;
  length?: number | Record<string, number>;
  order?: "asc" | "desc" | Record<string, "asc" | "desc">;
}

export interface ResolvedIndex extends IndexOptions {
  table: string;
  columns: readonly string[];
  name: string;
}

/**
 * The name an index gets when nobody supplies one. Rails' `index_name`.
 *
 * Derived from the table and every column, because two indexes on one table
 * differing only in their columns would otherwise collide — and the collision
 * appears on whichever machine already had the first one, which is production
 * rather than the laptop the migration was written on.
 */
export function indexNameFor(table: string, columns: readonly string[]): string {
  return `index_${table}_on_${columns.join("_and_")}`;
}

export class IndexNameTooLong extends Error {
  constructor(name: string, limit: number) {
    super(
      `The index name ${JSON.stringify(name)} is ${name.length} characters, past the ${limit} ` +
        `this adapter allows. Name it explicitly: a truncated name collides with whatever else ` +
        `truncates to the same thing, and the collision shows up on the machine that already ` +
        `had the other index.`,
    );
    this.name = "IndexNameTooLong";
  }
}

/**
 * Rails' `add_index_options`.
 *
 * Refuses a name that is too long rather than truncating it. Truncation is how
 * two different indexes end up asking for the same name, and the failure lands
 * on the database that already has one of them.
 */
export function addIndexOptions(
  table: string,
  columns: readonly string[],
  options: IndexOptions = {},
  { maxNameLength = 63 }: { maxNameLength?: number } = {},
): ResolvedIndex {
  validIndexOptions(options as Record<string, unknown>);

  if (columns.length === 0) {
    throw new Error(`An index on ${JSON.stringify(table)} needs at least one column.`);
  }

  const name = options.name ?? indexNameFor(table, columns);

  if (name.length > maxNameLength) throw new IndexNameTooLong(name, maxNameLength);

  return { ...options, table, columns: [...columns], name };
}

/** Rails' `default_index_type`. */
export function defaultIndexType(adapter: string): string {
  return adapter === "postgres" ? "btree" : "";
}

/** Rails' `index_algorithms`. */
export function indexAlgorithms(adapter: string): Record<string, string> {
  return adapter === "postgres" ? { concurrently: "CONCURRENTLY" } : {};
}

/**
 * Rails' `index_algorithm`.
 *
 * An algorithm the adapter does not have is refused rather than dropped.
 * `algorithm: :concurrently` exists so a migration does not lock a table for
 * the length of an index build; silently ignoring it on an adapter without it
 * turns a safe migration into an outage.
 */
export function indexAlgorithm(adapter: string, algorithm: string | undefined): string {
  if (algorithm === undefined || algorithm === "default") return "";

  const available = indexAlgorithms(adapter);

  if (!Object.hasOwn(available, algorithm)) {
    throw new Error(
      `The ${adapter} adapter has no index algorithm ${JSON.stringify(algorithm)}. Ignoring it ` +
        `would turn a migration written not to lock the table into one that does.`,
    );
  }

  return available[algorithm] as string;
}

/** Rails' `max_index_name_size`. */
export function maxIndexNameSize(adapter: string): number {
  return adapter === "mysql" ? 64 : 63;
}

/** Rails' `columns_for_index` — the index entries a column participates in. */
export function columnIndexes(indexes: readonly ResolvedIndex[], column: string): ResolvedIndex[] {
  return indexes.filter((index) => index.columns.includes(column));
}

// --- altering a table -------------------------------------------------------

export type AlterOperation =
  | { kind: "addColumn"; column: string; type: string; options?: Record<string, unknown> }
  | { kind: "changeNull"; column: string; null: boolean }
  | { kind: "removeColumn"; column: string }
  | { kind: "addConstraint"; name: string; expression: string }
  | { kind: "dropConstraint"; name: string };

/**
 * Rails' `bulk_change_table` — several alterations in one statement.
 *
 * Worth doing because each `ALTER TABLE` on a large table is its own full
 * rewrite on MySQL; three separate statements rewrite a hundred-million-row
 * table three times, and the migration takes three times as long holding a
 * lock for all of it.
 */
export function bulkChangeTable(
  table: string,
  operations: readonly AlterOperation[],
  quote: (name: string) => string = (name) => `"${name}"`,
): string {
  if (operations.length === 0) {
    throw new Error(`Nothing to change on ${JSON.stringify(table)}.`);
  }

  const clauses = operations.map((operation) => {
    switch (operation.kind) {
      case "addColumn":
        return `ADD COLUMN ${quote(operation.column)} ${operation.type}`;
      case "removeColumn":
        return `DROP COLUMN ${quote(operation.column)}`;
      case "changeNull":
        return `ALTER COLUMN ${quote(operation.column)} ${operation.null ? "DROP" : "SET"} NOT NULL`;
      case "addConstraint":
        return `ADD CONSTRAINT ${quote(operation.name)} CHECK (${operation.expression})`;
      case "dropConstraint":
        return `DROP CONSTRAINT ${quote(operation.name)}`;
    }
  });

  return `ALTER TABLE ${quote(table)} ${clauses.join(", ")}`;
}

/** Rails' `change_column_null`. */
export function changeNull(column: string, allowNull: boolean): AlterOperation {
  return { kind: "changeNull", column, null: allowNull };
}

/** Rails' `drop_constraint`. */
export function dropConstraint(name: string): AlterOperation {
  return { kind: "dropConstraint", name };
}

/**
 * Rails' `check_constraint_options` — the name a check constraint gets.
 *
 * Derived from the table and a digest of the expression rather than from the
 * expression itself, because an expression can be any length and contains
 * characters an identifier cannot.
 */
export function checkConstraintOptions(
  table: string,
  expression: string,
  options: { name?: string; validate?: boolean } = {},
): { name: string; validate: boolean } {
  return {
    name: options.name ?? `chk_rails_${digest(`${table}_${expression}`)}`,
    validate: options.validate !== false,
  };
}

/** Rails' `foreign_key_options` — the same, for a foreign key. */
export function foreignKeyOptions(
  fromTable: string,
  toTable: string,
  options: { name?: string; column?: string; primaryKey?: string; onDelete?: string } = {},
): { name: string; column: string; primaryKey: string; onDelete?: string } {
  const column = options.column ?? `${singular(toTable)}_id`;

  return {
    name: options.name ?? `fk_rails_${digest(`${fromTable}_${column}`)}`,
    column,
    primaryKey: options.primaryKey ?? "id",
    ...(options.onDelete === undefined ? {} : { onDelete: options.onDelete }),
  };
}

function singular(table: string): string {
  return table.endsWith("s") ? table.slice(0, -1) : table;
}

/**
 * A short, stable identifier fragment.
 *
 * Stable across processes and machines, because the name ends up in a schema
 * dump: a digest that varied would make every dump differ from the last and
 * every migration look like it changed something.
 */
function digest(input: string): string {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(16).padStart(10, "0").slice(0, 10);
}
