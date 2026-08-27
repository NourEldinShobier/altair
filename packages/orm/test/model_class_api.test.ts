/**
 * The model-class declarations Rails has, ported from
 * `activerecord/test/cases/readonly_test.rb`, `base_test.rb` and
 * `counter_cache_test.rb`.
 *
 * Each of these is a rule that holds on every write path rather than in one
 * place, which is the reason to declare it rather than remember it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface PostRow {
  id: number;
  title: string;
  slug: string | null;
  views: number | null;
  legacy: string | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("slug");
    t.integer("views");
    t.string("legacy");
  });
});

afterEach(async () => {
  await connection.close();
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
