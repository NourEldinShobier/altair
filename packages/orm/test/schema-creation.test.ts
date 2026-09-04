/**
 * Turning a schema change into DDL, ported from
 * `activerecord/test/cases/adapters/postgresql/schema_test.rb`,
 * `activerecord/test/cases/migration/check_constraint_test.rb`,
 * `activerecord/test/cases/migration/foreign_key_test.rb` and the SQLite
 * virtual-table cases in
 * `activerecord/test/cases/adapters/sqlite3/sqlite3_adapter_test.rb`.
 *
 * The cases worth having are the ones about a constraint that exists without
 * being true yet, and the ones about an adapter that cannot express what it
 * was asked for.
 */

import { describe, expect, it } from "bun:test";
import {
  buildAlterTableDefinition,
  buildCreateIndexDefinition,
  buildCreateJoinTableDefinition,
  buildCreateTableDefinition,
  changeForeignKey,
  checkAllForeignKeysValid,
  checkConstraint,
  compatibleTableDefinition,
  createIndexDefinition,
  createTableAndSetFlags,
  createVirtualTable,
  deferrable,
  disableIndex,
  dropCheckConstraint,
  dropForeignKey,
  dropVirtualTable,
  enableIndex,
  exclusionConstraint,
  foreignKeyColumnFor,
  newCheckConstraintDefinition,
  newColumnDefinition,
  newExclusionConstraintDefinition,
  newForeignKeyDefinition,
  newUniqueConstraintDefinition,
  optionsIncludeDefault,
  primaryKeyDefinition,
  removeConstraint,
  removeReferences,
  schemaCreation,
  setConstraints,
  uniqueConstraint,
  updateTableDefinition,
  usingIndex,
  validateCheckConstraint,
  validateConstraint,
  virtualTableExists,
} from "../src/schema-creation.js";
import { addIndexOptions } from "../src/schema-options.js";

describe("definition objects", () => {
  it("holds a column", () => {
    expect(newColumnDefinition("title", "varchar", { null: false })).toEqual({
      name: "title",
      type: "varchar",
      options: { null: false },
    });
  });

  /** A composite key is not a different kind of thing from a single one. */
  it("holds a primary key as a list either way", () => {
    expect(primaryKeyDefinition("id").columns).toEqual(["id"]);
    expect(primaryKeyDefinition(["shop_id", "id"]).columns).toEqual(["shop_id", "id"]);
  });

  /**
   * Through the real inflector rather than by dropping a trailing "s":
   * `assemblies` singularises to `assembly`, and `assemblie_id` would be a
   * column pointing at a table by a name that does not exist.
   */
  it("derives a foreign key's column from the table", () => {
    expect(foreignKeyColumnFor("posts")).toBe("post_id");
    expect(foreignKeyColumnFor("public.posts")).toBe("post_id");
    expect(foreignKeyColumnFor("assemblies")).toBe("assembly_id");
    expect(foreignKeyColumnFor("people")).toBe("person_id");
  });

  it("builds a foreign key", () => {
    const key = newForeignKeyDefinition("fk_a", "posts");

    expect(key.column).toEqual(["post_id"]);
    expect(key.primaryKey).toEqual(["id"]);
    expect(key.validate).toBe(true);
  });

  it("takes an explicit column", () => {
    expect(newForeignKeyDefinition("fk_a", "posts", { column: "author_id" }).column).toEqual([
      "author_id",
    ]);
  });

  it("builds a check constraint", () => {
    expect(newCheckConstraintDefinition("chk", "price > 0")).toEqual({
      name: "chk",
      expression: "price > 0",
      validate: true,
    });
  });

  /**
   * Postgres treats two NULLs as distinct, so a "unique" nullable column
   * accepts any number of rows with no value — usually a surprise rather than
   * a decision.
   */
  it("does not assume nulls are the same value", () => {
    expect(newUniqueConstraintDefinition("uq", "position").nullsNotDistinct).toBe(false);
    expect(
      newUniqueConstraintDefinition("uq", "position", { nullsNotDistinct: true }).nullsNotDistinct,
    ).toBe(true);
  });

  /** btree only knows equality and ordering; an exclusion compares with `&&`. */
  it("defaults an exclusion constraint to gist", () => {
    expect(newExclusionConstraintDefinition("ex", "during WITH &&").using).toBe("gist");
    expect(newExclusionConstraintDefinition("ex", "a WITH =", { using: "btree" }).using).toBe(
      "btree",
    );
  });
});

