/**
 * Turning a schema change into DDL, ported from
 * `ActiveRecord::ConnectionAdapters::SchemaCreation` and the definition objects
 * in `abstract/schema_definitions.rb`.
 *
 * `schema.ts` has the migration API — `createTable`, `addColumn`. This is the
 * layer under it: a migration builds *definition objects*, and one visitor
 * turns those objects into a statement. Rails splits it that way for a reason
 * that is easy to miss until something needs it:
 *
 * - **A definition can be inspected before it is run.** `buildCreateTableDefinition`
 *   hands back the object rather than executing it, which is what lets a
 *   migration be reversed, dry-run, or diffed against the live schema. A
 *   layer that only ever produced a string could do none of that.
 * - **One place decides what an adapter supports.** Every capability check —
 *   check constraints, exclusion constraints, indexes inside `CREATE TABLE` —
 *   lives in the visitor. Spread across the migration API instead, a new
 *   adapter means finding all of them.
 * - **The order inside `CREATE TABLE` is fixed.** Columns, then the primary
 *   key, then indexes, then foreign keys, then constraints. SQLite in
 *   particular rejects a table constraint that appears before a column it
 *   names, and the ordering bug it produces only shows up on that one adapter.
 *
 * The constraint half is mostly about a fact that has no equivalent in the
 * column half: a constraint can exist without being true yet. `NOT VALID` adds
 * one that applies to new rows immediately and leaves existing rows unchecked,
 * so a table with a hundred million rows gains a constraint without a long
 * exclusive lock, and `VALIDATE CONSTRAINT` does the scan afterwards under a
 * weaker lock. Skipping the second step leaves a constraint the database will
 * not use for planning and never checked the old rows against — which looks
 * exactly like a working constraint until somebody relies on it.
 */

import { singularize } from "@altair/support";

import { keyColumns, type PrimaryKey } from "./composite_key.js";
import {
  addIndexOptions,
  indexAlgorithm,
  type IndexOptions,
  type ResolvedIndex,
} from "./schema_options.js";

// --- definition objects -----------------------------------------------------

/** Rails' `ColumnDefinition`. */
export interface ColumnDefinition {
  name: string;
  type: string;
  options: Record<string, unknown>;
}

/** Rails' `new_column_definition`. */
export function newColumnDefinition(
  name: string,
  type: string,
  options: Record<string, unknown> = {},
): ColumnDefinition {
  return { name, type, options };
}

/**
 * Rails' `PrimaryKeyDefinition`. Named for the definition object rather than
 * the key itself, because `composite_key.ts` already owns `PrimaryKey` — that
 * is the key a model has, this is the clause a `CREATE TABLE` gets.
 */
export interface PrimaryKeyDefinitionData {
  columns: string[];
}

/**
 * Rails' `PrimaryKeyDefinition`.
 *
 * A list even for the usual single `id`, because a composite key is not a
 * different kind of thing and modelling it as one means every consumer has two
 * shapes to handle.
 */
export function primaryKeyDefinition(columns: PrimaryKey): PrimaryKeyDefinitionData {
  return { columns: keyColumns(columns) };
}

export type ReferentialAction = "cascade" | "nullify" | "restrict";

/** Rails' `ForeignKeyDefinition`. */
export interface ForeignKey {
  name: string;
  toTable: string;
  column: string[];
  primaryKey: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  validate: boolean;
  deferrable?: Deferrable;
}

/** Rails' `new_foreign_key_definition`. */
export function newForeignKeyDefinition(
  name: string,
  toTable: string,
  options: {
    column?: string | readonly string[];
    primaryKey?: PrimaryKey;
    onDelete?: ReferentialAction;
    onUpdate?: ReferentialAction;
    validate?: boolean;
    deferrable?: Deferrable;
  } = {},
): ForeignKey {
  return {
    name,
    toTable,
    column: columnList(options.column ?? foreignKeyColumnFor(toTable)),
    primaryKey: columnList(options.primaryKey ?? "id"),
    ...(options.onDelete === undefined ? {} : { onDelete: options.onDelete }),
    ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
    validate: options.validate !== false,
    ...(options.deferrable === undefined ? {} : { deferrable: deferrable(options.deferrable) }),
  };
}

