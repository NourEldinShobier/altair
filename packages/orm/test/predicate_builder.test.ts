/**
 * Turning a `where` hash into predicates, ported from
 * `activerecord/test/cases/relation/predicate_builder_test.rb`,
 * `activerecord/test/cases/relation/where_test.rb` and the uniqueness cases in
 * `activerecord/test/cases/validations/uniqueness_validation_test.rb`.
 *
 * Every wrong answer here produces valid SQL — `id = NULL` matching nothing,
 * an empty `IN` matching everything, a half-open range off by one row — so the
 * tests are about which SQL comes out rather than whether it runs.
 */

import { describe, expect, it } from "bun:test";
import {
  COLUMN_NAME,
  UnboundableValue,
  arrayPredicateFor,
  buildFromHash,
  buildPredicate,
  canPerformCaseInsensitiveComparisonFor,
  caseInsensitiveComparison,
  caseSensitiveComparison,
  checkOrderFragments,
  columnNameMatcher,
  columnNameWithOrderMatcher,
  columnsForDistinct,
  computeIfAbsent,
  contradiction,
  deduplicate,
  downcase,
  associatedTable,
  associatedWith,
  qualifiedColumn,
  rangePredicateFor,
  unboundable,
} from "../src/predicate_builder.js";

describe("a condition nothing can satisfy", () => {
  /**
   * `1 = 0` rather than an empty string: an empty condition is dropped by
   * whatever joins the clauses, and a dropped condition turns `where(id: [])`
   * from "nothing" into "everything" — which is destructive once the relation
   * is deleted.
   */
  it("is a false comparison, not an empty string", () => {
    expect(contradiction().sql).toBe("1 = 0");
    expect(contradiction().binds).toEqual([]);
  });
});

describe("one column and one value", () => {
  it("compares a scalar", () => {
    expect(buildPredicate("id", 7)).toEqual({ sql: '"id" = ?', binds: [7] });
  });

  /**
   * `column = NULL` is never true for any row, including rows whose column
   * *is* null, so a hash asking for null would silently match nothing.
   */
  it("asks for null with IS NULL", () => {
    expect(buildPredicate("parent_id", null)).toEqual({ sql: '"parent_id" IS NULL', binds: [] });
    expect(buildPredicate("parent_id", undefined).sql).toBe('"parent_id" IS NULL');
  });

  it("compares a date", () => {
    const at = new Date(0);

    expect(buildPredicate("created_at", at).binds).toEqual([at]);
  });

  /** A value with no SQL form would be bound as whatever the driver made of it. */
  it("refuses something that cannot be compared", () => {
    expect(() => buildPredicate("id", Symbol("x") as never)).toThrow(UnboundableValue);
    expect(unboundable(() => undefined)).toBe(true);
    expect(unboundable(7)).toBe(false);
  });

  it("quotes and numbers the way the adapter asks", () => {
    expect(
      buildPredicate(
        "id",
        7,
        (name) => `\`${name}\``,
        () => "$1",
      ),
    ).toEqual({ sql: "`id` = $1", binds: [7] });
  });
});

describe("a list of values", () => {
  it("becomes an IN", () => {
    expect(arrayPredicateFor("id", [1, 2])).toEqual({ sql: '"id" IN (?, ?)', binds: [1, 2] });
  });

  /** One value needs no list, and an equality is what an index is built for. */
  it("becomes an equality for a single value", () => {
    expect(arrayPredicateFor("id", [7])).toEqual({ sql: '"id" = ?', binds: [7] });
  });

  /**
   * `id IN ()` is a syntax error on most databases. An empty list means no
   * possible match — writing anything else is how `where(id: [])` returns the
   * whole table.
   */
  it("becomes a contradiction when empty", () => {
    expect(arrayPredicateFor("id", [])).toEqual(contradiction());
  });

  /**
   * `IN (NULL)` never matches: every comparison with null is unknown.
   * `where(parent_id: [1, null])` means "child of 1, or a root".
   */
  it("asks for a null in the list separately", () => {
    const predicate = arrayPredicateFor("parent_id", [1, null]);

    expect(predicate.sql).toBe('("parent_id" = ? OR "parent_id" IS NULL)');
    expect(predicate.binds).toEqual([1]);
  });

  it("becomes IS NULL for a list of only nulls", () => {
    expect(arrayPredicateFor("parent_id", [null])).toEqual({
      sql: '"parent_id" IS NULL',
      binds: [],
    });
  });

  it("keeps the OR form for several values plus a null", () => {
    expect(arrayPredicateFor("parent_id", [1, 2, null]).sql).toBe(
      '("parent_id" IN (?, ?) OR "parent_id" IS NULL)',
    );
  });
});

describe("a range", () => {
  it("bounds both ends inclusively", () => {
    expect(rangePredicateFor("age", { from: 1, to: 5 })).toEqual({
      sql: '"age" >= ? AND "age" <= ?',
      binds: [1, 5],
    });
  });

  /** `BETWEEN` is always inclusive, so a half-open range written as one is off by a row. */
  it("excludes the end when asked", () => {
    expect(rangePredicateFor("age", { from: 1, to: 5, excludeEnd: true }).sql).toBe(
      '"age" >= ? AND "age" < ?',
    );
  });

  it("bounds one end only", () => {
    expect(rangePredicateFor("age", { from: null, to: 5 })).toEqual({
      sql: '"age" <= ?',
      binds: [5],
    });
    expect(rangePredicateFor("age", { from: 1, to: null })).toEqual({
      sql: '"age" >= ?',
      binds: [1],
    });
  });

  it("reaches a range through the hash too", () => {
    expect(buildPredicate("age", { from: 1, to: 5 }).sql).toContain(">=");
  });
});