describe("deferrable", () => {
  it("takes the two values that mean something", () => {
    expect(deferrable("immediate")).toBe("immediate");
    expect(deferrable("deferred")).toBe("deferred");
  });

  /**
   * A misspelt value would silently produce a non-deferrable constraint, and
   * the failure shows up as a violation in the middle of a valid transaction.
   */
  it("refuses anything else", () => {
    expect(() => deferrable(true)).toThrow("immediate");
    expect(() => deferrable("yes")).toThrow('"yes"');
  });

  it("says why it matters", () => {
    expect(() => deferrable("later")).toThrow("dropping and re-adding");
  });

  it("checks a constraint's value when it is built", () => {
    expect(() => newUniqueConstraintDefinition("uq", "a", { deferrable: "soon" as never })).toThrow(
      "immediate",
    );
  });
});

describe("building a table definition", () => {
  /** The change is a value before it is a statement, which is what makes it reversible. */
  it("hands back the definition rather than running it", () => {
    const table = buildCreateTableDefinition("posts");

    expect(table.name).toBe("posts");
    expect(table.columns[0]?.name).toBe("id");
  });

  it("takes no primary key at all", () => {
    expect(buildCreateTableDefinition("posts", { id: false }).primaryKeys).toBeUndefined();
  });

  it("takes a composite one", () => {
    const table = buildCreateTableDefinition("posts", { primaryKey: ["shop_id", "id"] });

    expect(table.primaryKeys?.columns).toEqual(["shop_id", "id"]);
    expect(table.columns.map((column) => column.name)).toEqual(["shop_id", "id"]);
  });

  it("hands the definition to a block", () => {
    const table = buildCreateTableDefinition("posts", {}, (definition) => {
      definition.columns.push(newColumnDefinition("title", "varchar"));
    });

    expect(table.columns.map((column) => column.name)).toEqual(["id", "title"]);
  });

  it("collects alterations", () => {
    const alter = buildAlterTableDefinition("posts", (at) => {
      at.operations.push({ kind: "dropColumn", name: "old" });
    });

    expect(alter.operations).toHaveLength(1);
    expect(updateTableDefinition("posts").operations).toEqual([]);
  });

  /**
   * Named from the two tables in lexical order, so the same call written
   * either way round produces one table rather than two that both half-work.
   */
  it("names a join table the same either way round", () => {
    expect(buildCreateJoinTableDefinition("parts", "assemblies").name).toBe("assemblies_parts");
    expect(buildCreateJoinTableDefinition("assemblies", "parts").name).toBe("assemblies_parts");
  });

  /** A row is identified by the pair; an id column is one nothing ever reads. */
  it("gives a join table no primary key", () => {
    const table = buildCreateJoinTableDefinition("assemblies", "parts");

    expect(table.primaryKeys).toBeUndefined();
    expect(table.columns.map((column) => column.name)).toEqual(["assembly_id", "part_id"]);
  });

  it("makes join columns required", () => {
    expect(buildCreateJoinTableDefinition("a", "b").columns[0]?.options["null"]).toBe(false);
  });

  it("says what a definition implies", () => {
    expect(createTableAndSetFlags(buildCreateTableDefinition("posts"))).toMatchObject({
      hasPrimaryKey: true,
      fromQuery: false,
    });
    expect(
      createTableAndSetFlags(buildCreateTableDefinition("p", { id: false, as: "SELECT 1" })),
    ).toMatchObject({ hasPrimaryKey: false, fromQuery: true });
  });

  /**
   * Passing an adapter-specific option through produces a syntax error in a
   * migration that has already applied half its changes.
   */
  it("drops an option another adapter cannot express", () => {
    const table = buildCreateTableDefinition("posts", { options: "ENGINE=InnoDB" });

    expect(compatibleTableDefinition(table, "mysql").options).toBe("ENGINE=InnoDB");
    expect(compatibleTableDefinition(table, "postgres").options).toBeUndefined();
  });

  it("leaves a definition with no options alone", () => {
    const table = buildCreateTableDefinition("posts");

    expect(compatibleTableDefinition(table, "postgres")).toBe(table);
  });
});

