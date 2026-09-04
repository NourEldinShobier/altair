/**
 * Building one statement that writes many rows, ported from
 * `activerecord/test/cases/insert_all_test.rb` and the upsert cases in
 * `activerecord/test/cases/adapters/postgresql/insert_all_test.rb`.
 *
 * A bulk write is a different thing from a loop of single writes, not a faster
 * one — no callbacks, no validations, one column list for every row — so most
 * of these are about refusing input a loop would have accepted.
 */

import { describe, expect, it } from "bun:test";
import {
  MismatchedColumns,
  MissingConflictTarget,
  buildInsertSql,
  defaultInsertValue,
  emptyInsertStatementValue,
  insertColumns,
  returnValueAfterInsert,
  returnValueAfterUpdate,
  skipDuplicates,
  timestampColumns,
  updatableColumns,
  updateDuplicates,
  valuesList,
} from "../src/insert-all.js";

const ROWS = [
  { id: 1, title: "a", views: 0 },
  { id: 2, title: "b", views: 0 },
];

describe("the columns a set of rows writes", () => {
  it("takes them from the rows", () => {
    expect(insertColumns(ROWS)).toEqual(["id", "title", "views"]);
  });

  it("takes none from no rows", () => {
    expect(insertColumns([])).toEqual([]);
  });

  /**
   * Checked rather than unioned. A union accepts rows that disagree and fills
   * the difference with NULL — over columns the caller never mentioned, and
   * past the defaults the database would have supplied.
   */
  it("refuses a row missing a column", () => {
    expect(() => insertColumns([{ id: 1, title: "a" }, { id: 2 }])).toThrow(MismatchedColumns);
  });

  it("refuses a row with an extra column", () => {
    expect(() => insertColumns([{ id: 1 }, { id: 2, title: "b" }])).toThrow(MismatchedColumns);
  });

  it("names the row and the column", () => {
    expect(() => insertColumns([{ id: 1, title: "a" }, { id: 2 }])).toThrow("Row 1");
    expect(() => insertColumns([{ id: 1, title: "a" }, { id: 2 }])).toThrow("title");
  });

  it("says what would have been written", () => {
    expect(() => insertColumns([{ id: 1, title: "a" }, { id: 2 }])).toThrow("NULL");
  });

  it("puts the values in column order", () => {
    expect(valuesList([{ b: 2, a: 1 }], ["a", "b"])).toEqual([[1, 2]]);
  });
});

describe("which columns an upsert overwrites", () => {
  /**
   * Not the ones that identify the row: those are how it was found, and
   * setting them to themselves is noise at best and a no-op update that still
   * takes a row lock at worst.
   */
  it("leaves the conflict target alone", () => {
    expect(updatableColumns(["id", "title", "views"], { uniqueBy: ["id"] })).toEqual([
      "title",
      "views",
    ]);
  });

  it("takes an explicit list", () => {
    expect(
      updatableColumns(["id", "title", "views"], { uniqueBy: ["id"], updateOnly: ["title"] }),
    ).toEqual(["title"]);
  });

  it("takes an exclusion list", () => {
    expect(
      updatableColumns(["id", "title", "views"], { uniqueBy: ["id"], updateExcept: ["views"] }),
    ).toEqual(["title"]);
  });

  it("updates everything with no conflict target named", () => {
    expect(updatableColumns(["title", "views"])).toEqual(["title", "views"]);
  });
});

describe("timestamps", () => {
  it("sets both on an insert", () => {
    expect(timestampColumns(["title", "created_at", "updated_at"])).toEqual([
      "created_at",
      "updated_at",
    ]);
  });

  /**
   * `created_at` describes when the row first existed. An upsert overwriting
   * it makes every touched row look newly created — and that is the column
   * most reports group by.
   */
  it("does not touch created_at on the update half", () => {
    expect(timestampColumns(["created_at", "updated_at"], { forUpdate: true })).toEqual([
      "updated_at",
    ]);
  });

  it("sets none the table does not have", () => {
    expect(timestampColumns(["title"])).toEqual([]);
  });
});

