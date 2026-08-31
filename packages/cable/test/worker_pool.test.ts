/**
 * Running channel work off the socket loop, ported from
 * `actioncable/test/worker_test.rb`,
 * `actioncable/test/connection/multiple_identifiers_test.rb` and
 * `actioncable/test/server/broadcasting_test.rb`.
 *
 * Ordering is the property worth most of these tests: two messages from one
 * client have an order the client meant, and a pool that ran them concurrently
 * would still pass every test that only checks both ran.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  RemoteConnections,
  UnknownPubSubAdapter,
  WorkerPool,
  WorkerPoolFull,
  addTags,
  afterWork,
  aroundWork,
  beforeWork,
  broadcasterFor,
  clearWorkHooks,
  currentWork,
  newTaggedLogger,
  performWork,
  pubsub,
  pubsubAdapter,
  pubsubAdapterNames,
  registerPubSubAdapter,
  remoteConnections,
  sendAsync,
  setWorkerPool,
  usePubSub,
  withDatabaseConnections,
  workerPool,
} from "../src/worker_pool.js";

const context = (connectionId = "c1", tags: string[] = []) => ({ connectionId, tags });

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

afterEach(() => {
  clearWorkHooks();
  setWorkerPool(undefined);
  usePubSub(undefined);
});

describe("tagged logging", () => {
  /**
   * A cable server multiplexes every client onto one log, so a line saying
   * "rejected subscription" with nothing else in it cannot be traced to a user.
   */
  it("stamps the tags on every line", () => {
    const lines: string[] = [];
    newTaggedLogger((line) => lines.push(line), ["ActionCable"]).info("hello");

    expect(lines).toEqual(["[ActionCable] hello"]);
  });

  it("marks an error line", () => {
    const lines: string[] = [];
    newTaggedLogger((line) => lines.push(line)).error("boom");

    expect(lines[0]).toContain("[ERROR]");
  });

  it("adds a tag", () => {
    expect(
      addTags(
        newTaggedLogger(() => undefined, ["a"]),
        "b",
      ).tags,
    ).toEqual(["a", "b"]);
  });

  it("picks up the running connection's tags", async () => {
    const lines: string[] = [];
    const logger = newTaggedLogger((line) => lines.push(line), ["ActionCable"]);

    await performWork(context("c1", ["User/7"]), async () => {
      logger.info("subscribed");
    });

    expect(lines).toEqual(["[ActionCable] [User/7] subscribed"]);
  });

  it("has none outside a unit of work", () => {
    expect(currentWork()).toBeUndefined();
  });
});