describe("turning a table definition into SQL", () => {
  it("writes the columns", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("title", "varchar", { null: false }));
    });

    expect(schemaCreation().accept(table)).toBe('CREATE TABLE "posts" ("title" varchar NOT NULL)');
  });

  it("quotes an identifier containing a quote", () => {
    const table = buildCreateTableDefinition('we"ird', { id: false });

    expect(schemaCreation().accept(table)).toContain('"we""ird"');
  });

  it("writes a default", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("count", "integer", { default: 0 }));
    });

    expect(schemaCreation().accept(table)).toContain("DEFAULT 0");
  });

  /**
   * `undefined` means "not specified" and `null` means "explicitly NULL" —
   * a different statement, and a different column.
   */
  it("tells an unspecified default from an explicit null", () => {
    expect(optionsIncludeDefault({})).toBe(false);
    expect(optionsIncludeDefault({ default: undefined })).toBe(false);
    expect(optionsIncludeDefault({ default: null })).toBe(true);
  });

  it("writes an explicit null default", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("a", "integer", { default: null }));
    });

    expect(schemaCreation().accept(table)).toContain("DEFAULT NULL");
  });

  it("escapes a quote in a string default", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("a", "varchar", { default: "it's" }));
    });

    expect(schemaCreation().accept(table)).toContain("DEFAULT 'it''s'");
  });

  it("writes a composite primary key as a clause", () => {
    const table = buildCreateTableDefinition("posts", { primaryKey: ["shop_id", "id"] });

    expect(schemaCreation().accept(table)).toContain('PRIMARY KEY ("shop_id", "id")');
  });

  it("does not write a clause for a single one", () => {
    expect(schemaCreation().accept(buildCreateTableDefinition("posts"))).not.toContain(
      "PRIMARY KEY",
    );
  });

  it("writes temporary and if-not-exists", () => {
    const table = buildCreateTableDefinition("posts", { temporary: true, ifNotExists: true });

    expect(schemaCreation().accept(table)).toContain(
      'CREATE TEMPORARY TABLE IF NOT EXISTS "posts"',
    );
  });

  it("writes a table built from a query", () => {
    const table = buildCreateTableDefinition("recent", { id: false, as: "SELECT 1" });

    expect(schemaCreation().accept(table)).toBe('CREATE TABLE "recent" AS SELECT 1');
  });

  it("writes a foreign key", () => {
    const table = buildCreateTableDefinition("comments", { id: false }, (definition) => {
      definition.foreignKeys.push(
        newForeignKeyDefinition("fk_a", "posts", { onDelete: "cascade" }),
      );
    });

    const sql = schemaCreation().accept(table);

    expect(sql).toContain('CONSTRAINT "fk_a" FOREIGN KEY ("post_id") REFERENCES "posts" ("id")');
    expect(sql).toContain("ON DELETE CASCADE");
  });

  /**
   * Every capability check lives in the visitor, so an adapter that cannot
   * express something drops it in one place rather than in each caller.
   */
  it("leaves out what the adapter cannot express", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("a", "integer"));
      definition.checkConstraints.push(newCheckConstraintDefinition("chk", "a > 0"));
      definition.uniqueConstraints.push(newUniqueConstraintDefinition("uq", "a"));
      definition.exclusionConstraints.push(newExclusionConstraintDefinition("ex", "a WITH ="));
    });

    const sqlite = schemaCreation().accept(table);

    expect(sqlite).toContain("CHECK");
    expect(sqlite).not.toContain("EXCLUDE");
    expect(sqlite).not.toContain("UNIQUE");

    const postgres = schemaCreation({ exclusionConstraints: true, uniqueConstraints: true }).accept(
      table,
    );

    expect(postgres).toContain("EXCLUDE");
    expect(postgres).toContain("UNIQUE");
  });

  /**
   * SQLite rejects a table constraint appearing before a column it names, and
   * the ordering bug that produces shows up on that adapter only.
   */
  it("writes columns before constraints", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("price", "integer"));
      definition.checkConstraints.push(newCheckConstraintDefinition("chk", "price > 0"));
      definition.foreignKeys.push(newForeignKeyDefinition("fk", "shops"));
    });

    const sql = schemaCreation().accept(table);

    expect(sql.indexOf('"price" integer')).toBeLessThan(sql.indexOf("FOREIGN KEY"));
    expect(sql.indexOf("FOREIGN KEY")).toBeLessThan(sql.indexOf("CHECK"));
  });
});

