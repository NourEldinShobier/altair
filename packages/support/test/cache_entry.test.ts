/**
 * Cache entries, ported from `activesupport/test/cache/cache_entry_test.rb`
 * and the store-contract cases in `activesupport/test/cache/behaviors/`.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_COMPRESS_THRESHOLD, Entry, EntryStore } from "../src/cache_entry.js";

describe("Entry", () => {
  it("round-trips a value", () => {
    expect(new Entry({ a: 1 }).value).toEqual({ a: 1 });
  });

  it("round-trips a scalar", () => {
    expect(new Entry("hello").value).toBe("hello");
    expect(new Entry(42).value).toBe(42);
    expect(new Entry(false).value).toBe(false);
  });

  /** A stored null is a value, not an absence — that is the point of an entry. */
  it("round-trips null", () => {
    expect(new Entry(null).value).toBeNull();
  });

  it("does not expire without being told to", () => {
    expect(new Entry("x").expired()).toBe(false);
    expect(new Entry("x").expiresAt).toBeUndefined();
  });

  it("expires after its window", () => {
    const entry = new Entry("x", { expiresIn: 60 }, 1000);

    expect(entry.expired(1000)).toBe(false);
    expect(entry.expired(60_000)).toBe(false);
    expect(entry.expired(61_001)).toBe(true);
  });

  it("takes an absolute expiry", () => {
    const entry = new Entry("x", { expiresAt: 5000 }, 1000);

    expect(entry.expired(4999)).toBe(false);
    expect(entry.expired(5000)).toBe(true);
  });

  it("reports how long is left", () => {
    const entry = new Entry("x", { expiresIn: 60 }, 1000);

    expect(entry.secondsUntilExpiry(1000)).toBe(60);
    expect(new Entry("x").secondsUntilExpiry()).toBeUndefined();
  });
});

describe("versions", () => {
  /** Keying on a version means the old entry is never read, not deleted. */
  it("notices a different version", () => {
    const entry = new Entry("x", { version: "v1" });

    expect(entry.mismatched("v2")).toBe(true);
    expect(entry.mismatched("v1")).toBe(false);
  });

  /**
   * Not every entry is versioned, and treating an unversioned one as
   * mismatched would make the cache never hit for anybody who did not opt in.
   */
  it("does not mind when either side has no version", () => {
    expect(new Entry("x").mismatched("v1")).toBe(false);
    expect(new Entry("x", { version: "v1" }).mismatched(undefined)).toBe(false);
  });

  it("is unusable when mismatched or expired", () => {
    const entry = new Entry("x", { version: "v1", expiresIn: 60 }, 1000);

    expect(entry.usable("v1", 1000)).toBe(true);
    expect(entry.usable("v2", 1000)).toBe(false);
    expect(entry.usable("v1", 999_999)).toBe(false);
  });
});

describe("compression", () => {
  /** Below the threshold the gzip header costs more than it saves. */
  it("leaves a small value uncompressed", () => {
    expect(new Entry("small").compressed).toBe(false);
  });

  it("compresses a large one", () => {
    expect(new Entry("x".repeat(DEFAULT_COMPRESS_THRESHOLD * 2)).compressed).toBe(true);
  });

  it("round-trips a compressed value unchanged", () => {
    const value = { text: "y".repeat(DEFAULT_COMPRESS_THRESHOLD * 2), n: 1 };
    const entry = new Entry(value);

    expect(entry.compressed).toBe(true);
    expect(entry.value).toEqual(value);
  });

  it("actually gets smaller", () => {
    const value = "z".repeat(DEFAULT_COMPRESS_THRESHOLD * 10);

    expect(new Entry(value).bytesize).toBeLessThan(value.length);
  });

  it("takes a different threshold", () => {
    expect(new Entry("small", { compressThreshold: 1 }).compressed).toBe(true);
    expect(new Entry("x".repeat(5000), { compressThreshold: 100_000 }).compressed).toBe(false);
  });
});

describe("EntryStore", () => {
  it("reads what it wrote", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1));

    expect(store.readEntry("a")?.value).toBe(1);
  });

  it("gives null for a key it does not have", () => {
    expect(new EntryStore().readEntry("absent")).toBeNull();
  });

  it("deletes", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1));

    expect(store.deleteEntry("a")).toBe(true);
    expect(store.deleteEntry("a")).toBe(false);
    expect(store.readEntry("a")).toBeNull();
  });

  /** Dropped on read: a key nobody asks about costs nothing. */
  it("drops an expired entry when it is read", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1, { expiresAt: 1 }));

    expect(store.readEntry("a")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("drops a mismatched entry when it is read", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1, { version: "v1" }));

    expect(store.readEntry("a", "v2")).toBeNull();
    expect(store.readEntry("a", "v1")).toBeNull();
  });

  it("reads several at once, skipping what it does not have", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1));
    store.writeEntry("b", new Entry(2));

    const found = store.readMultiEntries(["a", "b", "c"]);

    expect([...found.keys()].sort()).toEqual(["a", "b"]);
    expect(found.get("a")?.value).toBe(1);
  });

  it("writes several at once", () => {
    const store = new EntryStore();
    store.writeMultiEntries(
      new Map([
        ["a", new Entry(1)],
        ["b", new Entry(2)],
      ]),
    );

    expect(store.size).toBe(2);
  });

  it("deletes by pattern", () => {
    const store = new EntryStore();
    store.writeEntry("posts/1", new Entry(1));
    store.writeEntry("posts/2", new Entry(2));
    store.writeEntry("users/1", new Entry(3));

    expect(store.deleteMatchedEntries(/^posts\//)).toBe(2);
    expect(store.keys).toEqual(["users/1"]);
  });

  /** Reads drop what they find, but something has to be able to say so. */
  it("cleans up expired entries in bulk", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1, { expiresAt: 1 }));
    store.writeEntry("b", new Entry(2, { expiresAt: 1 }));
    store.writeEntry("c", new Entry(3));

    expect(store.cleanup()).toBe(2);
    expect(store.keys).toEqual(["c"]);
  });

  it("reports its size in entries and in bytes", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry("hello"));

    expect(store.size).toBe(1);
    expect(store.bytesize).toBeGreaterThan(0);
  });

  /** What makes a cache a cache rather than a leak. */
  it("evicts the oldest when full", () => {
    const store = new EntryStore(2);
    store.writeEntry("a", new Entry(1));
    store.writeEntry("b", new Entry(2));
    store.writeEntry("c", new Entry(3));

    expect(store.size).toBe(2);
    expect(store.keys).toEqual(["b", "c"]);
  });

  it("does not evict when overwriting an existing key", () => {
    const store = new EntryStore(2);
    store.writeEntry("a", new Entry(1));
    store.writeEntry("b", new Entry(2));
    store.writeEntry("a", new Entry(3));

    expect(store.keys.sort()).toEqual(["a", "b"]);
    expect(store.readEntry("a")?.value).toBe(3);
  });

  it("clears", () => {
    const store = new EntryStore();
    store.writeEntry("a", new Entry(1));
    store.clearAll();

    expect(store.size).toBe(0);
  });
});
