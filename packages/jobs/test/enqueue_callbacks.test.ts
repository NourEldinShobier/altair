/**
 * Callbacks around the enqueue rather than around the run.
 *
 * Mirrors activejob/test/cases/callbacks_test.rb's enqueue cases.
 *
 * They run in the process that decided to enqueue, where the request that
 * caused it is still in scope — which is the point of having them at all. A
 * `beforePerform` runs in a worker minutes later with none of that, so
 * anything that needs to know who asked has to happen here.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Job,
  afterEnqueue,
  aroundEnqueue,
  beforeEnqueue,
  type JobPayload,
  type QueueAdapter,
} from "../src/index.js";

let order: string[];
let stored: JobPayload[];

const adapter: QueueAdapter = {
  async enqueue(payload) {
    order.push("enqueued");
    stored.push(payload);
  },
  async dequeue() {
    return null;
  },
  async size() {
    return 0;
  },
};

class Watched extends Job {
  @beforeEnqueue
  noteBefore(): void {
    order.push("before");
  }

  @aroundEnqueue
  async noteAround(_target: unknown, block: () => Promise<void>): Promise<void> {
    order.push("around in");
    await block();
    order.push("around out");
  }

  @afterEnqueue
  noteAfter(): void {
    order.push("after");
  }

  override async perform(): Promise<void> {}
}

class Refused extends Job {
  @beforeEnqueue
  refuse(): void {
    throw new Error("not allowed");
  }

  override async perform(): Promise<void> {}
}

class Reader extends Job {
  @beforeEnqueue
  read(): void {
    order.push(`queue=${this.payload?.queue} priority=${this.payload?.priority}`);
  }

  override async perform(): Promise<void> {}
}

beforeEach(() => {
  order = [];
  stored = [];
  Job.adapter = adapter;
  Job.resetRegistry();
  Job.register(Watched as typeof Job, Refused as typeof Job, Reader as typeof Job);
});

describe("the callbacks", () => {
  it("all run", async () => {
    await Watched.performLater();

    expect(order).toContain("before");
    expect(order).toContain("around in");
    expect(order).toContain("after");
  });

  it("run in the order the callback chain gives them", async () => {
    await Watched.performLater();

    expect(order).toEqual(["before", "around in", "enqueued", "after", "around out"]);
  });

  // They wrap the enqueue itself rather than the method, so `afterEnqueue`
  // runs once the adapter has taken it and not before.
  it("put the enqueue between the before and the after", async () => {
    await Watched.performLater();

    expect(order.indexOf("before")).toBeLessThan(order.indexOf("enqueued"));
    expect(order.indexOf("enqueued")).toBeLessThan(order.indexOf("after"));
  });

  it("leave a job with none of them alone", async () => {
    class Plain extends Job {
      override async perform(): Promise<void> {}
    }

    Job.register(Plain as typeof Job);
    await Plain.performLater();

    expect(order).toEqual(["enqueued"]);
  });
});

describe("what a callback can see", () => {
  it("reads the payload about to be enqueued", async () => {
    await Reader.set({ queue: "urgent", priority: -1 }).performLater();

    expect(order).toContain("queue=urgent priority=-1");
  });
});

/**
 * The caller is still there to hear it, which is the difference from a
 * `beforePerform`: that one runs in a worker with nobody waiting.
 */
describe("a before callback that throws", () => {
  it("stops the enqueue", async () => {
    await Refused.performLater().catch(() => undefined);

    expect(stored).toHaveLength(0);
  });

  it("reaches the caller", () => {
    expect(Refused.performLater()).rejects.toThrow("not allowed");
  });
});
