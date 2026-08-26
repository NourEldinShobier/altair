/**
 * Migrations, ported from `ActiveRecord::Migration` and `SchemaStatements`.
 *
 * The DSL is Rails': a migration declares `up` and `down`, tables are built
 * with a block that names columns by type, and applied versions are recorded in
 * `schema_migrations` so a migration runs once.
 */

import { createHash } from "node:crypto";
import { pluralize, singularize } from "@altair/support";
import type { Connection, Row } from "./connection.js";

export type ColumnType =
  | "string"
  | "text"
  | "integer"
  | "bigint"
  | "float"
  | "decimal"
  | "boolean"
  | "datetime"
  | "date"
  | "json"
  | "binary";

export interface ColumnOptions {
  null?: boolean;
  default?: unknown;
  limit?: number;
  primaryKey?: boolean;
  unique?: boolean;
}

/** What the database does to a child row when its parent is deleted. */
export type ForeignKeyAction = "cascade" | "nullify" | "restrict";

export interface ForeignKeyOptions {
  /** The table referenced. Inferred from the reference's name when omitted. */
  to?: string;
  /** The referenced column. Rails assumes the primary key. */
  primaryKey?: string;
  name?: string;
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
}

export interface ForeignKeyDefinition extends ForeignKeyOptions {
  column: string;
  to: string;
}

/** Rails names these `fk_rails_<hash>`; a readable name says as much. */
export function foreignKeyName(table: string, column: string): string {
  return `fk_${table}_${column}`;
}

function referentialAction(action: ForeignKeyAction): string {
  switch (action) {
    case "cascade":
      return "CASCADE";
    case "nullify":
      return "SET NULL";
    case "restrict":
      return "RESTRICT";
  }
}

/** The `REFERENCES ...` half of a constraint, shared by both ways of adding one. */
function referencesClause(connection: Connection, key: ForeignKeyDefinition): string {
  let clause = `REFERENCES ${connection.quote(key.to)} (${connection.quote(key.primaryKey ?? "id")})`;
  if (key.onDelete) clause += ` ON DELETE ${referentialAction(key.onDelete)}`;
  if (key.onUpdate) clause += ` ON UPDATE ${referentialAction(key.onUpdate)}`;
  return clause;
}

export interface Column extends ColumnOptions {
  name: string;
  type: ColumnType;
}

/** Rails' `t.string :title` and friends. */
export class TableDefinition {
  readonly columns: Column[] = [];
  readonly indexes: { columns: string[]; unique: boolean }[] = [];
  readonly foreignKeys: ForeignKeyDefinition[] = [];

  constructor(readonly name: string) {}

  column(name: string, type: ColumnType, options: ColumnOptions = {}): this {
    this.columns.push({ name, type, ...options });
    return this;
  }

  string(name: string, options?: ColumnOptions): this {
    return this.column(name, "string", options);
  }
  text(name: string, options?: ColumnOptions): this {
    return this.column(name, "text", options);
  }
  integer(name: string, options?: ColumnOptions): this {
    return this.column(name, "integer", options);
  }
  bigint(name: string, options?: ColumnOptions): this {
    return this.column(name, "bigint", options);
  }
  float(name: string, options?: ColumnOptions): this {
    return this.column(name, "float", options);
  }
  decimal(name: string, options?: ColumnOptions): this {
    return this.column(name, "decimal", options);
  }
  boolean(name: string, options?: ColumnOptions): this {
    return this.column(name, "boolean", options);
  }
  datetime(name: string, options?: ColumnOptions): this {
    return this.column(name, "datetime", options);
  }
  date(name: string, options?: ColumnOptions): this {
    return this.column(name, "date", options);
  }
  json(name: string, options?: ColumnOptions): this {
    return this.column(name, "json", options);
  }
  binary(name: string, options?: ColumnOptions): this {
    return this.column(name, "binary", options);
  }

