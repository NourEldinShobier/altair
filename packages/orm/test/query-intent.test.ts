/**
 * One statement on its way to the database and back, ported from
 * `activerecord/test/cases/adapter_test.rb`,
 * `activerecord/test/cases/bind_parameter_test.rb` and the batch cases in
 * `activerecord/test/cases/migration_test.rb`.
 *
 * The cases worth having are the ones where the wrong answer is a *normal*
 * answer: an empty row set, a zero count, a query that matched nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  QueryIntent,
  type QueryResult,
  type QueryRunner,
  QueryStateError,
  disablePreparedStatement,
  execInsertAll,
  executeBatch,
  executeIntent,
  preparedStatements,
  preparedStatementsDisabledCache,
  processArguments,
  processedSql,
  queryAll,
  queryCommand,
  queryOne,
  queryRows,
  queryValue,
  queryValues,
  querySourceLocation,
  rawConnection,
  rawSql,
  rawUpdateSql,
  resetPreparedStatementCache,
  retryable,
} from "../src/query-intent.js";

afterEach(() => {
  resetPreparedStatementCache();
});

const posts: QueryResult = {
  columns: ["id", "title"],
  rows: [
    [1, "First"],
    [2, "Second"],
  ],
};

function runner(result: QueryResult = posts): QueryRunner & { ran: string[] } {
  const seen: string[] = [];

  return {
    ran: seen,
    run(intent) {
      seen.push(intent.sql);

      return Promise.resolve(result);
    },
  };
}

describe("the intent", () => {
  it("carries what it was built from", () => {
    const intent = new QueryIntent({ sql: "SELECT 1", name: "Post Load", binds: [7] });

    expect(intent.sql).toBe("SELECT 1");
    expect(intent.name).toBe("Post Load");
    expect(intent.binds).toEqual([7]);
  });

  it("has not run until it has a result", () => {
    const intent = new QueryIntent({ sql: "SELECT 1" });

    expect(intent.executed).toBe(false);
    expect(intent.rawResultAvailable).toBe(false);
  });

  /**
   * Reading early would return an empty set, which looks exactly like a query
   * that matched nothing.
   */
  it("refuses to hand back a result that is not here", () => {
    expect(() => new QueryIntent({ sql: "SELECT 1" }).rawResult).toThrow(QueryStateError);
  });

  it("says why", () => {
    expect(() => new QueryIntent({ sql: "SELECT 1" }).rawResult).toThrow("matched nothing");
  });

  it("is available once the result arrives", () => {
    const intent = new QueryIntent({ sql: "SELECT 1" });
    intent.rawResult = posts;

    expect(intent.rawResultAvailable).toBe(true);
    expect(intent.executed).toBe(true);
  });

  /**
   * A cast that is not idempotent — a string parsed to a date, then parsed
   * again — produces different rows the second time.
   */
  it("casts once", () => {
    const intent = new QueryIntent({ sql: "SELECT 1" });
    intent.rawResult = posts;
    let casts = 0;
    const cast = (result: QueryResult) => {
      casts += 1;

      return result.rows.map(() => ({}));
    };

    intent.castResult(cast);
    intent.castResult(cast);

    expect(casts).toBe(1);
  });

  it("casts rows into objects", () => {
    const intent = new QueryIntent({ sql: "SELECT 1" });
    intent.rawResult = posts;

    expect(intent.castResult()).toEqual([
      { id: 1, title: "First" },
      { id: 2, title: "Second" },
    ]);
  });

  it("refuses to cast before it has run", () => {
    expect(() => new QueryIntent({ sql: "SELECT 1" }).castResult()).toThrow("has not run");
  });

  /**
   * The driver consumes the result to count updated rows, so asking for rows
   * afterwards hands back an empty set — and an empty set is a normal answer.
   */
  it("refuses rows after a count", () => {
    const intent = new QueryIntent({ sql: "UPDATE posts SET a = 1" });
    intent.rawResult = posts;
    intent.affectedRows(() => 2);

    expect(() => intent.castResult()).toThrow(QueryStateError);
    expect(() => intent.castResult()).toThrow("matched nothing");
  });

  it("refuses a count after rows", () => {
    const intent = new QueryIntent({ sql: "SELECT 1" });
    intent.rawResult = posts;
    intent.castResult();

    expect(() => intent.affectedRows(() => 2)).toThrow("a normal answer");
  });

  it("counts once", () => {
    const intent = new QueryIntent({ sql: "UPDATE posts SET a = 1" });
    intent.rawResult = posts;
    let counts = 0;

    intent.affectedRows(() => {
      counts += 1;

      return 2;
    });
    intent.affectedRows(() => {
      counts += 1;

      return 2;
    });

    expect(counts).toBe(1);
  });
});

