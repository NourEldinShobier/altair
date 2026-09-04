/**
 * Assertions about what an action put on the queue, ported from
 * `activejob/test/cases/test_helper_test.rb`.
 *
 * The thing worth testing about a background job is almost never the job. It is
 * that the action enqueued it — that placing an order sends the confirmation,
 * and that placing it twice does not send two.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { AssertionFailed } from "@altair/support";
import { Job } from "@altair/jobs";
import {
  assertEnqueuedJobs,
  assertEnqueuedWith,
  assertNoEnqueuedJobs,
  performEnqueuedJobs,
} from "../src/jobs.js";

class ChargeCard extends Job {
  override async perform(): Promise<void> {}
}

class SendReceipt extends Job {
  override async perform(): Promise<void> {}
}

beforeEach(() => {
  Job.resetRegistry();
  Job.register(ChargeCard, SendReceipt);
});

describe("counting what was enqueued", () => {
  it("passes when the count matches", async () => {
    await assertEnqueuedJobs(Job, 1, async () => {
      await ChargeCard.performLater(7);
    });
  });

  it("fails when it does not", async () => {
    await expect(
      assertEnqueuedJobs(Job, 1, async () => {
        await ChargeCard.performLater(7);
        await ChargeCard.performLater(8);
      }),
    ).rejects.toBeInstanceOf(AssertionFailed);
  });

  /**
   * "Expected 1, got 2" sends somebody counting call sites when the answer is
   * usually a callback enqueueing a second one they had forgotten about.
   */
  it("names what it found", async () => {
    await expect(
      assertEnqueuedJobs(Job, 1, async () => {
        await ChargeCard.performLater(7);
        await SendReceipt.performLater(7);
      }),
    ).rejects.toThrow(/Enqueued: ChargeCard, SendReceipt/);
  });

  it("counts one class at a time when asked", async () => {
    await assertEnqueuedJobs(
      Job,
      1,
      async () => {
        await ChargeCard.performLater(7);
        await SendReceipt.performLater(7);
      },
      { only: ChargeCard },
    );
  });

  it("passes when nothing was enqueued and nothing should have been", async () => {
    await assertNoEnqueuedJobs(Job, async () => {});
  });

  it("fails when something was", async () => {
    await expect(
      assertNoEnqueuedJobs(Job, async () => {
        await ChargeCard.performLater(7);
      }),
    ).rejects.toBeInstanceOf(AssertionFailed);
  });
});

describe("matching a particular job", () => {
  it("finds it among several", async () => {
    await assertEnqueuedWith(Job, { job: ChargeCard, args: [7] }, async () => {
      await SendReceipt.performLater(1);
      await ChargeCard.performLater(7);
    });
  });

  it("fails when the arguments differ", async () => {
    await expect(
      assertEnqueuedWith(Job, { job: ChargeCard, args: [8] }, async () => {
        await ChargeCard.performLater(7);
      }),
    ).rejects.toBeInstanceOf(AssertionFailed);
  });

  it("shows what was enqueued instead", async () => {
    await expect(
      assertEnqueuedWith(Job, { job: ChargeCard, args: [8] }, async () => {
        await ChargeCard.performLater(7);
      }),
    ).rejects.toThrow(/ChargeCard\(\[7\]\)/);
  });

  it("says nothing was enqueued when nothing was", async () => {
    await expect(assertEnqueuedWith(Job, { job: ChargeCard }, async () => {})).rejects.toThrow(
      /Nothing was enqueued/,
    );
  });

  it("matches on the class alone when no arguments are given", async () => {
    await assertEnqueuedWith(Job, { job: ChargeCard }, async () => {
      await ChargeCard.performLater(99);
    });
  });
});

/**
 * For the test that is about a job's effect rather than about it being
 * enqueued — where the assertion is on the mailbox rather than on the queue.
 */
describe("running what was enqueued", () => {
  it("runs them", async () => {
    const ran: unknown[] = [];

    const performed = await performEnqueuedJobs(
      Job,
      async (payload) => void ran.push(payload.arguments),
      async () => {
        await ChargeCard.performLater(7);
      },
    );

    expect(performed).toHaveLength(1);
    expect(ran).toEqual([[7]]);
  });

  /**
   * A snapshot taken before the loop would run the first and quietly drop
   * everything it led to, which is most of what a chain of jobs is.
   */
  it("runs what a job enqueues in turn", async () => {
    const ran: string[] = [];

    await performEnqueuedJobs(
      Job,
      async (payload) => {
        ran.push(payload.jobClass);
        if (payload.jobClass === "ChargeCard") await SendReceipt.performLater(7);
      },
      async () => {
        await ChargeCard.performLater(7);
      },
    );

    expect(ran).toEqual(["ChargeCard", "SendReceipt"]);
  });

  it("runs only the class it was given", async () => {
    const ran: string[] = [];

    await performEnqueuedJobs(
      Job,
      async (payload) => void ran.push(payload.jobClass),
      async () => {
        await ChargeCard.performLater(7);
        await SendReceipt.performLater(7);
      },
      { only: SendReceipt },
    );

    expect(ran).toEqual(["SendReceipt"]);
  });

  /**
   * A test that left the application pointed at a recording queue would make
   * every test after it silently stop delivering.
   */
  it("puts the real queue back, even when the block throws", async () => {
    const before = Job.adapter;

    await performEnqueuedJobs(
      Job,
      async () => {},
      async () => {
        throw new Error("nope");
      },
    ).catch(() => undefined);

    expect(Job.adapter).toBe(before);
  });
});
