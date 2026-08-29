/**
 * Identifiers that are not identifiers.
 *
 * Mirrors the ground activerecord/test/cases/relation/where_test.rb and
 * sanitize_test.rb cover, and the reason Rails validates rather than escapes:
 * a column name cannot be a bound parameter, so every one of these reaches the
 * SQL as text or does not reach it at all.
 *
 * Most of this passed the first time it was run. That is the point of writing
 * it down — the checks exist, and nothing says so, which is how a later
 * refactor removes one without anybody noticing. The `order` clause taking a
 * column straight from a query string is the ordinary way this gets reached.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  secret: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

/** What a query string can hand a relation. */
const PAYLOADS = [
  "title; DROP TABLE posts--",
  "title FROM posts UNION SELECT secret FROM posts--",
  "title\" = 'x'; DROP TABLE posts--",
  "1=1",
  "*",
  "title, secret",
  "(SELECT secret FROM posts)",
  "title--",
  "",
  " ",
];

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.string("secret");
  });

  await Post.create({ title: "one", secret: "hunter2" });
});

describe("a column name that is not one", () => {
  // Checked when the SQL is built rather than when the clause is added, so
  // the assertion has to go as far as the query.
  it("is refused by order", () => {
    for (const payload of PAYLOADS) {
      expect(() => Post.all().order(payload).toSql()).toThrow();
    }
  });

  it("is refused by select", () => {
    for (const payload of PAYLOADS) {
      expect(() => Post.all().select(payload).toSql()).toThrow();
    }
  });

  it("is refused by group", () => {
    for (const payload of PAYLOADS) {
      expect(() => Post.all().group(payload).toSql()).toThrow();
    }
  });

  it("is refused as a where key", () => {
    for (const payload of PAYLOADS) {
      expect(() => Post.where({ [payload]: 1 } as never).toSql()).toThrow();
    }
  });

  it("is refused by updateAll", () => {
    for (const payload of PAYLOADS) {
      expect(Post.all().updateAll({ [payload]: 1 } as never)).rejects.toThrow();
    }
  });

  it("says which name it refused", () => {
    expect(() => Post.all().order("title; DROP TABLE posts--").toSql()).toThrow(
      /Invalid column name/,
    );
  });

  it("still allows an ordinary column", () => {
    expect(Post.all().order("title").toSql().sql).toContain("ORDER BY");
    expect(Post.all().select("title", "secret").toSql().sql).toContain("secret");
  });

  // A condition may name a joined table, and only a joined one — otherwise a
  // relation could reach a table its query never mentions.
  it("allows a dotted name only for a table that was joined", () => {
    expect(() => Post.all().select("comments.body").toSql()).toThrow(/does not join/);
    expect(Post.all().select("posts.title").toSql().sql).toContain("title");
  });
});

describe("a value", () => {
  // Values are bound, so nothing here needs escaping — but a test saying so
  // is what keeps someone from "fixing" it into interpolation later.
  it("is bound rather than interpolated", () => {
    const { sql, bindings } = Post.where({ title: "x'; DROP TABLE posts--" }).toSql();

    expect(sql).not.toContain("DROP");
    expect(bindings).toContain("x'; DROP TABLE posts--");
  });

  it("is bound one placeholder per entry for an IN", () => {
    const { sql, bindings } = Post.where({ id: [1, 2, 3] } as never).toSql();

    expect(sql).toContain("IN (");
    expect(bindings).toHaveLength(3);
  });

  it("survives being stored and read back whole", async () => {
    const payload = "x'; DROP TABLE posts--";
    await Post.create({ title: payload, secret: "s" });

    expect(((await Post.findBy({ title: payload })) as Post).title).toBe(payload);
  });
});

// Rails patched exactly this: an annotation that closes its own comment turns
// the rest of the string into statements.
describe("an annotation", () => {
  it("cannot close the comment it sits in", () => {
    const { sql } = Post.all().annotate("*/ UNION SELECT secret FROM posts--").toSql();

    expect(sql).not.toContain("*/ UNION");
    expect(sql.split("*/")).toHaveLength(2);
  });

  it("still says what it was asked to say", () => {
    expect(Post.all().annotate("dashboard").toSql().sql).toContain("dashboard");
  });
});

/**
 * `LIMIT` and `OFFSET` cannot be bound, so the number is interpolated —
 * through `Number`, which is what stops a string being SQL. What survived that
 * was the text `NaN`, and the failure arrived from the database as a syntax
 * error pointing at generated SQL.
 */
describe("a row count", () => {
  it("is refused when it is not a number", () => {
    expect(() => Post.all().limit(Number.NaN)).toThrow(TypeError);
    expect(() => Post.all().offset(Number.NaN)).toThrow(TypeError);
  });

  // What `limit(Number(params.get("per_page")))` does with no per_page.
  it("is refused rather than reaching the database as NaN", () => {
    expect(() => Post.all().limit(Number(undefined))).toThrow(/whole number/);
  });

  it("is refused when it is not whole, or is negative", () => {
    expect(() => Post.all().limit(1.5)).toThrow(TypeError);
    expect(() => Post.all().limit(-1)).toThrow(TypeError);
    expect(() => Post.all().offset(-1)).toThrow(TypeError);
  });

  it("is refused when a string sneaks past the types", () => {
    expect(() => Post.all().limit("5" as never)).toThrow(TypeError);
    expect(() => Post.all().limit("1; DROP TABLE posts--" as never)).toThrow(TypeError);
  });

  it("allows nothing, which is a real page size", () => {
    expect(Post.all().limit(0).toSql().sql).toContain("LIMIT 0");
  });

  it("allows an ordinary count", async () => {
    expect(await Post.all().limit(10).offset(0)).toHaveLength(1);
  });
});
