/**
 * Recurring jobs and the database queue.
 *
 * Mirrors the ground Solid Queue covers in Rails 8. Two things carry their
 * weight: a schedule running on four servers must not happen four times, and
 * two workers must not be handed the same job.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { MemoryStore } from "@altair/support";
import { Connection } from "@altair/orm";
import { Job } from "../src/job.js";
import { MemoryQueue } from "../src/worker.js";
import { InvalidCronExpression, isCronExpression, lockKey, Scheduler } from "../src/schedule.js";
import { createJobsTable, DatabaseQueue, JOBS_TABLE } from "../src/database-queue.js";

const ran: string[] = [];

class SweepJob extends Job {
  override async perform(...args: unknown[]): Promise<void> {
    ran.push(`sweep:${JSON.stringify(args)}`);
  }
}

beforeEach(() => {
  ran.length = 0;
  Job.resetRegistry();
  Job.register(SweepJob);
  Job.adapter = new MemoryQueue();
});

describe("cron expressions", () => {
  it("accept the five-field form", () => {
    expect(isCronExpression("0 * * * *")).toBe(true);
    expect(isCronExpression("*/15 9-17 * * 1-5")).toBe(true);
  });

  it("reject the wrong number of fields", () => {
    expect(isCronExpression("0 * * *")).toBe(false);
    expect(isCronExpression("0 * * * * *")).toBe(false);
  });

  it("reject a field that is not one", () => {
    expect(isCronExpression("every hour please ok thanks")).toBe(false);
  });

  // A typo should fail where it was written, not at the first fire — which
  // could be a month later.
  it("are checked when the schedule is declared", () => {
    expect(() => new Scheduler({ bad: { cron: "nope", job: SweepJob } })).toThrow(
      InvalidCronExpression,
    );
  });
});