  /**
   * Rails' `t.references :post` — a key column plus its index.
   *
   * The database constraint is opt-in, as it is in Rails: an association is an
   * application-level fact by default, and `foreignKey` is what makes the
   * database enforce it too.
   */
  references(
    name: string,
    options: ColumnOptions & { index?: boolean; foreignKey?: true | ForeignKeyOptions } = {},
  ): this {
    const column = `${name}_id`;
    this.column(column, "bigint", options);
    if (options.index !== false) this.index([column]);

    if (options.foreignKey) {
      const given = options.foreignKey === true ? {} : options.foreignKey;
      this.foreignKeys.push({ ...given, column, to: given.to ?? pluralize(name) });
    }

    return this;
  }

  /** Rails' `t.foreign_key :posts, column: :post_id`. */
  foreignKey(to: string, options: ForeignKeyOptions & { column: string }): this {
    this.foreignKeys.push({ ...options, to });
    return this;
  }

  /** Rails' `t.timestamps`. */
  timestamps(): this {
    this.datetime("created_at", { null: false });
    this.datetime("updated_at", { null: false });
    return this;
  }

  index(columns: string[], options: { unique?: boolean } = {}): this {
    this.indexes.push({ columns, unique: options.unique ?? false });
    return this;
  }
}

/**
 * The shortest identifier limit of the three adapters.
 *
 * MySQL stops at 64 characters, PostgreSQL truncates at 63 without saying so,
 * and SQLite has no limit. Generating a name none of them will refuse means
 * living within the smallest.
 */
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Rails' name for an index, shortened when it has to be.
 *
 * `index_action_text_rich_texts_on_record_type_and_record_id_and_name` is 66
 * characters, so a schema that loads on PostgreSQL is refused by MySQL —
 * which is a migration that works until the day it is run somewhere else.
 * A digest of the full name is appended to the part that fits, so the result
 * is deterministic, unique, and still says which table it belongs to.
 */
export function indexName(table: string, columns: readonly string[]): string {
  const full = `index_${table}_on_${columns.join("_and_")}`;
  if (full.length <= MAX_IDENTIFIER_LENGTH) return full;

  const digest = createHash("sha1").update(full).digest("hex").slice(0, 10);
  return `${full.slice(0, MAX_IDENTIFIER_LENGTH - digest.length - 1)}_${digest}`;
}

/** Maps a logical column type to this adapter's SQL type. */
function sqlType(connection: Connection, column: Column): string {
  const { type, limit } = column;
  const pg = connection.adapter === "postgres";
  const mysql = connection.adapter === "mysql";

  switch (type) {
    case "string":
      return `VARCHAR(${limit ?? 255})`;
    case "text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "bigint":
      return pg ? "BIGINT" : mysql ? "BIGINT" : "INTEGER";
    case "float":
      return pg ? "DOUBLE PRECISION" : "DOUBLE";
    case "decimal":
      return "DECIMAL(10,2)";
    case "boolean":
      return pg ? "BOOLEAN" : mysql ? "TINYINT(1)" : "INTEGER";
    case "datetime":
      // DATETIME without a precision truncates to whole seconds, which makes
      // two saves in the same second indistinguishable — and `updated_at` is
      // meant to distinguish them.
      return pg ? "TIMESTAMP" : mysql ? "DATETIME(6)" : "DATETIME";
    case "date":
      return "DATE";
    case "json":
      return pg ? "JSONB" : "JSON";
    case "binary":
      return pg ? "BYTEA" : "BLOB";
  }
}