describe("turning an alteration into SQL", () => {
  const creation = schemaCreation();

  it("writes each operation in one statement", () => {
    const alter = buildAlterTableDefinition("posts", (at) => {
      at.operations.push(
        { kind: "addColumn", column: newColumnDefinition("a", "integer") },
        { kind: "dropColumn", name: "b" },
      );
    });

    expect(creation.accept(alter)).toBe('ALTER TABLE "posts" ADD "a" integer, DROP COLUMN "b"');
  });

  it("writes a rename", () => {
    const alter = buildAlterTableDefinition("posts", (at) => {
      at.operations.push({ kind: "renameColumn", from: "a", to: "b" });
    });

    expect(creation.accept(alter)).toContain('RENAME COLUMN "a" TO "b"');
  });

  it("writes a nullability change both ways", () => {
    const drop = buildAlterTableDefinition("posts", (at) => {
      at.operations.push({ kind: "changeColumnNull", name: "a", null: true });
    });
    const set = buildAlterTableDefinition("posts", (at) => {
      at.operations.push({ kind: "changeColumnNull", name: "a", null: false });
    });

    expect(creation.accept(drop)).toContain("DROP NOT NULL");
    expect(creation.accept(set)).toContain("SET NOT NULL");
  });

  it("writes a validation", () => {
    const alter = buildAlterTableDefinition("posts", (at) => {
      at.operations.push({ kind: "validateConstraint", name: "chk" });
    });

    expect(creation.accept(alter)).toContain('VALIDATE CONSTRAINT "chk"');
  });
});

describe("a constraint that is not true yet", () => {
  /**
   * `NOT VALID` applies to new rows and leaves the old ones unchecked, so a
   * hundred-million-row table gains a constraint without a long exclusive
   * lock.
   */
  it("marks an unvalidated check", () => {
    expect(checkConstraint(newCheckConstraintDefinition("chk", "a > 0"))).toBe(
      'CONSTRAINT "chk" CHECK (a > 0)',
    );
    expect(
      checkConstraint(newCheckConstraintDefinition("chk", "a > 0", { validate: false })),
    ).toContain("NOT VALID");
  });

  it("marks an unvalidated foreign key", () => {
    const table = buildCreateTableDefinition("c", { id: false }, (definition) => {
      definition.foreignKeys.push(newForeignKeyDefinition("fk", "posts", { validate: false }));
    });

    expect(schemaCreation().accept(table)).toContain("NOT VALID");
  });

  /**
   * The scan the `NOT VALID` add skipped. Without it the constraint has never
   * been checked against the old rows and the planner will not use it — so it
   * looks like a working constraint and is not one.
   */
  it("validates afterwards", () => {
    expect(validateConstraint("posts", "chk")).toBe(
      'ALTER TABLE "posts" VALIDATE CONSTRAINT "chk"',
    );
    expect(validateCheckConstraint("posts", "chk")).toBe(validateConstraint("posts", "chk"));
  });

  it("drops by name whatever the kind", () => {
    expect(removeConstraint("posts", "c")).toBe('ALTER TABLE "posts" DROP CONSTRAINT "c"');
    expect(dropCheckConstraint("posts", "c")).toBe(removeConstraint("posts", "c"));
    expect(dropForeignKey("posts", "c")).toBe(removeConstraint("posts", "c"));
  });

  /**
   * One statement rather than two, because between two the table has no
   * foreign key at all and a write landing in that window inserts a row the
   * re-added key would have refused.
   */
  it("changes a foreign key without a gap", () => {
    const sql = changeForeignKey("comments", "fk_old", newForeignKeyDefinition("fk_new", "posts"));

    expect(sql.startsWith('ALTER TABLE "comments" DROP CONSTRAINT "fk_old", ADD ')).toBe(true);
    expect(sql).toContain('CONSTRAINT "fk_new"');
  });

  it("re-adds it unvalidated, leaving the scan to the caller", () => {
    expect(
      changeForeignKey("comments", "fk_old", newForeignKeyDefinition("fk_new", "posts")),
    ).toContain("NOT VALID");
  });
});