describe("the text that is sent", () => {
  /**
   * A value substituted into the text is a value the database parses as SQL,
   * and the parameter form is the only way a string containing a quote is a
   * string rather than a syntax error or worse.
   */
  it("leaves placeholders alone", () => {
    expect(processedSql("SELECT * FROM posts WHERE id = ?", [7])).toBe(
      "SELECT * FROM posts WHERE id = ?",
    );
  });

  it("does not look for placeholders when there are no binds", () => {
    expect(processedSql("SELECT '?'")).toBe("SELECT '?'");
  });

  /**
   * A mismatch shifts every value one column left or leaves one unbound, and
   * both produce rows rather than an error on most adapters.
   */
  it("refuses a count that does not match", () => {
    expect(() => processedSql("SELECT * FROM posts WHERE id = ? AND a = ?", [7])).toThrow(
      QueryStateError,
    );
  });

  it("counts postgres placeholders too", () => {
    expect(() => processedSql("SELECT * FROM posts WHERE id = $1", [7])).not.toThrow();
  });

  it("computes the text once", () => {
    const intent = new QueryIntent({ sql: "SELECT ?", binds: [1] });

    expect(intent.processedSql).toBe(intent.processedSql);
  });

  /** For display only — good enough to read, not good enough to trust. */
  it("shows the values separately", () => {
    expect(rawSql("SELECT * FROM posts WHERE id = ? AND title = ?", [7, "it's"])).toBe(
      "SELECT * FROM posts WHERE id = 7 AND title = 'it''s'",
    );
  });

  it("shows a missing value as NULL", () => {
    expect(rawSql("SELECT ?", [null])).toBe("SELECT NULL");
  });
});

describe("the query family", () => {
  it("reads every row as objects", async () => {
    expect(await queryAll(runner(), "SELECT * FROM posts")).toEqual([
      { id: 1, title: "First" },
      { id: 2, title: "Second" },
    ]);
  });

  it("reads every row as arrays", async () => {
    expect(await queryRows(runner(), "SELECT * FROM posts")).toEqual([
      [1, "First"],
      [2, "Second"],
    ]);
  });

  it("reads the first row", async () => {
    expect(await queryOne(runner(), "SELECT * FROM posts")).toEqual({ id: 1, title: "First" });
  });

  it("reads the first column of every row", async () => {
    expect(await queryValues(runner(), "SELECT id FROM posts")).toEqual([1, 2]);
  });

  it("reads one value", async () => {
    expect(await queryValue(runner(), "SELECT id FROM posts")).toBe(1);
  });

  /**
   * "No rows" is the answer to most of what this is used for — does this table
   * exist, what is the schema version.
   */
  it("reads nothing rather than raising for an empty result", async () => {
    const empty = runner({ columns: ["id"], rows: [] });

    expect(await queryValue(empty, "SELECT 1")).toBeUndefined();
    expect(await queryOne(empty, "SELECT 1")).toBeUndefined();
    expect(await queryAll(empty, "SELECT 1")).toEqual([]);
  });

  /**
   * A read may be replayed after a dropped connection because reading twice
   * costs time. Replaying a write can apply it twice, and the adapter cannot
   * tell whether the first attempt landed.
   */
  it("never retries a command", async () => {
    const intent = await queryCommand(runner(), "DELETE FROM posts");

    expect(intent.allowRetry).toBe(false);
    expect(retryable(intent)).toBe(false);
  });

  it("retries a read that asked to be retried", () => {
    expect(retryable(new QueryIntent({ sql: "SELECT 1", allowRetry: true }))).toBe(true);
    expect(retryable(new QueryIntent({ sql: "SELECT 1" }))).toBe(false);
  });

  it("does not retry a write even when asked", () => {
    expect(retryable(new QueryIntent({ sql: "DELETE FROM posts", allowRetry: true }))).toBe(false);
  });

  it("reports how many rows a write touched", async () => {
    expect(await rawUpdateSql(runner(), "UPDATE posts SET a = 1")).toBe(2);
  });

  it("runs an intent that was built elsewhere", async () => {
    const intent = new QueryIntent({ sql: "SELECT 1" });

    expect(await executeIntent(runner(), intent)).toBe(intent);
    expect(intent.executed).toBe(true);
  });
});

