/**
 * What can cross an isolate boundary, ported from Rails' Ractor cases in
 * `activesupport/test/ractor_test.rb` and the fork-hook cases in
 * `activesupport/test/fork_tracker_test.rb`.
 *
 * The failure worth testing hardest is the one that is not an error: a value
 * that crosses by copy when the caller expected sharing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  afterFork,
  afterForkCallback,
  allocations,
  beforeFork,
  beforeForkCallback,
  gcTime,
  loadRactorSnapshot,
  main,
  makeShareable,
  onMain,
  parallelizeBeforeFork,
  ractorLogger,
  resetForkHooks,
  resetLocks,
  runInIsolation,
  setMainIsolate,
  shareWith,
  shareable,
  shareableLambda,
  shareableProc,
  threadSafely,
  toRactorSnapshot,
  tryMakeShareable,
  tryShareableLambda,
  tryShareableProc,
} from "../src/isolation.js";

afterEach(() => {
  resetForkHooks();
  resetLocks();
  setMainIsolate(true);
});

describe("what can cross without being copied", () => {
  it("lets primitives across", () => {
    for (const value of [1, "a", true, null, undefined]) {
      expect(shareable(value)).toBe(true);
    }
  });

  /** A function closes over a scope the other isolate does not have. */
  it("refuses a function", () => {
    expect(shareable(() => undefined)).toBe(false);
    expect(shareable(Symbol("x"))).toBe(false);
  });

  it("refuses an unfrozen object", () => {
    expect(shareable({ a: 1 })).toBe(false);
    expect(shareable(Object.freeze({ a: 1 }))).toBe(true);
  });

  /**
   * The mistake worth naming: a frozen array of mutable objects passes a
   * shallow check and still lets two isolates write to the same objects
   * through it.
   */
  it("looks all the way down", () => {
    expect(shareable(Object.freeze([{ a: 1 }]))).toBe(false);
    expect(shareable(Object.freeze([Object.freeze({ a: 1 })]))).toBe(true);
  });

  /** `set` on a frozen Map still works, which is exactly the trap. */
  it("refuses a Map or Set however frozen", () => {
    expect(shareable(Object.freeze(new Map([["a", 1]])))).toBe(false);
    expect(shareable(Object.freeze(new Set([1])))).toBe(false);
  });

  it("survives a cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    Object.freeze(cyclic);

    expect(shareable(cyclic)).toBe(true);
  });
});

