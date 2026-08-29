/**
 * Changing a table after it exists, ported from
 * `activerecord/test/cases/migration/change_schema_test.rb`,
 * `column_attributes_test.rb` and `references_index_test.rb`.
 *
 * A schema that can only be created and never changed is a schema for an
 * application that never ships twice.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Connection,
  indexSchemas,
  SchemaStatements,
  UnsupportedSchemaChange,
} from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;
let schema: SchemaStatements;

/**
 * Run against whichever database the suite is pointed at, because the three
 * adapters differ in kind here rather than only in syntax — Postgres alters a
 * column in place, MySQL restates its whole definition, SQLite rebuilds the
 * table. A branch that never executes is a branch nobody has checked, which is
 * the whole reason Rails runs its own suite against all three.
 */
beforeEach(async () => {
  connection = await testConnection();
  schema = new SchemaStatements(connection);

  await schema.createTable("users", (t) => t.string("name"));
  await schema.createTable("posts", (t) => {
    t.string("title", { null: false });
    t.string("views");
    t.string("legacy_id");
  });
});

afterEach(async () => {
  // A server connection is one shared pool that `testConnection` empties and
  // replaces; closing it here would pull it out from under the next file.
  if (isSqlite) await connection.close();
});

const columnNamed = async (table: string, name: string) =>
  (await schema.columns(table)).find((one) => one.name === name);

describe("asking what a table has", () => {
  it("lists its columns", async () => {
    expect((await schema.columns("posts")).map((one) => one.name)).toEqual([
      "id",
      "title",
      "views",
      "legacy_id",
    ]);
  });

  it("says whether a column is there", async () => {
    expect(await schema.columnExists("posts", "title")).toBe(true);
    expect(await schema.columnExists("posts", "nope")).toBe(false);
  });

  /**
   * The database answers in its own spelling — VARCHAR(255) for a string — so
   * a caller asking "is this a string?" should not have to know which of the
   * three databases it is talking to.
   */
  it("checks the type without knowing the database's spelling", async () => {
    expect(await schema.columnExists("posts", "title", "string")).toBe(true);
    expect(await schema.columnExists("posts", "title", "integer")).toBe(false);
  });
});

describe("changing a column's type", () => {
  it("changes it", async () => {
    await schema.changeColumn("posts", "views", "integer");

    // Every one of the three spells an integer with "int" somewhere — INTEGER,
    // int(11), integer — which is as much as a portable assertion can say.
    expect((await columnNamed("posts", "views"))?.type.toUpperCase()).toContain("INT");
  });

  it("keeps the rows that were already there", async () => {
    await connection.execute("INSERT INTO posts (title, views) VALUES ('A', '42')");

    await schema.changeColumn("posts", "views", "integer");

    const [row] = await connection.query<{ title: string; views: number }>("SELECT * FROM posts");

    expect(row!.title).toBe("A");
    expect(Number(row!.views)).toBe(42);
  });

  it("leaves the other columns alone", async () => {
    await schema.changeColumn("posts", "views", "integer");

    expect((await columnNamed("posts", "title"))?.nullable).toBe(false);
  });

  it("keeps the primary key a primary key", async () => {
    await schema.changeColumn("posts", "views", "integer");

    expect((await columnNamed("posts", "id"))?.primaryKey).toBe(true);
  });

  it("can add a NOT NULL along the way", async () => {
    await schema.changeColumn("posts", "views", "integer", { null: false });

    expect((await columnNamed("posts", "views"))?.nullable).toBe(false);
  });

  /**
   * Without putting them back, the rebuild silently drops them — and a table
   * that lost its unique index looks fine until two rows collide months later.
   */
  it("keeps an index across the rebuild", async () => {
    await schema.addIndex("posts", ["legacy_id"], { unique: true });

    await schema.changeColumn("posts", "views", "integer");

    const names = await schema.indexes("posts");
    expect(names.some((name) => name.includes("legacy_id"))).toBe(true);
  });

  it("keeps a unique index actually unique", async () => {
    await schema.addIndex("posts", ["legacy_id"], { unique: true });
    await schema.changeColumn("posts", "views", "integer");

    await connection.execute("INSERT INTO posts (title, legacy_id) VALUES ('A', 'x')");

    await expect(
      connection.execute("INSERT INTO posts (title, legacy_id) VALUES ('B', 'x')"),
    ).rejects.toThrow();
  });

  it.skipIf(!isSqlite)("keeps a foreign key across the rebuild", async () => {
    // SQLite only: the other two never rebuild, so there is nothing to lose,
    // and reading their foreign keys is a different query in each.
    await schema.createTable("comments", (t) => {
      t.integer("post_id");
      t.string("body");
      t.foreignKey("posts", { column: "post_id" });
    });

    await schema.changeColumn("comments", "body", "text");

    const keys = await connection.query<{ table: string }>("PRAGMA foreign_key_list(comments)");

    expect(keys.map((key) => key.table)).toContain("posts");
  });
});

