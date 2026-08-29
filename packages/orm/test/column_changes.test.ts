/**
 * Renaming and altering a column.
 *
 * Mirrors activerecord/test/cases/migration/column_attributes_test.rb and
 * rename_column_test.rb.
 *
 * These are where the three adapters disagree most, so the tests are written
 * to run everywhere and assert what each one actually does — including the
 * refusals. A test that skipped SQLite would leave the adapter most people
 * develop against as the one nobody checked.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Connection,
  SchemaStatements,
  UnsupportedSchemaChange,
  setConnection,
} from "../src/index.js";
import { testConnection } from "./support/database.js";

let connection: Connection;
let schema: SchemaStatements;

const sqlite = () => connection.adapter === "sqlite";

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  schema = new SchemaStatements(connection);

  await schema.dropTable("widgets", { ifExists: true });
  await schema.createTable("widgets", (t) => {
    t.string("title");
    t.integer("count", { default: 0 });
  });

  await connection.execute(
    `INSERT INTO ${connection.quote("widgets")} (${connection.quote("title")}) VALUES ('one')`,
  );
});

const columnNames = async (): Promise<string[]> => {
  const rows = await connection.query<Record<string, unknown>>(
    `SELECT * FROM ${connection.quote("widgets")}`,
  );

  return Object.keys(rows[0] ?? {});
};

/**
 * The one statement all three now spell the same way. They did not always:
 * SQLite could not do it before 3.25 and MySQL wanted `CHANGE` with the type
 * repeated before 8.0, both old enough that carrying the workaround would be
 * carrying it for nobody.
 */
describe("renameColumn", () => {
  it("renames it", async () => {
    await schema.renameColumn("widgets", "title", "name");

    expect(await columnNames()).toContain("name");
    expect(await columnNames()).not.toContain("title");
  });

  it("keeps the data", async () => {
    await schema.renameColumn("widgets", "title", "name");

    const rows = await connection.query<{ name: string }>(
      `SELECT ${connection.quote("name")} FROM ${connection.quote("widgets")}`,
    );

    expect(rows[0]?.name).toBe("one");
  });

  it("works on every adapter", async () => {
    expect(schema.renameColumn("widgets", "count", "total")).resolves.toBeUndefined();
  });
});

describe("changeColumnNull", () => {
  it("applies the constraint where the adapter can", async () => {
    if (sqlite()) return;

    await schema.changeColumnNull("widgets", "title", false, "string");

    expect(
      connection.execute(
        `INSERT INTO ${connection.quote("widgets")} (${connection.quote("count")}) VALUES (1)`,
      ),
    ).rejects.toThrow();
  });

  it("removes it again", async () => {
    if (sqlite()) return;

    await schema.changeColumnNull("widgets", "title", false, "string");
    await schema.changeColumnNull("widgets", "title", true, "string");

    // Awaited, and asserted on the row rather than on the promise. This read
    // `expect(promise).resolves.toBeDefined()` on a call that resolves to
    // `undefined` — so it could only fail, and never ran: the case is skipped
    // on SQLite and nothing else ever reached it.
    await connection.execute(
      `INSERT INTO ${connection.quote("widgets")} (${connection.quote("count")}) VALUES (1)`,
    );

    const rows = await connection.query(`SELECT * FROM ${connection.quote("widgets")}`);

    expect(rows).toHaveLength(1);
  });

  // MySQL restates the whole column definition, so dropping the type would
  // silently reset the column's default along with its nullability.
  it("insists on the type where the adapter restates the column", () => {
    if (connection.adapter !== "mysql") return;

    expect(schema.changeColumnNull("widgets", "title", false)).rejects.toThrow(/type/);
  });

  it("says why it cannot on SQLite, and what to do instead", () => {
    if (!sqlite()) return;

    expect(schema.changeColumnNull("widgets", "title", false, "string")).rejects.toBeInstanceOf(
      UnsupportedSchemaChange,
    );
    expect(schema.changeColumnNull("widgets", "title", false, "string")).rejects.toThrow(/rebuild/);
  });
});

describe("changeColumnDefault", () => {
  const inserted = async () => {
    await connection.execute(
      `INSERT INTO ${connection.quote("widgets")} (${connection.quote("title")}) VALUES ('two')`,
    );

    const rows = await connection.query<{ count: number }>(
      `SELECT ${connection.quote("count")} FROM ${connection.quote("widgets")} WHERE ${connection.quote("title")} = 'two'`,
    );

    return Number(rows[0]?.count);
  };

  it("sets one", async () => {
    if (sqlite()) return;

    await schema.changeColumnDefault("widgets", "count", 5);

    expect(await inserted()).toBe(5);
  });

  /**
   * This asked whether a SELECT returned anything, which it does whatever the
   * default is. The question is what a row that does not name the column gets,
   * and only inserting one answers it.
   *
   * Not through `inserted()`: that reads the value through `Number`, which
   * turns the null this is looking for into a 0 indistinguishable from a real
   * default of zero.
   */
  it("removes one", async () => {
    if (sqlite()) return;

    await schema.changeColumnDefault("widgets", "count", 5);
    expect(await inserted()).toBe(5);

    await schema.changeColumnDefault("widgets", "count", null);

    await connection.execute(
      `INSERT INTO ${connection.quote("widgets")} (${connection.quote("title")}) VALUES ('after')`,
    );

    const rows = await connection.query<{ count: number | null }>(
      `SELECT ${connection.quote("count")} FROM ${connection.quote("widgets")} WHERE ${connection.quote("title")} = 'after'`,
    );

    expect(rows[0]?.count).toBeNull();
  });

  // A default is part of a table's definition rather than of a statement, so
  // it cannot be a bound parameter and has to be written out.
  it("quotes a string default rather than interpolating it", async () => {
    if (sqlite()) return;

    await schema.changeColumnDefault("widgets", "title", "it's default");

    await connection.execute(
      `INSERT INTO ${connection.quote("widgets")} (${connection.quote("count")}) VALUES (9)`,
    );

    const rows = await connection.query<{ title: string }>(
      `SELECT ${connection.quote("title")} FROM ${connection.quote("widgets")} WHERE ${connection.quote("count")} = 9`,
    );

    expect(rows[0]?.title).toBe("it's default");
  });

  it("says why it cannot on SQLite", () => {
    if (!sqlite()) return;

    expect(schema.changeColumnDefault("widgets", "count", 5)).rejects.toBeInstanceOf(
      UnsupportedSchemaChange,
    );
  });
});
