/**
 * The `db:*` tasks, ported from
 * `activerecord/test/cases/tasks/database_tasks_test.rb` and the multi-database
 * cases in `activerecord/test/cases/tasks/*_rake_test.rb`.
 *
 * An application with more than one database has two of everything, so most of
 * these are about which databases a task acts on — a task acting on one too
 * few is a missing column that surfaces much later, and one too many is a
 * destroyed database.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { DatabaseConfiguration } from "../src/database-configurations.js";
import {
  type TaskRunner,
  createAll,
  createAndLoadSchema,
  createCurrent,
  dbconsole,
  dropAll,
  dropCurrent,
  dumpAll,
  forCurrentEnv,
  forName,
  loadSchemaCurrent,
  migrationContext,
  prepareAll,
  purgeAll,
  purgeCurrent,
  raiseForMultiDb,
  recreateDatabase,
  registerTask,
  resetTasks,
  schemaSearchPath,
  structureDump,
  structureLoad,
  taskFor,
} from "../src/database-tasks.js";

afterEach(() => {
  resetTasks();
});

function config(overrides: Partial<DatabaseConfiguration> = {}): DatabaseConfiguration {
  return {
    env: "test",
    name: "primary",
    adapter: "postgres",
    database: "app_test",
    ...overrides,
  };
}

function runner(): TaskRunner & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    create: (each) => void calls.push(`create:${each.name}`),
    drop: (each) => void calls.push(`drop:${each.name}`),
    purge: (each) => void calls.push(`purge:${each.name}`),
    loadSchema: (each) => void calls.push(`load:${each.name}`),
    dumpSchema: (each) => void calls.push(`dump:${each.name}`),
  };
}

describe("which databases a task acts on", () => {
  const configs = [
    config(),
    config({ name: "animals" }),
    config({ name: "replica", replica: true }),
    config({ name: "warehouse", databaseTasks: false }),
    config({ env: "production", name: "primary" }),
  ];

  /**
   * A replica is the same physical database as its primary under another
   * connection, so acting on it does the work twice — and `purge` twice is one
   * destroyed database and one destroyed database that was already empty.
   */
  it("leaves replicas out", () => {
    expect(forCurrentEnv(configs, "test").map((each) => each.name)).not.toContain("replica");
  });

  /** For a database the application connects to and does not own. */
  it("leaves out anything with database tasks turned off", () => {
    expect(forCurrentEnv(configs, "test").map((each) => each.name)).not.toContain("warehouse");
  });

  it("takes only this environment", () => {
    expect(forCurrentEnv(configs, "test").map((each) => each.name)).toEqual(["primary", "animals"]);
  });

  it("finds one by name", () => {
    expect(forName(configs, "test", "animals").name).toBe("animals");
  });

  it("says what is configured when a name is wrong", () => {
    expect(() => forName(configs, "test", "absent")).toThrow("primary, animals");
  });

  /**
   * Guessing "the first one" would act on one database and leave the others
   * behind, which surfaces as a missing column somewhere unrelated.
   */
  it("refuses an unnamed task against several databases", () => {
    expect(() => raiseForMultiDb(forCurrentEnv(configs, "test"), "db:migrate")).toThrow(
      "which database",
    );
  });

  it("allows an unnamed task against one", () => {
    expect(() => raiseForMultiDb([config()], "db:migrate")).not.toThrow();
  });
});

describe("creating", () => {
  const configs = [config(), config({ name: "animals" })];

  it("creates every database for the environment", async () => {
    const each = runner();

    expect(await createAll(each, configs, "test")).toEqual({
      created: ["primary", "animals"],
      existing: [],
    });
  });

  /**
   * Running `db:create` twice is the normal case, and an application with two
   * databases where one exists would otherwise be unable to create the other
   * without dropping the first.
   */
  it("keeps going past one that already exists", async () => {
    const each: TaskRunner = {
      ...runner(),
      create: (candidate) => {
        if (candidate.name === "primary") throw new Error("database already exists");
      },
    };

    expect(await createAll(each, configs, "test")).toEqual({
      created: ["animals"],
      existing: ["primary"],
    });
  });

  it("does not swallow another failure", async () => {
    const each: TaskRunner = {
      ...runner(),
      create: () => {
        throw new Error("permission denied");
      },
    };

    await expect(createAll(each, configs, "test")).rejects.toThrow("permission denied");
  });

  it("creates one by name", async () => {
    const each = runner();

    expect(await createCurrent(each, configs, "test", "animals")).toBe("animals");
    expect(each.calls).toEqual(["create:animals"]);
  });

  it("refuses an unnamed create against two", async () => {
    await expect(createCurrent(runner(), configs, "test")).rejects.toThrow("which database");
  });

  it("creates the only one when there is only one", async () => {
    expect(await createCurrent(runner(), [config()], "test")).toBe("primary");
  });
});

