/**
 * Cache suite.
 *
 * Mirrors activesupport/test/cache/. The behavioural contract Rails' stores
 * share is what is tested here, so a new store can be checked against the same
 * cases.
 */

import { describe, expect, it } from "bun:test";
import { Cache, MemoryStore, RedisStore, expandKey, type RedisLike } from "../src/cache.js";

describe("key expansion", () => {
  it("passes a string through", () => {
    expect(expandKey("posts/recent")).toBe("posts/recent");
  });

  it("joins an array into a path", () => {
    expect(expandKey(["posts", 1, "comments"])).toBe("posts/1/comments");
  });

  // A record's key includes its timestamp, so writing the record invalidates
  // the cache without anyone remembering to delete a key.
  it("builds a record key from id and updated_at", () => {
    expect(expandKey({ id: 7, updated_at: "2026-01-01" })).toBe("7-2026-01-01");
    expect(expandKey({ id: 7 })).toBe("7");
  });

  it("lets an object name itself", () => {
    expect(expandKey({ cacheKey: () => "posts/7-custom" })).toBe("posts/7-custom");
  });

  it("nests records inside arrays", () => {
    expect(expandKey(["posts", { id: 7, updated_at: "x" }])).toBe("posts/7-x");
  });
});

describe("memory store", () => {
  it("reads back what it writes", async () => {
    const store = new MemoryStore();
    await store.write("a", { value: 1 });

    expect(await store.read<{ value: number }>("a")).toEqual({ value: 1 });
  });

  it("misses an unknown key", async () => {
    expect(await new MemoryStore().read("nope")).toBeNull();
  });

  it("expires an entry", async () => {
    const store = new MemoryStore();
    await store.write("a", 1, { expiresIn: 0.01 });

    expect(await store.read<number>("a")).toBe(1);
    await Bun.sleep(20);
    expect(await store.read("a")).toBeNull();
  });

  it("keeps an entry with no expiry", async () => {
    const store = new MemoryStore();
    await store.write("a", 1);

    await Bun.sleep(5);
    expect(await store.read<number>("a")).toBe(1);
  });

  it("deletes and reports whether it did", async () => {
    const store = new MemoryStore();
    await store.write("a", 1);

    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(await store.read("a")).toBeNull();
  });

  it("reports existence, respecting expiry", async () => {
    const store = new MemoryStore();
    await store.write("a", 1, { expiresIn: 0.01 });

    expect(await store.exists("a")).toBe(true);
    await Bun.sleep(20);
    expect(await store.exists("a")).toBe(false);
  });

  it("clears", async () => {
    const store = new MemoryStore();
    await store.write("a", 1);
    await store.clear();

    expect(await store.read("a")).toBeNull();
  });

  it("increments and decrements", async () => {
    const store = new MemoryStore();

    expect(await store.increment("hits")).toBe(1);
    expect(await store.increment("hits", 5)).toBe(6);
    expect(await store.decrement("hits", 2)).toBe(4);
  });

  it("evicts when full", async () => {
    const store = new MemoryStore(2);
    await store.write("a", 1);
    await store.write("b", 2);
    await store.write("c", 3);

    expect(store.size).toBe(2);
    expect(await store.read("a")).toBeNull();
    expect(await store.read<number>("c")).toBe(3);
  });
});

describe("fetch", () => {
  it("computes on a miss and caches the result", async () => {
    const cache = new Cache();
    let calls = 0;

    const compute = () => {
      calls += 1;
      return "value";
    };

    expect(await cache.fetch("k", compute)).toBe("value");
    expect(await cache.fetch("k", compute)).toBe("value");
    expect(calls).toBe(1);
  });

  it("awaits an async block", async () => {
    const cache = new Cache();
    expect(await cache.fetch("k", async () => 42)).toBe(42);
  });

  // Without boxing, "this query returns nothing" is the one answer a cache can
  // never remember, and the expensive query runs on every request.
  it("treats a cached null as a hit", async () => {
    const cache = new Cache();
    let calls = 0;

    const compute = () => {
      calls += 1;
      return null;
    };

    expect(await cache.fetch("k", compute)).toBeNull();
    expect(await cache.fetch("k", compute)).toBeNull();
    expect(calls).toBe(1);
  });

  it("recomputes after expiry", async () => {
    const cache = new Cache();
    let calls = 0;

    const compute = () => {
      calls += 1;
      return calls;
    };

    expect(await cache.fetch("k", { expiresIn: 0.01 }, compute)).toBe(1);
    await Bun.sleep(20);
    expect(await cache.fetch("k", { expiresIn: 0.01 }, compute)).toBe(2);
  });

  it("recomputes when forced", async () => {
    const cache = new Cache();
    let calls = 0;

    const compute = () => {
      calls += 1;
      return calls;
    };

    await cache.fetch("k", compute);
    expect(await cache.fetch("k", { force: true }, compute)).toBe(2);
  });

  it("expands a record key", async () => {
    const cache = new Cache();
    const record = { id: 1, updated_at: "a" };

    await cache.fetch(["posts", record], () => "first");

    // The same record with a new timestamp is a different key, so writing the
    // record invalidates its cache entry.
    expect(await cache.fetch(["posts", { id: 1, updated_at: "b" }], () => "second")).toBe("second");
  });
});