describe("a batch", () => {
  it("sends each statement", async () => {
    const each = runner();

    expect(await executeBatch(each, ["ALTER TABLE a ADD b int", "ALTER TABLE a ADD c int"])).toBe(
      2,
    );
    expect(each.ran).toHaveLength(2);
  });

  /**
   * A migration sending five changes as one string fails with a syntax error
   * at a character offset, and working out which of the five that is takes
   * longer than the migration did.
   */
  it("names the statement that failed", async () => {
    const failing: QueryRunner = {
      run: (intent) =>
        intent.sql.includes("bad")
          ? Promise.reject(new Error("syntax error"))
          : Promise.resolve(posts),
    };

    await expect(executeBatch(failing, ["ok", "bad one", "ok"])).rejects.toThrow('"bad one"');
  });

  it("says where in the batch it was", async () => {
    const failing: QueryRunner = { run: () => Promise.reject(new Error("nope")) };

    await expect(executeBatch(failing, ["a", "b"])).rejects.toThrow("Statement 1 of 2");
  });
});

describe("inserting many rows", () => {
  it("builds one statement with a tuple per row", () => {
    const { sql, binds } = execInsertAll(
      "posts",
      ["title", "body"],
      [
        ["a", "b"],
        ["c", "d"],
      ],
    );

    expect(sql).toBe('INSERT INTO "posts" ("title", "body") VALUES (?, ?), (?, ?)');
    expect(binds).toEqual(["a", "b", "c", "d"]);
  });

  /**
   * An insert with no rows is a syntax error on some adapters and inserts one
   * blank row on others — and the second is worse, because it succeeds.
   */
  it("refuses an empty list", () => {
    expect(() => execInsertAll("posts", ["title"], [])).toThrow(QueryStateError);
  });

  it("says why", () => {
    expect(() => execInsertAll("posts", ["title"], [])).toThrow("because it succeeds");
  });
});

describe("how a statement is sent", () => {
  /**
   * A prepared statement is cached by its text on the server, so one built
   * with values interpolated fills that cache with entries used once — and the
   * server evicts the ones that would have been reused.
   */
  it("prepares only a statement with placeholders", () => {
    expect(preparedStatements("SELECT * FROM posts WHERE id = ?")).toBe(true);
    expect(preparedStatements("SELECT * FROM posts WHERE id = 7")).toBe(false);
  });

  it("prepares nothing when preparation is off", () => {
    expect(preparedStatements("SELECT ?", false)).toBe(false);
  });

  /**
   * Retrying the preparation on every execution turns one failure into two
   * round trips forever.
   */
  it("remembers a statement that could not be prepared", () => {
    disablePreparedStatement("SET x = 1");

    expect(preparedStatementsDisabledCache().has("SET x = 1")).toBe(true);
  });

  /**
   * A driver given `undefined` either sends nothing — shifting every later
   * value one column left — or refuses. Shifting is worse: it writes real
   * values into the wrong columns and reports success.
   */
  it("turns an absent value into an explicit null", () => {
    expect(processArguments([1, undefined, "a"])).toEqual([1, null, "a"]);
  });

  it("leaves an explicit null alone", () => {
    expect(processArguments([null])).toEqual([null]);
  });
});

describe("where a statement came from", () => {
  /**
   * By the time a statement reaches a log every frame between it and the
   * application is framework, so the search skips them rather than taking the
   * caller — which is always the adapter.
   */
  it("finds the first application frame", () => {
    expect(
      querySourceLocation([
        "/app/packages/orm/src/relation.ts:12",
        "/app/packages/orm/src/model.ts:40",
        "/app/app/models/post.ts:7",
      ]),
    ).toBe("/app/app/models/post.ts:7");
  });

  it("finds nothing when it is framework all the way down", () => {
    expect(querySourceLocation(["/app/packages/orm/src/model.ts:40"])).toBeUndefined();
  });

  it("takes a different idea of what is framework", () => {
    expect(
      querySourceLocation(["/vendor/x.ts", "/app/y.ts"], (frame) => frame.startsWith("/vendor")),
    ).toBe("/app/y.ts");
  });
});

describe("the driver handle", () => {
  it("hands it over", () => {
    const raw = {};

    expect(rawConnection({ raw })).toBe(raw);
  });

  /**
   * One held past its checkout is how a statement lands on a connection
   * another request is using.
   */
  it("refuses one that has been returned", () => {
    expect(() => rawConnection({})).toThrow("returned to the pool");
  });
});
