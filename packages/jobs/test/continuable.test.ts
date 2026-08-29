/**
 * Jobs that survive a restart, ported from
 * `activejob/test/cases/continuable_test.rb` (Rails 8).
 *
 * The problem: a job that runs for an hour and a deploy that restarts the
 * worker after fifty minutes. Without continuations the job is either killed
 * and lost, or killed and retried from the beginning — and from the beginning
 * means the first fifty minutes happen twice, which for anything that sends
 * mail or charges a card is not merely slow.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Continuation,
  Job,
  JobInterrupted,
  MemoryQueue,
  runJob,
  Worker,
  type JobPayload,
} from "../src/index.js";

let queue: MemoryQueue;
const trace: string[] = [];

class Importing extends Job {
  override async perform(): Promise<void> {
    await this.step("find", async () => {
      trace.push("find");
    });

    await this.step("process", async (step) => {
      const start = typeof step.cursor === "number" ? step.cursor + 1 : 0;

      for (let id = start; id < 5; id += 1) {
        trace.push(`process ${id}`);
        await step.advance(id);
      }
    });

    await this.step("report", async () => {
      trace.push("report");
    });
  }
}

beforeEach(() => {
  queue = new MemoryQueue();
  Job.adapter = queue;
  Job.resetRegistry();
  Job.register(Importing);
  trace.length = 0;
});

afterEach(() => {
  Job.adapter = undefined;
});

const enqueued = async (): Promise<JobPayload> => {
  await Importing.performLater();
  return (await queue.dequeue("default"))!;
};

/** Stops the moment the named marker has been traced. */
const stopAfter = (marker: string) => () => trace.includes(marker);

describe("running straight through", () => {
  it("runs every step in order", async () => {
    const result = await runJob(await enqueued(), queue);

    expect(result.status).toBe("completed");
    expect(trace).toEqual([
      "find",
      "process 0",
      "process 1",
      "process 2",
      "process 3",
      "process 4",
      "report",
    ]);
  });

  /**
   * A continuable job called directly is an ordinary job. A test that just
   * wants it to run should not have to build a continuation.
   */
  it("runs outside a worker with nothing to resume from", async () => {
    await Importing.performNow();

    expect(trace).toContain("report");
  });
});

