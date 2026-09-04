/**
 * Queries started now and collected later, ported from
 * `activerecord/test/cases/relation/load_async_test.rb` and
 * `future_result_test.rb`.
 *
 * Three independent 40ms queries awaited in sequence are 120ms of a request
 * spent doing nothing. Started together they are 40. The tests that matter
 * here are the two that a bare promise does not give you: cancelling one that
 * is no longer wanted, and not crashing the process when one nobody collected
 * rejects.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  AsynchronousQueriesSession,
  AsynchronousQueriesTracker,
  Canceled,
  FutureResult,
  asyncEnabled,
  asynchronousQueriesSession,
  asynchronousQueriesTracker,
  finalizeSession,
  setAsyncEnabled,
} from "../src/future-result.js";

afterEach(async () => {
  setAsyncEnabled(true);
  await finalizeSession();
});

/** A query that takes a moment, so "started" and "finished" are distinguishable. */
function slow<T>(value: T, ms = 10): () => Promise<T> {
  return () =>
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(value), ms);
    });
}

function failing(message: string, ms = 10): () => Promise<never> {
  return () =>
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
}

describe("a future on its own", () => {
  it("gives back what the query returned", async () => {
    expect(await new FutureResult(slow("rows")).result()).toBe("rows");
  });

  /** The whole point: a future that waits to be awaited has saved nothing. */
  it("starts the query on construction rather than on await", async () => {
    let started = false;
    const future = new FutureResult(async () => {
      started = true;

      return 1;
    });

    expect(started).toBe(true);
    await future.result();
  });

  it("is pending until it is not", async () => {
    const future = new FutureResult(slow(1));

    expect(future.pending()).toBe(true);
    expect(future.done()).toBe(false);

    await future.result();

    expect(future.pending()).toBe(false);
    expect(future.done()).toBe(true);
    expect(future.fullyCompleted()).toBe(true);
  });

  it("can be given a value that is already known", async () => {
    const future = FutureResult.wrap("known");

    expect(await future.result()).toBe("known");
  });

  it("hands the result to a block", async () => {
    expect(await new FutureResult(slow(2)).andThen((value) => value * 21)).toBe(42);
  });

  /**
   * Not a thenable, deliberately. A class with a `then` method gets called
   * with `(resolve, reject)` by `await`, so naming the mapping method `then`
   * would make `await future` silently do something else.
   */
  it("is not accidentally awaitable as a promise", () => {
    expect((new FutureResult(slow(1)) as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("offers the value without waiting once it is there", async () => {
    const future = new FutureResult(slow("rows"));

    expect(future.ensureResult()).toBeUndefined();

    await future.result();

    expect(future.ensureResult()).toBe("rows");
  });

  /** The saving is real: started together, two 30ms queries take about 30ms. */
  it("runs several at once rather than in sequence", async () => {
    const started = Date.now();

    const first = new FutureResult(slow("a", 30));
    const second = new FutureResult(slow("b", 30));

    expect([await first.result(), await second.result()]).toEqual(["a", "b"]);
    expect(Date.now() - started).toBeLessThan(55);
  });
});

describe("failures", () => {
  it("raises what the query raised, to whoever asks", async () => {
    const future = new FutureResult(failing("query blew up"));

    await expect(future.result()).rejects.toThrow("query blew up");
  });

  it("reports that it failed rather than completed", async () => {
    const future = new FutureResult(failing("boom"));

    await future.settled();

    expect(future.status).toBe("failed");
    expect(future.done()).toBe(true);
    expect(future.fullyCompleted()).toBe(false);
  });

  /**
   * A query started and never collected rejects into nothing, and an unhandled
   * rejection takes the process down. The rejection is captured when it
   * happens and only re-raised to a caller that asks.
   */
  it("does not reject into nothing when nobody collects it", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);

    new FutureResult(failing("nobody is waiting"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    process.off("unhandledRejection", onRejection);

    expect(rejections).toEqual([]);
  });

  it("gives nothing from ensureResult when it failed", async () => {
    const future = new FutureResult(failing("boom"));
    await future.settled();

    expect(future.ensureResult()).toBeUndefined();
  });
});

describe("cancelling", () => {
  /**
   * A controller that returns early on the first of three queries has two
   * still running against a connection each — without this the fast path costs
   * more than the slow one.
   */
  it("abandons one that is no longer wanted", async () => {
    const future = new FutureResult(slow("rows"));

    future.cancel();

    expect(future.canceled()).toBe(true);
    await expect(future.result()).rejects.toThrow(Canceled);
  });

  it("says why", async () => {
    const future = new FutureResult(slow(1));
    future.cancel();

    await expect(future.result()).rejects.toThrow("canceled");
  });

  /** Both true would be a contradiction a caller has to guess its way out of. */
  it("does not become complete after it was cancelled", async () => {
    const future = new FutureResult(slow("rows"));
    future.cancel();

    await future.settled();

    expect(future.canceled()).toBe(true);
    expect(future.fullyCompleted()).toBe(false);
    expect(future.ensureResult()).toBeUndefined();
  });

  it("swallows the error of one that was cancelled", async () => {
    const future = new FutureResult(failing("boom"));
    future.cancel();

    await future.settled();

    expect(future.status).toBe("canceled");
  });

  it("does nothing when it has already finished", async () => {
    const future = new FutureResult(slow("rows", 1));
    await future.result();

    future.cancel();

    expect(future.fullyCompleted()).toBe(true);
    expect(await future.result()).toBe("rows");
  });

  it("can be cancelled twice", async () => {
    const future = new FutureResult(slow(1));

    future.cancel();
    future.cancel();

    expect(future.canceled()).toBe(true);
  });
});

describe("a session", () => {
  it("tracks what was started in it", () => {
    const session = new AsynchronousQueriesSession();
    session.track(new FutureResult(slow(1)));
    session.track(new FutureResult(slow(2)));

    expect(session.size).toBe(2);
    expect(session.pending()).toHaveLength(2);
  });

  /**
   * A future outliving its request holds a connection nobody is waiting for.
   */
  it("cancels what is still running when it ends", async () => {
    const session = new AsynchronousQueriesSession();
    const future = session.track(new FutureResult(slow("rows")));

    await session.finalize();

    expect(future.canceled()).toBe(true);
    expect(session.active).toBe(false);
  });

  it("waits instead when told to", async () => {
    const session = new AsynchronousQueriesSession();
    const future = session.track(new FutureResult(slow("rows", 5)));

    await session.finalize(true);

    expect(future.canceled()).toBe(false);
    expect(await future.result()).toBe("rows");
  });

  it("waits through a failure without raising", async () => {
    const session = new AsynchronousQueriesSession();
    session.track(new FutureResult(failing("boom", 5)));

    await expect(session.finalize(true)).resolves.toBeUndefined();
  });

  it("leaves an already-finished one alone", async () => {
    const session = new AsynchronousQueriesSession();
    const future = session.track(new FutureResult(slow("rows", 1)));
    await future.result();

    await session.finalize();

    expect(future.fullyCompleted()).toBe(true);
  });
});

describe("the tracker", () => {
  it("has no session until one is started", () => {
    const tracker = new AsynchronousQueriesTracker();

    expect(tracker.currentSession()).toBeUndefined();
    expect(tracker.finalized).toBe(true);
  });

  it("starts one", () => {
    const tracker = new AsynchronousQueriesTracker();
    const session = tracker.startSession();

    expect(tracker.currentSession()).toBe(session);
    expect(tracker.finalized).toBe(false);
  });

  it("tracks a query started while one is open", () => {
    const tracker = new AsynchronousQueriesTracker();
    const session = tracker.startSession();

    tracker.executeOrSkip(slow(1));

    expect(session.size).toBe(1);
  });

  /** A future with no session has no boundary — started by a request, cancelled by nobody. */
  it("does not track one started with no session open", async () => {
    const tracker = new AsynchronousQueriesTracker();

    const future = tracker.executeOrSkip(slow("rows"));

    expect(await future.result()).toBe("rows");
    expect(tracker.currentSession()).toBeUndefined();
  });

  it("still runs the query when async is off", async () => {
    const tracker = new AsynchronousQueriesTracker();
    tracker.setAsyncEnabled(false);
    tracker.startSession();

    const future = tracker.executeOrSkip(slow("rows"));

    expect(await future.result()).toBe("rows");
  });

  it("does not track it when async is off", () => {
    const tracker = new AsynchronousQueriesTracker();
    tracker.setAsyncEnabled(false);
    const session = tracker.startSession();

    tracker.executeOrSkip(slow(1));

    expect(session.size).toBe(0);
  });

  it("says whether it is on", () => {
    const tracker = new AsynchronousQueriesTracker();

    expect(tracker.asyncEnabled()).toBe(true);

    tracker.setAsyncEnabled(false);

    expect(tracker.asyncEnabled()).toBe(false);
  });

  it("finalizes and forgets the session", async () => {
    const tracker = new AsynchronousQueriesTracker();
    tracker.startSession();

    await tracker.finalizeSession();

    expect(tracker.currentSession()).toBeUndefined();
    expect(tracker.finalized).toBe(true);
  });

  it("survives being finalized with nothing open", async () => {
    await expect(new AsynchronousQueriesTracker().finalizeSession()).resolves.toBeUndefined();
  });
});

describe("wrapping a unit of work", () => {
  it("opens a session for the body", async () => {
    const tracker = new AsynchronousQueriesTracker();

    const seen = await tracker.withSession(async () => tracker.currentSession() !== undefined);

    expect(seen).toBe(true);
  });

  it("closes it afterwards", async () => {
    const tracker = new AsynchronousQueriesTracker();

    await tracker.withSession(async () => undefined);

    expect(tracker.finalized).toBe(true);
  });

  /** An early return or an exception is exactly when futures are left behind. */
  it("closes it even when the body throws", async () => {
    const tracker = new AsynchronousQueriesTracker();
    let future: FutureResult<string> | undefined;

    await expect(
      tracker.withSession(async () => {
        future = tracker.executeOrSkip(slow("rows"));
        throw new Error("early out");
      }),
    ).rejects.toThrow("early out");

    expect(tracker.finalized).toBe(true);
    expect(future?.canceled()).toBe(true);
  });

  it("gives back what the body returned", async () => {
    const tracker = new AsynchronousQueriesTracker();

    expect(await tracker.withSession(async () => "done")).toBe("done");
  });
});

describe("the process-wide tracker", () => {
  it("is there", () => {
    expect(asynchronousQueriesTracker()).toBeInstanceOf(AsynchronousQueriesTracker);
  });

  it("reports the current session", () => {
    expect(asynchronousQueriesSession()).toBeUndefined();

    const session = asynchronousQueriesTracker().startSession();

    expect(asynchronousQueriesSession()).toBe(session);
  });

  it("reports whether async is on", () => {
    expect(asyncEnabled()).toBe(true);

    setAsyncEnabled(false);

    expect(asyncEnabled()).toBe(false);
  });
});
