/**
 * The registry of pools, ported from
 * `activerecord/test/cases/connection_adapters/connection_handler_test.rb`
 * and `pool_config_test.rb`.
 *
 * One pool is `connection_pool.ts`. An application with a replica or shards
 * has several, and the operations that matter — discarding after a fork,
 * reaping, draining on shutdown — are the ones over all of them at once.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { ConnectionPool } from "../src/connection_pool.js";
import type { Connection } from "../src/connection.js";
import {
  ConnectionHandler,
  DEFAULT_ROLE,
  DEFAULT_SHARD_NAME,
  connectionHandler,
  maxThreads,
  minThreads,
  poolJitter,
  poolKey,
  reapingFrequency,
  resetConnectionHandler,
} from "../src/connection_handler.js";

afterEach(() => {
  resetConnectionHandler();
});

/** Enough of a connection to be pooled, and to say whether it was closed. */
function fakeConnection(): Connection & { closed: boolean } {
  const connection = {
    adapter: "sqlite" as const,
    closed: false,
    async close() {
      connection.closed = true;
    },
    query: async () => [],
    execute: async () => ({ rowCount: 0 }),
    quote: (name: string) => `"${name}"`,
    placeholder: () => "?",
  };

  return connection as unknown as Connection & { closed: boolean };
}

function config(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    role: DEFAULT_ROLE,
    shard: DEFAULT_SHARD_NAME,
    build: fakeConnection,
    ...overrides,
  };
}

describe("pool keys", () => {
  it("fills in the role and shard", () => {
    expect(poolKey("primary")).toEqual({
      name: "primary",
      role: "writing",
      shard: "default",
    });
  });

  it("takes what it is given", () => {
    expect(poolKey("primary", "reading", "eu")).toEqual({
      name: "primary",
      role: "reading",
      shard: "eu",
    });
  });

  /** The same database in two roles is two pools, not one. */
  it("tells two roles apart", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary", { role: "writing" }));
    handler.registerPool(config("primary", { role: "reading" }));

    expect(handler.connectionPoolList()).toHaveLength(2);
  });

  it("tells two shards apart", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary", { shard: "eu" }));
    handler.registerPool(config("primary", { shard: "us" }));

    expect(handler.connectionPoolList()).toHaveLength(2);
  });
});

describe("pool configuration", () => {
  it("has a size", () => {
    expect(maxThreads(config("primary"))).toBe(5);
    expect(maxThreads(config("primary", { maxThreads: 20 }))).toBe(20);
  });

  it("keeps nothing idle by default", () => {
    expect(minThreads(config("primary"))).toBe(0);
  });

  /** A minimum above the maximum would ask the pool for connections it cannot hold. */
  it("never keeps more than it allows", () => {
    expect(minThreads(config("primary", { minThreads: 50, maxThreads: 5 }))).toBe(5);
  });

  it("reaps on a schedule", () => {
    expect(reapingFrequency(config("primary"))).toBe(60_000);
    expect(reapingFrequency(config("primary", { reapingFrequency: 1000 }))).toBe(1000);
  });

  /**
   * Without jitter every pool in every process wakes on the same tick, and a
   * fleet that started together sends a synchronised burst of disconnects at
   * the database — a load spike with a period.
   */
  it("jitters within the interval", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const jitter = poolJitter(1000);

      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1000);
    }
  });

  it("gives different values across calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => poolJitter(10_000)));

    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("registering", () => {
  it("records a config without building anything", () => {
    const handler = new ConnectionHandler();
    handler.setPoolConfig(config("primary"));

    expect(handler.getPoolConfig(poolKey("primary"))?.name).toBe("primary");
    expect(handler.connectionPoolList()).toHaveLength(0);
  });

  it("lists the configs", () => {
    const handler = new ConnectionHandler();
    handler.setPoolConfig(config("primary"));
    handler.setPoolConfig(config("analytics"));

    expect(handler.poolConfigs().map((each) => each.name)).toEqual(["primary", "analytics"]);
    expect(Array.from(handler.eachPoolConfig())).toHaveLength(2);
  });

  it("removes one", () => {
    const handler = new ConnectionHandler();
    handler.setPoolConfig(config("primary"));

    expect(handler.removePoolConfig(poolKey("primary"))).toBe(true);
    expect(handler.getPoolConfig(poolKey("primary"))).toBeUndefined();
  });

  it("says when there was nothing to remove", () => {
    expect(new ConnectionHandler().removePoolConfig(poolKey("nowhere"))).toBe(false);
  });

  /**
   * Built here rather than on first use, so a misconfigured database fails at
   * boot rather than on whichever request first touched that model.
   */
  it("builds the pool when the config is registered", () => {
    const handler = new ConnectionHandler();

    expect(handler.registerPool(config("primary"))).toBeInstanceOf(ConnectionPool);
    expect(handler.connectionPoolList()).toHaveLength(1);
  });

  it("gives the pool the configured size", () => {
    const handler = new ConnectionHandler();

    expect(handler.registerPool(config("primary", { maxThreads: 12 })).size).toBe(12);
  });

  it("passes the checkout timeout through", () => {
    const handler = new ConnectionHandler();

    expect(handler.registerPool(config("primary", { checkoutTimeout: 99 })).checkoutTimeout).toBe(
      99,
    );
  });

  it("records the config as well as building the pool", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary"));

    expect(handler.getPoolConfig(poolKey("primary"))).toBeDefined();
  });

  it("takes a pool that was built elsewhere", () => {
    const handler = new ConnectionHandler();
    const pool = new ConnectionPool(fakeConnection);
    handler.setPool(poolKey("primary"), pool);

    expect(handler.connectionPool(poolKey("primary"))).toBe(pool);
  });
});

