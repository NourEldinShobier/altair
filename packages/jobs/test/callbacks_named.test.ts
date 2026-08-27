/**
 * Job callbacks and queue declarations by name, ported from
 * `activejob/test/cases/callbacks_test.rb` and `queue_naming_test.rb`.
 *
 * `setCallback("perform", "before", fn)` says the same thing. These are what
 * appears in an application, and the difference between reading a name and
 * reading a pair of string arguments is the difference between knowing what a
 * line does and going to check.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Job, MemoryQueue, runJob } from "../src/index.js";

let queue: MemoryQueue;

beforeEach(() => {
  queue = new MemoryQueue();
  Job.adapter = queue;
  Job.resetRegistry();
});

/** Runs everything waiting on a queue. */
const drain = async (name = "default") => {
  for (let payload = await queue.dequeue(name); payload; payload = await queue.dequeue(name)) {
    await runJob(payload, queue);
  }
};

describe("callbacks around the run", () => {
  it("runs before and after", async () => {
    const ran: string[] = [];

    class Ping extends Job {
      static {
        this.beforePerform(() => void ran.push("before"));
        this.afterPerform(() => void ran.push("after"));
      }

      override async perform(): Promise<void> {
        ran.push("perform");
      }
    }

    await Ping.performLater();
    await drain();

    expect(ran).toEqual(["before", "perform", "after"]);
  });

  it("wraps with an around", async () => {
    const ran: string[] = [];

    class Ping extends Job {
      static {
        this.aroundPerform(async (_job: unknown, body: () => Promise<unknown>) => {
          ran.push("in");
          await body();
          ran.push("out");
        });
      }

      override async perform(): Promise<void> {
        ran.push("perform");
      }
    }

    await Ping.performLater();
    await drain();

    expect(ran).toEqual(["in", "perform", "out"]);
  });
});

describe("callbacks around the enqueue", () => {
  it("runs before and after enqueueing, not performing", async () => {
    const ran: string[] = [];

    class Ping extends Job {
      static {
        this.beforeEnqueue(() => void ran.push("before"));
        this.afterEnqueue(() => void ran.push("after"));
      }

      override async perform(): Promise<void> {
        ran.push("perform");
      }
    }

    await Ping.performLater();

    // Enqueued but not yet run: the enqueue callbacks have happened and the
    // perform has not, which is the distinction the two pairs exist for.
    expect(ran).toEqual(["before", "after"]);

    await drain();

    expect(ran).toEqual(["before", "after", "perform"]);
  });
});

/**
 * Which queue a job belongs on is a property of the job. Saying it once is
 * what stops half the call sites putting it somewhere else.
 */
describe("declaring the queue", () => {
  it("puts the job where it says", async () => {
    class Mail extends Job {
      static {
        this.queueAs("mailers");
      }

      override async perform(): Promise<void> {}
    }

    await Mail.performLater();

    expect(await queue.size("mailers")).toBe(1);
    expect(await queue.size("default")).toBe(0);
  });

  it("is still overridden by a call that says otherwise", async () => {
    class Mail extends Job {
      static {
        this.queueAs("mailers");
      }

      override async perform(): Promise<void> {}
    }

    await Mail.set({ queue: "urgent" }).performLater();

    expect(await queue.size("urgent")).toBe(1);
  });

  it("declares a priority the same way", async () => {
    class Sweep extends Job {
      static {
        this.queueWithPriority(10);
      }

      override async perform(): Promise<void> {}
    }

    const payload = await Sweep.performLater();

    expect(payload.priority).toBe(10);
  });

  it("leaves another job's queue alone", async () => {
    class Mail extends Job {
      static {
        this.queueAs("mailers");
      }
      override async perform(): Promise<void> {}
    }

    class Other extends Job {
      override async perform(): Promise<void> {}
    }

    await Mail.performLater();
    await Other.performLater();

    expect(await queue.size("mailers")).toBe(1);
    expect(await queue.size("default")).toBe(1);
  });

  it("names the adapter it is using", () => {
    expect(Job.queueAdapterName).toBe("MemoryQueue");
  });
});
