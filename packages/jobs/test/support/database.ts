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

let previous: Connection | undefined;

/**
 * A connection with an empty jobs table.
 *
 * On SQLite that is a new in-memory database each time. On a server it is a
 * fresh pool with the previous one closed — which is what the ORM's harness
 * does, and for a reason these tests hit immediately: PostgreSQL caches a
 * prepared statement's plan per connection and refuses to run it once the
 * table it was planned against has been dropped and rebuilt. These tests drop
 * and rebuild `altair_jobs` between cases, so a reused pool answers
 * `cached plan must not change result type`.
 *
 * Closing the previous one is what keeps a pool per test from exhausting the
 * server's connections — these files had no teardown at all before.
 */
export async function queueConnection(): Promise<Connection> {
  if (isSqlite) return (await connect(TEST_DATABASE_URL)) as Connection;

  const opened = (await connect(TEST_DATABASE_URL)) as Connection;

  await previous?.close();
  previous = opened;

  return opened;
}

/** Closes what a test opened, where there is anything to close. */
export async function releaseConnection(connection: Connection): Promise<void> {
  if (isSqlite) await connection.close();
}