describe("looking one up", () => {
  /**
   * A key with no pool is almost always a typo in a role or shard name, and
   * building one on demand would give that typo its own database connection
   * rather than an error.
   */
  it("gives nothing for a key nobody registered", () => {
    expect(new ConnectionHandler().retrieveConnectionPool(poolKey("nowhere"))).toBeUndefined();
  });

  it("throws when insisting on one that is not there", () => {
    expect(() => new ConnectionHandler().connectionPool(poolKey("nowhere"))).toThrow(
      "No connection pool for nowhere",
    );
  });

  it("says what it does know", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary"));

    expect(() => handler.connectionPool(poolKey("nowhere"))).toThrow("primary/writing/default");
  });

  it("says none when it knows none", () => {
    expect(() => new ConnectionHandler().connectionPool(poolKey("x"))).toThrow("none");
  });

  it("names every pool it holds", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary"));
    handler.registerPool(config("primary", { role: "reading" }));

    expect(handler.connectionPoolNames()).toEqual([
      "primary/writing/default",
      "primary/reading/default",
    ]);
  });

  it("walks them", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary"));
    handler.registerPool(config("analytics"));

    expect(Array.from(handler.eachConnectionPool())).toHaveLength(2);
  });
});

describe("removing and discarding", () => {
  it("closes a pool's connections when removing it", async () => {
    const handler = new ConnectionHandler();
    const built: (Connection & { closed: boolean })[] = [];
    handler.registerPool(
      config("primary", {
        build: () => {
          const connection = fakeConnection();
          built.push(connection);

          return connection;
        },
      }),
    );

    await handler.checkoutAndVerify(poolKey("primary"), async () => undefined);
    await handler.removeConnectionPool(poolKey("primary"));

    expect(built[0]?.closed).toBe(true);
    expect(handler.connectionPoolList()).toHaveLength(0);
  });

  it("says when there was nothing to remove", async () => {
    expect(await new ConnectionHandler().removeConnectionPool(poolKey("nowhere"))).toBe(false);
  });

  /**
   * The difference from disconnecting is the whole point: after a fork the
   * child holds the parent's sockets, and closing them closes the parent's
   * too — so the parent's next query fails.
   */
  it("discards a pool without closing its connections", async () => {
    const handler = new ConnectionHandler();
    const built: (Connection & { closed: boolean })[] = [];
    handler.registerPool(
      config("primary", {
        build: () => {
          const connection = fakeConnection();
          built.push(connection);

          return connection;
        },
      }),
    );

    await handler.checkoutAndVerify(poolKey("primary"), async () => undefined);
    handler.discardPool(poolKey("primary"));

    expect(built[0]?.closed).toBe(false);
    expect(handler.retrieveConnectionPool(poolKey("primary"))).toBeUndefined();
  });

  it("says when there was nothing to discard", () => {
    expect(new ConnectionHandler().discardPool(poolKey("nowhere"))).toBe(false);
  });

  /** What a forked child does first. */
  it("discards every pool at once", () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary"));
    handler.registerPool(config("analytics"));

    expect(handler.discardPools()).toBe(2);
    expect(handler.connectionPoolList()).toHaveLength(0);
  });

  it("closes every pool on shutdown", async () => {
    const handler = new ConnectionHandler();
    const built: (Connection & { closed: boolean })[] = [];
    const build = () => {
      const connection = fakeConnection();
      built.push(connection);

      return connection;
    };

    handler.registerPool(config("primary", { build }));
    handler.registerPool(config("analytics", { build }));

    await handler.checkoutAndVerify(poolKey("primary"), async () => undefined);
    await handler.checkoutAndVerify(poolKey("analytics"), async () => undefined);
    await handler.disconnectAll();

    expect(built.every((each) => each.closed)).toBe(true);
    expect(handler.connectionPoolList()).toHaveLength(0);
  });
});