describe("deferring a check to commit", () => {
  it("writes the clause", () => {
    expect(
      uniqueConstraint(newUniqueConstraintDefinition("uq", "a", { deferrable: "deferred" })),
    ).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(
      uniqueConstraint(newUniqueConstraintDefinition("uq", "a", { deferrable: "immediate" })),
    ).toContain("DEFERRABLE INITIALLY IMMEDIATE");
  });

  it("writes it on an exclusion constraint too", () => {
    expect(
      exclusionConstraint(newExclusionConstraintDefinition("ex", "a WITH =", { where: "b" })),
    ).toBe('CONSTRAINT "ex" EXCLUDE USING gist (a WITH =) WHERE (b)');
  });

  /** Building a second index over the same columns doubles the table's write cost. */
  it("adopts an existing index rather than building a second", () => {
    const sql = uniqueConstraint(
      newUniqueConstraintDefinition("uq", "a", { ...usingIndex("index_a") }),
    );

    expect(sql).toBe('CONSTRAINT "uq" UNIQUE USING INDEX "index_a"');
  });

  it("writes nulls-not-distinct", () => {
    expect(
      uniqueConstraint(newUniqueConstraintDefinition("uq", "a", { nullsNotDistinct: true })),
    ).toContain("NULLS NOT DISTINCT");
  });

  it("defers everything or a named few", () => {
    expect(setConstraints("deferred")).toBe("SET CONSTRAINTS ALL DEFERRED");
    expect(setConstraints("immediate", "fk_a", "fk_b")).toBe(
      'SET CONSTRAINTS "fk_a", "fk_b" IMMEDIATE',
    );
  });

  it("refuses a value that is neither", () => {
    expect(() => setConstraints("soon" as never)).toThrow("immediate");
  });
});

describe("indexes", () => {
  it("builds a definition", () => {
    const definition = buildCreateIndexDefinition("posts", "title", { unique: true });

    expect(schemaCreation().accept(definition)).toBe(
      'CREATE UNIQUE INDEX "index_posts_on_title" ON "posts" ("title")',
    );
  });

  it("writes if-not-exists", () => {
    expect(
      schemaCreation().accept(buildCreateIndexDefinition("posts", "title", { ifNotExists: true })),
    ).toContain("IF NOT EXISTS");
  });

  /**
   * `concurrently` is a Postgres word, and a MySQL adapter given it verbatim
   * produces a syntax error partway through a migration.
   */
  it("resolves the algorithm for the adapter", () => {
    expect(
      schemaCreation().accept(
        buildCreateIndexDefinition("posts", "title", { algorithm: "concurrently" }),
      ),
    ).toContain("CONCURRENTLY");

    expect(() =>
      buildCreateIndexDefinition("posts", "title", { algorithm: "concurrently", adapter: "mysql" }),
    ).toThrow("concurrently");
  });

  /** The index is still correct without the clause, just wider than asked for. */
  it("drops a partial clause the adapter cannot express", () => {
    const definition = buildCreateIndexDefinition("posts", "title", { where: "published" });

    expect(schemaCreation().accept(definition)).toContain("WHERE published");
    expect(schemaCreation({ partialIndex: false }).accept(definition)).not.toContain("WHERE");
  });

  it("writes an include clause where there is one", () => {
    const definition = createIndexDefinition(
      addIndexOptions("posts", ["title"], { include: ["body"] }),
    );

    expect(schemaCreation({ indexInclude: true }).accept(definition)).toContain('INCLUDE ("body")');
    expect(schemaCreation().accept(definition)).not.toContain("INCLUDE");
  });

  it("writes indexes inside a create where the adapter allows it", () => {
    const table = buildCreateTableDefinition("posts", { id: false }, (definition) => {
      definition.columns.push(newColumnDefinition("title", "varchar"));
      definition.indexes.push(addIndexOptions("posts", ["title"]));
    });

    expect(schemaCreation({ indexesInCreate: true }).accept(table)).toContain("INDEX");
    expect(schemaCreation().accept(table)).not.toContain("INDEX");
  });

  /**
   * Left in place rather than dropped, so re-enabling does not rebuild it — a
   * bulk load would otherwise be cheap and the restore expensive.
   */
  it("turns an index off and on without dropping it", () => {
    expect(disableIndex("posts", "index_a")).toContain("DISABLE");
    expect(enableIndex("posts", "index_a")).toContain("ENABLE");
    expect(disableIndex("posts", "index_a")).not.toContain("DROP");
  });
});

