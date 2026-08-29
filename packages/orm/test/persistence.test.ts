/**
 * Writing without going through save, ported from
 * `activerecord/test/cases/persistence_test.rb`.
 *
 * These are the methods Rails has for the columns that are bookkeeping rather
 * than content — a counter, a flag, a job id — and each of them skips
 * something on purpose. What they skip is what the cases here are about.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  views: number | null;
  published: number | null;
  updated_at: Date | null;
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
    t.integer("views");
    t.integer("published");
    t.datetime("updated_at");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/**
 * Rails' `update_column`. No validations, no callbacks, no `updated_at` —
 * which is the whole point and the whole danger.
 */
describe("writing a column straight to the row", () => {
  it("writes it", async () => {
    const post = await Post.create({ title: "A", views: 0 });

    await post.updateColumn("title", "B");

    expect(post.title).toBe("B");
    expect((await Post.find(post.id)).title).toBe("B");
  });

  it("writes several at once", async () => {
    const post = await Post.create({ title: "A", views: 0 });

    await post.updateColumns({ title: "B", views: 9 });

    const reloaded = await Post.find(post.id);
    expect([reloaded.title, reloaded.views]).toEqual(["B", 9]);
  });

  // The reason to reach for it: a row marked processed should not look edited.
  it("leaves updated_at alone", async () => {
    const post = await Post.create({ title: "A", views: 0 });
    const before = post.updated_at;

    await post.updateColumn("views", 5);

    expect((await Post.find(post.id)).updated_at).toEqual(before);
  });

  it("runs no callbacks", async () => {
    const ran: string[] = [];

    class Article extends Model<PostRow>("posts") {
      static {
        this.setCallback("save", "before", () => void ran.push("save"));
      }
    }

    const article = await Article.create({ title: "A", views: 0 });
    ran.length = 0;

    await article.updateColumn("title", "B");

    expect(ran).toEqual([]);
  });

  it("leaves the record clean rather than dirty", async () => {
    const post = await Post.create({ title: "A", views: 0 });

    await post.updateColumn("title", "B");

    expect(post.changed()).toEqual([]);
  });

  // Checked rather than escaped, as everywhere else a column name reaches SQL.
  it("refuses a column that is not there", async () => {
    const post = await Post.create({ title: "A", views: 0 });

    await expect(post.updateColumn("nope" as "title", 1)).rejects.toThrow(/Invalid column name/);
  });

  it("refuses a record that has no row yet", async () => {
    await expect(new Post({ title: "A" }).updateColumn("title", "B")).rejects.toThrow(
      /Save the record first/,
    );
  });
});

/**
 * Rails' `increment!`. The point is that the addition happens in the database:
 * two requests incrementing at once both read 5, both write 6, and one view is
 * gone.
 */
describe("adding to a column", () => {
  it("adds one by default", async () => {
    const post = await Post.create({ title: "A", views: 5 });

    await post.increment("views");

    expect(post.views).toBe(6);
    expect((await Post.find(post.id)).views).toBe(6);
  });

  it("adds what it is given", async () => {
    const post = await Post.create({ title: "A", views: 5 });

    await post.increment("views", 10);

    expect(post.views).toBe(15);
  });

  it("subtracts the other way", async () => {
    const post = await Post.create({ title: "A", views: 5 });

    await post.decrement("views", 2);

    expect(post.views).toBe(3);
  });

  // A counter nobody has set yet is null, and null plus one is null.
  it("treats an empty column as zero", async () => {
    const post = await Post.create({ title: "A" });

    await post.increment("views");

    expect(post.views).toBe(1);
  });

  /**
   * The whole reason it is not `post.views += 1; save()`. Two records in
   * memory, both holding 5, both incrementing — the answer is 7 rather than 6.
   */
  it("does not lose one when two do it at once", async () => {
    const post = await Post.create({ title: "A", views: 5 });

    const first = await Post.find(post.id);
    const second = await Post.find(post.id);

    await first.increment("views");
    await second.increment("views");

    expect((await Post.find(post.id)).views).toBe(7);

    // And the record in hand holds what the row holds. Adding in memory rather
    // than reading back would leave `second` saying 6 — the database would be
    // right and the object would not, which is the harder bug to see. The
    // check above passes either way; only this one tells them apart.
    expect(second.views).toBe(7);
  });

  it("leaves the record clean", async () => {
    const post = await Post.create({ title: "A", views: 5 });

    await post.increment("views");

    expect(post.changed()).toEqual([]);
  });
});

/**
 * Rails' `toggle!`. Read and written rather than `NOT column` in SQL, because
 * a flag is null before anybody sets it and `NOT NULL` is null — a toggle that
 * left it null would do nothing and say it had.
 */
describe("flipping a flag", () => {
  it("turns it on", async () => {
    const post = await Post.create({ title: "A", published: 0 });

    await post.toggle("published");

    expect(post.published).toBe(1);
    expect((await Post.find(post.id)).published).toBe(1);
  });

  it("turns it off again", async () => {
    const post = await Post.create({ title: "A", published: 1 });

    await post.toggle("published");

    expect(post.published).toBe(0);
  });

  it("turns on one that was never set", async () => {
    const post = await Post.create({ title: "A" });

    await post.toggle("published");

    expect(post.published).toBe(1);
  });
});

/**
 * Rails' `destroyed?`. Not the same question as `isPersisted`, which a record
 * that was never saved also answers no to — and a caller cleaning up after a
 * failed request needs to tell "never written" from "gone".
 */
describe("asking whether it was destroyed", () => {
  it("says no while it is there", async () => {
    const post = await Post.create({ title: "A" });

    expect(post.isDestroyed).toBe(false);
  });

  it("says yes once it is gone", async () => {
    const post = await Post.create({ title: "A" });

    await post.destroy();

    expect(post.isDestroyed).toBe(true);
  });

  it("says no for one that was never saved", async () => {
    const post = new Post({ title: "A" });

    expect(post.isDestroyed).toBe(false);
    expect(post.isPersisted).toBe(false);
  });
});
