/**
 * Primary keys made of more than one column, ported from
 * `activerecord/test/cases/primary_keys_test.rb`,
 * `activerecord/test/cases/composite_primary_keys_test.rb` and
 * `activerecord/test/cases/query_constraints_test.rb`.
 *
 * A partial composite key still produces valid SQL. It just matches more rows
 * than the caller meant — so the tests that matter here are the ones checking
 * something is refused rather than silently widened.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  MAX_ID,
  PartialCompositeKey,
  belongsToJoinKeys,
  clearQueryConstraints,
  composite,
  compositeIdentify,
  compositePrimaryKey,
  compositeQueryConstraintsList,
  distinctRelationForPrimaryKey,
  expectsMultipleIds,
  getPrimaryKey,
  hasManyJoinKeys,
  hasQueryConstraints,
  idBeforeTypeCast,
  idFor,
  idForDatabase,
  idInDatabase,
  idPresent,
  idWas,
  inMemoryQueryConstraintsHash,
  internalStringOptionsForPrimaryKey,
  identify,
  joinConditions,
  keyColumns,
  primaryKeyValuesPresent,
  queryConstraints,
  queryConstraintsHash,
  queryConstraintsList,
  setIdFor,
} from "../src/composite_key.js";

afterEach(() => {
  clearQueryConstraints();
});

describe("what a key is", () => {
  it("says a pair is composite", () => {
    expect(composite(["account_id", "id"])).toBe(true);
  });

  it("says a single column is not", () => {
    expect(composite("id")).toBe(false);
  });

  /** A one-element array is still one column, whatever shape it arrived in. */
  it("says a list of one is not", () => {
    expect(composite(["id"])).toBe(false);
  });

  it("reads it off a model", () => {
    expect(compositePrimaryKey({ primaryKey: ["account_id", "id"] })).toBe(true);
    expect(compositePrimaryKey({ primaryKey: "id" })).toBe(false);
  });

  it("gives one shape to callers", () => {
    expect(keyColumns("id")).toEqual(["id"]);
    expect(keyColumns(["account_id", "id"])).toEqual(["account_id", "id"]);
  });
});

describe("reading a key", () => {
  const record = { account_id: 4, id: 7, title: "x" };

  it("reads a single one as a value", () => {
    expect(idFor(record, "id")).toBe(7);
  });

  /** So a caller cannot mistake `[4, 7]` for the scalar and compare it to a column. */
  it("reads a composite one as a list", () => {
    expect(idFor(record, ["account_id", "id"])).toEqual([4, 7]);
  });

  it("keeps the declared order", () => {
    expect(idFor(record, ["id", "account_id"])).toEqual([7, 4]);
  });

  it("reads the values before they were cast", () => {
    expect(idBeforeTypeCast({ account_id: "4", id: "7" }, ["account_id", "id"])).toEqual([
      "4",
      "7",
    ]);
  });

  it("reads what was loaded", () => {
    expect(idWas({ account_id: 1, id: 2 }, ["account_id", "id"])).toEqual([1, 2]);
    expect(idInDatabase({ id: 2 }, "id")).toBe(2);
  });

  it("serialises each part for the database", () => {
    expect(idForDatabase(record, ["account_id", "id"], (value) => String(value))).toEqual([
      "4",
      "7",
    ]);
  });

  it("serialises a single one too", () => {
    expect(idForDatabase(record, "id", (value) => String(value))).toBe("7");
  });

  it("passes the values through by default", () => {
    expect(idForDatabase(record, "id")).toBe(7);
  });
});

describe("whether a key is set", () => {
  it("says so when every part is", () => {
    expect(primaryKeyValuesPresent({ account_id: 4, id: 7 }, ["account_id", "id"])).toBe(true);
  });

  /** All of them, not any — a half-populated key is what a partial WHERE is built from. */
  it("says not when one part is missing", () => {
    expect(primaryKeyValuesPresent({ account_id: 4, id: null }, ["account_id", "id"])).toBe(false);
  });

  it("counts an absent column as missing", () => {
    expect(primaryKeyValuesPresent({ account_id: 4 }, ["account_id", "id"])).toBe(false);
  });

  /** Zero is a value. A key column holding `0` is set. */
  it("counts zero as set", () => {
    expect(primaryKeyValuesPresent({ id: 0 }, "id")).toBe(true);
  });

  it("answers the same question for a query", () => {
    expect(idPresent({ account_id: 4, id: 7 }, ["account_id", "id"])).toBe(true);
    expect(idPresent({ account_id: 4 }, ["account_id", "id"])).toBe(false);
  });
});

