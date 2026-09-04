/**
 * The connection pool, ported from
 * `activerecord/test/cases/connection_pool_test.rb`.
 *
 * Built over fake connections rather than real ones: every behaviour under
 * test is the pool's own bookkeeping — the limit, the queue, the timeout, the
 * reaping — and a real socket would only make the tests slower and flakier
 * without exercising any of it.
 */

import { describe, expect, it } from "bun:test";
import {
  ConnectionPool,
  ConnectionTimeoutError,
  type PoolOptions,
} from "../src/connection-pool.js";
import type { Connection } from "../src/connection.js";

let built = 0;
let closed = 0;

function fakeConnection(): Connection {
  built += 1;

  return {
    close: async () => {
      closed += 1;
    },
  } as unknown as Connection;
}

function pool(options: PoolOptions = {}): ConnectionPool {
  built = 0;
  closed = 0;

  return new ConnectionPool(fakeConnection, options);
}

describe("checking out", () => {
  it("gives a connection", async () => {
    expect(await pool().checkout()).toBeDefined();
  });

  it("builds one per caller up to the size", async () => {
    const p = pool({ size: 3 });
    await p.checkout();
    await p.checkout();

    expect(built).toBe(2);
    expect(p.activeConnectionCount).toBe(2);
  });

  /** A connection that has run a statement already has its session set up. */
  it("prefers an idle connection to a new one", async () => {
    const p = pool({ size: 3 });
    const first = await p.checkout();
    p.checkin(first);

    const second = await p.checkout();

    expect(second).toBe(first);
    expect(built).toBe(1);
  });

  it("never exceeds its size", async () => {
    const p = pool({ size: 2, checkoutTimeout: 20 });
    await p.checkout();
    await p.checkout();

    await expect(p.checkout()).rejects.toThrow(ConnectionTimeoutError);
    expect(built).toBe(2);
  });
});

describe("waiting", () => {
  it("queues a caller when everything is busy", async () => {
    const p = pool({ size: 1, checkoutTimeout: 1000 });
    const held = await p.checkout();

    const queued = p.checkout();

    expect(p.numWaiting).toBe(1);

    p.checkin(held);

    expect(await queued).toBe(held);
  });

  /** Freed under load, a connection goes straight to whoever is queued. */
  it("hands a returned connection to the waiter rather than parking it", async () => {
    const p = pool({ size: 1, checkoutTimeout: 1000 });
    const held = await p.checkout();
    const queued = p.checkout();

    p.checkin(held);
    await queued;

    expect(p.idleCount).toBe(0);
    expect(p.activeConnectionCount).toBe(1);
  });

  it("serves waiters in the order they arrived", async () => {
    const p = pool({ size: 1, checkoutTimeout: 1000 });
    const held = await p.checkout();

    const order: number[] = [];
    const first = p.checkout().then(() => order.push(1));
    const second = p.checkout().then(() => order.push(2));

    p.checkin(held);
    await first;
    p.checkin(held);
    await second;

    expect(order).toEqual([1, 2]);
  });

  it("gives up after the timeout", async () => {
    const p = pool({ size: 1, checkoutTimeout: 20 });
    await p.checkout();

    await expect(p.checkout()).rejects.toThrow(/within 20ms/);
  });

  it("says how many there are in the message", async () => {
    const p = pool({ size: 1, checkoutTimeout: 20 });
    await p.checkout();

    await expect(p.checkout()).rejects.toThrow(/All 1 are in use/);
  });

  /**
   * A timed-out waiter must leave the queue, or a connection returned a moment
   * later is handed to a caller that has given up — and never comes back,
   * because nobody is holding it.
   */
  it("takes a timed-out waiter out of the queue", async () => {
    const p = pool({ size: 1, checkoutTimeout: 20 });
    const held = await p.checkout();

    await expect(p.checkout()).rejects.toThrow(ConnectionTimeoutError);

    expect(p.numWaiting).toBe(0);

    p.checkin(held);

    expect(p.idleCount).toBe(1);
  });
});

describe("checking in", () => {
  it("parks a connection when nobody is waiting", async () => {
    const p = pool({ size: 2 });
    const connection = await p.checkout();
    p.checkin(connection);

    expect(p.idleCount).toBe(1);
    expect(p.activeConnectionCount).toBe(0);
  });

  it("ignores one it did not hand out", async () => {
    const p = pool({ size: 2 });
    p.checkin(fakeConnection());

    expect(p.idleCount).toBe(0);
  });

  it("ignores a second check-in of the same connection", async () => {
    const p = pool({ size: 2 });
    const connection = await p.checkout();
    p.checkin(connection);
    p.checkin(connection);

    expect(p.idleCount).toBe(1);
  });
});