describe("running a task", () => {
  const cron = () => ({ stop: () => {}, unref: () => {} });

  it("enqueues the job", async () => {
    const scheduler = new Scheduler({ sweep: { cron: "0 * * * *", job: SweepJob } }, { cron });

    await scheduler.run("sweep");
    expect(await Job.adapter!.size("default")).toBe(1);
  });

  it("passes the arguments it was given", async () => {
    const scheduler = new Scheduler(
      { sweep: { cron: "0 * * * *", job: SweepJob, args: [7], performNow: true } },
      { cron },
    );

    await scheduler.run("sweep");
    expect(ran).toEqual(["sweep:[7]"]);
  });

  it("runs the job directly when told to", async () => {
    const scheduler = new Scheduler(
      { sweep: { cron: "0 * * * *", job: SweepJob, performNow: true } },
      { cron },
    );

    await scheduler.run("sweep");
    expect(ran).toHaveLength(1);
    expect(await Job.adapter!.size("default")).toBe(0);
  });

  it("says when there is no such task", async () => {
    const scheduler = new Scheduler({}, { cron });
    await expect(scheduler.run("nope")).rejects.toThrow('No scheduled task named "nope"');
  });

  it("registers every task on start and clears them on stop", () => {
    const started: string[] = [];
    const scheduler = new Scheduler(
      { a: { cron: "0 * * * *", job: SweepJob }, b: { cron: "* * * * *", job: SweepJob } },
      {
        cron: (expression) => {
          started.push(expression);
          return { stop: () => {}, unref: () => {} };
        },
      },
    );

    scheduler.start();
    expect(started).toEqual(["0 * * * *", "* * * * *"]);
    expect(scheduler.isRunning).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  // A scheduler has nobody to return an error to.
  it("reports a task that threw rather than losing it", async () => {
    class BrokenJob extends Job {
      override async perform(): Promise<void> {
        throw new Error("nope");
      }
    }
    Job.register(BrokenJob);

    const seen: string[] = [];
    let fire: (() => Promise<void>) | undefined;

    new Scheduler(
      { broken: { cron: "* * * * *", job: BrokenJob, performNow: true } },
      {
        cron: (_expression, callback) => {
          fire = callback as () => Promise<void>;
          return { stop: () => {}, unref: () => {} };
        },
        onError: (_error, name) => seen.push(name),
      },
    ).start();

    await fire!();
    expect(seen).toEqual(["broken"]);
  });
});

// A schedule is a list of things that must happen once. Run it on four
// servers and each one happens four times.
describe("running on more than one process", () => {
  const cron = () => ({ stop: () => {}, unref: () => {} });

  it("lets every process run when nothing is claiming", async () => {
    const first = new Scheduler({ sweep: { cron: "0 * * * *", job: SweepJob } }, { cron });
    const second = new Scheduler({ sweep: { cron: "0 * * * *", job: SweepJob } }, { cron });

    await first.run("sweep");
    await second.run("sweep");

    expect(await Job.adapter!.size("default")).toBe(2);
  });

  it("lets exactly one process run when they share a store", async () => {
    const lock = new MemoryStore();
    const options = { cron, lock, now: () => 1_000_000 };

    const first = new Scheduler({ sweep: { cron: "0 * * * *", job: SweepJob } }, options);
    const second = new Scheduler({ sweep: { cron: "0 * * * *", job: SweepJob } }, options);
    const third = new Scheduler({ sweep: { cron: "0 * * * *", job: SweepJob } }, options);

    await Promise.all([first.run("sweep"), second.run("sweep"), third.run("sweep")]);

    expect(await Job.adapter!.size("default")).toBe(1);
  });

  it("lets the next slot run again", async () => {
    const lock = new MemoryStore();
    const scheduler = new Scheduler(
      { sweep: { cron: "0 * * * *", job: SweepJob } },
      { cron, lock },
    );

    expect(await scheduler.claim("sweep", 0)).toBe(true);
    expect(await scheduler.claim("sweep", 30_000)).toBe(false);
    expect(await scheduler.claim("sweep", 90_000)).toBe(true);
  });

  it("keeps one task's claim from another's", async () => {
    const lock = new MemoryStore();
    const scheduler = new Scheduler(
      { a: { cron: "0 * * * *", job: SweepJob }, b: { cron: "0 * * * *", job: SweepJob } },
      { cron, lock },
    );

    expect(await scheduler.claim("a", 0)).toBe(true);
    expect(await scheduler.claim("b", 0)).toBe(true);
  });

  it("keys a claim by task and slot", () => {
    expect(lockKey("sweep", 0, 60)).toBe("schedule/sweep/0");
    expect(lockKey("sweep", 59_000, 60)).toBe("schedule/sweep/0");
    expect(lockKey("sweep", 60_000, 60)).toBe("schedule/sweep/1");
  });
});

describe("the database queue", () => {
  let connection: Connection;
  let queue: DatabaseQueue;

  const payload = (over: Partial<Parameters<DatabaseQueue["enqueue"]>[0]> = {}) => ({
    id: "job-1",
    jobClass: "SweepJob",
    arguments: [1, "two"],
    queue: "default",
    runAt: Date.now(),
    attempts: 0,
    enqueuedAt: Date.now(),
    priority: 0,
    ...over,
  });

  beforeEach(async () => {
    connection = new Connection("sqlite://:memory:");
    await createJobsTable(connection);
    queue = new DatabaseQueue(connection);
  });

  it("creates its table", async () => {
    const rows = await connection.query(`SELECT * FROM ${connection.quote(JOBS_TABLE)}`);
    expect(rows).toEqual([]);
  });

  it("stores and hands back a job", async () => {
    await queue.enqueue(payload());
    const taken = await queue.dequeue("default");

    expect(taken?.jobClass).toBe("SweepJob");
    expect(taken?.arguments).toEqual([1, "two"]);
  });

  it("hands back nothing when there is nothing", async () => {
    expect(await queue.dequeue("default")).toBeNull();
  });

  it("keeps a job whose time has not come", async () => {
    await queue.enqueue(payload({ runAt: Date.now() + 60_000 }));

    expect(await queue.dequeue("default")).toBeNull();
    expect(await queue.size("default")).toBe(1);
  });

  it("takes the oldest first", async () => {
    await queue.enqueue(payload({ id: "second", runAt: Date.now() - 1000 }));
    await queue.enqueue(payload({ id: "first", runAt: Date.now() - 5000 }));

    expect((await queue.dequeue("default"))?.id).toBe("first");
  });

  it("keeps queues apart", async () => {
    await queue.enqueue(payload({ queue: "mailers" }));

    expect(await queue.dequeue("default")).toBeNull();
    expect((await queue.dequeue("mailers"))?.queue).toBe("mailers");
  });

  // Selecting a row and then updating it leaves a window where another worker
  // selects the same one.
  it("hands one job to exactly one worker", async () => {
    await queue.enqueue(payload());

    const workers = Array.from({ length: 5 }, () => queue.dequeue("default"));
    const taken = (await Promise.all(workers)).filter(Boolean);

    expect(taken).toHaveLength(1);
  });

  it("empties as jobs are taken", async () => {
    await queue.enqueue(payload({ id: "a" }));
    await queue.enqueue(payload({ id: "b" }));

    expect(await queue.size("default")).toBe(2);
    await queue.dequeue("default");
    expect(await queue.size("default")).toBe(1);
  });

  it("lists what is waiting", async () => {
    await queue.enqueue(payload({ id: "a" }));
    await queue.enqueue(payload({ id: "b" }));

    expect((await queue.pending()).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  // A worker that dies between claiming and finishing would otherwise hold
  // its job for good, so a crash would lose work rather than retry it.
  it("frees a job a dead worker claimed", async () => {
    await queue.enqueue(payload());
    const claimedAt = Date.now() - 600_000;

    await connection.execute(
      `UPDATE ${connection.quote(JOBS_TABLE)} SET ${connection.quote("claimed_at")} = ?`,
      [claimedAt],
    );
    expect(await queue.dequeue("default")).toBeNull();

    expect(await queue.releaseStale(300)).toBe(1);
    expect(await queue.dequeue("default")).not.toBeNull();
  });

  it("leaves a job a live worker is holding", async () => {
    await queue.enqueue(payload());
    await connection.execute(
      `UPDATE ${connection.quote(JOBS_TABLE)} SET ${connection.quote("claimed_at")} = ?`,
      [Date.now()],
    );

    expect(await queue.releaseStale(300)).toBe(0);
  });
});
