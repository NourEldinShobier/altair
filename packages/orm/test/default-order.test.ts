/**
 * `defaultOrder`, ported from `default_order` in
 * `activerecord/lib/active_record/relation/query_methods.rb` and its
 * documented example: `default_order('email DESC').order('id ASC')` orders by
 * `id ASC` alone.
 *
 * The distinction from `order` is the whole of it. `order` appends, so a scope
 * that orders and a caller who also orders produce `ORDER BY created_at DESC,
 * title` — the scope's wins and the caller's decides ties, which is not what
 * either of them asked for. A list sorted by the column somebody clicked
 * comes back sorted by date.
 *
 * A default is what a scope wants: it holds when nobody says otherwise and
 * gets out of the way when somebody does.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface PostRow {
  id: number;
  title: string;
  rank: number;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
  declare rank: number;
}

let connection: Connection;

const titles = async (relation: { toArray(): Promise<Post[]> }): Promise<string[]> =>
  (await relation.toArray()).map((post) => post.title);

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.resetColumnInformation();

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("rank");
  });

  // Deliberately at odds: by rank is c, b, a; by title is a, b, c.
  await Post.create({ title: "c", rank: 1 });
  await Post.create({ title: "b", rank: 2 });
  await Post.create({ title: "a", rank: 3 });
});

describe("with nobody asking for an order", () => {
  it("holds", async () => {
    expect(await titles(Post.all().defaultOrder("rank"))).toEqual(["c", "b", "a"]);
  });

  it("takes a direction", async () => {
    expect(await titles(Post.all().defaultOrder("rank", "desc"))).toEqual(["a", "b", "c"]);
  });

  it("builds on another default", async () => {
    expect(await titles(Post.all().defaultOrder("rank").defaultOrder("title"))).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

describe("with a caller asking for one", () => {
  /** The point: replaced entirely, not appended to. */
  it("gets out of the way", async () => {
    expect(await titles(Post.all().defaultOrder("rank").order("title"))).toEqual(["a", "b", "c"]);
  });

  /**
   * Read off the statement, because the rows cannot show it: appending the
   * default *after* the caller's order sorts the same way whenever the
   * caller's column has no ties, which is most data and all of the data in a
   * test. The clause is where the difference lives.
   */
  it("leaves the default out of the statement entirely", () => {
    const { sql } = Post.all().defaultOrder("rank").order("title").toSql();

    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("title");
    expect(sql).not.toContain("rank");
  });

  it("does the same whichever came first", async () => {
    expect(await titles(Post.all().order("title").defaultOrder("rank"))).toEqual(["a", "b", "c"]);
  });

  /**
   * Rails' own example: two `order` calls still build on each other, and it is
   * the pair of them together that replaces the default.
   */
  it("is replaced by all of them, not only the first", async () => {
    const ordered = Post.all().defaultOrder("rank").order("rank", "desc").order("title");

    expect(await titles(ordered)).toEqual(["a", "b", "c"]);
  });

  it("stays replaced through a where added afterwards", async () => {
    const ordered = Post.all()
      .defaultOrder("rank")
      .order("title")
      .where({ rank: [1, 2, 3] });

    expect(await titles(ordered)).toEqual(["a", "b", "c"]);
  });
});

describe("the relation it was called on", () => {
  it("is left alone", async () => {
    const base = Post.all().defaultOrder("rank");

    await titles(base.order("title"));

    expect(await titles(base)).toEqual(["c", "b", "a"]);
  });
});

describe("a direction that is not one", () => {
  /**
   * Checked at run time as well as by the compiler, for the same reason
   * `order` checks: a direction is usually a query parameter, and the type
   * says nothing about a string that arrived over the wire.
   */
  it("is refused rather than read as ascending", () => {
    expect(() => Post.all().defaultOrder("rank", "descending" as never)).toThrow(
      /Unknown sort direction/,
    );
  });
});
