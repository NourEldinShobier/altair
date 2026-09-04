/**
 * Where a table lives, and what a dump must not pin down, ported from
 * `activerecord/test/cases/adapters/postgresql/schema_test.rb` and the
 * ignore-pattern cases in `schema_dumper_test.rb`.
 *
 * Everything here produces a schema file that loads without complaint and
 * rebuilds a different database.
 */

import { describe, expect, it } from "bun:test";
import {
  GENERATED_NAME_PATTERNS,
  createSchemaSql,
  currentSchemas,
  dropSchemaSql,
  exportNameOnSchemaDump,
  qualifiedTableName,
  quoteSearchPathEntry,
  renameSchema,
  setSearchPathSql,
  splitSchemaName,
  tableCollation,
  tableOptions,
} from "../src/schema-namespaces.js";

describe("quoting a search path entry", () => {
  it("leaves an ordinary name alone", () => {
    expect(quoteSearchPathEntry("public")).toBe("public");
    expect(quoteSearchPathEntry("tenant_1")).toBe("tenant_1");
  });

  /**
   * `$user` is a legal search-path entry and not a legal bare identifier, and
   * it is in the *default* path — so the failure is on a path nobody chose.
   */
  it("quotes one that is not an identifier", () => {
    expect(quoteSearchPathEntry("$user")).toBe('"$user"');
    expect(quoteSearchPathEntry("with space")).toBe('"with space"');
    expect(quoteSearchPathEntry("2024")).toBe('"2024"');
  });

  it("escapes a quote inside one", () => {
    expect(quoteSearchPathEntry('we"ird')).toBe('"we""ird"');
  });
});

describe("the search path as the server sees it", () => {
  it("is the entries, unquoted and trimmed", () => {
    expect(currentSchemas('"$user", public', { user: "ada" })).toEqual(["ada", "public"]);
  });

  it("resolves the user's own schema", () => {
    expect(currentSchemas("$user", { user: "ada" })).toEqual(["ada"]);
  });

  /** Which is what the server does, rather than failing on a path it was given. */
  it("drops the user entry when there is no user", () => {
    expect(currentSchemas('"$user", public')).toEqual(["public"]);
  });

  it("drops an entry whose schema does not exist", () => {
    expect(currentSchemas("$user, public", { user: "ada", existing: ["public"] })).toEqual([
      "public",
    ]);
  });

  it("ignores empty entries", () => {
    expect(currentSchemas("public, , analytics")).toEqual(["public", "analytics"]);
  });

  it("is nothing for an empty path", () => {
    expect(currentSchemas("")).toEqual([]);
  });
});

describe("the statements that manage a schema", () => {
  it("sets a path", () => {
    expect(setSearchPathSql(["$user", "public"])).toBe('SET search_path TO "$user", public');
  });

  it("creates one", () => {
    expect(createSchemaSql("analytics")).toBe("CREATE SCHEMA analytics");
    expect(createSchemaSql("analytics", { ifNotExists: true })).toBe(
      "CREATE SCHEMA IF NOT EXISTS analytics",
    );
  });

  /**
   * A schema is dropped to remove a tenant or a test namespace, and it always
   * has tables in it: without CASCADE the statement fails on exactly the
   * schemas anybody would want to drop.
   */
  it("drops one, with everything in it", () => {
    expect(dropSchemaSql("analytics")).toBe("DROP SCHEMA analytics CASCADE");
    expect(dropSchemaSql("analytics", { ifExists: true })).toBe(
      "DROP SCHEMA IF EXISTS analytics CASCADE",
    );
  });

  it("renames one", () => {
    expect(renameSchema("old", "new")).toBe("ALTER SCHEMA old RENAME TO new");
  });

  it("quotes a name that needs it", () => {
    expect(createSchemaSql("with space")).toBe('CREATE SCHEMA "with space"');
  });
});

