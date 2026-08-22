/**
 * Query depth: aggregates, grouping, scopes, bulk writes and transactions.
 *
 * Mirrors activerecord/test/cases/calculations_test.rb, scoping/,
 * relation/mutation_test.rb and transactions_test.rb.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface PostAttributes {
  id: number;
  title: string;
  category: string;
  views: number;
  published: number;
}

class Post extends Model<PostAttributes>("posts") {}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.string("category");
    t.integer("views", { default: 0 });
    t.integer("published", { default: 0 });
  });

  await Post.create({ title: "A", category: "tech", views: 10, published: 1 });
  await Post.create({ title: "B", category: "tech", views: 20, published: 1 });
  await Post.create({ title: "C", category: "life", views: 30, published: 0 });
});

describe("aggregates", () => {
  it("sums", async () => {
    expect(await Post.all().sum("views")).toBe(60);
    expect(await Post.where({ category: "tech" }).sum("views")).toBe(30);
  });

  it("returns zero for a sum over nothing", async () => {
    expect(await Post.where({ category: "none" }).sum("views")).toBe(0);
  });

  it("averages", async () => {
    expect(await Post.all().average("views")).toBe(20);
  });

  it("finds the minimum and maximum", async () => {
    expect(await Post.all().minimum("views")).toBe(10);
    expect(await Post.all().maximum("views")).toBe(30);
  });

  // An aggregate over an empty set is null, not zero — Rails distinguishes
  // "no rows" from "the answer is zero".
  it("returns null for an average over nothing", async () => {
    expect(await Post.where({ category: "none" }).average("views")).toBeNull();
  });

  // Order and limit would change the answer rather than the rows, so an
  // aggregate ignores them.
  it("ignores order and limit", async () => {
    expect(await Post.all().order("views", "desc").limit(1).sum("views")).toBe(60);
  });
});

describe("grouping", () => {
  it("groups and counts", async () => {
    const rows = await connection.query<{ category: string; count: number }>(
      Post.all()
        .group("category")
        .select("category")
        .toSql()
        .sql.replace('SELECT "posts"."category"', 'SELECT "posts"."category", COUNT(*) AS "count"'),
    );

    expect(rows).toHaveLength(2);
  });

  it("filters groups with having", () => {
    const { sql } = Post.all().group("category").having("COUNT(*) > ?", 1).toSql();

    expect(sql).toContain("GROUP BY");
    expect(sql).toContain("HAVING COUNT(*) > ?");
  });

  it("selects distinct rows", async () => {
    const categories = await Post.all().distinct().select("category").pluck("category");
    expect([...new Set(categories)]).toHaveLength(2);
  });
});

describe("scopes", () => {
  it("declares a named scope that composes", async () => {
    class Article extends Model<PostAttributes>("posts") {}
    Article.scope("published", (relation) => relation.where({ published: 1 }));

    const published = await (
      Article as unknown as { published(): Promise<PostAttributes[]> }
    ).published();
    expect(published).toHaveLength(2);
  });

  it("chains a scope with other query methods", async () => {
    class Article extends Model<PostAttributes>("posts") {}
    Article.scope("popular", (relation) => relation.where("views >= ?", 20));

    const relation = (
      Article as unknown as {
        popular(): { order(c: string, d?: "asc" | "desc"): Promise<PostAttributes[]> };
      }
    ).popular();

    expect((await relation.order("views")).map((post) => post.title)).toEqual(["B", "C"]);
  });
});

describe("find or create", () => {
  it("returns the existing record", async () => {
    const post = await Post.findOrCreateBy({ title: "A" });

    expect(post.id).toBe(1);
    expect(await Post.count()).toBe(3);
  });

  it("creates when there is no match", async () => {
    const post = await Post.findOrCreateBy({ title: "D" }, { category: "new" });

    expect(post.category).toBe("new");
    expect(await Post.count()).toBe(4);
  });

  it("initializes without saving", async () => {
    const post = await Post.findOrInitializeBy({ title: "E" });

    expect(post.isNewRecord).toBe(true);
    expect(await Post.count()).toBe(3);
  });
});

describe("bulk writes", () => {
  it("updates every matching row in one statement", async () => {
    await Post.where({ category: "tech" }).updateAll({ published: 0 });

    expect(await Post.where({ published: 1 }).count()).toBe(0);
    expect(await Post.count()).toBe(3);
  });

  it("updates everything when unscoped", async () => {
    await Post.all().updateAll({ views: 0 });
    expect(await Post.all().sum("views")).toBe(0);
  });

  it("rejects an invalid column", async () => {
    await expect(Post.all().updateAll({ "views = 1; DROP TABLE posts": 1 })).rejects.toThrow(
      "Invalid column name",
    );
  });

  it("deletes matching rows without callbacks", async () => {
    await Post.where({ category: "tech" }).deleteAll();
    expect(await Post.count()).toBe(1);
  });

  // destroyAll instantiates so callbacks run; deleteAll deliberately does not.
  it("destroys matching rows with callbacks", async () => {
    const destroyed: string[] = [];

    class Article extends Model<PostAttributes>("posts") {}
    Article.setCallback("destroy", "before", function (this: Article) {
      destroyed.push(String((this as unknown as PostAttributes).title));
    });

    expect(await Article.destroyAll({ category: "tech" })).toBe(2);
    expect(destroyed.sort()).toEqual(["A", "B"]);
    expect(await Article.count()).toBe(1);
  });
});

describe("transactions", () => {
  it("commits when the block returns", async () => {
    await Post.transaction(async () => {
      await Post.create({ title: "D", category: "tech" });
    });

    expect(await Post.count()).toBe(4);
  });

  it("rolls back when the block throws", async () => {
    await expect(
      Post.transaction(async () => {
        await Post.create({ title: "D", category: "tech" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(await Post.count()).toBe(3);
  });

  it("rolls back every write in the block", async () => {
    await expect(
      Post.transaction(async () => {
        await Post.create({ title: "D", category: "tech" });
        await Post.create({ title: "E", category: "tech" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(await Post.count()).toBe(3);
  });

  it("returns the block's value", async () => {
    expect(await Post.transaction(async () => "done")).toBe("done");
  });

  // A database has no nested BEGIN, so without savepoints a model method that
  // opens a transaction could not be called from another one — which is not a
  // rule anyone could follow.
  it("nests", async () => {
    await Post.transaction(async () => {
      await Post.create({ title: "D", category: "tech" });
      await Post.transaction(async () => {
        await Post.create({ title: "E", category: "tech" });
      });
    });

    expect(await Post.count()).toBe(5);
  });

  it("undoes only the inner block when it throws", async () => {
    await Post.transaction(async () => {
      await Post.create({ title: "D", category: "tech" });

      await expect(
        Post.transaction(async () => {
          await Post.create({ title: "E", category: "tech" });
          throw new Error("nope");
        }),
      ).rejects.toThrow("nope");
    });

    expect(await Post.count()).toBe(4);
    expect(await Post.exists({ title: "D" })).toBe(true);
    expect(await Post.exists({ title: "E" })).toBe(false);
  });

  it("undoes the inner block too when the outer one throws", async () => {
    await expect(
      Post.transaction(async () => {
        await Post.transaction(async () => {
          await Post.create({ title: "D", category: "tech" });
        });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(await Post.count()).toBe(3);
  });

  it("nests more than one level", async () => {
    await Post.transaction(async () => {
      await Post.transaction(async () => {
        await Post.transaction(async () => {
          await Post.create({ title: "D", category: "tech" });
        });
      });
    });

    expect(await Post.count()).toBe(4);
  });

  // The transaction has to open in one place and close in another for a test
  // helper to wrap a test body in it.
  it("can be opened and rolled back by hand", async () => {
    await connection.beginTransaction();
    expect(connection.isInTransaction).toBe(true);

    await Post.create({ title: "D", category: "tech" });
    expect(await Post.count()).toBe(4);

    await connection.rollbackTransaction();

    expect(connection.isInTransaction).toBe(false);
    expect(await Post.count()).toBe(3);
  });

  it("nests inside a transaction opened by hand", async () => {
    await connection.beginTransaction();

    await Post.transaction(async () => {
      await Post.create({ title: "D", category: "tech" });
    });
    expect(await Post.count()).toBe(4);

    await connection.rollbackTransaction();
    expect(await Post.count()).toBe(3);
  });

  it("commits one opened by hand", async () => {
    await connection.beginTransaction();
    await Post.create({ title: "D", category: "tech" });
    await connection.commitTransaction();

    expect(await Post.count()).toBe(4);
  });

  // The connection is swapped for the duration, so it has to be restored even
  // when the block throws.
  it("restores the connection afterwards", async () => {
    await expect(
      Post.transaction(async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow();

    expect(await Post.count()).toBe(3);
  });
});
