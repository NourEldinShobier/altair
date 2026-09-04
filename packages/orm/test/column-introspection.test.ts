/**
 * Column introspection and the multi-counter updates, ported from
 * `activerecord/test/cases/column_definition_test.rb` and
 * `counter_cache_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  body: string | null;
  author_id: number | null;
  comments_count: number | null;
  views: number | null;
  created_at: Date;
  updated_at: Date;
}

interface CommentRow {
  id: number;
  post_id: number;
}

class Post extends Model<PostRow>("posts") {
  declare comments: () => unknown;
}
class Comment extends Model<CommentRow>("comments") {}

Post.hasMany("comments", () => Comment, { foreignKey: "post_id", counterCache: true });

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.resetColumnInformation();
  Comment.resetColumnInformation();

  const schema = new SchemaStatements(connection);

  await schema.createTable("posts", (t) => {
    t.string("title");
    t.string("body");
    t.integer("author_id");
    t.integer("comments_count");
    t.integer("views");
    t.timestamps();
  });

  await schema.createTable("comments", (t) => {
    t.integer("post_id");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("columnsHash", () => {
  it("keys the schemas by name", async () => {
    const hash = await Post.columnsHash();

    expect(Object.keys(hash)).toContain("title");
    expect(hash.title?.name).toBe("title");
  });

  /** More than the type alone, which is why a form builder wants it. */
  it("reports nullability", async () => {
    const hash = await Post.columnsHash();

    expect(hash.title?.nullable).toBeDefined();
  });

  it("marks the primary key", async () => {
    const hash = await Post.columnsHash();

    expect(hash.id?.primaryKey).toBe(true);
    expect(hash.title?.primaryKey).toBe(false);
  });

  it("finds one column", async () => {
    expect((await Post.columnForAttribute("title"))?.name).toBe("title");
  });

  it("gives undefined for a column that is not there", async () => {
    expect(await Post.columnForAttribute("nope")).toBeUndefined();
  });

  it("gives one column's logical type", async () => {
    expect(await Post.typeForAttribute("title")).toBeDefined();
    expect(await Post.typeForAttribute("nope")).toBeUndefined();
  });
});

describe("columnDefaults", () => {
  it("names every column", async () => {
    const defaults = await Post.columnDefaults();

    expect(Object.keys(defaults)).toContain("title");
    expect(Object.keys(defaults)).toContain("views");
  });
});

describe("contentColumns", () => {
  /** Exactly what a scaffold puts on a form. */
  it("keeps the columns a person types", async () => {
    const columns = await Post.contentColumns();

    expect(columns).toContain("title");
    expect(columns).toContain("body");
  });

  it("drops the primary key", async () => {
    expect(await Post.contentColumns()).not.toContain("id");
  });

  it("drops the timestamps", async () => {
    const columns = await Post.contentColumns();

    expect(columns).not.toContain("created_at");
    expect(columns).not.toContain("updated_at");
  });

  it("drops the foreign keys", async () => {
    expect(await Post.contentColumns()).not.toContain("author_id");
  });
});

describe("updateCounters", () => {
  it("adds to a counter", async () => {
    const post = await Post.create({ title: "Hi", comments_count: 2 });
    await Post.updateCounters(post.id, { comments_count: 1 });

    expect((await Post.find(post.id)).comments_count).toBe(3);
  });

  /** One statement, so another writer cannot interleave between the two. */
  it("moves several counters at once", async () => {
    const post = await Post.create({ title: "Hi", comments_count: 2, views: 10 });
    await Post.updateCounters(post.id, { comments_count: 1, views: 5 });

    const found = await Post.find(post.id);

    expect(found.comments_count).toBe(3);
    expect(found.views).toBe(15);
  });

  it("subtracts with a negative", async () => {
    const post = await Post.create({ title: "Hi", comments_count: 2 });
    await Post.updateCounters(post.id, { comments_count: -1 });

    expect((await Post.find(post.id)).comments_count).toBe(1);
  });

  /** Otherwise a null counter stays null forever: null + 1 is null. */
  it("treats a null counter as zero", async () => {
    const post = await Post.create({ title: "Hi", comments_count: null });
    await Post.updateCounters(post.id, { comments_count: 1 });

    expect((await Post.find(post.id)).comments_count).toBe(1);
  });

  it("does nothing when given nothing", async () => {
    const post = await Post.create({ title: "Hi", comments_count: 2 });
    await Post.updateCounters(post.id, {});

    expect((await Post.find(post.id)).comments_count).toBe(2);
  });

  it("refuses a column that is not there", async () => {
    const post = await Post.create({ title: "Hi" });

    expect(Post.updateCounters(post.id, { "x; DROP TABLE posts": 1 })).rejects.toThrow(
      /Invalid column name/,
    );
  });
});

describe("resetCounters", () => {
  it("names the counter column by convention", () => {
    expect(Post.counterCacheColumn("comments")).toBe("comments_count");
  });

  /**
   * A counter drifts — a row deleted straight from SQL, a bulk insert that
   * skipped callbacks — and nothing notices, because nobody counts.
   */
  it("recounts from the rows", async () => {
    const post = await Post.create({ title: "Hi", comments_count: 99 });
    await Comment.create({ post_id: post.id });
    await Comment.create({ post_id: post.id });

    await Post.resetCounters(post.id, "comments");

    expect((await Post.find(post.id)).comments_count).toBe(2);
  });

  it("writes zero when there is nothing to count", async () => {
    const post = await Post.create({ title: "Hi", comments_count: 7 });
    await Post.resetCounters(post.id, "comments");

    expect((await Post.find(post.id)).comments_count).toBe(0);
  });

  it("counts only this record's rows", async () => {
    const post = await Post.create({ title: "Hi" });
    const other = await Post.create({ title: "Other" });
    await Comment.create({ post_id: post.id });
    await Comment.create({ post_id: other.id });

    await Post.resetCounters(post.id, "comments");

    expect((await Post.find(post.id)).comments_count).toBe(1);
  });
});
