/**
 * The ordinal finders and reverseOrder, ported from
 * `activerecord/test/cases/finder_test.rb`, plus `calculate` from
 * `calculations_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface TopicRow {
  id: number;
  title: string;
  rank: number | null;
}

class Topic extends Model<TopicRow>("topics") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Topic.columnCache = undefined;
  Topic.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("topics", (t) => {
    t.string("title");
    t.integer("rank");
  });

  for (const [title, rank] of [
    ["one", 5],
    ["two", 3],
    ["three", 9],
    ["four", 1],
    ["five", 7],
    ["six", null],
  ] as [string, number | null][]) {
    await Topic.create({ title, rank });
  }
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("counting from the front", () => {
  it("finds the second", async () => {
    expect((await Topic.all().second())?.title).toBe("two");
  });

  it("finds the third, fourth and fifth", async () => {
    expect((await Topic.all().third())?.title).toBe("three");
    expect((await Topic.all().fourth())?.title).toBe("four");
    expect((await Topic.all().fifth())?.title).toBe("five");
  });

  /** Without an ORDER BY there is no second row, only whichever came back. */
  it("orders by the primary key when nothing else is given", async () => {
    expect((await Topic.all().second())?.id).toBe(2);
  });

  it("respects an explicit order", async () => {
    expect((await Topic.all().order("title").second())?.title).toBe("four");
  });

  it("respects the conditions", async () => {
    const found = await Topic.where({ rank: null }).first();

    expect(found?.title).toBe("six");
  });

  it("gives null when the relation is shorter than that", async () => {
    expect(await Topic.all().fortyTwo()).toBeNull();
  });

  it("gives null on an empty relation", async () => {
    expect(await Topic.where({ title: "nope" }).second()).toBeNull();
  });
});

describe("counting from the back", () => {
  it("finds the second to last", async () => {
    expect((await Topic.all().secondToLast())?.title).toBe("five");
  });

  it("finds the third to last", async () => {
    expect((await Topic.all().thirdToLast())?.title).toBe("four");
  });

  it("respects an explicit order", async () => {
    expect((await Topic.all().order("title").secondToLast())?.title).toBe("three");
  });

  it("gives null when the relation is shorter than that", async () => {
    expect(await Topic.where({ title: "one" }).secondToLast()).toBeNull();
  });
});

describe("reverseOrder", () => {
  it("turns the order around", async () => {
    const titles = (await Topic.all().order("title").reverseOrder().toArray()).map(
      (one) => one.title,
    );

    expect(titles[0]).toBe("two");
  });

  /** Without this, last() would mean whichever row the planner handed back. */
  it("falls back to the primary key descending", async () => {
    expect((await Topic.all().reverseOrder().first())?.id).toBe(6);
  });

  /**
   * Every ordering flips, not just the first — otherwise a two-column sort
   * comes back grouped the old way and reversed only within each group.
   */
  it("flips every ordering, not only the first", async () => {
    const forward = Topic.all().order("rank", "asc").order("title", "asc");
    const { sql } = forward.reverseOrder().toSql();

    expect(sql).toMatch(/DESC.*DESC/);
    expect(sql).not.toMatch(/ASC/);
  });

  it("leaves the original relation alone", async () => {
    const ordered = Topic.all().order("title");
    ordered.reverseOrder();

    expect((await ordered.first())?.title).toBe("five");
  });

  it("agrees with last()", async () => {
    const viaReverse = await Topic.all().order("rank", "asc").reverseOrder().first();

    expect(viaReverse?.id).toBe(
      await Topic.all()
        .order("rank", "asc")
        .last()
        .then((r) => r?.id),
    );
  });
});

describe("calculate", () => {
  it("sums", async () => {
    expect(await Topic.all().calculate("sum", "rank")).toBe(25);
  });

  it("averages, minimises and maximises", async () => {
    expect(await Topic.all().calculate("minimum", "rank")).toBe(1);
    expect(await Topic.all().calculate("maximum", "rank")).toBe(9);
    expect(await Topic.all().calculate("average", "rank")).toBe(5);
  });

  it("counts every row without a column", async () => {
    expect(await Topic.all().calculate("count")).toBe(6);
  });

  /** The whole difference from COUNT(*), and why Rails takes a column. */
  it("counts only the non-null values of a column", async () => {
    expect(await Topic.all().calculate("count", "rank")).toBe(5);
  });

  it("agrees with the named methods", async () => {
    expect(await Topic.all().calculate("sum", "rank")).toBe(await Topic.all().sum("rank"));
  });

  it("respects the conditions", async () => {
    expect(await Topic.where({ title: "one" }).calculate("sum", "rank")).toBe(5);
  });

  /** Counting nothing is zero; averaging nothing is not. */
  it("answers zero for a count over no rows and null for the rest", async () => {
    const none = Topic.where({ title: "nope" });

    expect(await none.calculate("count")).toBe(0);
    expect(await none.calculate("average", "rank")).toBeNull();
  });

  it("refuses an operation that needs a column without one", async () => {
    expect(Topic.all().calculate("sum")).rejects.toThrow(/needs a column/);
  });
});
