/**
 * Counter caches.
 *
 * Mirrors activerecord/test/cases/counter_cache_test.rb. The feature exists so
 * that a list of posts showing comment counts is one query rather than one per
 * post, so the tests check the column, not a method that recounts.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model, type BelongsTo } from "../src/model.js";

interface PostAttributes {
  id: number;
  title: string;
  comments_count: number | null;
  reviews_tally: number | null;
}

interface CommentAttributes {
  id: number;
  post_id: number | null;
  body: string;
}

class Post extends Model<PostAttributes>("posts") {}

class Comment extends Model<CommentAttributes>("comments") {
  declare post: BelongsTo<Post>;

  static {
    this.belongsTo("post", () => Post, { counterCache: true });
  }
}

/** A second child, to prove the column name can be chosen. */
class Review extends Model<CommentAttributes>("reviews") {
  declare post: BelongsTo<Post>;

  static {
    this.belongsTo("post", () => Post, { counterCache: "reviews_tally" });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);

  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("comments_count", { default: 0 });
    t.integer("reviews_tally", { default: 0 });
  });

  await schema.createTable("comments", (t) => {
    t.references("post");
    t.string("body");
  });

  await schema.createTable("reviews", (t) => {
    t.references("post");
    t.string("body");
  });
});

describe("counter caches", () => {
  it("counts up when a child is created", async () => {
    const post = await Post.create({ title: "Hello" });
    await Comment.create({ post_id: post.id, body: "First" });

    expect((await Post.find(post.id)).comments_count).toBe(1);
  });

  it("counts every child", async () => {
    const post = await Post.create({ title: "Hello" });
    await Comment.create({ post_id: post.id, body: "One" });
    await Comment.create({ post_id: post.id, body: "Two" });
    await Comment.create({ post_id: post.id, body: "Three" });

    expect((await Post.find(post.id)).comments_count).toBe(3);
  });

  it("counts down when a child is destroyed", async () => {
    const post = await Post.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: post.id, body: "First" });
    await Comment.create({ post_id: post.id, body: "Second" });

    await comment.destroy();

    expect((await Post.find(post.id)).comments_count).toBe(1);
  });

  it("keeps each parent's count to itself", async () => {
    const first = await Post.create({ title: "First" });
    const second = await Post.create({ title: "Second" });

    await Comment.create({ post_id: first.id, body: "a" });
    await Comment.create({ post_id: first.id, body: "b" });
    await Comment.create({ post_id: second.id, body: "c" });

    expect((await Post.find(first.id)).comments_count).toBe(2);
    expect((await Post.find(second.id)).comments_count).toBe(1);
  });

  it("uses the column it was given a name for", async () => {
    const post = await Post.create({ title: "Hello" });
    await Review.create({ post_id: post.id, body: "Good" });

    const reloaded = await Post.find(post.id);
    expect(reloaded.reviews_tally).toBe(1);
    expect(reloaded.comments_count).toBe(0);
  });

  // An orphan has no parent to count against, and looking one up would be a
  // query per save for nothing.
  it("does nothing for a child with no parent", async () => {
    await Post.create({ title: "Hello" });
    await Comment.create({ body: "orphan" });

    expect((await Post.find(1)).comments_count).toBe(0);
  });

  // A parent that predates the column has null in it, and null + 1 is null —
  // a counter that silently stops counting.
  it("starts counting from a null", async () => {
    await connection.execute("INSERT INTO posts (title, comments_count) VALUES (?, NULL)", [
      "Legacy",
    ]);

    await Comment.create({ post_id: 1, body: "First" });

    expect((await Post.find(1)).comments_count).toBe(1);
  });

  it("leaves a model without a counter cache alone", async () => {
    class Plain extends Model<CommentAttributes>("comments") {
      declare post: BelongsTo<Post>;

      static {
        this.belongsTo("post", () => Post);
      }
    }

    const post = await Post.create({ title: "Hello" });
    await Plain.create({ post_id: post.id, body: "no counting" });

    expect((await Post.find(post.id)).comments_count).toBe(0);
  });
});
