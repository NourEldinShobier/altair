/**
 * Reading a database's real shape back out, so the schema can be dumped and
 * types can be generated from it.
 *
 * This is the half of the architecture that has been promised since the start:
 * Rails resolves conventions at run time by asking the database at boot, which
 * no type checker can see. Asking at build time instead produces an artifact
 * the compiler reads, so a column added in a migration and forgotten in an
 * interface becomes a type error rather than a lie.
 */

import type { Connection, Row } from "./connection.js";

export interface ColumnSchema {
  name: string;
  /** The database's own type name, kept verbatim for the dump. */
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
}

export interface SchemaDefinition {
  /** The last applied migration, so a dump says which schema it is. */
  version: string | null;
  tables: TableSchema[];
}

/** Tables the framework owns, which never belong in a dump. */
const INTERNAL_TABLES = new Set(["schema_migrations", "sqlite_sequence"]);

/** Reads every table's columns and indexes. */
export async function introspect(connection: Connection): Promise<SchemaDefinition> {
  const names = (await tableNames(connection)).filter((name) => !INTERNAL_TABLES.has(name)).sort();

  const tables: TableSchema[] = [];
  for (const name of names) {
    tables.push({
      name,
      columns: await columnsOf(connection, name),
      indexes: await indexesOf(connection, name),
    });
  }

  return { version: await currentVersion(connection), tables };
}

/** The newest applied migration version, or null when none have run. */
export async function currentVersion(connection: Connection): Promise<string | null> {
  try {
    const rows = await connection.query<Row>(
      `SELECT ${connection.quote("version")} FROM ${connection.quote("schema_migrations")} ORDER BY ${connection.quote("version")} DESC LIMIT 1`,
    );
    return rows[0] ? String(rows[0].version) : null;
  } catch {
    // No schema_migrations table means nothing has migrated yet.
    return null;
  }
}

async function tableNames(connection: Connection): Promise<string[]> {
  switch (connection.adapter) {
    case "sqlite": {
      const rows = await connection.query<Row>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      return rows.map((row) => String(row.name));
    }
    case "postgres": {
      const rows = await connection.query<Row>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
      );
      return rows.map((row) => String(row.name));
    }
    case "mysql": {
      const rows = await connection.query<Row>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
      );
      return rows.map((row) => String(row.name));
    }
  }
}

async function columnsOf(connection: Connection, table: string): Promise<ColumnSchema[]> {
  if (connection.adapter === "sqlite") {
    const rows = await connection.query<Row>(`PRAGMA table_info(${connection.quote(table)})`);

    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      // PRAGMA reports notnull as 0/1, and a primary key is implicitly not null.
      nullable: Number(row.notnull) === 0 && Number(row.pk) === 0,
      default:
        row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
      primaryKey: Number(row.pk) > 0,
    }));
  }

  const rows = await connection.query<Row>(
    `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS "default"
     FROM information_schema.columns
     WHERE table_name = ${connection.placeholder(0)}
     ORDER BY ordinal_position`,
    [table],
  );

  const primaryKeys = await primaryKeysOf(connection, table);

  return rows.map((row) => ({
    name: String(row.name),
    type: String(row.type),
    nullable: String(row.nullable).toUpperCase() === "YES",
    default: row.default === null || row.default === undefined ? null : String(row.default),
    primaryKey: primaryKeys.includes(String(row.name)),
  }));
}

async function primaryKeysOf(connection: Connection, table: string): Promise<string[]> {
  const rows = await connection.query<Row>(
    `SELECT column_name AS name
     FROM information_schema.key_column_usage
     WHERE table_name = ${connection.placeholder(0)} AND constraint_name LIKE '%pkey%' OR constraint_name = 'PRIMARY'`,
    [table],
  );
  return rows.map((row) => String(row.name));
}

async function indexesOf(connection: Connection, table: string): Promise<IndexSchema[]> {
  if (connection.adapter !== "sqlite") {
    // ponytail: indexes are dumped for SQLite only. Postgres and MySQL each
    // need their own catalog query, and the dump is still correct without
    // them — it just does not recreate indexes on those adapters yet.
    return [];
  }

  const list = await connection.query<Row>(`PRAGMA index_list(${connection.quote(table)})`);
  const indexes: IndexSchema[] = [];

  for (const entry of list) {
    const name = String(entry.name);
    // An index SQLite created for a UNIQUE column is not one the schema
    // declared, so dumping it would produce a schema that cannot be loaded.
    if (name.startsWith("sqlite_autoindex")) continue;

    const info = await connection.query<Row>(`PRAGMA index_info(${connection.quote(name)})`);
    indexes.push({
      name,
      columns: info.map((column) => String(column.name)),
      unique: Number(entry.unique) === 1,
    });
  }

  return indexes.sort((a, b) => a.name.localeCompare(b.name));
}
