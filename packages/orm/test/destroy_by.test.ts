/**
 * Removing records by their conditions, ported from
 * `activerecord/test/cases/persistence_test.rb` and `relations_test.rb`.
 *
 * `destroyBy` and `deleteBy` look alike and are not. One runs every callback
 * and takes the associations with it; the other is a single statement and
 * takes nothing. Choosing wrongly is either an hour where a second would do,
 * or orphaned rows nobody will ever find.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;
const destroyed: number[] = [];

class Post extends Model<{ id: number; title: string; draft: boolean | null }>("posts") {
  static {
    this.setCallback("destroy", "before", function (this: Post) {
      destroyed.push(this.id);
    });
  }
}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.boolean("draft");
  });

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;
  destroyed.length = 0;

  await Post.create({ title: "A", draft: true });
  await Post.create({ title: "B", draft: true });
  await Post.create({ title: "C", draft: false });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("destroying by conditions", () => {
  it("removes the matching rows", async () => {
    await Post.destroyBy({ draft: true });

    expect((await Post.all()).map((post) => post.title)).toEqual(["C"]);
  });

  it("answers how many it destroyed", async () => {
    expect(await Post.destroyBy({ draft: true })).toBe(2);
  });

  /**
   * The whole difference from `deleteBy`. A destroyed post should still take
   * its comments and its attachments with it, and only the callbacks know how.
   */
  it("runs each record's callbacks", async () => {
    await Post.destroyBy({ draft: true });

    expect(destroyed).toHaveLength(2);
  });

  it("destroys nothing when nothing matches", async () => {
    expect(await Post.destroyBy({ title: "nope" })).toBe(0);
    expect(destroyed).toEqual([]);
  });
});

describe("deleting by conditions", () => {
  it("removes the matching rows", async () => {
    await Post.deleteBy({ draft: true });

    expect((await Post.all()).map((post) => post.title)).toEqual(["C"]);
  });

  it("answers how many it deleted", async () => {
    expect(await Post.deleteBy({ draft: true })).toBe(2);
  });

  /**
   * For rows nothing else points at — a session table, an expired token —
   * where a callback chain per row is the difference between a second and an
   * hour.
   */
  it("runs no callbacks at all", async () => {
    await Post.deleteBy({ draft: true });

    expect(destroyed).toEqual([]);
  });

  it("deletes nothing when nothing matches", async () => {
    expect(await Post.deleteBy({ title: "nope" })).toBe(0);
  });
});

/**
 * The count is the only way a caller can tell "deleted nothing because nothing
 * matched" from "deleted nothing because the conditions were wrong".
 */
describe("deleteAll's count", () => {
  it("says how many rows went", async () => {
    expect(await Post.where({ draft: true }).deleteAll()).toBe(2);
  });

  it("says zero for a relation that matches nothing", async () => {
    expect(await Post.all().none().deleteAll()).toBe(0);
  });
});
