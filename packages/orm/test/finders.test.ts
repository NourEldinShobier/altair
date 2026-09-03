/**
 * Finding records, ported from `activerecord/test/cases/finder_test.rb`.
 *
 * The load-bearing part is `find` with several ids: it answered with one
 * record, because the ids became an `IN` and `first()` took whatever came out
 * of it. A caller asking for two got one, and asking for a row that does not
 * exist got the row that does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, RecordNotFound, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface TopicRow {
  id: number;
  title: string;
  views: number | null;
}

class Topic extends Model<TopicRow>("topics") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Topic.resetColumnInformation();

  await new SchemaStatements(connection).createTable("topics", (t) => {
    t.string("title");
    t.integer("views");
  });

  for (const title of ["First", "Second", "Third", "Fourth", "Fifth"]) {
    await Topic.create({ title: `The ${title} Topic of the day`, views: 0 });
  }
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("one id", () => {
  it("finds it", async () => {
    expect((await Topic.find(2)).title).toContain("Second");
  });

  it("raises for one that is not there", async () => {
    await expect(Topic.find(999)).rejects.toThrow(RecordNotFound);
  });

  it("says which id it could not find", async () => {
    await expect(Topic.find(999)).rejects.toThrow(/id = 999/);
  });
});

/**
 * Rails' `test_find_with_ids_returning_ordered`. The order is the one the ids
 * were given in, not the one the database returns — which is what makes this
 * usable for rebuilding a list somebody has already sorted.
 */
describe("several ids", () => {
  it("answers with all of them", async () => {
    const found = await Topic.find([1, 3]);

    expect(found).toHaveLength(2);
    expect(found.map((topic) => topic.id)).toEqual([1, 3]);
  });

  it("answers in the order they were asked for", async () => {
    const found = await Topic.find([4, 2, 5]);

    expect(found.map((topic) => topic.title)).toEqual([
      "The Fourth Topic of the day",
      "The Second Topic of the day",
      "The Fifth Topic of the day",
    ]);
  });

  // Rails' `find(["4", "2", "5"])`. An id out of a URL is a string and one off
  // the database is a number, and this is the ordinary case rather than an
  // edge one.
  it("takes ids as strings", async () => {
    const found = await Topic.find(["4", "2", "5"]);

    expect(found.map((topic) => topic.id)).toEqual([4, 2, 5]);
  });

  /**
   * This answered with the row that does exist. A caller reading
   * `find([1, 999])` has already decided that a missing row is a failure —
   * that is what separates `find` from `where`.
   */
  it("raises when one of them is missing", async () => {
    await expect(Topic.find([1, 999])).rejects.toThrow(RecordNotFound);
  });

  it("says how many it found and how many it wanted", async () => {
    await expect(Topic.find([1, 999])).rejects.toThrow(/found 1 results, but was looking for 2/);
  });

  // Asking for none of them is not a failure, and does not need a query.
  it("answers with nothing when given nothing", async () => {
    expect(await Topic.find([])).toEqual([]);
  });

  it("does not mind being given the same id twice", async () => {
    expect(await Topic.find([2, 2])).toHaveLength(2);
  });
});

describe("finding by other columns", () => {
  it("answers null rather than raising", async () => {
    expect(await Topic.findBy({ title: "Nothing" })).toBeNull();
  });

  it("finds by a column that is not the key", async () => {
    expect((await Topic.findBy({ title: "The Third Topic of the day" }))?.id).toBe(3);
  });
});

describe("the first and the last", () => {
  it("takes them in key order by default", async () => {
    expect((await Topic.all().first())?.id).toBe(1);
    expect((await Topic.all().last())?.id).toBe(5);
  });

  /**
   * `last` on an ordered relation is the other end of that order, not the last
   * row by key — reversing the order is the whole of what it means.
   */
  it("follows the order it was given", async () => {
    expect((await Topic.all().order("id", "desc").first())?.id).toBe(5);
    expect((await Topic.all().order("id", "desc").last())?.id).toBe(1);
  });

  it("answers null over nothing", async () => {
    expect(await Topic.where({ title: "Nothing" }).first()).toBeNull();
    expect(await Topic.where({ title: "Nothing" }).last()).toBeNull();
  });
});

describe("asking whether anything matches", () => {
  it("answers true when something does", async () => {
    expect(await Topic.all().exists()).toBe(true);
  });

  it("answers false when nothing does", async () => {
    expect(await Topic.where({ title: "Nothing" }).exists()).toBe(false);
  });

  // Rails' `exists_with_order`: the order cannot change the answer, and paying
  // for a sort to find out whether anything is there is waste.
  it("is not changed by an order", async () => {
    expect(await Topic.all().order("views", "desc").exists()).toBe(true);
  });

  it("is false for a relation that matches nothing", async () => {
    expect(await Topic.all().none().exists()).toBe(false);
  });
});
