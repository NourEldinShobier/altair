/**
 * The per-request local cache, ported from
 * `activesupport/test/cache/local_cache_middleware_test.rb` and the
 * LocalCache behaviour cases in `cache/behaviors/`.
 */

import { describe, expect, it } from "bun:test";
import { Cache, MemoryStore } from "../src/cache.js";
import {
  LocalCacheProxy,
  clearLocalCache,
  expandCacheKey,
  localCacheEnabled,
  withLocalCache,
} from "../src/cache_local.js";

/** A store that counts what actually reached it. */
class CountingStore extends MemoryStore {
  reads = 0;

  override async read<T = unknown>(key: string): Promise<T | null> {
    this.reads += 1;
    return await super.read<T>(key);
  }
}

describe("the scope", () => {
  it("is off outside a block", () => {
    expect(localCacheEnabled()).toBe(false);
  });

  it("is on inside one", async () => {
    await withLocalCache(() => {
      expect(localCacheEnabled()).toBe(true);
    });
  });

  /** The point of scoping it: another process can change a shared cache. */
  it("is off again afterwards", async () => {
    await withLocalCache(() => {});

    expect(localCacheEnabled()).toBe(false);
  });

  it("returns the result of the block", async () => {
    expect(await withLocalCache(() => 123)).toBe(123);
  });

  it("is off again after the block throws", async () => {
    await expect(
      withLocalCache(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(localCacheEnabled()).toBe(false);
  });

  /** A middleware and a job each wrapping work must not pay twice. */
  it("shares the map with a nested block", async () => {
    const store = new CountingStore();
    const cache = new LocalCacheProxy(new Cache(store));
    await cache.write("k", "v");

    await withLocalCache(async () => {
      await cache.read("k");
      await withLocalCache(async () => {
        await cache.read("k");
      });
    });

    expect(store.reads).toBe(1);
  });
});

describe("reading", () => {
  it("hits the store once for repeated reads", async () => {
    const store = new CountingStore();
    const cache = new LocalCacheProxy(new Cache(store));
    await cache.write("k", "v");

    await withLocalCache(async () => {
      expect(await cache.read<string>("k")).toBe("v");
      expect(await cache.read<string>("k")).toBe("v");
      expect(await cache.read<string>("k")).toBe("v");
    });

    expect(store.reads).toBe(1);
  });

  it("hits the store every time outside a block", async () => {
    const store = new CountingStore();
    const cache = new LocalCacheProxy(new Cache(store));
    await cache.write("k", "v");

    await cache.read("k");
    await cache.read("k");

    expect(store.reads).toBe(2);
  });

  /** A miss is worth remembering too, or the expensive lookup runs twice. */
  it("remembers a miss", async () => {
    const store = new CountingStore();
    const cache = new LocalCacheProxy(new Cache(store));

    await withLocalCache(async () => {
      expect(await cache.read("absent")).toBeNull();
      expect(await cache.read("absent")).toBeNull();
    });

    expect(store.reads).toBe(1);
  });

  it("keeps separate keys apart", async () => {
    const cache = new LocalCacheProxy(new Cache(new MemoryStore()));
    await cache.write("a", 1);
    await cache.write("b", 2);

    await withLocalCache(async () => {
      expect(await cache.read<number>("a")).toBe(1);
      expect(await cache.read<number>("b")).toBe(2);
    });
  });
});

describe("writing", () => {
  /**
   * Updated rather than invalidated: the writer knows the new value, and a
   * later read in the same request wanting it is the common case.
   */
  it("makes the new value readable without touching the store", async () => {
    const store = new CountingStore();
    const cache = new LocalCacheProxy(new Cache(store));

    await withLocalCache(async () => {
      await cache.write("k", "fresh");
      expect(await cache.read<string>("k")).toBe("fresh");
    });

    expect(store.reads).toBe(0);
  });

  it("writes through to the store", async () => {
    const store = new MemoryStore();
    const cache = new LocalCacheProxy(new Cache(store));

    await withLocalCache(async () => {
      await cache.write("k", "fresh");
    });

    expect(await new Cache(store).read<string>("k")).toBe("fresh");
  });

  it("forgets a deleted key locally as well", async () => {
    const cache = new LocalCacheProxy(new Cache(new MemoryStore()));

    await withLocalCache(async () => {
      await cache.write("k", "v");
      await cache.delete("k");

      expect(await cache.read("k")).toBeNull();
    });
  });

  it("clears without ending the block", async () => {
    const store = new CountingStore();
    const cache = new LocalCacheProxy(new Cache(store));
    await cache.write("k", "v");

    await withLocalCache(async () => {
      await cache.read("k");
      clearLocalCache();
      await cache.read("k");
    });

    expect(store.reads).toBe(2);
  });
});

describe("fetch", () => {
  it("computes once per block", async () => {
    const cache = new LocalCacheProxy(new Cache(new MemoryStore()));
    let computed = 0;

    await withLocalCache(async () => {
      await cache.fetch("k", () => {
        computed += 1;
        return "value";
      });
      await cache.fetch("k", () => {
        computed += 1;
        return "value";
      });
    });

    expect(computed).toBe(1);
  });

  it("gives the computed value back", async () => {
    const cache = new LocalCacheProxy(new Cache(new MemoryStore()));

    await withLocalCache(async () => {
      expect(await cache.fetch("k", () => "value")).toBe("value");
    });
  });
});

describe("expandCacheKey", () => {
  it("passes a string through", () => {
    expect(expandCacheKey("posts/1")).toBe("posts/1");
  });

  it("joins an array with slashes", () => {
    expect(expandCacheKey(["posts", 1, "show"])).toBe("posts/1/show");
  });

  /** A hand-built key is where the version gets left out and a fragment goes stale. */
  it("asks an object for its cacheKey", () => {
    expect(expandCacheKey({ cacheKey: "posts/1-20260101" })).toBe("posts/1-20260101");
  });

  it("calls a cacheKey method", () => {
    expect(expandCacheKey({ cacheKey: () => "posts/2" })).toBe("posts/2");
  });

  it("nests", () => {
    expect(expandCacheKey(["fragment", { cacheKey: "posts/1" }])).toBe("fragment/posts/1");
  });

  it("handles nothing", () => {
    expect(expandCacheKey(null)).toBe("null");
    expect(expandCacheKey(undefined)).toBe("undefined");
  });
});
