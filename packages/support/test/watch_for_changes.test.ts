/**
 * Pointing a reloader at the filesystem, ported from
 * `railties/test/application/loading_test.rb` and the
 * `ActiveSupport::Reloader` cases in `activesupport/test/reloader_test.rb`.
 *
 * Both halves existed and nothing joined them: the checker answers "has
 * anything changed", the reloader knows how to unload and put everything back.
 * These are about the joint — what runs, in what order, and what still runs
 * when something throws.
 */

import { describe, expect, it } from "bun:test";
import {
  resetPrepareHooks,
  toPrepare,
  watchForChanges,
  watchedDirsWithExtensions,
} from "../src/autoloading.js";
import { Reloader } from "../src/execution.js";
import type { FileStats } from "../src/file_update_checker.js";
import { resolve, sep } from "node:path";

const NOW = Date.now();

/** A filesystem that is a map of path to modification time, read live. */
function fakeStats(tree: Record<string, number>): FileStats {
  const paths = () => Object.keys(tree).map((path) => resolve(path));
  const key = (path: string) => Object.keys(tree).find((one) => resolve(one) === resolve(path));

  return {
    exists: (path) =>
      paths().some((each) => each === resolve(path) || each.startsWith(resolve(path) + sep)),
    mtime: (path) => {
      const found = key(path);

      return found === undefined ? undefined : tree[found];
    },
    entries: (dir) => paths().filter((each) => each.startsWith(resolve(dir) + sep)),
    realpath: (path) => path,
  };
}

function watched(tree: Record<string, number>, paths = ["app/models"]) {
  resetPrepareHooks();

  const reloader = new Reloader();
  const loaded = new Set(["Post", "Comment"]);
  const prepared: string[] = [];

  toPrepare(() => prepared.push("prepared"));

  const checker = watchForChanges(reloader, {
    paths,
    loaded,
    stats: fakeStats(tree),
  });

  return { reloader, loaded, prepared, checker, tree };
}

describe("noticing", () => {
  it("says nothing changed when nothing did", () => {
    const { reloader } = watched({ "app/models/post.ts": NOW - 1000 });

    expect(reloader.updated()).toBe(false);
  });

  it("says so when a watched file changed", () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;

    expect(reloader.updated()).toBe(true);
  });

  /** A template edit should not unload every class in the application. */
  it("ignores a file whose extension was not asked for", () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/README.md"] = NOW - 10;

    expect(reloader.updated()).toBe(false);
  });

  it("ignores a file outside the watched paths", () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["lib/thing.ts"] = NOW - 10;

    expect(reloader.updated()).toBe(false);
  });

  /**
   * The scan deduplicates by path anyway, so this is about the day the watcher
   * is fed by filesystem events instead — where a directory watched twice
   * reports every change twice.
   */
  it("collapses a path nested inside another", () => {
    expect(Object.keys(watchedDirsWithExtensions(["app", "app/models"]))).toEqual(["app"]);
  });

  it("still notices a change under a nested path", () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 }, ["app", "app/models"]);

    tree["app/models/post.ts"] = NOW - 10;

    expect(reloader.updated()).toBe(true);
  });

  /** A routes file is not under an autoload path and still has to be watched. */
  it("watches a file named on its own", () => {
    resetPrepareHooks();

    const reloader = new Reloader();
    const tree = { "app/models/post.ts": NOW - 1000, "config/routes.ts": NOW - 1000 };

    watchForChanges(reloader, {
      paths: ["app/models"],
      files: ["config/routes.ts"],
      loaded: new Set(),
      stats: fakeStats(tree),
    });

    tree["config/routes.ts"] = NOW - 10;

    expect(reloader.updated()).toBe(true);
  });
});

