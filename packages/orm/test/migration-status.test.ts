/**
 * Migration status, ported from `activerecord/test/cases/migrator_test.rb`
 * and the `db:migrate:status` cases in `migration_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Migrator, PendingMigrationError, setConnection, type Migration } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;

const migrations: Migration[] = [
  {
    version: "20260101000001",
    name: "CreateWidgets",
    up: async (schema) => {
      await schema.createTable("widgets", (t) => {
        t.string("name");
      });
    },
    down: async (schema) => {
      await schema.dropTable("widgets");
    },
  },
  {
    version: "20260101000002",
    name: "AddSizeToWidgets",
    up: async (schema) => {
      await schema.addColumn("widgets", "size", "integer");
    },
    down: async (schema) => {
      await schema.removeColumn("widgets", "size");
    },
  },
];

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("before anything has run", () => {
  it("reports everything as pending", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(await migrator.pendingMigrations()).toHaveLength(2);
    expect(await migrator.needsMigration()).toBe(true);
  });

  it("names the pending versions", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(await migrator.pendingMigrationVersions()).toEqual(["20260101000001", "20260101000002"]);
  });

  it("has no current version", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(await migrator.currentVersion()).toBeUndefined();
  });

  it("knows what it is aiming at", () => {
    const migrator = new Migrator(connection, migrations);

    expect(migrator.targetVersion()).toBe("20260101000002");
  });

  it("reports both as down", async () => {
    const migrator = new Migrator(connection, migrations);
    const status = await migrator.migrationsStatus();

    expect(status.map((one) => one.status)).toEqual(["down", "down"]);
    expect(status[0]?.name).toBe("CreateWidgets");
  });
});

describe("after running them", () => {
  it("reports nothing pending", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    expect(await migrator.needsMigration()).toBe(false);
    expect(await migrator.pendingMigrations()).toEqual([]);
  });

  it("records the versions", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    expect(await migrator.getAllVersions()).toEqual(["20260101000001", "20260101000002"]);
  });

  it("reports the highest as current", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    expect(await migrator.currentVersion()).toBe("20260101000002");
  });

  it("reports both as up", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    expect((await migrator.migrationsStatus()).map((one) => one.status)).toEqual(["up", "up"]);
  });

  it("reports a partial run correctly", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();
    await migrator.down(1);

    const status = await migrator.migrationsStatus();

    expect(status.map((one) => one.status)).toEqual(["up", "down"]);
    expect(await migrator.needsMigration()).toBe(true);
  });
});

describe("checkPending", () => {
  /** What a development server calls before serving a request. */
  it("throws when something is outstanding", async () => {
    const migrator = new Migrator(connection, migrations);

    await expect(migrator.checkPending()).rejects.toThrow(PendingMigrationError);
  });

  /** The first question is always which ones. */
  it("names the versions", async () => {
    const migrator = new Migrator(connection, migrations);

    await expect(migrator.checkPending()).rejects.toThrow(/20260101000001/);
  });

  it("passes once they have run", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    await expect(migrator.checkPending()).resolves.toBeUndefined();
  });

  it("carries the versions on the error", async () => {
    const migrator = new Migrator(connection, migrations);

    try {
      await migrator.checkPending();
      expect.unreachable();
    } catch (error) {
      expect((error as PendingMigrationError).versions).toEqual([
        "20260101000001",
        "20260101000002",
      ]);
    }
  });
});

describe("a version with no file", () => {
  /**
   * The interesting case: the branch that added the migration was reverted
   * while the database kept the row, so a rollback has nothing to undo.
   */
  it("still appears in the status", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    const orphaned = new Migrator(connection, [migrations[0] as Migration]);
    const status = await orphaned.migrationsStatus();

    expect(status).toHaveLength(2);
    expect(status[1]?.name).toBe("*** NO FILE ***");
    expect(status[1]?.status).toBe("up");
  });

  it("does not count as pending", async () => {
    const migrator = new Migrator(connection, migrations);
    await migrator.up();

    const orphaned = new Migrator(connection, [migrations[0] as Migration]);

    expect(await orphaned.needsMigration()).toBe(false);
  });
});
