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
       ${q("claimed_at")} BIGINT
     )`,
  );

  // The index every dequeue uses: the runnable jobs on one queue, oldest first.
  await connection.execute(
    `CREATE INDEX IF NOT EXISTS ${q("index_altair_jobs_on_queue_and_run_at")} ` +
      `ON ${q(JOBS_TABLE)} (${q("queue")}, ${q("claimed_at")}, ${q("run_at")})`,
  );
}

interface Row {
  id: number | string;
  job_id: string;
  job_class: string;
  arguments: string;
  queue: string;
  run_at: number | string;
  attempts: number | string;
  enqueued_at: number | string;
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
  };
}

export class DatabaseQueue implements QueueAdapter {
  constructor(private readonly connection: QueueConnection) {}

  async enqueue(payload: JobPayload): Promise<void> {
    const q = (name: string) => this.connection.quote(name);
    const values = [0, 1, 2, 3, 4, 5, 6].map((index) => this.connection.placeholder(index));

    await this.connection.execute(
      `INSERT INTO ${q(JOBS_TABLE)} (${q("job_id")}, ${q("job_class")}, ${q("arguments")}, ${q("queue")}, ${q("run_at")}, ${q("attempts")}, ${q("enqueued_at")}) ` +
        `VALUES (${values.join(", ")})`,
      [
        payload.id,
        payload.jobClass,
        JSON.stringify(payload.arguments),
        payload.queue,
        payload.runAt,
        payload.attempts,
        payload.enqueuedAt,
      ],
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
          `ORDER BY ${q("run_at")} ASC LIMIT 1`,
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
        `ORDER BY ${q("run_at")} ASC`,
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
