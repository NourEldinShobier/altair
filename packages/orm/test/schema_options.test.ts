/**
 * Checking what a migration asked for, ported from
 * `activerecord/test/cases/migration/columns_test.rb`,
 * `activerecord/test/cases/migration/index_test.rb` and the option-validation
 * cases in `activerecord/test/cases/migration_test.rb`.
 *
 * The bug being prevented has no symptom: a migration with a misspelled option
 * runs, reports success, and produces a schema that is quietly not what the
 * file says.
 */

import { describe, expect, it } from "bun:test";
import {
  type AlterOperation,
  IndexNameTooLong,
  UnknownOption,
  VALID_COLUMN_OPTIONS,
  addIndexOptions,
  bulkChangeTable,
  changeNull,
  checkConstraintOptions,
  columnIndexes,
  defaultIndexType,
  dropConstraint,
  foreignKeyOptions,
  indexAlgorithm,
  indexAlgorithms,
  indexNameFor,
  maxIndexNameSize,
  validColumnDefinitionOptions,
  validIndexOptions,
  validPrimaryKeyOptions,
  validTableDefinitionOptions,
  validType,
  validateOptions,
} from "../src/schema_options.js";

describe("checking a migration's options", () => {
  it("accepts what it knows", () => {
    expect(() => validColumnDefinitionOptions({ limit: 40, null: false })).not.toThrow();
  });

  /**
   * `t.string :name, limti: 40` runs, succeeds, and produces a column with no
   * limit. Nothing fails, and the difference is found months later by a value
   * that should have been rejected.
   */
  it("refuses a misspelling", () => {
    expect(() => validColumnDefinitionOptions({ limti: 40 })).toThrow(UnknownOption);
  });

  it("names what it did not recognise", () => {
    expect(() => validColumnDefinitionOptions({ limti: 40 })).toThrow("limti");
  });

  it("says what it would have accepted", () => {
    expect(() => validColumnDefinitionOptions({ limti: 40 })).toThrow("limit");
  });

  it("says why it matters", () => {
    expect(() => validColumnDefinitionOptions({ limti: 40 })).toThrow("does not fail");
  });

  it("checks table options separately", () => {
    expect(() => validTableDefinitionOptions({ temporary: true })).not.toThrow();
    expect(() => validTableDefinitionOptions({ limit: 40 })).toThrow(UnknownOption);
  });

  it("checks primary key options separately", () => {
    expect(() => validPrimaryKeyOptions({ type: "bigint" })).not.toThrow();
    expect(() => validPrimaryKeyOptions({ null: false })).toThrow(UnknownOption);
  });

  it("checks index options separately", () => {
    expect(() => validIndexOptions({ unique: true })).not.toThrow();
    expect(() => validIndexOptions({ uniqe: true })).toThrow(UnknownOption);
  });

  /** An allowlist: a denylist can only refuse the typos somebody thought of. */
  it("refuses anything not on the list", () => {
    expect(() => validateOptions({ anything: 1 }, ["known"], "thing")).toThrow(UnknownOption);
    expect(VALID_COLUMN_OPTIONS).toContain("limit");
  });

  it("accepts an empty set of options", () => {
    expect(() => validateOptions({}, ["known"], "thing")).not.toThrow();
  });

  it("checks a type against what the adapter has", () => {
    expect(validType("string", ["string", "integer"])).toBe(true);
    expect(validType("nonsense", ["string", "integer"])).toBe(false);
  });
});

describe("naming an index", () => {
  /**
   * Derived from the table *and every column*, because two indexes on one
   * table differing only in their columns would otherwise collide — and the
   * collision appears on whichever machine already had the first, which is
   * production rather than the laptop.
   */
  it("includes every column", () => {
    expect(indexNameFor("posts", ["author_id", "created_at"])).toBe(
      "index_posts_on_author_id_and_created_at",
    );
  });

  it("gives two different column sets different names", () => {
    expect(indexNameFor("posts", ["a"])).not.toBe(indexNameFor("posts", ["b"]));
  });

  it("uses the derived name by default", () => {
    expect(addIndexOptions("posts", ["author_id"]).name).toBe("index_posts_on_author_id");
  });

  it("takes an explicit name", () => {
    expect(addIndexOptions("posts", ["author_id"], { name: "by_author" }).name).toBe("by_author");
  });

  /**
   * Refused rather than truncated. Truncation is how two indexes end up asking
   * for one name, and the failure lands on the database that already has one.
   */
  it("refuses a name past the identifier limit", () => {
    expect(() => addIndexOptions("posts", ["a".repeat(80)], {}, { maxNameLength: 63 })).toThrow(
      IndexNameTooLong,
    );
  });

  it("says how long it was", () => {
    expect(() => addIndexOptions("posts", ["a".repeat(80)])).toThrow("past the 63");
  });

  it("refuses an index on no columns", () => {
    expect(() => addIndexOptions("posts", [])).toThrow("at least one column");
  });

  it("checks the options it was given", () => {
    expect(() => addIndexOptions("posts", ["id"], { uniqe: true } as never)).toThrow(UnknownOption);
  });

  it("keeps the options it was given", () => {
    expect(addIndexOptions("posts", ["id"], { unique: true, where: "published" })).toMatchObject({
      unique: true,
      where: "published",
      table: "posts",
    });
  });

  it("reports the identifier limit per adapter", () => {
    expect(maxIndexNameSize("mysql")).toBe(64);
    expect(maxIndexNameSize("postgres")).toBe(63);
  });
});

