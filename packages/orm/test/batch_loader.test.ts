/**
 * Coalescing many small reads into one query, ported from
 * `activerecord/test/cases/associations/preloader_test.rb` and the
 * `load_async` cases in `activerecord/test/cases/relation/load_async_test.rb`.
 *
 * The bug this addresses shows up as fifty queries and nothing that looks
 * wrong, so the tests mostly count queries rather than checking results.
 */

import { describe, expect, it } from "bun:test";
import {
  type BatchFetch,
  BatchLoader,
  BoundedExecutor,
  asyncLoadTarget,
  buildEntry,
  futureClasses,
  groupedRecords,
  immediateFutureClasses,
  scheduleQuery,
} from "../src/batch_loader.js";

const AUTHORS = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Grace" },
];

const fetchAuthors: BatchFetch = async (_table, column, values) =>
  AUTHORS.filter((row) => values.some((value) => String(value) === String(row[column as "id"])));

describe("grouping what was asked for", () => {
  it("names a group by table and column", () => {
    expect(buildEntry("authors", "id")).toBe("authors.id");
  });

  it("puts keys from one table in one group", () => {
    const groups = groupedRecords([
      { table: "authors", column: "id", value: 1 },
      { table: "authors", column: "id", value: 2 },
    ]);

    expect(groups.size).toBe(1);
    expect(groups.get("authors.id")?.values).toEqual([1, 2]);
  });

  /** Merging them would return rows keyed on the wrong column. */
  it("keeps two columns of one table apart", () => {
    const groups = groupedRecords([
      { table: "authors", column: "id", value: 1 },
      { table: "authors", column: "slug", value: "ada" },
    ]);

    expect(groups.size).toBe(2);
  });

  it("keeps two tables apart", () => {
    const groups = groupedRecords([
      { table: "authors", column: "id", value: 1 },
      { table: "posts", column: "id", value: 1 },
    ]);

    expect(groups.size).toBe(2);
  });

  /** The `IN` list should grow with the data, not with the page. */
  it("asks for a repeated key once", () => {
    const groups = groupedRecords([
      { table: "authors", column: "id", value: 1 },
      { table: "authors", column: "id", value: 1 },
    ]);

    expect(groups.get("authors.id")?.values).toEqual([1]);
  });

  /**
   * A foreign key read as a number from one row and a string from another is
   * the same row; two keys would issue two queries and fill neither.
   */
  it("treats a number and its string as one key", () => {
    const groups = groupedRecords([
      { table: "authors", column: "id", value: 1 },
      { table: "authors", column: "id", value: "1" },
    ]);

    expect(groups.get("authors.id")?.values).toHaveLength(1);
  });
});

