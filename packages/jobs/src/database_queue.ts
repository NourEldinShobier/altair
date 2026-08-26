/**
 * A queue in the database, in place of Rails' Solid Queue.
 *
 * Rails 8 made a database-backed queue the default because Redis is a second
 * thing to run, back up and lose. The trade is real either way: a database
 * queue is slower and it competes with the application for connections, but a
 * deployment that already has a database has nothing new to operate.
 *
 * The part that has to be right is handing the same job to two workers. A
 * `SELECT` then an `UPDATE` is a race with a window in it; the claim here is a
 * single guarded `UPDATE`, so exactly one worker wins whatever the timing.
 */

import type { JobPayload, QueueAdapter } from "./job.js";

/** The part of a connection this needs. Declared, so jobs need not import the ORM. */
export interface QueueConnection {
  adapter: "sqlite" | "postgres" | "mysql";
  quote(identifier: string): string;
  placeholder(index: number): string;
  query<T = Record<string, unknown>>(sql: string, bindings?: readonly unknown[]): Promise<T[]>;
  execute(sql: string, bindings?: readonly unknown[]): Promise<void>;
  executeCount(sql: string, bindings?: readonly unknown[]): Promise<number>;
}

export const JOBS_TABLE = "altair_jobs";

/** Creates the table the queue reads and writes. */
export async function createJobsTable(connection: QueueConnection): Promise<void> {
  const q = (name: string) => connection.quote(name);
  const id =
    connection.adapter === "postgres"
      ? "BIGSERIAL PRIMARY KEY"
      : connection.adapter === "mysql"
        ? "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY"
        : "INTEGER PRIMARY KEY AUTOINCREMENT";

  await connection.execute(
    `CREATE TABLE IF NOT EXISTS ${q(JOBS_TABLE)} (
       ${q("id")} ${id},
       ${q("job_id")} VARCHAR(255) NOT NULL,
       ${q("job_class")} VARCHAR(255) NOT NULL,
       ${q("arguments")} TEXT NOT NULL,
       ${q("queue")} VARCHAR(255) NOT NULL,
       ${q("run_at")} BIGINT NOT NULL,
       ${q("attempts")} INTEGER NOT NULL,
       ${q("enqueued_at")} BIGINT NOT NULL,
       ${q("priority")} INTEGER NOT NULL DEFAULT 0,
       ${q("claimed_at")} BIGINT
     )`,
  );

  await addPriorityToExistingTable(connection);

  // The index every dequeue uses: the runnable jobs on one queue, in the order
  // the dequeue asks for them — priority first, then oldest.
  await connection.execute(
    `CREATE INDEX IF NOT EXISTS ${q("index_altair_jobs_on_queue_and_priority")} ` +
      `ON ${q(JOBS_TABLE)} (${q("queue")}, ${q("claimed_at")}, ${q("priority")}, ${q("run_at")})`,
  );
}

/**
 * Adds `priority` to a table created before it existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing for a table that is already there,
 * so an application that ran an earlier version would have every insert fail
 * on a column the code now names. Detected by asking for the column rather
 * than by reading the adapter's catalog, which each of the three spells
 * differently.
 */
async function addPriorityToExistingTable(connection: QueueConnection): Promise<void> {
  if (await hasColumn(connection, JOBS_TABLE, "priority")) return;

  await connection.execute(
    `ALTER TABLE ${connection.quote(JOBS_TABLE)} ` +
      `ADD COLUMN ${connection.quote("priority")} INTEGER NOT NULL DEFAULT 0`,
  );
}

/**
 * Whether a table has a column, asked of the database's own catalog.
 *
 * The obvious shortcut is `SELECT "priority" FROM jobs LIMIT 1` and a
 * try/catch, and on SQLite it does not work: a double-quoted name that matches
 * no column is accepted as a *string literal* rather than refused, so the
 * probe succeeds, the migration is skipped, and every insert afterwards fails
 * on the column that was never added. It reported success against an empty
 * table for exactly that reason.
 */
