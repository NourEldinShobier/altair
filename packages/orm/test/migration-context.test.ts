/**
 * Which migrations have run and which have not, ported from
 * `activerecord/test/cases/migration_test.rb` and
 * `migration/pending_migrations_test.rb`.
 *
 * The case worth having is the out-of-order one. Two developers working the
 * same afternoon produce 20260830120000 and 20260830113000, merged in either
 * order — and anything that tracks "the current version" as a single number
 * decides the lower one has already run and skips it forever.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { IrreversibleMigration } from "../src/command-recorder.js";
import {
  MigrationContext,
  SchemaMigration,
  UnknownMigrationVersion,
  checkVersion,
  formatVersion,
  normalizeMigrationNumber,
  validVersionFormat,
} from "../src/migration-context.js";
import type { Migration } from "../src/migration-context.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;
/** Which migrations actually ran, in order. */
let ran: string[];

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  ran = [];
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

function migration(version: string, name: string, reversible = true): Migration {
  return {
    version,
    name,
    up: async (schema: SchemaStatements) => {
      ran.push(`up ${version}`);
      await schema.createTable(`t${version}`, (t) => t.string("x"));
    },
    ...(reversible
      ? {
          down: async (schema: SchemaStatements) => {
            ran.push(`down ${version}`);
            await schema.dropTable(`t${version}`);
          },
        }
      : {}),
  };
}

function context(...migrations: Migration[]): MigrationContext {
  return new MigrationContext(migrations, connection);
}

describe("versions", () => {
  it("accepts digits", () => {
    expect(validVersionFormat("20260830120000")).toBe(true);
    expect(validVersionFormat("1")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(validVersionFormat("20260830_add_posts")).toBe(false);
    expect(validVersionFormat("")).toBe(false);
    expect(validVersionFormat("12.5")).toBe(false);
  });

  /** Otherwise `830120000` and `20260830120000` sort by length rather than time. */
  it("pads a short one so it sorts by time", () => {
    expect(normalizeMigrationNumber("1")).toBe("00000000000001");
    expect(normalizeMigrationNumber("20260830120000")).toBe("20260830120000");
  });

  it("sorts padded versions correctly", () => {
    const sorted = ["20260830120000", "830120000"].map(normalizeMigrationNumber).sort();

    expect(sorted[0]).toBe(normalizeMigrationNumber("830120000"));
  });

  it("reads a version back as a date", () => {
    expect(formatVersion("20260830120000")).toBe("2026-08-30 12:00:00");
  });

  /**
   * Padding before formatting would turn this into `0000-00-00 00:00:01`,
   * which is not a date and is worse than the number it came from. A version
   * that is already fourteen digits is timestamp-shaped by definition and does
   * get formatted, nonsense date or not — there is nothing to tell it apart
   * from a real one.
   */
  it("leaves something that is not a timestamp alone", () => {
    expect(formatVersion("1")).toBe("1");
    expect(formatVersion("9")).toBe("9");
  });

  it("checks and normalizes in one step", () => {
    expect(checkVersion("1")).toBe("00000000000001");
  });

  it("refuses a version that is not one", () => {
    expect(() => checkVersion("not-a-version")).toThrow("digits only");
  });
});

describe("the schema_migrations table", () => {
  it("reports nothing before it exists", async () => {
    expect(await new SchemaMigration(connection).migrated()).toEqual(new Set());
  });

  it("records a version", async () => {
    const table = new SchemaMigration(connection);
    await table.createTable();
    await table.create("20260830120000");

    expect(await table.migrated()).toEqual(new Set(["20260830120000"]));
  });

  it("can be created twice without complaint", async () => {
    const table = new SchemaMigration(connection);
    await table.createTable();

    await expect(table.createTable()).resolves.toBeUndefined();
  });

  it("sorts what it reports", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["3", "1", "2"]);

    expect(await table.normalizedVersions()).toEqual([
      normalizeMigrationNumber("1"),
      normalizeMigrationNumber("2"),
      normalizeMigrationNumber("3"),
    ]);
  });

  it("offers them as numbers", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["2", "1"]);

    expect(await table.integerVersions()).toEqual([1, 2]);
  });

  it("deletes one", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["1", "2"]);
    await table.deleteVersion("1");

    expect(await table.normalizedVersions()).toEqual([normalizeMigrationNumber("2")]);
  });

  it("deletes all of them", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["1", "2"]);
    await table.deleteAllVersions();

    expect(await table.migrated()).toEqual(new Set());
  });

  it("reports the highest for a schema header", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["1", "3", "2"]);

    expect(await table.currentVersion()).toBe(normalizeMigrationNumber("3"));
  });

  it("reports none when nothing has run", async () => {
    expect(await new SchemaMigration(connection).currentVersion()).toBeUndefined();
  });

  it("writes the lines a dump carries", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["1"]);

    expect((await table.dumpSchemaMigrations())[0]).toContain(
      `VALUES ('${normalizeMigrationNumber("1")}')`,
    );
  });

  it("offers the bare versions for a dump too", async () => {
    const table = new SchemaMigration(connection);
    await table.loadSchemaMigrations(["1"]);

    expect(await table.dumpSchemaVersions()).toEqual([normalizeMigrationNumber("1")]);
  });
});

