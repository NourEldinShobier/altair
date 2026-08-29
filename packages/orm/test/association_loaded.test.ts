/**
 * Asking what is already in memory, ported from
 * `activerecord/test/cases/associations_test.rb` and `persistence_test.rb`.
 *
 * These are the questions `strictLoading` makes worth asking: a helper that
 * reads `post.author` is safe on a preloaded record and a violation on any
 * other, and it needs a way to tell without provoking one.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection, StrictLoadingViolation } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

class Comment extends Model<{ id: number; post_id: number; body: string }>("comments") {}
class Post extends Model<{ id: number; title: string; user_id: number }>("posts") {
  declare comments: () => unknown;
}

Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("user_id");
  });
  await schema.createTable("comments", (t) => {
    t.integer("post_id");
    t.string("body");
  });

  for (const model of [Post, Comment]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const post = await Post.create({ title: "A" });
  await Comment.create({ post_id: post.id, body: "First" });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("asking whether an association is loaded", () => {
  it("is false for one nobody has read", async () => {
    const post = (await Post.all().first())!;

    expect(post.isAssociationLoaded("comments")).toBe(false);
  });

  it("is true after preloading", async () => {
    const [post] = await Post.all().includes("comments");

    expect(post!.isAssociationLoaded("comments")).toBe(true);
  });

  /**
   * The pairing that matters: this must be answerable on a strict-loading
   * record without provoking the violation it exists to avoid.
   */
  it("does not itself trip strict loading", async () => {
    const post = (await Post.all().first())!.strictLoading();

    expect(post.isAssociationLoaded("comments")).toBe(false);
    expect(() => post.comments()).toThrow(StrictLoadingViolation);
  });

  it("says which associations are loaded", async () => {
    const [post] = await Post.all().includes("comments");

    expect(post!.loadedAssociations()).toEqual(["comments"]);
    expect((await Post.all().first())!.loadedAssociations()).toEqual([]);
  });

  it("refuses a name that is not an association", async () => {
    const post = (await Post.all().first())!;

    expect(() => post.isAssociationLoaded("nonexistent")).toThrow();
  });
});

/**
 * For after a write the association cannot have seen — a job inserted a
 * comment, a counter moved — where the record is otherwise still good and
 * reloading the whole thing would throw away everything else it holds.
 */
describe("forgetting a loaded association", () => {
  it("makes the next read fetch again", async () => {
    const [post] = await Post.all().includes("comments");
    expect(post!.isAssociationLoaded("comments")).toBe(true);

    post!.reloadAssociation("comments");

    expect(post!.isAssociationLoaded("comments")).toBe(false);
  });

  it("picks up a row written since", async () => {
    const [post] = await Post.all().includes("comments");
    expect(await (post!.comments() as Promise<Comment[]>)).toHaveLength(1);

    await Comment.create({ post_id: post!.id, body: "Second" });
    post!.reloadAssociation("comments");

    expect(await (post!.comments() as Promise<Comment[]>)).toHaveLength(2);
  });

  it("chains", async () => {
    const [post] = await Post.all().includes("comments");

    expect(post!.reloadAssociation("comments")).toBe(post!);
  });

  it("refuses a name that is not an association", async () => {
    const post = (await Post.all().first())!;

    expect(() => post.reloadAssociation("nonexistent")).toThrow();
  });
});

/**
 * By the time an `afterSave` callback runs the record is persisted either way,
 * so `isNewRecord` is false for both and the callback has no way to tell a
 * create from an update.
 */
describe("whether the last save was the one that created it", () => {
  it("is true right after a create", async () => {
    const post = await Post.create({ title: "New" });

    expect(post.isPreviouslyNewRecord).toBe(true);
  });

  it("is false after an update", async () => {
    const post = await Post.create({ title: "New" });

    post.title = "Changed";
    await post.save();

    expect(post.isPreviouslyNewRecord).toBe(false);
  });

  it("is false on a record that was loaded rather than created", async () => {
    expect((await Post.all().first())!.isPreviouslyNewRecord).toBe(false);
  });

  it("is what an afterSave callback can read", async () => {
    const seen: boolean[] = [];

    class Tracked extends Model<{ id: number; title: string }>("posts") {
      static {
        this.setCallback("save", "after", function (this: Tracked) {
          seen.push(this.isPreviouslyNewRecord);
        });
      }
    }
    Tracked.columnCache = undefined;
    Tracked.columnTypeCache = undefined;

    const record = await Tracked.create({ title: "One" });
    record.title = "Two";
    await record.save();

    expect(seen).toEqual([true, false]);
  });
});