describe("making a value shareable", () => {
  /**
   * Mutates rather than copying: a copy leaves the caller holding the mutable
   * original and passing the frozen one, so a later write through the original
   * is lost with no error anywhere.
   */
  it("freezes in place, all the way down", () => {
    const value = { a: { b: 1 } };

    expect(makeShareable(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
  });

  it("leaves a primitive alone", () => {
    expect(makeShareable(7)).toBe(7);
  });

  it("refuses a function, and says what to do instead", () => {
    expect(() => makeShareable(() => undefined)).toThrow("rebuild the function");
  });

  it("refuses a Map, and says what to do instead", () => {
    expect(() => makeShareable(new Map())).toThrow("plain object or array");
  });

  it("survives a cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => makeShareable(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
  });

  /** For a cache that shares what it can and copies the rest. */
  it("reports rather than raising when asked to", () => {
    expect(tryMakeShareable({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(tryMakeShareable(() => undefined).ok).toBe(false);
  });

  it("says why it could not", () => {
    const attempt = tryMakeShareable(new Map());

    expect(attempt.ok).toBe(false);
    expect(attempt.ok === false && attempt.reason).toContain("plain object");
  });
});

describe("sending a function across", () => {
  /**
   * A function crosses as source the other side compiles, so anything it needs
   * has to be an argument.
   */
  it("refuses one that closes over anything", () => {
    expect(() => shareableProc("() => x", ["x"])).toThrow("closes over x");
    expect(() => shareableLambda("() => x", ["x"])).toThrow("passed as an argument");
  });

  it("allows one that does not", () => {
    expect(shareableProc("() => 1")).toBe("() => 1");
    expect(shareableLambda("() => 1")).toBe("() => 1");
  });

  it("reports rather than raising when asked to", () => {
    expect(tryShareableProc("() => x", ["x"])).toBeUndefined();
    expect(tryShareableLambda("() => 1")).toBe("() => 1");
  });
});

describe("handing a value to another isolate", () => {
  it("passes a shareable value through", () => {
    const value = Object.freeze({ a: 1 });

    expect(shareWith("worker", value)).toEqual({ target: "worker", value });
  });

  /**
   * Copying is the failure that is not an error: the other side mutates its
   * copy, this side never sees it, and the feature quietly does nothing.
   */
  it("refuses one that would be copied", () => {
    expect(() => shareWith("worker", { a: 1 })).toThrow("quietly do nothing");
  });

  it("names the target", () => {
    expect(() => shareWith("worker", { a: 1 })).toThrow('"worker"');
  });
});

describe("the snapshot an isolate starts from", () => {
  /**
   * A snapshot rather than a live reference: an isolate reading through a
   * reference would see changes made after it started, and the point of
   * starting one is that it does not.
   */
  it("captures the configuration as it was", () => {
    const config = { locale: "en" };
    const snapshot = toRactorSnapshot(config);
    config.locale = "fr";

    expect(loadRactorSnapshot(snapshot)["locale"]).toBe("en");
  });

  /** Whatever the function decides has to be decided before the snapshot. */
  it("refuses configuration containing a function", () => {
    expect(() => toRactorSnapshot({ resolve: () => 1 })).toThrow("decided before");
  });

  /**
   * Frozen on arrival, so the isolate cannot edit configuration the parent
   * believes it shares — the two would then disagree with nothing reporting it.
   */
  it("arrives frozen", () => {
    expect(Object.isFrozen(loadRactorSnapshot('{"a":{"b":1}}'))).toBe(true);
    expect(shareable(loadRactorSnapshot('{"a":{"b":1}}'))).toBe(true);
  });
});

describe("which isolate is running", () => {
  it("is the main one by default", () => {
    expect(main()).toBe(true);
  });

  /**
   * Writing a log file, binding a port, running a migration — done in every
   * isolate each of those is a race whose loser fails with an error about the
   * resource rather than about the duplication.
   */
  it("runs a body only in the main isolate", () => {
    let ran = 0;
    const body = () => {
      ran += 1;

      return "done";
    };

    expect(onMain(body)).toBe("done");

    setMainIsolate(false);

    expect(onMain(body)).toBeUndefined();
    expect(ran).toBe(1);
  });

  /**
   * Two isolates writing interleaved lines to one destination produce a log
   * where no line is wrong and no sequence of them is right.
   */
  it("labels each isolate's log lines", () => {
    const lines: string[] = [];
    ractorLogger("worker-1", (line) => lines.push(line))("started");

    expect(lines).toEqual(["[worker-1] started"]);
  });
});

describe("running something under a lock", () => {
  it("runs the body", async () => {
    expect(await threadSafely("a", () => 7)).toBe(7);
  });

  /** Serialised: the second body does not start until the first has finished. */
  it("does not overlap two bodies with one name", async () => {
    const order: string[] = [];
    const slow = threadSafely("a", async () => {
      await Promise.resolve();
      order.push("first");
    });
    const fast = threadSafely("a", () => {
      order.push("second");
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(["first", "second"]);
  });

  /**
   * Named rather than global: one lock for everything makes unrelated critical
   * sections wait for each other, turning a correctness fix into a throughput
   * problem nobody connects back to it.
   */
  it("lets different names run independently", async () => {
    const order: string[] = [];
    await Promise.all([
      threadSafely("a", async () => {
        await Promise.resolve();
        order.push("a");
      }),
      threadSafely("b", () => {
        order.push("b");
      }),
    ]);

    expect(order).toEqual(["b", "a"]);
  });

  /**
   * One failure must not free the lock for everything queued behind it to run
   * at once.
   */
  it("keeps the chain when a body throws", async () => {
    const order: string[] = [];

    const failing = threadSafely("a", () => {
      throw new Error("boom");
    });
    const after = threadSafely("a", () => {
      order.push("after");
    });

    await expect(failing).rejects.toThrow("boom");
    await after;

    expect(order).toEqual(["after"]);
  });
});

describe("running something in isolation", () => {
  /**
   * A caller that could not tell would believe a test ran in a fresh process
   * when it ran in this one.
   */
  it("says when there was no isolation available", async () => {
    expect(await runInIsolation(() => 7)).toEqual({ result: 7, isolated: false });
  });

  it("says when there was", async () => {
    const isolate = async <T>(body: () => Promise<T> | T) => body();

    expect(await runInIsolation(() => 7, isolate)).toEqual({ result: 7, isolated: true });
  });
});

describe("fork hooks", () => {
  it("runs what was registered", async () => {
    const order: string[] = [];
    beforeFork(() => {
      order.push("before");
    });
    afterFork(() => {
      order.push("after");
    });

    await beforeForkCallback();
    await afterForkCallback();

    expect(order).toEqual(["before", "after"]);
  });

  it("registers a parallelize hook as a before-fork one", async () => {
    const order: string[] = [];
    parallelizeBeforeFork(() => {
      order.push("parallelize");
    });

    await beforeForkCallback();

    expect(order).toEqual(["parallelize"]);
  });

  /**
   * A hook that raised partway through would leave the child with some of its
   * per-process state set up and some not — a database connection but no cache
   * — and that child then does work that looks fine and is not.
   */
  it("runs every hook even when one throws", async () => {
    const order: string[] = [];
    afterFork(() => {
      throw new Error("boom");
    });
    afterFork(() => {
      order.push("second");
    });

    const failures = await afterForkCallback();

    expect(order).toEqual(["second"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe("boom");
  });

  it("reports nothing when every hook succeeded", async () => {
    afterFork(() => undefined);

    expect(await afterForkCallback()).toEqual([]);
  });
});

describe("what a body cost", () => {
  /**
   * A difference rather than a total: "did this request allocate more than the
   * last one" is answerable, "does this process hold four million objects" is
   * not.
   */
  it("reports allocations as a difference", () => {
    expect(allocations(100, 150)).toBe(50);
  });

  /** A counter that wrapped or reset must not report a negative cost. */
  it("never reports a negative", () => {
    expect(allocations(150, 100)).toBe(0);
    expect(gcTime(150, 100)).toBe(0);
  });

  it("reports collection time separately", () => {
    expect(gcTime(10, 190)).toBe(180);
  });
});
