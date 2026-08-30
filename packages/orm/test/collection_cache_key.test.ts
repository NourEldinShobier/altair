/**
 * One cache key for a whole collection, ported from the `cache_key` cases in
 * `activerecord/test/cases/relation_test.rb`.
 *
 * How a list page gets one cache entry rather than none. The alternatives are
 * both bad: no cache at all, or a cache per record that has to be reassembled
 * on every request — which costs a read per row and gives back most of what
 * caching was for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import { serialize } from "../src/model.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  status: string;
  updated_at: Date;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("status");
    t.timestamps();
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("collectionCacheKey", () => {
  it("names the table, so two collections cannot collide", async () => {
    expect(await Post.all().collectionCacheKey()).toContain("posts");
  });

  it("is stable while nothing changes", async () => {
    await Post.create({ title: "a", status: "draft" });

    expect(await Post.all().collectionCacheKey()).toBe(await Post.all().collectionCacheKey());
  });

  it("changes when a record is added", async () => {
    const before = await Post.all().collectionCacheKey();

    await Post.create({ title: "a", status: "draft" });

    expect(await Post.all().collectionCacheKey()).not.toBe(before);
  });

  /**
   * Count alone misses this: the number is the same and the rendered list is
   * not.
   */
  it("changes when a record is edited", async () => {
    const post = await Post.create({ title: "a", status: "draft" });
    const before = await Post.all().collectionCacheKey();

    // Written directly, and well into the future: `save` stamps updated_at
    // with the current time, which inside one test is the time the row already
    // had — so the key would not move for a reason that has nothing to do with
    // what is being tested.
    //
    // Through `serialize` rather than `toISOString`, because writing the bind
    // by hand means writing it for one adapter: MySQL refuses ISO 8601 for a
    // DATETIME outright, and wants `2026-01-01 12:00:00` for the same instant.
    await connection.execute(
      `UPDATE posts SET title = 'b', updated_at = ${connection.placeholder(0)} WHERE id = ${connection.placeholder(1)}`,
      [serialize(new Date(Date.now() + 86_400_000), connection), post.id],
    );

    expect(await Post.all().collectionCacheKey()).not.toBe(before);
  });

  /**
   * Timestamp alone misses this, and worse than missing: the row that changed
   * is gone, so the maximum can go *down* and a key built on it repeats a key
   * it has already used — serving a list with a record still in it.
   */
  it("changes when a record is deleted", async () => {
    const first = await Post.create({ title: "a", status: "draft" });
    await Post.create({ title: "b", status: "draft" });

    const before = await Post.all().collectionCacheKey();

    await first.destroy();

    expect(await Post.all().collectionCacheKey()).not.toBe(before);
  });

  it("differs between two different scopes", async () => {
    await Post.create({ title: "a", status: "draft" });
    await Post.create({ title: "b", status: "published" });

    const drafts = await Post.where({ status: "draft" }).collectionCacheKey();
    const all = await Post.all().collectionCacheKey();

    expect(drafts).not.toBe(all);
  });

  it("works on an empty collection", async () => {
    expect(await Post.where({ status: "nothing" }).collectionCacheKey()).toContain("posts");
  });

  it("gives the same key for two empty scopes of the same table", async () => {
    const one = await Post.where({ status: "nothing" }).collectionCacheKey();
    const two = await Post.where({ status: "also-nothing" }).collectionCacheKey();

    expect(one).toBe(two);
  });

  it("takes a different timestamp column", async () => {
    await Post.create({ title: "a", status: "draft" });

    expect(await Post.all().collectionCacheKey("created_at")).toContain("posts");
  });

  /** A table with no such column should give a key, not an error. */
  it("survives a timestamp column that is not there", async () => {
    await Post.create({ title: "a", status: "draft" });

    expect(await Post.all().collectionCacheKey("nonexistent")).toContain("posts");
  });
});
