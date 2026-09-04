/**
 * Choosing a cache store and deciding what to compress, ported from
 * `activesupport/test/cache/cache_store_fetch_test.rb`,
 * `cache_store_setting_test.rb` and the compression cases in
 * `activesupport/test/cache/behaviors/`.
 *
 * The stampede is the case worth having. When a popular entry expires, every
 * request that wanted it misses at the same moment and every one recomputes —
 * so the expensive query the cache existed to avoid runs a hundred times at
 * once, against a database that is already the reason for the cache.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { MemoryStore } from "../src/cache.js";
import {
  COMPRESS_THRESHOLD,
  UnknownStore,
  buildMemCache,
  cacheFor,
  clearRecomputing,
  currentLocalCache,
  defineCachedMethod,
  dumpCompressed,
  fetchEntry,
  isRecomputing,
  lookupStore,
  newLocalCache,
  registerStore,
  resetStores,
  setCacheFor,
  storeIfAbsent,
  storeNames,
  supportsCacheVersioning,
  tryCompress,
  unsetLocalCache,
} from "../src/cache-lookup.js";

afterEach(() => {
  resetStores();
  clearRecomputing();
  unsetLocalCache();
});

describe("choosing a store", () => {
  it("builds one that was registered", () => {
    registerStore("memory", () => new MemoryStore());

    expect(lookupStore("memory")).toBeInstanceOf(MemoryStore);
  });

  it("ignores case", () => {
    registerStore("memory", () => new MemoryStore());

    expect(lookupStore("MEMORY")).toBeInstanceOf(MemoryStore);
  });

  it("passes the options through", () => {
    let seen: Record<string, unknown> = {};
    registerStore("memory", (options) => {
      seen = options;

      return new MemoryStore();
    });

    lookupStore("memory", { size: 100 });

    expect(seen).toEqual({ size: 100 });
  });

  /**
   * A cache that silently discards everything looks exactly like one with a
   * very low hit rate, which nobody traces back to a typo in a config file.
   */
  it("refuses a name nobody registered", () => {
    expect(() => lookupStore("memroy")).toThrow(UnknownStore);
  });

  it("says what there is instead", () => {
    registerStore("memory", () => new MemoryStore());

    expect(() => lookupStore("memroy")).toThrow("memory");
  });

  it("says why the failure matters", () => {
    expect(() => lookupStore("nope")).toThrow("discards everything");
  });

  it("lists what is registered", () => {
    registerStore("redis", () => new MemoryStore());
    registerStore("memory", () => new MemoryStore());

    expect(storeNames()).toEqual(["memory", "redis"]);
  });

  it("builds one directly", () => {
    expect(buildMemCache(() => new MemoryStore())).toBeInstanceOf(MemoryStore);
  });
});

describe("compressing", () => {
  const long = "a".repeat(COMPRESS_THRESHOLD * 2);

  it("compresses something long and repetitive", () => {
    const result = tryCompress(long);

    expect(result.compressed).toBe(true);
    expect((result.value as Uint8Array).length).toBeLessThan(long.length);
  });

  /** Deflate on a short string is a round of work for nothing. */
  it("leaves something short alone", () => {
    expect(tryCompress("short").compressed).toBe(false);
  });

  /**
   * The case that shows the threshold is doing something. This *would*
   * compress well — 200 identical bytes deflate to a handful — so without the
   * size check it would be compressed, and the check is what stops the work
   * happening at all.
   */
  it("leaves something short alone even when it would compress well", () => {
    expect(tryCompress("a".repeat(200)).compressed).toBe(false);
  });

  it("takes a threshold of its own", () => {
    expect(tryCompress("a".repeat(50), 10).compressed).toBe(true);
  });

  /**
   * Deflate has a header, so on a short input the "compressed" form is larger
   * than what went in. Storing that would make the cache both slower and
   * bigger — which is also what happens with already-compressed content like
   * an image or a gzipped payload, just less reliably reproducible.
   */
  it("keeps the original when compressing makes it bigger", () => {
    const result = tryCompress("xQ7#z", 1);

    expect(result.compressed).toBe(false);
    expect(result.value).toBe("xQ7#z");
  });

  it("reads a compressed value back", () => {
    expect(dumpCompressed(tryCompress(long))).toBe(long);
  });

  it("reads an uncompressed one back unchanged", () => {
    expect(dumpCompressed(tryCompress("short"))).toBe("short");
  });

  it("says whether a store can version its entries", () => {
    expect(supportsCacheVersioning(new MemoryStore())).toBe(true);
  });
});