describe("a whole hash", () => {
  it("joins conditions with AND", () => {
    expect(buildFromHash({ id: 7, title: "a" })).toEqual({
      sql: '"id" = $1 AND "title" = $2',
      binds: [7, "a"],
    });
  });

  /** Placeholders have to keep counting across conditions, not restart. */
  it("numbers placeholders across the whole hash", () => {
    expect(buildFromHash({ id: [1, 2], title: "a" }).sql).toBe('"id" IN ($1, $2) AND "title" = $3');
  });

  /** `where({})` is "no additional restriction" — the opposite of `where(id: [])`. */
  it("produces nothing for an empty hash", () => {
    expect(buildFromHash({})).toEqual({ sql: "", binds: [] });
  });

  it("mixes shapes", () => {
    const built = buildFromHash({ id: [1, 2], parent_id: null, age: { from: 1, to: 5 } });

    expect(built.sql).toContain("IN");
    expect(built.sql).toContain("IS NULL");
    expect(built.binds).toEqual([1, 2, 1, 5]);
  });
});

describe("comparing text without regard to case", () => {
  /**
   * Only text. A cast column cannot use its index, so a uniqueness validation
   * on an integer would quietly become a full scan on every save.
   */
  it("only applies to text columns", () => {
    expect(canPerformCaseInsensitiveComparisonFor("varchar(255)")).toBe(true);
    expect(canPerformCaseInsensitiveComparisonFor("text")).toBe(true);
    expect(canPerformCaseInsensitiveComparisonFor("integer")).toBe(false);
    expect(canPerformCaseInsensitiveComparisonFor("timestamp")).toBe(false);
  });

  /**
   * Both sides lowered. Lowering only the column compares against whatever
   * case the caller passed, so the check passes or fails depending on how the
   * form was filled in — the exact thing it exists to prevent.
   */
  it("lowers both sides", () => {
    expect(caseInsensitiveComparison("email", "varchar(255)")).toBe('LOWER("email") = LOWER(?)');
  });

  it("falls back to a plain comparison for a non-text column", () => {
    expect(caseInsensitiveComparison("id", "integer")).toBe('"id" = ?');
  });

  it("compares plainly when asked to", () => {
    expect(caseSensitiveComparison("email")).toBe('"email" = ?');
  });

  it("lowers a string value and leaves anything else", () => {
    expect(downcase("Ada")).toBe("ada");
    expect(downcase(7)).toBe(7);
    expect(downcase(null)).toBeNull();
  });
});

describe("column names that reach SQL unbound", () => {
  it("accepts a bare column", () => {
    expect(columnNameMatcher("title")).toBe(true);
    expect(columnNameMatcher("posts.title")).toBe(true);
    expect(COLUMN_NAME.test("title")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(columnNameMatcher("title; DROP TABLE posts")).toBe(false);
    expect(columnNameMatcher("(SELECT 1)")).toBe(false);
  });

  it("accepts a direction only in the order form", () => {
    expect(columnNameWithOrderMatcher("title desc")).toBe(true);
    expect(columnNameMatcher("title desc")).toBe(false);
  });

  it("accepts a nulls placement", () => {
    expect(columnNameWithOrderMatcher("title desc nulls last")).toBe(true);
  });

  /** The check lives in `sanitization.ts`; this is the name the query layer uses. */
  it("refuses a raw fragment heading for an ORDER BY", () => {
    expect(() => checkOrderFragments(["title asc"])).not.toThrow();
    expect(() => checkOrderFragments(["(SELECT 1)"])).toThrow();
  });
});

describe("selecting for a DISTINCT", () => {
  /**
   * A database cannot order by something the DISTINCT did not keep — Postgres
   * refuses outright and the others pick an arbitrary row per group.
   */
  it("adds the ordering columns", () => {
    expect(columnsForDistinct(["id"], ["created_at desc"])).toEqual(["id", "created_at"]);
  });

  it("does not add one already selected", () => {
    expect(columnsForDistinct(["id"], ["id asc"])).toEqual(["id"]);
  });

  it("selects nothing extra with no ordering", () => {
    expect(columnsForDistinct(["id", "title"])).toEqual(["id", "title"]);
  });
});

describe("small helpers", () => {
  it("drops repeats and keeps the order", () => {
    expect(deduplicate(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("takes a key of its own", () => {
    expect(deduplicate([{ id: 1 }, { id: 1 }], (each) => String(each.id))).toHaveLength(1);
  });

  it("computes once and remembers", () => {
    const cache = new Map<string, number>();
    let ran = 0;
    const build = () => {
      ran += 1;

      return 7;
    };

    expect(computeIfAbsent(cache, "a", build)).toBe(7);
    expect(computeIfAbsent(cache, "a", build)).toBe(7);
    expect(ran).toBe(1);
  });

  it("finds a table through an association", () => {
    const associations = { author: { table: "authors" } };

    expect(associatedTable("author", associations)).toBe("authors");
    expect(associatedWith("author", associations)).toBe(true);
    expect(associatedWith("editor", associations)).toBe(false);
    expect(associatedTable("editor", associations)).toBeUndefined();
  });

  /**
   * Qualified always, not only when ambiguous: a table joined later gaining a
   * column of the same name would otherwise change a query's meaning with
   * nothing edited.
   */
  it("qualifies a column by its table", () => {
    expect(qualifiedColumn("posts", "id")).toBe("posts.id");
  });
});
