/**
 * Keeping a schema and a database in step, ported from
 * `activerecord/test/cases/tasks/database_tasks_test.rb`,
 * `activerecord/test/cases/migration_test.rb` and the protected-environment
 * cases in `activerecord/test/cases/tasks/database_tasks_test.rb`.
 *
 * The failure this exists for reports nothing: a suite run against a stale
 * schema is green, because every test that does not touch the new column
 * passes. So most of these are about detecting that, and about refusing to
 * empty a database outside the environments that expect it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DISPOSABLE_ENVIRONMENTS,
  INTERNAL_TABLES,
  NoSeedLoader,
  PendingMigrations,
  ProtectedEnvironment,
  cacheDumpFilename,
  checkAllPending,
  checkProtectedEnvironment,
  compatibleWith,
  dbDir,
  dumpVersion,
  dumpableTables,
  ignoredTables,
  loadSchemaIfPending,
  loadSeed,
  loadVersion,
  maintainTestSchema,
  pendingMigrationVersions,
  purgeStatements,
  schemaFormat,
  schemaUpToDate,
  seedLoader,
  setSeedLoader,
  structureDumpPath,
  truncatableTables,
  truncateAll,
} from "../src/schema_tasks.js";

afterEach(() => {
  setSeedLoader(undefined);
});

describe("what the database still has to apply", () => {
  it("finds nothing when everything is applied", () => {
    expect(pendingMigrationVersions({ applied: ["1", "2"], available: ["1", "2"] })).toEqual([]);
    expect(schemaUpToDate({ applied: ["1", "2"], available: ["1", "2"] })).toBe(true);
  });

  it("finds one that is missing", () => {
    expect(pendingMigrationVersions({ applied: ["1"], available: ["1", "2"] })).toEqual(["2"]);
  });

  /**
   * A set difference, not a comparison of maxima. Two branches produce two
   * migrations, and whoever merges second has one with a lower timestamp than
   * something already applied — comparing maxima calls that database current
   * and it is missing a table.
   */
  it("finds one with a timestamp below the highest applied", () => {
    expect(
      pendingMigrationVersions({
        applied: ["20260301", "20260401"],
        available: ["20260301", "20260315", "20260401"],
      }),
    ).toEqual(["20260315"]);
  });

  it("ignores a version applied but no longer on disk", () => {
    expect(pendingMigrationVersions({ applied: ["1", "2"], available: ["1"] })).toEqual([]);
  });

  it("raises with the versions", () => {
    expect(() => checkAllPending({ applied: [], available: ["1", "2"] })).toThrow(
      PendingMigrations,
    );
    expect(() => checkAllPending({ applied: [], available: ["1", "2"] })).toThrow("1, 2");
  });

  it("says why it matters", () => {
    expect(() => checkAllPending({ applied: [], available: ["1"] })).toThrow("production");
  });

  it("raises nothing when current", () => {
    expect(() => checkAllPending({ applied: ["1"], available: ["1"] })).not.toThrow();
  });
});

describe("keeping the test schema current", () => {
  /** Reloading rather than warning: a warning in a test run scrolls past. */
  it("reloads when something is pending", () => {
    expect(maintainTestSchema({ applied: [], available: ["1"] })).toBe("load");
  });

  it("does nothing when current", () => {
    expect(maintainTestSchema({ applied: ["1"], available: ["1"] })).toBe("none");
  });

  it("creates the database first when there is none", () => {
    expect(maintainTestSchema({ applied: [], available: [] }, { databaseExists: false })).toBe(
      "create-and-load",
    );
  });

  it("reports whether anything has to happen", () => {
    expect(loadSchemaIfPending({ applied: [], available: ["1"] })).toBe(true);
    expect(loadSchemaIfPending({ applied: ["1"], available: ["1"] })).toBe(false);
  });
});

describe("where a schema is written", () => {
  /**
   * Not a preference: a schema with a partial index, a trigger or a check
   * constraint holding a function is silently incomplete in the portable
   * format.
   */
  it("defaults to the portable format", () => {
    expect(schemaFormat(undefined)).toBe("ruby");
    expect(schemaFormat("ruby")).toBe("ruby");
  });

  it("takes sql when asked", () => {
    expect(schemaFormat("sql")).toBe("sql");
  });

  it("names the schema directory", () => {
    expect(dbDir()).toBe("./db");
    expect(dbDir("/srv/app/")).toBe("/srv/app/db");
  });

  it("names the cache file", () => {
    expect(cacheDumpFilename("primary")).toBe("./db/schema_cache.yml");
    expect(cacheDumpFilename("animals")).toBe("./db/animals_schema_cache.yml");
  });

  it("names the structure file", () => {
    expect(structureDumpPath("primary")).toBe("./db/structure.sql");
    expect(structureDumpPath("animals")).toBe("./db/animals_structure.sql");
  });
});