describe("building the statement", () => {
  it("writes one row", () => {
    const { sql, binds } = buildInsertSql("posts", [{ id: 1, title: "a" }]);

    expect(sql).toBe('INSERT INTO "posts" ("id", "title") VALUES ($1, $2)');
    expect(binds).toEqual([1, "a"]);
  });

  it("writes several", () => {
    const { sql, binds } = buildInsertSql("posts", ROWS);

    expect(sql).toContain("($1, $2, $3), ($4, $5, $6)");
    expect(binds).toHaveLength(6);
  });

  /** A bulk insert is usually the path carrying data from somewhere else. */
  it("binds values rather than interpolating them", () => {
    const { sql, binds } = buildInsertSql("posts", [{ title: "'; DROP TABLE posts --" }]);

    expect(sql).not.toContain("DROP TABLE");
    expect(binds).toEqual(["'; DROP TABLE posts --"]);
  });

  it("quotes the way the adapter asks", () => {
    const { sql } = buildInsertSql("posts", [{ id: 1 }], { quote: (name) => `\`${name}\`` });

    expect(sql).toContain("`posts`");
  });

  it("numbers placeholders the way the adapter asks", () => {
    const { sql } = buildInsertSql("posts", [{ id: 1 }], { placeholder: () => "?" });

    expect(sql).toContain("VALUES (?)");
  });

  /** A join table of only auto-populated columns is legitimate and rare. */
  it("writes a row of pure defaults", () => {
    expect(buildInsertSql("posts", [{}]).sql).toBe('INSERT INTO "posts" DEFAULT VALUES');
  });

  it("spells that differently on MySQL", () => {
    expect(emptyInsertStatementValue("mysql")).toBe("() VALUES ()");
    expect(emptyInsertStatementValue("postgres")).toBe("DEFAULT VALUES");
    expect(defaultInsertValue()).toBe("DEFAULT");
  });

  it("returns columns when asked", () => {
    expect(buildInsertSql("posts", [{ id: 1 }], { returning: ["id"] }).sql).toEndWith(
      'RETURNING "id"',
    );
  });

  it("returns none by default", () => {
    expect(buildInsertSql("posts", [{ id: 1 }]).sql).not.toContain("RETURNING");
  });
});

describe("what happens on a conflict", () => {
  it("says nothing by default", () => {
    expect(buildInsertSql("posts", [{ id: 1 }]).sql).not.toContain("ON CONFLICT");
  });

  /** "Any conflict" is unambiguous, which is why a skip needs no target. */
  it("skips without needing a target", () => {
    expect(buildInsertSql("posts", [{ id: 1 }], { conflict: "skip" }).sql).toEndWith(
      "ON CONFLICT DO NOTHING",
    );
  });

  it("skips on a named target when given one", () => {
    expect(
      buildInsertSql("posts", [{ id: 1 }], { conflict: "skip", uniqueBy: ["id"] }).sql,
    ).toEndWith('ON CONFLICT ("id") DO NOTHING');
  });

  it("updates on a named target", () => {
    const { sql } = buildInsertSql("posts", [{ id: 1, title: "a" }], {
      conflict: "update",
      uniqueBy: ["id"],
    });

    expect(sql).toEndWith('ON CONFLICT ("id") DO UPDATE SET "title" = EXCLUDED."title"');
  });

  /**
   * Postgres refuses the statement and MySQL upserts on the primary key —
   * different enough that guessing is worse than asking.
   */
  it("refuses to update with no target", () => {
    expect(() => buildInsertSql("posts", [{ id: 1 }], { conflict: "update" })).toThrow(
      MissingConflictTarget,
    );
  });

  /** `DO UPDATE SET` with no assignments is a syntax error. */
  it("becomes a skip when nothing is left to update", () => {
    const { sql } = buildInsertSql("posts", [{ id: 1 }], {
      conflict: "update",
      uniqueBy: ["id"],
    });

    expect(sql).toEndWith('ON CONFLICT ("id") DO NOTHING');
  });

  it("names the two behaviours", () => {
    expect(skipDuplicates("skip")).toBe(true);
    expect(skipDuplicates("update")).toBe(false);
    expect(updateDuplicates("update")).toBe(true);
    expect(updateDuplicates("raise")).toBe(false);
  });
});

describe("reading rows back", () => {
  it("returns what was asked for where the adapter can", () => {
    expect(returnValueAfterInsert(true, ["id"])).toEqual(["id"]);
  });

  /**
   * Asking elsewhere produces a statement the database refuses, and the
   * fallback — a second query for the ids just written — cannot identify them
   * reliably in a bulk write.
   */
  it("returns nothing where it cannot", () => {
    expect(returnValueAfterInsert(false, ["id"])).toBeUndefined();
  });

  it("returns nothing when nothing was asked for", () => {
    expect(returnValueAfterInsert(true, false)).toBeUndefined();
    expect(returnValueAfterInsert(true, undefined)).toBeUndefined();
  });

  /** SQLite gained UPDATE ... RETURNING later than INSERT, so they differ. */
  it("asks the update capability separately", () => {
    expect(returnValueAfterUpdate(false, ["id"])).toBeUndefined();
    expect(returnValueAfterUpdate(true, ["id"])).toEqual(["id"]);
  });
});