describe("being asked to stop", () => {
  it("stops at the next checkpoint rather than mid-statement", async () => {
    const result = await runJob(await enqueued(), queue, { shouldStop: stopAfter("process 2") });

    expect(result.status).toBe("interrupted");
    expect(trace).toEqual(["find", "process 0", "process 1", "process 2"]);
  });

  it("re-enqueues itself carrying its progress", async () => {
    await runJob(await enqueued(), queue, { shouldStop: stopAfter("process 2") });

    const resumed = (await queue.dequeue("default"))!;

    expect(resumed.continuation?.completed).toEqual(["find"]);
    expect(resumed.continuation?.step).toBe("process");
    expect(resumed.continuation?.cursor).toBe(2);
  });

  /**
   * An interrupt is not a failure. Counting it as an attempt means a long job
   * dies after however many deploys the retry policy allows.
   */
  it("does not burn a retry", async () => {
    await runJob(await enqueued(), queue, { shouldStop: stopAfter("process 2") });

    const resumed = (await queue.dequeue("default"))!;

    expect(resumed.attempts).toBe(0);
  });

  it("comes back ready to run rather than after a wait", async () => {
    await runJob(await enqueued(), queue, { shouldStop: stopAfter("process 2") });

    const resumed = (await queue.dequeue("default"))!;

    expect(resumed.runAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("picking up where it left off", () => {
  it("skips what already finished and resumes the rest", async () => {
    await runJob(await enqueued(), queue, { shouldStop: stopAfter("process 2") });
    const resumed = (await queue.dequeue("default"))!;

    trace.length = 0;
    const result = await runJob(resumed, queue);

    expect(result.status).toBe("completed");
    expect(trace).toEqual(["process 3", "process 4", "report"]);
  });

  it("does not run a finished step a second time", async () => {
    await runJob(await enqueued(), queue, { shouldStop: stopAfter("process 0") });
    const resumed = (await queue.dequeue("default"))!;

    trace.length = 0;
    await runJob(resumed, queue);

    expect(trace).not.toContain("find");
  });

  it("survives being interrupted more than once", async () => {
    let payload = await enqueued();
    const seen: string[] = [];

    for (const marker of ["process 0", "process 2"]) {
      await runJob(payload, queue, { shouldStop: stopAfter(marker) });
      seen.push(...trace);
      trace.length = 0;
      payload = (await queue.dequeue("default"))!;
    }

    await runJob(payload, queue);
    seen.push(...trace);

    // Every id processed exactly once, across three attempts.
    expect(seen.filter((line) => line.startsWith("process"))).toEqual([
      "process 0",
      "process 1",
      "process 2",
      "process 3",
      "process 4",
    ]);
  });
});

describe("a cursor belongs to its step", () => {
  /**
   * Carrying one into a different step would hand it a position from another
   * step's list.
   */
  it("is not handed to a step that did not record it", async () => {
    const seen: unknown[] = [];

    class TwoLists extends Job {
      override async perform(): Promise<void> {
        await this.step("first", async (step) => {
          seen.push(step.cursor);
          await step.advance(99);
        });

        await this.step("second", async (step) => {
          seen.push(step.cursor);
        });
      }
    }

    Job.register(TwoLists);
    await TwoLists.performLater();
    const payload = (await queue.dequeue("default"))!;

    await runJob({ ...payload, continuation: { completed: [], step: "first", cursor: 99 } }, queue);

    expect(seen).toEqual([99, undefined]);
  });
});

describe("checkpoints outside a step", () => {
  it("stop the job between steps", async () => {
    class Checkpointed extends Job {
      override async perform(): Promise<void> {
        await this.step("one", async () => void trace.push("one"));
        this.checkpoint();
        await this.step("two", async () => void trace.push("two"));
      }
    }

    Job.register(Checkpointed);
    await Checkpointed.performLater();
    const payload = (await queue.dequeue("default"))!;

    const result = await runJob(payload, queue, { shouldStop: stopAfter("one") });

    expect(result.status).toBe("interrupted");
    expect(trace).toEqual(["one"]);
  });

  it("do nothing outside a worker", async () => {
    class Checkpointed extends Job {
      override async perform(): Promise<void> {
        this.checkpoint();
        trace.push("ran");
      }
    }

    await Checkpointed.performNow();

    expect(trace).toEqual(["ran"]);
  });
});

describe("the continuation itself", () => {
  it("says when it is stopping", () => {
    expect(new Continuation(undefined, () => true).stopping).toBe(true);
    expect(new Continuation(undefined).stopping).toBe(false);
  });

  it("throws the interrupt carrying its state", () => {
    const continuation = new Continuation({ completed: ["a"] }, () => true);

    try {
      continuation.checkpoint();
      throw new Error("should have interrupted");
    } catch (error) {
      expect(error).toBeInstanceOf(JobInterrupted);
      expect((error as JobInterrupted).continuation.completed).toEqual(["a"]);
    }
  });
});

/**
 * `drain` runs with the worker's running flag false. Without distinguishing
 * "never started" from "asked to stop", every continuable job it ran would
 * interrupt at its first checkpoint — a test suite that never finishes a job.
 */
describe("draining", () => {
  it("runs a continuable job to completion", async () => {
    await Importing.performLater();

    const [result] = await new Worker({ adapter: queue }).drain();

    expect(result!.status).toBe("completed");
    expect(trace).toContain("report");
  });
});

describe("draining", () => {
  /**
   * A draining worker is not shutting down — it is running everything that is
   * ready. A job that interrupted here would re-enqueue itself ready to run
   * and be dequeued again on the next turn of the loop, forever. That is not
   * hypothetical: an earlier version made drain interruptible and a positive
   * control hung the test run rather than failing it.
   */
  it("never interrupts, so it cannot spin", async () => {
    class Stubborn extends Job {
      override async perform(): Promise<void> {
        await this.step("one", async (step) => {
          trace.push("attempt");
          await step.advance(1);
        });
      }
    }

    Job.register(Stubborn);
    await Stubborn.performLater();

    const results = await Promise.race([
      new Worker({ adapter: queue }).drain(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("spun")), 2000)),
    ]);

    expect(results.map((one) => one.status)).toEqual(["completed"]);
    expect(trace).toEqual(["attempt"]);
  });

  /**
   * Scoped to interrupts on purpose: a retry comes back under the same id too,
   * and running it again in one drain is what `drain` is for — it is how a job
   * exhausts its attempts without a worker loop.
   */
  it("still runs a retry to exhaustion in one drain", async () => {
    let attempts = 0;

    class Flaky extends Job {
      static {
        this.retryPolicy = { attempts: 3, backoff: () => 0 };
      }

      override async perform(): Promise<void> {
        attempts += 1;
        throw new Error("not yet");
      }
    }

    Job.register(Flaky);
    await Flaky.performLater();

    await new Worker({ adapter: queue }).drain();

    expect(attempts).toBe(3);
  });
});
