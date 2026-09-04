/**
 * Caching a fragment only sometimes, ported from the `cache_if` and
 * `cache_unless` cases in `actionview/test/template/render_test.rb`.
 *
 * The case it is for: a page whose logged-out version is the same for
 * everybody and whose logged-in version is not. Without a condition the choice
 * is to cache neither — losing the win on exactly the traffic a cache is
 * cheapest on, a crawler and a first-time visitor — or to cache both, which
 * serves one person's page to another.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Cache, MemoryStore } from "@altair/support";
import { renderToString } from "../src/render.js";
import { Cached, configureFragmentCache } from "../src/cache.js";

interface Post {
  id: number;
  title: string;
  cacheKey(): string;
}

const post = (id: number, title: string): Post => ({
  id,
  title,
  cacheKey: () => `posts/${id}`,
});

let renders = 0;

function Body({ post }: { post: Post }) {
  renders += 1;

  return <p>{post.title}</p>;
}

afterEach(() => {
  configureFragmentCache(undefined);
  renders = 0;
});

function fresh(): Cache {
  const cache = new Cache(new MemoryStore());

  configureFragmentCache(cache);

  return cache;
}

/** Renders the same fragment twice, and says how many times the body ran. */
async function renderTwice(
  props: Record<string, unknown>,
): Promise<{ html: string; runs: number }> {
  const one = post(1, "Hello");

  const first = await renderToString(
    <Cached on={one} {...props}>
      <Body post={one} />
    </Cached>,
  );

  await renderToString(
    <Cached on={one} {...props}>
      <Body post={one} />
    </Cached>,
  );

  return { html: first, runs: renders };
}

describe("cache if", () => {
  it("caches when the condition holds", async () => {
    fresh();

    const { html, runs } = await renderTwice({ if: true });

    expect(html).toBe("<p>Hello</p>");
    expect(runs).toBe(1);
  });

  it("does not cache when it does not", async () => {
    fresh();

    const { html, runs } = await renderTwice({ if: false });

    expect(html).toBe("<p>Hello</p>");
    expect(runs).toBe(2);
  });

  it("caches when no condition is given at all", async () => {
    fresh();

    expect((await renderTwice({})).runs).toBe(1);
  });

  /** Not caching must never mean not rendering. */
  it("still renders the children when it does not cache", async () => {
    fresh();

    expect((await renderTwice({ if: false })).html).toBe("<p>Hello</p>");
  });

  it("writes nothing to the cache when it does not cache", async () => {
    const cache = fresh();

    await renderTwice({ if: false });

    expect(await cache.read("posts/1")).toBeNull();
  });
});

describe("cache unless", () => {
  it("caches when the condition does not hold", async () => {
    fresh();

    expect((await renderTwice({ unless: false })).runs).toBe(1);
  });

  it("does not cache when it does", async () => {
    fresh();

    expect((await renderTwice({ unless: true })).runs).toBe(2);
  });
});

describe("the three of them together", () => {
  /**
   * Any one saying no is enough, so two that disagree give the safe answer
   * rather than an order of precedence nobody would remember.
   */
  it("does not cache when if says yes and unless does too", async () => {
    fresh();

    expect((await renderTwice({ if: true, unless: true })).runs).toBe(2);
  });

  it("does not cache when skip says so, whatever the others say", async () => {
    fresh();

    expect((await renderTwice({ skip: true, if: true, unless: false })).runs).toBe(2);
  });

  it("caches when all three agree it should", async () => {
    fresh();

    expect((await renderTwice({ skip: false, if: true, unless: false })).runs).toBe(1);
  });
});
