/**
 * Asking a record what it already has, ported from the association-proxy cases
 * in `activerecord/test/cases/associations/association_test.rb`.
 *
 * `post.author()` on a preloaded record costs nothing and on any other costs a
 * query, and the two read identically at the call site — which is precisely
 * why N+1s survive code review.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Model,
  SchemaStatements,
  setConnection,
  type BelongsTo,
  type HasMany,
} from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface AuthorRow {
  id: number;
  name: string;
}

interface PostRow {
  id: number;
  title: string;
  author_id: number | null;
}

class Author extends Model<AuthorRow>("authors") {
  declare posts: HasMany<Post>;
}

class Post extends Model<PostRow>("posts") {
  declare author: BelongsTo<Author>;
}

Author.hasMany("posts", () => Post);
Post.belongsTo("author", () => Author, { optional: true });

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Author, Post]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  await schema.createTable("authors", (t) => {
    t.string("name");
  });

  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("author_id");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

async function seed(): Promise<{ author: Author; post: Post }> {
  const author = await Author.create({ name: "A" });
  const post = await Post.create({ title: "one", author_id: author.id });

  return { author, post };
}

describe("associationCached", () => {
  /** The question that tells a free read from a query. */
  it("is false on a record loaded on its own", async () => {
    await seed();

    const post = await Post.first();

    expect(post?.associationCached("author")).toBe(false);
  });

  it("is true on a record whose association was preloaded", async () => {
    await seed();

    const [post] = await Post.all().includes("author");

    expect(post?.associationCached("author")).toBe(true);
  });

  it("is false for an association nobody declared", async () => {
    await seed();

    expect((await Post.first())?.associationCached("nonexistent")).toBe(false);
  });

  it("becomes true once the association is loaded", async () => {
    await seed();

    const post = (await Post.first()) as Post;

    expect(post.associationCached("author")).toBe(false);

    await post.loadTarget("author");

    expect(post.associationCached("author")).toBe(true);
  });
});

describe("proxyAssociation", () => {
  it("gives the definition behind an accessor", async () => {
    await seed();

    const definition = (await Post.first())?.proxyAssociation("author");

    expect(definition?.kind).toBe("belongsTo");
    expect(definition?.name).toBe("author");
  });

  it("gives undefined for a name nobody declared", async () => {
    await seed();

    expect((await Post.first())?.proxyAssociation("nonexistent")).toBeUndefined();
  });

  it("knows a to-many when it sees one", async () => {
    await seed();

    expect((await Author.first())?.proxyAssociation("posts")?.kind).toBe("hasMany");
  });
});

describe("foreignKeyPresent", () => {
  it("is true when the key is set", async () => {
    await seed();

    expect((await Post.first())?.foreignKeyPresent("author")).toBe(true);
  });

  /**
   * A belongsTo with a null key has nothing to load, and asking the database
   * is a query guaranteed to return nothing.
   */
  it("is false when the key is null", async () => {
    await Post.create({ title: "orphan", author_id: null });

    expect((await Post.first())?.foreignKeyPresent("author")).toBe(false);
  });

  /**
   * A hasMany reads through the other table's column, so this record holding
   * nothing says nothing about whether there is anything to find.
   */
  it("is true for a to-many, which holds no key of its own", async () => {
    await seed();

    expect((await Author.first())?.foreignKeyPresent("posts")).toBe(true);
  });

  it("is false for an association nobody declared", async () => {
    await seed();

    expect((await Post.first())?.foreignKeyPresent("nonexistent")).toBe(false);
  });
});

describe("loadTarget", () => {
  it("loads and gives back the record", async () => {
    const { author } = await seed();
    const post = (await Post.first()) as Post;

    const loaded = (await post.loadTarget("author")) as Author | null;

    expect(loaded?.id).toBe(author.id);
  });

  it("remembers it, so a second read costs nothing", async () => {
    await seed();

    const post = (await Post.first()) as Post;

    await post.loadTarget("author");

    expect(post.associationCached("author")).toBe(true);
  });

  it("gives back what was already there rather than loading again", async () => {
    await seed();

    const [post] = await Post.all().includes("author");
    const held = post?.recordsFor("author");

    expect(await post?.loadTarget("author")).toBe(held);
  });

  it("gives undefined for an association nobody declared", async () => {
    await seed();

    expect(await (await Post.first())?.loadTarget("nonexistent")).toBeUndefined();
  });

  it("loads a to-many too", async () => {
    await seed();

    const author = (await Author.first()) as Author;
    const posts = (await author.loadTarget("posts")) as Post[];

    expect(posts).toHaveLength(1);
  });
});

describe("recordsFor", () => {
  it("gives what a preload put there", async () => {
    const { author } = await seed();

    const [post] = await Post.all().includes("author");

    expect((post?.recordsFor("author") as Author | null)?.id).toBe(author.id);
  });

  it("gives undefined when nothing has been loaded", async () => {
    await seed();

    expect((await Post.first())?.recordsFor("author")).toBeUndefined();
  });
});

/**
 * Rails calls this `reset_scope`; it is already here as `reloadAssociation`,
 * which does exactly the same thing and additionally refuses a name nobody
 * declared. Tested under the name it has rather than shipped twice.
 */
describe("forgetting a loaded association", () => {
  /**
   * Without it the record keeps handing back the object it loaded for the old
   * key — a stale value that looks exactly like a fresh one, and the next save
   * writes it.
   */
  it("forgets what was loaded", async () => {
    await seed();

    const post = (await Post.first()) as Post;

    await post.loadTarget("author");
    post.reloadAssociation("author");

    expect(post.associationCached("author")).toBe(false);
  });

  it("makes the next load see the new key", async () => {
    await seed();

    const other = await Author.create({ name: "B" });
    const post = (await Post.first()) as Post;

    await post.loadTarget("author");

    post.author_id = other.id;
    post.reloadAssociation("author");

    expect(((await post.loadTarget("author")) as Author | null)?.name).toBe("B");
  });

  it("is quiet about an association that was never loaded", async () => {
    await seed();

    const post = (await Post.first()) as Post;

    expect(() => {
      post.reloadAssociation("author");
    }).not.toThrow();
  });
});
