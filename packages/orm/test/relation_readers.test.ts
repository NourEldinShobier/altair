/**
 * The small readers on a relation.
 *
 * Mirrors activerecord/test/cases/relations_test.rb's `take`, `ids`, `any?`,
 * `many?`, `none` and `destroy_all` cases.
 *
 * Most of these are conveniences. `none` is not: it is the answer a method
 * gives when it has decided there is nothing to return, and the whole value of
 * it is that it costs no query and survives being chained onto.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { notifications } from "@altair/support";
import { Connection, Model, SchemaStatements, beforeDestroy, setConnection } from "../src/index.js";
import { testConnection } from "./support/database.js";

interface PostRow {
  id: number;
  title: string;
  published: number;
}

let destroyed: string[] = [];

class Post extends Model<PostRow>("posts") {
  @beforeDestroy
  recordIt(): void {
    destroyed.push(String(this.title));
  }
}

let connection: Connection;

/** Counts statements off the instrumentation bus, which every query reports on. */
const countingQueries = async <T>(body: () => Promise<T>): Promise<[T, number]> => {
  let queries = 0;
  const subscription = notifications.subscribe("sql.altair", () => {
    queries += 1;
  });

  try {
    return [await body(), queries];
  } finally {
    subscription.unsubscribe();
  }
};

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;
  destroyed = [];

  const schema = new SchemaStatements(connection);
  await schema.dropTable("posts", { ifExists: true });
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("published", { default: 0 });
  });

  await Post.create({ title: "one", published: 1 });
  await Post.create({ title: "two", published: 1 });
  await Post.create({ title: "three", published: 0 });
});

describe("take", () => {
  it("returns a record", async () => {
    expect(await Post.all().take()).not.toBeNull();
  });

  it("returns null when nothing matches", async () => {
    expect(await Post.where({ published: 9 }).take()).toBeNull();
  });
});

describe("ids", () => {
  it("returns the primary keys", async () => {
    expect(await Post.all().ids()).toHaveLength(3);
  });

  it("respects the conditions", async () => {
    expect(await Post.where({ published: 1 }).ids()).toHaveLength(2);
  });

  it("is empty when nothing matches", async () => {
    expect(await Post.where({ published: 9 }).ids()).toEqual([]);
  });
});

describe("any and many", () => {
  it("say whether anything matches", async () => {
    expect(await Post.where({ published: 1 }).any()).toBe(true);
    expect(await Post.where({ published: 9 }).any()).toBe(false);
  });

  it("tell one apart from more than one", async () => {
    expect(await Post.where({ published: 1 }).many()).toBe(true);
    expect(await Post.where({ published: 0 }).many()).toBe(false);
    expect(await Post.where({ published: 9 }).many()).toBe(false);
  });

  // Two rows fetched rather than a count: the question is "more than one", and
  // counting a million rows to learn there are at least two is work nobody
  // asked for.
  it("asks one question to answer many", async () => {
    const [, queries] = await countingQueries(() => Post.all().many());

    expect(queries).toBe(1);
  });
});

/**
 * `where({ id: null })` is the usual stand-in for this and is not the same
 * thing: it runs a query, and it stops being empty the moment somebody chains
 * an `or` onto it.
 */
describe("none", () => {
  it("is empty", async () => {
    expect(await Post.all().none()).toEqual([]);
  });

  it("asks the database nothing at all", async () => {
    const [, queries] = await countingQueries(async () => {
      await Post.all().none().toArray();
      await Post.all().none().count();
      await Post.all().none().ids();
      await Post.all().none().exists();
      await Post.all().none().maximum("id");
    });

    expect(queries).toBe(0);
  });

  it("answers each reader with its own kind of nothing", async () => {
    expect(await Post.all().none().count()).toBe(0);
    expect(await Post.all().none().exists()).toBe(false);
    expect(await Post.all().none().ids()).toEqual([]);
    expect(await Post.all().none().maximum("id")).toBeNull();
    expect(await Post.all().none().take()).toBeNull();
  });

  // The point of returning a relation rather than an array: the caller does
  // not have to know, and keeps chaining.
  it("stays empty however it is chained onto", async () => {
    const chained = Post.all().none().where({ published: 1 }).order("title").limit(10);

    const [rows, queries] = await countingQueries(() => chained.toArray());

    expect(rows).toEqual([]);
    expect(queries).toBe(0);
  });

  it("does not take the emptiness back to the relation it came from", async () => {
    const all = Post.all();
    all.none();

    expect(await all.count()).toBe(3);
  });

  // A guard clause that returns `none` must not delete the table when the
  // caller goes on to call `deleteAll` on it.
  it("deletes nothing", async () => {
    await Post.all().none().deleteAll();

    expect(await Post.all().count()).toBe(3);
  });
});

describe("destroyAll", () => {
  it("removes the matching records", async () => {
    await Post.where({ published: 0 }).destroyAll();

    expect(await Post.all().count()).toBe(2);
  });

  it("says how many it removed", async () => {
    expect(await Post.where({ published: 1 }).destroyAll()).toBe(2);
  });

  // The difference from `deleteAll`, and the reason for the slower path: a
  // record with dependents or a callback needs to be loaded to be destroyed.
  it("runs the callbacks that deleteAll skips", async () => {
    await Post.where({ published: 0 }).destroyAll();

    expect(destroyed).toEqual(["three"]);
  });

  it("runs none of them for deleteAll", async () => {
    await Post.where({ published: 0 }).deleteAll();

    expect(destroyed).toEqual([]);
  });
});
