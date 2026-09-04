/**
 * `createWith`, ported from `create_with` in
 * `activerecord/lib/active_record/relation/query_methods.rb` and the
 * `test_create_with` cases in
 * `activerecord/test/cases/relations_test.rb`.
 *
 * A relation's conditions already seed a `build`, which covers most of it: a
 * `where({ published: 1 })` builds a published post. What conditions cannot
 * cover is an attribute that is not a condition — `createWith({ author_id })`
 * on a relation that is not filtered by author, which is every "new post in
 * this list, by me".
 *
 * Without it the attribute goes at every call site, and the one that forgets
 * writes a row with a null where a foreign key should be.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface PostRow {
  id: number;
  title: string;
  author_id: number | null;
  published: number | null;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
  declare author_id: number | null;
  declare published: number | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.resetColumnInformation();

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("author_id");
    t.integer("published");
  });
});

describe("building", () => {
  it("starts a record with what was asked for", () => {
    const post = Post.all().createWith({ author_id: 7 }).build({ title: "a" });

    expect(post.author_id).toBe(7);
    expect(post.title).toBe("a");
  });

  /** The point: an attribute that is not a condition on the relation. */
  it("sets something the conditions do not mention", () => {
    const post = Post.where({ published: 1 }).createWith({ author_id: 7 }).build();

    expect(post.published).toBe(1);
    expect(post.author_id).toBe(7);
  });

  it("does not filter by what it sets", async () => {
    await Post.create({ title: "someone else's", author_id: 9, published: 1 });

    const found = await Post.where({ published: 1 }).createWith({ author_id: 7 }).toArray();

    expect(found).toHaveLength(1);
  });

  /**
   * Different questions, and this one is about the new record: an attribute
   * named both ways takes what the caller asked to create with.
   */
  it("wins over a condition on the same attribute", () => {
    const post = Post.where({ author_id: 9 }).createWith({ author_id: 7 }).build();

    expect(post.author_id).toBe(7);
  });

  it("is still overridden by what build was given", () => {
    const post = Post.all().createWith({ author_id: 7 }).build({ author_id: 3 });

    expect(post.author_id).toBe(3);
  });
});

describe("creating", () => {
  it("writes the attribute to the row", async () => {
    const post = await Post.all().createWith({ author_id: 7 }).create({ title: "a" });

    expect((await Post.find(post.id)).author_id).toBe(7);
  });
});

describe("chaining", () => {
  it("merges with what a relation above it set", () => {
    const post = Post.all().createWith({ author_id: 7 }).createWith({ published: 1 }).build();

    expect(post.author_id).toBe(7);
    expect(post.published).toBe(1);
  });

  it("replaces a value the one above it set", () => {
    const post = Post.all().createWith({ author_id: 7 }).createWith({ author_id: 3 }).build();

    expect(post.author_id).toBe(3);
  });

  /** Rails' `create_with(nil)`, so a scope can undo what a scope above it set. */
  it("clears when given nothing", () => {
    const post = Post.all().createWith({ author_id: 7 }).createWith().build();

    expect(post.author_id).toBeUndefined();
  });

  it("leaves the relation it was called on alone", () => {
    const base = Post.all();

    base.createWith({ author_id: 7 });

    expect(base.build().author_id).toBeUndefined();
  });

  it("survives a where added afterwards", () => {
    const post = Post.all().createWith({ author_id: 7 }).where({ published: 1 }).build();

    expect(post.author_id).toBe(7);
    expect(post.published).toBe(1);
  });
});
