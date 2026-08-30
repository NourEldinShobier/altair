/**
 * Running one thing at a time, and asking a value what it can be treated as.
 * Ported from the `synchronize` cases Rails exercises through its connection
 * pool tests, and `activesupport/test/core_ext/object/acts_like_test.rb`.
 *
 * JavaScript has no mutex because it has no threads, and that reasoning is
 * exactly half right: every `await` is a place another task can run, so any
 * invariant spanning one is protected by nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Mutex, computeOnce, forgetOnce, resetOnce, synchronize } from "../src/mutex.js";
import {
  actsLike,
  actsLikeDate,
  actsLikeString,
  actsLikeTime,
  declareActsLike,
} from "../src/acts_like.js";

afterEach(() => {
  resetOnce();
});

/** Resolves after the event loop has turned, so interleaving is possible. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Mutex", () => {
  it("runs a block and gives back its value", async () => {
    expect(await new Mutex().synchronize(() => 42)).toBe(42);
  });

  /** The shape the whole file exists for. */
  it("does not let two blocks interleave", async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const one = mutex.synchronize(async () => {
      order.push("one in");
      await tick();
      order.push("one out");
    });

    const two = mutex.synchronize(async () => {
      order.push("two in");
      await tick();
      order.push("two out");
    });

    await Promise.all([one, two]);

    expect(order).toEqual(["one in", "one out", "two in", "two out"]);
  });

  it("lets them interleave without one", async () => {
    const order: string[] = [];

    const body = async (name: string) => {
      order.push(`${name} in`);
      await tick();
      order.push(`${name} out`);
    };

    await Promise.all([body("one"), body("two")]);

    expect(order).toEqual(["one in", "two in", "one out", "two out"]);
  });

  /**
   * A block that throws while holding it would otherwise leave every later
   * caller waiting for ever — and requests that hang rather than fail point
   * nowhere near the code that threw.
   */
  it("releases the lock when a block throws", async () => {
    const mutex = new Mutex();

    await mutex
      .synchronize(() => {
        throw new Error("boom");
      })
      .catch(() => undefined);

    expect(await mutex.synchronize(() => "after")).toBe("after");
  });

  it("lets the error through", async () => {
    expect(
      new Mutex().synchronize(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("says whether it is held", async () => {
    const mutex = new Mutex();

    expect(mutex.locked).toBe(false);

    const held = mutex.synchronize(async () => {
      expect(mutex.locked).toBe(true);
      await tick();
    });

    await held;

    expect(mutex.locked).toBe(false);
  });

  it("counts who is waiting", async () => {
    const mutex = new Mutex();

    const first = mutex.synchronize(async () => tick());
    const second = mutex.synchronize(() => undefined);

    await tick();

    expect(mutex.waiting).toBeGreaterThanOrEqual(0);

    await Promise.all([first, second]);

    expect(mutex.waiting).toBe(0);
  });

  /**
   * Unlocking and re-racing would let a caller arriving at that moment jump
   * the queue, which turns a fair lock into one where a busy caller can starve
   * a patient one.
   */
  it("hands the lock to waiters in the order they arrived", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const first = mutex.synchronize(async () => {
      await tick();
    });

    const rest = [1, 2, 3].map((n) =>
      mutex.synchronize(() => {
        order.push(n);
      }),
    );

    await Promise.all([first, ...rest]);

    expect(order).toEqual([1, 2, 3]);
  });
});

describe("synchronize by name", () => {
  it("serialises callers sharing a name", async () => {
    const order: string[] = [];

    await Promise.all([
      synchronize("shared", async () => {
        order.push("one in");
        await tick();
        order.push("one out");
      }),
      synchronize("shared", async () => {
        order.push("two in");
        await tick();
        order.push("two out");
      }),
    ]);

    expect(order).toEqual(["one in", "one out", "two in", "two out"]);
  });

  /** Two unrelated things must not be serialised for having both wanted a lock. */
  it("does not serialise callers with different names", async () => {
    const order: string[] = [];

    await Promise.all([
      synchronize("a", async () => {
        order.push("a in");
        await tick();
        order.push("a out");
      }),
      synchronize("b", async () => {
        order.push("b in");
        await tick();
        order.push("b out");
      }),
    ]);

    expect(order).toEqual(["a in", "b in", "a out", "b out"]);
  });
});

describe("computeOnce", () => {
  /** Two callers both seeing nothing, both fetching, one throwing the other away. */
  it("runs the body once however many callers arrive together", async () => {
    let runs = 0;

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        computeOnce("token", async () => {
          runs += 1;
          await tick();

          return "abc";
        }),
      ),
    );

    expect(runs).toBe(1);
    expect(results).toEqual(["abc", "abc", "abc"]);
  });

  it("gives the remembered value to a later caller", async () => {
    await computeOnce("token", async () => "first");

    expect(await computeOnce("token", async () => "second")).toBe("first");
  });

  /**
   * A token fetch that failed once should be retried rather than turned into a
   * permanent error.
   */
  it("does not remember a failure", async () => {
    await computeOnce("token", () => Promise.reject(new Error("upstream down"))).catch(
      () => undefined,
    );

    expect(await computeOnce("token", async () => "worked")).toBe("worked");
  });

  it("keeps different names apart", async () => {
    expect(await computeOnce("a", async () => "one")).toBe("one");
    expect(await computeOnce("b", async () => "two")).toBe("two");
  });

  it("forgets one when told", async () => {
    await computeOnce("token", async () => "first");

    forgetOnce("token");

    expect(await computeOnce("token", async () => "second")).toBe("second");
  });

  it("remembers a falsy value rather than recomputing it", async () => {
    let runs = 0;

    const body = async () => {
      runs += 1;

      return null;
    };

    await computeOnce("nothing", body);
    await computeOnce("nothing", body);

    expect(runs).toBe(1);
  });
});

