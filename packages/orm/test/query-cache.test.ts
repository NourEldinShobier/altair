/**
 * The query cache.
 *
 * Mirrors activerecord/test/cases/query_cache_test.rb. The tests that matter
 * are the invalidation ones: a cache that saves a query is worth little, and a
 * cache that answers with rows from before a write is worth less than nothing.
 *
 * Queries are counted off the notifications bus, which is the same place the
 * request log counts them — so a hit that reported itself would be caught here
 * as well as being wrong in the log.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Model,
  SchemaStatements,
  setConnection,
  withQueryCache,
  withoutQueryCache,
  isCacheable,
} from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { notifications } from "@altair/support";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {}

let connection: Connection;
let queries: string[];
let subscription: { unsubscribe(): void };

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.resetColumnInformation();

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
  });

  await Post.create({ title: "A" });
  await Post.create({ title: "B" });

  queries = [];
  subscription = notifications.subscribe<{ sql: string }>("sql.altair", (event) => {
    queries.push(event.payload.sql);
  });
});

afterEach(() => {
  subscription.unsubscribe();
});

const selects = () => queries.filter((sql) => sql.trimStart().toUpperCase().startsWith("SELECT"));

describe("what may be cached", () => {
  it("caches a plain select", () => {
    expect(isCacheable("SELECT * FROM posts")).toBe(true);
  });

  it("refuses anything that writes", () => {
    expect(isCacheable("INSERT INTO posts (title) VALUES (?)")).toBe(false);
    expect(isCacheable("UPDATE posts SET title = ?")).toBe(false);
    expect(isCacheable("DELETE FROM posts")).toBe(false);
  });

  // A `RETURNING` clause makes an insert look like a read to a naive check.
  it("refuses an insert that returns rows", () => {
    expect(isCacheable("INSERT INTO posts (title) VALUES (?) RETURNING *")).toBe(false);
  });

  // Asking again is the entire point of a locking read: one answered from
  // memory takes no lock at all.
  it("refuses a locking read", () => {
    expect(isCacheable("SELECT * FROM posts FOR UPDATE")).toBe(false);
    expect(isCacheable("SELECT * FROM posts FOR SHARE")).toBe(false);
    expect(isCacheable("SELECT * FROM posts LOCK IN SHARE MODE")).toBe(false);
  });
});

describe("inside a cache", () => {
  it("asks once for the same query", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "A" }).toArray();
    });

    expect(selects()).toHaveLength(1);
  });

  it("gives the same answer each time", async () => {
    await withQueryCache(async () => {
      const first = await Post.where({ title: "A" }).toArray();
      const second = await Post.where({ title: "A" }).toArray();

      expect(second.map((post) => post.title)).toEqual(first.map((post) => post.title));
    });
  });

  it("tells two different queries apart", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "B" }).toArray();
    });

    expect(selects()).toHaveLength(2);
  });

  // The same SQL with different values is a different question.
  it("tells the bindings apart", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "B" }).toArray();
    });

    expect(selects()).toHaveLength(2);
  });

  // A hit is not a query. Reporting one would make the request log say four
  // where the database saw one.
  it("reports nothing on the bus for a hit", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();
      queries = [];
      await Post.where({ title: "A" }).toArray();
    });

    expect(queries).toEqual([]);
  });

  it("hands back a copy, so a caller cannot poison the entry", async () => {
    await withQueryCache(async () => {
      const first = await Post.all().toArray();
      first.length = 0;

      expect(await Post.all().toArray()).toHaveLength(2);
    });
  });
});

// A cache that survived a write would answer with the rows from before it,
// which is worse than having no cache at all.
describe("writes empty it", () => {
  it("after an insert", async () => {
    await withQueryCache(async () => {
      expect(await Post.count()).toBe(2);

      await Post.create({ title: "C" });

      expect(await Post.count()).toBe(3);
    });
  });

  it("after an update", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();

      await Post.where({ title: "A" }).updateAll({ title: "renamed" });

      expect(await Post.where({ title: "A" }).count()).toBe(0);
    });
  });

  it("after a delete", async () => {
    await withQueryCache(async () => {
      expect(await Post.count()).toBe(2);

      await Post.where({ title: "A" }).deleteAll();

      expect(await Post.count()).toBe(1);
    });
  });

  it("empties all of it, not just the rows that changed", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "B" }).toArray();
      queries = [];

      await Post.create({ title: "C" });

      await Post.where({ title: "A" }).toArray();
      await Post.where({ title: "B" }).toArray();

      // Narrowed to the two reads under test. `create` issues its own read on
      // some adapters — MySQL asks for the inserted id — and counting every
      // SELECT made this an assertion about how the driver inserts rather
      // than about the cache.
      expect(selects().filter((sql) => sql.includes("title"))).toHaveLength(2);
    });
  });
});

describe("outside a cache", () => {
  it("asks every time", async () => {
    await Post.where({ title: "A" }).toArray();
    await Post.where({ title: "A" }).toArray();

    expect(selects()).toHaveLength(2);
  });

  it("can be turned off for a read that has to be fresh", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();

      await withoutQueryCache(async () => {
        await Post.where({ title: "A" }).toArray();
      });
    });

    expect(selects()).toHaveLength(2);
  });

  // Two requests in flight must never share one.
  it("keeps concurrent blocks apart", async () => {
    await Promise.all([
      withQueryCache(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await Post.where({ title: "A" }).toArray();
      }),
      withQueryCache(async () => {
        await Post.where({ title: "A" }).toArray();
      }),
    ]);

    expect(selects()).toHaveLength(2);
  });

  it("reuses the one already in scope rather than starting a second", async () => {
    await withQueryCache(async () => {
      await Post.where({ title: "A" }).toArray();

      await withQueryCache(async () => {
        await Post.where({ title: "A" }).toArray();
      });
    });

    expect(selects()).toHaveLength(1);
  });
});
