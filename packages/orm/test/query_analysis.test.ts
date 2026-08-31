/**
 * Telling one kind of statement from another, ported from
 * `activerecord/test/cases/query_cache_test.rb`,
 * `activerecord/test/cases/explain_test.rb` and the `write_query?` cases in
 * `activerecord/test/cases/adapters/...`.
 *
 * The classification errs toward "this writes", because a read called a write
 * costs a cleared cache and a write called a read costs correctness in three
 * places at once.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  CannotExplainWrite,
  addSqlComment,
  autoIncrementedByDb,
  buildExplainClause,
  buildReadQueryRegexp,
  cacheEntry,
  cacheableStatement,
  cachedEntry,
  clearQueryCachesForCurrentThread,
  collectingQueriesForExplain,
  compatibleTimestampType,
  defaultSequenceName,
  deleteAllEntries,
  dirtiesQueryCache,
  disableQueryCache,
  enableQueryCache,
  execExplain,
  highPrecisionCurrentTimestamp,
  preventableQuery,
  queryCacheEnabled,
  recordForExplain,
  resetQueryCache,
  resetSequenceName,
  serialSequence,
  skipQueryCache,
  uncached,
  unpreparedStatement,
  writeQuery,
} from "../src/query_analysis.js";

afterEach(() => {
  resetQueryCache();
});

describe("whether a statement writes", () => {
  it("says a select does not", () => {
    expect(writeQuery("SELECT * FROM posts")).toBe(false);
  });

  it("says the writing statements do", () => {
    for (const sql of [
      "INSERT INTO posts VALUES (1)",
      "UPDATE posts SET a=1",
      "DELETE FROM posts",
    ]) {
      expect(writeQuery(sql)).toBe(true);
    }
  });

  /**
   * An allowlist, not a denylist: a denylist cannot know about a keyword it
   * has not heard of, and failing to recognise a *write* is much worse.
   */
  it("treats something it does not recognise as a write", () => {
    expect(writeQuery("VACUUM")).toBe(true);
    expect(writeQuery("CREATE TABLE posts (id int)")).toBe(true);
  });

  it("says the other reading statements do not", () => {
    for (const sql of ["SHOW TABLES", "EXPLAIN SELECT 1", "PRAGMA foreign_keys"]) {
      expect(writeQuery(sql)).toBe(false);
    }
  });

  /**
   * Query annotation puts a comment at the front, and a naive check would call
   * every annotated read a write and clear the cache on all of them.
   */
  it("looks past a leading comment", () => {
    expect(writeQuery("/*application:Blog*/ SELECT * FROM posts")).toBe(false);
  });

  it("looks past several", () => {
    expect(writeQuery("/*a*/ /*b*/ SELECT 1")).toBe(false);
  });

  it("ignores leading whitespace", () => {
    expect(writeQuery("\n  SELECT 1")).toBe(false);
  });

  /** Postgres allows `WITH x AS (DELETE ...) SELECT ...`, which deletes rows. */
  it("says a WITH that only reads does not write", () => {
    expect(writeQuery("WITH recent AS (SELECT * FROM posts) SELECT * FROM recent")).toBe(false);
  });

  it("says a WITH that deletes does", () => {
    expect(writeQuery("WITH gone AS (DELETE FROM posts RETURNING *) SELECT * FROM gone")).toBe(
      true,
    );
  });

  it("is the same question a reading role asks", () => {
    expect(preventableQuery("DELETE FROM posts")).toBe(true);
    expect(preventableQuery("SELECT 1")).toBe(false);
  });

  it("takes extra reading keywords", () => {
    expect(buildReadQueryRegexp(["ANALYZE"]).test("ANALYZE posts")).toBe(true);
  });
});