/**
 * Rails' `foreign_key_column_for`.
 *
 * `posts` becomes `post_id`. Derived rather than required, because the column
 * name is the one thing a foreign key declaration would otherwise repeat on
 * every line for no information.
 */
export function foreignKeyColumnFor(table: string): string {
  const name = table.includes(".") ? (table.split(".").at(-1) ?? table) : table;

  return `${singularize(name)}_id`;
}

/** Rails' `CheckConstraintDefinition`. */
export interface CheckConstraint {
  name: string;
  expression: string;
  validate: boolean;
}

/** Rails' `new_check_constraint_definition`. */
export function newCheckConstraintDefinition(
  name: string,
  expression: string,
  options: { validate?: boolean } = {},
): CheckConstraint {
  return { name, expression, validate: options.validate !== false };
}

/** Rails' `UniqueConstraintDefinition`. */
export interface UniqueConstraint {
  name: string;
  columns: string[];
  deferrable?: Deferrable;
  nullsNotDistinct: boolean;
  usingIndex?: string;
}

/** Rails' `new_unique_constraint_definition`. */
export function newUniqueConstraintDefinition(
  name: string,
  columns: string | readonly string[],
  options: {
    deferrable?: Deferrable;
    nullsNotDistinct?: boolean;
    usingIndex?: string;
  } = {},
): UniqueConstraint {
  return {
    name,
    columns: columnList(columns),
    ...(options.deferrable === undefined ? {} : { deferrable: deferrable(options.deferrable) }),
    // Postgres treats two NULLs as distinct by default, so a "unique" column
    // that is nullable accepts any number of rows with no value — which is
    // usually a surprise rather than a decision.
    nullsNotDistinct: options.nullsNotDistinct === true,
    ...(options.usingIndex === undefined ? {} : { usingIndex: options.usingIndex }),
  };
}

/** Rails' `ExclusionConstraintDefinition`. */
export interface ExclusionConstraint {
  name: string;
  expression: string;
  using?: string;
  where?: string;
  deferrable?: Deferrable;
}

/** Rails' `new_exclusion_constraint_definition`. */
export function newExclusionConstraintDefinition(
  name: string,
  expression: string,
  options: { using?: string; where?: string; deferrable?: Deferrable } = {},
): ExclusionConstraint {
  return {
    name,
    expression,
    // GiST rather than the default btree: an exclusion constraint compares with
    // an operator like `&&`, and btree only knows equality and ordering.
    using: options.using ?? "gist",
    ...(options.where === undefined ? {} : { where: options.where }),
    ...(options.deferrable === undefined ? {} : { deferrable: deferrable(options.deferrable) }),
  };
}

export type Deferrable = "immediate" | "deferred";

/**
 * Rails' `assert_valid_deferrable`.
 *
 * `deferred` postpones the check to commit, which is the only way to write a
 * cycle — two rows that reference each other — in one transaction. `immediate`
 * declares the constraint deferrable but leaves it checking per statement, so
 * a later `SET CONSTRAINTS ... DEFERRED` can move it: a constraint that was
 * not declared deferrable cannot be deferred at all, and changing that needs a
 * `DROP` and `ADD`, which takes the lock the deferral was meant to avoid.
 *
 * Anything else raises rather than being ignored, because a misspelt value
 * silently produces a non-deferrable constraint and the failure shows up as a
 * foreign key violation in the middle of an otherwise valid transaction.
 */
export function deferrable(value: unknown): Deferrable {
  if (value === "immediate" || value === "deferred") return value;

  throw new Error(
    `deferrable must be "immediate" or "deferred", got ${JSON.stringify(value)}. A value that is ` +
      `neither would leave the constraint checked per statement, and a constraint not declared ` +
      `deferrable cannot be deferred later without dropping and re-adding it.`,
  );
}

/** Rails' `CreateIndexDefinition`. */
export interface CreateIndex {
  index: ResolvedIndex;
  algorithm?: string;
  ifNotExists: boolean;
}

/** Rails' `CreateIndexDefinition.new`. */
export function createIndexDefinition(
  index: ResolvedIndex,
  algorithm?: string,
  ifNotExists = false,
): CreateIndex {
  return { index, ...(algorithm === undefined ? {} : { algorithm }), ifNotExists };
}

