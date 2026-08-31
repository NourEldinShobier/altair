/**
 * Running a suite across workers, ported from
 * `activesupport/test/testing/parallelization_test.rb`,
 * `activesupport/test/testing/parallelize_executor_test.rb` and the
 * per-worker database cases in `activerecord/test/cases/tasks/database_tasks_test.rb`.
 *
 * The failures worth testing are the quiet ones: two workers sharing a
 * database, and a dead worker taking its test with it. Neither reports
 * anything — one fails intermittently somewhere unrelated, the other reports
 * green having skipped something.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  MissingWorkerId,
  type WorkItem,
  WorkQueue,
  afterForkHook,
  beforeForkHook,
  cleanupHook,
  clearForkHooks,
  forkingEnv,
  parallelWorkerId,
  parallelize,
  runAfterFork,
  runBeforeFork,
  runCleanup,
  workerCount,
  workerDatabaseName,
} from "../src/parallelize.js";

const item = (file: string): WorkItem => ({ file });

afterEach(() => {
  clearForkHooks();
});

describe("a worker's own database", () => {
  it("suffixes the name with the worker id", () => {
    expect(workerDatabaseName("altair_test", 3)).toBe("altair_test-3");
  });

  /**
   * Worker 0 gets a suffix too, or a parallel run and a serial run share a
   * database and running both at once corrupts the serial one.
   */
  it("suffixes worker zero as well", () => {
    expect(workerDatabaseName("altair_test", 0)).toBe("altair_test-0");
  });

  /**
   * A default is what makes two workers share a database, and the failure that
   * produces is the least debuggable kind there is.
   */
  it("refuses a worker with no id", () => {
    expect(() => workerDatabaseName("altair_test", undefined)).toThrow(MissingWorkerId);
  });

  it("refuses a nonsense id", () => {
    expect(() => workerDatabaseName("altair_test", -1)).toThrow(MissingWorkerId);
    expect(() => workerDatabaseName("altair_test", 1.5)).toThrow(MissingWorkerId);
  });

  it("says what would have gone wrong", () => {
    expect(() => workerDatabaseName("altair_test", undefined)).toThrow("truncate each other");
  });

  it("reads the id a worker was started with", () => {
    expect(parallelWorkerId({ TEST_ENV_NUMBER: "2" })).toBe(2);
    expect(parallelWorkerId({})).toBeUndefined();
  });
});

describe("whether to fork", () => {
  /** One worker in-process gives a stack trace from the process that failed. */
  it("does not fork for a single worker", () => {
    expect(forkingEnv(1, "linux")).toBe(false);
  });

  it("forks for several", () => {
    expect(forkingEnv(4, "linux")).toBe(true);
  });

  it("does not fork where the platform has no fork", () => {
    expect(forkingEnv(4, "win32")).toBe(false);
  });

  /** A worker with nothing to do still pays the whole fork-and-boot cost. */
  it("uses no more workers than there are tests", () => {
    expect(workerCount(8, 3)).toBe(3);
  });

  it("uses the requested count when there is enough work", () => {
    expect(workerCount(4, 100)).toBe(4);
  });

  it("always uses at least one", () => {
    expect(workerCount(0, 0)).toBe(1);
  });
});

describe("fork hooks", () => {
  it("runs the parent's hooks once", async () => {
    const seen: string[] = [];
    beforeForkHook(() => {
      seen.push("before");
    });

    await runBeforeFork({ id: 0, alive: true });

    expect(seen).toEqual(["before"]);
  });

  it("gives each worker's hook its own id", async () => {
    const seen: number[] = [];
    afterForkHook((worker) => {
      seen.push(worker.id);
    });

    await runAfterFork({ id: 0, alive: true });
    await runAfterFork({ id: 1, alive: true });

    expect(seen).toEqual([0, 1]);
  });

  it("runs cleanup hooks", async () => {
    const seen: string[] = [];
    cleanupHook(() => {
      seen.push("clean");
    });

    await runCleanup({ id: 0, alive: true });

    expect(seen).toEqual(["clean"]);
  });

  it("forgets them when cleared", async () => {
    const seen: string[] = [];
    beforeForkHook(() => {
      seen.push("x");
    });
    clearForkHooks();

    await runBeforeFork({ id: 0, alive: true });

    expect(seen).toEqual([]);
  });
});

