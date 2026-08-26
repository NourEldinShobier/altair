/**
 * Saving a record that had an association preloaded.
 *
 * The preload cache was stored among the record's attributes, because the
 * model proxy turns anything it does not recognise into one — which is what
 * makes `post.title = "x"` work without declaring a column, and what caught
 * `__preloaded_comments` as well.
 *
 * So `changed()` listed it and the next save built an UPDATE naming a column
 * that does not exist:
 *
 *     Post.all().includes("comments")  ->  edit  ->  save
 *     SQLiteError: no such column: __preloaded_comments
 *
 * Which is an ordinary thing to do. Nothing covered it because the preloading
 * tests read associations and the saving tests did not preload.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface PostRow {
  id: number;
  title: string;
}

interface CommentRow {
  id: number;
  post_id: number;
  body: string;
}

class Comment extends Model<CommentRow>("comments") {
  declare post: () => Promise<Post | null>;
  static {
    this.belongsTo("post", () => Post, { optional: true });
  }
}

class Post extends Model<PostRow>("posts") {
  declare comments: () => Promise<Comment[]>;
  static {
    this.hasMany("comments", () => Comment);
  }
}

let connection: Connection;
let post: Post;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);

  for (const model of [Post, Comment]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);
  await schema.dropTable("comments", { ifExists: true });
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("comments", (t) => {
    t.bigint("post_id");
    t.text("body");
  });

  post = await Post.create({ title: "one" });
  await Comment.create({ post_id: post.id, body: "a" });
});

describe("a record with a preloaded association", () => {
  it("keeps the cache out of its attributes", async () => {
    const [loaded] = await Post.all().includes("comments");

    expect(Object.keys((loaded as Post).attributes())).toEqual(["id", "title"]);
  });

  it("does not report the cache as a change", async () => {
    const [loaded] = await Post.all().includes("comments");
    (loaded as Post).title = "changed";

    expect((loaded as Post).changed()).toEqual(["title"]);
  });

  // The failure itself.
  it("saves", async () => {
    const [loaded] = await Post.all().includes("comments");
    (loaded as Post).title = "changed";

    expect(await (loaded as Post).save()).toBe(true);
    expect(((await Post.findBy({ id: post.id })) as Post).title).toBe("changed");
  });

  it("saves when nothing but the association was touched", async () => {
    const [loaded] = await Post.all().includes("comments");

    expect(await (loaded as Post).save()).toBe(true);
  });

  it("does the same for a belongsTo", async () => {
    const [loaded] = await Comment.all().includes("post");
    (loaded as Comment).body = "edited";

    expect(await (loaded as Comment).save()).toBe(true);
    expect(Object.keys((loaded as Comment).attributes())).not.toContain("__preloaded_post");
  });

  // The cache still has to work, which is the other half of the fix: it is
  // kept off the attributes rather than thrown away.
  it("still reads the association without another query", async () => {
    const [loaded] = await Post.all().includes("comments");
    const comments = await (loaded as Post).comments();

    expect(comments).toHaveLength(1);
    expect(String(comments[0]?.body)).toBe("a");
  });

  it("still holds it after the record is saved", async () => {
    const [loaded] = await Post.all().includes("comments");
    (loaded as Post).title = "changed";
    await (loaded as Post).save();

    expect(await (loaded as Post).comments()).toHaveLength(1);
  });

  it("keeps it out of toJSON as well", async () => {
    const [loaded] = await Post.all().includes("comments");

    expect(Object.keys((loaded as Post).toJSON())).not.toContain("__preloaded_comments");
  });
});