describe("what is pending", () => {
  it("is everything when nothing has run", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));

    expect((await at.pending()).map((each) => each.version)).toEqual(["1", "2"]);
    expect(await at.needsMigration()).toBe(true);
  });

  it("is nothing once everything has", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.migrateAll();

    expect(await at.pending()).toEqual([]);
    expect(await at.needsMigration()).toBe(false);
  });

  /**
   * The one that matters. A lower version merged after a higher one has to
   * still run — anything comparing against a maximum skips it forever.
   */
  it("still reports one whose version is lower than an applied one", async () => {
    const later = migration("20260830120000", "later");
    const earlier = migration("20260830113000", "earlier");

    await context(later).migrateAll();

    const at = context(later, earlier);

    expect((await at.pending()).map((each) => each.name)).toEqual(["earlier"]);
  });

  it("runs it when asked", async () => {
    const later = migration("20260830120000", "later");
    const earlier = migration("20260830113000", "earlier");
    await context(later).migrateAll();
    ran = [];

    await context(later, earlier).migrateAll();

    expect(ran).toEqual(["up 20260830113000"]);
  });

  it("orders them oldest first", async () => {
    const at = context(migration("3", "c"), migration("1", "a"), migration("2", "b"));

    expect((await at.pending()).map((each) => each.version)).toEqual(["1", "2", "3"]);
  });
});

describe("migrating", () => {
  it("runs each one", async () => {
    await context(migration("1", "a"), migration("2", "b")).migrateAll();

    expect(ran).toEqual(["up 1", "up 2"]);
  });

  it("records each as it goes", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.migrateAll();

    expect(await at.schemaMigration.normalizedVersions()).toEqual([
      normalizeMigrationNumber("1"),
      normalizeMigrationNumber("2"),
    ]);
  });

  it("reports what it ran", async () => {
    const at = context(migration("1", "a"));

    expect((await at.migrateAll()).map((each) => each.version)).toEqual(["1"]);
  });

  it("does nothing the second time", async () => {
    const at = context(migration("1", "a"));
    await at.migrateAll();
    ran = [];

    expect(await at.migrateAll()).toEqual([]);
    expect(ran).toEqual([]);
  });

  /**
   * A run that fails halfway has genuinely applied what came before it, and a
   * table that does not say so makes the next run try them again.
   */
  it("keeps the record of the ones that succeeded when a later one throws", async () => {
    const failing: Migration = {
      version: "2",
      name: "boom",
      up: async () => {
        throw new Error("boom");
      },
    };
    const at = context(migration("1", "a"), failing);

    await expect(at.migrateAll()).rejects.toThrow("boom");

    expect(await at.schemaMigration.normalizedVersions()).toEqual([normalizeMigrationNumber("1")]);
  });

  it("runs one by version", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.up("2");

    expect(ran).toEqual(["up 2"]);
    expect(await at.schemaMigration.migrated()).toEqual(new Set([normalizeMigrationNumber("2")]));
  });

  it("refuses a version it does not have", async () => {
    await expect(context(migration("1", "a")).up("999")).rejects.toThrow(UnknownMigrationVersion);
  });

  it("finds one by version", () => {
    expect(context(migration("1", "a")).migrationClass("1").name).toBe("a");
  });

  it("finds one by an unpadded version", () => {
    expect(context(migration("00000000000001", "a")).migrationClass("1").name).toBe("a");
  });
});

