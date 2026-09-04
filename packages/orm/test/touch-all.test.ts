/**
 * Moving many rows' timestamps at once, ported from
 * `activerecord/test/cases/timestamp_test.rb`.
 *
 * What a bulk import reaches for: touching each record individually is a query
 * per row, and the point of a timestamp column is usually to invalidate a
 * cache, which does not care how it moved.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

class Post extends Model<{
  id: number;
  title: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}>("posts") {}

const stampsOf = async () =>
  await connection.query<{ title: string; updated_at: unknown; reviewed_at: unknown }>(
    `SELECT ${connection.quote("title")}, ${connection.quote("updated_at")}, ${connection.quote("reviewed_at")} FROM ${connection.quote("posts")} ORDER BY ${connection.quote("id")}`,
  );

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("posts", (t) => {
    t.string("title");
    t.datetime("reviewed_at");
    t.timestamps();
  });

  Post.resetColumnInformation();

  await Post.create({ title: "A" });
  await Post.create({ title: "B" });

  // Far enough back that a move is unambiguous whatever the column's precision.
  await connection.execute(
    `UPDATE ${connection.quote("posts")} SET ${connection.quote("updated_at")} = ${connection.placeholder(0)}`,
    ["2020-01-01 00:00:00"],
  );
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("touching everything", () => {
  it("moves updated_at on every row", async () => {
    await Post.all().touchAll();

    for (const row of await stampsOf()) {
      expect(String(row.updated_at)).not.toContain("2020");
    }
  });

  it("says how many it touched", async () => {
    expect(await Post.all().touchAll()).toBe(2);
  });

  it("leaves the rows the conditions exclude alone", async () => {
    await Post.where({ title: "A" }).touchAll();

    const [first, second] = await stampsOf();

    expect(String(first!.updated_at)).not.toContain("2020");
    expect(String(second!.updated_at)).toContain("2020");
  });

  it("touches nothing when nothing matches", async () => {
    expect(await Post.where({ title: "nope" }).touchAll()).toBe(0);
  });
});

/**
 * A caller asking for `reviewed_at` almost never means "and leave `updated_at`
 * where it is". Rails reads the same way.
 */
describe("touching another column too", () => {
  it("moves it", async () => {
    await Post.all().touchAll("reviewed_at");

    for (const row of await stampsOf()) expect(row.reviewed_at).not.toBeNull();
  });

  it("still moves updated_at alongside it", async () => {
    await Post.all().touchAll("reviewed_at");

    for (const row of await stampsOf()) {
      expect(String(row.updated_at)).not.toContain("2020");
    }
  });

  it("does not write updated_at twice when it is named", async () => {
    // Naming it explicitly is reasonable and must not produce
    // `SET updated_at = ?, updated_at = ?`, which MySQL accepts and PostgreSQL
    // refuses outright.
    await Post.all().touchAll("updated_at");

    for (const row of await stampsOf()) {
      expect(String(row.updated_at)).not.toContain("2020");
    }
  });
});

describe("what it refuses", () => {
  it("says so for a column the table does not have", () => {
    expect(() => Post.all().touchAll("nonexistent")).toThrow();
  });
});
