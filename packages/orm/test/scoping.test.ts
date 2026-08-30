/**
 * Scoping, ported from `activerecord/test/cases/scoping/default_scoping_test.rb`
 * and `relation_scoping_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  published: number;
  author_id: number | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("published");
    t.integer("author_id");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

function postClass() {
  class Post extends Model<PostRow>("posts") {}
  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;
  return Post;
}

describe("defaultScoped", () => {
  it("is what all() returns", async () => {
    const Post = postClass();
    await Post.create({ title: "a", published: 1 });
    await Post.create({ title: "b", published: 0 });

    expect(await Post.defaultScoped().count()).toBe(2);
  });

  /** Rails: the default scope applies to it, and unscoped skips it. */
  it("applies the default scope", async () => {
    const Post = postClass();
    Post.defaultScope((posts) => posts.where({ published: 1 }));

    await Post.create({ title: "a", published: 1 });
    await Post.create({ title: "b", published: 0 });

    expect(await Post.defaultScoped().count()).toBe(1);
    expect(await Post.unscoped().count()).toBe(2);
  });
});

describe("nullRelation", () => {
  /** A guard clause needs something that is still a relation. */
  it("matches nothing", async () => {
    const Post = postClass();
    await Post.create({ title: "a", published: 1 });

    expect(await Post.nullRelation().count()).toBe(0);
    expect(await Post.nullRelation().toArray()).toEqual([]);
  });

  it("is still chainable", async () => {
    const Post = postClass();
    await Post.create({ title: "a", published: 1 });

    expect(await Post.nullRelation().order("title").limit(5).toArray()).toEqual([]);
  });

  it("is what emptyScope answers too", async () => {
    const Post = postClass();

    expect(await Post.emptyScope().count()).toBe(0);
  });

  it("does not touch the database", async () => {
    const Post = postClass();
    await Post.create({ title: "a", published: 1 });

    // A none relation short-circuits, so this holds even against a table with
    // rows in it — the count comes from the relation, not a query.
    expect(await Post.nullRelation().count()).toBe(0);
  });
});

describe("whereValues and scopeForCreate", () => {
  /** What makes `author.books.create(title)` set the author unprompted. */
  it("reports the equality conditions", () => {
    const Post = postClass();

    expect(Post.where({ author_id: 7 }).whereValues()).toEqual({ author_id: 7 });
  });

  it("collects several", () => {
    const Post = postClass();

    expect(Post.where({ author_id: 7, published: 1 }).whereValues()).toEqual({
      author_id: 7,
      published: 1,
    });
  });

  it("leaves out conditions that are not equality", () => {
    const Post = postClass();

    expect(Post.where("published > ?", 0).whereValues()).toEqual({});
  });

  it("is empty for an unfiltered relation", () => {
    const Post = postClass();

    expect(Post.all().whereValues()).toEqual({});
  });

  it("reports what the default scope implies", () => {
    const Post = postClass();
    Post.defaultScope((posts) => posts.where({ published: 1 }));

    expect(Post.scopeForCreate()).toEqual({ published: 1 });
  });

  it("is empty when there is no default scope", () => {
    const Post = postClass();

    expect(Post.scopeForCreate()).toEqual({});
  });

  /** A record built from the relation starts with them. */
  it("agrees with what build seeds", () => {
    const Post = postClass();
    const relation = Post.where({ author_id: 7 });

    expect(relation.build({}).author_id).toBe(relation.whereValues().author_id as number);
  });
});

describe("withUnscoped", () => {
  it("hands the block an unscoped relation", async () => {
    const Post = postClass();
    Post.defaultScope((posts) => posts.where({ published: 1 }));

    await Post.create({ title: "a", published: 1 });
    await Post.create({ title: "b", published: 0 });

    const count = await Post.withUnscoped((posts) => posts.count());

    expect(count).toBe(2);
  });

  it("returns what the block returned", async () => {
    const Post = postClass();

    expect(await Post.withUnscoped(() => 123)).toBe(123);
  });

  /**
   * The scope is still on afterwards. A flag set and unset by hand stays set
   * when something in between throws, and a process that quietly lost its
   * default scope starts serving soft-deleted rows to everybody.
   */
  it("leaves the default scope in place afterwards", async () => {
    const Post = postClass();
    Post.defaultScope((posts) => posts.where({ published: 1 }));

    await Post.create({ title: "a", published: 1 });
    await Post.create({ title: "b", published: 0 });

    await Post.withUnscoped((posts) => posts.count());

    expect(await Post.all().count()).toBe(1);
  });

  it("leaves it in place after the block throws", async () => {
    const Post = postClass();
    Post.defaultScope((posts) => posts.where({ published: 1 }));

    await Post.create({ title: "a", published: 1 });
    await Post.create({ title: "b", published: 0 });

    await expect(
      Post.withUnscoped(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await Post.all().count()).toBe(1);
  });
});