describe("destroying", () => {
  const configs = [config(), config({ name: "animals" })];

  it("drops every database", async () => {
    const each = runner();

    expect(await dropAll(each, configs, "test")).toEqual(["primary", "animals"]);
  });

  /**
   * `db:drop` in production is unrecoverable and is exactly what a deploy
   * script pointed at the wrong environment runs.
   */
  it("refuses outside a disposable environment", async () => {
    const production = [config({ env: "production" })];

    await expect(dropAll(runner(), production, "production")).rejects.toThrow();
    await expect(dropCurrent(runner(), production, "production")).rejects.toThrow();
    await expect(purgeAll(runner(), production, "production")).rejects.toThrow();
    await expect(purgeCurrent(runner(), production, "production")).rejects.toThrow();
  });

  it("empties every database without dropping", async () => {
    const each = runner();
    await purgeAll(each, configs, "test");

    expect(each.calls).toEqual(["purge:primary", "purge:animals"]);
  });

  it("drops and purges one by name", async () => {
    const each = runner();
    await dropCurrent(each, configs, "test", "animals");
    await purgeCurrent(each, configs, "test", "primary");

    expect(each.calls).toEqual(["drop:animals", "purge:primary"]);
  });

  /**
   * The two halves are useless apart: a drop that succeeds and a create that
   * fails leaves no database at all, so the create is attempted even when the
   * drop failed for the ordinary reason.
   */
  it("recreates past a database that was not there", async () => {
    const each: TaskRunner = {
      ...runner(),
      drop: () => {
        throw new Error('database "app_test" does not exist');
      },
    };

    await expect(recreateDatabase(each, config(), "test")).resolves.toBeUndefined();
  });

  it("does not recreate past another failure", async () => {
    const each: TaskRunner = {
      ...runner(),
      drop: () => {
        throw new Error("permission denied");
      },
    };

    await expect(recreateDatabase(each, config(), "test")).rejects.toThrow("permission denied");
  });
});

describe("loading a schema", () => {
  /**
   * A created database with no schema is worse than none: it exists, so
   * `db:create` reports success on the next run and never loads the schema —
   * and the failure appears as a missing table.
   */
  it("removes the database when the schema fails to load", async () => {
    const calls: string[] = [];
    const each: TaskRunner = {
      ...runner(),
      create: () => void calls.push("create"),
      drop: () => void calls.push("drop"),
      loadSchema: () => {
        calls.push("load");

        throw new Error("bad schema");
      },
    };

    await expect(createAndLoadSchema(each, config())).rejects.toThrow("bad schema");
    expect(calls).toEqual(["create", "load", "drop"]);
  });

  it("leaves the database alone when it worked", async () => {
    const each = runner();
    await createAndLoadSchema(each, config());

    expect(each.calls).toEqual(["create:primary", "load:primary"]);
  });

  it("loads one by name", async () => {
    const each = runner();

    expect(
      await loadSchemaCurrent(each, [config(), config({ name: "animals" })], "test", "animals"),
    ).toBe("animals");
  });

  /**
   * A combined file makes every migration on either database a conflict in the
   * same file, and these files are checked in.
   */
  it("dumps one file per database", async () => {
    const dumped = await dumpAll(runner(), [config(), config({ name: "animals" })], "test");

    expect(dumped).toEqual(["db/primary_schema.rb", "db/animals_schema.rb"]);
  });

  it("uses a configured dump path", async () => {
    const dumped = await dumpAll(runner(), [config({ schemaDump: "db/custom.sql" })], "test");

    expect(dumped).toEqual(["db/custom.sql"]);
  });

  /**
   * The task an application runs on boot, so it has to be safe against a
   * database that is already there — which is why it is not create then load.
   */
  it("loads a schema only into what it just created", async () => {
    const each: TaskRunner = {
      ...runner(),
      create: (candidate) => {
        if (candidate.name === "primary") throw new Error("database already exists");
      },
    };
    const loaded: string[] = [];

    const result = await prepareAll(
      { ...each, loadSchema: (candidate) => void loaded.push(candidate.name) },
      [config(), config({ name: "animals" })],
      "test",
    );

    expect(result).toEqual({ created: ["animals"], loaded: ["primary"] });
    expect(loaded).toEqual(["animals"]);
  });
});

