/**
 * Bulk writes.
 *
 * Mirrors activerecord/test/cases/insert_all_test.rb. The behavioural tests
 * run against whatever adapter the suite is pointed at — all three in CI —
 * because conflict handling is the thing the adapters disagree about most,
 * and a test that only ever sees SQLite would not know.
 *
 * The statement-shape tests pin each adapter's SQL explicitly, so a change
 * that breaks MySQL is caught without a MySQL running.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  bulkStatement,
  columnsOf,
  Connection,
  Model,
  SchemaStatements,
  setConnection,
  UnsupportedBulkWrite,
} from "../src/index.js";
import { testConnection } from "./support/database.js";

interface WidgetRow {
  id: number;
  slug: string;
  name: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

class Widget extends Model<WidgetRow>("widgets") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Widget.columnCache = undefined;
  Widget.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("widgets", { ifExists: true });
  await schema.createTable("widgets", (t) => {
    t.string("slug", { null: false });
    t.string("name");
    t.integer("quantity", { default: 0 });
    t.datetime("created_at");
    t.datetime("updated_at");
    t.index(["slug"], { unique: true });
  });
});

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    slug: `w-${index}`,
    name: `Widget ${index}`,
    quantity: index,
  }));

describe("the column list", () => {
  // A batch is one statement with one column list, so a row that omits a
  // column gets NULL rather than a shorter tuple.
  it("is every column any row mentions", () => {
    expect(columnsOf([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }])).toEqual(["a", "b", "c"]);
  });

  it("keeps the order they were first seen in", () => {
    expect(columnsOf([{ b: 1, a: 2 }])).toEqual(["b", "a"]);
  });

  it("ignores a key explicitly set to undefined", () => {
    expect(columnsOf([{ a: 1, b: undefined }])).toEqual(["a"]);
  });
});

describe("inserting", () => {
  it("writes every row", async () => {
    const result = await Widget.insertAll(rows(5));

    expect(result.attempted).toBe(5);
    expect(await Widget.count()).toBe(5);
  });

  it("does nothing for an empty list", async () => {
    expect(await Widget.insertAll([])).toEqual({ attempted: 0, ids: [] });
  });

  it("fills a column a row left out", async () => {
    await Widget.insertAll([{ slug: "a", name: "A", quantity: 1 }, { slug: "b" }]);

    const found = await Widget.findBy({ slug: "b" });
    expect(found?.name).toBeNull();
  });

  it("stamps the timestamps the table has", async () => {
    await Widget.insertAll([{ slug: "a" }]);

    const found = await Widget.findBy({ slug: "a" });
    expect(found?.created_at).toBeTruthy();
    expect(found?.updated_at).toBeTruthy();
  });

  it("can be told not to", async () => {
    await Widget.insertAll([{ slug: "a" }], { recordTimestamps: false });

    expect((await Widget.findBy({ slug: "a" }))?.created_at).toBeNull();
  });

  it("splits into batches and still writes everything", async () => {
    await Widget.insertAll(rows(25), { batchSize: 4 });
    expect(await Widget.count()).toBe(25);
  });

  it("refuses a batch size below one", async () => {
    await expect(Widget.insertAll(rows(2), { batchSize: 0 })).rejects.toThrow(/at least 1/);
  });

  // With timestamps on, an empty row still has two columns; this is about the
  // case where there is genuinely nothing to write.
  it("refuses rows with nothing in them", async () => {
    await expect(Widget.insertAll([{}], { recordTimestamps: false })).rejects.toThrow(
      UnsupportedBulkWrite,
    );
  });
});

describe("collisions", () => {
  const existing = () => Widget.insertAll([{ slug: "a", name: "Original", quantity: 1 }]);

  // Rails' insert_all skips; insert_all! raises. Two methods because the two
  // situations are genuinely different, and one flag would get passed wrongly.
  it("skips what already exists", async () => {
    await existing();
    await Widget.insertAll([
      { slug: "a", name: "Replacement" },
      { slug: "b", name: "New" },
    ]);

    expect(await Widget.count()).toBe(2);
    expect((await Widget.findBy({ slug: "a" }))?.name).toBe("Original");
  });

  it("raises instead, when asked to", async () => {
    await existing();

    await expect(Widget.insertAllOrFail([{ slug: "a", name: "Replacement" }])).rejects.toThrow();
  });

  it("overwrites on an upsert", async () => {
    await existing();
    await Widget.upsertAll([{ slug: "a", name: "Replacement", quantity: 9 }], { uniqueBy: "slug" });

    const found = await Widget.findBy({ slug: "a" });
    expect(found?.name).toBe("Replacement");
    expect(found?.quantity).toBe(9);
    expect(await Widget.count()).toBe(1);
  });

  it("inserts what is not there and overwrites what is", async () => {
    await existing();
    await Widget.upsertAll(
      [
        { slug: "a", name: "Replacement" },
        { slug: "b", name: "New" },
      ],
      { uniqueBy: "slug" },
    );

    expect(await Widget.count()).toBe(2);
    expect((await Widget.findBy({ slug: "a" }))?.name).toBe("Replacement");
  });

  it("overwrites only the columns it was told to", async () => {
    await existing();
    await Widget.upsertAll([{ slug: "a", name: "Replacement", quantity: 9 }], {
      uniqueBy: "slug",
      updateOnly: ["name"],
    });

    const found = await Widget.findBy({ slug: "a" });
    expect(found?.name).toBe("Replacement");
    expect(found?.quantity).toBe(1);
  });

  // An upsert that overwrote created_at would make every updated row look as
  // though it had just been created.
  it("does not rewrite created_at on an upsert", async () => {
    await existing();
    const before = (await Widget.findBy({ slug: "a" }))?.created_at;

    await Widget.upsertAll([{ slug: "a", name: "Replacement" }], { uniqueBy: "slug" });

    expect((await Widget.findBy({ slug: "a" }))?.created_at).toEqual(before);
  });
});

// The whole batch lands or none of it does, which saving one at a time cannot
// offer without a transaction the caller has to remember to open.
describe("atomicity", () => {
  it("leaves nothing behind when a later batch fails", async () => {
    await Widget.insertAll([{ slug: "clash" }]);

    await Widget.insertAllOrFail([...rows(3), { slug: "clash", name: "boom" }], {
      batchSize: 2,
    }).catch(() => undefined);

    expect(await Widget.count()).toBe(1);
  });
});

// Pinned per adapter, so a change that breaks MySQL is caught without one
// running. This is where the three genuinely disagree.
describe("the statement each adapter gets", () => {
  const adapters = {
    postgres: new Connection("postgres://localhost/x"),
    // Pinned, unlike the rest of this file: the block compares the SQL each
    // adapter is given, so the SQLite entry has to be SQLite whatever the
    // suite is pointed at.
    sqlite: new Connection("sqlite://:memory:"),
    mysql: new Connection("mysql://localhost/x"),
  };

  const build = (
    adapter: keyof typeof adapters,
    behaviour: "raise" | "skip" | "update",
    options = {},
  ) =>
    bulkStatement(adapters[adapter], "widgets", [{ slug: "a", name: "A" }], behaviour, options).sql;

  it("numbers placeholders only where they are numbered", () => {
    expect(build("postgres", "raise")).toContain("VALUES ($1, $2)");
    expect(build("sqlite", "raise")).toContain("VALUES (?, ?)");
    expect(build("mysql", "raise")).toContain("VALUES (?, ?)");
  });

  it("uses ON CONFLICT where there is one", () => {
    expect(build("postgres", "skip", { uniqueBy: "slug" })).toContain(
      'ON CONFLICT ("slug") DO NOTHING',
    );
    expect(build("sqlite", "update", { uniqueBy: "slug" })).toContain(
      'ON CONFLICT ("slug") DO UPDATE SET "name" = excluded."name"',
    );
  });

  // MySQL has neither DO NOTHING nor a named conflict target.
  it("uses ON DUPLICATE KEY on MySQL", () => {
    expect(build("mysql", "update", { uniqueBy: "slug" })).toContain(
      "ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)",
    );
  });

  // INSERT IGNORE would be the obvious equivalent, and it also swallows
  // unrelated recoverable errors — a truncated value becomes a warning.
  // Assigning a column to itself means only "on a duplicate key, do nothing".
  it("skips on MySQL without swallowing other errors", () => {
    const sql = build("mysql", "skip", { uniqueBy: "slug" });

    expect(sql).not.toContain("INSERT IGNORE");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE `slug` = `slug`");
  });

  it("never overwrites the columns the conflict is judged on", () => {
    expect(build("postgres", "update", { uniqueBy: "slug" })).not.toContain(
      'SET "slug" = excluded."slug"',
    );
  });

  // Without a target, DO UPDATE is a syntax error outright. DO NOTHING is
  // legal but widens to every unique constraint on the table, which is why
  // naming one is worth insisting on where it can be insisted on.
  it("insists on a conflict target where one is needed", () => {
    expect(() => build("postgres", "update")).toThrow(/uniqueBy/);
    expect(() => build("sqlite", "update")).toThrow(/uniqueBy/);
    expect(() => build("mysql", "update")).not.toThrow();
  });

  it("says so when there is nothing left to update", () => {
    expect(() =>
      bulkStatement(adapters.postgres, "widgets", [{ slug: "a" }], "update", {
        uniqueBy: "slug",
      }),
    ).toThrow(/nothing to update/);
  });
});
