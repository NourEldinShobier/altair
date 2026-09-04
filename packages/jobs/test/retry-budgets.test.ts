/**
 * One retry budget per rule, ported from `exception_executions` in
 * `activejob/lib/active_job/core.rb` and `executions_for` in
 * `activejob/lib/active_job/exceptions.rb`, with the
 * `test_retry_on_with_different_exceptions` cases from
 * `activejob/test/cases/exceptions_test.rb`.
 *
 * A job with two rules has two budgets:
 *
 *     this.retryOn(RateLimited, { attempts: 10 })
 *     this.retryOn(Timeout, { attempts: 3 })
 *
 * There was one counter, so they shared. Nine rate limits and the job's first
 * timeout was also its last: the count was already past three, and the
 * `attempts: 3` written against `Timeout` had been spent by an error it says
 * nothing about.
 *
 * It fails in the direction nobody checks. The job does not crash, it gives
 * up — and gives up on the failure that would have come right, having used its
 * tries on the one that was always going to be slow. Rails keeps a count per
 * declaration for exactly this.
 */

import { Logger, setComponentLogger } from "@altair/support";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Job, runJob, type JobPayload, type QueueAdapter } from "../src/index.js";

beforeEach(() => {
  setComponentLogger("jobs", new Logger({ level: "fatal", sink: () => undefined }));
});

afterEach(() => {
  setComponentLogger("jobs", undefined);
});

class RateLimited extends Error {}
class Timeout extends Error {}

class RecordingQueue implements QueueAdapter {
  readonly enqueued: JobPayload[] = [];

  async enqueue(payload: JobPayload): Promise<void> {
    this.enqueued.push(payload);
  }

  async dequeue(): Promise<JobPayload | null> {
    return null;
  }

  async size(): Promise<number> {
    return 0;
  }
}

let queue: RecordingQueue;
let thrown: Error;

class Sync extends Job {
  static {
    this.retryOn(RateLimited, { attempts: 10, wait: 1 });
    this.retryOn(Timeout, { attempts: 3, wait: 1 });
  }

  override async perform(): Promise<void> {
    throw thrown;
  }
}

const fresh = (): JobPayload => ({
  id: "job-1",
  jobClass: "Sync",
  queue: "default",
  arguments: [],
  runAt: Date.now(),
  enqueuedAt: Date.now(),
  priority: 0,
  attempts: 0,
});

/** Runs the job repeatedly, feeding each result's payload into the next run. */
const failWith = async (errors: Error[]): Promise<{ status: string; payload: JobPayload }[]> => {
  const results: { status: string; payload: JobPayload }[] = [];
  let payload = fresh();

  for (const error of errors) {
    thrown = error;

    const result = await runJob(payload, queue);

    results.push({ status: result.status, payload: result.payload });
    payload = result.payload;
  }

  return results;
};

beforeEach(() => {
  queue = new RecordingQueue();
  Job.resetRegistry();
  Job.adapter = queue;
  Job.register(Sync as typeof Job);
});

describe("two rules on one job", () => {
  /** The bug: a rule's budget spent by an error it says nothing about. */
  it("does not let one error spend another's tries", async () => {
    const rateLimits = Array.from({ length: 9 }, () => new RateLimited());
    const results = await failWith([...rateLimits, new Timeout()]);

    expect(results.at(-1)?.status).toBe("retried");
  });

  it("counts each rule separately", async () => {
    const results = await failWith([new RateLimited(), new Timeout(), new RateLimited()]);

    expect(results.at(-1)?.payload.exceptionExecutions).toEqual({
      RateLimited: 2,
      Timeout: 1,
    });
  });

  it("still stops a rule at its own limit", async () => {
    const results = await failWith([new Timeout(), new Timeout(), new Timeout()]);

    expect(results.map((one) => one.status)).toEqual(["retried", "retried", "failed"]);
  });

  it("stops the other rule at its own, larger limit", async () => {
    const results = await failWith(Array.from({ length: 10 }, () => new RateLimited()));

    expect(results.at(-1)?.status).toBe("failed");
    expect(results.slice(0, -1).every((one) => one.status === "retried")).toBe(true);
  });

  /**
   * A rule that has run out stays out, even while the other is still going.
   * Otherwise a job alternating between two failures never stops.
   */
  it("keeps a spent rule spent", async () => {
    const spent = await failWith([new Timeout(), new Timeout(), new Timeout()]);

    thrown = new Timeout();
    const again = await runJob(spent.at(-1)?.payload as JobPayload, queue);

    expect(again.status).toBe("failed");
  });
});

