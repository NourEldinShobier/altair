/**
 * Enqueuing several jobs at once.
 *
 * Mirrors activejob/test/cases/enqueuing_test.rb's `perform_all_later` cases.
 *
 * A hundred jobs enqueued in a loop is a hundred round trips, and the loop is
 * the obvious way to write it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { notifications } from "@altair/support";
import { type Connection } from "@altair/orm";
import {
  DatabaseQueue,
  Job,
  beforeEnqueue,
  createJobsTable,
  type JobPayload,
  type QueueAdapter,
} from "../src/index.js";
import { queueConnection, releaseConnection } from "./support/database.js";

class Charge extends Job {
  static override priority = -1;
  override async perform(): Promise<void> {}
}

class Receipt extends Job {
  override async perform(): Promise<void> {}
}

let connection: Connection;
let queue: DatabaseQueue;

const statementsFor = async (body: () => Promise<unknown>): Promise<number> => {
  let statements = 0;
  const subscription = notifications.subscribe("sql.altair", () => {
    statements += 1;
  });

  try {
    await body();
  } finally {
    subscription.unsubscribe();
  }

  return statements;
};

const drain = async (): Promise<JobPayload[]> => {
  const taken: JobPayload[] = [];

  for (;;) {
    const next = await queue.dequeue("default");
    if (!next) return taken;

    taken.push(next);
  }
};

beforeEach(async () => {
  connection = await queueConnection();
  await connection.execute("DROP TABLE IF EXISTS altair_jobs");
  await createJobsTable(connection as never);

  queue = new DatabaseQueue(connection as never);
  Job.adapter = queue;
  Job.resetRegistry();
  Job.register(Charge as typeof Job, Receipt as typeof Job);
});

afterEach(async () => {
  await releaseConnection(connection);
});

describe("a batch", () => {
  it("enqueues every job in it", async () => {
    await Job.performAllLater(Charge.later(1), Receipt.later(2), Receipt.later(3));

    expect(await drain()).toHaveLength(3);
  });

  // The whole reason for it, with both numbers so the first means something.
  it("is one statement where a loop is one each", async () => {
    const loop = await statementsFor(async () => {
      for (let index = 0; index < 5; index += 1) await Receipt.performLater(index);
    });

    await connection.execute("DELETE FROM altair_jobs");

    const batch = await statementsFor(async () => {
      await Job.performAllLater(...Array.from({ length: 5 }, (_, index) => Receipt.later(index)));
    });

    expect(loop).toBe(5);
    expect(batch).toBe(1);
  });

  it("keeps each job's arguments with it", async () => {
    await Job.performAllLater(Receipt.later("a"), Receipt.later("b"));

    const taken = await drain();

    expect(taken.map((payload) => payload.arguments[0]).sort()).toEqual(["a", "b"]);
  });

  it("keeps each job's priority", async () => {
    await Job.performAllLater(Receipt.later(1), Charge.later(2));

    const taken = await drain();

    // Charge is -1, so it comes out first however it went in.
    expect(taken[0]?.jobClass).toBe("Charge");
  });

  it("does nothing when given nothing", async () => {
    const statements = await statementsFor(async () => {
      await Job.performAllLater();
    });

    expect(statements).toBe(0);
  });

  it("refuses an argument that cannot be serialized, at the call site", () => {
    expect(() => Receipt.later(() => undefined)).toThrow();
  });
});

/**
 * An adapter with no bulk insert still works, one job at a time. The
 * difference is throughput, never whether the jobs were enqueued.
 */
describe("an adapter that cannot do it in one", () => {
  it("still enqueues them all", async () => {
    const stored: JobPayload[] = [];

    Job.adapter = {
      async enqueue(payload) {
        stored.push(payload);
      },
      async dequeue() {
        return null;
      },
      async size() {
        return 0;
      },
    } satisfies QueueAdapter;

    await Job.performAllLater(Receipt.later(1), Receipt.later(2));

    expect(stored).toHaveLength(2);
  });
});

/**
 * What Rails does, and worth knowing before reaching for this: a rule that
 * refuses a job is skipped for everything in the batch.
 */
describe("the enqueue callbacks", () => {
  it("do not run", async () => {
    let asked = 0;

    class Watched extends Job {
      @beforeEnqueue
      note(): void {
        asked += 1;
      }

      override async perform(): Promise<void> {}
    }

    Job.register(Watched as typeof Job);

    await Job.performAllLater(Watched.later(1));

    expect(asked).toBe(0);
  });

  it("still run for a job enqueued on its own", async () => {
    let asked = 0;

    class Watched2 extends Job {
      @beforeEnqueue
      note(): void {
        asked += 1;
      }

      override async perform(): Promise<void> {}
    }

    Job.register(Watched2 as typeof Job);

    await Watched2.performLater(1);

    expect(asked).toBe(1);
  });
});