describe("hooks around one unit of work", () => {
  it("runs them in order", async () => {
    const seen: string[] = [];
    beforeWork(() => {
      seen.push("before");
    });
    afterWork(() => {
      seen.push("after");
    });

    await performWork(context(), async () => {
      seen.push("body");
    });

    expect(seen).toEqual(["before", "body", "after"]);
  });

  it("wraps the body in an around hook", async () => {
    const seen: string[] = [];
    aroundWork(async (_ctx, proceed) => {
      seen.push("in");
      await proceed();
      seen.push("out");
    });

    await performWork(context(), async () => {
      seen.push("body");
    });

    expect(seen).toEqual(["in", "body", "out"]);
  });

  /** So a connection-management hook wraps everything a later hook does. */
  it("puts the first around hook outermost", async () => {
    const seen: string[] = [];
    aroundWork(async (_ctx, proceed) => {
      seen.push("outer in");
      await proceed();
      seen.push("outer out");
    });
    aroundWork(async (_ctx, proceed) => {
      seen.push("inner in");
      await proceed();
      seen.push("inner out");
    });

    await performWork(context(), async () => undefined);

    expect(seen).toEqual(["outer in", "inner in", "inner out", "outer out"]);
  });

  /**
   * `after` runs in a `finally`. It is where a connection is returned, and
   * skipping it on the failure path leaks the resource the failing action used.
   */
  it("still runs the after hooks when the body throws", async () => {
    const seen: string[] = [];
    afterWork(() => {
      seen.push("after");
    });

    await expect(
      performWork(context(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen).toEqual(["after"]);
  });

  it("clears the running context afterwards", async () => {
    await performWork(context(), async () => undefined);

    expect(currentWork()).toBeUndefined();
  });

  it("clears it even when the body throws", async () => {
    await expect(
      performWork(context(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    expect(currentWork()).toBeUndefined();
  });

  it("names the connection while it runs", async () => {
    let seen: string | undefined;

    await performWork(context("c9"), async () => {
      seen = currentWork()?.connectionId;
    });

    expect(seen).toBe("c9");
  });
});

describe("database connections", () => {
  /**
   * A cable server holds connections for as long as a client is connected, so
   * one leaked per failed action exhausts the pool in an afternoon.
   */
  it("returns the connection when the body throws", async () => {
    const events: string[] = [];
    withDatabaseConnections(
      async () => {
        events.push("out");

        return "conn";
      },
      async () => {
        events.push("in");
      },
    );

    await expect(
      performWork(context(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    expect(events).toEqual(["out", "in"]);
  });

  it("returns it on the happy path too", async () => {
    const events: string[] = [];
    withDatabaseConnections(
      async () => "conn",
      async () => {
        events.push("in");
      },
    );

    await performWork(context(), async () => undefined);

    expect(events).toEqual(["in"]);
  });
});

describe("the pool", () => {
  /**
   * The property a concurrent pool would break while still passing any test
   * that only checks both ran: a subscribe landing after the message it was
   * meant to receive looks like a dropped message.
   */
  it("keeps one connection's work in order", async () => {
    const pool = new WorkerPool();
    const seen: string[] = [];

    pool.asyncInvoke("c1", async () => {
      await tick();
      seen.push("first");
    });
    pool.asyncInvoke("c1", async () => {
      seen.push("second");
    });

    await pool.drained();

    expect(seen).toEqual(["first", "second"]);
  });

  it("runs different connections independently", async () => {
    const pool = new WorkerPool();
    const seen: string[] = [];

    pool.asyncInvoke("slow", async () => {
      await tick();
      await tick();
      seen.push("slow");
    });
    pool.asyncInvoke("fast", async () => {
      seen.push("fast");
    });

    await pool.drained();

    expect(seen).toEqual(["fast", "slow"]);
  });

  /**
   * An unbounded queue does not remove the limit, it moves it to memory — and
   * by then the socket has been unresponsive for a while.
   */
  it("refuses work once the queue is full", async () => {
    const pool = new WorkerPool(5, 2);
    pool.asyncInvoke("c1", async () => {
      await tick();
    });
    pool.asyncInvoke("c1", async () => {
      await tick();
    });

    expect(() =>
      pool.asyncInvoke("c1", async () => {
        await tick();
      }),
    ).toThrow(WorkerPoolFull);

    await pool.drained();
  });

  /**
   * The limit counts what is running, not only what is waiting: a pool whose
   * every connection is busy would otherwise report an empty queue and accept
   * unlimited more.
   */
  it("counts running work against the limit", async () => {
    const pool = new WorkerPool(5, 1);
    pool.asyncInvoke("c1", async () => {
      await tick();
    });

    expect(pool.queued).toBe(0);
    expect(() => pool.asyncInvoke("c2", async () => undefined)).toThrow(WorkerPoolFull);

    await pool.drained();
  });

  it("says why it refused", async () => {
    const pool = new WorkerPool(5, 1);
    pool.asyncInvoke("c1", async () => {
      await tick();
    });

    expect(() => pool.asyncInvoke("c1", async () => undefined)).toThrow("moves it to memory");

    await pool.drained();
  });

  /** A failing action must not stop the pool draining or reach the socket loop. */
  it("keeps going after one item throws", async () => {
    const pool = new WorkerPool();
    const seen: string[] = [];
    pool.onError((error) => seen.push(`error:${(error as Error).message}`));

    pool.asyncInvoke("c1", async () => {
      throw new Error("boom");
    });
    pool.asyncInvoke("c1", async () => {
      seen.push("after");
    });

    await pool.drained();

    expect(seen).toEqual(["error:boom", "after"]);
  });

  it("reports which connection failed", async () => {
    const pool = new WorkerPool();
    let seen: string | undefined;
    pool.onError((_error, ctx) => {
      seen = ctx.connectionId;
    });

    pool.asyncInvoke("c7", async () => {
      throw new Error("boom");
    });
    await pool.drained();

    expect(seen).toBe("c7");
  });

  /**
   * Discarded, not drained: a server shutting down has clients going away with
   * it, and finishing their work delays the shutdown to deliver messages
   * nobody will receive.
   */
  it("discards queued work when halted", async () => {
    const pool = new WorkerPool();
    const seen: string[] = [];
    pool.asyncInvoke("c1", async () => {
      await tick();
      seen.push("running");
    });
    pool.asyncInvoke("c1", async () => {
      seen.push("queued");
    });

    pool.halt();
    await pool.drained();

    expect(seen).toEqual(["running"]);
    expect(pool.stopping).toBe(true);
  });

  it("takes no new work once halted", async () => {
    const pool = new WorkerPool();
    pool.halt();
    const seen: string[] = [];

    pool.asyncInvoke("c1", async () => {
      seen.push("ran");
    });
    await pool.drained();

    expect(seen).toEqual([]);
  });

  it("counts what is waiting", async () => {
    const pool = new WorkerPool();
    pool.asyncInvoke("c1", async () => {
      await tick();
    });
    pool.asyncInvoke("c1", async () => {
      await tick();
    });

    expect(pool.queued).toBe(1);
    expect(pool.active).toBe(1);
    expect(pool.outstanding).toBe(2);

    // Drained here, or this pool is still running work when the next test
    // registers a global hook, and that hook fires for work it never posted.
    await pool.drained();
  });

  it("runs the hooks for pooled work too", async () => {
    const pool = new WorkerPool();
    const seen: string[] = [];
    beforeWork(() => {
      seen.push("before");
    });

    pool.asyncInvoke("c1", async () => {
      seen.push("body");
    });
    await pool.drained();

    expect(seen).toEqual(["before", "body"]);
  });

  it("has one pool by default", () => {
    expect(workerPool()).toBe(workerPool());
  });

  it("posts to it", async () => {
    const seen: string[] = [];

    sendAsync("c1", async () => {
      seen.push("ran");
    });
    await workerPool().drained();

    expect(seen).toEqual(["ran"]);
  });

  it("runs a bound body", async () => {
    const pool = new WorkerPool();
    const seen: string[] = [];

    pool.asyncExec("c1", async () => {
      seen.push("ran");
    });
    await pool.drained();

    expect(seen).toEqual(["ran"]);
  });
});

describe("pub/sub adapters", () => {
  /**
   * The fallback would be the in-process adapter, which works perfectly on one
   * server and delivers nothing to the other three.
   */
  it("refuses one nobody registered", () => {
    expect(() => pubsubAdapter("redsi")).toThrow(UnknownPubSubAdapter);
  });

  it("says why", () => {
    expect(() => pubsubAdapter("redsi")).toThrow("other three");
  });

  it("builds one that was registered", () => {
    const adapter = {
      broadcast: () => undefined,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    };
    registerPubSubAdapter("test", () => adapter);

    expect(pubsubAdapter("test")).toBe(adapter);
    expect(pubsubAdapterNames()).toContain("test");
  });

  it("has none in use to start with", () => {
    expect(pubsub()).toBeUndefined();
  });

  it("broadcasts through the one in use", async () => {
    const sent: string[] = [];
    usePubSub({
      broadcast: (stream, message) => {
        sent.push(`${stream}:${message}`);
      },
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    });

    await broadcasterFor("room:1").broadcast("hello");

    expect(sent).toEqual(["room:1:hello"]);
  });

  /** Broadcasting with nothing configured is a no-op, not a crash. */
  it("does nothing with no adapter", async () => {
    await expect(broadcasterFor("room:1").broadcast("hello")).resolves.toBeUndefined();
  });
});

describe("connections in another process", () => {
  it("disconnects everything under an identifier", async () => {
    const connections = new RemoteConnections();
    const seen: boolean[] = [];
    connections.addSubscriber("User/7", async (reconnect) => {
      seen.push(reconnect);
    });

    expect(await connections.disconnect("User/7", false)).toBe(1);
    expect(seen).toEqual([false]);
  });

  /**
   * Every socket, not just the first. A user signed out on one tab has to lose
   * the others too, and a count alone cannot tell the two apart.
   */
  it("reaches every socket a user has", async () => {
    const connections = new RemoteConnections();
    const reached: string[] = [];
    connections.addSubscriber("User/7", async () => {
      reached.push("one");
    });
    connections.addSubscriber("User/7", async () => {
      reached.push("two");
    });

    expect(await connections.disconnect("User/7")).toBe(2);
    expect(reached.sort()).toEqual(["one", "two"]);
  });

  it("leaves other identifiers alone", async () => {
    const connections = new RemoteConnections();
    connections.addSubscriber("User/7", async () => undefined);

    expect(await connections.disconnect("User/8")).toBe(0);
  });

  it("removes one", () => {
    const connections = new RemoteConnections();
    const disconnect = async () => undefined;
    connections.addSubscriber("User/7", disconnect);

    connections.removeSubscriber("User/7", disconnect);

    expect(connections.subscriberCount("User/7")).toBe(0);
  });

  /**
   * A process that has served a million users would otherwise hold a million
   * empty sets for the rest of its life.
   */
  it("drops the identifier when the last one goes", () => {
    const connections = new RemoteConnections();
    const disconnect = async () => undefined;
    connections.addSubscriber("User/7", disconnect);

    expect(connections.identifiers()).toEqual(["User/7"]);

    connections.removeSubscriber("User/7", disconnect);

    // The count is zero either way; only the key list shows the empty set is
    // really gone rather than merely empty.
    expect(connections.identifiers()).toEqual([]);
  });

  it("has a shared registry", () => {
    expect(remoteConnections()).toBe(remoteConnections());
  });
});
