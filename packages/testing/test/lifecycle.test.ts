/**
 * Wrapping a test's own setup and teardown, ported from
 * `activesupport/test/test_case_test.rb`'s `before_setup` / `after_teardown`
 * cases and `activesupport/lib/active_support/testing/setup_and_teardown.rb`.
 *
 * The failures here are the ones a suite does not report: a cleanup that
 * throws and takes the rest of the cleanups with it, and a teardown that
 * unwinds in the same order it wound up.
 */

import { describe, expect, it } from "bun:test";
import { TestLifecycle } from "../src/lifecycle.js";

/** Records what ran, in the order it ran. */
function recorder(): { log: string[]; hook: (name: string) => () => void } {
  const log: string[] = [];

  return { log, hook: (name) => () => void log.push(name) };
}

describe("the order things run in", () => {
  it("puts the test's own setup between the two setup phases", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.beforeSetup(hook("before")).afterSetup(hook("after"));

    const { setup } = lifecycle.hooks({ setup: hook("own") });
    await setup();

    expect(log).toEqual(["before", "own", "after"]);
  });

  it("puts the test's own teardown between the two teardown phases", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.beforeTeardown(hook("before")).afterTeardown(hook("after"));

    const { teardown } = lifecycle.hooks({ teardown: hook("own") });
    await teardown();

    expect(log).toEqual(["before", "own", "after"]);
  });

  /**
   * A transaction opened before a stub was installed has to be rolled back
   * after the stub is gone, or the rollback runs against a replaced method.
   */
  it("unwinds in the opposite order to winding up", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.use({ setup: hook("open transaction"), teardown: hook("roll back") });
    lifecycle.use({ setup: hook("install stub"), teardown: hook("restore stub") });

    const { setup, teardown } = lifecycle.hooks();
    await setup();
    await teardown();

    expect(log).toEqual(["open transaction", "install stub", "restore stub", "roll back"]);
  });

  it("runs each phase's own hooks in registration order", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.beforeSetup(hook("first")).beforeSetup(hook("second"));
    lifecycle.beforeTeardown(hook("third")).beforeTeardown(hook("fourth"));

    const { setup, teardown } = lifecycle.hooks();
    await setup();
    await teardown();

    expect(log).toEqual(["first", "second", "fourth", "third"]);
  });

  it("needs neither a test setup nor a test teardown", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.beforeSetup(hook("before")).afterTeardown(hook("after"));

    const { setup, teardown } = lifecycle.hooks();
    await setup();
    await teardown();

    expect(log).toEqual(["before", "after"]);
  });

  it("waits for a hook that returns a promise", async () => {
    const log: string[] = [];
    const lifecycle = new TestLifecycle();

    lifecycle.beforeSetup(async () => {
      await Promise.resolve();
      log.push("slow");
    });

    const { setup } = lifecycle.hooks({ setup: () => void log.push("own") });
    await setup();

    expect(log).toEqual(["slow", "own"]);
  });
});

describe("when a hook throws", () => {
  /**
   * The hooks after a failed setup were written assuming it worked, so
   * running them produces a second, misleading failure on top of the real one.
   */
  it("stops the setup phase", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.beforeSetup(() => {
      throw new Error("no database");
    });
    lifecycle.afterSetup(hook("never"));

    const { setup } = lifecycle.hooks({ setup: hook("also never") });

    await expect(setup()).rejects.toThrow("no database");
    expect(log).toEqual([]);
  });

  /**
   * The hooks after a failed teardown are what put the globals back, and the
   * cost of skipping them is paid by a different test in a different file.
   */
  it("finishes the teardown phase anyway", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.beforeTeardown(() => {
      throw new Error("rollback failed");
    });
    lifecycle.afterTeardown(hook("unfreeze the clock"));

    const { teardown } = lifecycle.hooks({ teardown: hook("own teardown") });

    await expect(teardown()).rejects.toThrow("rollback failed");
    expect(log).toEqual(["own teardown", "unfreeze the clock"]);
  });

  /** Later failures are usually consequences; the last would name the symptom. */
  it("reports the first teardown failure, not the last", async () => {
    const lifecycle = new TestLifecycle();

    lifecycle.beforeTeardown(() => {
      throw new Error("first");
    });
    lifecycle.afterTeardown(() => {
      throw new Error("second");
    });

    const { teardown } = lifecycle.hooks();

    await expect(teardown()).rejects.toThrow("first");
  });

  it("says nothing when every teardown succeeds", async () => {
    const { hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.afterTeardown(hook("fine"));

    const { teardown } = lifecycle.hooks();

    await expect(teardown()).resolves.toBeUndefined();
  });
});

describe("registering a pair", () => {
  /** Registering the halves separately is how a suite rolls back twice. */
  it("takes both halves at once", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.use({ setup: hook("begin"), teardown: hook("rollback") });

    const { setup, teardown } = lifecycle.hooks();
    await setup();
    await teardown();

    expect(log).toEqual(["begin", "rollback"]);
  });

  /**
   * The pair goes on the outside: a transaction has to be open before the
   * test's setup inserts anything, and rolled back after its teardown.
   */
  it("brackets the test's own setup and teardown", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.use({ setup: hook("begin"), teardown: hook("rollback") });

    const { setup, teardown } = lifecycle.hooks({
      setup: hook("own setup"),
      teardown: hook("own teardown"),
    });
    await setup();
    await teardown();

    expect(log).toEqual(["begin", "own setup", "own teardown", "rollback"]);
  });

  it("takes a pair that is only one half", async () => {
    const { log, hook } = recorder();
    const lifecycle = new TestLifecycle();

    lifecycle.use({ teardown: hook("only cleanup") });
    lifecycle.use({ setup: hook("only setup") });

    const { setup, teardown } = lifecycle.hooks();
    await setup();
    await teardown();

    expect(log).toEqual(["only setup", "only cleanup"]);
  });

  it("chains, so a suite reads as one statement", () => {
    const lifecycle = new TestLifecycle();

    expect(lifecycle.use({}).beforeSetup(() => undefined)).toBe(lifecycle);
  });
});
