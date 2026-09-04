/**
 * Raw SQL that comes back as records, ported from
 * `activerecord/test/cases/finder_test.rb`'s `find_by_sql` cases and
 * `asynchronous_queries_test.rb`.
 *
 * Dropping to SQL is the point where the framework stops protecting the
 * caller, so the cases are about the two things it still has to: the values go
 * in binds, and a count is one number.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { BoundedExecutor } from "../src/batch-loader.js";
import {
  type RawRow,
  NotACount,
  RawSqlBindingError,
  asyncCountBySql,
  asyncExecutor,
  asyncFindBySql,
  checkBinds,
  countBySql,
  findBySql,
  resetAsyncExecutor,
  setAsyncExecutor,
} from "../src/find-by-sql.js";

afterEach(() => {
  resetAsyncExecutor();
});

interface Post {
  id: number;
  title: string;
  extra?: unknown;
}

const Post = {
  name: "Post",
  instantiate: (row: RawRow): Post => ({
    id: Number(row["id"]),
    title: String(row["title"]),
    ...(row["comment_count"] === undefined ? {} : { extra: row["comment_count"] }),
  }),
};

const rows =
  (...values: RawRow[]) =>
  () =>
    values;

describe("checking a statement against its binds", () => {
  it("passes when they match", () => {
    expect(() => checkBinds("SELECT * FROM posts WHERE id = ?", [1])).not.toThrow();
    expect(() => checkBinds("SELECT * FROM posts", [])).not.toThrow();
  });

  /**
   * A placeholder with no value is sent as a literal question mark and a value
   * with no placeholder is dropped. Neither raises, and both change what the
   * query means.
   */
  it("refuses a placeholder with no value", () => {
    expect(() => checkBinds("SELECT * FROM posts WHERE id = ?", [])).toThrow(RawSqlBindingError);
  });

  it("refuses a value with no placeholder", () => {
    expect(() => checkBinds("SELECT * FROM posts", [1])).toThrow(RawSqlBindingError);
  });

  it("counts every placeholder", () => {
    expect(() => checkBinds("WHERE a = ? AND b = ?", [1])).toThrow(RawSqlBindingError);
    expect(() => checkBinds("WHERE a = ? AND b = ?", [1, 2])).not.toThrow();
  });
});

describe("raw sql as records", () => {
  it("instantiates every row through the model", async () => {
    const found = await findBySql(Post, "SELECT * FROM posts", [], rows({ id: "1", title: "a" }));

    expect(found).toEqual([{ id: 1, title: "a" }]);
  });

  /**
   * The point of hand-written SQL is often the extra column; dropped, a
   * `SELECT posts.*, COUNT(*) AS comment_count` returns posts with no count.
   */
  it("keeps a column the model has no field for", async () => {
    const found = await findBySql(
      Post,
      "SELECT * FROM posts",
      [],
      rows({ id: "1", title: "a", comment_count: 7 }),
    );

    expect(found[0]?.extra).toBe(7);
  });

  it("passes the binds to the query", async () => {
    const seen: unknown[][] = [];

    await findBySql(Post, "SELECT * FROM posts WHERE id = ?", [1], (_sql, binds) => {
      seen.push([...binds]);

      return [];
    });

    expect(seen).toEqual([[1]]);
  });

  it("is nothing for a query that found nothing", async () => {
    expect(await findBySql(Post, "SELECT * FROM posts", [], rows())).toEqual([]);
  });

  /** Checked before anything is sent, so the error names the query. */
  it("refuses a statement whose binds do not match", async () => {
    await expect(findBySql(Post, "WHERE id = ?", [], rows())).rejects.toThrow(RawSqlBindingError);
  });
});

