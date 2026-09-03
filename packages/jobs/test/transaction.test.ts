/**
 * Jobs waiting for the transaction that enqueued them.
 *
 * Mirrors activejob/test/cases/queuing_test.rb's transaction section, added in
 * Rails 7.2 when `enqueue_after_transaction_commit` became the default. It
 * became the default because the alternative kept biting people, and this file
 * is mostly about showing what the alternative does.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "@altair/orm";
import { errors } from "@altair/support";
import {
  EnqueueError,
  Job,
  MemoryQueue,
  type JobPayload,
  type QueueAdapter,
} from "../src/index.js";

interface OrderRow {
  id: number;
  reference: string;
}

class Order extends Model<OrderRow>("orders") {}

class ChargeCard extends Job {
  override async perform(): Promise<void> {}
}

let queue: MemoryQueue;
let connection: Connection;

const enqueued = (): readonly JobPayload[] => queue.pending();

beforeEach(async () => {
  queue = new MemoryQueue();
  Job.adapter = queue;
  Job.resetRegistry();
  Job.register(ChargeCard as never);

  connection = new Connection("sqlite://:memory:");
  setConnection(connection);
  Order.resetColumnInformation();

  await new SchemaStatements(connection).createTable("orders", (t) => {
    t.string("reference");
  });
});

describe("with no transaction", () => {
  it("enqueues straight away", async () => {
    await ChargeCard.performLater(1);

    expect(enqueued()).toHaveLength(1);
  });

  // The caller is still there to hear about it, so a queue that is down has to
  // reach them rather than being reported and forgotten.
  it("lets a failing enqueue reach the caller", async () => {
    Job.adapter = {
      async enqueue() {
        throw new Error("the queue is down");
      },
      async dequeue() {
        return null;
      },
    } as unknown as QueueAdapter;

    await expect(ChargeCard.performLater(1)).rejects.toThrow("the queue is down");
  });
});

describe("inside a transaction that commits", () => {
  it("waits for the commit", async () => {
    await connection.transaction(async () => {
      await Order.create({ reference: "A" });
      await ChargeCard.performLater(1);

      // The row is written but nothing may act on it yet.
      expect(enqueued()).toHaveLength(0);
    });

    expect(enqueued()).toHaveLength(1);
  });

  it("still returns the payload at the call site", async () => {
    let payload: JobPayload | undefined;

    await connection.transaction(async () => {
      payload = await ChargeCard.performLater(7);
    });

    expect(payload?.arguments).toEqual([7]);
    expect(enqueued()[0]?.id).toBe(payload?.id as string);
  });

  it("keeps the options it was given", async () => {
    await connection.transaction(async () => {
      await ChargeCard.set({ queue: "urgent" }).performLater(1);
    });

    expect(queue.pending("urgent")[0]?.arguments).toEqual([1]);
  });
});

describe("a refusal after the commit", () => {
  /**
   * The caller returned when the transaction was still open, so there is
   * nobody left to read `enqueueError` off the payload. A refusal that only
   * set a field here would be a job that vanished silently — which is exactly
   * what `EnqueueError` exists to stop the adapter from doing.
   */
  it("is reported, because nobody is left to be told", async () => {
    const seen: unknown[] = [];
    const subscription = errors.subscribe((error) => seen.push(error));
    const refusal = new EnqueueError("the queue is full");

    Job.adapter = {
      async enqueue() {
        throw refusal;
      },
      async dequeue() {
        return null;
      },
    } as unknown as QueueAdapter;

    try {
      await connection.transaction(async () => {
        await ChargeCard.performLater(1);
      });
    } finally {
      subscription.unsubscribe();
    }

    expect(seen).toEqual([refusal]);
  });

  it("does not report one the adapter took", async () => {
    const seen: unknown[] = [];
    const subscription = errors.subscribe((error) => seen.push(error));

    try {
      await connection.transaction(async () => {
        await ChargeCard.performLater(1);
      });
    } finally {
      subscription.unsubscribe();
    }

    expect(seen).toEqual([]);
  });
});

// The bug the default exists to prevent: a worker holding the id of a row that
// never existed, or picking the job up before the commit lands.
describe("inside a transaction that rolls back", () => {
  it("never enqueues", async () => {
    await connection
      .transaction(async () => {
        await Order.create({ reference: "A" });
        await ChargeCard.performLater(1);

        throw new Error("something failed later in the request");
      })
      .catch(() => undefined);

    expect(enqueued()).toHaveLength(0);
    expect(await Order.count()).toBe(0);
  });

  it("leaves the error alone", async () => {
    await expect(
      connection.transaction(async () => {
        await ChargeCard.performLater(1);
        throw new Error("the real problem");
      }),
    ).rejects.toThrow("the real problem");
  });
});

describe("opting out", () => {
  // Rarer than it sounds: a job that runs against uncommitted data cannot see
  // it either. But a job that has nothing to do with the transaction is a fair
  // reason to ask.
  it("enqueues immediately when told to", async () => {
    await connection.transaction(async () => {
      await ChargeCard.set({ enqueueAfterCommit: false }).performLater(1);

      expect(enqueued()).toHaveLength(1);
    });
  });

  it("keeps it enqueued even when the transaction rolls back", async () => {
    await connection
      .transaction(async () => {
        await ChargeCard.set({ enqueueAfterCommit: false }).performLater(1);
        throw new Error("rolled back");
      })
      .catch(() => undefined);

    expect(enqueued()).toHaveLength(1);
  });
});

describe("nesting", () => {
  // A savepoint releasing has committed nothing.
  it("waits for the outermost transaction", async () => {
    await connection.transaction(async (outer) => {
      await outer.transaction(async () => {
        await ChargeCard.performLater(1);
      });

      expect(enqueued()).toHaveLength(0);
    });

    expect(enqueued()).toHaveLength(1);
  });
});