/** The auto-incrementing primary key clause, which every adapter spells differently. */
function primaryKeyClause(connection: Connection): string {
  switch (connection.adapter) {
    case "postgres":
      return `${connection.quote("id")} BIGSERIAL PRIMARY KEY`;
    case "mysql":
      return `${connection.quote("id")} BIGINT AUTO_INCREMENT PRIMARY KEY`;
    case "sqlite":
      return `${connection.quote("id")} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
}

/**
 * Raised when an adapter cannot make a change the others can.
 *
 * Its own error rather than a driver message, because the answer is usually a
 * different migration rather than a different adapter, and the message is the
 * only place to say so.
 */
export class UnsupportedSchemaChange extends Error {
  constructor(
    readonly operation: string,
    reason: string,
  ) {
    super(`${operation} is not supported here: ${reason}`);
    this.name = "UnsupportedSchemaChange";
  }
}

/**
 * A default value as SQL.
 *
 * A default cannot be a bound parameter — it is part of the table's
 * definition, not of a statement — so it is written out, and a string is
 * quoted by doubling its quotes rather than escaped by hand.
 */
function defaultLiteral(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  return `'${String(value).replaceAll("'", "''")}'`;
}

export class SchemaStatements {
  constructor(readonly connection: Connection) {}

  async createTable(
    name: string,
    build: (t: TableDefinition) => void,
    options: { id?: boolean; ifNotExists?: boolean } = {},
  ): Promise<void> {
    const table = new TableDefinition(name);
    build(table);

    const parts: string[] = [];
    if (options.id !== false) parts.push(primaryKeyClause(this.connection));

    for (const column of table.columns) {
      let clause = `${this.connection.quote(column.name)} ${sqlType(this.connection, column)}`;
      if (column.null === false) clause += " NOT NULL";
      if (column.unique) clause += " UNIQUE";
      if (column.default !== undefined)
        clause += ` DEFAULT ${literal(this.connection, column.default)}`;
      parts.push(clause);
    }

    for (const key of table.foreignKeys) {
      // Inline rather than a follow-up ALTER, because SQLite cannot add a
      // constraint to a table that already exists.
      parts.push(
        `CONSTRAINT ${this.connection.quote(key.name ?? foreignKeyName(name, key.column))} ` +
          `FOREIGN KEY (${this.connection.quote(key.column)}) ${referencesClause(this.connection, key)}`,
      );
    }

    const exists = options.ifNotExists ? "IF NOT EXISTS " : "";
    await this.connection.execute(
      `CREATE TABLE ${exists}${this.connection.quote(name)} (${parts.join(", ")})`,
    );

    for (const index of table.indexes) {
      await this.addIndex(name, index.columns, { unique: index.unique });
    }
  }

  async dropTable(name: string, options: { ifExists?: boolean } = {}): Promise<void> {
    const exists = options.ifExists ? "IF EXISTS " : "";
    await this.connection.execute(`DROP TABLE ${exists}${this.connection.quote(name)}`);
  }

  async addColumn(
    table: string,
    name: string,
    type: ColumnType,
    options: ColumnOptions = {},
  ): Promise<void> {
    const column: Column = { name, type, ...options };
    let clause = `${this.connection.quote(name)} ${sqlType(this.connection, column)}`;
    if (column.null === false) clause += " NOT NULL";
    if (column.default !== undefined)
      clause += ` DEFAULT ${literal(this.connection, column.default)}`;

    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} ADD COLUMN ${clause}`,
    );
  }

  async removeColumn(table: string, name: string): Promise<void> {
    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} DROP COLUMN ${this.connection.quote(name)}`,
    );
  }

  /**
   * Renames a column. Rails' `rename_column`.
   *
   * The one statement here all three adapters now spell the same way. They did
   * not always: SQLite could not rename a column before 3.25 and MySQL wanted
   * `CHANGE` with the type repeated before 8.0. Both are old enough that
   * carrying the workarounds would be carrying them for nobody.
   */
  async renameColumn(table: string, from: string, to: string): Promise<void> {
    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} RENAME COLUMN ${this.connection.quote(from)} TO ${this.connection.quote(to)}`,
    );
  }

  /**
   * Adds or removes a column's NOT NULL. Rails' `change_column_null`.
   *
   * Postgres and MySQL disagree about more than syntax: MySQL restates the
   * column's whole definition, so it needs the type, and dropping it here
   * would silently reset the column's default along with its nullability.
   */
  async changeColumnNull(
    table: string,
    column: string,
    allowNull: boolean,
    type?: ColumnType,
  ): Promise<void> {
    const quoted = `${this.connection.quote(table)}`;
    const name = this.connection.quote(column);

    if (this.connection.adapter === "sqlite") {
      throw new UnsupportedSchemaChange(
        "changeColumnNull",
        "SQLite cannot alter a column's nullability. Create the table with the constraint, or rebuild it: new table, copy, drop, rename.",
      );
    }

    if (this.connection.adapter === "mysql") {
      if (!type) {
        throw new Error(
          `changeColumnNull needs the column's type on MySQL: it restates the whole definition, and guessing would reset ${column}'s default.`,
        );
      }

      const sql = sqlType(this.connection, { name: column, type } as Column);

      await this.connection.execute(
        `ALTER TABLE ${quoted} MODIFY ${name} ${sql} ${allowNull ? "NULL" : "NOT NULL"}`,
      );
      return;
    }

    await this.connection.execute(
      `ALTER TABLE ${quoted} ALTER COLUMN ${name} ${allowNull ? "DROP" : "SET"} NOT NULL`,
    );
  }

  /**
   * Changes a column's default. Rails' `change_column_default`.
   *
   * `null` removes it, which is a different statement from setting it to NULL
   * on Postgres and the same one on MySQL.
   */
  async changeColumnDefault(table: string, column: string, value: unknown): Promise<void> {
    if (this.connection.adapter === "sqlite") {
      throw new UnsupportedSchemaChange(
        "changeColumnDefault",
        "SQLite cannot alter a column's default. Create the table with it, or rebuild the table.",
      );
    }

    const quoted = this.connection.quote(table);
    const name = this.connection.quote(column);

    if (value === null || value === undefined) {
      await this.connection.execute(`ALTER TABLE ${quoted} ALTER COLUMN ${name} DROP DEFAULT`);
      return;
    }

    await this.connection.execute(
      `ALTER TABLE ${quoted} ALTER COLUMN ${name} SET DEFAULT ${defaultLiteral(value)}`,
    );
  }

  async renameTable(from: string, to: string): Promise<void> {
    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(from)} RENAME TO ${this.connection.quote(to)}`,
    );
  }

  async addIndex(
    table: string,
    columns: string[],
    options: { unique?: boolean; name?: string } = {},
  ): Promise<void> {
    const name = options.name ?? indexName(table, columns);
    const unique = options.unique ? "UNIQUE " : "";
    await this.connection.execute(
      `CREATE ${unique}INDEX ${this.connection.quote(name)} ON ${this.connection.quote(table)} (${columns
        .map((c) => this.connection.quote(c))
        .join(", ")})`,
    );
  }

  async removeIndex(table: string, options: { name: string }): Promise<void> {
    const drop =
      this.connection.adapter === "mysql"
        ? `DROP INDEX ${this.connection.quote(options.name)} ON ${this.connection.quote(table)}`
        : `DROP INDEX ${this.connection.quote(options.name)}`;
    await this.connection.execute(drop);
  }

  /**
   * Rails' `add_foreign_key`.
   *
   * SQLite cannot add a constraint to a table that already exists, so this
   * says so rather than failing with a syntax error — the constraint belongs
   * in `createTable` there.
   */
  async addForeignKey(
    table: string,
    to: string,
    options: ForeignKeyOptions & { column?: string } = {},
  ): Promise<void> {
    if (this.connection.adapter === "sqlite") {
      throw new Error(
        `SQLite cannot add a foreign key to an existing table. Declare it in createTable("${table}") instead.`,
      );
    }

    const column = options.column ?? `${singularize(to)}_id`;
    const name = options.name ?? foreignKeyName(table, column);
    const key: ForeignKeyDefinition = { ...options, column, to };

    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} ADD CONSTRAINT ${this.connection.quote(name)} ` +
        `FOREIGN KEY (${this.connection.quote(column)}) ${referencesClause(this.connection, key)}`,
    );
  }

  /**
   * Rails' `add_check_constraint`.
   *
   * The condition is written into the table definition rather than bound, so
   * it cannot be a parameter — a check is part of the schema, not part of a
   * statement. It is the caller's SQL, which is why the migration file is the
   * only place it should ever come from.
   */
  async addCheckConstraint(
    table: string,
    condition: string,
    options: { name?: string } = {},
  ): Promise<void> {
    if (this.connection.adapter === "sqlite") {
      throw new Error(
        `SQLite cannot add a check constraint to an existing table. Declare it in createTable("${table}") instead.`,
      );
    }

    const name =
      options.name ?? `chk_rails_${table}_${Bun.hash(condition).toString(36).slice(0, 10)}`;

    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} ADD CONSTRAINT ${this.connection.quote(name)} CHECK (${condition})`,
    );
  }

  async removeCheckConstraint(table: string, name: string): Promise<void> {
    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} DROP CONSTRAINT ${this.connection.quote(name)}`,
    );
  }

  /** Rails' `add_unique_constraint`, which is an index everywhere but Postgres. */
  async addUniqueConstraint(
    table: string,
    columns: string | string[],
    options: { name?: string } = {},
  ): Promise<void> {
    const names = Array.isArray(columns) ? columns : [columns];

    await this.addIndex(table, names, { unique: true, ...options });
  }

  /**
   * Rails' `add_timestamps`.
   *
   * Both columns, because a row with one and not the other is worse than a row
   * with neither: everything that reads `updated_at` finds it and everything
   * that sorts by `created_at` does not.
   */
  async addTimestamps(table: string, options: { default?: unknown } = {}): Promise<void> {
    for (const column of ["created_at", "updated_at"]) {
      await this.addColumn(table, column, "datetime", options);
    }
  }

  async removeTimestamps(table: string): Promise<void> {
    for (const column of ["created_at", "updated_at"]) {
      await this.removeColumn(table, column);
    }
  }

  /** Whether an index is there. Rails' `index_exists?`. */
  async indexExists(table: string, columns: string | string[]): Promise<boolean> {
    const names = Array.isArray(columns) ? columns : [columns];
    const wanted = indexName(table, names);

    return (await this.indexes(table)).some((index) => index === wanted);
  }

  /** Every index on a table, by name. */
  async indexes(table: string): Promise<string[]> {
    const connection = this.connection;

    if (connection.adapter === "sqlite") {
      const rows = await connection.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${connection.placeholder(0)}`,
        [table],
      );

      return rows.map((row) => row.name);
    }

    if (connection.adapter === "postgres") {
      const rows = await connection.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = ${connection.placeholder(0)}`,
        [table],
      );

      return rows.map((row) => row.indexname);
    }

    const rows = await connection.query<{ INDEX_NAME: string; index_name: string }>(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${connection.placeholder(0)}`,
      [table],
    );

    return rows.map((row) => row.INDEX_NAME ?? row.index_name);
  }

  /** Rails' `remove_foreign_key`. */
  async removeForeignKey(
    table: string,
    options: { column?: string; to?: string; name?: string } = {},
  ): Promise<void> {
    if (this.connection.adapter === "sqlite") {
      throw new Error(`SQLite cannot drop a foreign key from an existing table.`);
    }

    const column = options.column ?? (options.to ? `${singularize(options.to)}_id` : undefined);
    if (!column && !options.name) {
      throw new Error("removeForeignKey needs a column, a referenced table, or a constraint name.");
    }

    const name = options.name ?? foreignKeyName(table, column!);
    const keyword = this.connection.adapter === "mysql" ? "FOREIGN KEY" : "CONSTRAINT";

    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} DROP ${keyword} ${this.connection.quote(name)}`,
    );
  }

  /** The table names in this database, which the schema dumper reads. */
  async tables(): Promise<string[]> {
    switch (this.connection.adapter) {
      case "sqlite": {
        const rows = await this.connection.query<Row>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        );
        return rows.map((row) => String(row.name));
      }
      case "postgres": {
        const rows = await this.connection.query<Row>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
        );
        return rows.map((row) => String(row.name));
      }
      case "mysql": {
        const rows = await this.connection.query<Row>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
        );
        return rows.map((row) => String(row.name));
      }
    }
  }

  async tableExists(name: string): Promise<boolean> {
    return (await this.tables()).includes(name);
  }
}

/**
 * Renders a default value.
 *
 * Only literals reach this — defaults come from migration source, never from
 * user input, so there is no injection surface. Values from a request are
 * always bound, never interpolated.
 */
function literal(connection: Connection, value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);

  if (typeof value === "boolean") {
    // Postgres has a real boolean type and refuses an integer default for it.
    // SQLite and MySQL store booleans as 0 and 1.
    if (connection.adapter === "postgres") return value ? "TRUE" : "FALSE";
    return value ? "1" : "0";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

/** A single migration. Rails names these by a timestamp version. */
export interface Migration {
  version: string;
  name?: string;
  up: (schema: SchemaStatements) => Promise<void>;
  down?: (schema: SchemaStatements) => Promise<void>;
}

/** Runs migrations and records which have been applied. */
export class Migrator {
  readonly schema: SchemaStatements;

  constructor(
    readonly connection: Connection,
    readonly migrations: Migration[] = [],
  ) {
    this.schema = new SchemaStatements(connection);
  }

  async ensureSchemaTable(): Promise<void> {
    await this.connection.execute(
      `CREATE TABLE IF NOT EXISTS ${this.connection.quote("schema_migrations")} (${this.connection.quote("version")} VARCHAR(255) NOT NULL PRIMARY KEY)`,
    );
  }

  async appliedVersions(): Promise<string[]> {
    await this.ensureSchemaTable();
    const rows = await this.connection.query<Row>(
      `SELECT ${this.connection.quote("version")} FROM ${this.connection.quote("schema_migrations")} ORDER BY ${this.connection.quote("version")}`,
    );
    return rows.map((row) => String(row.version));
  }

  async pending(): Promise<Migration[]> {
    const applied = new Set(await this.appliedVersions());
    return [...this.migrations]
      .sort((a, b) => a.version.localeCompare(b.version))
      .filter((migration) => !applied.has(migration.version));
  }

  /** Runs every pending migration in version order. Rails' `db:migrate`. */
  async up(): Promise<Migration[]> {
    const pending = await this.pending();
    for (const migration of pending) {
      await migration.up(this.schema);
      await this.connection.execute(
        `INSERT INTO ${this.connection.quote("schema_migrations")} (${this.connection.quote("version")}) VALUES (${this.connection.placeholder(0)})`,
        [migration.version],
      );
    }
    return pending;
  }

  /** Rolls back the last applied migration. Rails' `db:rollback`. */
  async down(steps = 1): Promise<Migration[]> {
    const applied = await this.appliedVersions();
    const toRevert = applied.slice(-steps).reverse();
    const reverted: Migration[] = [];

    for (const version of toRevert) {
      const migration = this.migrations.find((m) => m.version === version);
      if (!migration) continue;
      if (!migration.down) {
        throw new Error(`Migration ${version} is irreversible: it defines no down().`);
      }
      await migration.down(this.schema);
      await this.connection.execute(
        `DELETE FROM ${this.connection.quote("schema_migrations")} WHERE ${this.connection.quote("version")} = ${this.connection.placeholder(0)}`,
        [version],
      );
      reverted.push(migration);
    }
    return reverted;
  }
}