/** Rails' `TableDefinition`. */
export interface TableDefinitionData {
  name: string;
  columns: ColumnDefinition[];
  primaryKeys?: PrimaryKeyDefinitionData;
  indexes: ResolvedIndex[];
  foreignKeys: ForeignKey[];
  checkConstraints: CheckConstraint[];
  uniqueConstraints: UniqueConstraint[];
  exclusionConstraints: ExclusionConstraint[];
  temporary: boolean;
  ifNotExists: boolean;
  options?: string;
  as?: string;
}

/** Rails' `AlterTable`. */
export interface AlterTableData {
  name: string;
  operations: AlterOperationData[];
}

export type AlterOperationData =
  | { kind: "addColumn"; column: ColumnDefinition }
  | { kind: "dropColumn"; name: string }
  | { kind: "renameColumn"; from: string; to: string }
  | { kind: "changeColumnNull"; name: string; null: boolean }
  | { kind: "addForeignKey"; foreignKey: ForeignKey }
  | { kind: "addCheckConstraint"; checkConstraint: CheckConstraint }
  | { kind: "dropConstraint"; name: string }
  | { kind: "validateConstraint"; name: string };

// --- building a definition ---------------------------------------------------

/**
 * Rails' `build_create_table_definition`.
 *
 * Hands back the definition instead of running it. That is what makes a
 * migration reversible and diffable: the change is a value before it is a
 * statement, so something can look at it.
 */
export function buildCreateTableDefinition(
  name: string,
  options: {
    id?: string | false;
    primaryKey?: PrimaryKey;
    temporary?: boolean;
    ifNotExists?: boolean;
    options?: string;
    as?: string;
  } = {},
  block?: (table: TableDefinitionData) => void,
): TableDefinitionData {
  const table: TableDefinitionData = {
    name,
    columns: [],
    indexes: [],
    foreignKeys: [],
    checkConstraints: [],
    uniqueConstraints: [],
    exclusionConstraints: [],
    temporary: options.temporary === true,
    ifNotExists: options.ifNotExists === true,
    ...(options.options === undefined ? {} : { options: options.options }),
    ...(options.as === undefined ? {} : { as: options.as }),
  };

  const id = options.id ?? "primary_key";

  if (id !== false) {
    const columns = options.primaryKey ?? "id";
    table.primaryKeys = primaryKeyDefinition(columns);

    for (const column of table.primaryKeys.columns) {
      table.columns.push(newColumnDefinition(column, id === "primary_key" ? "bigserial" : id));
    }
  }

  block?.(table);

  return table;
}

/** Rails' `build_alter_table_definition`. */
export function buildAlterTableDefinition(
  name: string,
  block?: (alter: AlterTableData) => void,
): AlterTableData {
  const alter: AlterTableData = { name, operations: [] };
  block?.(alter);

  return alter;
}

/** Rails' `build_create_index_definition`. */
export function buildCreateIndexDefinition(
  table: string,
  columns: string | readonly string[],
  {
    adapter = "postgres",
    ifNotExists,
    ...options
  }: IndexOptions & {
    adapter?: string;
    ifNotExists?: boolean;
  } = {},
): CreateIndex {
  const index = addIndexOptions(table, columnList(columns), options);

  // The algorithm is resolved here rather than carried through: `concurrently`
  // is a Postgres word and a MySQL adapter given it verbatim produces a syntax
  // error partway through a migration.
  const algorithm = indexAlgorithm(adapter, options.algorithm);

  return createIndexDefinition(
    index,
    algorithm === "" ? undefined : algorithm,
    ifNotExists === true,
  );
}

/**
 * Rails' `build_create_join_table_definition`.
 *
 * The name is the two tables in lexical order, so `create_join_table` written
 * either way round produces one table rather than two that both half-work. No
 * primary key, because a row in a join table is identified by the pair; an
 * `id` column on it is a column nothing ever reads.
 */
export function buildCreateJoinTableDefinition(
  first: string,
  second: string,
  options: {
    tableName?: string;
    columnOptions?: Record<string, unknown>;
    id?: string | false;
  } = {},
  block?: (table: TableDefinitionData) => void,
): TableDefinitionData {
  const name = options.tableName ?? [first, second].sort().join("_");
  const columnOptions = { null: false, ...options.columnOptions };

  return buildCreateTableDefinition(name, { id: options.id ?? false }, (table) => {
    for (const reference of [first, second]) {
      table.columns.push(
        newColumnDefinition(foreignKeyColumnFor(reference), "bigint", columnOptions),
      );
    }

    block?.(table);
  });
}