describe("setting a key", () => {
  it("sets a single one", () => {
    const record: Record<string, unknown> = {};
    setIdFor(record, "id", 7);

    expect(record).toEqual({ id: 7 });
  });

  it("spreads a list across a composite one", () => {
    const record: Record<string, unknown> = {};
    setIdFor(record, ["account_id", "id"], [4, 7]);

    expect(record).toEqual({ account_id: 4, id: 7 });
  });

  it("refuses something that is not a list", () => {
    expect(() => setIdFor({}, ["account_id", "id"], 7)).toThrow(TypeError);
  });

  /**
   * A short list would otherwise leave the remaining columns holding whatever
   * they held before — a key that is half the new record and half the old one.
   */
  it("refuses a list of the wrong length", () => {
    expect(() => setIdFor({}, ["account_id", "id"], [7])).toThrow(TypeError);
    expect(() => setIdFor({}, ["account_id", "id"], [1, 2, 3])).toThrow(TypeError);
  });

  it("says what it wanted", () => {
    expect(() => setIdFor({}, ["account_id", "id"], [7])).toThrow("account_id, id");
  });
});

describe("the WHERE a write is built from", () => {
  it("names every key column", () => {
    expect(
      queryConstraintsHash({ account_id: 4, id: 7, title: "x" }, ["account_id", "id"]),
    ).toEqual({ account_id: 4, id: 7 });
  });

  it("leaves other columns out", () => {
    expect(Object.keys(queryConstraintsHash({ id: 7, title: "x" }, "id"))).toEqual(["id"]);
  });

  /**
   * The load-bearing check. The SQL is valid either way, so the only signal
   * that a column was missing is the number of rows the statement touched.
   */
  it("refuses a partial key", () => {
    expect(() => queryConstraintsHash({ id: 7 }, ["account_id", "id"])).toThrow(
      PartialCompositeKey,
    );
  });

  it("names what was missing", () => {
    expect(() => queryConstraintsHash({ id: 7 }, ["account_id", "id"])).toThrow("account_id");
  });

  it("says what would have happened", () => {
    expect(() => queryConstraintsHash({ id: 7 }, ["account_id", "id"])).toThrow(
      "matches more rows",
    );
  });

  it("refuses a null single key too", () => {
    expect(() => queryConstraintsHash({ id: null }, "id")).toThrow(PartialCompositeKey);
  });

  /**
   * Reload has to use the loaded values: a record whose key column was edited
   * in memory would otherwise fetch a different row and overwrite itself with it.
   */
  it("builds a reload from what was loaded", () => {
    expect(inMemoryQueryConstraintsHash({ account_id: 4, id: 7 }, ["account_id", "id"])).toEqual({
      account_id: 4,
      id: 7,
    });
  });
});

describe("columns a model declares it queries by", () => {
  it("remembers them", () => {
    queryConstraints("Developer", "company_id", "id");

    expect(queryConstraintsList("Developer")).toEqual(["company_id", "id"]);
    expect(hasQueryConstraints("Developer")).toBe(true);
  });

  it("has none until declared", () => {
    expect(hasQueryConstraints("Developer")).toBe(false);
    expect(queryConstraintsList("Developer")).toBeUndefined();
  });

  it("refuses an empty declaration", () => {
    expect(() => queryConstraints("Developer")).toThrow("at least one column");
  });

  /** Declared constraints win: they are what this application wants in every WHERE. */
  it("uses the declared ones over the primary key", () => {
    queryConstraints("Developer", "company_id", "id");

    expect(compositeQueryConstraintsList("Developer", "id")).toEqual(["company_id", "id"]);
  });

  it("falls back to the primary key", () => {
    expect(compositeQueryConstraintsList("Post", "id")).toEqual(["id"]);
  });

  it("hands back a list either way", () => {
    expect(compositeQueryConstraintsList("Post", ["account_id", "id"])).toEqual([
      "account_id",
      "id",
    ]);
  });
});

