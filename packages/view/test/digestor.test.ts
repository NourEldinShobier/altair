/**
 * What a cached fragment's key depends on, ported from
 * `actionview/test/template/digestor_test.rb` and the `cache` helper cases in
 * `actionview/test/template/render_test.rb`.
 *
 * The failure this prevents is the one everybody has met: you edit a partial,
 * deploy, and every page still shows the old markup — because the cache key is
 * built from the record, the record has not changed, and nothing knows the
 * template moved.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  cacheDisabled,
  cacheFragmentName,
  cacheHits,
  cacheIf,
  cacheTemplateLoading,
  cacheUnless,
  clearCache,
  dependencyDigest,
  digestCache,
  digestCaches,
  digestPathFromTemplate,
  disableCache,
  findDependencies,
  markUncacheable,
  recordCacheHit,
  registerTemplateSource,
  registerTracker,
  removeTracker,
  resetCacheHits,
  resetDigestor,
  trackCaching,
  uncacheable,
  withEmptyTemplateCache,
} from "../src/digestor.js";

afterEach(() => {
  resetDigestor();
});

/** Declares a tree of templates and what each renders. */
function tree(graph: Record<string, { source: string; renders?: string[] }>): void {
  for (const [name, { source }] of Object.entries(graph)) registerTemplateSource(name, source);

  registerTracker("test", (name) => graph[name]?.renders ?? []);
}

describe("the digest of one template", () => {
  it("is stable for the same source", () => {
    tree({ "posts/index": { source: "<h1>Posts</h1>" } });

    const first = dependencyDigest("posts/index");
    clearCache();
    tree({ "posts/index": { source: "<h1>Posts</h1>" } });

    expect(dependencyDigest("posts/index")).toBe(first);
  });

  /** The whole point: the key has to move when the template does. */
  it("changes when the source changes", () => {
    tree({ "posts/index": { source: "<h1>Posts</h1>" } });
    const before = dependencyDigest("posts/index");

    resetDigestor();
    tree({ "posts/index": { source: "<h1>All posts</h1>" } });

    expect(dependencyDigest("posts/index")).not.toBe(before);
  });

  it("differs between two templates with the same source", () => {
    tree({ "posts/index": { source: "same" }, "comments/index": { source: "same" } });

    expect(dependencyDigest("posts/index")).not.toBe(dependencyDigest("comments/index"));
  });

  it("gives something for a template nobody registered", () => {
    expect(dependencyDigest("nothing/here")).toHaveLength(32);
  });
});

describe("the digest of what it renders", () => {
  /**
   * The recursion is the feature. A digest of one template alone leaves the
   * caller's cache stale, which is the same bug one level up.
   */
  it("changes when a partial it renders changes", () => {
    tree({
      "posts/index": { source: "index", renders: ["posts/post"] },
      "posts/post": { source: "post" },
    });
    const before = dependencyDigest("posts/index");

    resetDigestor();
    tree({
      "posts/index": { source: "index", renders: ["posts/post"] },
      "posts/post": { source: "post edited" },
    });

    expect(dependencyDigest("posts/index")).not.toBe(before);
  });

  it("changes when something three levels down changes", () => {
    const build = (deepest: string) =>
      tree({
        a: { source: "a", renders: ["b"] },
        b: { source: "b", renders: ["c"] },
        c: { source: deepest },
      });

    build("c");
    const before = dependencyDigest("a");

    resetDigestor();
    build("c edited");

    expect(dependencyDigest("a")).not.toBe(before);
  });

  it("does not change when an unrelated template changes", () => {
    tree({
      "posts/index": { source: "index", renders: ["posts/post"] },
      "posts/post": { source: "post" },
      "comments/index": { source: "comments" },
    });
    const before = dependencyDigest("posts/index");

    resetDigestor();
    tree({
      "posts/index": { source: "index", renders: ["posts/post"] },
      "posts/post": { source: "post" },
      "comments/index": { source: "comments edited" },
    });

    expect(dependencyDigest("posts/index")).toBe(before);
  });

  /** Two components rendering each other is unusual and legal. */
  it("survives a cycle rather than recursing forever", () => {
    tree({ a: { source: "a", renders: ["b"] }, b: { source: "b", renders: ["a"] } });

    expect(dependencyDigest("a")).toHaveLength(32);
  });

  it("does not depend on the order dependencies are declared in", () => {
    tree({
      page: { source: "page", renders: ["one", "two"] },
      one: { source: "one" },
      two: { source: "two" },
    });
    const before = dependencyDigest("page");

    resetDigestor();
    tree({
      page: { source: "page", renders: ["two", "one"] },
      one: { source: "one" },
      two: { source: "two" },
    });

    expect(dependencyDigest("page")).toBe(before);
  });
});

describe("trackers", () => {
  it("reports what a template renders", () => {
    tree({ page: { source: "page", renders: ["part"] }, part: { source: "part" } });

    expect(findDependencies("page")).toEqual(["part"]);
  });

  it("reports nothing for a template that renders nothing", () => {
    tree({ page: { source: "page" } });

    expect(findDependencies("page")).toEqual([]);
  });

  /** One template can be reached more than one way; missing either leaves a stale cache. */
  it("combines what every tracker knows", () => {
    registerTracker("one", (name) => (name === "page" ? ["a"] : []));
    registerTracker("two", (name) => (name === "page" ? ["b"] : []));

    expect(findDependencies("page").sort()).toEqual(["a", "b"]);
  });

  it("does not report the same dependency twice", () => {
    registerTracker("one", () => ["a"]);
    registerTracker("two", () => ["a"]);

    expect(findDependencies("page")).toEqual(["a"]);
  });

  it("can be removed", () => {
    registerTracker("one", () => ["a"]);

    expect(removeTracker("one")).toBe(true);
    expect(findDependencies("page")).toEqual([]);
  });

  it("says when there was nothing to remove", () => {
    expect(removeTracker("never-registered")).toBe(false);
  });
});

