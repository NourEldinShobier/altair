/**
 * What a model's table, primary key and sequence are called, ported from
 * `activerecord/test/cases/base_test.rb`'s naming cases,
 * `activerecord/test/cases/inheritance_test.rb` and the identifier-length
 * cases in `activerecord/test/cases/migration/index_test.rb`.
 *
 * The two themes are inheritance — a derived name recomputes, an explicit one
 * never does — and length, where every server truncates rather than refusing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  IDENTIFIER_LIMITS,
  IdentifierTooLong,
  type ModelNaming,
  activePrimaryKey,
  activeSequence,
  aliasFor,
  aliasedTable,
  cachedTableName,
  checkIdentifierLength,
  defaultNamingConfig,
  deriveTableName,
  extractSchemaQualifiedName,
  fullTableNamePrefix,
  fullTableNameSuffix,
  indexNameLength,
  inferredId,
  joinForeignKey,
  joinForeignType,
  joinIdFor,
  joinPrimaryKey,
  joinPrimaryType,
  nextSequenceValue,
  prefetchPrimaryKey,
  primaryKeyName,
  primaryKeyType,
  resetPrimaryKey,
  resetPrimaryKeys,
  resetSequence,
  resetSequences,
  resetTableName,
  sequenceName,
  setPkSequence,
  setPrimaryKey,
  tableAliasLength,
  tableName,
  tableNameLength,
  tableizeName,
} from "../src/model_naming.js";

afterEach(() => {
  resetPrimaryKeys();
  resetSequences();
});

describe("deriving a table name", () => {
  it("underscores and pluralises", () => {
    expect(deriveTableName("BlogPost")).toBe("blog_posts");
    expect(deriveTableName("Admin::Post")).toBe("admin/posts");
  });

  /** What an application mapping onto a legacy schema needs. */
  it("leaves it singular when pluralisation is off", () => {
    expect(
      deriveTableName("BlogPost", { ...defaultNamingConfig(), pluralizeTableNames: false }),
    ).toBe("blog_post");
  });

  /** Applied after, so a prefix is not itself pluralised. */
  it("applies a prefix and a suffix around the derived name", () => {
    expect(
      deriveTableName("Post", {
        tableNamePrefix: "app_",
        tableNameSuffix: "_v2",
        pluralizeTableNames: true,
      }),
    ).toBe("app_posts_v2");
  });

  /**
   * Reading only the innermost gives `reports_`, a table that exists in
   * neither schema.
   */
  it("gathers a prefix from every enclosing namespace", () => {
    expect(
      fullTableNamePrefix([{ tableNamePrefix: "admin_" }, { tableNamePrefix: "reports_" }]),
    ).toBe("admin_reports_");
  });

  it("gathers a suffix from the inside out", () => {
    expect(
      fullTableNameSuffix([{ tableNameSuffix: "_outer" }, { tableNameSuffix: "_inner" }]),
    ).toBe("_inner_outer");
  });

  it("gathers nothing from namespaces that declare nothing", () => {
    expect(fullTableNamePrefix([{}, {}])).toBe("");
  });
});

describe("inheritance", () => {
  const base: ModelNaming = { className: "Post" };

  /**
   * Backwards, an STI subclass looks for a table that does not exist — or two
   * unrelated models share one, which works until their columns diverge.
   */
  it("gives an STI subclass its base class's table", () => {
    expect(
      tableName({ className: "SpecialPost", parent: base, singleTableInheritance: true }),
    ).toBe("posts");
  });

  it("gives an independent subclass its own", () => {
    expect(tableName({ className: "Draft", parent: base })).toBe("drafts");
  });

  it("prefers an explicit name over everything", () => {
    expect(tableName({ className: "Post", explicitTableName: "legacy_posts", parent: base })).toBe(
      "legacy_posts",
    );
  });

  /**
   * The whole point of setting one is that nothing recomputes it, and a reset
   * that cleared it would silently move a legacy model onto a conventionally
   * named table.
   */
  it("leaves an explicit name alone across a reset", () => {
    const model: ModelNaming = { className: "Post", explicitTableName: "legacy_posts" };
    const key = {};

    expect(cachedTableName(model, key)).toBe("legacy_posts");
    expect(resetTableName(model, key)).toBe("legacy_posts");
  });

  it("recomputes a derived name after a reset", () => {
    const model: ModelNaming = { className: "Post" };
    const key = {};

    cachedTableName(model, key);
    model.config = { tableNamePrefix: "app_", tableNameSuffix: "", pluralizeTableNames: true };

    // Still the cached answer, which is the point of caching it.
    expect(cachedTableName(model, key)).toBe("posts");

    resetTableName(model, key);

    // And the *next* cached read is the new one — the reset has to actually
    // drop the entry, not merely recompute once and leave the stale one behind.
    expect(cachedTableName(model, key)).toBe("app_posts");
  });
});

