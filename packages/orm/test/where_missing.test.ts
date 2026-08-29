/**
 * Records that have none of an association, ported from
 * `activerecord/test/cases/relations_test.rb`.
 *
 * A left join and a null check on the other side is the one shape SQL has for
 * "no matching row", and the one nobody remembers. Written by hand it is an
 * inner join by mistake about half the time — and an inner join answers the
 * opposite question.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

class Comment extends Model<{ id: number; post_id: number; body: string }>("comments") {}
class Post extends Model<{ id: number; title: string }>("posts") {
  declare comments: () => unknown;
}

Post.hasMany("comments", () => Comment, { foreignKey: "post_id" });

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("posts", (t) => t.string("title"));
  await schema.createTable("comments", (t) => {
    t.integer("post_id");
    t.string("body");
  });

  for (const model of [Post, Comment]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const discussed = await Post.create({ title: "Discussed" });
  await Post.create({ title: "Ignored" });
  await Post.create({ title: "Also ignored" });

  await Comment.create({ post_id: discussed.id, body: "First" });
  await Comment.create({ post_id: discussed.id, body: "Second" });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("finding what has none", () => {
  it("keeps the records with no matching row", async () => {
    const found = await Post.all().whereMissing("comments").order("id");

    expect(found.map((post) => post.title)).toEqual(["Ignored", "Also ignored"]);
  });

  it("is the opposite of joining", async () => {
    const withComments = await Post.all().joins("comments");

    expect(withComments.map((post) => post.title)).toEqual(["Discussed", "Discussed"]);
  });

  it("counts them", async () => {
    expect(await Post.all().whereMissing("comments").count()).toBe(2);
  });

  it("finds nothing when everything has one", async () => {
    await Comment.create({ post_id: 2, body: "Now discussed" });
    await Comment.create({ post_id: 3, body: "Also now" });

    expect(await Post.all().whereMissing("comments").count()).toBe(0);
  });

  it("finds everything when nothing has one", async () => {
    await Comment.all().deleteAll();

    expect(await Post.all().whereMissing("comments").count()).toBe(3);
  });
});

describe("chaining", () => {
  it("narrows further", async () => {
    const found = await Post.all().whereMissing("comments").where({ title: "Ignored" });

    expect(found.map((post) => post.title)).toEqual(["Ignored"]);
  });

  it("leaves the relation it was built from alone", async () => {
    const base = Post.all();
    await base.whereMissing("comments");

    expect(await base.count()).toBe(3);
  });

  /**
   * Joining the same table twice produces a cross product, so asking for a
   * join the relation already has must not add a second one.
   */
  it("does not join twice when the relation already joined", async () => {
    const found = await Post.all().leftJoins("comments").whereMissing("comments").order("id");

    expect(found.map((post) => post.title)).toEqual(["Ignored", "Also ignored"]);
  });
});

describe("what it refuses", () => {
  it("says so when the association does not exist", () => {
    expect(() => Post.all().whereMissing("nonexistent")).toThrow();
  });
});
