/**
 * Common table expressions, ported from
 * `activerecord/test/cases/relation/with_test.rb` and the `from` cases in
 * `activerecord/test/cases/relations_test.rb`.
 *
 * The recursive form is the one that earns its keep. A tree — a comment
 * thread, an org chart, a category hierarchy — cannot be fetched in one round
 * trip any other way. The alternatives are a query per level, which is a round
 * trip per level of depth and unbounded, or a materialized path column, which
 * is a second copy of the tree that has to be kept correct on every move.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface CommentRow {
  id: number;
  parent_id: number | null;
  body: string;
}

class Comment extends Model<CommentRow>("comments") {}

interface PostRow {
  id: number;
  title: string;
  status: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

const sqlOf = (relation: { toSql(): { sql: string } }) => relation.toSql().sql;

/**
 * An identifier quoted the way the database running these tests quotes it.
 *
 * Written out, `"posts"` is only correct on SQLite and PostgreSQL — MySQL uses
 * backticks — so a hard-coded assertion is really asserting which adapter is
 * running. Asking the connection makes the test say what it means: that the
 * name was quoted, not that it was quoted in one particular dialect.
 */
const q = (name: string) => connection.quote(name);

/** The same for a bind placeholder: `?` on SQLite and MySQL, `$1` on PostgreSQL. */
const ph = (index = 0) => connection.placeholder(index);

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Comment, Post]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  await schema.createTable("comments", (t) => {
    t.integer("parent_id");
    t.string("body");
  });

  await schema.createTable("posts", (t) => {
    t.string("title");
    t.string("status");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("with", () => {
  it("puts the expression in front of the select", () => {
    const sql = sqlOf(Post.with({ recent: Post.where({ status: "published" }) }));

    expect(sql.startsWith("WITH ")).toBe(true);
    expect(sql).toContain("SELECT");
  });

  it("names it", () => {
    const sql = sqlOf(Post.with({ recent: Post.where({ status: "published" }) }));

    expect(sql).toContain(`${q("recent")} AS (`);
  });

  it("is not recursive unless asked", () => {
    expect(sqlOf(Post.with({ recent: Post.all() }))).not.toContain("RECURSIVE");
  });

  it("takes several at once", () => {
    const sql = sqlOf(
      Post.with({
        drafts: Post.where({ status: "draft" }),
        published: Post.where({ status: "published" }),
      }),
    );

    expect(sql).toContain(`${q("drafts")} AS (`);
    expect(sql).toContain(`${q("published")} AS (`);
  });

  /**
   * Two definitions of one name in a single clause is a syntax error the
   * database reports about a name the caller only wrote once.
   */
  it("replaces a name rather than defining it twice", () => {
    const sql = sqlOf(
      Post.with({ recent: Post.where({ status: "draft" }) }).with({
        recent: Post.where({ status: "published" }),
      }),
    );

    expect(sql.split(`${q("recent")} AS (`)).toHaveLength(2);
  });

  it("takes raw sql with its own bindings", () => {
    const { sql, bindings } = Post.with({
      recent: { sql: `SELECT * FROM posts WHERE status = ${ph()}`, bindings: ["published"] },
    }).toSql();

    expect(sql).toContain(`${q("recent")} AS (SELECT * FROM posts WHERE status = ${ph()})`);
    expect(bindings).toEqual(["published"]);
  });

  /**
   * WITH comes first in the statement, so its placeholders are the first ones
   * counted from the left. Pushed after the WHERE's, every binding in the
   * query would be off by the number the expression carried.
   */
  it("binds the expression before the rest of the query", () => {
    const { bindings } = Post.with({
      recent: { sql: "SELECT * FROM posts WHERE status = ?", bindings: ["published"] },
    })
      .where({ title: "a" })
      .toSql();

    expect(bindings).toEqual(["published", "a"]);
  });

  it("does not change a relation it was called on", () => {
    const base = Post.where({ status: "draft" });

    base.with({ recent: Post.all() });

    expect(sqlOf(base)).not.toContain("WITH");
  });

  it("runs", async () => {
    await Post.create({ title: "a", status: "published" });
    await Post.create({ title: "b", status: "draft" });

    const found = await Post.with({ recent: Post.where({ status: "published" }) }).from("recent");

    expect(found.map((one) => one.title)).toEqual(["a"]);
  });
});

describe("withRecursive", () => {
  it("says RECURSIVE", () => {
    const sql = sqlOf(
      Comment.withRecursive({ thread: { sql: "SELECT * FROM comments WHERE id = 1" } }),
    );

    expect(sql).toContain("WITH RECURSIVE ");
  });

  /**
   * RECURSIVE is a property of the whole clause rather than of one expression,
   * which is what the standard says and what every database implements.
   */
  it("makes the whole clause recursive when mixed with a plain one", () => {
    const sql = sqlOf(
      Comment.with({ roots: Comment.where({ parent_id: null }) }).withRecursive({
        thread: { sql: "SELECT * FROM comments" },
      }),
    );

    expect(sql.match(/RECURSIVE/g)).toHaveLength(1);
    expect(sql).toContain(`${q("roots")} AS (`);
    expect(sql).toContain(`${q("thread")} AS (`);
  });

  /** The whole point: a tree in one round trip. */
  it("walks a tree in one query", async () => {
    const root = await Comment.create({ parent_id: null, body: "root" });
    const child = await Comment.create({ parent_id: root.id, body: "child" });
    await Comment.create({ parent_id: child.id, body: "grandchild" });
    await Comment.create({ parent_id: null, body: "elsewhere" });

    const thread = await Comment.withRecursive({
      thread: {
        sql: `SELECT id, parent_id, body FROM comments WHERE id = ?
              UNION ALL
              SELECT c.id, c.parent_id, c.body FROM comments c
              JOIN thread ON c.parent_id = thread.id`,
        bindings: [root.id],
      },
    })
      .from("thread")
      .order("id");

    expect(thread.map((one) => one.body)).toEqual(["root", "child", "grandchild"]);
  });

  it("leaves out what is not in the tree", async () => {
    const root = await Comment.create({ parent_id: null, body: "root" });
    await Comment.create({ parent_id: null, body: "elsewhere" });

    const thread = await Comment.withRecursive({
      thread: {
        sql: `SELECT id, parent_id, body FROM comments WHERE id = ?
              UNION ALL
              SELECT c.id, c.parent_id, c.body FROM comments c
              JOIN thread ON c.parent_id = thread.id`,
        bindings: [root.id],
      },
    }).from("thread");

    expect(thread.map((one) => one.body)).toEqual(["root"]);
  });
});

describe("from", () => {
  it("selects from what it was given", () => {
    expect(sqlOf(Post.from("archived_posts"))).toContain(`FROM ${q("archived_posts")}`);
  });

  /** Every join and every `table.*` has to follow it or they name a table
   * the statement no longer selects. */
  it("qualifies the star against it", () => {
    expect(sqlOf(Post.from("archived_posts"))).toContain(`${q("archived_posts")}.*`);
  });

  it("carries the rest of the query", () => {
    const sql = sqlOf(Post.from("archived_posts").where({ status: "draft" }).order("title"));

    expect(sql).toContain(`FROM ${q("archived_posts")}`);
    expect(sql).toContain("WHERE");
    expect(sql).toContain("ORDER BY");
  });

  /**
   * Validated rather than escaped, like every other identifier here. Quoting a
   * name with a quote in it produces something inert but nonsensical, and a
   * caller who reached this with a value from a parameter should be told
   * rather than handed a query against a table nobody named.
   */
  it("refuses a name that is not a plain identifier", () => {
    expect(() => Post.from('posts"; DROP TABLE posts; --')).toThrow("Invalid table name");
    expect(() => Post.from("posts posts")).toThrow("Invalid table name");
    expect(() => Post.from("")).toThrow("Invalid table name");
  });

  it("does not change a relation it was called on", () => {
    const base = Post.all();

    base.from("archived_posts");

    expect(sqlOf(base)).toContain('FROM "posts"');
  });
});
