/**
 * Many-to-many with no model in the middle, ported from
 * `activerecord/test/cases/associations/habtm_join_table_test.rb` and
 * `has_and_belongs_to_many_associations_test.rb`.
 *
 * The shape for a pairing with nothing to say about itself. The moment it has
 * something to say — when it was made, by whom, whether it is approved — it
 * wants a real model, and `hasManyThrough` is the tool.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;

class Tag extends Model<{ id: number; name: string }>("tags") {}
class Post extends Model<{ id: number; title: string }>("posts") {
  declare tags: () => Promise<Tag[]>;
  declare tagIds: () => Promise<unknown[]>;
  declare setTagIds: (ids: readonly unknown[]) => Promise<void>;
}

Post.hasAndBelongsToMany("tags", () => Tag);

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("tags", (t) => t.string("name"));

  // No id of its own, which is what a HABTM join table looks like in Rails.
  // Built through the schema statements rather than as raw SQL, so the column
  // type matches whatever the adapter gave the primary keys — Postgres makes
  // them BIGSERIAL, and an INTEGER foreign key will not compare against one.
  // A HABTM join table has no id of its own, which is why the columns are
  // added rather than declared with `createTable`'s implicit key.
  await new SchemaStatements(connection).createTable(
    "posts_tags",
    (t) => {
      t.bigint("post_id");
      t.bigint("tag_id");
    },
    { id: false },
  );

  Post.resetColumnInformation();
  Tag.resetColumnInformation();
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

const seed = async () => {
  const post = await Post.create({ title: "Hello" });
  const ruby = await Tag.create({ name: "ruby" });
  const bun = await Tag.create({ name: "bun" });

  return { post, ruby, bun };
};

describe("reading across the join", () => {
  it("finds nothing before anything is linked", async () => {
    const { post } = await seed();

    expect(await post.tags()).toEqual([]);
  });

  it("finds what was linked", async () => {
    const { post, ruby, bun } = await seed();
    await post.setTagIds([ruby.id, bun.id]);

    const names = (await post.tags()).map((tag) => tag.name).sort();

    expect(names).toEqual(["bun", "ruby"]);
  });

  it("keeps one post's tags out of another's", async () => {
    const { post, ruby, bun } = await seed();
    const other = await Post.create({ title: "Other" });

    await post.setTagIds([ruby.id]);
    await other.setTagIds([bun.id]);

    expect((await post.tags()).map((tag) => tag.name)).toEqual(["ruby"]);
    expect((await other.tags()).map((tag) => tag.name)).toEqual(["bun"]);
  });

  it("hands back just the ids, for a form", async () => {
    const { post, ruby } = await seed();
    await post.setTagIds([ruby.id]);

    expect(await post.tagIds()).toEqual([ruby.id]);
  });
});

describe("changing what is linked", () => {
  it("adds and removes to match what it was given", async () => {
    const { post, ruby, bun } = await seed();

    await post.setTagIds([ruby.id]);
    await post.setTagIds([bun.id]);

    expect(await post.tagIds()).toEqual([bun.id]);
  });

  it("clears them all", async () => {
    const { post, ruby, bun } = await seed();
    await post.setTagIds([ruby.id, bun.id]);
    await post.setTagIds([]);

    expect(await post.tagIds()).toEqual([]);
  });

  /**
   * A diff rather than delete-then-insert: a form submission that changed
   * nothing should not churn the table, and on a database with a foreign key
   * onto the join row it would break whatever points at it.
   */
  it("leaves an unchanged row alone rather than rewriting it", async () => {
    const { post, ruby, bun } = await seed();
    await post.setTagIds([ruby.id]);

    // Counted rather than compared: SQLite hands a deleted row's rowid
    // straight back to the next insert, so "the row looks the same" is true
    // even when it was destroyed and remade. The statements are the evidence.
    const statements: string[] = [];
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql: string, bindings?: readonly unknown[]) => {
      statements.push(sql);
      return await execute(sql, bindings);
    };

    try {
      await post.setTagIds([ruby.id, bun.id]);
    } finally {
      connection.execute = execute;
    }

    const touched = statements.filter((sql) => sql.includes("posts_tags"));

    expect(touched.filter((sql) => sql.startsWith("DELETE"))).toHaveLength(0);
    expect(touched.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1);
  });

  it("does not duplicate a link that is already there", async () => {
    const { post, ruby } = await seed();

    await post.setTagIds([ruby.id]);
    await post.setTagIds([ruby.id]);

    expect(await connection.query("SELECT * FROM posts_tags")).toHaveLength(1);
  });

  /**
   * A stale association is worse than an unloaded one: it looks like an
   * answer.
   */
  it("forgets what it had already loaded", async () => {
    const { post, ruby, bun } = await seed();
    await post.setTagIds([ruby.id]);

    expect((await post.tags()).map((tag) => tag.name)).toEqual(["ruby"]);

    await post.setTagIds([bun.id]);

    expect((await post.tags()).map((tag) => tag.name)).toEqual(["bun"]);
  });

  it("refuses on a record with no id to point at", async () => {
    const post = new Post({ title: "Unsaved" });

    await expect(post.setTagIds([1])).rejects.toThrow(/must be saved/);
  });
});

/**
 * The reason this is built on `hasManyThrough` rather than beside it: reads,
 * preloading and `includes` are the same code, so they cannot drift apart.
 */
describe("preloading", () => {
  it("loads every post's tags without a query per post", async () => {
    const { ruby, bun } = await seed();
    const second = await Post.create({ title: "Second" });

    const first = (await Post.where({ title: "Hello" }).first())!;
    await first.setTagIds([ruby.id]);
    await second.setTagIds([bun.id]);

    const posts = await Post.all().includes("tags").order("id");

    // Loaded, so reading the association runs nothing further.
    const names = posts.map((post) => (post as Post).tags());

    expect((await names[0]!).map((tag) => tag.name)).toEqual(["ruby"]);
    expect((await names[1]!).map((tag) => tag.name)).toEqual(["bun"]);
  });
});

describe("the join table's name", () => {
  it("is both tables sorted, as Rails spells it", async () => {
    // `posts_tags`, not `tags_posts` — the table created above is the one the
    // association found, which is the assertion.
    const { post, ruby } = await seed();
    await post.setTagIds([ruby.id]);

    expect(await connection.query("SELECT * FROM posts_tags")).toHaveLength(1);
  });

  it("can be named explicitly", async () => {
    await new SchemaStatements(connection).createTable(
      "taggings",
      (t) => {
        t.bigint("article_id");
        t.bigint("tag_id");
      },
      { id: false },
    );

    class Article extends Model<{ id: number; title: string }>("posts") {
      declare setTagIds: (ids: readonly unknown[]) => Promise<void>;
      declare tags: () => Promise<Tag[]>;
    }
    Article.hasAndBelongsToMany("tags", () => Tag, { joinTable: "taggings" });

    const article = await Article.create({ title: "A" });
    const tag = await Tag.create({ name: "x" });
    await article.setTagIds([tag.id]);

    expect(await connection.query("SELECT * FROM taggings")).toHaveLength(1);
  });
});