async function hasColumn(
  connection: QueueConnection,
  table: string,
  column: string,
): Promise<boolean> {
  if (connection.adapter === "sqlite") {
    const rows = await connection.query<{ name: string }>(`PRAGMA table_info(${table})`);

    return rows.some((row) => row.name === column);
  }

  const rows = await connection.query<{ count: number | string }>(
    `SELECT COUNT(*) AS ${connection.quote("count")} FROM information_schema.columns ` +
      `WHERE table_name = ${connection.placeholder(0)} ` +
      `AND column_name = ${connection.placeholder(1)}`,
    [table, column],
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

/**
 * The columns an insert writes, and where each value comes from.
 *
 * One list rather than a list of names and a matching list of values: keeping
 * two in step by hand is what wrote every job at priority zero.
 */
const COLUMNS: { name: string; read: (payload: JobPayload) => unknown }[] = [
  { name: "job_id", read: (payload) => payload.id },
  { name: "job_class", read: (payload) => payload.jobClass },
  { name: "arguments", read: (payload) => JSON.stringify(payload.arguments) },
  { name: "queue", read: (payload) => payload.queue },
  { name: "run_at", read: (payload) => payload.runAt },
  { name: "attempts", read: (payload) => payload.attempts },
  { name: "enqueued_at", read: (payload) => payload.enqueuedAt },
  { name: "priority", read: (payload) => payload.priority ?? 0 },
];

interface Row {
  id: number | string;
  job_id: string;
  job_class: string;
  arguments: string;
  queue: string;
  run_at: number | string;
  attempts: number | string;
  enqueued_at: number | string;
  priority: number | string;
}

function toPayload(row: Row): JobPayload {
  return {
    id: String(row.job_id),
    jobClass: String(row.job_class),
    arguments: JSON.parse(String(row.arguments)) as unknown[],
    queue: String(row.queue),
    runAt: Number(row.run_at),
    attempts: Number(row.attempts),
    enqueuedAt: Number(row.enqueued_at),
    priority: Number(row.priority ?? 0),
  };
}

export class DatabaseQueue implements QueueAdapter {
  constructor(private readonly connection: QueueConnection) {}

  async enqueue(payload: JobPayload): Promise<void> {
    await this.insert([payload]);
  }

  /**
   * Writes every payload in one statement.
   *
   * A hundred jobs enqueued in a loop is a hundred round trips, and the loop
   * is the obvious way to write it.
   */
  async enqueueAll(payloads: JobPayload[]): Promise<void> {
    if (payloads.length === 0) return;

    await this.insert(payloads);
  }

  /**
   * The one INSERT both paths use.
   *
   * Shared rather than written twice, and for a specific reason: `priority`
   * went into the table, the index and the ordering and not into the insert,
   * so every job was written at zero while its payload said otherwise. Two
   * inserts would be two places for that to happen again.
   */
  private async insert(payloads: JobPayload[]): Promise<void> {
    const q = (name: string) => this.connection.quote(name);
    const bindings: unknown[] = [];

    const rows = payloads.map((payload) => {
      const values = COLUMNS.map((column) => column.read(payload));
      const placeholders = values.map((_, index) =>
        this.connection.placeholder(bindings.length + index),
      );

      bindings.push(...values);

      return `(${placeholders.join(", ")})`;
    });

    await this.connection.execute(
      `INSERT INTO ${q(JOBS_TABLE)} (${COLUMNS.map((column) => q(column.name)).join(", ")}) ` +
        `VALUES ${rows.join(", ")}`,
      bindings,
    );
  }

  /**
   * Takes the next runnable job, and takes it exactly once.
   *
   * Selecting a row and then updating it leaves a window where another worker
   * selects the same one. The claim is a single UPDATE guarded by the row
   * still being unclaimed, so the database decides the winner and the loser
   * sees zero rows changed and looks again.
   */
  async dequeue(queue: string): Promise<JobPayload | null> {
    const q = (name: string) => this.connection.quote(name);
    const now = Date.now();

    for (;;) {
      const candidates = await this.connection.query<Row & { id: number }>(
        `SELECT * FROM ${q(JOBS_TABLE)} ` +
          `WHERE ${q("queue")} = ${this.connection.placeholder(0)} ` +
          `AND ${q("claimed_at")} IS NULL ` +
          `AND ${q("run_at")} <= ${this.connection.placeholder(1)} ` +
          `ORDER BY ${q("priority")} ASC, ${q("run_at")} ASC LIMIT 1`,
        [queue, now],
      );

      const candidate = candidates[0];
      if (!candidate) return null;

      const claimed = await this.connection.executeCount(
        `UPDATE ${q(JOBS_TABLE)} SET ${q("claimed_at")} = ${this.connection.placeholder(0)} ` +
          `WHERE ${q("id")} = ${this.connection.placeholder(1)} AND ${q("claimed_at")} IS NULL`,
        [now, candidate.id],
      );

      // Someone else got there first; the next one may still be ours.
      if (claimed === 0) continue;

      await this.connection.execute(
        `DELETE FROM ${q(JOBS_TABLE)} WHERE ${q("id")} = ${this.connection.placeholder(0)}`,
        [candidate.id],
      );

      return toPayload(candidate);
    }
  }

  async size(queue = "default"): Promise<number> {
    const q = (name: string) => this.connection.quote(name);
    const rows = await this.connection.query<{ count: number | string }>(
      `SELECT COUNT(*) AS ${q("count")} FROM ${q(JOBS_TABLE)} ` +
        `WHERE ${q("queue")} = ${this.connection.placeholder(0)} AND ${q("claimed_at")} IS NULL`,
      [queue],
    );

    return Number(rows[0]?.count ?? 0);
  }

  /** Everything waiting on a queue, for assertions and monitoring. */
  async pending(queue = "default"): Promise<JobPayload[]> {
    const q = (name: string) => this.connection.quote(name);
    const rows = await this.connection.query<Row>(
      `SELECT * FROM ${q(JOBS_TABLE)} WHERE ${q("queue")} = ${this.connection.placeholder(0)} ` +
        `ORDER BY ${q("priority")} ASC, ${q("run_at")} ASC`,
      [queue],
    );

    return rows.map(toPayload);
  }

  /**
   * Frees jobs a worker claimed and never finished.
   *
   * A worker that dies between claiming and finishing leaves its job claimed
   * for good. Rails' Solid Queue calls the same thing, and without it a crash
   * quietly loses work rather than retrying it.
   */
  async releaseStale(olderThanSeconds = 300, now: number = Date.now()): Promise<number> {
    const q = (name: string) => this.connection.quote(name);

    return await this.connection.executeCount(
      `UPDATE ${q(JOBS_TABLE)} SET ${q("claimed_at")} = NULL ` +
        `WHERE ${q("claimed_at")} IS NOT NULL AND ${q("claimed_at")} < ${this.connection.placeholder(0)}`,
      [now - olderThanSeconds * 1000],
    );
  }
}