describe("fetching", () => {
  it("computes on a miss and stores it", async () => {
    const store = new MemoryStore();

    const result = await fetchEntry(store, "key", async () => "computed", {}, 1000);

    expect(result).toEqual({ value: "computed", outcome: "miss" });
  });

  it("returns what was stored on a hit", async () => {
    const store = new MemoryStore();
    await fetchEntry(store, "key", async () => "computed", { expiresInMs: 5000 }, 1000);

    const again = await fetchEntry(store, "key", async () => "recomputed", {}, 2000);

    expect(again).toEqual({ value: "computed", outcome: "hit" });
  });

  it("does not run the computation on a hit", async () => {
    const store = new MemoryStore();
    let ran = 0;
    await fetchEntry(store, "key", async () => "v", { expiresInMs: 5000 }, 1000);

    await fetchEntry(
      store,
      "key",
      async () => {
        ran += 1;

        return "v";
      },
      {},
      2000,
    );

    expect(ran).toBe(0);
  });

  it("recomputes once the entry expires", async () => {
    const store = new MemoryStore();
    await fetchEntry(store, "key", async () => "old", { expiresInMs: 1000 }, 1000);

    const after = await fetchEntry(store, "key", async () => "new", {}, 5000);

    expect(after.value).toBe("new");
  });

  it("recomputes when told to whatever the entry says", async () => {
    const store = new MemoryStore();
    await fetchEntry(store, "key", async () => "old", { expiresInMs: 50_000 }, 1000);

    const forced = await fetchEntry(store, "key", async () => "new", { forceMiss: true }, 2000);

    expect(forced.value).toBe("new");
  });

  /**
   * The case the whole thing exists for: one caller recomputes and the rest
   * are handed the old value rather than queueing behind the same query.
   */
  it("serves the stale value while one caller recomputes", async () => {
    const store = new MemoryStore();
    await fetchEntry(
      store,
      "key",
      async () => "old",
      { expiresInMs: 1000, staleWhileRevalidateMs: 10_000 },
      1000,
    );

    let release: (() => void) | undefined;
    const slow = fetchEntry(
      store,
      "key",
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("new");
        }),
      { expiresInMs: 1000, staleWhileRevalidateMs: 10_000 },
      5000,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const meanwhile = await fetchEntry(store, "key", async () => "never runs", {}, 5000);

    expect(meanwhile).toEqual({ value: "old", outcome: "stale" });

    release?.();
    await slow;
  });

  /**
   * Past the window the old value is not servable, so a second caller waits
   * for the real answer rather than being handed something arbitrarily old.
   * This needs a recompute genuinely in flight, or the grace check is never
   * the thing being tested.
   */
  it("does not serve a stale value once the grace window passes", async () => {
    const store = new MemoryStore();
    await fetchEntry(
      store,
      "key",
      async () => "old",
      { expiresInMs: 1000, staleWhileRevalidateMs: 100 },
      1000,
    );

    let release: (() => void) | undefined;
    const slow = fetchEntry(
      store,
      "key",
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("new");
        }),
      {},
      50_000,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const meanwhile = await fetchEntry(store, "key", async () => "computed itself", {}, 50_000);

    expect(meanwhile.value).toBe("computed itself");

    release?.();
    await slow;
  });

  /**
   * In a `finally`, or a computation that throws leaves the key marked forever
   * and every later caller is served a stale value that never refreshes.
   */
  it("stops marking the key as recomputing when the computation throws", async () => {
    const store = new MemoryStore();

    await expect(
      fetchEntry(store, "key", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(isRecomputing("key")).toBe(false);
  });

  it("is not recomputing anything to start with", () => {
    expect(isRecomputing("key")).toBe(false);
  });
});

describe("writing only when nothing is there", () => {
  it("writes when the key is free", async () => {
    const store = new MemoryStore();

    expect(await storeIfAbsent(store, "key", "mine")).toBe(true);
    expect(await store.read<string>("key")).toBe("mine");
  });

  /** Using this as a lock is the usual reason to want it. */
  it("refuses when something already holds it", async () => {
    const store = new MemoryStore();
    await store.write("key", "theirs");

    expect(await storeIfAbsent(store, "key", "mine")).toBe(false);
    expect(await store.read<string>("key")).toBe("theirs");
  });
});

describe("a cache for one unit of work", () => {
  it("has none until one is opened", () => {
    expect(currentLocalCache()).toBeUndefined();
  });

  it("opens one", () => {
    const cache = newLocalCache();
    cache.set("key", "value");

    expect(currentLocalCache()?.get("key")).toBe("value");
  });

  /**
   * Not optional. One that outlives its request serves one user's data to the
   * next, which is the worst failure here and the quietest.
   */
  it("drops it", () => {
    newLocalCache();

    unsetLocalCache();

    expect(currentLocalCache()).toBeUndefined();
  });

  it("starts a fresh one each time", () => {
    newLocalCache().set("key", "first");

    expect(newLocalCache().has("key")).toBe(false);
  });
});

describe("remembering against an object", () => {
  it("holds a value", () => {
    const owner = {};
    setCacheFor(owner, "key", "value");

    expect(cacheFor(owner, "key")).toBe("value");
  });

  it("keeps two owners apart", () => {
    const one = {};
    setCacheFor(one, "key", "value");

    expect(cacheFor({}, "key")).toBeUndefined();
  });

  it("computes once and remembers", () => {
    const owner = {};
    let ran = 0;
    const compute = () => {
      ran += 1;

      return "value";
    };

    expect(defineCachedMethod(owner, "key", compute)).toBe("value");
    expect(defineCachedMethod(owner, "key", compute)).toBe("value");
    expect(ran).toBe(1);
  });

  it("computes again for a different owner", () => {
    let ran = 0;
    const compute = () => {
      ran += 1;

      return "value";
    };

    defineCachedMethod({}, "key", compute);
    defineCachedMethod({}, "key", compute);

    expect(ran).toBe(2);
  });
});
