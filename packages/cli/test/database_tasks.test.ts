/**
 * Creating and dropping the database itself.
 *
 * Mirrors railties/test/application/rake/dbs_test.rb.
 *
 * Every other database task assumes the database is there. These put it there,
 * and they are the only ones that cannot connect to it to do their work:
 * `CREATE DATABASE app_development` has to be run from somewhere else, and
 * where that somewhere is differs by adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDatabaseName,
  createDatabase,
  dropDatabase,
  targetFor,
  type MaintenanceConnection,
} from "../src/database.js";

let directory: string;

/** A connection that records what it was asked to run. */
const recorder = () => {
  const statements: string[] = [];

  const connection: MaintenanceConnection = {
    async execute(sql: string) {
      statements.push(sql);
      return undefined;
    },
    async query<T>() {
      return [] as T[];
    },
    async close() {},
  };

  return { statements, open: async () => connection };
};

/** SQLite must never open a maintenance connection. */
const never = async (): Promise<MaintenanceConnection> => {
  throw new Error("connected when it should not have");
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "altair-db-task-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("reading the connection URL", () => {
  // `CREATE DATABASE` cannot be run from the database it creates.
  it("points Postgres at the database every server has", () => {
    const target = targetFor("postgres://user:pass@host:5432/app_development");

    expect(target.adapter).toBe("postgres");
    expect(target.name).toBe("app_development");
    expect(target.maintenanceUrl).toContain("/postgres");
  });

  it("points MySQL at no database at all", () => {
    const target = targetFor("mysql://user:pass@host/app_development");

    expect(target.adapter).toBe("mysql");
    expect(target.name).toBe("app_development");
    expect(target.maintenanceUrl).toEndWith("/");
  });

  it("reads a SQLite path as the name", () => {
    expect(targetFor("sqlite:///var/app.sqlite3").name).toBe("/var/app.sqlite3");
    expect(targetFor("sqlite://:memory:").name).toBe(":memory:");
  });
});

/**
 * A database name cannot be a bound parameter — it is part of the statement,
 * not a value in it — so it is checked rather than escaped.
 */
describe("a name it will not use", () => {
  it("refuses one carrying a statement", () => {
    expect(() => assertDatabaseName('a"; DROP DATABASE other; --')).toThrow();
    expect(() => assertDatabaseName("a`; DROP DATABASE other; --")).toThrow();
  });

  it("refuses whitespace, and a name starting with a digit", () => {
    expect(() => assertDatabaseName("a b")).toThrow();
    expect(() => assertDatabaseName("1abc")).toThrow();
    expect(() => assertDatabaseName("")).toThrow();
  });

  it("allows the names people actually use", () => {
    for (const name of ["app_development", "app-test", "App_Test_2"]) {
      expect(() => assertDatabaseName(name)).not.toThrow();
    }
  });

  it("refuses before connecting anywhere", () => {
    const target = {
      adapter: "postgres" as const,
      name: "a b",
      maintenanceUrl: "postgres://x/postgres",
    };

    expect(createDatabase(target, never)).rejects.toThrow();
  });
});

describe("on SQLite", () => {
  const target = () => targetFor(`sqlite://${join(directory, "app.sqlite3")}`);

  it("makes the file", async () => {
    const result = await createDatabase(target(), never);

    expect(result.changed).toBe(true);
    expect(await Bun.file(join(directory, "app.sqlite3")).exists()).toBe(true);
  });

  // Run as part of setting a machine up, so a second run should be quiet.
  it("says so when it is already there", async () => {
    await createDatabase(target(), never);
    const again = await createDatabase(target(), never);

    expect(again.changed).toBe(false);
    expect(again.output).toContain("already exists");
  });

  it("removes the file", async () => {
    await createDatabase(target(), never);
    const result = await dropDatabase(target(), never);

    expect(result.changed).toBe(true);
    expect(await Bun.file(join(directory, "app.sqlite3")).exists()).toBe(false);
  });

  it("says so when there is nothing to drop", async () => {
    expect((await dropDatabase(target(), never)).changed).toBe(false);
  });

  it("has nothing to do for an in-memory database", async () => {
    const memory = targetFor("sqlite://:memory:");

    expect((await createDatabase(memory, never)).changed).toBe(false);
    expect((await dropDatabase(memory, never)).changed).toBe(false);
  });
});

describe("on a server", () => {
  const postgres = () => targetFor("postgres://user@host/app_development");
  const mysql = () => targetFor("mysql://user@host/app_development");

  it("runs CREATE DATABASE", async () => {
    const { statements, open } = recorder();
    await createDatabase(postgres(), open);

    expect(statements[0]).toBe('CREATE DATABASE "app_development"');
  });

  it("quotes the name the way the adapter does", async () => {
    const { statements, open } = recorder();
    await createDatabase(mysql(), open);

    expect(statements[0]).toBe("CREATE DATABASE `app_development`");
  });

  it("runs DROP DATABASE", async () => {
    const { statements, open } = recorder();
    await dropDatabase(postgres(), open);

    expect(statements[0]).toBe('DROP DATABASE "app_development"');
  });

  // The server says so in its own words, and neither is an error worth
  // stopping a setup script for.
  it("reads an already-exists failure as nothing to do", async () => {
    const open = async (): Promise<MaintenanceConnection> => ({
      async execute() {
        throw new Error('database "app_development" already exists');
      },
      async query<T>() {
        return [] as T[];
      },
      async close() {},
    });

    expect((await createDatabase(postgres(), open)).changed).toBe(false);
  });

  it("reads a does-not-exist failure the same way", async () => {
    const open = async (): Promise<MaintenanceConnection> => ({
      async execute() {
        throw new Error("Unknown database 'app_development'");
      },
      async query<T>() {
        return [] as T[];
      },
      async close() {},
    });

    expect((await dropDatabase(mysql(), open)).changed).toBe(false);
  });

  it("lets any other failure through", () => {
    const open = async (): Promise<MaintenanceConnection> => ({
      async execute() {
        throw new Error("permission denied for user");
      },
      async query<T>() {
        return [] as T[];
      },
      async close() {},
    });

    expect(createDatabase(postgres(), open)).rejects.toThrow(/permission denied/);
  });
});