describe("remembering digests", () => {
  it("computes one once", () => {
    tree({ page: { source: "page" } });

    dependencyDigest("page");

    expect(digestCache().has("page")).toBe(true);
    expect(digestCaches()["page"]).toBeDefined();
  });

  /**
   * On in production, where templates cannot change under a running process.
   * Off in development, where they do — and a digest cached across an edit is
   * exactly the staleness this exists to prevent.
   */
  it("is on by default", () => {
    expect(cacheTemplateLoading()).toBe(true);
  });

  it("recomputes when caching is off", () => {
    trackCaching(false);
    tree({ page: { source: "page" } });
    dependencyDigest("page");

    registerTemplateSource("page", "page edited");

    expect(digestCache().size).toBe(0);
  });

  it("gives the new digest after an edit when caching is off", () => {
    trackCaching(false);
    tree({ page: { source: "page" } });
    const before = dependencyDigest("page");

    registerTemplateSource("page", "page edited");

    expect(dependencyDigest("page")).not.toBe(before);
  });

  it("runs something with nothing remembered and puts it back", () => {
    tree({ page: { source: "page" } });
    dependencyDigest("page");

    withEmptyTemplateCache(() => {
      expect(digestCache().size).toBe(0);
    });

    expect(digestCache().has("page")).toBe(true);
  });

  it("puts it back even when the body throws", () => {
    tree({ page: { source: "page" } });
    dependencyDigest("page");

    expect(() =>
      withEmptyTemplateCache(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(digestCache().has("page")).toBe(true);
  });
});

describe("templates that must not be cached", () => {
  it("marks one", () => {
    tree({ page: { source: "page" } });
    markUncacheable("page");

    expect(uncacheable("page")).toBe(true);
  });

  it("leaves an ordinary one alone", () => {
    tree({ page: { source: "page" } });

    expect(uncacheable("page")).toBe(false);
  });

  /**
   * Recursive for the same reason the digest is: checking only the top
   * template is how the uncacheable thing gets cached anyway.
   */
  it("spreads to whatever renders one", () => {
    tree({ page: { source: "page", renders: ["clock"] }, clock: { source: "clock" } });
    markUncacheable("clock");

    expect(uncacheable("page")).toBe(true);
  });

  it("spreads up several levels", () => {
    tree({
      a: { source: "a", renders: ["b"] },
      b: { source: "b", renders: ["c"] },
      c: { source: "c" },
    });
    markUncacheable("c");

    expect(uncacheable("a")).toBe(true);
  });

  it("survives a cycle", () => {
    tree({ a: { source: "a", renders: ["b"] }, b: { source: "b", renders: ["a"] } });

    expect(uncacheable("a")).toBe(false);
  });
});

describe("the key a fragment is stored under", () => {
  /**
   * The digest goes in the key rather than beside it, so a template edit
   * produces a different key rather than overwriting the old entry — and a
   * rollback finds its own cache still there.
   */
  it("includes the digest", () => {
    tree({ "posts/post": { source: "post" } });

    expect(cacheFragmentName("posts/post", ["posts/1-2026"])).toContain(
      dependencyDigest("posts/post"),
    );
  });

  it("includes what the caller passed", () => {
    tree({ "posts/post": { source: "post" } });

    expect(cacheFragmentName("posts/post", ["posts/1-2026"])).toContain("posts/1-2026");
  });

  it("changes when the template changes but the record does not", () => {
    tree({ "posts/post": { source: "post" } });
    const before = cacheFragmentName("posts/post", ["posts/1-2026"]);

    resetDigestor();
    tree({ "posts/post": { source: "post edited" } });

    expect(cacheFragmentName("posts/post", ["posts/1-2026"])).not.toBe(before);
  });

  it("leaves the digest out when told to", () => {
    tree({ "posts/post": { source: "post" } });

    expect(cacheFragmentName("posts/post", ["posts/1"], { skipDigest: true })).toBe(
      "posts/post/posts/1",
    );
  });

  it("strips the extension from the path", () => {
    expect(digestPathFromTemplate("/posts/_post.html.erb")).toBe("posts/_post.html");
  });
});

describe("deciding whether to cache", () => {
  it("caches when the condition holds", () => {
    tree({ page: { source: "page" } });

    expect(cacheIf(true, "page")).toBe(true);
    expect(cacheIf(false, "page")).toBe(false);
  });

  it("is the other way round for cacheUnless", () => {
    tree({ page: { source: "page" } });

    expect(cacheUnless(false, "page")).toBe(true);
    expect(cacheUnless(true, "page")).toBe(false);
  });

  /** A condition saying yes cannot override a template that must not be cached. */
  it("refuses an uncacheable template whatever the condition says", () => {
    tree({ page: { source: "page" } });
    markUncacheable("page");

    expect(cacheIf(true, "page")).toBe(false);
    expect(cacheUnless(false, "page")).toBe(false);
  });

  it("turns caching off for a block", () => {
    expect(cacheDisabled()).toBe(false);

    disableCache(() => {
      expect(cacheDisabled()).toBe(true);
    });

    expect(cacheDisabled()).toBe(false);
  });

  it("turns it back on even when the block throws", () => {
    expect(() =>
      disableCache(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(cacheDisabled()).toBe(false);
  });

  it("counts what was served from the cache", () => {
    expect(cacheHits()).toBe(0);

    recordCacheHit();
    recordCacheHit();

    expect(cacheHits()).toBe(2);

    resetCacheHits();

    expect(cacheHits()).toBe(0);
  });
});