describe("the wait between attempts", () => {
  class Backing extends Job {
    static {
      this.retryOn(RateLimited, { attempts: 10, wait: (n) => n * 100 });
      this.retryOn(Timeout, { attempts: 5, wait: (n) => n * 10 });
    }

    override async perform(): Promise<void> {
      throw thrown;
    }
  }

  beforeEach(() => {
    Job.register(Backing as typeof Job);
  });

  /**
   * Grows with the rule's own count, not the job's. A timeout arriving after
   * two rate limits is that rule's *first*, and backing it off as though it
   * were the third makes the wait depend on an unrelated failure.
   */
  it("grows with the rule's own count", async () => {
    let payload: JobPayload = { ...fresh(), jobClass: "Backing" };

    for (const error of [new RateLimited(), new RateLimited()]) {
      thrown = error;
      payload = (await runJob(payload, queue)).payload;
    }

    thrown = new Timeout();
    await runJob(payload, queue);

    const waited = Math.round((queue.enqueued.at(-1)!.runAt - Date.now()) / 1000);

    expect(waited).toBe(10);
  });

  it("uses the rule's own count for the rule that has been failing", async () => {
    let payload: JobPayload = { ...fresh(), jobClass: "Backing" };

    for (const _ of [0, 1, 2]) {
      thrown = new RateLimited();
      payload = (await runJob(payload, queue)).payload;
    }

    const waited = Math.round((queue.enqueued.at(-1)!.runAt - Date.now()) / 1000);

    expect(waited).toBe(300);
  });
});

describe("a payload from before this existed", () => {
  /**
   * No record of which rule spent what, so its total is the only count there
   * is. Starting every budget at zero instead would hand a job that was
   * already nine retries deep at the deploy nine more of each.
   */
  it("is counted against whichever rule catches it next", async () => {
    thrown = new RateLimited();

    const result = await runJob({ ...fresh(), attempts: 9 }, queue);

    expect(result.status).toBe("failed");
  });

  it("switches to per-rule counting from then on", async () => {
    thrown = new Timeout();

    const first = await runJob({ ...fresh(), attempts: 1 }, queue);

    expect(first.payload.exceptionExecutions).toEqual({ Timeout: 2 });

    const second = await runJob(first.payload, queue);

    expect(second.payload.exceptionExecutions).toEqual({ Timeout: 3 });
    expect(second.status).toBe("failed");
  });
});

describe("the total", () => {
  /** Still counted, because "how many times has this job run" is its own question. */
  it("counts every attempt whichever rule matched", async () => {
    const results = await failWith([new RateLimited(), new Timeout(), new RateLimited()]);

    expect(results.at(-1)?.payload.attempts).toBe(3);
  });
});

describe("a job with one rule", () => {
  class Only extends Job {
    static {
      this.retryOn(Timeout, { attempts: 2, wait: 1 });
    }

    override async perform(): Promise<void> {
      throw thrown;
    }
  }

  beforeEach(() => {
    Job.register(Only as typeof Job);
  });

  it("behaves as it always did", async () => {
    thrown = new Timeout();

    const first = await runJob({ ...fresh(), jobClass: "Only" }, queue);

    expect(first.status).toBe("retried");

    const second = await runJob(first.payload, queue);

    expect(second.status).toBe("failed");
  });
});