describe("the queue", () => {
  it("hands work out", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.startWorker(0);

    expect(queue.workFromQueue(0)).toEqual(item("a"));
  });

  it("runs out", () => {
    const queue = new WorkQueue();
    queue.startWorker(0);

    expect(queue.workFromQueue(0)).toBeUndefined();
  });

  /**
   * Pulled, not dealt out: dealing assumes the tests take the same time and
   * the run lasts as long as whichever worker got the slow ones.
   */
  it("lets a fast worker take more", () => {
    const queue = new WorkQueue();
    for (const file of ["a", "b", "c"]) queue.addTest(item(file));
    queue.startWorker(0);
    queue.startWorker(1);

    queue.workFromQueue(0);
    queue.finish(0, "pass");
    queue.workFromQueue(0);
    queue.finish(0, "pass");

    expect(queue.workFromQueue(1)).toEqual(item("c"));
  });

  it("gives nothing to a worker that is gone", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.startWorker(0);
    queue.stopWorker(0);

    expect(queue.workFromQueue(0)).toBeUndefined();
  });

  it("gives nothing to a worker it never started", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));

    expect(queue.workFromQueue(7)).toBeUndefined();
  });

  it("counts what it has done", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.startWorker(0);
    queue.workFromQueue(0);
    queue.finish(0, "fail");

    expect(queue.stats()).toMatchObject({ queued: 0, completed: 1, failed: 1 });
  });

  it("reports each step", () => {
    const queue = new WorkQueue();
    const seen: string[] = [];
    queue.onStep((each, outcome, workerId) => seen.push(`${each.file}:${outcome}:${workerId}`));
    queue.addTest(item("a"));
    queue.startWorker(0);
    queue.workFromQueue(0);
    queue.finish(0, "pass");

    expect(seen).toEqual(["a:pass:0"]);
  });

  it("lists live workers", () => {
    const queue = new WorkQueue();
    queue.startWorker(0);
    queue.startWorker(1);
    queue.stopWorker(1);

    expect(queue.activeWorkers().map((each) => each.id)).toEqual([0]);
  });

  it("is not done before it starts", () => {
    expect(new WorkQueue().doneRunning()).toBe(false);
  });

  it("is done when the queue empties and nothing is in flight", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.startRunning();
    queue.startWorker(0);
    queue.workFromQueue(0);

    expect(queue.doneRunning()).toBe(false);

    queue.finish(0, "pass");

    expect(queue.doneRunning()).toBe(true);
  });
});

describe("a worker that dies", () => {
  /**
   * A suite reporting green having silently skipped a test is worse than one
   * that fails, so whatever it was running goes back on the queue.
   */
  it("puts its test back", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.startWorker(0);
    queue.startWorker(1);
    queue.workFromQueue(0);

    expect(queue.stopWorker(0)).toEqual(item("a"));
    expect(queue.workFromQueue(1)).toEqual(item("a"));
  });

  /** At the front, so the test that killed a worker is retried promptly. */
  it("puts it back at the front", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.addTest(item("b"));
    queue.startWorker(0);
    queue.startWorker(1);
    queue.workFromQueue(0);
    queue.stopWorker(0);

    expect(queue.workFromQueue(1)).toEqual(item("a"));
  });

  it("returns nothing for a worker that was idle", () => {
    const queue = new WorkQueue();
    queue.startWorker(0);

    expect(queue.stopWorker(0)).toBeUndefined();
  });

  it("reaps several at once", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.addTest(item("b"));
    queue.startWorker(0);
    queue.startWorker(1);
    queue.workFromQueue(0);
    queue.workFromQueue(1);

    expect(queue.removeDeadWorkers([0, 1])).toHaveLength(2);
  });

  it("stops every worker on shutdown", () => {
    const queue = new WorkQueue();
    queue.startWorker(0);
    queue.startWorker(1);

    queue.shutdown();

    expect(queue.activeWorkers()).toEqual([]);
  });
});

