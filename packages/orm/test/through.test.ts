/**
 * Through and polymorphic associations.
 *
 * Mirrors activerecord/test/cases/associations/has_many_through_associations_test.rb
 * and the polymorphic association tests.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model, type BelongsTo, type HasMany } from "../src/model.js";

interface AuthorAttributes {
  id: number;
  name: string;
}
interface PostAttributes {
  id: number;
  title: string;
  author_id: number | null;
}
interface CommentAttributes {
  id: number;
  body: string;
  post_id: number | null;
  commentable_id: number | null;
  commentable_type: string | null;
}

class Author extends Model<AuthorAttributes>("authors") {
  declare posts: HasMany<Post>;
  declare comments: HasMany<Comment>;
}
class Post extends Model<PostAttributes>("posts") {
  declare author: BelongsTo<Author>;
  declare comments: HasMany<Comment>;
}
class Comment extends Model<CommentAttributes>("comments") {
  declare post: BelongsTo<Post>;
  declare commentable: BelongsTo<Post | Author>;
}

Author.hasMany("posts", () => Post);
// Rails: has_many :comments, through: :posts
Author.hasManyThrough("comments", "posts");
Post.belongsTo("author", () => Author, { optional: true });
Post.hasMany("comments", () => Comment);
Comment.belongsTo("post", () => Post, { optional: true });
Comment.belongsToPolymorphic("commentable", { Post: () => Post, Author: () => Author });

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("authors", (t) => t.string("name"));
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.references("author");
  });
  await schema.createTable("comments", (t) => {
    t.text("body");
    t.references("post");
    t.integer("commentable_id");
    t.string("commentable_type");
  });
});

describe("has many through", () => {
  it("reaches the target through the intermediate association", async () => {
    const ada = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "One", author_id: ada.id });
    await Comment.create({ body: "first", post_id: post.id });
    await Comment.create({ body: "second", post_id: post.id });

    const comments = await ada.comments();
    expect(comments.map((comment) => comment.body).sort()).toEqual(["first", "second"]);
  });

  it("collects across several intermediates", async () => {
    const ada = await Author.create({ name: "Ada" });
    const first = await Post.create({ title: "One", author_id: ada.id });
    const second = await Post.create({ title: "Two", author_id: ada.id });

    await Comment.create({ body: "a", post_id: first.id });
    await Comment.create({ body: "b", post_id: second.id });

    expect(await ada.comments()).toHaveLength(2);
  });

  it("returns nothing when the intermediate is empty", async () => {
    const author = await Author.create({ name: "Silent" });
    expect(await author.comments()).toHaveLength(0);
  });

  it("does not pick up another author's comments", async () => {
    const ada = await Author.create({ name: "Ada" });
    const alan = await Author.create({ name: "Alan" });

    const adaPost = await Post.create({ title: "A", author_id: ada.id });
    const alanPost = await Post.create({ title: "B", author_id: alan.id });

    await Comment.create({ body: "ada's", post_id: adaPost.id });
    await Comment.create({ body: "alan's", post_id: alanPost.id });

    expect((await ada.comments()).map((c) => c.body)).toEqual(["ada's"]);
  });

  // The point of preloading a through association: two queries per hop for the
  // whole set, not two per record.
  it("preloads for a whole result set", async () => {
    const ada = await Author.create({ name: "Ada" });
    const alan = await Author.create({ name: "Alan" });

    for (const [author, title] of [
      [ada, "A1"],
      [ada, "A2"],
      [alan, "B1"],
    ] as const) {
      const post = await Post.create({ title, author_id: author.id });
      await Comment.create({ body: `on ${title}`, post_id: post.id });
    }

    const authors = await Author.all().order("name").includes("comments");
    const counts = [];
    for (const author of authors) counts.push((await author.comments()).length);

    expect(counts).toEqual([2, 1]);
  });

  it("explains what went wrong if the target is queried directly", () => {
    const definition = Author.associationFor("comments");
    expect(() => definition.target()).toThrow('loads via "posts"');
  });
});

describe("polymorphic belongsTo", () => {
  it("loads the record its type column names", async () => {
    const post = await Post.create({ title: "One" });
    const author = await Author.create({ name: "Ada" });

    const onPost = await Comment.create({
      body: "about a post",
      commentable_id: post.id,
      commentable_type: "Post",
    });
    const onAuthor = await Comment.create({
      body: "about an author",
      commentable_id: author.id,
      commentable_type: "Author",
    });

    expect(((await onPost.commentable()) as PostAttributes).title).toBe("One");
    expect(((await onAuthor.commentable()) as AuthorAttributes).name).toBe("Ada");
  });

  it("returns null when there is no target", async () => {
    const comment = await Comment.create({ body: "orphan" });
    expect(await comment.commentable()).toBeNull();
  });

  // One query per type, not one per record.
  it("preloads each type in its own query", async () => {
    const post = await Post.create({ title: "One" });
    const author = await Author.create({ name: "Ada" });

    await Comment.create({ body: "p1", commentable_id: post.id, commentable_type: "Post" });
    await Comment.create({ body: "p2", commentable_id: post.id, commentable_type: "Post" });
    await Comment.create({ body: "a1", commentable_id: author.id, commentable_type: "Author" });

    const comments = await Comment.all().order("body").includes("commentable");
    const targets = [];
    for (const comment of comments) targets.push(await comment.commentable());

    expect(targets.filter(Boolean)).toHaveLength(3);
  });

  it("reports an unregistered type", async () => {
    const comment = await Comment.create({
      body: "mystery",
      commentable_id: 1,
      commentable_type: "Widget",
    });

    await expect(comment.commentable()).rejects.toThrow('no class registered for type "Widget"');
  });
});

// The other half of a polymorphic pair. `belongsToPolymorphic` lets a comment
// name whatever it is attached to; this lets the thing it is attached to ask
// for its comments back.
describe("hasMany as", () => {
  class Article extends Model<PostAttributes>("posts") {
    declare remarks: HasMany<Comment>;

    static {
      this.hasMany("remarks", () => Comment, { as: "commentable" });
    }
  }

  class Writer extends Model<AuthorAttributes>("authors") {
    declare remarks: HasMany<Comment>;

    static {
      this.hasMany("remarks", () => Comment, { as: "commentable" });
    }
  }

  it("loads the children pointing back at it", async () => {
    const article = await Article.create({ title: "One" });
    await Comment.create({
      body: "first",
      commentable_id: article.id,
      commentable_type: "Article",
    });
    await Comment.create({
      body: "second",
      commentable_id: article.id,
      commentable_type: "Article",
    });

    const remarks = await article.remarks();
    expect(remarks.map((remark) => remark.body).sort()).toEqual(["first", "second"]);
  });

  // Matching only the id would hand back another table's children whenever the
  // ids happened to collide, which for two tables counting from 1 is always.
  it("does not pick up another type's children with the same id", async () => {
    const article = await Article.create({ title: "One" });
    const writer = await Writer.create({ name: "Ada" });

    await Comment.create({
      body: "on the article",
      commentable_id: article.id,
      commentable_type: "Article",
    });
    await Comment.create({
      body: "on the writer",
      commentable_id: writer.id,
      commentable_type: "Writer",
    });

    expect(article.id).toBe(writer.id);
    expect((await article.remarks()).map((r) => r.body)).toEqual(["on the article"]);
    expect((await writer.remarks()).map((r) => r.body)).toEqual(["on the writer"]);
  });

  it("returns nothing when there are none", async () => {
    const article = await Article.create({ title: "Quiet" });
    expect(await article.remarks()).toHaveLength(0);
  });

  it("stays chainable", async () => {
    const article = await Article.create({ title: "One" });
    await Comment.create({ body: "keep", commentable_id: article.id, commentable_type: "Article" });
    await Comment.create({ body: "drop", commentable_id: article.id, commentable_type: "Article" });

    const kept = await article.remarks().where({ body: "keep" });
    expect(kept.map((remark) => remark.body)).toEqual(["keep"]);
  });

  it("preloads without a query per owner", async () => {
    const first = await Article.create({ title: "One" });
    const second = await Article.create({ title: "Two" });

    await Comment.create({ body: "a", commentable_id: first.id, commentable_type: "Article" });
    await Comment.create({ body: "b", commentable_id: first.id, commentable_type: "Article" });
    await Comment.create({ body: "c", commentable_id: second.id, commentable_type: "Article" });

    const articles = await Article.all().order("title").includes("remarks");

    const counts: number[] = [];
    for (const article of articles) counts.push((await article.remarks()).length);

    expect(counts).toEqual([2, 1]);
  });

  it("keeps preloading scoped to the owner's type", async () => {
    const article = await Article.create({ title: "One" });
    const writer = await Writer.create({ name: "Ada" });

    await Comment.create({
      body: "on the article",
      commentable_id: article.id,
      commentable_type: "Article",
    });
    await Comment.create({
      body: "on the writer",
      commentable_id: writer.id,
      commentable_type: "Writer",
    });

    const articles = await Article.all().includes("remarks");
    expect((await articles[0]!.remarks()).map((r) => r.body)).toEqual(["on the article"]);
  });
});