describe("loading in a batch", () => {
  it("answers a single request", async () => {
    const loader = new BatchLoader(fetchAuthors);

    expect(await loader.load({ table: "authors", column: "id", value: 1 })).toEqual(AUTHORS[0]);
  });

  /** The whole point: fifty template renders, one query. */
  it("answers many requests with one query", async () => {
    const loader = new BatchLoader(fetchAuthors);

    const results = await Promise.all([
      loader.load({ table: "authors", column: "id", value: 1 }),
      loader.load({ table: "authors", column: "id", value: 2 }),
      loader.load({ table: "authors", column: "id", value: 1 }),
    ]);

    expect(loader.queries).toBe(1);
    expect(results.map((each) => each?.["name"])).toEqual(["Ada", "Grace", "Ada"]);
  });

  it("runs one query per group", async () => {
    const loader = new BatchLoader(fetchAuthors);

    await Promise.all([
      loader.load({ table: "authors", column: "id", value: 1 }),
      loader.load({ table: "posts", column: "id", value: 1 }),
    ]);

    expect(loader.queries).toBe(2);
  });

  /**
   * A promise that never settles stops the request with no error, and the
   * timeout that eventually fires names the wrong thing.
   */
  it("answers nothing for a key with no row", async () => {
    const loader = new BatchLoader(fetchAuthors);

    expect(await loader.load({ table: "authors", column: "id", value: 99 })).toBeUndefined();
  });

  /** One failed query must not turn into a hung request. */
  it("rejects every caller in a failed group", async () => {
    const loader = new BatchLoader(async () => {
      throw new Error("connection lost");
    });

    // Both handed to `allSettled` before the batch runs, so neither is briefly
    // an unhandled rejection — which is what a caller waiting on several loads
    // does anyway.
    const settled = await Promise.allSettled([
      loader.load({ table: "authors", column: "id", value: 1 }),
      loader.load({ table: "authors", column: "id", value: 2 }),
    ]);

    expect(settled.map((each) => each.status)).toEqual(["rejected", "rejected"]);
    expect((settled[0] as PromiseRejectedResult).reason.message).toBe("connection lost");
  });

  /**
   * The failing group settles *first* here, so a rejection that reached across
   * groups would beat the success rather than arrive after it and be ignored.
   */
  it("does not fail a group that succeeded alongside a failure", async () => {
    const loader = new BatchLoader(async (table, column, values) => {
      if (table === "posts") throw new Error("boom");

      await new Promise((resolve) => setTimeout(resolve, 2));

      return fetchAuthors(table, column, values);
    });

    const settled = await Promise.allSettled([
      loader.load({ table: "authors", column: "id", value: 1 }),
      loader.load({ table: "posts", column: "id", value: 1 }),
    ]);

    expect(settled[0]).toMatchObject({ status: "fulfilled", value: AUTHORS[0] });
    expect(settled[1]?.status).toBe("rejected");
  });

  it("reports what is waiting", () => {
    const loader = new BatchLoader(fetchAuthors, () => undefined);
    void loader.load({ table: "authors", column: "id", value: 1 });
    void loader.load({ table: "posts", column: "id", value: 1 });

    expect(loader.loaders().sort()).toEqual(["authors.id", "posts.id"]);
    expect(loader.runnableLoaders()).toBe(2);
  });

  it("runs nothing when nothing is waiting", async () => {
    const loader = new BatchLoader(fetchAuthors, () => undefined);

    await loader.run();

    expect(loader.queries).toBe(0);
  });

  /**
   * The second batch must ask only for what the second batch wanted. Left
   * uncleared, the pending list grows for the life of the loader and every
   * later query re-asks for every key the page has ever wanted.
   */
  it("starts a fresh batch after one runs", async () => {
    const asked: unknown[][] = [];
    const loader = new BatchLoader(async (table, column, values) => {
      asked.push([...values]);

      return fetchAuthors(table, column, values);
    });

    await loader.load({ table: "authors", column: "id", value: 1 });
    await loader.load({ table: "authors", column: "id", value: 2 });

    expect(loader.queries).toBe(2);
    expect(asked).toEqual([[1], [2]]);
  });

  /**
   * One deferral however many callers ask. Scheduling per request would queue
   * a microtask per row on a page, which is the cost the batch existed to
   * avoid moved somewhere less visible.
   */
  it("schedules one batch however many loads", async () => {
    let scheduled = 0;
    const runs: (() => void)[] = [];
    const loader = new BatchLoader(fetchAuthors, (run) => {
      scheduled += 1;
      runs.push(run);
    });

    void loader.load({ table: "authors", column: "id", value: 1 });
    void loader.load({ table: "authors", column: "id", value: 2 });
    void loader.load({ table: "authors", column: "id", value: 1 });

    expect(scheduled).toBe(1);

    for (const run of runs) run();
  });
});

describe("running deferred work", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

  it("runs what it is given", async () => {
    const executor = new BoundedExecutor(2);
    let ran = false;
    executor.post(async () => {
      ran = true;
    });

    await settle();

    expect(ran).toBe(true);
  });

  /**
   * Every in-flight async query holds a connection. Unbounded, a page calling
   * `load_async` in a loop takes the pool, and the synchronous queries
   * rendering that page wait on connections its own optimisation is holding.
   */
  it("runs no more than the limit at once", async () => {
    const executor = new BoundedExecutor(2);
    let peak = 0;
    const slow = async () => {
      peak = Math.max(peak, executor.inFlight);
      await settle();
    };

    for (let index = 0; index < 6; index += 1) executor.post(slow);

    expect(executor.inFlight).toBe(2);
    expect(executor.queued).toBe(4);

    await settle();
    await settle();

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("starts a queued item once a slot frees", async () => {
    const executor = new BoundedExecutor(1);
    const ran: number[] = [];

    executor.post(async () => {
      ran.push(1);
      await settle();
    });
    executor.post(async () => {
      ran.push(2);
    });

    await settle();
    await settle();

    expect(ran).toEqual([1, 2]);
  });

  it("frees the slot when work throws", async () => {
    const executor = new BoundedExecutor(1);
    executor.post(async () => {
      throw new Error("boom");
    });

    await settle();

    expect(executor.inFlight).toBe(0);
  });

  it("hands back what deferred work returned", async () => {
    expect(await asyncLoadTarget(new BoundedExecutor(), async () => 7)).toBe(7);
  });

  it("passes on a failure", async () => {
    await expect(
      asyncLoadTarget(new BoundedExecutor(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("whether a query may be deferred", () => {
  it("defers an ordinary one", () => {
    expect(scheduleQuery()).toBe("async");
  });

  /**
   * A query on another connection cannot see uncommitted work, so deferring
   * inside a transaction silently reads the state from before it — which looks
   * like a caching bug and is not one.
   */
  it("does not defer inside a transaction", () => {
    expect(scheduleQuery({ inTransaction: true })).toBe("immediate");
  });

  it("does not defer with nowhere to run it", () => {
    expect(scheduleQuery({ executorAvailable: false })).toBe("immediate");
  });

  it("names the kinds a deferred query can be", () => {
    expect(futureClasses()).toContain("count");
  });

  it("forces every kind immediate inside a transaction", () => {
    expect(immediateFutureClasses(true)).toEqual(futureClasses());
    expect(immediateFutureClasses(false)).toEqual([]);
  });
});