describe("a schema-qualified name", () => {
  it("splits the two halves", () => {
    expect(extractSchemaQualifiedName("public.posts")).toEqual({
      schema: "public",
      identifier: "posts",
    });
  });

  it("leaves an unqualified name alone", () => {
    expect(extractSchemaQualifiedName("posts")).toEqual({ identifier: "posts" });
  });

  /**
   * A table genuinely named `"my.table"` exists, and splitting it would
   * produce a schema nobody created.
   */
  it("does not split inside quotes", () => {
    expect(extractSchemaQualifiedName('"my.table"')).toEqual({ identifier: "my.table" });
    expect(extractSchemaQualifiedName('public."my.table"')).toEqual({
      schema: "public",
      identifier: "my.table",
    });
  });

  it("reads a doubled quote as one", () => {
    expect(extractSchemaQualifiedName('"we""ird"')).toEqual({ identifier: 'we"ird' });
  });
});

describe("identifier length", () => {
  it("knows each server's limit", () => {
    expect(tableNameLength("postgres")).toBe(63);
    expect(tableNameLength("mysql")).toBe(64);
    expect(indexNameLength("postgres")).toBe(63);
    expect(tableAliasLength("mysql")).toBe(64);
    expect(IDENTIFIER_LIMITS["sqlite"]).toBeGreaterThan(100);
  });

  it("falls back to the strictest limit for an unknown adapter", () => {
    expect(tableNameLength("oracle")).toBe(63);
  });

  /**
   * A name past the limit is truncated rather than refused, so two names
   * differing only past the cutoff become one — and the collision appears on
   * whichever database already had the first.
   */
  it("refuses a name that would be truncated", () => {
    expect(() => checkIdentifierLength("a".repeat(64), "postgres")).toThrow(IdentifierTooLong);
    expect(() => checkIdentifierLength("a".repeat(64), "postgres")).toThrow(
      "already had the first",
    );
    expect(checkIdentifierLength("a".repeat(63), "postgres")).toHaveLength(63);
  });
});

describe("aliasing a joined table", () => {
  it("suffixes a short name plainly", () => {
    expect(aliasFor("posts", "2")).toBe("posts_2");
  });

  it("flattens a schema qualification, which is not valid in an alias", () => {
    expect(aliasFor("public.posts", "2")).toBe("public_posts_2");
  });

  /**
   * A plain truncation is the failure this exists to prevent: two aliases
   * cutting to the same thing make a query joining a table twice silently join
   * it to itself once.
   */
  it("digests a name that would be truncated", () => {
    const long = "a".repeat(70);
    const first = aliasFor(long, "2");
    const second = aliasFor(`${long}b`, "2");

    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).not.toBe(second);
  });

  /**
   * Numbered from two, because the first occurrence keeps the bare name: a
   * query joining a table once should read as it always did.
   */
  it("leaves the first occurrence unaliased", () => {
    expect(aliasedTable("posts", new Set())).toBe("posts");
    expect(aliasedTable("posts", new Set(["posts"]))).toBe("posts_2");
    expect(aliasedTable("posts", new Set(["posts", "posts_2"]))).toBe("posts_3");
  });
});

