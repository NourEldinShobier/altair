/**
 * Finding a class by its name, ported from
 * `activesupport/test/autoloading_fixtures`-driven cases in
 * `activesupport/test/dependencies_test.rb` and the registration cases in
 * `activesupport/test/autoload_test.rb`.
 *
 * The cases worth having are about reloading, because that is where the
 * failures are invisible: a stale constant is a class that exists and answers
 * to the right name with the wrong body.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { NameError } from "../src/class_attributes.js";
import { inflections } from "../src/inflections.js";
import {
  absolutePath,
  autoload,
  autoloadAt,
  autoloadUnder,
  clearContext,
  constMissing,
  constantForPath,
  currentlyUnloading,
  deprecateConstant,
  determineConstantFromTestName,
  directoriesToWatch,
  doneUnloading,
  eagerAutoload,
  eagerLoadEntries,
  expand,
  isMissing,
  loadClass,
  loggerOutputsTo,
  newAutoloadRegistry,
  releaseUnloadLock,
  requireDependency,
  requireUnloadLock,
  resetPrepareHooks,
  runPrepareHooks,
  searchForFile,
  startUnloading,
  toPrepare,
  watchedDirsWithExtensions,
} from "../src/autoloading.js";

afterEach(() => {
  resetPrepareHooks();
  doneUnloading();
});

describe("a name and its file", () => {
  /** Nesting becomes directories, so a namespace can be moved by moving one. */
  it("turns a namespace into directories", () => {
    expect(searchForFile("Admin::PostsController")).toBe("admin/posts_controller");
    expect(searchForFile("Post")).toBe("post");
  });

  /**
   * The round trip has to be exact, or a name resolves to a file defining a
   * different constant — and the error names the constant rather than the
   * file, so nothing points at the mismatch.
   */
  it("inverts exactly", () => {
    for (const name of ["Post", "Admin::PostsController", "Api::V1::Base"]) {
      expect(constantForPath(searchForFile(name))).toBe(name);
    }
  });

  /**
   * The exception, and the reason `inflections().acronym` exists: `API`
   * underscores to `api` and reconstructs as `Api`, so an application with an
   * acronym in a namespace has to declare it or the constant it defines and
   * the one being looked for differ by two letters.
   */
  it("needs an acronym declared to round-trip one", () => {
    const held = { ...inflections().acronyms };

    try {
      expect(constantForPath(searchForFile("API::Base"))).toBe("Api::Base");

      inflections("en", (each) => each.acronym("API"));

      expect(constantForPath(searchForFile("API::Base"))).toBe("API::Base");
    } finally {
      // Restored: the inflector is global, and an acronym left registered
      // changes how every later test in this process camelizes.
      inflections().acronyms = held;
    }
  });

  it("ignores an extension", () => {
    expect(constantForPath("admin/posts_controller.ts")).toBe("Admin::PostsController");
  });

  it("expands a relative entry against the root", () => {
    expect(expand("/app", "models")).toBe("/app/models");
    expect(expand("/app/", "./models")).toBe("/app/models");
    expect(expand("/app", "/elsewhere")).toBe("/elsewhere");
  });

  /**
   * A relative entry resolves against where the process was started rather
   * than where the application lives, so it works from the app directory and
   * fails from anywhere else — including most process managers.
   */
  it("tells an absolute path from a relative one", () => {
    expect(absolutePath("/app/models")).toBe(true);
    expect(absolutePath("C:/app/models")).toBe(true);
    expect(absolutePath("app/models")).toBe(false);
    expect(absolutePath("./app")).toBe(false);
  });
});

