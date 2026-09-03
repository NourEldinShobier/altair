/**
 * The first row's values, ported from
 * `activerecord/test/cases/calculations_test.rb`.
 *
 * `pluck(...)[0]` reads the same and is not the same: it selects every matching
 * row and throws all but one away. On a table of any size that is the
 * difference between reading one row and reading the table.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

class Post extends Model<{ id: number; title: string; views: number }>("posts") {}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("views");
  });

  Post.resetColumnInformation();

  await Post.create({ title: "First", views: 10 });
  await Post.create({ title: "Second", views: 20 });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("one column", () => {
  it("gives the first row's value", async () => {
    expect(await Post.all().order("id").pick("title")).toBe("First");
  });

  it("follows the conditions", async () => {
    expect(await Post.where({ title: "Second" }).pick("views")).toBe(20);
  });

  it("follows the ordering", async () => {
    expect(await Post.all().order("id", "desc").pick("title")).toBe("Second");
  });

  /**
   * Null rather than undefined, matching `first`, so the two can be checked
   * the same way.
   */
  it("is null when nothing matches", async () => {
    expect(await Post.where({ title: "nope" }).pick("title")).toBeNull();
  });
});

describe("several columns", () => {
  it("gives them as a row", async () => {
    expect(await Post.all().order("id").pick("title", "views")).toEqual(["First", 10]);
  });

  it("keeps them in the order asked for", async () => {
    expect(await Post.all().order("id").pick("views", "title")).toEqual([10, "First"]);
  });

  it("is null when nothing matches", async () => {
    expect(await Post.where({ title: "nope" }).pick("title", "views")).toBeNull();
  });
});

describe("what it reads", () => {
  /**
   * The whole reason this exists rather than `pluck(...)[0]`.
   */
  it("asks for one row, not every row", async () => {
    const statements: string[] = [];
    const query = connection.query.bind(connection);

    connection.query = async <T>(sql: string, bindings?: readonly unknown[]) => {
      statements.push(sql);
      return (await query(sql, bindings)) as T[];
    };

    try {
      await Post.all().pick("title");
    } finally {
      connection.query = query;
    }

    expect(statements.at(-1)?.toUpperCase()).toContain("LIMIT 1");
  });

  it("refuses to pick nothing", async () => {
    await expect(Post.all().pick()).rejects.toThrow(/at least one column/);
  });
});
