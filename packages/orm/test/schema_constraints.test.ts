/**
 * The schema statements Rails has beyond columns and indexes, ported from
 * `activerecord/test/cases/migration/`.
 *
 * Check constraints and unique constraints are the ones worth having: a rule
 * the database enforces holds against every writer, including the console and
 * the migration that forgot about it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;
let schema: SchemaStatements;

const sqlite = () => connection.adapter === "sqlite";

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  schema = new SchemaStatements(connection);

  await schema.createTable("widgets", (t) => {
    t.string("name");
    t.integer("count");
  });
});

afterEach(async () => {
  await schema.dropTable("widgets").catch(() => undefined);
  if (isSqlite) await connection.close();
});

describe("timestamps", () => {
  it("adds both, never one", async () => {
    await schema.addTimestamps("widgets");

    const rows = await connection.query<Record<string, unknown>>("SELECT * FROM widgets");
    void rows;

    await connection.execute("INSERT INTO widgets (name) VALUES ('a')");

    const [row] = await connection.query<Record<string, unknown>>("SELECT * FROM widgets");

    expect("created_at" in (row as object)).toBe(true);
    expect("updated_at" in (row as object)).toBe(true);
  });

  it("takes them away together too", async () => {
    if (sqlite()) return;

    await schema.addTimestamps("widgets");
    await schema.removeTimestamps("widgets");

    const [row] = await connection.query<Record<string, unknown>>(
      "SELECT * FROM widgets WHERE 1 = 0",
    );

    expect(row).toBeUndefined();
  });
});

describe("a unique constraint", () => {
  it("stops a second row with the same value", async () => {
    await schema.addUniqueConstraint("widgets", "name");

    await connection.execute("INSERT INTO widgets (name) VALUES ('a')");

    await expect(connection.execute("INSERT INTO widgets (name) VALUES ('a')")).rejects.toThrow();
  });

  it("takes several columns together", async () => {
    await schema.addUniqueConstraint("widgets", ["name", "count"]);

    await connection.execute("INSERT INTO widgets (name, count) VALUES ('a', 1)");

    // The pair differs, so this is allowed.
    await connection.execute("INSERT INTO widgets (name, count) VALUES ('a', 2)");

    await expect(
      connection.execute("INSERT INTO widgets (name, count) VALUES ('a', 1)"),
    ).rejects.toThrow();
  });
});

/**
 * A rule the database enforces holds against every writer — the console, a
 * migration that forgot, a script somebody ran once. A validation only holds
 * against the application.
 */
describe("a check constraint", () => {
  it("refuses a row that breaks the rule", async () => {
    if (sqlite()) return;

    await schema.addCheckConstraint("widgets", "count > 0", { name: "count_positive" });

    await connection.execute("INSERT INTO widgets (name, count) VALUES ('a', 1)");

    await expect(
      connection.execute("INSERT INTO widgets (name, count) VALUES ('b', 0)"),
    ).rejects.toThrow();
  });

  it("can be taken away again", async () => {
    if (sqlite()) return;

    await schema.addCheckConstraint("widgets", "count > 0", { name: "count_positive" });
    await schema.removeCheckConstraint("widgets", "count_positive");

    await connection.execute("INSERT INTO widgets (name, count) VALUES ('b', 0)");

    expect(await connection.query("SELECT * FROM widgets")).toHaveLength(1);
  });

  /**
   * SQLite cannot add one to a table that exists, and says so rather than
   * silently doing nothing — the same answer `addForeignKey` gives, for the
   * same reason.
   */
  it("says SQLite cannot add one afterwards", async () => {
    if (!sqlite()) return;

    await expect(schema.addCheckConstraint("widgets", "count > 0")).rejects.toThrow(/createTable/);
  });
});

describe("asking what indexes are there", () => {
  it("says when one is and when it is not", async () => {
    expect(await schema.indexExists("widgets", "name")).toBe(false);

    await schema.addIndex("widgets", ["name"]);

    expect(await schema.indexExists("widgets", "name")).toBe(true);
  });

  it("lists them", async () => {
    await schema.addIndex("widgets", ["name"]);

    expect((await schema.indexes("widgets")).some((one) => one.includes("name"))).toBe(true);
  });

  it("tells a multi-column index apart from a single one", async () => {
    await schema.addIndex("widgets", ["name", "count"]);

    expect(await schema.indexExists("widgets", ["name", "count"])).toBe(true);
    expect(await schema.indexExists("widgets", "name")).toBe(false);
  });
});
