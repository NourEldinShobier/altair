/**
 * Noticing that a file changed, ported from
 * `activesupport/test/file_update_checker_shared_tests.rb` and
 * `activesupport/test/evented_file_update_checker_test.rb`.
 *
 * The filesystem is a parameter here rather than a temporary directory: every
 * case below is about a clock or a count, and reproducing "a file dated next
 * year" or "an edit that lands between two calls" against a real disk is a
 * test that passes for the wrong reason on a fast machine.
 */

import { describe, expect, it } from "bun:test";
import { resolve, sep } from "node:path";
import {
  FileUpdateChecker,
  type FileStats,
  type WatchedPaths,
} from "../src/file_update_checker.js";

const NOW = Date.now();

/** A filesystem that is a map of path to modification time, read live. */
function fakeStats(tree: Record<string, number>, links: Record<string, string>): FileStats {
  const lookup = (source: Record<string, unknown>, path: string) =>
    Object.keys(source).find((key) => resolve(key) === resolve(path));

  const paths = () => Object.keys(tree).map((path) => resolve(path));

  return {
    exists: (path) =>
      lookup(links, path) !== undefined ||
      paths().some((each) => each === resolve(path) || each.startsWith(resolve(path) + sep)),
    mtime: (path) => {
      const key = lookup(tree, path);

      return key === undefined ? undefined : tree[key];
    },
    entries: (dir) => paths().filter((each) => each.startsWith(resolve(dir) + sep)),
    realpath: (path) => {
      const key = lookup(links, path);

      return key === undefined ? path : (links[key] as string);
    },
  };
}

function checker(
  tree: Record<string, number>,
  watched: WatchedPaths = { dirs: { "app/models": [".ts"] } },
  links: Record<string, string> = {},
): { it: FileUpdateChecker; ran: () => number; tree: Record<string, number> } {
  let runs = 0;
  const instance = new FileUpdateChecker(watched, () => void (runs += 1), fakeStats(tree, links));

  return { it: instance, ran: () => runs, tree };
}