describe("a qualified table name", () => {
  it("splits into its parts", () => {
    expect(splitSchemaName("analytics.events")).toEqual({ schema: "analytics", table: "events" });
  });

  it("is all table when there is no schema", () => {
    expect(splitSchemaName("events")).toEqual({ table: "events" });
  });

  /**
   * On the first dot: split on the last, a table called `reports.2024` in the
   * public schema reads as a table `2024` in a schema `reports` that does not
   * exist.
   */
  it("splits on the first dot", () => {
    expect(splitSchemaName("reports.2024.q1")).toEqual({ schema: "reports", table: "2024.q1" });
  });

  it("qualifies a name outside the path's first entry", () => {
    expect(qualifiedTableName("events", { schema: "analytics", searchPath: ["public"] })).toBe(
      "analytics.events",
    );
  });

  /**
   * A dump full of redundant qualifications is one that cannot be loaded into a
   * database using a different path — which is the usual reason for having one.
   */
  it("leaves a name in the path's first schema unqualified", () => {
    expect(qualifiedTableName("events", { schema: "public", searchPath: ["public"] })).toBe(
      "events",
    );
  });

  it("leaves a name with no schema alone", () => {
    expect(qualifiedTableName("events")).toBe("events");
  });

  /**
   * Only the *first* entry. A schema further down the path is found only when
   * nothing before it has a table of that name, so leaving the name
   * unqualified there is a name that means something else the moment somebody
   * adds a table to the schema above it.
   */
  it("qualifies a name from further down the path", () => {
    expect(
      qualifiedTableName("events", { schema: "analytics", searchPath: ["public", "analytics"] }),
    ).toBe("analytics.events");
  });
});

describe("whether a constraint's name belongs in a dump", () => {
  /**
   * A generated name records an identifier derived from the table and column
   * names as they were on the machine that first created it: two developers'
   * dumps differ, the diff is noise, and a rename upstream stops matching.
   */
  it("leaves out one the database generated", () => {
    expect(exportNameOnSchemaDump("fk_rails_0123456789")).toBe(false);
    expect(exportNameOnSchemaDump("chk_rails_0123456789", "check")).toBe(false);
    expect(exportNameOnSchemaDump("excl_rails_0123456789", "exclusion")).toBe(false);
    expect(exportNameOnSchemaDump("uniq_rails_0123456789", "unique")).toBe(false);
  });

  /** It may be referenced by a migration, a query hint, or an operator. */
  it("keeps one the application chose", () => {
    expect(exportNameOnSchemaDump("posts_author_fk")).toBe(true);
    expect(exportNameOnSchemaDump("fk_rails_short")).toBe(true);
  });

  /**
   * The generated form is exactly ten hex characters. A name that merely
   * begins the same way — `fk_rails_orders`, written by hand — is the
   * application's, and dropping it would lose a name a migration may reference.
   */
  it("matches the generated shape exactly", () => {
    expect(exportNameOnSchemaDump("fk_rails_0123456789a")).toBe(true);
    expect(exportNameOnSchemaDump("fk_rails_012345678")).toBe(true);
  });

  /** The patterns are per kind: a check constraint is not a foreign key. */
  it("does not mistake one kind's generated name for another's", () => {
    expect(exportNameOnSchemaDump("chk_rails_0123456789", "foreignKey")).toBe(true);
    expect(exportNameOnSchemaDump("fk_rails_0123456789", "check")).toBe(true);
    expect(Object.keys(GENERATED_NAME_PATTERNS).sort()).toEqual([
      "check",
      "exclusion",
      "foreignKey",
      "unique",
    ]);
  });

  it("has nothing to write for a constraint with no name", () => {
    expect(exportNameOnSchemaDump(undefined)).toBe(false);
  });
});

describe("what a table is beyond its columns", () => {
  /**
   * Each changes what the rebuilt table *does*: the engine decides whether
   * there are transactions, the row format how large a row may be before an
   * insert fails, the collation what `WHERE name = 'é'` matches.
   */
  it("carries the options that were set", () => {
    expect(
      tableOptions({
        engine: "InnoDB",
        rowFormat: "DYNAMIC",
        charset: "utf8mb4",
        collation: "utf8mb4_bin",
      }),
    ).toBe("ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin");
  });

  /**
   * A dump that pinned the defaults would fail to load on a server configured
   * differently — which is most of them.
   */
  it("says nothing about what was not set", () => {
    expect(tableOptions()).toBe("");
    expect(tableOptions({ engine: "InnoDB" })).toBe("ENGINE=InnoDB");
  });

  it("carries a comment", () => {
    expect(tableOptions({ comment: "audit log" })).toBe("COMMENT='audit log'");
  });

  it("is the table's collation when it has one", () => {
    expect(tableCollation("posts", { posts: "utf8mb4_bin" }, "utf8mb4_general_ci")).toBe(
      "utf8mb4_bin",
    );
  });

  /**
   * What the server does — and a table reported as having no collation would
   * make a dump omit the thing that decides whether two names are equal.
   */
  it("falls back to the database's", () => {
    expect(tableCollation("posts", {}, "utf8mb4_general_ci")).toBe("utf8mb4_general_ci");
    expect(tableCollation("posts", {})).toBeUndefined();
  });
});