describe("what a dump leaves out", () => {
  /**
   * The bookkeeping holds *this* database's history. Dumping it and loading it
   * elsewhere tells the new database it has run every migration, and the next
   * `db:migrate` then does nothing.
   */
  it("leaves out the bookkeeping tables", () => {
    expect(ignoredTables()).toEqual([...INTERNAL_TABLES]);
    expect(dumpableTables(["posts", "schema_migrations", "ar_internal_metadata"])).toEqual([
      "posts",
    ]);
  });

  it("leaves out anything else it is told to", () => {
    expect(dumpableTables(["posts", "cache_entries"], ["cache_entries"])).toEqual(["posts"]);
  });

  it("sorts what is left, so two dumps of one schema match", () => {
    expect(dumpableTables(["users", "posts"])).toEqual(["posts", "users"]);
  });
});

describe("emptying a database", () => {
  it("allows it in test", () => {
    expect(() => checkProtectedEnvironment("purge", "test")).not.toThrow();
    expect(DISPOSABLE_ENVIRONMENTS).toEqual(["test"]);
  });

  /** Routine in test, unrecoverable anywhere else. */
  it("refuses it in production", () => {
    expect(() => checkProtectedEnvironment("purge", "production")).toThrow(ProtectedEnvironment);
  });

  it("refuses it in development too", () => {
    expect(() => checkProtectedEnvironment("purge", "development")).toThrow(ProtectedEnvironment);
  });

  /**
   * The override lives in the environment rather than in an argument, so it
   * cannot be committed: an escape hatch in code is one somebody adds during
   * an incident and nobody removes.
   */
  it("allows it with the environment override", () => {
    expect(() =>
      checkProtectedEnvironment("purge", "production", {
        DISABLE_DATABASE_ENVIRONMENT_CHECK: "1",
      }),
    ).not.toThrow();
  });

  /**
   * Truncating `schema_migrations` would make the database look unmigrated,
   * and the next run would apply every migration to a schema that has them.
   */
  it("truncates everything but the bookkeeping", () => {
    expect(truncatableTables(["posts", "schema_migrations"])).toEqual(["posts"]);
  });

  it("builds the truncate statements", () => {
    expect(truncateAll(["posts"], "test")).toEqual(['TRUNCATE TABLE "posts"']);
  });

  it("refuses to build them outside test", () => {
    expect(() => truncateAll(["posts"], "production")).toThrow(ProtectedEnvironment);
  });

  /** A purge is followed by a schema load, so the bookkeeping goes too. */
  it("drops the bookkeeping as well", () => {
    expect(purgeStatements(["posts", "schema_migrations"], "test")).toHaveLength(2);
  });

  it("refuses to purge outside test", () => {
    expect(() => purgeStatements(["posts"], "production")).toThrow(ProtectedEnvironment);
  });

  it("quotes the way the adapter asks", () => {
    expect(truncateAll(["posts"], "test", { quote: (name) => `\`${name}\`` })[0]).toContain(
      "`posts`",
    );
  });
});

describe("seeds", () => {
  it("has no loader to start with", () => {
    expect(seedLoader()).toBeUndefined();
  });

  it("runs the configured loader", async () => {
    let ran = false;
    setSeedLoader({
      load: () => {
        ran = true;
      },
    });

    await loadSeed();

    expect(ran).toBe(true);
  });

  /**
   * Succeeding silently makes `db:seed` against an empty database look
   * identical to seeds that ran and inserted nothing.
   */
  it("refuses when nothing is configured", async () => {
    await expect(loadSeed()).rejects.toThrow(NoSeedLoader);
  });
});

describe("the version a dump records", () => {
  /**
   * The highest applied, which is what makes `db:schema:load` followed by
   * `db:migrate` a no-op rather than a re-run of everything.
   */
  it("is the highest applied version", () => {
    expect(dumpVersion(["20260101", "20260301", "20260201"])).toBe("20260301");
  });

  it("is nothing for a database that has applied nothing", () => {
    expect(dumpVersion([])).toBeUndefined();
  });

  it("reads one back out of a dump", () => {
    expect(loadVersion("ActiveRecord::Schema.define(version: 20260301) do")).toBe("20260301");
    expect(loadVersion('define(version: "20260301")')).toBe("20260301");
  });

  it("reads nothing from a dump with no version", () => {
    expect(loadVersion("nothing here")).toBeUndefined();
  });

  /** A partial schema still starts, which is worse than refusing to load. */
  it("refuses a dump from a newer writer", () => {
    expect(compatibleWith(8, 7)).toBe(false);
    expect(compatibleWith(7, 7)).toBe(true);
    expect(compatibleWith(6, 7)).toBe(true);
  });
});