describe("cache facade", () => {
  it("reads, writes, deletes and counts through the store", async () => {
    const cache = new Cache();

    await cache.write(["posts", 1], "value");
    expect(await cache.read<string>(["posts", 1])).toBe("value");
    expect(await cache.exists(["posts", 1])).toBe(true);

    expect(await cache.delete(["posts", 1])).toBe(true);
    expect(await cache.read(["posts", 1])).toBeNull();
  });

  it("reads and writes several keys", async () => {
    const cache = new Cache();
    await cache.writeMulti({ a: 1, b: 2 });

    expect(await cache.readMulti("a", "b", "c")).toEqual({ a: 1, b: 2, c: null });
  });

  it("increments through the store", async () => {
    const cache = new Cache();
    expect(await cache.increment("hits", 3)).toBe(3);
    expect(await cache.decrement("hits")).toBe(2);
  });
});

describe("redis store", () => {
  /** A stand-in for Bun.RedisClient, so the suite needs no Redis. */
  function fakeRedis() {
    const data = new Map<string, string>();
    const expiries: Record<string, number> = {};

    const client: RedisLike & { data: Map<string, string>; expiries: Record<string, number> } = {
      data,
      expiries,
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => void data.set(key, value),
      del: async (key) => (data.delete(key) ? 1 : 0),
      exists: async (key) => data.has(key),
      expire: async (key, seconds) => void (expiries[key] = seconds),
      incrby: async (key, amount) => {
        const next = Number(data.get(key) ?? 0) + amount;
        data.set(key, String(next));
        return next;
      },
    };
    return client;
  }

  it("namespaces its keys", async () => {
    const client = fakeRedis();
    await new RedisStore(client).write("a", 1);

    expect([...client.data.keys()]).toEqual(["altair:a"]);
  });

  it("round-trips a value as JSON", async () => {
    const store = new RedisStore(fakeRedis());
    await store.write("a", { nested: true });

    expect(await store.read<{ nested: boolean }>("a")).toEqual({ nested: true });
  });

  // Expiry is Redis' own, so an expired key costs nothing to read.
  it("sets expiry on the server", async () => {
    const client = fakeRedis();
    await new RedisStore(client).write("a", 1, { expiresIn: 60 });

    expect(client.expiries["altair:a"]).toBe(60);
  });

  it("deletes and reports whether it did", async () => {
    const store = new RedisStore(fakeRedis());
    await store.write("a", 1);

    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
  });

  it("increments with the server's own command", async () => {
    const store = new RedisStore(fakeRedis());

    expect(await store.increment("hits", 2)).toBe(2);
    expect(await store.increment("hits")).toBe(3);
  });

  it("returns null for a value it did not write", async () => {
    const client = fakeRedis();
    client.data.set("altair:a", "not json");

    expect(await new RedisStore(client).read("a")).toBeNull();
  });

  // Flushing a shared Redis would drop keys this application does not own.
  it("refuses to clear", async () => {
    await expect(new RedisStore(fakeRedis()).clear()).rejects.toThrow("not implemented");
  });
});

// Everything built on increment — rate limits, and the lock that keeps a
// schedule from running on every server at once — is counting on it being
// atomic and on it leaving the expiry alone.
describe("counters", () => {
  it("count each caller once when they arrive together", async () => {
    const store = new MemoryStore();

    const results = await Promise.all(Array.from({ length: 50 }, () => store.increment("hits")));

    expect(new Set(results).size).toBe(50);
    expect(await store.read<number>("hits")).toBe(50);
  });

  // A counter whose window is reset on every increment is a rate limit that
  // never lifts.
  it("keep the expiry the first write set", async () => {
    const store = new MemoryStore();

    await store.write("window", 1, { expiresIn: 0.05 });
    await store.increment("window");
    await store.increment("window");

    expect(await store.read<number>("window")).toBe(3);

    await Bun.sleep(70);
    expect(await store.read("window")).toBeNull();
  });

  it("start from nothing when the key has expired", async () => {
    const store = new MemoryStore();

    await store.write("window", 9, { expiresIn: 0.02 });
    await Bun.sleep(40);

    expect(await store.increment("window")).toBe(1);
  });
});