describe("adding a reference", () => {
  it("adds the column", async () => {
    await schema.addReference("posts", "user");

    expect(await schema.columnExists("posts", "user_id")).toBe(true);
  });

  /**
   * The index is the point. A `user_id` with no index is the commonest cause
   * of a slow `user.posts` — every read scans the whole table — and it stays
   * invisible until the table is large.
   */
  it("indexes it, because that is the point", async () => {
    await schema.addReference("posts", "user");

    const names = await schema.indexes("posts");

    expect(names.some((name) => name.includes("user_id"))).toBe(true);
  });

  it("can be told not to", async () => {
    await schema.addReference("posts", "user", { index: false });

    expect(await schema.indexes("posts")).toEqual([]);
  });

  it("adds a type column for a polymorphic one", async () => {
    await schema.addReference("posts", "owner", { polymorphic: true });

    expect(await schema.columnExists("posts", "owner_type")).toBe(true);
    expect(await schema.columnExists("posts", "owner_id")).toBe(true);
  });

  /**
   * An index is usable left to right and every query on a polymorphic
   * association names the type, so the type goes first — as it does in Rails.
   */
  it("indexes a polymorphic one type-first", async () => {
    await schema.addReference("posts", "owner", { polymorphic: true });

    const index = (await indexSchemas(connection, "posts"))[0];

    expect(index?.columns).toEqual(["owner_type", "owner_id"]);
  });

  it("refuses a foreign key on a polymorphic reference", async () => {
    await expect(
      schema.addReference("posts", "owner", { polymorphic: true, foreignKey: true }),
    ).rejects.toBeInstanceOf(UnsupportedSchemaChange);
  });

  it("removes what it added", async () => {
    await schema.addReference("posts", "owner", { polymorphic: true });
    await schema.removeReference("posts", "owner", { polymorphic: true });

    expect(await schema.columnExists("posts", "owner_id")).toBe(false);
    expect(await schema.columnExists("posts", "owner_type")).toBe(false);
  });
});

/**
 * Recorded and then run in order rather than executed as the block reads them,
 * which is what lets the block be synchronous — a migration written with
 * `await` on every line is mostly punctuation, and a forgotten one is a change
 * that silently does not happen.
 */
describe("several changes at once", () => {
  it("applies them in the order they were written", async () => {
    await schema.changeTable("posts", (t) => {
      t.string("slug");
      t.rename("slug", "permalink");
    });

    expect(await schema.columnExists("posts", "permalink")).toBe(true);
    expect(await schema.columnExists("posts", "slug")).toBe(false);
  });

  it("adds, changes and removes in one block", async () => {
    await schema.changeTable("posts", (t) => {
      t.integer("rank");
      t.change("views", "integer");
      t.remove("legacy_id");
    });

    expect(await schema.columnExists("posts", "rank", "integer")).toBe(true);
    expect(await schema.columnExists("posts", "views", "integer")).toBe(true);
    expect(await schema.columnExists("posts", "legacy_id")).toBe(false);
  });

  it("removes several columns in one call", async () => {
    await schema.changeTable("posts", (t) => t.remove("views", "legacy_id"));

    expect(await schema.columnExists("posts", "views")).toBe(false);
    expect(await schema.columnExists("posts", "legacy_id")).toBe(false);
  });

  it("adds a reference", async () => {
    await schema.changeTable("posts", (t) => t.reference("user"));

    expect(await schema.columnExists("posts", "user_id")).toBe(true);
  });

  /**
   * SQLite cannot add a foreign key to a table that already exists, and says
   * so rather than failing with a driver syntax error — the answer is a
   * different migration, not a different database.
   */
  it.skipIf(!isSqlite)("says why a foreign key cannot be added on SQLite", async () => {
    await expect(
      schema.changeTable("posts", (t) => t.reference("user", { foreignKey: true })),
    ).rejects.toThrow(/cannot add a foreign key/);
  });

  it.skipIf(isSqlite)("adds a foreign key where the database allows it", async () => {
    await schema.changeTable("posts", (t) => t.reference("user", { foreignKey: true }));

    expect(await schema.columnExists("posts", "user_id")).toBe(true);
  });

  it("adds an index and takes it away again", async () => {
    await schema.changeTable("posts", (t) => t.index(["title"], { name: "posts_on_title" }));
    expect(await schema.indexes("posts")).toContain("posts_on_title");

    await schema.changeTable("posts", (t) => t.removeIndex("posts_on_title"));
    expect(await schema.indexes("posts")).not.toContain("posts_on_title");
  });

  it("adds timestamps", async () => {
    await schema.changeTable("posts", (t) => t.timestamps());

    expect(await schema.columnExists("posts", "created_at")).toBe(true);
    expect(await schema.columnExists("posts", "updated_at")).toBe(true);
  });

  /**
   * Nothing runs until the block returns, so a block that throws leaves the
   * table exactly as it was rather than half-changed.
   */
  it("changes nothing when the block throws", async () => {
    const before = (await schema.columns("posts")).map((one) => one.name);

    await expect(
      schema.changeTable("posts", () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect((await schema.columns("posts")).map((one) => one.name)).toEqual(before);
  });
});