/**
 * Rails' `create_table_and_set_flags` — the definition plus what it implies.
 *
 * A join table has no primary key and a table created `as` a query has no
 * column list of its own, and both facts have to travel with the definition:
 * the code that turns it into SQL cannot recover them by looking.
 */
export function createTableAndSetFlags(table: TableDefinitionData): {
  table: TableDefinitionData;
  hasPrimaryKey: boolean;
  fromQuery: boolean;
} {
  return {
    table,
    hasPrimaryKey: table.primaryKeys !== undefined,
    fromQuery: table.as !== undefined,
  };
}

/** Rails' `update_table_definition` — a definition to modify an existing table. */
export function updateTableDefinition(
  name: string,
  block?: (alter: AlterTableData) => void,
): AlterTableData {
  return buildAlterTableDefinition(name, block);
}

/**
 * Rails' `compatible_table_definition`.
 *
 * A definition built for one adapter carries options another cannot express —
 * a MySQL `ENGINE=InnoDB` means nothing to Postgres. Dropped rather than
 * passed through, because passing it through produces a syntax error in a
 * migration that has already applied half its changes.
 */
export function compatibleTableDefinition(
  table: TableDefinitionData,
  adapter: string,
): TableDefinitionData {
  if (adapter === "mysql" || table.options === undefined) return table;

  const { options: _dropped, ...rest } = table;

  return rest;
}

// --- turning it into SQL -----------------------------------------------------

/** What an adapter can express. Rails asks the connection; this is the same set. */
export interface AdapterCapabilities {
  indexesInCreate: boolean;
  foreignKeys: boolean;
  checkConstraints: boolean;
  exclusionConstraints: boolean;
  uniqueConstraints: boolean;
  nullsNotDistinct: boolean;
  partialIndex: boolean;
  indexInclude: boolean;
}

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  indexesInCreate: false,
  foreignKeys: true,
  checkConstraints: true,
  exclusionConstraints: false,
  uniqueConstraints: false,
  nullsNotDistinct: false,
  partialIndex: true,
  indexInclude: false,
};

