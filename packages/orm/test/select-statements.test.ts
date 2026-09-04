/**
 * The adapter's query shapes, ported from
 * `activerecord/test/cases/adapter_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import {
  execDelete,
  execInsert,
  execQuery,
  execUpdate,
  isReadQuery,
  isWriteQuery,
  selectAll,
  selectOne,
  selectPairs,
  selectRows,
  selectValue,
  selectValues,
} from "../src/select-statements.js";

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("views");
  });

  await connection.execute(
    "INSERT INTO posts (title, views) VALUES ('one', 10), ('two', 20), ('three', 30)",
  );
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("selectAll", () => {
  it("gives rows as objects", async () => {
    const rows = await selectAll(connection, "SELECT title, views FROM posts ORDER BY views");

    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe("one");
  });
});

describe("selectOne", () => {
  it("gives the first row", async () => {
    const row = await selectOne(connection, "SELECT title FROM posts ORDER BY views");

    expect(row?.title).toBe("one");
  });

  /** Null, so a caller has one absence to check rather than two. */
  it("gives null when nothing matched", async () => {
    expect(await selectOne(connection, "SELECT title FROM posts WHERE views > 999")).toBeNull();
  });
});

describe("selectRows", () => {
  /** The caller already decided the order in the query. */
  it("gives arrays in the order the query asked for", async () => {
    const rows = await selectRows(connection, "SELECT title, views FROM posts ORDER BY views");

    expect(rows[0]).toEqual(["one", 10]);
  });

  it("follows a different column order", async () => {
    const rows = await selectRows(connection, "SELECT views, title FROM posts ORDER BY views");

    expect(rows[0]).toEqual([10, "one"]);
  });

  it("gives nothing for no rows", async () => {
    expect(await selectRows(connection, "SELECT title FROM posts WHERE views > 999")).toEqual([]);
  });
});

describe("selectValue", () => {
  /** The queries whose whole answer is one number. */
  it("gives a scalar", async () => {
    expect(Number(await selectValue(connection, "SELECT COUNT(*) FROM posts"))).toBe(3);
  });

  it("gives the first column when several are selected", async () => {
    expect(await selectValue(connection, "SELECT title, views FROM posts ORDER BY views")).toBe(
      "one",
    );
  });

  it("gives null when nothing matched", async () => {
    expect(await selectValue(connection, "SELECT title FROM posts WHERE views > 999")).toBeNull();
  });
});

describe("selectValues", () => {
  /** One array rather than one object per row. */
  it("gives one column across every row", async () => {
    const titles = await selectValues(connection, "SELECT title FROM posts ORDER BY views");

    expect(titles).toEqual(["one", "two", "three"]);
  });

  it("takes the first column when several are selected", async () => {
    const values = await selectValues(connection, "SELECT views, title FROM posts ORDER BY views");

    expect(values).toEqual([10, 20, 30]);
  });

  it("gives nothing for no rows", async () => {
    expect(await selectValues(connection, "SELECT title FROM posts WHERE views > 999")).toEqual([]);
  });
});

describe("selectPairs", () => {
  /** For a lookup table read once and consulted many times. */
  it("keys the second column by the first", async () => {
    const pairs = await selectPairs(connection, "SELECT title, views FROM posts ORDER BY views");

    expect(pairs.get("one")).toBe(10);
    expect(pairs.get("three")).toBe(30);
    expect(pairs.size).toBe(3);
  });
});

describe("the exec family", () => {
  it("reads rows", async () => {
    expect(await execQuery(connection, "SELECT title FROM posts")).toHaveLength(3);
  });

  /**
   * The count is what tells an optimistic update whether it won: an UPDATE
   * matching no rows changed nothing, and that is a conflict rather than a
   * success.
   */
  it("counts what an update changed", async () => {
    expect(await execUpdate(connection, "UPDATE posts SET views = 99 WHERE views < 25")).toBe(2);
  });

  it("counts zero for an update that matched nothing", async () => {
    expect(await execUpdate(connection, "UPDATE posts SET views = 1 WHERE views > 999")).toBe(0);
  });

  it("counts what a delete removed", async () => {
    expect(await execDelete(connection, "DELETE FROM posts WHERE views < 25")).toBe(2);
  });

  it("gives back the new row's key on insert", async () => {
    const id = await execInsert(connection, "INSERT INTO posts (title, views) VALUES ('four', 40)");

    expect(Number(id)).toBeGreaterThan(0);
  });

  it("inserts the row it says it did", async () => {
    const id = await execInsert(connection, "INSERT INTO posts (title, views) VALUES ('four', 40)");
    const title = await selectValue(connection, `SELECT title FROM posts WHERE id = ${String(id)}`);

    expect(title).toBe("four");
  });
});

describe("telling a read from a write", () => {
  it("recognises the read statements", () => {
    expect(isReadQuery("SELECT * FROM posts")).toBe(true);
    expect(isReadQuery("  select 1")).toBe(true);
    expect(isReadQuery("EXPLAIN SELECT 1")).toBe(true);
    expect(isReadQuery("SHOW TABLES")).toBe(true);
  });

  it("recognises the writes", () => {
    expect(isWriteQuery("INSERT INTO posts VALUES (1)")).toBe(true);
    expect(isWriteQuery("UPDATE posts SET a = 1")).toBe(true);
    expect(isWriteQuery("DELETE FROM posts")).toBe(true);
    expect(isWriteQuery("CREATE TABLE x (id int)")).toBe(true);
  });

  /** `WITH moved AS (DELETE ... RETURNING *) SELECT ...` is a write. */
  it("does not take a CTE carrying a write for a read", () => {
    expect(isReadQuery("WITH moved AS (DELETE FROM posts RETURNING *) SELECT * FROM moved")).toBe(
      false,
    );
  });

  it("takes a plain CTE for a read", () => {
    expect(isReadQuery("WITH recent AS (SELECT * FROM posts) SELECT * FROM recent")).toBe(true);
  });

  /** Sending a write to a replica fails loudly; a read to the primary costs a little. */
  it("guesses write for anything it does not recognise", () => {
    expect(isReadQuery("VACUUM")).toBe(false);
    expect(isReadQuery("")).toBe(false);
  });

  it("sees through a leading parenthesis", () => {
    expect(isReadQuery("(SELECT 1)")).toBe(true);
  });
});