describe("virtual tables", () => {
  it("creates one", () => {
    expect(createVirtualTable("emails", "fts5", ["sender", "body"])).toBe(
      'CREATE VIRTUAL TABLE IF NOT EXISTS "emails" USING fts5 (sender, body)',
    );
  });

  /** The module and values are recorded so the migration can be reversed. */
  it("drops one, ignoring what it was told for the reverse", () => {
    expect(dropVirtualTable("emails", "fts5", ["sender"])).toBe('DROP TABLE "emails"');
  });

  /**
   * A virtual table appears in the table list like any other, so its DDL is
   * the only thing that distinguishes it — and a plain table answering here
   * would make the drop take real data with it.
   */
  it("does not mistake a plain table for one", () => {
    const tables = [
      { name: "emails", sql: "CREATE VIRTUAL TABLE emails USING fts5(body)" },
      { name: "posts", sql: "CREATE TABLE posts (id integer)" },
    ];

    expect(virtualTableExists("emails", tables)).toBe(true);
    expect(virtualTableExists("posts", tables)).toBe(false);
    expect(virtualTableExists("absent", tables)).toBe(false);
  });

  it("does not mistake a table it has no DDL for", () => {
    expect(virtualTableExists("emails", [{ name: "emails" }])).toBe(false);
  });
});

describe("references", () => {
  /**
   * A `*_type` column left behind reads as one somebody forgot rather than one
   * that used to mean something.
   */
  it("removes the type column too when it was polymorphic", () => {
    expect(removeReferences("comments", "author", { polymorphic: true })).toEqual([
      'DROP INDEX "index_comments_on_author"',
      'ALTER TABLE "comments" DROP COLUMN "author_id"',
      'ALTER TABLE "comments" DROP COLUMN "author_type"',
    ]);
  });

  it("removes only the id column otherwise", () => {
    expect(removeReferences("comments", "post")).toHaveLength(2);
  });

  it("leaves an index alone when there was none", () => {
    expect(removeReferences("comments", "post", { index: false })).toEqual([
      'ALTER TABLE "comments" DROP COLUMN "post_id"',
    ]);
  });
});

describe("fixture referential integrity", () => {
  /**
   * Fixtures are inserted with integrity disabled because they reference each
   * other and no insertion order satisfies a cycle, so a label nothing defines
   * would otherwise surface as a null association in whichever test followed.
   */
  it("says nothing when everything resolved", () => {
    expect(() => checkAllForeignKeysValid([])).not.toThrow();
  });

  it("names the tables when something did not", () => {
    expect(() => checkAllForeignKeysValid([{ table: "comments" }, { table: "comments" }])).toThrow(
      "comments",
    );
  });

  it("names each table once", () => {
    let message = "";

    try {
      checkAllForeignKeysValid([{ table: "a" }, { table: "a" }, { table: "b" }]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("fixture data: a, b.");
  });
});
