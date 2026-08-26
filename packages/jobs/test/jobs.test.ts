/**
 * Job suite.
 *
 * Mirrors activejob/test/cases/ — enqueuing, performing, queues, retries and
 * the worker loop.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Job,
  UnknownJob,
  assertSerializable,
  beforePerform,
  afterPerform,
  defaultAdapter,
} from "../src/job.js";
import {
  InlineQueue,
  MemoryQueue,
  RedisQueue,
  Worker,
  runJob,
  type RedisQueueClient,
} from "../src/worker.js";

let queue: MemoryQueue;
const ran: string[] = [];

class Greet extends Job<[name: string]> {
  override async perform(name: string): Promise<string> {
    ran.push(`hello ${name}`);
    return `hello ${name}`;
  }
}

class Flaky extends Job<[]> {
  static failures = 0;
  static override retryPolicy = { attempts: 3, backoff: () => 0 };

  override async perform(): Promise<void> {
    Flaky.failures += 1;
    throw new Error("still broken");
  }
}

class Reports extends Job<[]> {
  static override queueName = "reports";
  override async perform(): Promise<void> {
    ran.push("report");
  }
}

beforeEach(() => {
  queue = new MemoryQueue();
  Job.adapter = queue;
  Job.resetRegistry();
  Job.register(Greet as never, Flaky as never, Reports as never);
  ran.length = 0;
  Flaky.failures = 0;
});

describe("performing", () => {
  it("runs a job now", async () => {
    expect(await Greet.performNow("Ada")).toBe("hello Ada");
    expect(ran).toEqual(["hello Ada"]);
  });

  it("reports a job that does not implement perform", async () => {
    class Empty extends Job {}
    await expect(Empty.performNow()).rejects.toThrow("does not implement perform");
  });

  it("runs callbacks around perform", async () => {
    const order: string[] = [];

    class Hooked extends Job<[]> {
      @beforePerform
      before(): void {
        order.push("before");
      }

      @afterPerform
      after(): void {
        order.push("after");
      }

      override async perform(): Promise<void> {
        order.push("perform");
      }
    }

    await Hooked.performNow();
    expect(order).toEqual(["before", "perform", "after"]);
  });
});

describe("enqueuing", () => {
  it("puts a job on its queue", async () => {
    const payload = await Greet.performLater("Ada");

    expect(payload.jobClass).toBe("Greet");
    expect(payload.arguments).toEqual(["Ada"]);
    expect(payload.queue).toBe("default");
    expect(await queue.size("default")).toBe(1);
  });

  it("honours queueName", async () => {
    await Reports.performLater();

    expect(await queue.size("reports")).toBe(1);
    expect(await queue.size("default")).toBe(0);
  });

  it("delays with wait", async () => {
    const before = Date.now();
    const payload = await Greet.set({ wait: 60 }).performLater("Ada");

    expect(payload.runAt).toBeGreaterThanOrEqual(before + 59_000);
  });

  it("delays until a time", async () => {
    const when = new Date(Date.now() + 5000);
    const payload = await Greet.set({ waitUntil: when }).performLater("Ada");

    expect(payload.runAt).toBe(when.getTime());
  });

  it("overrides the queue per enqueue", async () => {
    await Greet.set({ queue: "urgent" }).performLater("Ada");
    expect(await queue.size("urgent")).toBe(1);
  });

  it("gives each job an id", async () => {
    const first = await Greet.performLater("a");
    const second = await Greet.performLater("b");

    expect(first.id).not.toBe(second.id);
  });

  // Production is the environment with no default: every adapter that needs
  // no configuration keeps its jobs in memory, and a job that has to outlive
  // the process that enqueued it cannot live there.
  it("refuses to guess an adapter in production", () => {
    expect(() => defaultAdapter("production")).toThrow("No queue adapter");
  });

  // Neither default can lose work — one collects it, the other runs it.
  it("picks one that cannot lose the job everywhere else", () => {
    expect(defaultAdapter("test")).toBeInstanceOf(MemoryQueue);
    expect(defaultAdapter("development")).toBeInstanceOf(InlineQueue);
  });
});

describe("argument serialization", () => {
  // The worker is another process, possibly after a deploy. Failing at the
  // call site beats failing in a worker at 3am with no context.
  it("rejects a function", () => {
    expect(() => assertSerializable([() => {}], "Greet")).toThrow("cannot take a function");
  });

  it("rejects a symbol and a bigint", () => {
    expect(() => assertSerializable([Symbol("x")], "Greet")).toThrow("cannot take a symbol");
    expect(() => assertSerializable([1n], "Greet")).toThrow("cannot take a bigint");
  });

  it("rejects a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => assertSerializable([circular], "Greet")).toThrow("cannot be serialized");
  });

  it("accepts plain data", () => {
    expect(() => assertSerializable([1, "a", null, { nested: [1, 2] }], "Greet")).not.toThrow();
  });

  it("fails at the call site", async () => {
    await expect(Greet.performLater((() => {}) as never)).rejects.toThrow("cannot take a function");
  });
});

describe("memory queue", () => {
  it("hands out a ready job", async () => {
    await Greet.performLater("Ada");
    expect(await queue.dequeue("default")).toMatchObject({ jobClass: "Greet" });
  });

  it("withholds a delayed job", async () => {
    await Greet.set({ wait: 60 }).performLater("Ada");
    expect(await queue.dequeue("default")).toBeNull();
  });

  // A delayed job at the head must not block a ready one behind it.
  it("orders by when a job becomes runnable", async () => {
    await Greet.set({ wait: 60 }).performLater("later");
    await Greet.performLater("now");

    const next = await queue.dequeue("default");
    expect(next?.arguments).toEqual(["now"]);
  });

  it("is empty when nothing is queued", async () => {
    expect(await queue.dequeue("default")).toBeNull();
    expect(await queue.size("default")).toBe(0);
  });
});

describe("registry", () => {
  it("resolves a registered class", () => {
    expect(Job.lookup("Greet")).toBe(Greet as never);
  });

  it("explains an unregistered class", () => {
    expect(() => Job.lookup("Missing")).toThrow(UnknownJob);
    expect(() => Job.lookup("Missing")).toThrow("Register it with Job.register()");
  });
});

describe("running and retrying", () => {
  it("runs a queued job", async () => {
    await Greet.performLater("Ada");
    const payload = (await queue.dequeue("default"))!;

    expect((await runJob(payload, queue)).status).toBe("completed");
    expect(ran).toEqual(["hello Ada"]);
  });

  it("re-enqueues a failure for another attempt", async () => {
    await Flaky.performLater();
    const payload = (await queue.dequeue("default"))!;

    const result = await runJob(payload, queue);

    expect(result.status).toBe("retried");
    expect(result.payload.attempts).toBe(1);
    expect(await queue.size("default")).toBe(1);
  });

  it("gives up after the policy's attempts", async () => {
    await Flaky.performLater();

    const worker = new Worker({ adapter: queue });
    const results = await worker.drain();

    // Three attempts: two retries then a failure.
    expect(Flaky.failures).toBe(3);
    expect(results.at(-1)!.status).toBe("failed");
    expect(await queue.size("default")).toBe(0);
  });

  it("reports the final failure", async () => {
    const failures: unknown[] = [];
    await Flaky.performLater();

    await new Worker({
      adapter: queue,
      onFailure: (error) => void failures.push(error),
    }).drain();

    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("still broken");
  });

  it("backs off further with each attempt", () => {
    const policy = Job.retryPolicy;

    expect(policy.backoff(1)).toBeLessThan(policy.backoff(2));
    expect(policy.backoff(2)).toBeLessThan(policy.backoff(3));
  });
});

describe("worker", () => {
  it("drains everything ready", async () => {
    await Greet.performLater("one");
    await Greet.performLater("two");

    const results = await new Worker({ adapter: queue }).drain();

    expect(results).toHaveLength(2);
    expect(ran).toEqual(["hello one", "hello two"]);
  });

  it("leaves delayed jobs alone", async () => {
    await Greet.set({ wait: 60 }).performLater("later");

    expect(await new Worker({ adapter: queue }).drain()).toHaveLength(0);
    expect(await queue.size("default")).toBe(1);
  });

  it("works one queue at a time", async () => {
    await Greet.performLater("default queue");
    await Reports.performLater();

    await new Worker({ adapter: queue, queue: "reports" }).drain();

    expect(ran).toEqual(["report"]);
    expect(await queue.size("default")).toBe(1);
  });

  // A worker asked to stop must finish what it is holding rather than drop it.
  it("finishes the job in flight before stopping", async () => {
    let finished = false;

    class Slow extends Job<[]> {
      override async perform(): Promise<void> {
        await Bun.sleep(30);
        finished = true;
      }
    }
    Job.register(Slow as never);
    await Slow.performLater();

    const worker = new Worker({ adapter: queue, pollInterval: 1 });
    const running = worker.start();

    await Bun.sleep(10);
    await worker.stop();
    await running;

    expect(finished).toBe(true);
    expect(worker.isRunning).toBe(false);
  });
});

describe("redis queue", () => {
  function fakeRedis() {
    const lists = new Map<string, string[]>();
    const client: RedisQueueClient & { lists: Map<string, string[]> } = {
      lists,
      lpush: async (key, ...values) => {
        const list = lists.get(key) ?? [];
        list.unshift(...values);
        lists.set(key, list);
        return list.length;
      },
      rpop: async (key) => lists.get(key)?.pop() ?? null,
      llen: async (key) => lists.get(key)?.length ?? 0,
    };
    return client;
  }

  it("round-trips a payload", async () => {
    const client = fakeRedis();
    const adapter = new RedisQueue(client);
    Job.adapter = adapter;

    await Greet.performLater("Ada");
    expect(await adapter.size("default")).toBe(1);

    const payload = await adapter.dequeue("default");
    expect(payload?.arguments).toEqual(["Ada"]);
  });

  it("namespaces its lists", async () => {
    const client = fakeRedis();
    Job.adapter = new RedisQueue(client);

    await Greet.performLater("Ada");
    expect([...client.lists.keys()]).toEqual(["altair:jobs:default"]);
  });

  // Redis lists have no delay, so a job that is not ready goes back.
  it("puts a delayed job back", async () => {
    const adapter = new RedisQueue(fakeRedis());
    Job.adapter = adapter;

    await Greet.set({ wait: 60 }).performLater("Ada");

    expect(await adapter.dequeue("default")).toBeNull();
    expect(await adapter.size("default")).toBe(1);
  });

  // Something else writing to the list must not crash the worker on every poll.
  it("survives a value it did not write", async () => {
    const client = fakeRedis();
    await client.lpush("altair:jobs:default", "not json");

    expect(await new RedisQueue(client).dequeue("default")).toBeNull();
  });
});
