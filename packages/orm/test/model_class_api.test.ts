/**
 * The model-class declarations Rails has, ported from
 * `activerecord/test/cases/readonly_test.rb`, `base_test.rb` and
 * `counter_cache_test.rb`.
 *
 * Each of these is a rule that holds on every write path rather than in one
 * place, which is the reason to declare it rather than remember it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  slug: string | null;
  views: number | null;
  legacy: string | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("slug");
    t.integer("views");
    t.string("legacy");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/** A model with the declaration under test, and nothing else. */
const modelWith = (declare: (klass: ReturnType<typeof subject>) => void) => {
  const Post = subject();

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;
  declare(Post);

  return Post;
};

function subject() {
  class Post extends Model<PostRow>("posts") {}

  return Post;
}

/**
 * Set once and never changed. Dropped from the update rather than refused,
 * which is what Rails does — a save that touched one is not an error, it
 * simply does not write that column.
 */
describe("a column that may not change", () => {
  const Post = () => modelWith((klass) => klass.attrReadonly("slug"));

  it("is written when the row is created", async () => {
    const post = await Post().create({ title: "A", slug: "a" });

    expect(post.slug).toBe("a");
  });

  it("is not written when the row is updated", async () => {
    const Subject = Post();
    const post = await Subject.create({ title: "A", slug: "a" });

    post.slug = "changed";
    await post.save();

    expect((await Subject.find(post.id)).slug).toBe("a");
  });

  it("does not stop the rest of the save", async () => {
    const Subject = Post();
    const post = await Subject.create({ title: "A", slug: "a" });

    post.slug = "changed";
    post.title = "B";
    await post.save();

    const found = await Subject.find(post.id);

    expect([found.title, found.slug]).toEqual(["B", "a"]);
  });

  it("leaves another model's columns alone", async () => {
    const other = modelWith(() => undefined);
    const post = await other.create({ title: "A", slug: "a" });

    post.slug = "changed";
    await post.save();

    expect((await other.find(post.id)).slug).toBe("changed");
  });
});

/**
 * What makes dropping a column safe: name it here, deploy, then drop it.
 * Without the gap the running application selects a column the migration has
 * just removed, and every query fails until the deploy catches up.
 */
describe("a column the model pretends is gone", () => {
  it("is left out of the columns it knows", async () => {
    const Post = modelWith((klass) => klass.ignoreColumns("legacy"));

    expect(await Post.columnNames()).not.toContain("legacy");
    expect(await Post.columnNames()).toContain("title");
  });

  it("is still there for a model that did not ignore it", async () => {
    modelWith((klass) => klass.ignoreColumns("legacy"));
    const other = modelWith(() => undefined);

    expect(await other.columnNames()).toContain("legacy");
  });
});

describe("what a model calls itself", () => {
  it("has a name a person can read", () => {
    class BlogPost extends Model<PostRow>("posts") {}

    expect(BlogPost.humanName()).toBe("Blog post");
  });

  it("says where its translations live", () => {
    expect(modelWith(() => undefined).i18nScope).toBe("activerecord");
  });

  it("is its own base class outside a hierarchy", () => {
    const Post = modelWith(() => undefined);

    expect(Post.baseClass).toBe(Post);
  });
});

/**
 * Adds to a column on a row that is not in hand — which is the case a counter
 * cache is in: the parent is an id, not an object, and loading it to add one
 * is a query and a race.
 */
describe("counting on a row not in hand", () => {
  it("adds without loading the record", async () => {
    const Post = modelWith(() => undefined);
    const post = await Post.create({ title: "A", views: 5 });

    await Post.incrementCounter("views", post.id);

    expect((await Post.find(post.id)).views).toBe(6);
  });

  it("subtracts the other way", async () => {
    const Post = modelWith(() => undefined);
    const post = await Post.create({ title: "A", views: 5 });

    await Post.decrementCounter("views", post.id, 2);

    expect((await Post.find(post.id)).views).toBe(3);
  });

  it("treats an empty column as zero", async () => {
    const Post = modelWith(() => undefined);
    const post = await Post.create({ title: "A" });

    await Post.incrementCounter("views", post.id);

    expect((await Post.find(post.id)).views).toBe(1);
  });

  it("refuses a column that is not there", async () => {
    const Post = modelWith(() => undefined);

    await expect(Post.incrementCounter("nope", 1)).rejects.toThrow(/Invalid column name/);
  });
});

/**
 * A cache key in two halves, ported from
 * `activerecord/test/cases/cache_key_test.rb`.
 *
 * Kept apart so a store that understands versions holds one entry per record
 * rather than one per version — the difference between a cache that reuses its
 * space and one that fills with yesterday's copies of the same page.
 */
describe("a cache key and its version", () => {
  // Its own table: the version is read from `updated_at`, and the table the
  // rest of this file uses has no timestamps.
  class Article extends Model<{ id: number; title: string }>("articles") {}

  beforeEach(async () => {
    await new SchemaStatements(connection).createTable("articles", (t) => {
      t.string("title");
      t.timestamps();
    });

    Article.columnCache = undefined;
    Article.columnTypeCache = undefined;
  });

  it("has a version that moves when the record does", async () => {
    const article = await Article.create({ title: "A" });
    const before = article.cacheVersion();

    expect(before).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    article.title = "B";
    await article.save();

    expect(article.cacheVersion()).not.toBe(before);
  });

  it("joins them for a store that wants one string", async () => {
    const article = await Article.create({ title: "A" });

    expect(article.cacheKeyWithVersion()).toBe(`articles/${article.id}-${article.cacheVersion()}`);
  });

  it("has no version before there is a timestamp", () => {
    const article = new Article({ title: "A" });

    expect(article.cacheVersion()).toBeUndefined();
    expect(article.cacheKeyWithVersion()).toBe("articles/new");
  });
});

/**
 * For a bulk import, where every row touching its parent means one update per
 * row on the same handful of parents — both slow and a deadlock waiting to
 * happen.
 */
describe("turning touch off for a block", () => {
  it("puts it back afterwards, even when the block throws", async () => {
    const Post = modelWith(() => undefined);

    await Post.noTouching(async () => {
      expect(Post.touchingDisabled).toBe(true);
    });

    expect(Post.touchingDisabled).toBe(false);

    await Post.noTouching(async () => {
      throw new Error("nope");
    }).catch(() => undefined);

    expect(Post.touchingDisabled).toBe(false);
  });

  it("hands back what the block returned", async () => {
    expect(await modelWith(() => undefined).noTouching(async () => "done")).toBe("done");
  });
});

describe("a token no two records share", () => {
  it("is different every time", () => {
    const Post = modelWith(() => undefined);
    const tokens = new Set(Array.from({ length: 50 }, () => Post.generateUniqueSecureToken()));

    expect(tokens.size).toBe(50);
  });

  it("takes a length in bytes of entropy", () => {
    const Post = modelWith(() => undefined);

    expect(Post.generateUniqueSecureToken(8).length).toBeLessThan(
      Post.generateUniqueSecureToken(32).length,
    );
  });

  it("names the column an STI hierarchy reads", () => {
    expect(modelWith(() => undefined).inheritanceColumnName).toBe("type");
  });
});
