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
 * Times one step of the handover and says so when it is slow.
 *
 * A `beforeEach` that runs out of budget is reported by the runner as a
 * timeout naming the test, which says nothing about which part of the handover
 * was slow. This names it.
 */
const SLOW_STEP_MS = Number(process.env["ALTAIR_TEST_SLOW_STEP_MS"] ?? 750);

async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  const started = Date.now();

  try {
    return await body();
  } finally {
    const took = Date.now() - started;

    if (took >= SLOW_STEP_MS) {
      process.stderr.write(`[test-connection] ${name} took ${String(took)}ms
`);
    }
  }
}

/**
 * Closes the outgoing pool, tolerating one that was never used.
 *
 * A pool is connected lazily, so one created and replaced without a query in
 * between rejects here instead of closing quietly. Nothing has leaked — there
 * was no socket — and failing the next test over the harness's own tidy-up
 * would report the wrong thing.
 */
async function closeQuietly(connection: Connection | undefined): Promise<void> {
  if (!connection) return;

  try {
    await connection.close();
  } catch (error) {
    if (!String(error).includes("before the connection was established")) throw error;
  }
}

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
  // The old pool is closed *first*, before the new one opens and before
  // anything is dropped.
  //
  // Two reasons, and the second is the one that bites. Closing first means only
  // one pool is ever alive, so a long run cannot exhaust the server's
  // connections. And closing rolls back whatever that connection still had
  // open: MySQL makes DDL wait for the metadata lock a transaction holds, so a
  // test that left one open blocks the next file's `DROP TABLE` indefinitely —
  // which surfaces as a `beforeEach` timing out in a file that did nothing
  // wrong, and then as "table already exists" when the hook finally gives up
  // and the create runs anyway.
  await step("close", () => closeQuietly(shared));

  shared = await step("open", async () => new Connection(TEST_DATABASE_URL));

  await step("drop", () => dropAllTables(shared as Connection));

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
  if (connection.adapter === "mysql") {
    await connection.execute("SET FOREIGN_KEY_CHECKS = 0");
    // Fail fast instead of hanging. If something does hold a metadata lock,
    // five seconds of waiting is reported by the test runner as a hook timeout
    // naming an unrelated test; two seconds of waiting is reported by MySQL as
    // a lock timeout naming the table.
    await connection.execute("SET SESSION lock_wait_timeout = 2");
  }

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
