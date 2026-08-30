/**
 * What a queue announces about itself, ported from
 * `activejob/test/cases/instrumentation_test.rb` and the log-subscriber cases.
 *
 * The worker knew everything worth knowing and told nobody: it returned a
 * status to whoever called it, which serves the loop and nothing else. There
 * was no way to count retries, alert on a job that gave up, or notice a
 * queue's latency growing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { notifications } from "@altair/support";
import { Job, MemoryQueue, runJob, type JobPayload } from "../src/index.js";
import { JOB_EVENTS, afterDiscard, resetDiscardCallbacks } from "../src/events.js";
import { Logger, setComponentLogger } from "@altair/support";

class Fine extends Job {
  override async perform(): Promise<void> {
    // Nothing to do; the point is that it succeeds.
  }
}

class Broken extends Job {
  override async perform(): Promise<void> {
    throw new Error("boom");
  }
}

class Refused extends Job {
  static {
    this.discardOn(TypeError);
  }

  override async perform(): Promise<void> {
    throw new TypeError("will never work");
  }
}

let queue: MemoryQueue;
const seen: { name: string; payload: Record<string, unknown> }[] = [];
const stops: (() => void)[] = [];

beforeEach(() => {
  // A discard writes an error line, which is right in an application and noise
  // in a suite that discards on purpose. Quietening the one component is
  // exactly what a per-component logger is for.
  setComponentLogger("jobs", new Logger({ level: "fatal", sink: () => undefined }));

  queue = new MemoryQueue();
  Job.adapter = queue;
  Job.register(Fine, Broken, Refused);
  seen.length = 0;

  for (const name of Object.values(JOB_EVENTS)) {
    const subscription = notifications.subscribe(name, (event) => {
      seen.push({ name, payload: event.payload as Record<string, unknown> });
    });

    stops.push(() => {
      subscription.unsubscribe();
    });
  }
});

afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;

  Job.adapter = undefined;
  Job.resetRegistry();
  resetDiscardCallbacks();
  setComponentLogger("jobs", undefined);
});

const namesSeen = (): string[] => seen.map((one) => one.name);
const payloadOf = (name: string): Record<string, unknown> =>
  seen.find((one) => one.name === name)?.payload ?? {};

function payloadFor(jobClass: string, attempts = 0): JobPayload {
  return {
    id: "1",
    jobClass,
    queue: "default",
    arguments: [],
    attempts,
    runAt: 0,
    enqueuedAt: 0,
    priority: 0,
  };
}

describe("enqueueing", () => {
  it("announces a job that was queued", async () => {
    await Fine.performLater();

    expect(namesSeen()).toContain(JOB_EVENTS.enqueue);
  });

  it("says which job and which queue", async () => {
    await Fine.performLater();

    const payload = payloadOf(JOB_EVENTS.enqueue);

    expect(payload.jobClass).toBe("Fine");
    expect(payload.queue).toBe("default");
  });

  /**
   * How much work is arriving and how much is waiting are different questions,
   * and a dashboard adding them together reports a backlog that is not one.
   */
  it("announces a scheduled job separately", async () => {
    await Fine.set({ wait: 60 }).performLater();

    expect(namesSeen()).toContain(JOB_EVENTS.enqueueAt);
    expect(namesSeen()).not.toContain(JOB_EVENTS.enqueue);
  });

  it("says when a scheduled job is due", async () => {
    await Fine.set({ wait: 60 }).performLater();

    expect(payloadOf(JOB_EVENTS.enqueueAt).runAt).toBeGreaterThan(Date.now());
  });

  it("announces a bulk enqueue once", async () => {
    await Job.performAllLater({ payload: payloadFor("Fine") });

    expect(namesSeen().filter((one) => one === JOB_EVENTS.bulkEnqueued)).toHaveLength(1);
  });

  /** An event carrying thousands of payloads costs more than the work it describes. */
  it("counts a bulk enqueue rather than listing it", async () => {
    await Job.performAllLater(
      { payload: payloadFor("Fine") },
      { payload: payloadFor("Fine") },
      { payload: payloadFor("Broken") },
    );

    const payload = payloadOf(JOB_EVENTS.bulkEnqueued);

    expect(payload.count).toBe(3);
    expect(payload.jobClasses).toEqual(["Fine", "Broken"]);
  });

  it("announces nothing for an empty bulk enqueue", async () => {
    await Job.performAllLater();

    expect(namesSeen()).not.toContain(JOB_EVENTS.bulkEnqueued);
  });
});

