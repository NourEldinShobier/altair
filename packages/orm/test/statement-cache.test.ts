/**
 * Reusing a query's shape across calls, ported from
 * `activerecord/test/cases/statement_cache_test.rb` and the `find_by` cases in
 * `activerecord/test/cases/finder_test.rb`.
 *
 * Two properties carry the weight, and both are about the cache never being
 * keyed on or filled with user input: the key is the query's *shape*, and a
 * value that would need a different shape is refused rather than substituted
 * into the one that was built.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  BindArityError,
  PartialQuery,
  PartialQueryCollector,
  Params,
  Query,
  StatementCache,
  Substitute,
  UnsupportedBindValue,
  cacheableQuery,
  cachedFindBy,
  cachedFindByStatement,
  findByStatementCache,
  findByStatementCacheKey,
  initializeFindByCache,
  partialQuery,
  partialQueryCollector,
  query,
  unsupportedValue,
} from "../src/statement-cache.js";

afterEach(() => {
  initializeFindByCache();
});

describe("what may be bound", () => {
  it("takes a scalar", () => {
    expect(unsupportedValue(7)).toBe(false);
    expect(unsupportedValue("seven")).toBe(false);
    expect(unsupportedValue(true)).toBe(false);
  });

  /** `WHERE id = ?` with null matches nothing, silently, where `IS NULL` was meant. */
  it("refuses null", () => {
    expect(unsupportedValue(null)).toBe(true);
    expect(unsupportedValue(undefined)).toBe(true);
  });

  /** An array needs as many holes as it has elements — a different shape. */
  it("refuses an array", () => {
    expect(unsupportedValue([1, 2])).toBe(true);
  });

  it("refuses anything else with structure", () => {
    expect(unsupportedValue({ from: 1, to: 2 })).toBe(true);
    expect(unsupportedValue(new Date())).toBe(true);
  });
});

describe("a statement with no holes", () => {
  it("hands back its sql", () => {
    expect(query("SELECT 1").sqlFor()).toBe("SELECT 1");
  });

  it("has no holes", () => {
    expect(query("SELECT 1").holes).toBe(0);
  });

  /**
   * Only for a statement the database was not told to change anything by:
   * retrying a SELECT costs a round trip, retrying an INSERT after a
   * connection died mid-write can produce the row twice.
   */
  it("is not retryable unless it says so", () => {
    expect(query("SELECT 1").retryable).toBe(false);
    expect(query("SELECT 1", true).retryable).toBe(true);
  });

  it("takes no bind values", () => {
    expect(() => new StatementCache(query("SELECT 1")).execute([7])).toThrow(BindArityError);
  });
});

describe("a statement with holes", () => {
  const built = () =>
    partialQuery(["SELECT * FROM posts WHERE id = ", new Substitute(), " LIMIT 1"]);

  it("counts them", () => {
    expect(built().holes).toBe(1);
  });

  /**
   * Placeholders, not values. A cached statement is reused for the life of the
   * process, so one unquoted interpolation is a permanent injection rather
   * than a single bad query.
   */
  it("fills them with placeholders", () => {
    expect(built().sqlFor([7]).sql).toBe("SELECT * FROM posts WHERE id = ? LIMIT 1");
  });

  it("hands the values back as binds", () => {
    expect(built().sqlFor([7]).binds).toEqual([7]);
  });

  it("does not put the value in the sql", () => {
    expect(built().sqlFor(["'; DROP TABLE posts --"]).sql).not.toContain("DROP TABLE");
  });

  it("takes the adapter's own placeholder", () => {
    expect(built().sqlFor([7], (index) => `$${index + 1}`).sql).toContain("$1");
  });

  it("numbers several of them in order", () => {
    const two = partialQuery(["a=", new Substitute(), " AND b=", new Substitute()]);

    expect(two.sqlFor([1, 2], (index) => `$${index + 1}`).sql).toBe("a=$1 AND b=$2");
    expect(two.sqlFor([1, 2]).binds).toEqual([1, 2]);
  });

  /**
   * A mismatch shifts every later value into the wrong column, producing a
   * query that runs and answers a question nobody asked.
   */
  it("refuses too few values", () => {
    expect(() => built().sqlFor([])).toThrow(BindArityError);
  });

  it("refuses too many", () => {
    expect(() => built().sqlFor([1, 2])).toThrow(BindArityError);
  });

  it("says how many it wanted", () => {
    expect(() => built().sqlFor([])).toThrow("1 bind");
  });

  it("refuses a value the shape cannot express", () => {
    expect(() => built().sqlFor([null])).toThrow(UnsupportedBindValue);
    expect(() => built().sqlFor([[1, 2]])).toThrow(UnsupportedBindValue);
  });

  it("says why", () => {
    expect(() => built().sqlFor([null])).toThrow("different query shape");
  });
});