describe("index algorithms", () => {
  it("names the default type per adapter", () => {
    expect(defaultIndexType("postgres")).toBe("btree");
    expect(defaultIndexType("sqlite")).toBe("");
  });

  it("lists what an adapter has", () => {
    expect(indexAlgorithms("postgres")).toEqual({ concurrently: "CONCURRENTLY" });
    expect(indexAlgorithms("mysql")).toEqual({});
  });

  it("resolves one the adapter has", () => {
    expect(indexAlgorithm("postgres", "concurrently")).toBe("CONCURRENTLY");
  });

  it("resolves nothing for the default", () => {
    expect(indexAlgorithm("postgres", "default")).toBe("");
    expect(indexAlgorithm("postgres", undefined)).toBe("");
  });

  /**
   * `concurrently` exists so a migration does not lock the table for the
   * length of an index build. Silently ignoring it turns a safe migration into
   * an outage.
   */
  it("refuses one the adapter does not have", () => {
    expect(() => indexAlgorithm("mysql", "concurrently")).toThrow("no index algorithm");
  });

  it("says what would have happened", () => {
    expect(() => indexAlgorithm("mysql", "concurrently")).toThrow("not to lock the table");
  });

  it("finds the indexes a column takes part in", () => {
    const indexes = [addIndexOptions("posts", ["author_id"]), addIndexOptions("posts", ["title"])];

    expect(columnIndexes(indexes, "author_id")).toHaveLength(1);
    expect(columnIndexes(indexes, "missing")).toEqual([]);
  });
});

describe("altering a table", () => {
  /**
   * Each `ALTER TABLE` on a large table is its own full rewrite on MySQL:
   * three statements rewrite a hundred-million-row table three times, holding
   * a lock for all of it.
   */
  it("puts several changes in one statement", () => {
    const sql = bulkChangeTable("posts", [
      { kind: "addColumn", column: "views", type: "integer" },
      changeNull("title", false),
    ]);

    expect(sql).toBe(
      'ALTER TABLE "posts" ADD COLUMN "views" integer, ALTER COLUMN "title" SET NOT NULL',
    );
  });

  it("drops a column", () => {
    expect(bulkChangeTable("posts", [{ kind: "removeColumn", column: "views" }])).toContain(
      'DROP COLUMN "views"',
    );
  });

  it("allows null again", () => {
    expect(bulkChangeTable("posts", [changeNull("title", true)])).toContain("DROP NOT NULL");
  });

  it("adds and drops a constraint", () => {
    expect(
      bulkChangeTable("posts", [
        { kind: "addConstraint", name: "chk", expression: "views >= 0" },
        dropConstraint("old"),
      ]),
    ).toBe('ALTER TABLE "posts" ADD CONSTRAINT "chk" CHECK (views >= 0), DROP CONSTRAINT "old"');
  });

  it("refuses to build a statement that changes nothing", () => {
    expect(() => bulkChangeTable("posts", [])).toThrow("Nothing to change");
  });

  it("quotes the way the adapter asks", () => {
    const operations: AlterOperation[] = [{ kind: "removeColumn", column: "views" }];

    expect(bulkChangeTable("posts", operations, (name) => `\`${name}\``)).toContain("`posts`");
  });
});

describe("naming a constraint", () => {
  /** An expression can be any length and holds characters an identifier cannot. */
  it("derives a check constraint name from a digest", () => {
    const named = checkConstraintOptions("posts", "views >= 0");

    expect(named.name).toStartWith("chk_rails_");
    expect(named.validate).toBe(true);
  });

  /**
   * Stable across processes: the name ends up in a schema dump, and a digest
   * that varied would make every dump differ and every migration look like it
   * changed something.
   */
  it("derives the same name every time", () => {
    expect(checkConstraintOptions("posts", "views >= 0").name).toBe(
      checkConstraintOptions("posts", "views >= 0").name,
    );
  });

  it("derives different names for different expressions", () => {
    expect(checkConstraintOptions("posts", "views >= 0").name).not.toBe(
      checkConstraintOptions("posts", "views > 0").name,
    );
  });

  it("takes an explicit name", () => {
    expect(checkConstraintOptions("posts", "x", { name: "mine" }).name).toBe("mine");
  });

  it("can be told not to validate", () => {
    expect(checkConstraintOptions("posts", "x", { validate: false }).validate).toBe(false);
  });

  it("derives a foreign key column and name", () => {
    const key = foreignKeyOptions("posts", "authors");

    expect(key.column).toBe("author_id");
    expect(key.primaryKey).toBe("id");
    expect(key.name).toStartWith("fk_rails_");
  });

  it("takes an explicit column", () => {
    expect(foreignKeyOptions("posts", "authors", { column: "editor_id" }).column).toBe("editor_id");
  });

  it("carries an on-delete rule through", () => {
    expect(foreignKeyOptions("posts", "authors", { onDelete: "cascade" }).onDelete).toBe("cascade");
  });

  it("leaves it out when there is none", () => {
    expect(Object.keys(foreignKeyOptions("posts", "authors"))).not.toContain("onDelete");
  });
});
