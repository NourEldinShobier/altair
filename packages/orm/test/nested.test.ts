/**
 * Nested attributes.
 *
 * Mirrors activerecord/test/cases/nested_attributes_test.rb. Two cases carry
 * their weight beyond the happy path: an invalid owner must not leave its
 * children behind, and an id typed into a form must not reach a record the
 * owner does not have.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model, type BelongsTo, type HasMany, type HasOne } from "../src/model.js";
import {
  NestedAttributesLimitExceeded,
  NestedRecordNotFound,
  marksForDestruction,
  normalizeCollection,
} from "../src/nested.js";

interface AuthorAttributes {
  id: number;
  name: string;
}

interface PostAttributes {
  id: number;
  author_id: number | null;
  title: string;
}

interface CommentAttributes {
  id: number;
  post_id: number | null;
  body: string;
}

interface CoverAttributes {
  id: number;
  post_id: number | null;
  url: string;
}

class Author extends Model<AuthorAttributes>("authors") {}
class Comment extends Model<CommentAttributes>("comments") {}
class Cover extends Model<CoverAttributes>("covers") {}

class Post extends Model<PostAttributes>("posts") {
  declare comments: HasMany<Comment>;
  declare cover: HasOne<Cover>;
  declare author: BelongsTo<Author>;

  static {
    this.hasMany("comments", () => Comment);
    this.hasOne("cover", () => Cover);
    this.belongsTo("author", () => Author);

    this.acceptsNestedAttributesFor("comments", { allowDestroy: true });
    this.acceptsNestedAttributesFor("cover", { allowDestroy: true });
    this.acceptsNestedAttributesFor("author");

    this.validates("title", { presence: true });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);

  await schema.createTable("authors", (t) => t.string("name"));
  await schema.createTable("posts", (t) => {
    t.references("author");
    t.string("title");
  });
  await schema.createTable("comments", (t) => {
    t.references("post");
    t.string("body");
  });
  await schema.createTable("covers", (t) => {
    t.references("post");
    t.string("url");
  });
});

describe("payload shapes", () => {
  // A form encoder sends a collection as an object keyed by index, so both
  // spellings arrive in practice.
  it("accepts an array", () => {
    expect(normalizeCollection([{ body: "a" }, { body: "b" }])).toHaveLength(2);
  });

  it("accepts an index-keyed object", () => {
    expect(normalizeCollection({ 0: { body: "a" }, 1: { body: "b" } })).toEqual([
      { body: "a" },
      { body: "b" },
    ]);
  });

  it("orders index keys numerically", () => {
    const records = normalizeCollection({ 10: { body: "last" }, 2: { body: "first" } });
    expect(records.map((record) => record.body)).toEqual(["first", "last"]);
  });

  it("treats nothing as an empty collection", () => {
    expect(normalizeCollection(null)).toEqual([]);
    expect(normalizeCollection(undefined)).toEqual([]);
  });

  // A checkbox posts "1", not true.
  it("reads a destroy flag in every spelling a form sends", () => {
    expect(marksForDestruction({ _destroy: "1" })).toBe(true);
    expect(marksForDestruction({ _destroy: 1 })).toBe(true);
    expect(marksForDestruction({ _destroy: true })).toBe(true);
    expect(marksForDestruction({ _destroy: "true" })).toBe(true);

    expect(marksForDestruction({ _destroy: "0" })).toBe(false);
    expect(marksForDestruction({})).toBe(false);
  });
});

describe("declaring", () => {
  // The name is checked at compile time too; this is the runtime backstop for
  // code that reached here without one.
  it("refuses an association that was never declared", () => {
    // @ts-expect-error not a property this model declares
    expect(() => Post.acceptsNestedAttributesFor("nonexistent")).toThrow();
  });
});

describe("a collection", () => {
  it("creates children with the owner", async () => {
    const post = Post.build({
      title: "Hello",
      comments_attributes: [{ body: "First" }, { body: "Second" }],
    } as Partial<PostAttributes>);

    expect(await post.save()).toBe(true);
    expect(await Comment.count()).toBe(2);
    expect((await Comment.where({ post_id: post.id })).map((c) => c.body)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("does not write the nested key as a column", async () => {
    const post = await Post.create({
      title: "Hello",
      comments_attributes: [{ body: "First" }],
    } as Partial<PostAttributes>);

    expect(Object.keys(post.attributes())).not.toContain("comments_attributes");
  });

  it("updates an existing child", async () => {
    const post = await Post.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: post.id, body: "Before" });

    await post.update({
      comments_attributes: [{ id: comment.id, body: "After" }],
    } as Partial<PostAttributes>);

    expect((await Comment.find(comment.id)).body).toBe("After");
    expect(await Comment.count()).toBe(1);
  });

  it("creates and updates in the same submission", async () => {
    const post = await Post.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: post.id, body: "Before" });

    await post.update({
      comments_attributes: [{ id: comment.id, body: "After" }, { body: "New" }],
    } as Partial<PostAttributes>);

    expect(await Comment.count()).toBe(2);
    expect((await Comment.find(comment.id)).body).toBe("After");
  });

  it("destroys a child that asked to be", async () => {
    const post = await Post.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: post.id, body: "Doomed" });

    await post.update({
      comments_attributes: [{ id: comment.id, _destroy: "1" }],
    } as Partial<PostAttributes>);

    expect(await Comment.count()).toBe(0);
  });

  it("ignores a destroy flag on a record that does not exist yet", async () => {
    const post = Post.build({
      title: "Hello",
      comments_attributes: [{ body: "Never saved", _destroy: "1" }],
    } as Partial<PostAttributes>);

    await post.save();
    expect(await Comment.count()).toBe(0);
  });

  // Without allowDestroy the flag is data, not an instruction.
  it("ignores a destroy flag the model did not allow", async () => {
    class Article extends Model<PostAttributes>("posts") {
      declare comments: HasMany<Comment>;

      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id" });
        this.acceptsNestedAttributesFor("comments");
      }
    }

    const article = await Article.create({ title: "Hello" });
    const comment = await Comment.create({ post_id: article.id, body: "Safe" });

    await article.update({
      comments_attributes: [{ id: comment.id, _destroy: "1" }],
    } as Partial<PostAttributes>);

    expect(await Comment.count()).toBe(1);
  });

  it("skips a record rejectIf turns down", async () => {
    class Article extends Model<PostAttributes>("posts") {
      declare comments: HasMany<Comment>;

      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id" });
        this.acceptsNestedAttributesFor("comments", {
          rejectIf: (attributes) => !attributes.body,
        });
      }
    }

    const article = Article.build({
      title: "Hello",
      comments_attributes: [{ body: "Kept" }, { body: "" }, {}],
    } as Partial<PostAttributes>);

    await article.save();
    expect(await Comment.count()).toBe(1);
  });

  it("refuses more records than the limit allows", async () => {
    class Article extends Model<PostAttributes>("posts") {
      declare comments: HasMany<Comment>;

      static {
        this.hasMany("comments", () => Comment, { foreignKey: "post_id" });
        this.acceptsNestedAttributesFor("comments", { limit: 2 });
      }
    }

    const article = Article.build({
      title: "Hello",
      comments_attributes: [{ body: "a" }, { body: "b" }, { body: "c" }],
    } as Partial<PostAttributes>);

    await expect(article.save()).rejects.toThrow(NestedAttributesLimitExceeded);
  });

  // A security boundary, not a convenience: an id typed into a form must not
  // reach a record the owner does not have.
  it("refuses an id belonging to another owner", async () => {
    const mine = await Post.create({ title: "Mine" });
    const theirs = await Post.create({ title: "Theirs" });
    const theirComment = await Comment.create({ post_id: theirs.id, body: "Private" });

    await expect(
      mine.update({
        comments_attributes: [{ id: theirComment.id, body: "Hijacked" }],
      } as Partial<PostAttributes>),
    ).rejects.toThrow(NestedRecordNotFound);

    expect((await Comment.find(theirComment.id)).body).toBe("Private");
  });
});

describe("a to-one child", () => {
  it("creates it with the owner", async () => {
    const post = await Post.create({
      title: "Hello",
      cover_attributes: { url: "cover.png" },
    } as Partial<PostAttributes>);

    const cover = await Cover.findBy({ post_id: post.id });
    expect(cover?.url).toBe("cover.png");
  });

  it("updates the one that is already there", async () => {
    const post = await Post.create({ title: "Hello" });
    await Cover.create({ post_id: post.id, url: "old.png" });

    await post.update({ cover_attributes: { url: "new.png" } } as Partial<PostAttributes>);

    expect(await Cover.count()).toBe(1);
    expect((await Cover.findBy({ post_id: post.id }))?.url).toBe("new.png");
  });

  it("destroys it when asked", async () => {
    const post = await Post.create({ title: "Hello" });
    await Cover.create({ post_id: post.id, url: "old.png" });

    await post.update({ cover_attributes: { _destroy: true } } as Partial<PostAttributes>);

    expect(await Cover.count()).toBe(0);
  });
});

describe("a parent", () => {
  // The owner holds the key, so the parent has to be saved first.
  it("is created before the owner and linked to it", async () => {
    const post = await Post.create({
      title: "Hello",
      author_attributes: { name: "Ada" },
    } as Partial<PostAttributes>);

    expect(await Author.count()).toBe(1);
    expect(post.author_id).toBe(1);
    expect((await Post.find(post.id)).author_id).toBe(1);
  });

  it("updates the one already linked", async () => {
    const author = await Author.create({ name: "Ada" });
    const post = await Post.create({ title: "Hello", author_id: author.id });

    await post.update({ author_attributes: { name: "Ada L" } } as Partial<PostAttributes>);

    expect(await Author.count()).toBe(1);
    expect((await Author.find(author.id)).name).toBe("Ada L");
  });

  it("refuses an id that does not exist", async () => {
    const post = Post.build({
      title: "Hello",
      author_attributes: { id: 99, name: "Nobody" },
    } as Partial<PostAttributes>);

    await expect(post.save()).rejects.toThrow(NestedRecordNotFound);
  });
});

describe("when the owner is invalid", () => {
  // The whole submission is one transaction, so a form that half-saves is not
  // a state an application can reach.
  it("saves nothing at all", async () => {
    const post = Post.build({
      title: "",
      comments_attributes: [{ body: "Orphan" }],
    } as Partial<PostAttributes>);

    expect(await post.save()).toBe(false);
    expect(await Post.count()).toBe(0);
    expect(await Comment.count()).toBe(0);
  });

  it("leaves a parent it had already created behind", async () => {
    const post = Post.build({
      title: "",
      author_attributes: { name: "Ada" },
    } as Partial<PostAttributes>);

    expect(await post.save()).toBe(false);
    expect(await Author.count()).toBe(0);
  });

  it("reports the owner's errors", async () => {
    const post = Post.build({
      title: "",
      comments_attributes: [{ body: "Orphan" }],
    } as Partial<PostAttributes>);

    await post.save();
    expect(post.errors.on("title")).not.toEqual([]);
  });
});

describe("without nested attributes", () => {
  it("leaves an ordinary save alone", async () => {
    const author = await Author.create({ name: "Ada" });

    expect(author.isPersisted).toBe(true);
    expect(await Author.count()).toBe(1);
  });
});