describe("withConnection", () => {
  it("gives the block a connection and takes it back", async () => {
    const p = pool({ size: 1 });

    await p.withConnection(() => undefined);

    expect(p.activeConnectionCount).toBe(0);
    expect(p.idleCount).toBe(1);
  });

  it("returns what the block returned", async () => {
    expect(await pool().withConnection(() => 42)).toBe(42);
  });

  /** A pool that loses one per error empties itself under exactly the conditions that cause errors. */
  it("takes it back when the block throws", async () => {
    const p = pool({ size: 1 });

    await expect(
      p.withConnection(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(p.activeConnectionCount).toBe(0);
  });

  it("stays usable after a failure", async () => {
    const p = pool({ size: 1, checkoutTimeout: 50 });

    await expect(
      p.withConnection(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    await expect(p.withConnection(() => "fine")).resolves.toBe("fine");
  });
});

describe("stat", () => {
  it("reports an empty pool", () => {
    const p = pool({ size: 5, checkoutTimeout: 1000 });

    expect(p.stat()).toEqual({
      size: 5,
      busy: 0,
      idle: 0,
      waiting: 0,
      checkoutTimeout: 1000,
    });
  });

  it("counts what is busy and idle", async () => {
    const p = pool({ size: 5 });
    const one = await p.checkout();
    await p.checkout();
    p.checkin(one);

    expect(p.stat().busy).toBe(1);
    expect(p.stat().idle).toBe(1);
  });

  /** Waiting above zero is the pool, not the database, being the bottleneck. */
  it("counts who is waiting", async () => {
    const p = pool({ size: 1, checkoutTimeout: 1000 });
    await p.checkout();
    const queued = p.checkout();

    expect(p.stat().waiting).toBe(1);

    p.checkin([...p.connections][0] as Connection);
    await queued;
  });

  it("lists every connection it holds", async () => {
    const p = pool({ size: 3 });
    const one = await p.checkout();
    await p.checkout();
    p.checkin(one);

    expect(p.connections).toHaveLength(2);
  });
});

describe("reaping", () => {
  /** An idle connection still costs the database a backend process. */
  it("drops one idle longer than the timeout", async () => {
    const p = pool({ size: 2, idleTimeout: 1000 });
    const connection = await p.checkout();
    p.checkin(connection);

    expect(await p.reap(Date.now() + 2000)).toBe(1);
    expect(p.idleCount).toBe(0);
    expect(closed).toBe(1);
  });

  it("keeps one that is still fresh", async () => {
    const p = pool({ size: 2, idleTimeout: 10_000 });
    p.checkin(await p.checkout());

    expect(await p.reap()).toBe(0);
    expect(p.idleCount).toBe(1);
  });

  it("never reaps a busy one", async () => {
    const p = pool({ size: 2, idleTimeout: 1 });
    await p.checkout();

    expect(await p.reap(Date.now() + 5000)).toBe(0);
    expect(p.activeConnectionCount).toBe(1);
  });

  it("flushes every idle one whatever its age", async () => {
    const p = pool({ size: 3, idleTimeout: 10_000 });
    const one = await p.checkout();
    const two = await p.checkout();
    p.checkin(one);
    p.checkin(two);

    expect(await p.flushIdleConnections()).toBe(2);
    expect(p.idleCount).toBe(0);
  });
});

describe("disconnect", () => {
  it("closes everything it holds", async () => {
    const p = pool({ size: 3 });
    const one = await p.checkout();
    await p.checkout();
    p.checkin(one);

    await p.disconnect();

    expect(closed).toBe(2);
    expect(p.connections).toEqual([]);
  });

  /**
   * A shutdown that resolved nothing keeps the process alive on promises that
   * can never settle — which is how a graceful stop becomes a kill -9.
   */
  it("rejects anybody still waiting", async () => {
    const p = pool({ size: 1, checkoutTimeout: 5000 });
    await p.checkout();
    const queued = p.checkout();

    await p.disconnect();

    await expect(queued).rejects.toThrow(/shut down/);
  });
});
