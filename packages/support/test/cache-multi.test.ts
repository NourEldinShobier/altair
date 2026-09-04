/**
 * Several cache entries at once, ported from
 * `activesupport/test/cache/behaviors/cache_store_behavior.rb`.
 *
 * One round trip instead of N. Against a memory store the difference is
 * nothing; against a Redis across a network it is a page that renders against
 * a page that waits.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { MemoryStore } from "../src/cache.js";
import { deleteMatched, fetchMulti, readMulti, writeMulti } from "../src/cache-multi.js";

let cache: MemoryStore;

beforeEach(() => {
  cache = new MemoryStore();
});

describe("reading several", () => {
  it("answers with what it holds", async () => {
    await cache.write("a", 1);
    await cache.write("b", 2);

    expect([...(await readMulti(cache, ["a", "b"]))]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  /**
   * Absent rather than present as null, so `has` answers the question a caller
   * actually has: "was this cached", not "was the cached value nothing".
   */
  it("leaves out what it does not hold", async () => {
    await cache.write("a", 1);

    const found = await readMulti(cache, ["a", "missing"]);

    expect(found.has("missing")).toBe(false);
    expect(found.size).toBe(1);
  });

  it("answers with nothing when it holds nothing", async () => {
    expect((await readMulti(cache, ["a", "b"])).size).toBe(0);
  });
});

describe("writing several", () => {
  it("takes an object", async () => {
    await writeMulti(cache, { a: 1, b: 2 });

    expect(await cache.read<number>("a")).toBe(1);
    expect(await cache.read<number>("b")).toBe(2);
  });

  it("takes a map, and an expiry for all of them", async () => {
    await writeMulti(cache, new Map([["a", 1]]), { expiresIn: 60 });

    expect(await cache.read<number>("a")).toBe(1);
  });
});

/**
 * The block is called only for the misses, and only once each — which a
 * hand-written version usually gets wrong by recomputing everything when one
 * key is cold.
 */
describe("fetching several", () => {
  it("computes only what is missing", async () => {
    await cache.write("a", "cached");

    const computed: string[] = [];
    const found = await fetchMulti(cache, ["a", "b", "c"], (key) => {
      computed.push(key);
      return `made-${key}`;
    });

    expect(computed).toEqual(["b", "c"]);
    expect([...found]).toEqual([
      ["a", "cached"],
      ["b", "made-b"],
      ["c", "made-c"],
    ]);
  });

  it("caches what it computed", async () => {
    await fetchMulti(cache, ["a"], () => "made");

    expect(await cache.read<string>("a")).toBe("made");
  });

  it("computes nothing when everything is cached", async () => {
    await cache.write("a", 1);

    let called = 0;
    await fetchMulti(cache, ["a"], () => {
      called += 1;
      return 2;
    });

    expect(called).toBe(0);
  });

  // So a caller can zip the answers back against the list it handed over.
  it("answers in the order it was asked", async () => {
    await cache.write("b", "cached");

    const found = await fetchMulti(cache, ["c", "b", "a"], (key) => key);

    expect([...found.keys()]).toEqual(["c", "b", "a"]);
  });
});

describe("deleting by pattern", () => {
  it("takes everything that matches", async () => {
    await writeMulti(cache, { "post/1": 1, "post/2": 2, "user/1": 3 });

    expect(await deleteMatched(cache, /^post\//)).toBe(2);

    expect(await cache.read("post/1")).toBeNull();
    expect(await cache.read<number>("user/1")).toBe(3);
  });

  /**
   * A Redis cannot list its keys without scanning the whole space, so a store
   * that cannot say what it holds refuses rather than deleting nothing and
   * reporting success.
   */
  it("refuses on a store that cannot list its keys", async () => {
    // Own properties only, which is the point: the store keeps its methods on
    // the prototype, so `delete` on the instance is a no-op and the test would
    // pass for the wrong reason.
    const blind = Object.assign({}, cache, { keys: undefined }) as unknown as MemoryStore;

    await expect(deleteMatched(blind, /x/)).rejects.toThrow(/cannot list its keys/);
  });
});
