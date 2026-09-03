/**
 * What a `minimum` and a `maximum` answer with, ported from the
 * `test_maximum_with_not_auto_incremented_non_numeric_column` and
 * `test_should_get_maximum_of_field` cases in
 * `activerecord/test/cases/calculations_test.rb`.
 *
 * `Post.maximum("created_at")` is how you ask when a set of records was last
 * touched, and it answered `NaN`. So did a minimum over any text column. The
 * aggregate coerced its result to a number unconditionally, which is right for
 * a sum and wrong for the two aggregates that answer in the column's own
 * terms.
 *
 * NaN is worse than an error. It survives arithmetic, compares unequal to
 * itself, and `JSON.stringify` prints it as `null` — so a cache key built from
 * one is the same key for every record, and an API hands back a field that
 * looks like "no value" rather than a mistake.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import { scalarValue } from "../src/relation.js";

interface PostRow {
  id: number;
  title: string;
  views: number | null;
  price: string | null;
  at: string | null;
}

class Post extends Model<PostRow>("posts") {
  declare id: number;
  declare title: string;
  declare views: number | null;
  declare price: string | null;
  declare at: string | null;
}

const EARLY = new Date("2026-06-01T12:00:00.000Z");
const LATE = new Date("2026-06-05T09:30:00.000Z");

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Post.columnCache = undefined;
  Post.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.integer("views");
    t.decimal("price");
    t.datetime("at");
  });

  await Post.create({ title: "alpha", views: 10, price: "1.50" as never, at: EARLY as never });
  await Post.create({ title: "zulu", views: 30, price: "9.25" as never, at: LATE as never });
  // No views, so a count of the column and a count of the rows differ.
  await Post.create({ title: "", views: null, price: null, at: null });
});

describe("over a numeric column", () => {
  it("still answers with a number", async () => {
    expect(await Post.all().maximum("views")).toBe(30);
    expect(await Post.all().minimum("views")).toBe(10);
  });

  /** `count(column)` counts the rows where it is set, which is not `count()`. */
  it("counts only the rows that have one", async () => {
    expect(await Post.all().calculate("count", "views")).toBe(2);
    expect(await Post.all().count()).toBe(3);
  });

  /**
   * PostgreSQL hands `BIGINT` and `NUMERIC` back as strings, so the coercion
   * this narrowed cannot simply go: a total that arrives as `"40"` has to be
   * a number by the time a caller adds to it.
   */
  it("still totals as a number", async () => {
    expect(await Post.all().sum("views")).toBe(40);
    expect(await Post.all().average("views")).toBe(20);
  });

  it("reads a decimal as a number", async () => {
    expect(await Post.all().maximum("price")).toBeCloseTo(9.25, 2);
  });
});

describe("over a datetime column", () => {
  /** The regression. This used to be NaN, which prints as null and is not one. */
  it("answers with the timestamp rather than NaN", async () => {
    const newest = await Post.all().maximum<string>("at");

    expect(newest).not.toBeNull();
    expect(new Date(newest as string).toISOString()).toBe(LATE.toISOString());
  });

  it("answers with the earliest for a minimum", async () => {
    const oldest = await Post.all().minimum<string>("at");

    expect(new Date(oldest as string).toISOString()).toBe(EARLY.toISOString());
  });

  it("is not a number", async () => {
    expect(Number.isNaN(await Post.all().maximum("at"))).toBe(false);
  });
});

describe("over a text column", () => {
  it("answers with the text", async () => {
    expect(await Post.all().maximum<string>("title")).toBe("zulu");
  });

  /**
   * `Number("")` is 0, so an empty string is the one text value a numeric
   * coercion turns into a plausible number rather than an obvious NaN.
   */
  it("answers with an empty string rather than a zero", async () => {
    expect(await Post.all().minimum<string>("title")).toBe("");
  });
});

describe("the conversion itself", () => {
  /**
   * PostgreSQL returns `BIGINT` and `NUMERIC` as strings, which is why this
   * converts at all. SQLite hands back numbers, so nothing above can tell the
   * difference and this is where that half is pinned down.
   */
  it("reads a numeric string as a number", () => {
    expect(scalarValue("40")).toBe(40);
    expect(scalarValue("9.25")).toBe(9.25);
    expect(scalarValue("-3")).toBe(-3);
  });

  it("leaves text that is not a number alone", () => {
    expect(scalarValue("2026-06-01T12:00:00.000Z")).toBe("2026-06-01T12:00:00.000Z");
    expect(scalarValue("zulu")).toBe("zulu");
  });

  it("leaves an empty string alone rather than reading it as zero", () => {
    expect(scalarValue("")).toBe("");
    expect(scalarValue("   ")).toBe("   ");
  });

  it("leaves a number alone", () => {
    expect(scalarValue(40)).toBe(40);
  });

  it("keeps a null and turns a missing value into one", () => {
    expect(scalarValue(null)).toBeNull();
    expect(scalarValue(undefined)).toBeNull();
  });
});

describe("with nothing to aggregate", () => {
  it("answers null rather than a number", async () => {
    await Post.all().deleteAll();

    expect(await Post.all().maximum("views")).toBeNull();
    expect(await Post.all().maximum<string>("at")).toBeNull();
    expect(await Post.all().minimum<string>("title")).toBeNull();
  });

  it("still totals nothing as zero, because adding nothing is zero", async () => {
    await Post.all().deleteAll();

    expect(await Post.all().sum("views")).toBe(0);
  });

  it("answers null for an average, because the mean of nothing is not zero", async () => {
    await Post.all().deleteAll();

    expect(await Post.all().average("views")).toBeNull();
  });
});

describe("through calculate", () => {
  it("names the same aggregates", async () => {
    expect(await Post.all().calculate("maximum", "views")).toBe(30);
    expect(await Post.all().calculate("sum", "views")).toBe(40);
  });
});
