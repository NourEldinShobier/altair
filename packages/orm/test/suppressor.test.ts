/**
 * The suppressor and timestamp control, ported from
 * `activerecord/test/cases/suppressor_test.rb` and the
 * `record_timestamps` cases in `timestamp_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  created_at: Date | null;
  updated_at: Date | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  // Nullable rather than t.timestamps(), which declares them NOT NULL. Turning
  // timestamps off only makes sense for a table that can hold a row without
  // them, and Rails has the same constraint.
  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.datetime("created_at");
    t.datetime("updated_at");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

function postClass() {
  class Post extends Model<PostRow>("posts") {}
  Post.resetColumnInformation();
  return Post;
}

describe("suppress", () => {
  /** The case it exists for: an import whose callback emails per record. */
  it("writes nothing inside the block", async () => {
    const Post = postClass();

    await Post.suppress(async () => {
      await Post.build({ title: "a" }).save();
    });

    expect(await Post.all().count()).toBe(0);
  });

  /**
   * True, as Rails answers: the caller asked for the record to be persisted
   * and the application decided that means nothing here. Reporting failure
   * would send it down an error path for something that is not an error.
   */
  it("still reports success", async () => {
    const Post = postClass();

    const saved = await Post.suppress(async () => await Post.build({ title: "a" }).save());

    expect(saved).toBe(true);
  });

  it("writes again after the block", async () => {
    const Post = postClass();

    await Post.suppress(async () => {
      await Post.build({ title: "a" }).save();
    });
    await Post.build({ title: "b" }).save();

    expect(await Post.all().count()).toBe(1);
  });

  it("returns what the block returned", async () => {
    const Post = postClass();

    expect(await Post.suppress(() => 123)).toBe(123);
  });

  /** One throwing import must not leave the model unable to save. */
  it("stops suppressing after the block throws", async () => {
    const Post = postClass();

    await expect(
      Post.suppress(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await Post.build({ title: "a" }).save();

    expect(await Post.all().count()).toBe(1);
  });

  it("reports whether it is suppressing", async () => {
    const Post = postClass();

    expect(Post.suppressed).toBe(false);

    await Post.suppress(() => {
      expect(Post.suppressed).toBe(true);
    });

    expect(Post.suppressed).toBe(false);
  });

  it("does not suppress another model", async () => {
    const Post = postClass();

    class Other extends Model<PostRow>("posts") {}
    Other.resetColumnInformation();

    await Post.suppress(async () => {
      await Other.build({ title: "a" }).save();
    });

    expect(await Other.all().count()).toBe(1);
  });
});

describe("recordTimestamps", () => {
  it("writes timestamps by default", async () => {
    const Post = postClass();
    const post = await Post.create({ title: "a" });

    expect(post.created_at).toBeDefined();
    expect(post.updated_at).toBeDefined();
  });

  it("writes none when the model turns them off", async () => {
    const Post = postClass();
    Post.recordTimestamps = false;

    const post = await Post.create({ title: "a" });
    const stored = await Post.find(post.id);

    // Null from the database rather than undefined: the column exists and was
    // simply never written, which is what turning timestamps off means.
    expect(stored.created_at).toBeNull();
    expect(stored.updated_at).toBeNull();
  });

  /**
   * updated_at usually means "when a person last changed this". A backfill
   * touching every row makes it mean "when we ran the backfill", which nobody
   * wanted recorded and cannot be undone.
   */
  it("leaves updated_at alone inside withoutTimestamps", async () => {
    const Post = postClass();
    const post = await Post.create({ title: "a" });
    // Read back rather than taken from memory: the column stores at a coarser
    // precision than a Date holds, so comparing the two differs by a
    // millisecond for reasons that have nothing to do with this.
    const before = (await Post.find(post.id)).updated_at;

    await Post.withoutTimestamps(async () => {
      post.title = "b";
      await post.save();
    });

    const found = await Post.find(post.id);

    expect(found.title).toBe("b");
    expect(new Date(found.updated_at as Date).getTime()).toBe(new Date(before as Date).getTime());
  });

  it("writes them again after the block", async () => {
    const Post = postClass();

    await Post.withoutTimestamps(async () => {
      await Post.create({ title: "a" });
    });

    const second = await Post.create({ title: "b" });

    expect(second.updated_at).toBeDefined();
    expect(Post.recordTimestamps).toBe(true);
  });

  it("restores the setting after the block throws", async () => {
    const Post = postClass();

    await expect(
      Post.withoutTimestamps(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(Post.recordTimestamps).toBe(true);
  });

  it("returns what the block returned", async () => {
    expect(await postClass().withoutTimestamps(() => 123)).toBe(123);
  });
});