describe("actsLike", () => {
  it("recognises a Date as a time", () => {
    expect(actsLikeTime(new Date())).toBe(true);
  });

  it("recognises an ISO timestamp", () => {
    expect(actsLikeTime("2026-01-01T12:00:00Z")).toBe(true);
    expect(actsLikeTime("2026-01-01 12:00")).toBe(true);
  });

  /**
   * `Date.parse` accepts "March" and a bare year, and treating those as
   * timestamps is how a filter on created_at silently starts matching January.
   */
  it("does not treat any parseable string as a time", () => {
    expect(actsLikeTime("March")).toBe(false);
    expect(actsLikeTime("2026")).toBe(false);
    expect(actsLikeTime("next tuesday")).toBe(false);
  });

  it("does not treat an invalid Date as a time", () => {
    expect(actsLikeTime(new Date("nonsense"))).toBe(false);
  });

  /** The case Rails needs it for: a third type that is not either built-in. */
  it("recognises anything that can produce a Date", () => {
    expect(actsLikeTime({ toDate: () => new Date() })).toBe(true);
  });

  it("tells a bare date from a timestamp", () => {
    expect(actsLikeDate("2026-01-01")).toBe(true);
    expect(actsLikeTime("2026-01-01")).toBe(false);
  });

  it("recognises a string as text", () => {
    expect(actsLikeString("hello")).toBe(true);
    expect(actsLikeString(42)).toBe(false);
  });

  it("says no to nothing at all", () => {
    expect(actsLikeTime(null)).toBe(false);
    expect(actsLikeTime(undefined)).toBe(false);
    expect(actsLike(null, "anything")).toBe(false);
  });

  it("says no to a kind nobody claims", () => {
    expect(actsLike(new Date(), "duration")).toBe(false);
  });

  it("takes a value's own declaration", () => {
    const money = declareActsLike({ amount: 1 }, "money", "numeric");

    expect(actsLike(money, "money")).toBe(true);
    expect(actsLike(money, "numeric")).toBe(true);
    expect(actsLike(money, "time")).toBe(false);
  });

  /** A declaration is the whole answer, so a Date declaring otherwise is taken at its word. */
  it("lets a declaration override the built-in shapes", () => {
    const odd = declareActsLike(new Date(), "money");

    expect(actsLike(odd, "money")).toBe(true);
    expect(actsLikeTime(odd)).toBe(false);
  });

  it("does not put its marker where JSON would find it", () => {
    const money = declareActsLike({ amount: 1 }, "money");

    expect(JSON.stringify(money)).toBe('{"amount":1}');
  });
});
