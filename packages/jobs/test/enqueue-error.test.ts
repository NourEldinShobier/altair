/**
 * An adapter refusing a job, ported from `ActiveJob::EnqueueError` and the
 * `enqueue` / `_raw_enqueue` pair in
 * `activejob/lib/active_job/enqueuing.rb`, with the cases from
 * `activejob/test/cases/queuing_test.rb`.
 *
 * The distinction is the whole feature. A queue that is full, read-only, or
 * has rejected the payload has *answered*; a driver that threw a TypeError has
 * not. One of those is a condition an application can be written to expect,
 * and the other is a bug.
 *
 * Without the split there are two bad options and no third. Let everything
 * through and a controller 500s because Redis blinked, on a request whose
 * actual work succeeded. Swallow everything and a broken adapter is a queue
 * that silently accepts nothing, which is the failure nobody notices until the
 * emails have not gone out for a week.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { EnqueueError, Job, type JobPayload } from "../src/job.js";
import { MemoryQueue } from "../src/worker.js";

class Refusing extends MemoryQueue {
  refuse: Error | undefined;

  override async enqueue(payload: JobPayload): Promise<void> {
    if (this.refuse) throw this.refuse;

    await super.enqueue(payload);
  }
}

class Notify extends Job {
  static override jobName = "Notify";

  override async perform(): Promise<void> {}
}

let queue: Refusing;

beforeEach(() => {
  queue = new Refusing();
  Job.adapter = queue;
  queue.refuse = undefined;
});

afterAll(() => {
  Job.adapter = undefined;
});

describe("when the adapter refuses", () => {
  it("hands the caller a payload rather than throwing", async () => {
    queue.refuse = new EnqueueError("the queue is full");

    const payload = await Notify.performLater();

    expect(payload.jobClass).toBe("Notify");
  });

  it("says it was not enqueued", async () => {
    queue.refuse = new EnqueueError("the queue is full");

    expect((await Notify.performLater()).successfullyEnqueued).toBe(false);
  });

  it("keeps the refusal on the payload it is about", async () => {
    const refusal = new EnqueueError("the queue is full");
    queue.refuse = refusal;

    expect((await Notify.performLater()).enqueueError).toBe(refusal);
  });

  it("leaves the job out of the queue", async () => {
    queue.refuse = new EnqueueError("the queue is full");

    await Notify.performLater();

    expect(await queue.size()).toBe(0);
  });

  /** A refusal carries what it was refused for, so a log line can say why. */
  it("keeps the cause the adapter attached", async () => {
    const cause = new Error("ECONNREFUSED");
    queue.refuse = new EnqueueError("the queue is unreachable", { cause });

    expect((await Notify.performLater()).enqueueError?.cause).toBe(cause);
  });
});

describe("when the adapter breaks", () => {
  /**
   * The other half. Swallowing this would turn a bug in an adapter into a
   * queue that accepts everything and holds nothing.
   */
  it("reaches the caller unchanged", async () => {
    queue.refuse = new TypeError("payload.queue is not a function");

    await expect(Notify.performLater()).rejects.toThrow(TypeError);
  });

  it("is not mistaken for a refusal", async () => {
    queue.refuse = new Error("something went wrong");

    await expect(Notify.performLater()).rejects.toThrow(/something went wrong/);
  });
});

describe("when the adapter takes it", () => {
  it("says so", async () => {
    expect((await Notify.performLater()).successfullyEnqueued).toBe(true);
  });

  it("carries no refusal", async () => {
    expect((await Notify.performLater()).enqueueError).toBeUndefined();
  });

  it("queues the job", async () => {
    await Notify.performLater();

    expect(await queue.size()).toBe(1);
  });
});

describe("a payload that never reached an adapter", () => {
  /**
   * Absent rather than true, so "built" and "taken" cannot be confused by
   * anything reading the field.
   */
  it("does not claim to have been enqueued", () => {
    expect(Notify.buildPayload({}, []).successfullyEnqueued).toBe(false);
  });
});