describe("collecting a query", () => {
  it("joins the fixed parts", () => {
    const collector = partialQueryCollector();
    collector.append("SELECT * FROM posts").append(" LIMIT 1");

    expect(collector.value().parts.join("")).toBe("SELECT * FROM posts LIMIT 1");
  });

  it("puts a hole where a bind goes", () => {
    const collector = new PartialQueryCollector();
    collector.append("id = ").addBind(7);

    expect(collector.value().parts[1]).toBeInstanceOf(Substitute);
    expect(collector.value().binds).toEqual([7]);
  });

  /**
   * The commas matter as much as the holes: `id IN (???)` is not valid SQL,
   * and a collector that emitted the placeholders without separating them
   * would still pass a count of the holes.
   */
  it("separates several binds", () => {
    const collector = new PartialQueryCollector();
    collector.append("id IN (").addBinds([1, 2, 3]).append(")");

    expect(collector.value().binds).toEqual([1, 2, 3]);
    expect(collector.value().parts.filter((part) => part instanceof Substitute)).toHaveLength(3);
    expect(new PartialQuery(collector.value().parts).sqlFor([1, 2, 3]).sql).toBe("id IN (?, ?, ?)");
  });

  it("starts preparable", () => {
    expect(cacheableQuery(partialQueryCollector())).toBe(true);
  });

  /**
   * One-way. A collector that let a later fragment set this back would cache a
   * statement built partly from something that was never safe to cache.
   */
  it("stays unpreparable once anything is", () => {
    const collector = partialQueryCollector();
    collector.markUnpreparable();
    collector.append("SELECT 1").addBind(7);

    expect(cacheableQuery(collector)).toBe(false);
  });
});

describe("building one from a block", () => {
  it("hands the block something to make holes with", () => {
    const statement = StatementCache.create((params) => ["id = ", params.bind()]);

    expect(statement.execute([7]).sql).toBe("id = ?");
  });

  it("makes a hole per call", () => {
    const params = new Params();

    expect(params.bind()).not.toBe(params.bind());
  });

  it("carries a name through, for readability", () => {
    expect(new Params().bind("id").name).toBe("id");
  });

  it("runs with different values", () => {
    const statement = StatementCache.create((params) => ["id = ", params.bind()]);

    expect(statement.execute([1]).binds).toEqual([1]);
    expect(statement.execute([2]).binds).toEqual([2]);
  });
});

describe("the cache key", () => {
  /**
   * The columns, never the values. Keying on values makes this an unbounded
   * map filled by whatever ids arrive — a memory leak anyone can trigger by
   * iterating.
   */
  it("is the model and the columns", () => {
    expect(findByStatementCacheKey("Post", ["id"])).toBe("Post(id)");
  });

  it("is the same whatever order the columns came in", () => {
    expect(findByStatementCacheKey("Post", ["a", "b"])).toBe(
      findByStatementCacheKey("Post", ["b", "a"]),
    );
  });

  it("separates two models", () => {
    expect(findByStatementCacheKey("Post", ["id"])).not.toBe(
      findByStatementCacheKey("Comment", ["id"]),
    );
  });

  it("separates two column sets", () => {
    expect(findByStatementCacheKey("Post", ["id"])).not.toBe(
      findByStatementCacheKey("Post", ["id", "slug"]),
    );
  });
});

describe("caching a finder", () => {
  const build = (params: Params) => ["id = ", params.bind()];

  it("builds one the first time", () => {
    expect(cachedFindByStatement("Post", ["id"], build)).toBeInstanceOf(StatementCache);
  });

  it("hands back the same one after that", () => {
    expect(cachedFindByStatement("Post", ["id"], build)).toBe(
      cachedFindByStatement("Post", ["id"], build),
    );
  });

  /** One entry per shape — not one per value. */
  it("stores one entry however many values are used", () => {
    cachedFindBy("Post", "posts", ["id"], [1]);
    cachedFindBy("Post", "posts", ["id"], [2]);
    cachedFindBy("Post", "posts", ["id"], [3]);

    expect(findByStatementCache().size).toBe(1);
  });

  it("stores a second entry for a different shape", () => {
    cachedFindBy("Post", "posts", ["id"], [1]);
    cachedFindBy("Post", "posts", ["id", "slug"], [1, "x"]);

    expect(findByStatementCache().size).toBe(2);
  });

  it("empties", () => {
    cachedFindBy("Post", "posts", ["id"], [1]);

    initializeFindByCache();

    expect(findByStatementCache().size).toBe(0);
  });

  it("builds the query", () => {
    expect(cachedFindBy("Post", "posts", ["id"], [7]).sql).toBe(
      'SELECT * FROM "posts" WHERE "id" = ? LIMIT 1',
    );
  });

  it("ands several columns together", () => {
    expect(cachedFindBy("Post", "posts", ["id", "slug"], [7, "x"]).sql).toBe(
      'SELECT * FROM "posts" WHERE "id" = ? AND "slug" = ? LIMIT 1',
    );
  });

  it("binds the values in order", () => {
    expect(cachedFindBy("Post", "posts", ["id", "slug"], [7, "x"]).binds).toEqual([7, "x"]);
  });

  it("quotes the way the adapter asks", () => {
    expect(cachedFindBy("Post", "posts", ["id"], [7], (name) => `\`${name}\``).sql).toContain(
      "`posts`",
    );
  });

  it("never puts a value in the sql", () => {
    expect(cachedFindBy("Post", "posts", ["slug"], ["' OR 1=1 --"]).sql).not.toContain("OR 1=1");
  });

  /** The caller falls back to building a query normally, as Rails' find_by does. */
  it("refuses a value that needs a different shape", () => {
    expect(() => cachedFindBy("Post", "posts", ["id"], [null])).toThrow(UnsupportedBindValue);
  });

  it("refuses a column count that does not match", () => {
    expect(() => cachedFindBy("Post", "posts", ["id", "slug"], [7])).toThrow(BindArityError);
  });

  it("is retryable, being a select", () => {
    expect(cachedFindByStatement("Post", ["id"], build).retryable).toBe(true);
  });
});

describe("what a statement is made of", () => {
  it("recognises the pieces", () => {
    const statement = new StatementCache(new PartialQuery(["a", new Substitute()]));

    expect(statement.builder).toBeInstanceOf(PartialQuery);
    expect(new StatementCache(new Query("SELECT 1")).builder).toBeInstanceOf(Query);
  });
});