describe("what may be cached", () => {
  /** A cache surviving a write returns pre-write rows to the rest of the request. */
  it("is emptied by a write", () => {
    expect(dirtiesQueryCache("INSERT INTO posts VALUES (1)")).toBe(true);
    expect(dirtiesQueryCache("SELECT 1")).toBe(false);
  });

  it("is emptied by DDL", () => {
    expect(dirtiesQueryCache("ALTER TABLE posts ADD COLUMN a int")).toBe(true);
  });

  it("caches an ordinary read", () => {
    expect(cacheableStatement("SELECT * FROM posts")).toBe(true);
  });

  it("does not cache a write", () => {
    expect(cacheableStatement("INSERT INTO posts VALUES (1)")).toBe(false);
  });

  /** `SELECT nextval(...)` reads and answers differently every time. */
  it("does not cache a read whose answer changes", () => {
    expect(cacheableStatement("SELECT nextval('posts_id_seq')")).toBe(false);
    expect(cacheableStatement("SELECT random()")).toBe(false);
    expect(cacheableStatement("SELECT now()")).toBe(false);
  });
});

describe("the cache", () => {
  it("is off until enabled", () => {
    expect(queryCacheEnabled()).toBe(false);
  });

  it("turns on and off", () => {
    enableQueryCache();

    expect(queryCacheEnabled()).toBe(true);

    disableQueryCache();

    expect(queryCacheEnabled()).toBe(false);
  });

  it("holds and returns an entry", () => {
    enableQueryCache();
    cacheEntry("k", "v");

    expect(cachedEntry("k")).toBe("v");
  });

  it("holds nothing while off", () => {
    cacheEntry("k", "v");

    expect(cachedEntry("k")).toBeUndefined();
  });

  it("empties", () => {
    enableQueryCache();
    cacheEntry("k", "v");

    expect(deleteAllEntries()).toBe(1);
    expect(cachedEntry("k")).toBeUndefined();
  });

  it("empties for the current task too", () => {
    enableQueryCache();
    cacheEntry("k", "v");

    expect(clearQueryCachesForCurrentThread()).toBe(1);
  });

  it("is off inside an uncached block", async () => {
    enableQueryCache();

    await uncached(() => {
      expect(queryCacheEnabled()).toBe(false);
    });

    expect(queryCacheEnabled()).toBe(true);
  });

  /** Counted, so an inner block finishing does not turn the cache back on. */
  it("stays off while an outer block is still open", async () => {
    enableQueryCache();

    await uncached(async () => {
      await uncached(() => undefined);

      expect(queryCacheEnabled()).toBe(false);
    });
  });

  /**
   * A body that throws must not leave the cache off for the rest of the
   * request — one error would become a silent performance regression nobody
   * connects to it.
   */
  it("comes back on when the body throws", async () => {
    enableQueryCache();

    await expect(
      uncached(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(queryCacheEnabled()).toBe(true);
  });

  it("skips a statement it cannot cache", () => {
    enableQueryCache();

    expect(skipQueryCache("SELECT 1")).toBe(false);
    expect(skipQueryCache("SELECT now()")).toBe(true);
    expect(skipQueryCache("INSERT INTO posts VALUES (1)")).toBe(true);
  });
});

describe("annotating a statement", () => {
  /** A leading comment breaks statement matching in proxies and poolers. */
  it("puts the comment at the end", () => {
    expect(addSqlComment("SELECT 1", "application:Blog")).toBe("SELECT 1 /*application:Blog*/");
  });

  /** A value containing one would end the comment and turn the rest into SQL. */
  it("strips a comment terminator from the text", () => {
    expect(addSqlComment("SELECT 1", "a*/ DROP TABLE posts --")).not.toContain("*/ DROP");
  });

  it("adds nothing for an empty comment", () => {
    expect(addSqlComment("SELECT 1", "  ")).toBe("SELECT 1");
  });

  it("says which statements must not be prepared", () => {
    expect(unpreparedStatement("INSERT INTO posts VALUES (1)")).toBe(true);
    expect(unpreparedStatement("INSERT INTO posts VALUES (?)")).toBe(false);
    expect(unpreparedStatement("SELECT 1")).toBe(false);
  });
});

describe("explaining", () => {
  it("explains a read", () => {
    expect(buildExplainClause("SELECT 1")).toBe("EXPLAIN SELECT 1");
  });

  /**
   * `EXPLAIN INSERT` runs the insert on MySQL, so explaining a slow write
   * would apply it twice — which is the situation somebody is in when they
   * reach for explain at all.
   */
  it("refuses a write", () => {
    expect(() => buildExplainClause("INSERT INTO posts VALUES (1)")).toThrow(CannotExplainWrite);
  });

  it("says why", () => {
    expect(() => buildExplainClause("DELETE FROM posts")).toThrow("a second time");
  });

  /** ANALYZE actually runs the statement, which is why it is opt-in. */
  it("analyses only when asked", () => {
    expect(buildExplainClause("SELECT 1", { analyze: true })).toContain("ANALYZE");
    expect(buildExplainClause("SELECT 1")).not.toContain("ANALYZE");
  });

  it("uses the adapter's syntax", () => {
    expect(buildExplainClause("SELECT 1", { analyze: true, adapter: "mysql" })).toBe(
      "EXPLAIN ANALYZE SELECT 1",
    );
    expect(buildExplainClause("SELECT 1", { analyze: true })).toContain("BUFFERS");
  });

  it("collects what ran inside a block", async () => {
    const { queries } = await collectingQueriesForExplain(() => {
      recordForExplain("SELECT 1");
      recordForExplain("SELECT 2");
    });

    expect(queries).toEqual(["SELECT 1", "SELECT 2"]);
  });

  /** A write cannot be explained, so collecting one produces an unusable list. */
  it("does not collect a write", async () => {
    const { queries } = await collectingQueriesForExplain(() => {
      recordForExplain("SELECT 1");
      recordForExplain("INSERT INTO posts VALUES (1)");
    });

    expect(queries).toEqual(["SELECT 1"]);
  });

  it("collects nothing outside a block", async () => {
    recordForExplain("SELECT 1");

    const { queries } = await collectingQueriesForExplain(() => undefined);

    expect(queries).toEqual([]);
  });

  it("stops collecting when the body throws", async () => {
    await expect(
      collectingQueriesForExplain(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    recordForExplain("SELECT after");
    const { queries } = await collectingQueriesForExplain(() => undefined);

    expect(queries).toEqual([]);
  });

  it("hands back what the body returned", async () => {
    expect((await collectingQueriesForExplain(() => 7)).result).toBe(7);
  });

  it("explains everything collected", () => {
    expect(execExplain(["SELECT 1", "SELECT 2"])).toEqual(["EXPLAIN SELECT 1", "EXPLAIN SELECT 2"]);
  });
});

describe("sequences and timestamps", () => {
  it("names a sequence after its table and column", () => {
    expect(defaultSequenceName("posts")).toBe("posts_id_seq");
    expect(serialSequence("posts", "number")).toBe("posts_number_seq");
    expect(resetSequenceName("posts")).toBe("posts_id_seq");
  });

  /** Which decides whether the id has to be read back after an insert. */
  it("says which columns the database fills in", () => {
    expect(autoIncrementedByDb({ autoIncrement: true })).toBe(true);
    expect(autoIncrementedByDb({ default: "nextval('posts_id_seq'::regclass)" })).toBe(true);
    expect(autoIncrementedByDb({ default: "0" })).toBe(false);
    expect(autoIncrementedByDb({})).toBe(false);
  });

  /**
   * MySQL truncates to whole seconds unless told otherwise, and two rows
   * written in one request then compare equal — which breaks any ordering
   * relying on them.
   */
  it("asks MySQL for sub-second precision", () => {
    expect(highPrecisionCurrentTimestamp("mysql")).toBe("CURRENT_TIMESTAMP(6)");
    expect(highPrecisionCurrentTimestamp("postgres")).toBe("CURRENT_TIMESTAMP");
  });

  it("names the timestamp type per adapter", () => {
    expect(compatibleTimestampType("mysql")).toBe("datetime(6)");
    expect(compatibleTimestampType("postgres")).toBe("timestamp");
    expect(compatibleTimestampType("postgres", 3)).toBe("timestamp(3)");
    expect(compatibleTimestampType("sqlite")).toBe("datetime");
  });
});