describe("reloading", () => {
  it("does nothing when nothing changed", async () => {
    const { reloader, loaded, prepared } = watched({ "app/models/post.ts": NOW - 1000 });

    expect(await reloader.executeIfUpdated()).toBe(false);
    expect(loaded.size).toBe(2);
    expect(prepared).toEqual([]);
  });

  it("forgets what was loaded", async () => {
    const { reloader, loaded, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;
    await reloader.executeIfUpdated();

    expect(loaded.size).toBe(0);
  });

  it("runs the prepare hooks", async () => {
    const { reloader, prepared, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;
    await reloader.executeIfUpdated();

    expect(prepared).toEqual(["prepared"]);
  });

  /**
   * A prepare hook re-reads a constant, and re-reading one that has not been
   * forgotten yet gives back the version being replaced.
   */
  it("forgets before it re-reads", async () => {
    resetPrepareHooks();

    const reloader = new Reloader();
    const loaded = new Set(["Post"]);
    const sawWhenPrepared: number[] = [];
    const tree = { "app/models/post.ts": NOW - 1000 };

    toPrepare(() => sawWhenPrepared.push(loaded.size));
    watchForChanges(reloader, { paths: ["app/models"], loaded, stats: fakeStats(tree) });

    tree["app/models/post.ts"] = NOW - 10;
    await reloader.executeIfUpdated();

    expect(sawWhenPrepared).toEqual([0]);
  });

  /**
   * Forget, then load, then let anything holding a reference re-read. A step
   * out of order gives somebody the version being replaced.
   */
  it("forgets, then loads, then prepares", async () => {
    resetPrepareHooks();

    const reloader = new Reloader();
    const loaded = new Set(["Post"]);
    const order: string[] = [];
    const tree = { "app/models/post.ts": NOW - 1000 };

    toPrepare(() => order.push("prepare"));
    watchForChanges(reloader, { paths: ["app/models"], loaded, stats: fakeStats(tree) });

    tree["app/models/post.ts"] = NOW - 10;

    await reloader.executeIfUpdated(async () => {
      order.push(loaded.size === 0 ? "load (forgotten)" : "load (still held)");
    });

    expect(order).toEqual(["load (forgotten)", "prepare"]);
  });

  it("says it reloaded", async () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;

    expect(await reloader.executeIfUpdated()).toBe(true);
    expect(reloader.reloaded).toBe(true);
  });

  it("stops reporting the change once it has reloaded", async () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;
    await reloader.executeIfUpdated();

    expect(reloader.updated()).toBe(false);
  });

  /**
   * The checker records the scan `updated` took rather than a fresh one, so an
   * edit that lands while the reload is running is still there next time. It
   * would be very easy to lose, and it is the edit somebody makes while
   * watching the page not update.
   */
  it("still sees an edit made while it was reloading", async () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 500;

    await reloader.executeIfUpdated(async () => {
      tree["app/models/user.ts"] = NOW - 400;
    });

    expect(reloader.updated()).toBe(true);
  });
});

describe("while it is happening", () => {
  /**
   * A request that runs while constants are half gone sees a class that
   * exists with none of its methods — which fails on a method the file
   * plainly defines, so nobody finds it by reading the file.
   */
  it("holds the interlock alone", async () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });
    let unloadingDuring = false;

    tree["app/models/post.ts"] = NOW - 10;

    await reloader.executeIfUpdated(async () => {
      unloadingDuring = reloader.unloading;
    });

    expect(unloadingDuring).toBe(true);
    expect(reloader.unloading).toBe(false);
  });

  /**
   * A hook that fails leaves the application in a bad state; one that fails
   * and leaves the lock held leaves it in no state at all, with every request
   * after it waiting on a reload that already gave up.
   */
  it("lets go even when the reload throws", async () => {
    const { reloader, tree } = watched({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;

    await expect(
      reloader.executeIfUpdated(async () => {
        throw new Error("a constant would not load");
      }),
    ).rejects.toThrow("a constant would not load");

    expect(reloader.unloading).toBe(false);

    // And the next one can still take it.
    tree["app/models/post.ts"] = NOW - 5;
    expect(await reloader.executeIfUpdated()).toBe(true);
  });
});
