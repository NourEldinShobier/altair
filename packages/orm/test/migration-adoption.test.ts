/**
 * Recording migrations without running them, and refusing to carry on while
 * any are outstanding. Ported from the `assume_migrated_upto_version` and
 * `check_all_pending!` cases in `activerecord/test/cases/migrator_test.rb`.
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
  {
    version: "20260101000003",
    name: "AddColourToWidgets",
    up: async (schema) => {
      await schema.addColumn("widgets", "colour", "string");
    },
    down: async (schema) => {
      await schema.removeColumn("widgets", "colour");
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

describe("the bookkeeping tables", () => {
  it("names the one recording what has run", () => {
    expect(new Migrator(connection, migrations).schemaMigrationTable).toBe("schema_migrations");
  });

  it("names the one recording the environment", () => {
    expect(new Migrator(connection, migrations).internalMetadataTable).toBe("ar_internal_metadata");
  });
});

describe("createVersion", () => {
  it("records a version without running anything", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.createVersion("20260101000001");

    expect(await migrator.appliedVersions()).toEqual(["20260101000001"]);
  });

  it("does not create the table the migration would have", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.createVersion("20260101000001");

    expect(await migrator.schema.tableExists("widgets")).toBe(false);
  });

  /** So an idempotent setup script does not have to catch a key violation. */
  it("is quiet about recording one twice", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.createVersion("20260101000001");
    await migrator.createVersion("20260101000001");

    expect(await migrator.appliedVersions()).toEqual(["20260101000001"]);
  });

  it("records several", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.createVersions(["20260101000001", "20260101000002"]);

    expect(await migrator.appliedVersions()).toEqual(["20260101000001", "20260101000002"]);
  });
});

describe("assumeMigratedUptoVersion", () => {
  /**
   * What db:schema:load does after loading a dump: the tables are already
   * there, so the migrations that would create them must not run — but the
   * ones after must.
   */
  it("marks everything up to and including a version", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.assumeMigratedUptoVersion("20260101000002");

    expect(await migrator.appliedVersions()).toEqual(["20260101000001", "20260101000002"]);
  });

  it("leaves later ones outstanding", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.assumeMigratedUptoVersion("20260101000002");

    expect(await migrator.pendingMigrationVersions()).toEqual(["20260101000003"]);
  });

  /**
   * A row per migration rather than one high-water mark, because a rollback
   * needs a row per migration to know what to undo.
   */
  it("writes a row for each rather than one for the highest", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.assumeMigratedUptoVersion("20260101000003");

    expect(await migrator.appliedVersions()).toHaveLength(3);
  });

  /** A dump records its schema version, and the file may have been squashed. */
  it("records a version no migration file matches", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.assumeMigratedUptoVersion("20259999999999");

    expect(await migrator.appliedVersions()).toContain("20259999999999");
  });

  it("says what it recorded", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(await migrator.assumeMigratedUptoVersion("20260101000001")).toEqual(["20260101000001"]);
  });

  it("leaves nothing pending when told the last one", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.assumeMigratedUptoVersion("20260101000003");

    expect(await migrator.needsMigration()).toBe(false);
  });
});

describe("checkAllPending", () => {
  /**
   * A deploy where the code shipped and the migration did not produces "no
   * such column" from deep in a view — an error naming neither the migration
   * nor the deploy. This says it once, at the front.
   */
  it("throws while anything is outstanding", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(migrator.checkAllPending()).rejects.toThrow(PendingMigrationError);
  });

  it("names the versions in the message", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(migrator.checkAllPending()).rejects.toThrow("20260101000001");
  });

  it("is quiet when everything has run", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.up();

    expect(await migrator.checkAllPending()).toBeUndefined();
  });

  it("still throws when only the last is outstanding", async () => {
    const migrator = new Migrator(connection, migrations);

    await migrator.assumeMigratedUptoVersion("20260101000002");

    expect(migrator.checkAllPending()).rejects.toThrow("20260101000003");
  });

  it("answers the same under its other name", async () => {
    const migrator = new Migrator(connection, migrations);

    expect(migrator.checkPendingMigrations()).rejects.toThrow(PendingMigrationError);
  });

  it("is quiet for a migrator with no migrations at all", async () => {
    expect(await new Migrator(connection, []).checkAllPending()).toBeUndefined();
  });
});

describe("checkTargetVersion", () => {
  it("accepts a version it knows", () => {
    expect(() => {
      new Migrator(connection, migrations).checkTargetVersion("20260101000002");
    }).not.toThrow();
  });

  /**
   * The most destructive way a typo can be read: migrating to a version that
   * matches nothing rolls the database back past every migration and reports
   * success.
   */
  it("refuses one it does not", () => {
    expect(() => {
      new Migrator(connection, migrations).checkTargetVersion("20260101000009");
    }).toThrow("Unknown migration version");
  });

  it("lists what it does know", () => {
    expect(() => {
      new Migrator(connection, migrations).checkTargetVersion("nope");
    }).toThrow("20260101000001");
  });

  it("says so plainly when it knows none", () => {
    expect(() => {
      new Migrator(connection, []).checkTargetVersion("20260101000001");
    }).toThrow("none");
  });
});

describe("currentMigration", () => {
  it("finds the migration a version names", () => {
    expect(new Migrator(connection, migrations).currentMigration("20260101000002")?.name).toBe(
      "AddSizeToWidgets",
    );
  });

  it("gives undefined for a version it has no file for", () => {
    expect(new Migrator(connection, migrations).currentMigration("nope")).toBeUndefined();
  });
});
