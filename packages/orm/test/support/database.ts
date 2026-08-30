/**
 * The database the ORM suite runs against.
 *
 * Rails runs its own suite against SQLite, PostgreSQL and MySQL, because an
 * adapter branch that never executes is a branch nobody has checked. Set
 * `ALTAIR_TEST_DATABASE_URL` to point this suite at a server; the default is
 * in-memory SQLite, so running the tests needs nothing installed.
 */

import { Connection, adapterFor } from "../../src/connection.js";
import { introspect, tableNames } from "../../src/introspect.js";

export const TEST_DATABASE_URL = process.env.ALTAIR_TEST_DATABASE_URL ?? "sqlite://:memory:";
export const TEST_ADAPTER = adapterFor(TEST_DATABASE_URL);

/** In-memory SQLite gives every test a private database; a server does not. */
export const isSqlite = TEST_ADAPTER === "sqlite";

let shared: Connection | undefined;

/**
 * A connection to an empty database.
 *
 * On SQLite that is a new in-memory database each time. On a server it is one
 * pool, emptied — opening a pool per test would exhaust the server's
 * connections long before the suite finished.
 */
export async function testConnection(): Promise<Connection> {
  if (isSqlite) return new Connection(TEST_DATABASE_URL);

  // A fresh pool each time. PostgreSQL caches a prepared statement's plan per
  // connection and refuses to run it once the table it was planned against has
  // been dropped and rebuilt — which is what these tests do between every case.
  //
  // The old pool is emptied and closed *before* the new one opens, rather than
  // after. Two pools were otherwise alive at once for the length of every
  // teardown, and with a few hundred tests the server runs out of connections
  // somewhere near the end of the run — which surfaces as a `beforeEach` in
  // whichever file happens to be last timing out, naming a test that has
  // nothing to do with it.
  //
  // Dropping through the outgoing connection also means the new one never sees
  // the tables the last file built, so there is nothing for it to have cached
  // a plan against.
  const previous = shared;

  if (previous) {
    await dropAllTables(previous);
    await previous.close();
  }

  shared = new Connection(TEST_DATABASE_URL);

  // The first call inherits whatever the last run left behind.
  if (!previous) await dropAllTables(shared);

  return shared;
}

/**
 * Empties the database, `schema_migrations` included.
 *
 * Dropping rather than truncating, because the tests build their own tables
 * and the next file's shape is not this one's.
 */
export async function dropAllTables(connection: Connection): Promise<void> {
  // Views first, and separately: `tableNames` reports base tables only, and
  // `DROP TABLE` will not remove a view. One test creating a view otherwise
  // leaves it behind for every file that runs after it — which shows up as a
  // failure in whichever unrelated test happens to list what the database
  // holds.
  await dropAllViews(connection);

  const names = await tableNames(connection);
  if (names.length === 0) return;

  // MySQL refuses to drop a table another table references, and the order that
  // would satisfy every foreign key is not worth computing for a test database.
  if (connection.adapter === "mysql") await connection.execute("SET FOREIGN_KEY_CHECKS = 0");

  for (const name of names) {
    const cascade = connection.adapter === "postgres" ? " CASCADE" : "";
    await connection.execute(`DROP TABLE IF EXISTS ${connection.quote(name)}${cascade}`);
  }

  if (connection.adapter === "mysql") await connection.execute("SET FOREIGN_KEY_CHECKS = 1");
}

/**
 * A table's column names, asked of whichever database is running.
 *
 * The suite used PRAGMA directly, which meant every schema assertion was also
 * an assertion that the database was SQLite.
 */
export async function columnNamesOf(connection: Connection, table: string): Promise<string[]> {
  const schema = await introspect(connection);
  return schema.tables.find((entry) => entry.name === table)?.columns.map((c) => c.name) ?? [];
}

/** A table's index names, primary key aside. */
export async function indexNamesOf(connection: Connection, table: string): Promise<string[]> {
  const schema = await introspect(connection);
  return schema.tables.find((entry) => entry.name === table)?.indexes.map((i) => i.name) ?? [];
}

/** Every view, dropped. Empty on SQLite in memory, where each test gets its own database. */
async function dropAllViews(connection: Connection): Promise<void> {
  const names = await viewNames(connection);

  for (const name of names) {
    await connection.execute(`DROP VIEW IF EXISTS ${connection.quote(name)}`);
  }
}

async function viewNames(connection: Connection): Promise<string[]> {
  const rows = await connection.query<{ name: unknown }>(
    connection.adapter === "sqlite"
      ? "SELECT name FROM sqlite_master WHERE type = 'view'"
      : connection.adapter === "postgres"
        ? "SELECT viewname AS name FROM pg_views WHERE schemaname = 'public'"
        : `SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_type = 'VIEW'`,
  );

  return rows.map((row) => String(row.name));
}