describe("reaping", () => {
  /** The limit being protected is the server's, and it counts every pool the same. */
  it("drops idle connections across every pool", async () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary", { idleTimeout: 0 }));
    handler.registerPool(config("analytics", { idleTimeout: 0 }));

    await handler.checkoutAndVerify(poolKey("primary"), async () => undefined);
    await handler.checkoutAndVerify(poolKey("analytics"), async () => undefined);

    expect(await handler.reapAll(Date.now() + 1000)).toBe(2);
  });

  it("reaps nothing when nothing is idle long enough", async () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary", { idleTimeout: 60_000 }));

    await handler.checkoutAndVerify(poolKey("primary"), async () => undefined);

    expect(await handler.reapAll()).toBe(0);
  });
});

describe("checkoutAndVerify", () => {
  it("hands a connection to the body", async () => {
    const handler = new ConnectionHandler();
    handler.registerPool(config("primary"));

    const adapter = await handler.checkoutAndVerify(
      poolKey("primary"),
      async (connection) => connection.adapter,
    );

    expect(adapter).toBe("sqlite");
  });

  /**
   * A pool that leaks one connection per failed request runs out during the
   * incident causing the failures — turning a handled error into an outage.
   */
  it("gives the connection back even when the body throws", async () => {
    const handler = new ConnectionHandler();
    const pool = handler.registerPool(config("primary"));

    await expect(
      handler.checkoutAndVerify(poolKey("primary"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(pool.activeConnectionCount).toBe(0);
  });

  it("throws when the pool is not there", async () => {
    await expect(
      new ConnectionHandler().checkoutAndVerify(poolKey("nowhere"), async () => undefined),
    ).rejects.toThrow("No connection pool");
  });
});

describe("temporary pools", () => {
  it("puts one in place for the body", async () => {
    const handler = new ConnectionHandler();

    const seen = await handler.withTemporaryPool(
      config("migration"),
      async () => handler.retrieveConnectionPool(poolKey("migration")) !== undefined,
    );

    expect(seen).toBe(true);
  });

  it("takes it away afterwards", async () => {
    const handler = new ConnectionHandler();

    await handler.withTemporaryPool(config("migration"), async () => undefined);

    expect(handler.retrieveConnectionPool(poolKey("migration"))).toBeUndefined();
  });

  /** Or a failing migration leaves the process pointing at the wrong database. */
  it("takes it away even when the body throws", async () => {
    const handler = new ConnectionHandler();

    await expect(
      handler.withTemporaryPool(config("migration"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(handler.retrieveConnectionPool(poolKey("migration"))).toBeUndefined();
  });

  it("puts back a pool it replaced", async () => {
    const handler = new ConnectionHandler();
    const original = handler.registerPool(config("primary"));

    await handler.withTemporaryPool(config("primary"), async () => undefined);

    expect(handler.retrieveConnectionPool(poolKey("primary"))).toBe(original);
  });

  it("runs one per config", async () => {
    const handler = new ConnectionHandler();

    const names = await handler.withTemporaryPoolForEach(
      [config("a"), config("b")],
      async (_pool, each) => each.name,
    );

    expect(names).toEqual(["a", "b"]);
    expect(handler.connectionPoolList()).toHaveLength(0);
  });
});

describe("the process-wide handler", () => {
  it("is there", () => {
    expect(connectionHandler()).toBeInstanceOf(ConnectionHandler);
  });

  it("keeps what is registered on it", () => {
    connectionHandler().registerPool(config("primary"));

    expect(connectionHandler().retrieveConnectionPool(poolKey("primary"))).toBeDefined();
  });

  it("is replaced on reset", () => {
    connectionHandler().registerPool(config("primary"));
    resetConnectionHandler();

    expect(connectionHandler().retrieveConnectionPool(poolKey("primary"))).toBeUndefined();
  });
});