describe("noticing a change", () => {
  it("says nothing when nothing moved", () => {
    const { it: check } = checker({ "app/models/post.ts": NOW - 1000 });

    expect(check.updated()).toBe(false);
  });

  it("notices an mtime moving forward", () => {
    const { it: check, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;

    expect(check.updated()).toBe(true);
  });

  /**
   * Comparing the newest mtime alone misses a deletion: removing a file lowers
   * nothing, and the remaining files keep their old timestamps.
   */
  it("notices a file that is gone", () => {
    const { it: check, tree } = checker({
      "app/models/post.ts": NOW - 1000,
      "app/models/user.ts": NOW - 2000,
    });

    delete tree["app/models/user.ts"];

    expect(check.updated()).toBe(true);
  });

  /** The newest file is rarely the first one the scan happens to reach. */
  it("takes the newest mtime, not the first", () => {
    const { it: check, tree } = checker({
      "app/models/post.ts": NOW - 1000,
      "app/models/user.ts": NOW - 2000,
    });

    tree["app/models/user.ts"] = NOW - 10;

    expect(check.updated()).toBe(true);
  });

  it("notices a file that appeared with an old timestamp", () => {
    const { it: check, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/user.ts"] = NOW - 5000;

    expect(check.updated()).toBe(true);
  });

  /**
   * A clock set forward by hand, or a file copied from a machine whose clock
   * is ahead, would otherwise pin the high-water mark somewhere no real edit
   * reaches — and reloading stops for the session with nothing in the log.
   */
  it("ignores a file dated in the future", () => {
    const { it: check, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW + 60 * 60 * 1000;

    expect(check.updated()).toBe(false);

    tree["app/models/post.ts"] = NOW - 10;

    expect(check.updated()).toBe(true);
  });
});

describe("running the block", () => {
  it("runs it and stops reporting the change", () => {
    const { it: check, ran, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 10;

    expect(check.executeIfUpdated()).toBe(true);
    expect(ran()).toBe(1);
    expect(check.updated()).toBe(false);
  });

  it("does not run it when nothing changed", () => {
    const { it: check, ran } = checker({ "app/models/post.ts": NOW - 1000 });

    expect(check.executeIfUpdated()).toBe(false);
    expect(ran()).toBe(0);
  });

  it("runs it unconditionally when asked directly", () => {
    const { it: check, ran } = checker({ "app/models/post.ts": NOW - 1000 });

    check.execute();

    expect(ran()).toBe(1);
  });

  /**
   * Rescanning in `execute` would record the state as of *after* the reload,
   * so an edit made in the moment between the two calls would be swallowed
   * permanently.
   */
  it("records the scan that noticed the change, not a newer one", () => {
    const { it: check, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/post.ts"] = NOW - 500;
    expect(check.updated()).toBe(true);

    // The edit lands while the reload is running.
    tree["app/models/user.ts"] = NOW - 400;
    check.execute();

    expect(check.updated()).toBe(true);
  });
});

describe("what counts as watched", () => {
  it("watches a named file wherever it is", () => {
    const { it: check } = checker(
      { "config/routes.ts": NOW - 1000 },
      { files: ["config/routes.ts"] },
    );

    expect(check.watching("config/routes.ts")).toBe(true);
    expect(check.watching("config/other.ts")).toBe(false);
  });

  /** Reloading because vim wrote a swap file is a reload on every keystroke. */
  it("watches only the extensions a directory asked for", () => {
    const { it: check } = checker({ "app/models/post.ts": NOW - 1000 });

    expect(check.watching("app/models/post.ts")).toBe(true);
    expect(check.watching("app/models/.post.ts.swp")).toBe(false);
    expect(check.watching("app/models/nested/post.ts")).toBe(true);
  });

  it("watches everything when a directory named no extensions", () => {
    const { it: check } = checker({ "config/app.yml": NOW - 1000 }, { dirs: { config: [] } });

    expect(check.watching("config/app.yml")).toBe(true);
    expect(check.watching("config/anything")).toBe(true);
    // Not the directory itself, even though it names no extension to fail on.
    expect(check.watching("config")).toBe(false);
  });

  it("takes an extension with or without its dot", () => {
    const { it: check } = checker(
      { "app/models/post.ts": NOW - 1000 },
      {
        dirs: { "app/models": ["ts"] },
      },
    );

    expect(check.watching("app/models/post.ts")).toBe(true);
  });

  /** `app/views` is a prefix of `app/views_old`, and a string check watches both. */
  it("does not watch a sibling whose name starts the same", () => {
    const { it: check } = checker({ "app/models/post.ts": NOW - 1000 });

    expect(check.watching("app/models_old/post.ts")).toBe(false);
  });

  it("does not watch the directory itself", () => {
    const { it: check } = checker({ "app/models/post.ts": NOW - 1000 });

    expect(check.watching("app/models")).toBe(false);
  });

  /** A dot at the front is part of the name, not a separator. */
  it("does not read a dotfile's name as its extension", () => {
    const { it: check } = checker({ "app/models/post.ts": NOW - 1000 });

    expect(check.watching("app/models/.ts")).toBe(false);
  });

  it("ignores a file under no watched directory", () => {
    const { it: check, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["lib/thing.ts"] = NOW - 10;

    expect(check.updated()).toBe(false);
  });

  /** The swap file vim leaves next to the template is not a reason to reload. */
  it("ignores a wrong-extension file inside a watched directory", () => {
    const { it: check, tree } = checker({ "app/models/post.ts": NOW - 1000 });

    tree["app/models/.post.ts.swp"] = NOW - 10;

    expect(check.updated()).toBe(false);
  });
});

describe("a file watched by name", () => {
  it("notices it changing", () => {
    const { it: check, tree } = checker(
      { "config/routes.ts": NOW - 1000 },
      { files: ["config/routes.ts"] },
    );

    tree["config/routes.ts"] = NOW - 10;

    expect(check.updated()).toBe(true);
  });

  it("notices it going away", () => {
    const { it: check, tree } = checker(
      { "config/routes.ts": NOW - 1000 },
      { files: ["config/routes.ts"] },
    );

    delete tree["config/routes.ts"];

    expect(check.updated()).toBe(true);
  });
});

describe("directories that are symlinks", () => {
  /**
   * A change is reported against the path the filesystem knows, which is the
   * real one — so a watcher holding the link would answer false for a file
   * that plainly changed.
   */
  it("watches where the link points", () => {
    const { it: check } = checker(
      { "shared/views/post.ts": NOW - 1000 },
      { dirs: { "app/views": [".ts"] } },
      { "app/views": resolve("shared/views") },
    );

    expect(check.watching("shared/views/post.ts")).toBe(true);
  });

  /** `tmp/` is created on the first boot that needs it. */
  it("keeps a directory that is not there yet", () => {
    const { it: check, tree } = checker({}, { dirs: { tmp: [".ts"] } });

    tree["tmp/cache.ts"] = NOW - 10;

    expect(check.updated()).toBe(true);
  });
});
