/**
 * The database the storage tests run against.
 *
 * Blobs, attachments and variant records are ordinary models, so these tests
 * exercise the ORM's polymorphic associations, its JSON columns and its
 * timestamps — on whichever database the suite is pointed at. They ran on
 * in-memory SQLite and nothing else, which is how a whole class of adapter bug
 * stayed hidden in the ORM until its own suite started running on a server.
 *
 * CI sets `ALTAIR_TEST_DATABASE_URL`.
 */

import { Connection, tableNames } from "@altair/orm";

export const TEST_DATABASE_URL = process.env.ALTAIR_TEST_DATABASE_URL ?? "sqlite://:memory:";
export const isSqlite = TEST_DATABASE_URL.startsWith("sqlite");

let previous: Connection | undefined;

/**
 * A connection to an empty database.
 *
 * On SQLite that is a new in-memory database each time. On a server it is a
 * fresh pool with the previous one closed: PostgreSQL caches a prepared
 * statement's plan per connection and refuses to run it once the table it was
 * planned against has been dropped and rebuilt, which is what these tests do
 * between cases. Closing the previous pool is what stops one per test from
 * exhausting the server.
 */
export async function storageConnection(): Promise<Connection> {
  if (isSqlite) return new Connection(TEST_DATABASE_URL);

  const opened = new Connection(TEST_DATABASE_URL);

  await dropStorageTables(opened);
  await previous?.close();
  previous = opened;

  return opened;
}

/** Closes what a test opened, where there is anything to close. */
export async function releaseConnection(connection: Connection): Promise<void> {
  if (isSqlite) await connection.close();
}

/**
 * Empties the database.
 *
 * Every table rather than a list of the ones I could think of: these suites
 * build `teams`, `posts`, `users` and more between them, and a hardcoded list
 * leaves whatever it forgot behind for the next file to collide with —
 * `Table 'teams' already exists`, which is exactly what it did.
 */
async function dropStorageTables(connection: Connection): Promise<void> {
  const names = await tableNames(connection);
  if (names.length === 0) return;

  // MySQL refuses to drop a table another references, and the order that would
  // satisfy every foreign key is not worth computing for a test database.
  if (connection.adapter === "mysql") await connection.execute("SET FOREIGN_KEY_CHECKS = 0");

  for (const name of names) {
    const cascade = connection.adapter === "postgres" ? " CASCADE" : "";
    await connection.execute(`DROP TABLE IF EXISTS ${connection.quote(name)}${cascade}`);
  }

  if (connection.adapter === "mysql") await connection.execute("SET FOREIGN_KEY_CHECKS = 1");
}