describe("registering a constant", () => {
  /** Registration, not loading — the file is read the first time it is named. */
  it("records where to look without looking", () => {
    const registry = autoload(newAutoloadRegistry(), "Post");

    expect(registry.entries.get("Post")?.path).toBe("post");
  });

  it("takes an explicit path", () => {
    const registry = autoload(newAutoloadRegistry(), "Post", "models/post");

    expect(registry.entries.get("Post")?.path).toBe("models/post");
  });

  /** Repeating the directory on every line is how one ends up spelled differently. */
  it("prefixes what a block declares", () => {
    const registry = autoloadUnder(newAutoloadRegistry(), "middleware", (each) => {
      autoload(each, "Static");
    });

    expect(registry.entries.get("Static")?.path).toBe("middleware/static");
  });

  it("stops prefixing after the block", () => {
    const registry = autoloadUnder(newAutoloadRegistry(), "middleware", (each) => {
      autoload(each, "Static");
    });

    autoload(registry, "Post");

    expect(registry.entries.get("Post")?.path).toBe("post");
  });

  /** A throwing block must not leave every later declaration prefixed. */
  it("stops prefixing when the block throws", () => {
    const registry = newAutoloadRegistry();

    expect(() =>
      autoloadUnder(registry, "middleware", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    autoload(registry, "Post");

    expect(registry.entries.get("Post")?.path).toBe("post");
  });

  /** Restored rather than cleared, so an inner block does not flatten the outer. */
  it("nests", () => {
    const registry = autoloadUnder(newAutoloadRegistry(), "middleware", (outer) => {
      autoloadUnder(outer, "middleware/stack", (inner) => {
        autoload(inner, "Static");
      });

      autoload(outer, "Runner");
    });

    expect(registry.entries.get("Static")?.path).toBe("middleware/stack/static");
    expect(registry.entries.get("Runner")?.path).toBe("middleware/runner");
  });

  it("points several constants at one file", () => {
    const registry = autoloadAt(newAutoloadRegistry(), "errors", (each) => {
      autoload(each, "NotFound");
      autoload(each, "Forbidden");
    });

    expect(registry.entries.get("NotFound")?.path).toBe("errors");
    expect(registry.entries.get("Forbidden")?.path).toBe("errors");
  });

  it("stops pointing at one file when the block throws", () => {
    const registry = newAutoloadRegistry();

    expect(() =>
      autoloadAt(registry, "errors", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    autoload(registry, "Post");

    expect(registry.entries.get("Post")?.path).toBe("post");
  });

  /**
   * Eager loading is what turns constant resolution from something happening
   * under concurrency forever into something that happened once at boot.
   */
  it("marks only what a block declared", () => {
    const registry = newAutoloadRegistry();
    autoload(registry, "Lazy");
    eagerAutoload(registry, (each) => {
      autoload(each, "Eager");
    });

    expect(eagerLoadEntries(registry).map((entry) => entry.constantName)).toEqual(["Eager"]);
  });

  it("marks nothing when nothing is declared eagerly", () => {
    const registry = autoload(newAutoloadRegistry(), "Lazy");

    expect(eagerLoadEntries(registry)).toEqual([]);
  });
});

describe("resolving a name that is not loaded", () => {
  it("loads the registered file", () => {
    const registry = autoload(newAutoloadRegistry(), "Post", "models/post");
    const read: string[] = [];

    const found = constMissing(registry, "Post", (path) => {
      read.push(path);

      return "the class";
    });

    expect(found).toBe("the class");
    expect(read).toEqual(["models/post"]);
  });

  it("falls back to the convention for an unregistered name", () => {
    const read: string[] = [];

    loadClass(newAutoloadRegistry(), "Admin::Post", (path) => {
      read.push(path);

      return "x";
    });

    expect(read).toEqual(["admin/post"]);
  });

  /**
   * From the constant alone the two usual causes are indistinguishable: the
   * file is missing, or it exists and defines something spelled differently.
   */
  it("says the file was expected to define it", () => {
    expect(() => constMissing(newAutoloadRegistry(), "Post", () => undefined)).toThrow(
      "Expected post to define",
    );
  });

  it("says when nothing declared it either", () => {
    expect(() => constMissing(newAutoloadRegistry(), "Post", () => undefined)).toThrow(
      "nothing declared it",
    );
  });

  it("says when the file loaded without defining it", () => {
    const registry = autoload(newAutoloadRegistry(), "Post", "models/post");

    expect(() => constMissing(registry, "Post", () => undefined)).toThrow("without defining it");
  });

  /**
   * One error type for both ways of resolving a name, so a rescue around a
   * lookup does not have to know which was used.
   */
  it("raises the same error a registry lookup does", () => {
    expect(() => constMissing(newAutoloadRegistry(), "Post", () => undefined)).toThrow(NameError);
  });

  /**
   * Exact rather than a substring: `Post` is a substring of `PostsController`,
   * and a loose match swallows an error about a different constant and retries
   * a load that fails the same way.
   */
  it("matches the constant exactly", () => {
    const error = new NameError("PostsController", []);

    expect(isMissing(error, "PostsController")).toBe(true);
    expect(isMissing(error, "Post")).toBe(false);
    expect(isMissing(new Error("nope"), "Post")).toBe(false);
  });
});

describe("finding the class a test is about", () => {
  const known = new Map<string, unknown>([["Admin::PostsController", "found"]]);
  const resolve = (name: string) => known.get(name);

  it("drops the Test suffix", () => {
    expect(determineConstantFromTestName("Admin::PostsControllerTest", resolve)).toBe("found");
  });

  /** One segment at a time, so a nested test does not give up at the namespace. */
  it("drops trailing segments until something answers", () => {
    expect(determineConstantFromTestName("Admin::PostsController::EdgeCasesTest", resolve)).toBe(
      "found",
    );
  });

  it("finds nothing when nothing answers", () => {
    expect(determineConstantFromTestName("NowhereTest", resolve)).toBeUndefined();
  });
});

describe("reloading", () => {
  /**
   * A request running through a half-unloaded set of constants sees a class
   * that exists with none of its methods — a NoMethodError on a method the
   * file plainly defines.
   */
  it("takes the interlock alone", async () => {
    expect(await requireUnloadLock()).toBe(true);

    releaseUnloadLock();
  });

  it("tracks whether it is mid-unload", () => {
    expect(currentlyUnloading()).toBe(false);

    startUnloading();

    expect(currentlyUnloading()).toBe(true);

    doneUnloading();

    expect(currentlyUnloading()).toBe(false);
  });

  /**
   * Everything, not the changed files only: a file whose constants reference
   * another's is stale as soon as that other one changes, and tracking which
   * is the dependency graph Rails deliberately stopped maintaining.
   */
  it("forgets everything that was loaded", () => {
    const loaded = new Set(["a", "b"]);

    expect(clearContext(loaded)).toBe(2);
    expect(loaded.size).toBe(0);
  });

  /**
   * Distinct from a plain require, which is remembered permanently: a reload
   * that unloaded the constants but left the file marked as required would not
   * read it again, so the class would simply be gone.
   */
  it("tracks a required file so a reload reads it again", () => {
    const loaded = new Set<string>();

    expect(requireDependency(loaded, "models/post", () => "x")).toBe("x");
    expect(loaded.has("models/post")).toBe(true);
  });

  /**
   * A reference captured at boot points at the class from before the reload,
   * and the two are different objects answering to the same name.
   */
  it("runs the prepare hooks", () => {
    let ran = 0;
    toPrepare(() => {
      ran += 1;
    });

    expect(runPrepareHooks()).toBe(1);
    expect(ran).toBe(1);

    runPrepareHooks();

    expect(ran).toBe(2);
  });
});

describe("what to watch", () => {
  /**
   * A directory watched twice reports every change twice, and a reloader that
   * reloads twice per edit doubles the slowest part of development.
   */
  it("drops a directory nested inside another", () => {
    expect(directoriesToWatch(["/app", "/app/models", "/lib"])).toEqual(["/app", "/lib"]);
  });

  it("drops a duplicate", () => {
    expect(directoriesToWatch(["/app", "/app/", "/app"])).toEqual(["/app"]);
  });

  it("keeps a directory that merely shares a prefix", () => {
    expect(directoriesToWatch(["/app", "/application"])).toEqual(["/app", "/application"]);
  });

  /**
   * Per directory rather than globally: a template edit should not unload
   * every class in the application.
   */
  it("names extensions per directory", () => {
    expect(watchedDirsWithExtensions(["/app"], ["erb"])).toEqual({ "/app": ["erb"] });
  });

  it("defaults to source extensions", () => {
    expect(watchedDirsWithExtensions(["/app"])["/app"]).toEqual(["ts", "tsx"]);
  });
});

describe("deprecating a constant", () => {
  /**
   * A constant is referenced from application code the framework cannot see,
   * so removing one turns an upgrade into a NameError at the first request
   * that touches it.
   */
  it("keeps answering and says so", () => {
    const registry = new Map<string, unknown>([["NewName", "value"]]);
    const said: string[] = [];

    expect(deprecateConstant(registry, "OldName", "NewName", (message) => said.push(message))).toBe(
      "value",
    );
    expect(said[0]).toContain("OldName");
    expect(said[0]).toContain("NewName");
  });
});

describe("whether a logger already writes somewhere", () => {
  /** Two loggers on one stream duplicates every line. */
  it("says so", () => {
    const stream = {};

    expect(loggerOutputsTo({ destination: stream }, stream)).toBe(true);
    expect(loggerOutputsTo({ destination: {} }, stream)).toBe(false);
    expect(loggerOutputsTo(undefined, stream)).toBe(false);
  });
});
