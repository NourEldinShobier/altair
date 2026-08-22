/**
 * The database the ORM suite runs against.
 *
 * Rails runs its own suite against SQLite, PostgreSQL and MySQL, because an
 * adapter branch that never executes is a branch nobody has checked. Set
 * `ALTAIR_TEST_DATABASE_URL` to point this suite at a server; the default is
 * in-memory SQLite, so running the tests needs nothing installed.
 */

import { Connection, adapterFor } from "../../src/connection.js";
import { tableNames } from "../../src/introspect.js";

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

  shared ??= new Connection(TEST_DATABASE_URL);
  await dropAllTables(shared);
  return shared;
}

/**
 * Empties the database, `schema_migrations` included.
 *
 * Dropping rather than truncating, because the tests build their own tables
 * and the next file's shape is not this one's.
 */
export async function dropAllTables(connection: Connection): Promise<void> {
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