describe("primary keys", () => {
  const base: ModelNaming = { className: "Post" };

  it("is id unless told otherwise", () => {
    expect(primaryKeyName(base)).toBe("id");
    expect(primaryKeyName({ ...base, explicitPrimaryKey: "uuid" })).toBe("uuid");
  });

  /**
   * They share a table and a table has one primary key — a subclass deriving
   * its own would generate a WHERE against a column the table does not have.
   */
  it("is inherited by an STI subclass", () => {
    expect(
      primaryKeyName({
        className: "SpecialPost",
        parent: { ...base, explicitPrimaryKey: "uuid" },
        singleTableInheritance: true,
      }),
    ).toBe("uuid");
  });

  /**
   * A model whose key is configured from an initializer is ordinary, and
   * caching the derived answer at load time would make that configuration do
   * nothing.
   */
  it("takes a key set after boot", () => {
    expect(activePrimaryKey(base)).toBe("id");

    setPrimaryKey("Post", "uuid");

    expect(activePrimaryKey(base)).toBe("uuid");

    resetPrimaryKey("Post");

    expect(activePrimaryKey(base)).toBe("id");
  });

  /**
   * The singular class name, not the table name: the table is plural, and
   * `posts_id` is a column nobody generates and every convention would miss.
   */
  it("derives a foreign key from the singular name", () => {
    expect(inferredId("Post")).toBe("post_id");
    expect(inferredId("Admin::BlogPost")).toBe("blog_post_id");
    expect(inferredId("People")).toBe("person_id");
  });

  /**
   * A table that outgrows a 32-bit key needs a migration rewriting every row
   * and index, at the moment it can least afford one.
   */
  it("generates a bigint key", () => {
    expect(primaryKeyType()).toBe("bigint");
    expect(primaryKeyType("uuid")).toBe("uuid");
  });

  /**
   * Wrong the other way, a newly created record has no id and every
   * association built against it points at nothing.
   */
  it("says when the id has to be generated first", () => {
    expect(prefetchPrimaryKey("postgres")).toBe(false);
    expect(prefetchPrimaryKey("postgres", "uuid")).toBe(true);
  });
});

describe("sequences", () => {
  it("derives one from the table and key", () => {
    expect(sequenceName("posts")).toBe("posts_id_seq");
    expect(sequenceName("posts", "uuid")).toBe("posts_uuid_seq");
  });

  /**
   * Two long tables whose sequence names truncate together would share one
   * counter, so one of them would skip most of its ids.
   */
  it("digests one that would be truncated", () => {
    const long = "a".repeat(70);
    const first = sequenceName(long);
    const second = sequenceName(`${long}b`);

    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).not.toBe(second);
    expect(first).toEndWith("_seq");
  });

  it("takes one set explicitly", () => {
    expect(activeSequence("Post", "posts")).toBe("posts_id_seq");

    setPkSequence("Post", "legacy_seq");

    expect(activeSequence("Post", "posts")).toBe("legacy_seq");

    resetSequence("Post");

    expect(activeSequence("Post", "posts")).toBe("posts_id_seq");
  });

  it("draws the next value", () => {
    expect(nextSequenceValue("posts_id_seq")).toBe("SELECT nextval('posts_id_seq')");
  });

  it("escapes a quote in the name", () => {
    expect(nextSequenceValue("we'ird")).toContain("we''ird");
  });

  /**
   * Elsewhere the id comes back from the insert itself, so asking first would
   * consume a value the row never uses — leaving a gap that reads as a deleted
   * record.
   */
  it("refuses on an adapter that does not work that way", () => {
    expect(() => nextSequenceValue("posts_id_seq", "mysql")).toThrow("reads as a deleted record");
  });
});

describe("the other side of an association", () => {
  it("derives a foreign key from the association name", () => {
    expect(joinForeignKey({ name: "Post" })).toBe("post_id");
    expect(joinForeignKey({ name: "Post", foreignKey: "author_id" })).toBe("author_id");
  });

  it("defaults the primary key to id", () => {
    expect(joinPrimaryKey({})).toBe("id");
    expect(joinPrimaryKey({ primaryKey: "uuid" })).toBe("uuid");
  });

  /**
   * A join built with a type condition against a table that has no type column
   * fails in the adapter with a message about SQL.
   */
  it("has no type columns unless the association is polymorphic", () => {
    expect(joinForeignType({ name: "commentable" })).toBeUndefined();
    expect(joinPrimaryType({})).toBeUndefined();
    expect(joinForeignType({ name: "commentable", polymorphic: true })).toBe("commentable_type");
    expect(joinPrimaryType({ polymorphic: true })).toBe("type");
  });

  it("takes an explicit foreign type", () => {
    expect(joinForeignType({ name: "commentable", polymorphic: true, foreignType: "kind" })).toBe(
      "kind",
    );
  });

  it("reads the join value off the owner", () => {
    expect(joinIdFor({ id: 7 }, "id")).toBe(7);
  });

  it("tableizes a bare name", () => {
    expect(tableizeName("BlogPost")).toBe("blog_posts");
    expect(tableizeName("BlogPost", false)).toBe("blog_post");
  });
});