export interface SchemaCreation {
  accept(node: TableDefinitionData | AlterTableData | CreateIndex): string;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function actionSql(action: string, dependency: ReferentialAction): string {
  switch (dependency) {
    case "nullify":
      return `ON ${action} SET NULL`;
    case "cascade":
      return `ON ${action} CASCADE`;
    case "restrict":
      return `ON ${action} RESTRICT`;
  }
}

/**
 * Rails' `SchemaCreation` — one visitor from definition objects to a statement.
 *
 * Every capability check lives here rather than in the migration API, so
 * adding an adapter means filling in one record instead of finding each check
 * scattered through the code that builds definitions.
 */
export function schemaCreation(capabilities: Partial<AdapterCapabilities> = {}): SchemaCreation {
  const supports = { ...DEFAULT_CAPABILITIES, ...capabilities };

  const visitColumn = (column: ColumnDefinition): string => {
    let sql = `${quote(column.name)} ${column.type}`;

    if (optionsIncludeDefault(column.options)) {
      sql += ` DEFAULT ${formatDefault(column.options["default"])}`;
    }

    if (column.options["null"] === false) sql += " NOT NULL";
    if (column.options["autoIncrement"] === true) sql += " AUTO_INCREMENT";
    if (column.options["primaryKey"] === true) sql += " PRIMARY KEY";

    return sql;
  };

  const visitForeignKey = (key: ForeignKey): string => {
    let sql =
      `CONSTRAINT ${quote(key.name)} FOREIGN KEY (${key.column.map(quote).join(", ")}) ` +
      `REFERENCES ${quote(key.toTable)} (${key.primaryKey.map(quote).join(", ")})`;

    if (key.onDelete !== undefined) sql += ` ${actionSql("DELETE", key.onDelete)}`;
    if (key.onUpdate !== undefined) sql += ` ${actionSql("UPDATE", key.onUpdate)}`;
    if (key.deferrable !== undefined) sql += ` ${deferrableSql(key.deferrable)}`;
    // NOT VALID goes last: it applies the key to new rows now and leaves the
    // existing ones for a later VALIDATE, so a large table gains the key
    // without the long exclusive lock a full scan would take.
    if (!key.validate) sql += " NOT VALID";

    return sql;
  };

  const visitTable = (table: TableDefinitionData): string => {
    const statements: string[] = table.columns.map(visitColumn);

    // The order is fixed rather than incidental: SQLite rejects a table
    // constraint that appears before a column it names, and the resulting bug
    // shows up on that one adapter only.
    if (table.primaryKeys && table.primaryKeys.columns.length > 1) {
      statements.push(`PRIMARY KEY (${table.primaryKeys.columns.map(quote).join(", ")})`);
    }

    if (supports.indexesInCreate) {
      statements.push(...table.indexes.map((index) => indexInCreate(index)));
    }

    if (supports.foreignKeys) statements.push(...table.foreignKeys.map(visitForeignKey));
    if (supports.checkConstraints) statements.push(...table.checkConstraints.map(checkConstraint));
    if (supports.exclusionConstraints) {
      statements.push(...table.exclusionConstraints.map(exclusionConstraint));
    }
    if (supports.uniqueConstraints) {
      statements.push(...table.uniqueConstraints.map(uniqueConstraint));
    }

    let sql = `CREATE${table.temporary ? " TEMPORARY" : ""} TABLE `;
    if (table.ifNotExists) sql += "IF NOT EXISTS ";
    sql += quote(table.name);

    if (statements.length > 0) sql += ` (${statements.join(", ")})`;
    if (table.options !== undefined) sql += ` ${table.options}`;
    if (table.as !== undefined) sql += ` AS ${table.as}`;

    return sql;
  };

  const visitOperation = (operation: AlterOperationData): string => {
    switch (operation.kind) {
      case "addColumn":
        return `ADD ${visitColumn(operation.column)}`;
      case "dropColumn":
        return `DROP COLUMN ${quote(operation.name)}`;
      case "renameColumn":
        return `RENAME COLUMN ${quote(operation.from)} TO ${quote(operation.to)}`;
      case "changeColumnNull":
        return `ALTER COLUMN ${quote(operation.name)} ${operation.null ? "DROP" : "SET"} NOT NULL`;
      case "addForeignKey":
        return `ADD ${visitForeignKey(operation.foreignKey)}`;
      case "addCheckConstraint":
        return `ADD ${checkConstraint(operation.checkConstraint)}`;
      case "dropConstraint":
        return `DROP CONSTRAINT ${quote(operation.name)}`;
      case "validateConstraint":
        return `VALIDATE CONSTRAINT ${quote(operation.name)}`;
    }
  };

  const indexInCreate = (index: ResolvedIndex): string =>
    `${index.unique === true ? "UNIQUE " : ""}INDEX ${quote(index.name)} ` +
    `(${index.columns.map(quote).join(", ")})`;

  const visitCreateIndex = (definition: CreateIndex): string => {
    const { index } = definition;
    const parts = ["CREATE"];

    if (index.unique === true) parts.push("UNIQUE");
    parts.push("INDEX");
    if (definition.algorithm !== undefined) parts.push(definition.algorithm);
    if (definition.ifNotExists) parts.push("IF NOT EXISTS");
    parts.push(`${quote(index.name)} ON ${quote(index.table)}`);
    if (index.using !== undefined) parts.push(`USING ${index.using}`);
    parts.push(`(${index.columns.map(quote).join(", ")})`);
    if (supports.indexInclude && index.include !== undefined) {
      parts.push(`INCLUDE (${index.include.map(quote).join(", ")})`);
    }
    if (supports.nullsNotDistinct && index.nullsNotDistinct === true) {
      parts.push("NULLS NOT DISTINCT");
    }
    // Dropped rather than raising when the adapter cannot express it: the index
    // is still correct, just wider than asked for.
    if (supports.partialIndex && index.where !== undefined) parts.push(`WHERE ${index.where}`);

    return parts.join(" ");
  };

  return {
    accept(node) {
      if ("operations" in node) {
        return `ALTER TABLE ${quote(node.name)} ${node.operations.map(visitOperation).join(", ")}`;
      }

      if ("index" in node) return visitCreateIndex(node);

      return visitTable(node);
    },
  };
}

/**
 * Rails' `options_include_default?`.
 *
 * A default of `undefined` means "not specified"; a default of `null` means
 * "explicitly NULL", which is a different statement and a different column.
 */
export function optionsIncludeDefault(options: Record<string, unknown>): boolean {
  return "default" in options && options["default"] !== undefined;
}

function formatDefault(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return `'${String(value).replaceAll("'", "''")}'`;
}

function deferrableSql(value: Deferrable): string {
  return value === "deferred" ? "DEFERRABLE INITIALLY DEFERRED" : "DEFERRABLE INITIALLY IMMEDIATE";
}

// --- constraints -------------------------------------------------------------

/** Rails' `visit_CheckConstraintDefinition`. */
export function checkConstraint(constraint: CheckConstraint): string {
  const sql = `CONSTRAINT ${quote(constraint.name)} CHECK (${constraint.expression})`;

  return constraint.validate ? sql : `${sql} NOT VALID`;
}

/** Rails' `visit_UniqueConstraintDefinition`. */
export function uniqueConstraint(constraint: UniqueConstraint): string {
  // An existing unique index can be adopted rather than duplicated: building a
  // second index over the same columns doubles the write cost of the table for
  // no additional guarantee.
  if (constraint.usingIndex !== undefined) {
    let sql = `CONSTRAINT ${quote(constraint.name)} UNIQUE USING INDEX ${quote(constraint.usingIndex)}`;
    if (constraint.deferrable !== undefined) sql += ` ${deferrableSql(constraint.deferrable)}`;

    return sql;
  }

  let sql = `CONSTRAINT ${quote(constraint.name)} UNIQUE (${constraint.columns.map(quote).join(", ")})`;
  if (constraint.nullsNotDistinct) sql += " NULLS NOT DISTINCT";
  if (constraint.deferrable !== undefined) sql += ` ${deferrableSql(constraint.deferrable)}`;

  return sql;
}

/** Rails' `visit_ExclusionConstraintDefinition`. */
export function exclusionConstraint(constraint: ExclusionConstraint): string {
  let sql = `CONSTRAINT ${quote(constraint.name)} EXCLUDE`;
  if (constraint.using !== undefined) sql += ` USING ${constraint.using}`;
  sql += ` (${constraint.expression})`;
  if (constraint.where !== undefined) sql += ` WHERE (${constraint.where})`;
  if (constraint.deferrable !== undefined) sql += ` ${deferrableSql(constraint.deferrable)}`;

  return sql;
}

/**
 * Rails' `validate_constraint` — the second half of a `NOT VALID` add.
 *
 * The scan the `NOT VALID` add skipped. Without it the constraint applies to
 * new rows and has never been checked against the old ones, and the database
 * will not use it for query planning — so it looks like a working constraint
 * and is not one.
 */
export function validateConstraint(table: string, name: string): string {
  return `ALTER TABLE ${quote(table)} VALIDATE CONSTRAINT ${quote(name)}`;
}

/** Rails' `validate_check_constraint`. */
export function validateCheckConstraint(table: string, name: string): string {
  return validateConstraint(table, name);
}

/** Rails' `remove_constraint`. */
export function removeConstraint(table: string, name: string): string {
  return `ALTER TABLE ${quote(table)} DROP CONSTRAINT ${quote(name)}`;
}

/** Rails' `drop_check_constraint`. */
export function dropCheckConstraint(table: string, name: string): string {
  return removeConstraint(table, name);
}

/** Rails' `drop_foreign_key`. */
export function dropForeignKey(table: string, name: string): string {
  return removeConstraint(table, name);
}

/**
 * Rails' `change_foreign_key` — drop and re-add, in that order, in one
 * statement.
 *
 * One `ALTER TABLE` rather than two statements because between two the table
 * has no foreign key at all, and a write landing in that window inserts a row
 * the re-added key would have refused. The re-add is `NOT VALID`, so the
 * caller still has to `validateConstraint` — otherwise the rows written before
 * the change were never checked against the new definition.
 */
export function changeForeignKey(table: string, existing: string, replacement: ForeignKey): string {
  const creation = schemaCreation();
  const alter = buildAlterTableDefinition(table, (at) => {
    at.operations.push(
      { kind: "dropConstraint", name: existing },
      { kind: "addForeignKey", foreignKey: { ...replacement, validate: false } },
    );
  });

  return creation.accept(alter);
}

/**
 * Rails' `set_constraints` — defer or resume constraint checking for a
 * transaction.
 *
 * Only affects constraints declared deferrable, which is why `deferrable` is
 * a declaration on the constraint rather than something a transaction can
 * decide alone.
 */
export function setConstraints(when: Deferrable, ...constraints: readonly string[]): string {
  const which = constraints.length === 0 ? "ALL" : constraints.map(quote).join(", ");

  return `SET CONSTRAINTS ${which} ${deferrable(when).toUpperCase()}`;
}

/**
 * Rails' `check_all_foreign_keys_valid!` — the check fixtures run afterwards.
 *
 * Fixtures are inserted with referential integrity disabled, because they
 * reference each other and no insertion order satisfies a cycle. That leaves
 * the possibility of a fixture pointing at a label nothing defines, which
 * would otherwise surface as a `nil` in whichever test happened to follow the
 * association.
 */
export function checkAllForeignKeysValid(violations: readonly { table: string }[]): void {
  if (violations.length === 0) return;

  const tables = [...new Set(violations.map((each) => each.table))];

  throw new Error(
    `Foreign key violations found in fixture data: ${tables.join(", ")}. A fixture referring to ` +
      `a label nothing defines would otherwise surface as a null association in whichever test ` +
      `happened to follow it.`,
  );
}

// --- indexes -----------------------------------------------------------------

/** Rails' `using_index` — adopt an existing index for a unique constraint. */
export function usingIndex(name: string): { usingIndex: string } {
  return { usingIndex: name };
}

/**
 * Rails' `disable_index`.
 *
 * Left in place rather than dropped, so re-enabling does not rebuild it. A
 * bulk load with an index disabled avoids paying the per-row index maintenance
 * cost, and dropping instead would make the load cheap and the restore
 * expensive.
 */
export function disableIndex(table: string, name: string): string {
  return `ALTER TABLE ${quote(table)} ALTER INDEX ${quote(name)} DISABLE`;
}

/** Rails' `enable_index`. */
export function enableIndex(table: string, name: string): string {
  return `ALTER TABLE ${quote(table)} ALTER INDEX ${quote(name)} ENABLE`;
}

// --- virtual tables ----------------------------------------------------------

/**
 * Rails' `create_virtual_table` — SQLite's `fts5` and friends.
 *
 * `IF NOT EXISTS` because a virtual table is usually a search index rebuilt by
 * a migration that may run twice.
 */
export function createVirtualTable(
  name: string,
  moduleName: string,
  values: readonly string[],
): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${quote(name)} USING ${moduleName} (${values.join(", ")})`;
}

/**
 * Rails' `drop_virtual_table`.
 *
 * Takes the module and values it does not use, so a migration written as
 * `drop_virtual_table` can be reversed into the matching `create` — the
 * arguments are there to be recorded, not to be executed.
 */
export function dropVirtualTable(
  name: string,
  _moduleName?: string,
  _values?: readonly string[],
): string {
  return `DROP TABLE ${quote(name)}`;
}

/** Rails' `virtual_table_exists?`. */
export function virtualTableExists(
  name: string,
  tables: readonly { name: string; sql?: string }[],
): boolean {
  const found = tables.find((table) => table.name === name);

  // A virtual table appears in the table list like any other, so the module
  // clause in its DDL is the only thing that distinguishes it — and a plain
  // table answering here would make `dropVirtualTable` drop real data.
  return found !== undefined && /create\s+virtual\s+table/i.test(found.sql ?? "");
}

// --- references ---------------------------------------------------------------

/**
 * Rails' `remove_references` — undo what `t.references` added.
 *
 * The type column goes too when the reference was polymorphic. Removing only
 * the id column leaves a `*_type` column nothing populates, which reads as a
 * column somebody forgot rather than one that used to mean something.
 */
export function removeReferences(
  table: string,
  reference: string,
  options: { polymorphic?: boolean; index?: boolean } = {},
): string[] {
  const statements: string[] = [];

  if (options.index !== false) {
    statements.push(`DROP INDEX ${quote(`index_${table}_on_${reference}`)}`);
  }

  statements.push(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(`${reference}_id`)}`);

  if (options.polymorphic === true) {
    statements.push(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(`${reference}_type`)}`);
  }

  return statements;
}

function columnList(value: string | readonly string[]): string[] {
  return typeof value === "string" ? [value] : [...value];
}
