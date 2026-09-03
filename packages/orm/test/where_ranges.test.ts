/**
 * A range in a `where`, ported from the `RangeHandler` cases in
 * `activerecord/test/cases/relation/where_test.rb`.
 *
 * `predicate_builder` has known how to write one since it was added and
 * `relation.where` never asked it. A range fell through to `=` and was bound
 * as an object, which the driver stringifies into a comparison nobody wrote:
 * it matches nothing, and nothing says so.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface ReadingRow {
  id: number;
  value: number;
  taken_at: string | null;
}

class Reading extends Model<ReadingRow>("readings") {
  declare id: number;
  declare value: number;
  declare taken_at: string | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Reading.columnCache = undefined;
  Reading.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("readings", (t) => {
    t.integer("value");
    t.string("taken_at");
  });

  for (const value of [1, 2, 3, 4, 5]) await Reading.create({ value });
});

async function valuesWhere(condition: Record<string, unknown>): Promise<number[]> {
  const rows = await Reading.where(condition).order("value").toArray();

  return rows.map((row) => row.value);
}

describe("a range with both ends", () => {
  it("matches from one to the other, inclusive", async () => {
    expect(await valuesWhere({ value: { from: 2, to: 4 } })).toEqual([2, 3, 4]);
  });

  /**
   * `BETWEEN` is always inclusive, so writing a half-open range as one is off
   * by exactly one row — for a range of dates, a whole day of records in the
   * wrong report.
   */
  it("leaves the end out when the range says so", async () => {
    expect(await valuesWhere({ value: { from: 2, to: 4, excludeEnd: true } })).toEqual([2, 3]);
  });

  it("matches nothing when the range is empty", async () => {
    expect(await valuesWhere({ value: { from: 4, to: 2 } })).toEqual([]);
  });
});

describe("a range with one end", () => {
  it("is a floor when it has no top", async () => {
    expect(await valuesWhere({ value: { from: 4, to: null } })).toEqual([4, 5]);
  });

  it("is a ceiling when it has no bottom", async () => {
    expect(await valuesWhere({ value: { from: null, to: 2 } })).toEqual([1, 2]);
  });

  it("is an exclusive ceiling when the range says so", async () => {
    expect(await valuesWhere({ value: { from: null, to: 2, excludeEnd: true } })).toEqual([1]);
  });

  /**
   * One key is enough. The alternative is that `{ from: 4 }` falls through to
   * `=` and is bound as an object — matching nothing, saying nothing.
   */
  it("is a floor when the top was left out entirely", async () => {
    expect(await valuesWhere({ value: { from: 4 } })).toEqual([4, 5]);
  });

  it("is a ceiling when the bottom was left out entirely", async () => {
    expect(await valuesWhere({ value: { to: 2 } })).toEqual([1, 2]);
  });
});

describe("a list holding a null", () => {
  /**
   * `IN (1, NULL)` never matches the null rows: SQL's three-valued logic makes
   * every comparison with null unknown. `[1, null]` means "one, or nothing at
   * all", and this used to mean only the first half.
   */
  it("matches the rows that are null as well", async () => {
    await Reading.create({ value: 6, taken_at: "yesterday" });

    const rows = await Reading.where({ taken_at: ["yesterday", null] })
      .order("value")
      .toArray();

    expect(rows.map((row) => row.value)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("matches only the nulls when that is all the list holds", async () => {
    await Reading.create({ value: 6, taken_at: "yesterday" });

    const rows = await Reading.where({ taken_at: [null] })
      .order("value")
      .toArray();

    expect(rows.map((row) => row.value)).toEqual([1, 2, 3, 4, 5]);
  });

  /** One value is `=`, not a one-element `IN`: the same rows, and a plan more index-friendly. */
  it("compares a single value by equality", async () => {
    expect(await valuesWhere({ value: [3] })).toEqual([3]);
  });

  it("still matches nothing for an empty list", async () => {
    expect(await valuesWhere({ value: [] })).toEqual([]);
  });
});

describe("what is not a range", () => {
  it("still compares by equality", async () => {
    expect(await valuesWhere({ value: 3 })).toEqual([3]);
  });

  it("still becomes an IN for a list", async () => {
    expect(await valuesWhere({ value: [1, 3] })).toEqual([1, 3]);
  });

  it("still becomes IS NULL for null", async () => {
    expect(await valuesWhere({ taken_at: null })).toEqual([1, 2, 3, 4, 5]);
  });

  /** An object that is not a range is a value, and comparing it is the caller's business. */
  it("is not mistaken for one", async () => {
    expect(await valuesWhere({ value: { from: 2, to: 4 } })).toEqual([2, 3, 4]);
    expect(await valuesWhere({ value: 2 })).toEqual([2]);
  });
});

describe("a qualified column", () => {
  /**
   * The relation quotes `table.column` as two identifiers; the predicate
   * builder's own default quotes it as one. Passing the relation's quoting in
   * is what keeps a joined query from asking for a column literally called
   * `readings.value`.
   */
  it("is quoted the way the relation quotes it", async () => {
    const rows = await Reading.where({ "readings.value": { from: 2, to: 4 } })
      .order("value")
      .toArray();

    expect(rows.map((row) => row.value)).toEqual([2, 3, 4]);
  });
});

describe("combining", () => {
  it("ands with another condition", async () => {
    expect(await valuesWhere({ value: { from: 2, to: 4 }, taken_at: null })).toEqual([2, 3, 4]);
  });

  it("chains with a second where", async () => {
    const rows = await Reading.where({ value: { from: 2, to: 4 } })
      .where({ value: { from: 3, to: 5 } })
      .order("value")
      .toArray();

    expect(rows.map((row) => row.value)).toEqual([3, 4]);
  });
});