describe("structure dumps", () => {
  /**
   * A dump including data would be checked into version control, which is how
   * a production export ends up in a public repository.
   */
  it("asks for the schema only", () => {
    expect(structureDump(config(), "db/structure.sql")).toContain("--schema-only");
    expect(structureDump(config({ adapter: "mysql" }), "db/structure.sql")).toContain("--no-data");
  });

  /**
   * Without ON_ERROR_STOP, psql reports success after failing every statement
   * in the file — an empty database and a green deploy.
   */
  it("stops on the first error when loading", () => {
    expect(structureLoad(config(), "db/structure.sql")).toContain("ON_ERROR_STOP=1");
  });

  it("uses each adapter's own tool", () => {
    expect(structureDump(config({ adapter: "sqlite" }), "x")[0]).toBe("sqlite3");
    expect(structureLoad(config({ adapter: "mysql" }), "x")[0]).toBe("mysql");
  });

  /** Guessing a command would produce a file that looks like a schema and is not one. */
  it("refuses an adapter it does not know", () => {
    expect(() => structureDump(config({ adapter: "oracle" }), "x")).toThrow("looks like a schema");
    expect(() => structureLoad(config({ adapter: "oracle" }), "x")).toThrow("oracle");
  });

  /**
   * A command built with an empty name connects to whichever database the
   * client defaults to — usually one named after the current user, and that is
   * the one that would be dumped.
   */
  it("refuses a configuration with no database name", () => {
    expect(() => structureDump(config({ database: undefined }), "x")).toThrow("current user");
  });
});

describe("the console command", () => {
  /**
   * Arguments are visible in the process list to every user on the machine, so
   * the password goes through the environment.
   */
  it("keeps the password off the command line", () => {
    const { command, env } = dbconsole(config({ username: "ada", password: "secret" }));

    expect(command.join(" ")).not.toContain("secret");
    expect(Object.keys(env)).toEqual(["PGPASSWORD"]);
  });

  it("uses each adapter's own client", () => {
    expect(dbconsole(config({ adapter: "mysql" })).command[0]).toBe("mysql");
    expect(dbconsole(config({ adapter: "sqlite" })).command).toEqual(["sqlite3", "app_test"]);
  });

  it("passes the host and user when there are any", () => {
    expect(dbconsole(config({ host: "db.internal" })).command).toContain("db.internal");
    expect(dbconsole(config()).command).not.toContain("--host");
  });
});

describe("per-database context", () => {
  /**
   * Sharing either the directory or the table makes a migration applied to one
   * database look applied to the other, so it is silently skipped.
   */
  it("gives a secondary database its own migrations directory", () => {
    expect(migrationContext(config()).paths).toEqual(["db/migrate"]);
    expect(migrationContext(config({ name: "animals" })).paths).toEqual(["db/animals_migrate"]);
  });

  it("uses a configured path", () => {
    expect(migrationContext(config({ migrationsPaths: "db/custom" })).paths).toEqual(["db/custom"]);
  });

  /**
   * Dumping every schema would include whatever an extension installed —
   * PostGIS puts several thousand functions in one — and the file is then both
   * unreadable and unloadable without that extension.
   */
  it("dumps the public schema alone by default", () => {
    expect(schemaSearchPath()).toEqual(["public"]);
    expect(schemaSearchPath("public, audit")).toEqual(["public", "audit"]);
  });
});

describe("adapter-supplied tasks", () => {
  /**
   * By adapter name rather than a pattern: a pattern matching two adapters
   * would pick whichever registered last, and the failure is a `pg_dump` run
   * against MySQL.
   */
  it("registers and finds one", () => {
    const task = () => undefined;
    registerTask("postgres", task);

    expect(taskFor("postgres")).toBe(task);
    expect(taskFor("mysql")).toBeUndefined();
  });
});
