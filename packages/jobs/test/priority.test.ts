/**
 * Which job runs first when several are due.
 *
 * Mirrors activejob/test/cases/queue_priority_test.rb.
 *
 * Without a priority the only order is the order things arrived in, so a
 * password reset waits behind whatever the nightly batch enqueued. Lower goes
 * first, as `nice` does and as every queue that has one reads it.
 *
 * The tests dequeue from a real table rather than inspecting payloads: the
 * payload carrying the number and the queue ordering by it are two different
 * things, and the first version of this had one without the other.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, connect } from "@altair/orm";
import { DatabaseQueue, Job, createJobsTable } from "../src/index.js";

class Batch extends Job {
  static override priority = 10;
  override async perform(): Promise<void> {}
}

class Reset extends Job {
  static override priority = 0;
  override async perform(): Promise<void> {}
}

class Ordinary extends Job {
  override async perform(): Promise<void> {}
}

let connection: Connection;
let queue: DatabaseQueue;

/** Everything runnable, in the order a worker would take it. */
const drain = async (name = "default"): Promise<string[]> => {
  const taken: string[] = [];

  for (;;) {
    const next = await queue.dequeue(name);
    if (!next) return taken;

    taken.push(next.jobClass);
  }
};

beforeEach(async () => {
  connection = await connect(process.env.DATABASE_URL ?? "sqlite://:memory:");
  await connection.execute("DROP TABLE IF EXISTS altair_jobs");
  await createJobsTable(connection as never);

  queue = new DatabaseQueue(connection as never);
  Job.adapter = queue;
  Job.resetRegistry();
  Job.register(Batch as typeof Job, Reset as typeof Job, Ordinary as typeof Job);
});

describe("a class with a priority", () => {
  it("carries it onto the payload", async () => {
    const payload = await Batch.performLater();

    expect(payload.priority).toBe(10);
  });

  it("defaults to nothing in particular", async () => {
    expect((await Ordinary.performLater()).priority).toBe(0);
  });
});

describe("the order a worker takes them in", () => {
  // The one that matters: arrival order and priority order disagree, and
  // priority wins.
  it("is by priority before arrival", async () => {
    await Batch.performLater();
    await Batch.performLater();
    await Reset.performLater();

    expect(await drain()).toEqual(["Reset", "Batch", "Batch"]);
  });

  it("is by arrival within one priority", async () => {
    const first = await Batch.performLater();
    await Batch.performLater();

    const taken = await queue.dequeue("default");

    expect(taken?.id).toBe(first.id);
  });

  it("takes a negative priority ahead of the default", async () => {
    await Ordinary.performLater();
    await Reset.set({ priority: -5 }).performLater();

    expect(await drain()).toEqual(["Reset", "Ordinary"]);
  });
});

describe("an explicit priority", () => {
  it("beats the class's own", async () => {
    expect((await Batch.set({ priority: -5 }).performLater()).priority).toBe(-5);
  });

  it("changes where the job lands in the queue", async () => {
    await Reset.performLater();
    await Batch.set({ priority: -5 }).performLater();

    expect(await drain()).toEqual(["Batch", "Reset"]);
  });

  it("leaves the class's default alone for the next job", async () => {
    await Batch.set({ priority: -5 }).performLater();

    expect((await Batch.performLater()).priority).toBe(10);
  });
});

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing for a table that is already there,
 * so an application that ran an earlier version would have every insert fail
 * on a column the code now names.
 */
describe("a table created before priority existed", () => {
  it("gains the column", async () => {
    await connection.execute("DROP TABLE IF EXISTS altair_jobs");

    // The table as it was, without the column.
    await connection.execute(
      `CREATE TABLE altair_jobs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         job_id VARCHAR(255) NOT NULL,
         job_class VARCHAR(255) NOT NULL,
         arguments TEXT NOT NULL,
         queue VARCHAR(255) NOT NULL,
         run_at BIGINT NOT NULL,
         attempts INTEGER NOT NULL,
         enqueued_at BIGINT NOT NULL,
         claimed_at BIGINT
       )`,
    );

    await createJobsTable(connection as never);

    expect(await Batch.performLater()).toBeDefined();
    expect((await queue.dequeue("default"))?.priority).toBe(10);
  });
});
