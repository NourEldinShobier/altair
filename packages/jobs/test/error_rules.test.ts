/**
 * Per-error retry rules.
 *
 * Mirrors activejob/test/cases/exceptions_test.rb.
 *
 * Before these, every failure was the same failure: five attempts with a
 * growing wait, whatever went wrong. That is right for a timeout and wrong for
 * everything that will not come right on its own — the record was deleted, the
 * argument no longer deserializes, the remote said 404. Retrying one of those
 * four more times fills the queue and the error tracker with work that was
 * never going to succeed, and the noise is what stops people reading it.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Job, runJob, type JobPayload, type QueueAdapter } from "../src/index.js";

class Gone extends Error {}
class RateLimited extends Error {}
class Timeout extends Error {}

/** Records what was re-enqueued, so a retry can be told from a discard. */
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

class Charge extends Job {
  static {
    this.discardOn(Gone);
    this.retryOn(RateLimited, { attempts: 9, wait: 42 });
  }

  override async perform(): Promise<void> {
    throw thrown;
  }
}

/** A sibling with no rules, to prove one class's rules stay its own. */
class Deliver extends Job {
  override async perform(): Promise<void> {
    throw thrown;
  }
}

const payloadFor = (jobClass: string, attempts = 0): JobPayload => ({
  id: "job-1",
  jobClass,
  queue: "default",
  arguments: [],
  runAt: Date.now(),
  enqueuedAt: Date.now(),
  attempts,
});

const run = async (jobClass: string, error: Error, attempts = 0) => {
  thrown = error;
  return await runJob(payloadFor(jobClass, attempts), queue);
};

beforeEach(() => {
  queue = new RecordingQueue();
  Job.resetRegistry();
  Job.adapter = queue;
  Job.register(Charge as typeof Job, Deliver as typeof Job);
});

describe("discarding", () => {
  it("gives up at once", async () => {
    expect((await run("Charge", new Gone())).status).toBe("discarded");
  });

  it("does not put the job back", async () => {
    await run("Charge", new Gone());

    expect(queue.enqueued).toHaveLength(0);
  });

  // Reported apart from a failure on purpose: a discard is the rule working,
  // and counting it as a failure is how a failure count stops being read.
  it("is not a failure", async () => {
    const result = await run("Charge", new Gone());

    expect(result.status).not.toBe("failed");
    expect(result.error).toBeInstanceOf(Gone);
  });

  it("still carries the error, so it can be reported", async () => {
    expect((await run("Charge", new Gone())).error).toBeInstanceOf(Gone);
  });

  it("catches a subclass, as a catch block would", async () => {
    class LongGone extends Gone {}

    expect((await run("Charge", new LongGone())).status).toBe("discarded");
  });
});

describe("retrying on a particular error", () => {
  it("waits as long as the rule says", async () => {
    await run("Charge", new RateLimited());

    const waited = Math.round((queue.enqueued[0]!.runAt - Date.now()) / 1000);

    expect(waited).toBe(42);
  });

  it("keeps going past the default number of attempts", async () => {
    const result = await run("Charge", new RateLimited(), 6);

    expect(result.status).toBe("retried");
  });

  it("gives up once the rule's own attempts run out", async () => {
    const result = await run("Charge", new RateLimited(), 8);

    expect(result.status).toBe("failed");
  });

  it("takes a wait that grows", async () => {
    class Backing extends Job {
      static {
        this.retryOn(Timeout, { wait: (attempt) => attempt * 10 });
      }

      override async perform(): Promise<void> {
        throw new Timeout();
      }
    }

    Job.register(Backing as typeof Job);
    await runJob(payloadFor("Backing", 2), queue);

    expect(Math.round((queue.enqueued[0]!.runAt - Date.now()) / 1000)).toBe(30);
  });
});

describe("an error no rule mentions", () => {
  it("retries the way it always did", async () => {
    const result = await run("Charge", new Error("something else"));

    expect(result.status).toBe("retried");
  });

  it("uses the class's own policy", async () => {
    await run("Charge", new Error("something else"));

    // The default backoff: attempt ** 4 + 3, so 4 seconds on the first retry.
    expect(Math.round((queue.enqueued[0]!.runAt - Date.now()) / 1000)).toBe(4);
  });
});

// Without the copy-on-write a subclass pushing a rule would push it onto
// whichever class declared the array, and every job would inherit it.
describe("whose rules are whose", () => {
  it("leaves a sibling alone", async () => {
    expect((await run("Deliver", new Gone())).status).toBe("retried");
  });

  it("passes them down to a subclass", async () => {
    class ChargeAgain extends Charge {}

    Job.register(ChargeAgain as typeof Job);

    expect((await run("ChargeAgain", new Gone())).status).toBe("discarded");
  });

  it("does not push a subclass's rule back up to its parent", async () => {
    class Fussy extends Charge {
      static {
        this.discardOn(Timeout);
      }
    }

    Job.register(Fussy as typeof Job);

    expect((await run("Fussy", new Timeout())).status).toBe("discarded");
    expect((await run("Charge", new Timeout())).status).toBe("retried");
  });
});

describe("matching on something other than a class", () => {
  // Anything that came back over HTTP rarely has a class of its own, so a
  // rule has to be able to key off a status code or a message.
  it("takes a predicate", async () => {
    class Api extends Job {
      static {
        this.discardOn((error) => (error as { status?: number }).status === 404);
      }

      override async perform(): Promise<void> {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
    }

    Job.register(Api as typeof Job);

    expect((await runJob(payloadFor("Api"), queue)).status).toBe("discarded");
  });

  it("lets a predicate decline", async () => {
    class Api extends Job {
      static {
        this.discardOn((error) => (error as { status?: number }).status === 404);
      }

      override async perform(): Promise<void> {
        throw Object.assign(new Error("Server Error"), { status: 500 });
      }
    }

    Job.register(Api as typeof Job);

    expect((await runJob(payloadFor("Api"), queue)).status).toBe("retried");
  });

  // Declaration order is the only thing that decides, so a specific rule goes
  // above a general one.
  it("takes the first rule that matches", async () => {
    class Ordered extends Job {
      static {
        this.retryOn(RateLimited, { wait: 7 });
        this.discardOn(Error);
      }

      override async perform(): Promise<void> {
        throw new RateLimited();
      }
    }

    Job.register(Ordered as typeof Job);
    const result = await runJob(payloadFor("Ordered"), queue);

    expect(result.status).toBe("retried");
    expect(Math.round((queue.enqueued[0]!.runAt - Date.now()) / 1000)).toBe(7);
  });
});
