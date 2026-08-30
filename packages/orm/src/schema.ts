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
import { ADAPTERS, maxIdentifierLength, type Capabilities } from "./capabilities.js";
import { columnTypeFor } from "./dump.js";
import { columnSchemas, indexSchemas, type ColumnSchema } from "./introspect.js";

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

/**
 * The block `changeTable` yields. Rails' `Table`.
 *
 * Each call records what to do; nothing runs until the block has returned.
 * That is what keeps the block synchronous, and a synchronous block is what
 * makes a forgotten `await` impossible rather than merely unlikely.
 */
export class TableChange {
  readonly operations: ((schema: SchemaStatements, table: string) => Promise<void>)[] = [];

  column(name: string, type: ColumnType, options: ColumnOptions = {}): this {
    this.operations.push((schema, table) => schema.addColumn(table, name, type, options));
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

  date(name: string, options?: ColumnOptions): this {
    return this.column(name, "date", options);
  }

  datetime(name: string, options?: ColumnOptions): this {
    return this.column(name, "datetime", options);
  }

  json(name: string, options?: ColumnOptions): this {
    return this.column(name, "json", options);
  }

  binary(name: string, options?: ColumnOptions): this {
    return this.column(name, "binary", options);
  }

  /** Changes a column's type. Rails' `t.change`. */
  change(name: string, type: ColumnType, options: ColumnOptions = {}): this {
    this.operations.push((schema, table) => schema.changeColumn(table, name, type, options));
    return this;
  }

  /** Rails' `t.change_default`. */
  changeDefault(name: string, value: unknown): this {
    this.operations.push((schema, table) => schema.changeColumnDefault(table, name, value));
    return this;
  }

  /** Rails' `t.remove`, which takes several. */
  remove(...names: string[]): this {
    for (const name of names) {
      this.operations.push((schema, table) => schema.removeColumn(table, name));
    }

    return this;
  }

  /** Rails' `t.rename`. */
  rename(from: string, to: string): this {
    this.operations.push((schema, table) => schema.renameColumn(table, from, to));
    return this;
  }

  index(columns: string[], options: { unique?: boolean; name?: string } = {}): this {
    this.operations.push((schema, table) => schema.addIndex(table, columns, options));
    return this;
  }

  /** Rails' `t.remove_index`, by name — which is how the index was created. */
  removeIndex(name: string): this {
    this.operations.push((schema, table) => schema.removeIndex(table, { name }));
    return this;
  }

  /** Rails' `t.references`, which adds the column, the index and the key. */
  reference(
    name: string,
    options: {
      type?: ColumnType;
      null?: boolean;
      index?: boolean;
      unique?: boolean;
      foreignKey?: boolean | { to: string };
      polymorphic?: boolean;
    } = {},
  ): this {
    this.operations.push((schema, table) => schema.addReference(table, name, options));
    return this;
  }

  removeReference(name: string, options: { polymorphic?: boolean } = {}): this {
    this.operations.push((schema, table) => schema.removeReference(table, name, options));
    return this;
  }

  timestamps(): this {
    this.operations.push((schema, table) => schema.addTimestamps(table));
    return this;
  }
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
 * and SQLite has no practical limit. Generating a name none of them will
 * refuse means living within the smallest, so this is derived from the
 * per-adapter numbers rather than written out again beside them — one place to
 * correct when a server moves its limit.
 */
export const MAX_IDENTIFIER_LENGTH = Math.min(
  ...ADAPTERS.map((adapter) => maxIdentifierLength(adapter)),
);

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

/** A comment as a SQL literal, or NULL to remove it. */
function commentLiteral(comment: string | null): string {
  return comment === null ? "NULL" : `'${comment.replaceAll("'", "''")}'`;
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
    // SQLite refuses to drop a column an index depends on, where Postgres and
    // MySQL drop the index along with it. Dropped here so the three behave the
    // same: a caller removing a column should not have to know which indexes
    // happened to mention it, and the index is worthless without the column.
    if (this.connection.adapter === "sqlite") {
      for (const index of await indexSchemas(this.connection, table)) {
        if (!index.columns.includes(name)) continue;
        if (index.name.startsWith("sqlite_")) continue;

        await this.removeIndex(table, { name: index.name });
      }
    }

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
   * Several changes to one table. Rails' `change_table`.
   *
   *     await schema.changeTable("posts", (t) => {
   *       t.string("slug")
   *       t.reference("author", { foreignKey: { to: "users" } })
   *       t.index(["slug"], { unique: true })
   *       t.remove("legacy_id")
   *     })
   *
   * Recorded and then run in order rather than executed as the block reads
   * them, which is what lets the block be synchronous — a migration written
   * with `await` on every line is mostly punctuation, and forgetting one is a
   * change that silently does not happen.
   */
  async changeTable(table: string, define: (t: TableChange) => void): Promise<void> {
    const change = new TableChange();
    define(change);

    for (const operation of change.operations) await operation(this, table);
  }

  /** Every column on a table, as the database describes it. Rails' `columns`. */
  async columns(table: string): Promise<ColumnSchema[]> {
    return await columnSchemas(this.connection, table);
  }

  /**
   * Whether a table has this column. Rails' `column_exists?`.
   *
   * The check a migration makes before adding something twice — which is what
   * happens when one is re-run against a database that was patched by hand,
   * and the failure without it is a driver syntax error rather than a
   * migration saying what it found.
   */
  async columnExists(table: string, column: string, type?: ColumnType): Promise<boolean> {
    const found = (await this.columns(table)).find((one) => one.name === column);

    if (!found) return false;
    if (type === undefined) return true;

    // Mapped back to a logical type rather than compared as SQL. The three
    // databases answer in their own spellings — `character varying`, `int`,
    // `TINYINT(1)` — and a caller asking "is this a string?" should not have to
    // know which one it is talking to. Comparing the SQL text instead is a
    // check that passes on SQLite and fails on the other two, which is exactly
    // what it did before CI ran this against all three.
    return columnTypeFor(found.type) === type;
  }

  /**
   * Changes a column's type. Rails' `change_column`.
   *
   * The three adapters differ in kind, not only in syntax. Postgres alters the
   * type in place, MySQL restates the whole column definition, and SQLite
   * cannot alter a column at all — so there the table is rebuilt, which is
   * what Rails' SQLite adapter does and the only reason `change_column` works
   * on a developer's own machine.
   */
  async changeColumn(
    table: string,
    column: string,
    type: ColumnType,
    options: ColumnOptions = {},
  ): Promise<void> {
    const definition: Column = { name: column, type, ...options };
    const quoted = this.connection.quote(table);
    const name = this.connection.quote(column);
    const sql = sqlType(this.connection, definition);

    if (this.connection.adapter === "postgres") {
      // USING, so a change that needs a cast — text to integer — is made
      // rather than refused. Postgres will not guess; the other two always do.
      await this.connection.execute(
        `ALTER TABLE ${quoted} ALTER COLUMN ${name} TYPE ${sql} USING ${name}::${sql}`,
      );

      if (options.null !== undefined) await this.changeColumnNull(table, column, options.null);
      if (options.default !== undefined) {
        await this.changeColumnDefault(table, column, options.default);
      }

      return;
    }

    if (this.connection.adapter === "mysql") {
      // Restated whole, because MySQL's MODIFY replaces the definition: naming
      // only the type here would silently drop the column's NOT NULL and its
      // default along with it.
      let clause = `${name} ${sql}`;
      if (definition.null === false) clause += " NOT NULL";
      if (definition.default !== undefined) {
        clause += ` DEFAULT ${literal(this.connection, definition.default)}`;
      }

      await this.connection.execute(`ALTER TABLE ${quoted} MODIFY COLUMN ${clause}`);
      return;
    }

    await this.rebuildSqliteTable(table, (existing) =>
      existing.map((one) =>
        one.name === column
          ? {
              ...one,
              type: sql,
              nullable: definition.null !== false,
              default:
                definition.default === undefined
                  ? one.default
                  : literal(this.connection, definition.default),
            }
          : one,
      ),
    );
  }

  /**
   * Rebuilds a SQLite table around a changed column list.
   *
   * SQLite's `ALTER TABLE` can add, drop and rename a column and nothing else,
   * so every other change is: build the new table, copy the rows across, drop
   * the old one, rename. Rails walks the same twelve steps.
   *
   * Indexes and foreign keys are read first and put back afterwards. Without
   * that the rebuild silently drops them, and a table that lost its unique
   * index looks fine until two rows collide months later.
   */
  private async rebuildSqliteTable(
    table: string,
    change: (columns: ColumnSchema[]) => ColumnSchema[],
  ): Promise<void> {
    const quote = (name: string) => this.connection.quote(name);
    const existing = await columnSchemas(this.connection, table);
    const indexes = await indexSchemas(this.connection, table);
    const keys = await this.connection.query<Row>(`PRAGMA foreign_key_list(${quote(table)})`);

    const wanted = change(existing);
    const carried = wanted.filter((one) => existing.some((was) => was.name === one.name));
    const temporary = `${table}_altair_rebuild`;

    const clauses = wanted.map((one) => {
      let clause = `${quote(one.name)} ${one.type}`;
      if (one.primaryKey) clause += " PRIMARY KEY AUTOINCREMENT";
      else if (!one.nullable) clause += " NOT NULL";
      if (one.default !== null) clause += ` DEFAULT ${one.default}`;

      return clause;
    });

    for (const key of keys) {
      clauses.push(
        `FOREIGN KEY (${quote(String(key.from))}) REFERENCES ${quote(String(key.table))}(${quote(String(key.to))})`,
      );
    }

    // Off for the rebuild, or dropping the old table trips every key pointing
    // at it — including the ones about to be put back.
    await this.connection.execute("PRAGMA foreign_keys = OFF");

    try {
      await this.connection.execute(`CREATE TABLE ${quote(temporary)} (${clauses.join(", ")})`);

      const names = carried.map((one) => quote(one.name)).join(", ");
      await this.connection.execute(
        `INSERT INTO ${quote(temporary)} (${names}) SELECT ${names} FROM ${quote(table)}`,
      );

      await this.connection.execute(`DROP TABLE ${quote(table)}`);
      await this.connection.execute(`ALTER TABLE ${quote(temporary)} RENAME TO ${quote(table)}`);

      for (const index of indexes) {
        // SQLite names the index behind a UNIQUE constraint `sqlite_autoindex_…`,
        // and that prefix is reserved: recreating one by that name is an error,
        // and the constraint came back with the column anyway.
        if (index.name.startsWith("sqlite_")) continue;

        await this.addIndex(table, index.columns, { unique: index.unique, name: index.name });
      }
    } finally {
      await this.connection.execute("PRAGMA foreign_keys = ON");
    }
  }

  /**
   * Adds a foreign-key column and its index. Rails' `add_reference`.
   *
   *     await schema.addReference("posts", "user", { foreignKey: true })
   *
   * The index is the point. A `user_id` with no index is the commonest cause
   * of a slow `user.posts` — every read of the association scans the whole
   * table — and it stays invisible until the table is large.
   */
  async addReference(
    table: string,
    name: string,
    options: {
      type?: ColumnType;
      null?: boolean;
      index?: boolean;
      unique?: boolean;
      foreignKey?: boolean | { to: string };
      polymorphic?: boolean;
    } = {},
  ): Promise<void> {
    const column = `${name}_id`;

    await this.addColumn(table, column, options.type ?? "bigint", { null: options.null });

    if (options.polymorphic) {
      await this.addColumn(table, `${name}_type`, "string", { null: options.null });
    }

    if (options.index !== false) {
      // Type first for a polymorphic one, matching Rails: an index is usable
      // left-to-right, and every query on it names the type.
      const columns = options.polymorphic ? [`${name}_type`, column] : [column];
      await this.addIndex(table, columns, { unique: options.unique ?? false });
    }

    if (options.foreignKey) {
      if (options.polymorphic) {
        throw new UnsupportedSchemaChange(
          "addReference",
          "a polymorphic reference points at more than one table, so no one foreign key can describe it",
        );
      }

      const to = typeof options.foreignKey === "object" ? options.foreignKey.to : pluralize(name);
      await this.addForeignKey(table, to, { column });
    }
  }

  /** Removes a reference column and its type column. Rails' `remove_reference`. */
  async removeReference(
    table: string,
    name: string,
    options: { polymorphic?: boolean } = {},
  ): Promise<void> {
    if (options.polymorphic) await this.removeColumn(table, `${name}_type`);

    await this.removeColumn(table, `${name}_id`);
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

  /**
   * Writes a note against a table. Rails' `change_table_comment`.
   *
   * Stored in the database rather than in a migration file, which is the point:
   * every tool that looks at the schema — psql, a GUI client, whatever the
   * analytics team uses — shows it, and a comment that lives only in a
   * migration is a comment only somebody reading the repository will find.
   *
   * SQLite has no comment support at all. It is refused rather than silently
   * skipped, because a schema that quietly loses its documentation on one
   * adapter is a schema whose documentation nobody can rely on.
   */
  async changeTableComment(table: string, comment: string | null): Promise<void> {
    this.#requireComments("changeTableComment");

    await this.connection.execute(
      `COMMENT ON TABLE ${this.connection.quote(table)} IS ${commentLiteral(comment)}`,
    );
  }

  /** The same for one column. Rails' `change_column_comment`. */
  async changeColumnComment(table: string, column: string, comment: string | null): Promise<void> {
    this.#requireComments("changeColumnComment");

    await this.connection.execute(
      `COMMENT ON COLUMN ${this.connection.quote(table)}.${this.connection.quote(column)} IS ${commentLiteral(comment)}`,
    );
  }

  /** What a table's comment says, or undefined. Rails' `table_comment`. */
  async tableComment(table: string): Promise<string | undefined> {
    if (this.connection.adapter !== "postgres") return undefined;

    const rows = await this.connection.query<Row>(
      `SELECT obj_description(${this.connection.placeholder(0)}::regclass, 'pg_class') AS comment`,
      [table],
    );
    const comment = rows[0]?.comment;

    return comment === null || comment === undefined ? undefined : String(comment);
  }

  #requireComments(operation: string): void {
    if (this.connection.adapter === "postgres") return;

    throw new UnsupportedSchemaChange(
      operation,
      `${this.connection.adapter} has no schema comments. Keep the note in the migration instead.`,
    );
  }

  /**
   * Runs a block with foreign keys not enforced. Rails'
   * `disable_referential_integrity`.
   *
   * What loading fixtures needs. A set of fixtures references itself in every
   * direction — a post's author, an author's favourite post — so there is no
   * insertion order that satisfies every constraint, and sorting them is
   * solving a graph problem to avoid a switch the database already has.
   *
   * Turned back on in a `finally`, and that is the whole safety of it: a
   * connection left with checks off is a connection that will accept broken
   * data for the rest of its life, and nothing about the eventual corruption
   * points back here.
   */
  async disableReferentialIntegrity<T>(body: () => Promise<T>): Promise<T> {
    const off = this.#referentialIntegrityStatement(false);
    const on = this.#referentialIntegrityStatement(true);

    if (off === undefined || on === undefined) return await body();

    await this.connection.execute(off);

    try {
      return await body();
    } finally {
      await this.connection.execute(on);
    }
  }

  #referentialIntegrityStatement(enabled: boolean): string | undefined {
    switch (this.connection.adapter) {
      case "sqlite":
        return `PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`;
      case "mysql":
        return `SET FOREIGN_KEY_CHECKS = ${enabled ? "1" : "0"}`;
      default:
        // PostgreSQL has no session-wide switch that an ordinary user may
        // throw: `session_replication_role` needs superuser. Rails disables
        // each table's triggers instead, which needs ownership of every table
        // — so the honest answer here is that this connection cannot, and the
        // caller gets its block run with the constraints still on rather than
        // a statement that will fail.
        return undefined;
    }
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

  /**
   * The name Rails gives a join table for two others.
   *
   * Sorted, so `createJoinTable("users", "posts")` and the same call with the
   * arguments the other way round name the same table — a migration and the
   * model that reads it are written by different people on different days, and
   * neither should have to remember an order.
   *
   * A shared prefix is written once: `admin_posts` and `admin_users` join as
   * `admin_posts_users`, not `admin_posts_admin_users`. Rails does this with a
   * regular expression over a NUL-joined pair, and this is the same rule.
   */
  static joinTableName(first: string, second: string): string {
    const [a, b] = [first, second].sort() as [string, string];
    const joined = `${a}\0${b}`;

    return joined.replace(/^(.*[_.])(.+)\0\1(.+)$/, "$1$2_$3").replace("\0", "_");
  }

  /**
   * The table behind a `hasAndBelongsToMany`. Rails' `create_join_table`.
   *
   * No primary key, because a join row has no identity of its own — it is the
   * pair. Both columns are NOT NULL, since a join row missing half of the pair
   * joins nothing and is only ever a bug that outlived the code that wrote it.
   */
  async createJoinTable(
    first: string,
    second: string,
    options: { tableName?: string; columnOptions?: ColumnOptions } = {},
    define?: (t: TableDefinition) => void,
  ): Promise<void> {
    const name = options.tableName ?? SchemaStatements.joinTableName(first, second);
    const columnOptions = { null: false, ...options.columnOptions };

    await this.createTable(
      name,
      (t) => {
        t.references(singularize(first), columnOptions);
        t.references(singularize(second), columnOptions);
        define?.(t);
      },
      { id: false },
    );
  }

  /** Rails' `drop_join_table`. */
  async dropJoinTable(
    first: string,
    second: string,
    options: { tableName?: string; ifExists?: boolean } = {},
  ): Promise<void> {
    const name = options.tableName ?? SchemaStatements.joinTableName(first, second);

    await this.dropTable(name, { ifExists: options.ifExists });
  }

  /**
   * Renames an index. Rails' `rename_index`.
   *
   * Built rather than renamed in place, because only PostgreSQL has a direct
   * ALTER INDEX ... RENAME and doing it the naive way works everywhere: create
   * the new one with the same columns and uniqueness, then drop the old. Rails
   * says the same thing in a comment on the same method.
   *
   * The new index is created first. Dropping first would leave the table
   * unindexed for the length of the build, which on a large table is exactly
   * when the queries that needed it are slowest.
   */
  async renameIndex(table: string, from: string, to: string): Promise<void> {
    const existing = (await indexSchemas(this.connection, table)).find((one) => one.name === from);
    if (!existing) return;

    await this.addIndex(table, existing.columns, { name: to, unique: existing.unique });
    await this.removeIndex(table, { name: from });
  }

  /** Whether an index of this name is there. Rails' `index_name_exists?`. */
  async indexNameExists(table: string, name: string): Promise<boolean> {
    return (await this.indexes(table)).includes(name);
  }

  /**
   * Several columns in one go. Rails' `remove_columns`.
   *
   * One statement per column on the adapters that cannot batch, which is most
   * of them, but one call in the migration — and one place for a rollback to
   * put them back.
   */
  async removeColumns(table: string, ...names: string[]): Promise<void> {
    for (const name of names) await this.removeColumn(table, name);
  }

  /** Whether a foreign key is there. Rails' `foreign_key_exists?`. */
  async foreignKeyExists(
    table: string,
    options: { column?: string; to?: string; name?: string },
  ): Promise<boolean> {
    const wanted =
      options.name ??
      `fk_${table}_${options.column ?? (options.to ? `${singularize(options.to)}_id` : "")}`;

    return (await this.foreignKeys(table)).some(
      (one) => one === wanted || (options.column !== undefined && one.includes(options.column)),
    );
  }

  /** Every foreign key on a table, by name. */
  async foreignKeys(table: string): Promise<string[]> {
    const connection = this.connection;

    if (!connection.supportsForeignKeys) return [];

    switch (connection.adapter) {
      case "sqlite": {
        // SQLite reports foreign keys positionally rather than by name, so the
        // "name" is the column it is on. Nothing else is available, and an
        // empty answer would make foreignKeyExists always false.
        const rows = await connection.query<Row>(
          `PRAGMA foreign_key_list(${connection.quote(table)})`,
        );
        return rows.map((row) => String(row.from));
      }
      case "postgres": {
        const rows = await connection.query<Row>(
          `SELECT conname AS name FROM pg_constraint
           WHERE contype = 'f' AND conrelid = ${connection.placeholder(0)}::regclass`,
          [table],
        );
        return rows.map((row) => String(row.name));
      }
      case "mysql": {
        const rows = await connection.query<Row>(
          `SELECT constraint_name AS name FROM information_schema.table_constraints
           WHERE constraint_type = 'FOREIGN KEY' AND table_schema = DATABASE()
             AND table_name = ${connection.placeholder(0)}`,
          [table],
        );
        return rows.map((row) => String(row.name));
      }
    }
  }

  /** Whether a check constraint is there. Rails' `check_constraint_exists?`. */
  async checkConstraintExists(table: string, name: string): Promise<boolean> {
    return (await this.constraintNames(table, "CHECK")).includes(name);
  }

  /** Whether a unique constraint is there. Rails' `unique_constraint_exists?`. */
  async uniqueConstraintExists(table: string, name: string): Promise<boolean> {
    if (await this.indexNameExists(table, name)) return true;

    return (await this.constraintNames(table, "UNIQUE")).includes(name);
  }

  /** Drops a unique constraint. Rails' `remove_unique_constraint`. */
  async removeUniqueConstraint(table: string, name: string): Promise<void> {
    await this.removeIndex(table, { name });
  }

  /** Named constraints of one kind, for the adapters that report them. */
  async constraintNames(table: string, kind: "CHECK" | "UNIQUE"): Promise<string[]> {
    const connection = this.connection;

    switch (connection.adapter) {
      case "postgres": {
        const rows = await connection.query<Row>(
          `SELECT conname AS name FROM pg_constraint
           WHERE contype = ${connection.placeholder(0)} AND conrelid = ${connection.placeholder(1)}::regclass`,
          [kind === "CHECK" ? "c" : "u", table],
        );
        return rows.map((row) => String(row.name));
      }
      case "mysql": {
        const rows = await connection.query<Row>(
          `SELECT constraint_name AS name FROM information_schema.table_constraints
           WHERE constraint_type = ${connection.placeholder(0)} AND table_schema = DATABASE()
             AND table_name = ${connection.placeholder(1)}`,
          [kind, table],
        );
        return rows.map((row) => String(row.name));
      }
      case "sqlite":
        // SQLite keeps constraints in the table's original CREATE statement and
        // has no catalog for them. Reading the DDL back and parsing it would be
        // a SQL parser, so this reports none rather than half-answering.
        return [];
    }
  }

  /**
   * Adds an EXCLUDE constraint. Rails' `add_exclusion_constraint`.
   *
   * PostgreSQL only, and this says so rather than emitting SQL the others will
   * reject with a syntax error that names a column instead of the feature.
   */
  async addExclusionConstraint(
    table: string,
    expression: string,
    options: { name?: string; using?: string; where?: string } = {},
  ): Promise<void> {
    this.#require("exclusionConstraints", "addExclusionConstraint");

    const name = options.name ?? `excl_rails_${table}`;
    const using = options.using ? ` USING ${options.using}` : "";
    const where = options.where ? ` WHERE (${options.where})` : "";

    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} ADD CONSTRAINT ${this.connection.quote(name)} ` +
        `EXCLUDE${using} (${expression})${where}`,
    );
  }

  /** Rails' `remove_exclusion_constraint`. */
  async removeExclusionConstraint(table: string, name: string): Promise<void> {
    this.#require("exclusionConstraints", "removeExclusionConstraint");

    await this.connection.execute(
      `ALTER TABLE ${this.connection.quote(table)} DROP CONSTRAINT ${this.connection.quote(name)}`,
    );
  }

  /** Rails' `exclusion_constraint_exists?`. */
  async exclusionConstraintExists(table: string, name: string): Promise<boolean> {
    if (!this.connection.supportsExclusionConstraints) return false;

    const rows = await this.connection.query<Row>(
      `SELECT conname AS name FROM pg_constraint
       WHERE contype = 'x' AND conrelid = ${this.connection.placeholder(0)}::regclass`,
      [table],
    );

    return rows.some((row) => String(row.name) === name);
  }

  /**
   * Creates an enum type. Rails' `create_enum`.
   *
   * PostgreSQL only. Elsewhere the same job is a CHECK constraint on a string
   * column, which is why this refuses rather than silently doing something
   * else: a schema that quietly means a different thing on another adapter is
   * worse than one that will not load.
   */
  async createEnum(name: string, values: readonly string[]): Promise<void> {
    this.#require("extensions", "createEnum");

    const literals = values.map((one) => `'${one.replaceAll("'", "''")}'`).join(", ");

    await this.connection.execute(
      `CREATE TYPE ${this.connection.quote(name)} AS ENUM (${literals})`,
    );
  }

  /** Rails' `drop_enum`. */
  async dropEnum(name: string, options: { ifExists?: boolean } = {}): Promise<void> {
    this.#require("extensions", "dropEnum");

    await this.connection.execute(
      `DROP TYPE ${options.ifExists ? "IF EXISTS " : ""}${this.connection.quote(name)}`,
    );
  }

  /** Rails' `rename_enum`. */
  async renameEnum(from: string, to: string): Promise<void> {
    this.#require("extensions", "renameEnum");

    await this.connection.execute(
      `ALTER TYPE ${this.connection.quote(from)} RENAME TO ${this.connection.quote(to)}`,
    );
  }

  /**
   * Adds a value to an enum. Rails' `add_enum_value`.
   *
   * Position matters, because an enum's order is what comparisons and ORDER BY
   * use — appending is not the same schema as inserting before an existing
   * value, and a migration that got it wrong sorts wrongly ever after.
   */
  async addEnumValue(
    name: string,
    value: string,
    options: { before?: string; after?: string; ifNotExists?: boolean } = {},
  ): Promise<void> {
    this.#require("extensions", "addEnumValue");

    const where = options.before
      ? ` BEFORE '${options.before.replaceAll("'", "''")}'`
      : options.after
        ? ` AFTER '${options.after.replaceAll("'", "''")}'`
        : "";

    await this.connection.execute(
      `ALTER TYPE ${this.connection.quote(name)} ADD VALUE ${options.ifNotExists ? "IF NOT EXISTS " : ""}` +
        `'${value.replaceAll("'", "''")}'${where}`,
    );
  }

  /** Rails' `rename_enum_value`. */
  async renameEnumValue(name: string, from: string, to: string): Promise<void> {
    this.#require("extensions", "renameEnumValue");

    await this.connection.execute(
      `ALTER TYPE ${this.connection.quote(name)} RENAME VALUE ` +
        `'${from.replaceAll("'", "''")}' TO '${to.replaceAll("'", "''")}'`,
    );
  }

  /** Turns on a server extension. Rails' `enable_extension`. */
  async enableExtension(name: string): Promise<void> {
    this.#require("extensions", "enableExtension");

    await this.connection.execute(`CREATE EXTENSION IF NOT EXISTS ${this.connection.quote(name)}`);
  }

  /** Rails' `disable_extension`. */
  async disableExtension(name: string): Promise<void> {
    this.#require("extensions", "disableExtension");

    await this.connection.execute(`DROP EXTENSION IF EXISTS ${this.connection.quote(name)}`);
  }

  /** Every extension turned on. Rails' `extensions`. */
  async extensions(): Promise<string[]> {
    if (!this.connection.supportsExtensions) return [];

    const rows = await this.connection.query<Row>("SELECT extname AS name FROM pg_extension");

    return rows.map((row) => String(row.name));
  }

  /** Rails' `extension_enabled?`. */
  async extensionEnabled(name: string): Promise<boolean> {
    return (await this.extensions()).includes(name);
  }

  /**
   * Empties a table without dropping it. Rails' `truncate`.
   *
   * SQLite has no TRUNCATE, and DELETE without a WHERE is what it does
   * instead — the same outcome by a slower route, which is the right trade for
   * a database that is usually a test fixture.
   */
  async truncateTable(table: string): Promise<void> {
    const quoted = this.connection.quote(table);

    await this.connection.execute(
      this.connection.adapter === "sqlite" ? `DELETE FROM ${quoted}` : `TRUNCATE TABLE ${quoted}`,
    );
  }

  /** Rails' `truncate_tables`. */
  async truncateTables(...tables: string[]): Promise<void> {
    for (const table of tables) await this.truncateTable(table);
  }

  /** Every view. Rails' `views`. */
  async views(): Promise<string[]> {
    const connection = this.connection;

    switch (connection.adapter) {
      case "sqlite": {
        const rows = await connection.query<Row>(
          "SELECT name FROM sqlite_master WHERE type = 'view'",
        );
        return rows.map((row) => String(row.name));
      }
      case "postgres": {
        const rows = await connection.query<Row>(
          "SELECT viewname AS name FROM pg_views WHERE schemaname = 'public'",
        );
        return rows.map((row) => String(row.name));
      }
      case "mysql": {
        const rows = await connection.query<Row>(
          `SELECT table_name AS name FROM information_schema.views
           WHERE table_schema = DATABASE()`,
        );
        return rows.map((row) => String(row.name));
      }
    }
  }

  /** Rails' `view_exists?`. */
  async viewExists(name: string): Promise<boolean> {
    return (await this.views()).includes(name);
  }

  /**
   * Everything a SELECT can read from. Rails' `data_sources`.
   *
   * Tables and views together, which is the question a model actually asks:
   * it does not care which one it was told to read, only that reading works.
   */
  async dataSources(): Promise<string[]> {
    return [...(await this.tables()), ...(await this.views())];
  }

  /** Rails' `data_source_exists?`. */
  async dataSourceExists(name: string): Promise<boolean> {
    return (await this.dataSources()).includes(name);
  }

  /** Every schema. Rails' `schema_names`. */
  async schemaNames(): Promise<string[]> {
    if (this.connection.adapter !== "postgres") return [];

    const rows = await this.connection.query<Row>(
      `SELECT nspname AS name FROM pg_namespace
       WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'`,
    );

    return rows.map((row) => String(row.name));
  }

  /** Rails' `schema_exists?`. */
  async schemaExists(name: string): Promise<boolean> {
    return (await this.schemaNames()).includes(name);
  }

  /** Rails' `create_schema`. */
  async createSchema(name: string, options: { ifNotExists?: boolean } = {}): Promise<void> {
    this.#require("extensions", "createSchema");

    await this.connection.execute(
      `CREATE SCHEMA ${options.ifNotExists ? "IF NOT EXISTS " : ""}${this.connection.quote(name)}`,
    );
  }

  /** Rails' `drop_schema`. */
  async dropSchema(name: string, options: { ifExists?: boolean } = {}): Promise<void> {
    this.#require("extensions", "dropSchema");

    await this.connection.execute(
      `DROP SCHEMA ${options.ifExists ? "IF EXISTS " : ""}${this.connection.quote(name)} CASCADE`,
    );
  }

  /**
   * Refuses a statement this adapter cannot run.
   *
   * Named rather than emitted and left to fail, because the database's own
   * error for unsupported syntax points at a token — a stray parenthesis, a
   * column that does not exist — and reads like a typo in the migration rather
   * than a feature the server does not have.
   */
  #require(capability: keyof Capabilities, method: string): void {
    if (this.connection.capabilities[capability]) return;

    throw new UnsupportedSchemaChange(
      method,
      `${this.connection.adapterName} has no ${capability}, so ${method} cannot run there.`,
    );
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
/**
 * Raised when the database is behind the code.
 *
 * Names the versions rather than only saying "pending", because the first
 * question is always which ones — and on a shared database the answer is
 * usually somebody else's branch rather than your own.
 */
export class PendingMigrationError extends Error {
  constructor(readonly versions: string[]) {
    super(`Migrations are pending. Run them before continuing: ${versions.join(", ")}`);
    this.name = "PendingMigrationError";
  }
}

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

  /** The table recording what has run. Rails' `schema_migration`. */
  get schemaMigrationTable(): string {
    return "schema_migrations";
  }

  /** The table recording which environment this database belongs to. */
  get internalMetadataTable(): string {
    return "ar_internal_metadata";
  }

  /**
   * Records a version as applied without running it. Rails' `create_version`.
   *
   * For adopting a database that already has the shape — a copy taken before
   * the migrations existed, a schema loaded from a dump rather than migrated.
   * Running the migration against such a database fails on the first
   * `CREATE TABLE` for a table that is already there.
   */
  async createVersion(version: string): Promise<void> {
    await this.ensureSchemaTable();

    const applied = new Set(await this.appliedVersions());

    // Skipped rather than left to the primary key, so calling this twice is
    // not an error a caller has to catch to write an idempotent setup script.
    if (applied.has(version)) return;

    await this.connection.execute(
      `INSERT INTO ${this.connection.quote(this.schemaMigrationTable)} (${this.connection.quote("version")}) VALUES (${this.connection.placeholder(0)})`,
      [version],
    );
  }

  /** Records several. Rails' `create_versions`. */
  async createVersions(versions: readonly string[]): Promise<void> {
    for (const version of versions) await this.createVersion(version);
  }

  /**
   * Marks every known migration up to a version as applied. Rails'
   * `assume_migrated_upto_version`.
   *
   * What `db:schema:load` does after loading a dump: the tables are there, so
   * the migrations that would have created them must not run, but the ones
   * after it still must. Marking them individually rather than writing one
   * high-water row, because a rollback needs a row per migration to know what
   * to undo.
   */
  async assumeMigratedUptoVersion(version: string): Promise<string[]> {
    const upTo = this.migrations
      .map((migration) => migration.version)
      .filter((known) => known.localeCompare(version) <= 0)
      .sort((a, b) => a.localeCompare(b));

    // The version itself even when no migration file matches it, since a dump
    // records the schema's version and the file may have been squashed away.
    const wanted = upTo.includes(version) ? upTo : [...upTo, version];

    await this.createVersions(wanted);

    return wanted;
  }

  /**
   * Refuses to carry on while anything is outstanding. Rails'
   * `check_all_pending!`.
   *
   * Worth doing at boot, and worth doing loudly. A deploy where the code
   * shipped and the migration did not produces "no such column" from somewhere
   * deep in a view — an error that names neither the migration nor the deploy,
   * and that three people will read before somebody thinks to check. This says
   * it once, at the front, with the versions in the message.
   */
  async checkAllPending(): Promise<void> {
    const outstanding = await this.pendingMigrationVersions();

    if (outstanding.length > 0) throw new PendingMigrationError(outstanding);
  }

  /** The same, under Rails' other name for it. */
  async checkPendingMigrations(): Promise<void> {
    await this.checkAllPending();
  }

  /**
   * Refuses a version this Migrator does not know. Rails'
   * `check_target_version`.
   *
   * `migrate VERSION=20260101` with a typo otherwise migrates to *nothing* and
   * reports success, having quietly rolled the database back past every
   * migration — which is the most destructive way a typo can be read.
   */
  checkTargetVersion(version: string): void {
    const known = this.migrations.some((migration) => migration.version === version);

    if (!known) {
      throw new Error(
        `Unknown migration version "${version}". Known versions: ${this.migrations.map((one) => one.version).join(", ") || "none"}.`,
      );
    }
  }

  /** The migration a version names, or undefined. Rails' `current_migration`. */
  currentMigration(version: string): Migration | undefined {
    return this.migrations.find((migration) => migration.version === version);
  }

  async pending(): Promise<Migration[]> {
    const applied = new Set(await this.appliedVersions());
    return [...this.migrations]
      .sort((a, b) => a.version.localeCompare(b.version))
      .filter((migration) => !applied.has(migration.version));
  }

  /** Rails' `pending_migrations`, under its own name. */
  async pendingMigrations(): Promise<Migration[]> {
    return await this.pending();
  }

  /** The versions still to run. Rails' `pending_migration_versions`. */
  async pendingMigrationVersions(): Promise<string[]> {
    return (await this.pending()).map((migration) => migration.version);
  }

  /** Whether anything is outstanding. Rails' `needs_migration?`. */
  async needsMigration(): Promise<boolean> {
    return (await this.pending()).length > 0;
  }

  /** Every version the schema table records. Rails' `get_all_versions`. */
  async getAllVersions(): Promise<string[]> {
    return await this.appliedVersions();
  }

  /** The highest applied version, or undefined. Rails' `current_version`. */
  async currentVersion(): Promise<string | undefined> {
    return (await this.appliedVersions()).at(-1);
  }

  /**
   * The version an `up` would take the schema to. Rails' `target_version`.
   *
   * The highest version this Migrator knows about, applied or not — which is
   * what a deploy compares against to decide whether the database is ready for
   * the code it is about to run.
   */
  targetVersion(): string | undefined {
    return [...this.migrations].sort((a, b) => a.version.localeCompare(b.version)).at(-1)?.version;
  }

  /**
   * Every migration with whether it has run. Rails' `db:migrate:status`.
   *
   * Sorted by version, and including applied versions this Migrator has no
   * file for — those are the interesting ones. A version in the table with
   * nothing to match it means the branch that added it was reverted while the
   * database kept the row, and a rollback will not know what to undo.
   */
  async migrationsStatus(): Promise<{ status: "up" | "down"; version: string; name: string }[]> {
    const applied = new Set(await this.appliedVersions());
    const known = new Map(this.migrations.map((one) => [one.version, one]));
    const versions = [...new Set([...applied, ...known.keys()])].sort((a, b) => a.localeCompare(b));

    return versions.map((version) => ({
      status: applied.has(version) ? "up" : "down",
      version,
      name: known.get(version)?.name ?? "*** NO FILE ***",
    }));
  }

  /**
   * Throws if anything is outstanding. Rails' `check_pending!`.
   *
   * What a development server calls before serving a request. Running against
   * a schema the code does not expect fails somewhere far from the cause — a
   * missing column surfaces as a query error in a partial, three layers from
   * the migration nobody ran.
   */
  async checkPending(): Promise<void> {
    const pending = await this.pending();
    if (pending.length === 0) return;

    throw new PendingMigrationError(pending.map((one) => one.version));
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
