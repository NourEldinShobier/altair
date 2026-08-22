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

/** Every table in the database, framework-owned ones included. */
export async function tableNames(connection: Connection): Promise<string[]> {
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
  // The parentheses are load-bearing. Without them the OR binds looser than
  // the AND, and MySQL — which names every table's primary key constraint
  // PRIMARY — reports the primary key of every table in the database.
  const rows = await connection.query<Row>(
    `SELECT column_name AS name
     FROM information_schema.key_column_usage
     WHERE table_name = ${connection.placeholder(0)}
       AND (constraint_name LIKE '%pkey%' OR constraint_name = 'PRIMARY')`,
    [table],
  );
  return rows.map((row) => String(row.name));
}

async function indexesOf(connection: Connection, table: string): Promise<IndexSchema[]> {
  if (connection.adapter === "postgres") return await postgresIndexes(connection, table);
  if (connection.adapter === "mysql") return await mysqlIndexes(connection, table);

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

/**
 * Groups catalog rows, one per index column, into indexes.
 *
 * Both server catalogs report an index as one row per column, already in
 * position order, so the grouping is the same for either.
 */
function groupIndexColumns(rows: readonly Row[]): IndexSchema[] {
  const indexes = new Map<string, IndexSchema>();

  for (const row of rows) {
    const name = String(row.name);
    const existing = indexes.get(name);

    if (existing) existing.columns.push(String(row.column));
    else indexes.set(name, { name, columns: [String(row.column)], unique: Boolean(row.unique) });
  }

  return [...indexes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function postgresIndexes(connection: Connection, table: string): Promise<IndexSchema[]> {
  // unnest WITH ORDINALITY keeps the columns in the order the index declares
  // them, which a plain join against pg_attribute would lose — and a two-column
  // index dumped in the wrong order is a different index.
  const rows = await connection.query<Row>(
    `SELECT i.relname AS name, ix.indisunique AS unique, a.attname AS column
     FROM pg_class t
     JOIN pg_index ix ON t.oid = ix.indrelid
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE t.relname = ${connection.placeholder(0)} AND NOT ix.indisprimary
     ORDER BY i.relname, k.ord`,
    [table],
  );

  return groupIndexColumns(rows);
}

async function mysqlIndexes(connection: Connection, table: string): Promise<IndexSchema[]> {
  const rows = await connection.query<Row>(
    `SELECT index_name AS name, (non_unique = 0) AS \`unique\`, column_name AS \`column\`
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ${connection.placeholder(0)}
       AND index_name <> 'PRIMARY'
     ORDER BY index_name, seq_in_index`,
    [table],
  );

  return groupIndexColumns(rows);
}