describe("joining", () => {
  /**
   * On a belongsTo the foreign key lives on this table, so the direction is
   * the opposite of a hasMany. Wrong, it still returns rows — the wrong ones.
   */
  it("reads from the local key to the other table's", () => {
    expect(belongsToJoinKeys("author_id", "id")).toEqual({
      primaryKey: "id",
      foreignKey: "author_id",
    });
  });

  it("carries the type column for a polymorphic one", () => {
    expect(belongsToJoinKeys("subject_id", "id", "subject_type").foreignType).toBe("subject_type");
  });

  it("reads the other way for a hasMany", () => {
    expect(hasManyJoinKeys("post_id", "id")).toEqual({
      primaryKey: "post_id",
      foreignKey: "id",
    });
  });

  it("carries the type on the other side", () => {
    expect(hasManyJoinKeys("subject_id", "id", "subject_type").primaryType).toBe("subject_type");
  });

  it("pairs the columns up", () => {
    expect(
      joinConditions({ foreignKey: ["account_id", "post_id"], primaryKey: ["account_id", "id"] }),
    ).toEqual([
      { left: "account_id", right: "account_id" },
      { left: "post_id", right: "id" },
    ]);
  });

  it("pairs a single column too", () => {
    expect(joinConditions({ foreignKey: "post_id", primaryKey: "id" })).toEqual([
      { left: "post_id", right: "id" },
    ]);
  });

  /**
   * Joining on the columns they have in common would match across every value
   * of the rest — for a tenanted table, rows from every tenant.
   */
  it("refuses keys of different widths", () => {
    expect(() =>
      joinConditions({ foreignKey: ["account_id", "post_id"], primaryKey: "id" }),
    ).toThrow("different widths");
  });
});

describe("naming", () => {
  it("is id by default", () => {
    expect(getPrimaryKey(undefined)).toBe("id");
    expect(getPrimaryKey("post")).toBe("id");
  });

  it("takes a table-name prefix", () => {
    expect(getPrimaryKey("post", "table_name")).toBe("postid");
    expect(getPrimaryKey("post", "table_name_with_underscore")).toBe("post_id");
  });

  it("describes the column a schema dumper writes", () => {
    expect(internalStringOptionsForPrimaryKey()).toEqual({ primaryKey: true });
  });
});

describe("fixture ids", () => {
  /**
   * The same label is the same id in every process, which is what lets one
   * fixture file reference another by name.
   */
  it("gives a label the same id every time", () => {
    expect(identify("david")).toBe(identify("david"));
  });

  it("gives different labels different ids", () => {
    expect(identify("david")).not.toBe(identify("mary"));
  });

  it("stays within range", () => {
    expect(identify("david")).toBeLessThan(MAX_ID);
    expect(identify("david")).toBeGreaterThanOrEqual(0);
  });

  /**
   * CRC-32 of the label, the same function Rails uses, so a fixture written
   * for one has the same id under the other. The expected value is zlib's
   * `crc32("david")`, not ours.
   */
  it("matches Rails' hash", () => {
    expect(identify("david")).toBe(0x8796_d7bb % MAX_ID);
  });

  it("names every column of a composite key", () => {
    expect(Object.keys(compositeIdentify("order", ["shop_id", "id"]))).toEqual(["shop_id", "id"]);
  });

  /**
   * A `(a, b)` key of `(7, 7)` is exactly the coincidence that makes a broken
   * join look like it works.
   */
  it("gives the two columns different values", () => {
    const built = compositeIdentify("order", ["shop_id", "id"]);

    expect(built["shop_id"]).not.toBe(built["id"]);
  });

  it("is stable", () => {
    expect(compositeIdentify("order", ["shop_id", "id"])).toEqual(
      compositeIdentify("order", ["shop_id", "id"]),
    );
  });
});

describe("finding several", () => {
  it("says a list of ids is several", () => {
    expect(expectsMultipleIds("id", [1, 2])).toBe(true);
  });

  it("says a bare id is not", () => {
    expect(expectsMultipleIds("id", 1)).toBe(false);
  });

  /**
   * `find([1, 2])` on a composite key is one record and `find([[1, 2]])` is a
   * list of one — no visual weight, completely different result.
   */
  it("reads one composite key as one record", () => {
    expect(expectsMultipleIds(["account_id", "id"], [1, 2])).toBe(false);
  });

  it("reads a list of composite keys as several", () => {
    expect(
      expectsMultipleIds(
        ["account_id", "id"],
        [
          [1, 2],
          [1, 3],
        ],
      ),
    ).toBe(true);
  });
});

describe("distinct", () => {
  /** `SELECT DISTINCT a` over a key of `(a, b)` collapses different records. */
  it("selects every key column", () => {
    expect(distinctRelationForPrimaryKey(["account_id", "id"])).toEqual(["account_id", "id"]);
  });

  /** You cannot order by something a DISTINCT did not keep. */
  it("selects the ordering columns too", () => {
    expect(distinctRelationForPrimaryKey("id", ["created_at"])).toEqual(["id", "created_at"]);
  });

  it("does not select one twice", () => {
    expect(distinctRelationForPrimaryKey("id", ["id"])).toEqual(["id"]);
  });
});