describe("failing fast", () => {
  it("is not failing before anything fails", () => {
    const queue = new WorkQueue({ failFast: true });

    expect(queue.failingFast()).toBe(false);
  });

  it("stops handing work out after a failure", () => {
    const queue = new WorkQueue({ failFast: true });
    queue.addTest(item("a"));
    queue.addTest(item("b"));
    queue.startWorker(0);
    queue.workFromQueue(0);
    queue.finish(0, "fail");

    expect(queue.failingFast()).toBe(true);
    expect(queue.workFromQueue(0)).toBeUndefined();
  });

  it("keeps going when not asked to fail fast", () => {
    const queue = new WorkQueue();
    queue.addTest(item("a"));
    queue.addTest(item("b"));
    queue.startWorker(0);
    queue.workFromQueue(0);
    queue.finish(0, "fail");

    expect(queue.workFromQueue(0)).toEqual(item("b"));
  });
});

describe("running a whole suite", () => {
  it("runs every test", async () => {
    const ran: string[] = [];

    const stats = await parallelize([item("a"), item("b"), item("c")], {
      workers: 2,
      run: async (each) => {
        ran.push(each.file);

        return "pass";
      },
    });

    expect(ran.sort()).toEqual(["a", "b", "c"]);
    expect(stats).toMatchObject({ completed: 3, failed: 0, queued: 0 });
  });

  it("counts failures", async () => {
    const stats = await parallelize([item("a"), item("b")], {
      workers: 2,
      run: async (each) => (each.file === "a" ? "fail" : "pass"),
    });

    expect(stats.failed).toBe(1);
  });

  /** One crash must not hide every test after it. */
  it("treats a thrown test as a failure and keeps going", async () => {
    const ran: string[] = [];

    const stats = await parallelize([item("a"), item("b")], {
      workers: 1,
      run: async (each) => {
        ran.push(each.file);

        if (each.file === "a") throw new Error("boom");

        return "pass";
      },
    });

    expect(ran).toEqual(["a", "b"]);
    expect(stats.failed).toBe(1);
  });

  it("runs the hooks in Rails' order", async () => {
    const seen: string[] = [];
    beforeForkHook(() => {
      seen.push("before");
    });
    afterForkHook((worker) => {
      seen.push(`after:${worker.id}`);
    });
    cleanupHook((worker) => {
      seen.push(`clean:${worker.id}`);
    });

    await parallelize([item("a")], { workers: 1, run: async () => "pass" });

    expect(seen).toEqual(["before", "after:0", "clean:0"]);
  });

  /**
   * In a `finally`: a worker that dies still has to release its database and
   * its connection, or the next run trips on both.
   */
  it("cleans up even when every test throws", async () => {
    const seen: string[] = [];
    cleanupHook(() => {
      seen.push("clean");
    });

    await parallelize([item("a")], {
      workers: 1,
      run: async () => {
        throw new Error("boom");
      },
    });

    expect(seen).toEqual(["clean"]);
  });

  /**
   * The worker that failed to set itself up is exactly the one that leaks a
   * database and a connection, so the hook runs inside the block cleanup
   * guards rather than before it.
   */
  it("cleans up when a worker fails to start", async () => {
    const seen: string[] = [];
    afterForkHook(() => {
      throw new Error("no database for worker");
    });
    cleanupHook(() => {
      seen.push("clean");
    });

    await expect(parallelize([item("a")], { workers: 1, run: async () => "pass" })).rejects.toThrow(
      "no database for worker",
    );
    expect(seen).toEqual(["clean"]);
  });

  it("stops early when told to fail fast", async () => {
    const ran: string[] = [];

    await parallelize([item("a"), item("b"), item("c")], {
      workers: 1,
      failFast: true,
      run: async (each) => {
        ran.push(each.file);

        return "fail";
      },
    });

    expect(ran).toEqual(["a"]);
  });

  it("runs nothing for an empty suite", async () => {
    expect(await parallelize([], { workers: 4, run: async () => "pass" })).toMatchObject({
      completed: 0,
    });
  });
});