describe("raw sql as one number", () => {
  it("is the single value the query returned", async () => {
    expect(await countBySql("SELECT COUNT(*) FROM posts", [], rows({ count: 42 }))).toBe(42);
  });

  it("reads a count the driver returned as text", async () => {
    expect(await countBySql("SELECT COUNT(*) FROM posts", [], rows({ count: "42" }))).toBe(42);
  });

  /**
   * A count that found nothing is a count of nothing: `undefined` would make
   * every caller write `?? 0`, and the one that forgets renders "undefined
   * items".
   */
  it("is zero when the query returned no rows", async () => {
    expect(await countBySql("SELECT COUNT(*) FROM posts", [], rows())).toBe(0);
  });

  /**
   * Reading the first column of a query that returns several counts whichever
   * happened to be first, and the number that comes back is plausible.
   */
  it("refuses a query that returns more than one column", async () => {
    await expect(countBySql("SELECT a, b FROM posts", [], rows({ a: 1, b: 2 }))).rejects.toThrow(
      NotACount,
    );
  });

  it("refuses a query that returns more than one row", async () => {
    await expect(
      countBySql("SELECT COUNT(*) FROM posts GROUP BY author_id", [], rows({ c: 1 }, { c: 2 })),
    ).rejects.toThrow(NotACount);
  });

  it("names the columns it got instead", async () => {
    await expect(countBySql("SELECT a, b", [], rows({ a: 1, b: 2 }))).rejects.toThrow("a, b");
  });

  it("refuses a statement whose binds do not match", async () => {
    await expect(countBySql("WHERE id = ?", [], rows())).rejects.toThrow(RawSqlBindingError);
  });
});

describe("starting one ahead of time", () => {
  it("comes back as the records", async () => {
    const future = asyncFindBySql(Post, "SELECT * FROM posts", [], rows({ id: "1", title: "a" }));

    expect(await future.result()).toEqual([{ id: 1, title: "a" }]);
  });

  it("comes back as the number", async () => {
    const future = asyncCountBySql("SELECT COUNT(*) FROM posts", [], rows({ c: 3 }));

    expect(await future.result()).toBe(3);
  });

  /**
   * The executor swallows failures because the work it runs usually reports its
   * own. Here the caller is waiting, so a dropped rejection leaves the future
   * pending for ever.
   */
  it("reaches the caller when the query fails", async () => {
    const future = asyncFindBySql(Post, "SELECT * FROM posts", [], () => {
      throw new Error("connection lost");
    });

    await expect(future.result()).rejects.toThrow("connection lost");
  });

  it("refuses a mismatched statement before starting anything", () => {
    expect(() => asyncFindBySql(Post, "WHERE id = ?", [], rows())).toThrow(RawSqlBindingError);
    expect(() => asyncCountBySql("WHERE id = ?", [], rows())).toThrow(RawSqlBindingError);
  });

  /**
   * Every in-flight async query holds a connection, so an unbounded one takes
   * the whole pool and the synchronous queries rendering the page wait for
   * connections its own optimisation is holding.
   */
  it("runs through the shared executor", async () => {
    const posted: (() => Promise<void>)[] = [];
    setAsyncExecutor({
      inFlight: 0,
      post: (work) => posted.push(work),
    });

    const future = asyncFindBySql(Post, "SELECT * FROM posts", [], rows({ id: "1", title: "a" }));

    expect(posted).toHaveLength(1);

    await posted[0]?.();

    expect(await future.result()).toEqual([{ id: 1, title: "a" }]);
  });

  it("is a bounded executor by default, and can be put back", () => {
    expect(asyncExecutor()).toBeInstanceOf(BoundedExecutor);

    const replacement = new BoundedExecutor(1);
    setAsyncExecutor(replacement);

    expect(asyncExecutor()).toBe(replacement);

    resetAsyncExecutor();

    expect(asyncExecutor()).not.toBe(replacement);
  });

  /** One shared bound, or two call sites each bound to four run eight. */
  it("holds the bound across separate queries", async () => {
    setAsyncExecutor(new BoundedExecutor(1));

    let running = 0;
    let peak = 0;
    const slow = async (): Promise<RawRow[]> => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;

      return [{ c: 1 }];
    };

    await Promise.all([
      asyncCountBySql("SELECT 1", [], slow).result(),
      asyncCountBySql("SELECT 1", [], slow).result(),
    ]);

    expect(peak).toBe(1);
  });
});
