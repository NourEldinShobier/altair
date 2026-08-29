/**
 * The database the queue tests run against.
 *
 * The database queue writes raw SQL — a claim under contention, a delete, a
 * catalog probe — and each of the three databases spells parts of that
 * differently. A branch that never executes is a branch nobody has checked,
 * which is why the ORM suite runs everywhere and why this now does too.
 *
 * These files read `process.env.DATABASE_URL`, which nothing sets. CI sets
 * `ALTAIR_TEST_DATABASE_URL`, so they ran on in-memory SQLite in every leg.
 */

import { connect, type Connection } from "@altair/orm";

export const TEST_DATABASE_URL = process.env.ALTAIR_TEST_DATABASE_URL ?? "sqlite://:memory:";
export const isSqlite = TEST_DATABASE_URL.startsWith("sqlite");

let shared: Connection | undefined;

/**
 * A connection with an empty jobs table.
 *
 * On SQLite that is a new in-memory database each time. On a server it is one
 * pool, reused — these tests had no teardown at all, and a pool per test would
 * exhaust the server's connections long before the file finished.
 */
export async function queueConnection(): Promise<Connection> {
  if (isSqlite) return (await connect(TEST_DATABASE_URL)) as Connection;

  shared ??= (await connect(TEST_DATABASE_URL)) as Connection;

  return shared;
}

/** Closes what a test opened, where there is anything to close. */
export async function releaseConnection(connection: Connection): Promise<void> {
  if (isSqlite) await connection.close();
}