describe("rolling back", () => {
  it("undoes the last one", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.migrateAll();
    ran = [];

    await at.rollback();

    expect(ran).toEqual(["down 2"]);
    expect(await at.schemaMigration.normalizedVersions()).toEqual([normalizeMigrationNumber("1")]);
  });

  it("undoes several", async () => {
    const at = context(migration("1", "a"), migration("2", "b"), migration("3", "c"));
    await at.migrateAll();
    ran = [];

    await at.rollback(2);

    expect(ran).toEqual(["down 3", "down 2"]);
  });

  it("undoes one by version", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.migrateAll();
    ran = [];

    await at.down("1");

    expect(ran).toEqual(["down 1"]);
  });

  /**
   * Dropping the row would say the migration never ran, and the next deploy
   * would apply it a second time on top of itself.
   */
  it("refuses one that cannot be undone, and keeps its version", async () => {
    const at = context(migration("1", "a", false));
    await at.migrateAll();

    await expect(at.down("1")).rejects.toThrow(IrreversibleMigration);
    expect(await at.schemaMigration.migrated()).toEqual(new Set([normalizeMigrationNumber("1")]));
  });

  it("names the migration that cannot be undone", async () => {
    const at = context(migration("1", "a", false));
    await at.migrateAll();

    await expect(at.down("1")).rejects.toThrow("1");
  });

  it("makes what it undid pending again", async () => {
    const at = context(migration("1", "a"));
    await at.migrateAll();
    await at.rollback();

    expect(await at.needsMigration()).toBe(true);
  });
});

describe("status", () => {
  it("says which are up and which are down", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.up("1");

    expect(await at.migrateStatus()).toEqual([
      { status: "up", version: normalizeMigrationNumber("1"), name: "a" },
      { status: "down", version: normalizeMigrationNumber("2"), name: "b" },
    ]);
  });

  it("orders by version", async () => {
    const at = context(migration("2", "b"), migration("1", "a"));

    expect((await at.migrateStatus()).map((each) => each.name)).toEqual(["a", "b"]);
  });

  /**
   * Worth showing rather than hiding: it means the file was deleted or a
   * branch was switched, and the schema now has changes nothing in the tree
   * accounts for.
   */
  it("shows a version with no migration to match it", async () => {
    const at = context(migration("1", "a"));
    await at.schemaMigration.loadSchemaMigrations(["1", "999"]);

    const status = await at.migrateStatus();

    expect(status).toHaveLength(2);
    expect(status[1]?.name).toContain("NO FILE");
    expect(status[1]?.status).toBe("up");
  });

  it("is empty when there is nothing at all", async () => {
    expect(await context().migrateStatus()).toEqual([]);
  });
});

describe("the context itself", () => {
  it("has a default path", () => {
    expect(context().migrationsPaths).toEqual(["db/migrate"]);
  });

  it("takes the paths it was given", () => {
    expect(
      new MigrationContext([], connection, ["db/migrate", "engines/x/db"]).migrationsPaths,
    ).toEqual(["db/migrate", "engines/x/db"]);
  });

  it("reports every version it knows", () => {
    expect(context(migration("2", "b"), migration("1", "a")).versions()).toEqual([
      normalizeMigrationNumber("1"),
      normalizeMigrationNumber("2"),
    ]);
  });

  it("reports the current version through the table", async () => {
    const at = context(migration("1", "a"), migration("2", "b"));
    await at.migrateAll();

    expect(await at.currentVersion()).toBe(normalizeMigrationNumber("2"));
  });

  it("reports what has run", async () => {
    const at = context(migration("1", "a"));
    await at.migrateAll();

    expect(await at.loadMigrated()).toEqual(new Set([normalizeMigrationNumber("1")]));
  });
});
