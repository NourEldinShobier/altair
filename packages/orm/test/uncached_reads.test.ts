/**
 * What `uncached` does to the query cache, counted in statements rather than
 * in flags. Ported from `test_uncached` in
 * `activerecord/test/cases/query_cache_test.rb`.
 *
 * There are two query caches here. `query_cache.ts` holds the one that runs:
 * `Connection.query` consults it and `application.ts` wraps every request in
 * it. `query_analysis.ts` holds an older second one that nothing calls, and
 * `uncached` used to gate that.
 *
 * So `uncached` did nothing. Worse than nothing in context — reads inside the
 * block were answered from the very cache the caller had asked to bypass, and
 * a flag-based test could not see it, because the flag it checked was real and
 * did flip. Only counting statements shows it: two expected, zero executed.
 *
 * `uncached` is called for a read that must be fresh. Polling for a job to
 * finish, re-reading a row something outside the process just wrote. A stale
 * answer there is exactly what it was called to prevent.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { notifications } from "@altair/support";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import { withQueryCache, withoutQueryCache } from "../src/query_cache.js";
import { uncached } from "../src/query_analysis.js";

interface PostRow {
  id: number;
  title: string;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
}

let connection: Connection;
let executed = 0;

notifications.subscribe("sql.altair", (event) => {
  const sql = String((event as { payload?: { sql?: unknown } }).payload?.sql ?? "");

  if (/^\s*select/i.test(sql)) executed += 1;
});

/** How many SELECTs actually reached the database while the body ran. */
async function selectsDuring(body: () => Promise<void>): Promise<number> {
  executed = 0;
  await body();

  return executed;
}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.resetColumnInformation();

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
  });

  await Post.create({ title: "a" });
  // Warmed: a model's first read also reads its columns, and that extra
  // statement would land in whichever count came first.
  await Post.find(1);
});

describe("with no cache in scope", () => {
  it("asks twice for the same row", async () => {
    expect(
      await selectsDuring(async () => {
        await Post.find(1);
        await Post.find(1);
      }),
    ).toBe(2);
  });
});

describe("inside a query cache", () => {
  it("asks once", async () => {
    await withQueryCache(async () => {
      expect(
        await selectsDuring(async () => {
          await Post.find(1);
          await Post.find(1);
        }),
      ).toBe(1);
    });
  });

  /** The regression, and the number that names it: this used to be zero. */
  it("asks again inside an uncached block", async () => {
    await withQueryCache(async () => {
      // Populate it first, so a broken `uncached` has something to serve.
      await Post.find(1);

      expect(
        await selectsDuring(async () => {
          await uncached(async () => {
            await Post.find(1);
            await Post.find(1);
          });
        }),
      ).toBe(2);
    });
  });

  it("does the same through withoutQueryCache", async () => {
    await withQueryCache(async () => {
      await Post.find(1);

      expect(
        await selectsDuring(async () => {
          await withoutQueryCache(async () => {
            await Post.find(1);
            await Post.find(1);
          });
        }),
      ).toBe(2);
    });
  });

  it("caches again once the uncached block is over", async () => {
    await withQueryCache(async () => {
      await uncached(async () => Post.find(1));

      expect(
        await selectsDuring(async () => {
          await Post.find(1);
          await Post.find(1);
        }),
      ).toBe(1);
    });
  });

  it("reads fresh after a write, uncached or not", async () => {
    await withQueryCache(async () => {
      const post = await Post.find(1);

      post.title = "b";
      await post.save();

      expect((await Post.find(1)).title).toBe("b");
    });
  });

  /**
   * A block does not leave the cache off behind it, which is the failure that
   * would turn one error into a performance regression nobody connects to it.
   */
  it("caches again after an uncached block throws", async () => {
    await withQueryCache(async () => {
      await expect(
        uncached(() => {
          throw new Error("from the body");
        }),
      ).rejects.toThrow("from the body");

      expect(
        await selectsDuring(async () => {
          await Post.find(1);
          await Post.find(1);
        }),
      ).toBe(1);
    });
  });
});
