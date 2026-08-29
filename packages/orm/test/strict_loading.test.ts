/**
 * The N+1 guard, ported from
 * `activerecord/test/cases/strict_loading_test.rb`.
 *
 * A list page reads `post.author` inside a loop, one query per post, and
 * nothing in the code says so — it looks exactly like reading an attribute.
 * This turns that into a failure where it happens rather than a graph in a
 * dashboard three weeks later.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection, StrictLoadingViolation } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

class User extends Model<{ id: number; name: string }>("users") {
  declare posts: () => Promise<Post[]>;
}
class Post extends Model<{ id: number; title: string; user_id: number }>("posts") {
  static {
    this.belongsTo("author", () => User, { foreignKey: "user_id" });
  }

  declare author: () => Promise<User | null>;
}

User.hasMany("posts", () => Post, { foreignKey: "user_id" });

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("users", (t) => t.string("name"));
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("user_id");
  });

  for (const model of [User, Post]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  Post.strictLoadingByDefault = false;
  User.strictLoadingByDefault = false;

  const author = await User.create({ name: "Martin" });
  await Post.create({ title: "A", user_id: author.id });
  await Post.create({ title: "B", user_id: author.id });
});

afterEach(async () => {
  Post.strictLoadingByDefault = false;
  User.strictLoadingByDefault = false;
  if (isSqlite) await connection.close();
});

describe("a record that is not strict", () => {
  it("loads an association on demand, as it always has", async () => {
    const post = (await Post.all().first())!;

    expect((await post.author())?.name).toBe("Martin");
  });

  it("says it is not strict", async () => {
    expect((await Post.all().first())!.isStrictLoading).toBe(false);
  });
});

describe("a record marked strict", () => {
  /**
   * Thrown where it is called, not returned as a rejected promise. This is a
   * programming error rather than a runtime failure — the association was
   * never going to load — and the value of catching it at all is the stack
   * pointing at the read that would have run the query.
   */
  it("refuses to load an association that was not preloaded", async () => {
    const post = (await Post.all().first())!.strictLoading();

    expect(() => post.author()).toThrow(StrictLoadingViolation);
  });

  /**
   * The message has to name the fix. "Strict loading violation" tells you what
   * rule was broken; it does not tell you what to type.
   */
  it("names the association and the way out", async () => {
    const post = (await Post.all().first())!.strictLoading();

    expect(() => post.author()).toThrow(/includes\("author"\)/);
  });

  it("can be told to stop being strict", async () => {
    const post = (await Post.all().first())!.strictLoading();
    post.strictLoading(false);

    expect((await post.author())?.name).toBe("Martin");
  });

  it("says it is strict", async () => {
    expect((await Post.all().first())!.strictLoading().isStrictLoading).toBe(true);
  });
});

/**
 * Strict loading is about the query, not about the association: something
 * already in memory costs nothing to read.
 */
describe("a preloaded association", () => {
  it("is allowed even under strict loading", async () => {
    const posts = await Post.all().includes("author").strictLoading();

    expect((await posts[0]!.author())?.name).toBe("Martin");
  });

  it("still refuses the associations that were not preloaded", async () => {
    const users = await User.all().strictLoading();

    expect(() => users[0]!.posts()).toThrow(StrictLoadingViolation);
  });
});

describe("marking a whole query", () => {
  it("marks every record it returns", async () => {
    const posts = await Post.all().strictLoading();

    expect(posts.map((post) => post.isStrictLoading)).toEqual([true, true]);
  });

  it("leaves the same query without it alone", async () => {
    const relation = Post.all();
    await relation.strictLoading();

    // A relation is immutable, so asking one chain to be strict must not make
    // the chain it was built from strict too.
    const again = await relation;

    expect(again.map((post) => post.isStrictLoading)).toEqual([false, false]);
  });

  it("can be turned off again in a chain", async () => {
    const posts = await Post.all().strictLoading().strictLoading(false);

    expect(posts[0]!.isStrictLoading).toBe(false);
  });
});

/**
 * Off by default, because turning it on for an existing application breaks
 * every page at once. A new one should turn it on in development and leave it.
 */
describe("marking a whole class", () => {
  it("is off unless asked for", async () => {
    expect((await Post.all().first())!.isStrictLoading).toBe(false);
  });

  it("marks every record the class loads", async () => {
    Post.strictLoadingByDefault = true;

    const post = (await Post.all().first())!;

    expect(() => post.author()).toThrow(StrictLoadingViolation);
  });

  it("does not mark another class's records", async () => {
    Post.strictLoadingByDefault = true;

    const user = (await User.all().first())!;

    expect(user.isStrictLoading).toBe(false);
  });

  it("still allows what was preloaded", async () => {
    Post.strictLoadingByDefault = true;

    const posts = await Post.all().includes("author");

    expect((await posts[0]!.author())?.name).toBe("Martin");
  });
});

describe("a record that was built rather than loaded", () => {
  it("is not strict, so a form can read its associations", () => {
    Post.strictLoadingByDefault = true;

    expect(new Post({ title: "New" }).isStrictLoading).toBe(false);
  });
});