describe("performing", () => {
  it("announces the start and the finish", async () => {
    await runJob(payloadFor("Fine"), queue);

    expect(namesSeen()).toContain(JOB_EVENTS.performStart);
    expect(namesSeen()).toContain(JOB_EVENTS.perform);
  });

  it("announces the start before the finish", async () => {
    await runJob(payloadFor("Fine"), queue);

    expect(namesSeen().indexOf(JOB_EVENTS.performStart)).toBeLessThan(
      namesSeen().indexOf(JOB_EVENTS.perform),
    );
  });

  it("says which job ran", async () => {
    await runJob(payloadFor("Fine"), queue);

    expect(payloadOf(JOB_EVENTS.performStart).jobClass).toBe("Fine");
  });
});

describe("retrying", () => {
  it("announces a retry that was scheduled", async () => {
    await runJob(payloadFor("Broken"), queue);

    expect(namesSeen()).toContain(JOB_EVENTS.retryScheduled);
  });

  /**
   * "It will be retried" and "it will be retried in four hours" call for
   * different reactions, and only one of them is visible from a queue depth.
   */
  it("says when the retry is due", async () => {
    await runJob(payloadFor("Broken"), queue);

    expect(payloadOf(JOB_EVENTS.retryScheduled).runAt).toBeGreaterThan(Date.now());
  });

  it("carries the error", async () => {
    await runJob(payloadFor("Broken"), queue);

    expect((payloadOf(JOB_EVENTS.retryScheduled).error as Error).message).toBe("boom");
  });

  it("announces when the tries run out", async () => {
    await runJob(payloadFor("Broken", 99), queue);

    expect(namesSeen()).toContain(JOB_EVENTS.retryStopped);
    expect(namesSeen()).not.toContain(JOB_EVENTS.retryScheduled);
  });
});

describe("discarding", () => {
  /**
   * The event worth alerting on. The work will never happen, nothing remains
   * in the queue to notice, and without this the only record is a log line.
   */
  it("announces a job a rule refused", async () => {
    await runJob(payloadFor("Refused"), queue);

    expect(namesSeen()).toContain(JOB_EVENTS.discarded);
  });

  /** Ran out of tries and refused by a rule are different things. */
  it("is not the same event as running out of tries", async () => {
    await runJob(payloadFor("Refused"), queue);

    expect(namesSeen()).not.toContain(JOB_EVENTS.retryStopped);
  });

  it("carries the error", async () => {
    await runJob(payloadFor("Refused"), queue);

    expect((payloadOf(JOB_EVENTS.discarded).error as Error).message).toBe("will never work");
  });

  /**
   * Beside the notification rather than instead of it: an event is for
   * something watching from outside, and this is for the application's own
   * reaction.
   */
  it("runs the callbacks an application registered", async () => {
    const discarded: string[] = [];

    afterDiscard((payload) => {
      discarded.push(payload.jobClass);
    });

    await runJob(payloadFor("Refused"), queue);

    expect(discarded).toEqual(["Refused"]);
  });

  it("runs several", async () => {
    const order: string[] = [];

    afterDiscard(() => void order.push("one"));
    afterDiscard(() => void order.push("two"));

    await runJob(payloadFor("Refused"), queue);

    expect(order).toEqual(["one", "two"]);
  });

  /** The job is already lost; losing the notification too makes it silent. */
  it("keeps going when a callback throws", async () => {
    const order: string[] = [];

    afterDiscard(() => {
      throw new Error("callback failed");
    });
    afterDiscard(() => void order.push("still ran"));

    const result = await runJob(payloadFor("Refused"), queue);

    expect(order).toEqual(["still ran"]);
    expect(result.status).toBe("discarded");
  });

  it("stops running one that was removed", async () => {
    const discarded: string[] = [];
    const stop = afterDiscard(() => void discarded.push("ran"));

    stop();

    await runJob(payloadFor("Refused"), queue);

    expect(discarded).toEqual([]);
  });

  it("does not run them for a job that merely failed", async () => {
    const discarded: string[] = [];

    afterDiscard(() => void discarded.push("ran"));

    await runJob(payloadFor("Broken"), queue);

    expect(discarded).toEqual([]);
  });
});
