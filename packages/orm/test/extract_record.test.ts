/**
 * Turning a row of aliased join columns back into records, ported from the
 * `extract_record` cases in
 * `activerecord/test/cases/associations/join_dependency_test.rb`.
 *
 * The case that matters is the outer join with no match: every one of that
 * side's aliases comes back null, and a record built from them is a ghost —
 * an object with a null id that renders as a blank row and raises on save.
 */

import { describe, expect, it } from "bun:test";
import { columnAliases, extractRecord } from "../src/join_dependency.js";

const posts = { name: "posts", alias: "posts" };
const authors = { name: "authors", alias: "authors" };

describe("one record out of a joined row", () => {
  const aliases = columnAliases([{ table: posts, columns: ["id", "title"] }]);

  it("names the columns the way the model knows them", () => {
    const row = { t0_r0: 7, t0_r1: "Hello" };

    expect(extractRecord(row, aliases)).toEqual({ id: 7, title: "Hello" });
  });

  /** A row from a join carries the aliases, not the original names. */
  it("reads the alias, not the name", () => {
    expect(extractRecord({ id: 1, title: "Wrong" }, aliases)).toEqual({
      id: undefined,
      title: undefined,
    });
  });

  it("keeps a null that is a real value", () => {
    expect(extractRecord({ t0_r0: 7, t0_r1: null }, aliases)).toEqual({ id: 7, title: null });
  });

  it("takes no aliases at all", () => {
    expect(extractRecord({ t0_r0: 7 }, [])).toEqual({});
  });
});

describe("more than one table in the row", () => {
  const [postColumns, authorColumns] = [
    columnAliases([
      { table: posts, columns: ["id", "title"] },
      { table: authors, columns: ["id", "name"] },
    ]).slice(0, 2),
    columnAliases([
      { table: posts, columns: ["id", "title"] },
      { table: authors, columns: ["id", "name"] },
    ]).slice(2),
  ];

  /**
   * Both tables have an `id`, which is the entire reason the aliases exist:
   * selected under their own names, the row keeps whichever the driver saw
   * last.
   */
  it("keeps the two apart", () => {
    const row = { t0_r0: 7, t0_r1: "Hello", t1_r2: 3, t1_r3: "Ada" };

    expect(extractRecord(row, postColumns)).toEqual({ id: 7, title: "Hello" });
    expect(extractRecord(row, authorColumns)).toEqual({ id: 3, name: "Ada" });
  });
});

describe("an outer join with no match", () => {
  const aliases = columnAliases([{ table: authors, columns: ["id", "name"] }]);

  /**
   * A ghost record is an object with a null id that `instanceof` says is a
   * record, that renders as a blank row in a list, and that raises on save.
   */
  it("is no record at all", () => {
    expect(
      extractRecord({ t0_r0: null, t0_r1: null }, aliases, { primaryKey: "id" }),
    ).toBeUndefined();
  });

  it("is no record when the column is missing entirely", () => {
    expect(extractRecord({}, aliases, { primaryKey: "id" })).toBeUndefined();
  });

  it("is still a record when the key is there and the rest is null", () => {
    expect(extractRecord({ t0_r0: 3, t0_r1: null }, aliases, { primaryKey: "id" })).toEqual({
      id: 3,
      name: null,
    });
  });

  /** A key of zero is a key. */
  it("is a record for a falsy key that is not null", () => {
    expect(extractRecord({ t0_r0: 0, t0_r1: "" }, aliases, { primaryKey: "id" })).toEqual({
      id: 0,
      name: "",
    });
  });

  /** Without a primary key to check, there is nothing to decide it on. */
  it("is a record when no primary key was named", () => {
    expect(extractRecord({ t0_r0: null, t0_r1: null }, aliases)).toEqual({ id: null, name: null });
  });

  it("looks at the named key, not the first column", () => {
    const keyed = columnAliases([{ table: authors, columns: ["name", "id"] }]);

    expect(extractRecord({ t0_r0: null, t0_r1: 3 }, keyed, { primaryKey: "id" })).toEqual({
      name: null,
      id: 3,
    });
    expect(
      extractRecord({ t0_r0: "Ada", t0_r1: null }, keyed, { primaryKey: "id" }),
    ).toBeUndefined();
  });
});

describe("a qualified expression", () => {
  it("keeps only the column half", () => {
    expect(extractRecord({ a: 1 }, [{ expression: "posts.id", as: "a" }])).toEqual({ id: 1 });
  });

  it("takes an expression with no table at all", () => {
    expect(extractRecord({ a: 1 }, [{ expression: "id", as: "a" }])).toEqual({ id: 1 });
  });

  /** Taking the first dot would leave `posts.id` as the attribute name. */
  it("takes the last dot of a schema-qualified expression", () => {
    expect(extractRecord({ a: 1 }, [{ expression: "public.posts.id", as: "a" }])).toEqual({
      id: 1,
    });
  });
});
