/**
 * Through and polymorphic associations.
 *
 * Mirrors activerecord/test/cases/associations/has_many_through_associations_test.rb
 * and the polymorphic association tests.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
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
Post.belongsTo("author", () => Author);
Post.hasMany("comments", () => Comment);
Comment.belongsTo("post", () => Post);
Comment.belongsToPolymorphic("commentable", { Post: () => Post, Author: () => Author });

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
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
