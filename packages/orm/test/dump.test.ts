/**
 * Schema dump and type generation.
 *
 * Mirrors activerecord/test/cases/schema_dumper_test.rb. The round trip is the
 * important case: a dump that cannot be loaded back is worse than no dump,
 * because it fails when someone is trying to prepare a test database.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Migrator, type Migration } from "../src/schema.js";
import { Model } from "../src/model.js";
import { currentVersion, introspect } from "../src/introspect.js";
import {
  columnTypeFor,
  dumpSchema,
  dumpTypes,
  loadSchema,
  rowTypeName,
  tsTypeFor,
} from "../src/dump.js";

let connection: Connection;
let schema: SchemaStatements;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  schema = new SchemaStatements(connection);

  await schema.createTable("posts", (t) => {
    t.string("title", { null: false });
    t.text("body");
    t.integer("views", { default: 0 });
    t.boolean("published", { default: false });
    t.timestamps();
  });

  await schema.createTable("comments", (t) => {
    t.text("body");
    t.references("post");
  });

  await schema.addIndex("posts", ["title"], { unique: true });
});

describe("introspection", () => {
  it("finds every application table", async () => {
    const definition = await introspect(connection);
    expect(definition.tables.map((table) => table.name)).toEqual(["comments", "posts"]);
  });

  // A dump containing schema_migrations would try to recreate it on load.
  it("leaves the framework's own tables out", async () => {
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS ${connection.quote("schema_migrations")} ` +
        `(${connection.quote("version")} VARCHAR(255) NOT NULL PRIMARY KEY)`,
    );

    const definition = await introspect(connection);
    expect(definition.tables.map((table) => table.name)).not.toContain("schema_migrations");
  });

  it("reads columns with their nullability and defaults", async () => {
    const definition = await introspect(connection);
    const posts = definition.tables.find((table) => table.name === "posts")!;

    const title = posts.columns.find((column) => column.name === "title")!;
    expect(title.nullable).toBe(false);

    const body = posts.columns.find((column) => column.name === "body")!;
    expect(body.nullable).toBe(true);

    const views = posts.columns.find((column) => column.name === "views")!;
    expect(views.default).toBe("0");
  });

  it("marks the primary key", async () => {
    const definition = await introspect(connection);
    const posts = definition.tables.find((table) => table.name === "posts")!;

    expect(posts.columns.find((column) => column.name === "id")!.primaryKey).toBe(true);
    // A primary key is implicitly not null, whatever PRAGMA reports.
    expect(posts.columns.find((column) => column.name === "id")!.nullable).toBe(false);
  });

  it("reads declared indexes", async () => {
    const definition = await introspect(connection);
    const posts = definition.tables.find((table) => table.name === "posts")!;

    const index = posts.indexes.find((entry) => entry.name === "index_posts_on_title")!;
    expect(index.columns).toEqual(["title"]);
    expect(index.unique).toBe(true);
  });

  it("records the migration version", async () => {
    expect(await currentVersion(connection)).toBeNull();

    const migration: Migration = {
      version: "20260101000001",
      up: async (s) => s.createTable("widgets", (t) => t.string("name")),
    };
    await new Migrator(connection, [migration]).up();

    expect(await currentVersion(connection)).toBe("20260101000001");
    expect((await introspect(connection)).version).toBe("20260101000001");
  });
});

describe("type mapping", () => {
  it("normalizes the spellings adapters use", () => {
    expect(columnTypeFor("VARCHAR(255)")).toBe("string");
    expect(columnTypeFor("character varying")).toBe("string");
    expect(columnTypeFor("TEXT")).toBe("text");
    expect(columnTypeFor("INTEGER")).toBe("integer");
    expect(columnTypeFor("BIGINT")).toBe("bigint");
    expect(columnTypeFor("DOUBLE PRECISION")).toBe("float");
    expect(columnTypeFor("JSONB")).toBe("json");
    expect(columnTypeFor("BYTEA")).toBe("binary");
    expect(columnTypeFor("TIMESTAMP")).toBe("datetime");
  });

  // The type describes what a driver returns, not what the column means. A
  // SQLite boolean arrives as 0 or 1, and saying otherwise would make the
  // generated type wrong in the same way a hand-written one is.
  it("describes what the driver actually returns", () => {
    const column = { name: "x", nullable: false, default: null, primaryKey: false };

    expect(tsTypeFor({ ...column, type: "INTEGER" })).toBe("number");
    expect(tsTypeFor({ ...column, type: "TEXT" })).toBe("string");
    expect(tsTypeFor({ ...column, type: "DATETIME" })).toBe("string");
    expect(tsTypeFor({ ...column, type: "BOOLEAN" })).toBe("number | boolean");
    expect(tsTypeFor({ ...column, type: "JSON" })).toBe("unknown");
  });

  it("names the interface after the singular table", () => {
    expect(rowTypeName("posts")).toBe("PostRow");
    expect(rowTypeName("line_items")).toBe("LineItemRow");
  });
});

describe("dumping types", () => {
  it("emits an interface per table", async () => {
    const types = dumpTypes(await introspect(connection));

    expect(types).toContain("export interface PostRow {");
    expect(types).toContain("export interface CommentRow {");
  });

  it("types each column from the database", async () => {
    const types = dumpTypes(await introspect(connection));

    expect(types).toContain("id: number;");
    expect(types).toContain("title: string;");
    expect(types).toContain("views: number | null;");
  });

  // This is the bug the whole file exists to prevent: a nullable column typed
  // as non-null is the compiler confidently reporting a shape the database
  // does not have.
  it("marks a nullable column nullable", async () => {
    const types = dumpTypes(await introspect(connection));

    expect(types).toContain("body: string | null;");
    expect(types).not.toContain("title: string | null;");
  });

  it("says it is generated", async () => {
    expect(dumpTypes(await introspect(connection))).toContain("do not edit by hand");
  });

  it("emits a table map", async () => {
    const types = dumpTypes(await introspect(connection));
    expect(types).toContain('"posts": PostRow;');
  });

  it("quotes a column name that is not an identifier", () => {
    const types = dumpTypes({
      version: null,
      tables: [
        {
          name: "odd",
          columns: [
            { name: "some-column", type: "TEXT", nullable: true, default: null, primaryKey: false },
          ],
          indexes: [],
        },
      ],
    });

    expect(types).toContain('"some-column": string | null;');
  });
});

describe("dumping the schema", () => {
  it("emits a loadable definition", async () => {
    const dumped = dumpSchema(await introspect(connection));

    expect(dumped).toContain("const schema: SchemaDefinition = {");
    expect(dumped).toContain('name: "posts"');
    expect(dumped).toContain("export default schema;");
  });

  it("records the version it was taken at", async () => {
    const definition = await introspect(connection);
    definition.version = "20260101000001";

    expect(dumpSchema(definition)).toContain('version: "20260101000001"');
  });
});

// The round trip loads a dump into a second, independent empty database.
// In-memory SQLite hands one out for free; on a server it would mean
// provisioning a second database, which the introspection cases above already
// cover the risky half of.
describe.skipIf(!isSqlite)("loading a dumped schema", () => {
  // A dump that cannot be loaded is worse than none, because it fails when
  // someone is preparing a test database.
  it("recreates every table in a fresh database", async () => {
    const definition = await introspect(connection);

    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);

    const reloaded = await introspect(fresh);
    expect(reloaded.tables.map((table) => table.name)).toEqual(["comments", "posts"]);
  });

  it("keeps columns, nullability and defaults", async () => {
    const definition = await introspect(connection);
    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);

    const posts = (await introspect(fresh)).tables.find((table) => table.name === "posts")!;

    expect(posts.columns.map((column) => column.name).sort()).toEqual(
      ["body", "created_at", "id", "published", "title", "updated_at", "views"].sort(),
    );
    expect(posts.columns.find((column) => column.name === "title")!.nullable).toBe(false);
    expect(posts.columns.find((column) => column.name === "body")!.nullable).toBe(true);
  });

  it("keeps the primary key", async () => {
    const definition = await introspect(connection);
    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);

    const posts = (await introspect(fresh)).tables.find((table) => table.name === "posts")!;
    expect(posts.columns.find((column) => column.name === "id")!.primaryKey).toBe(true);
  });

  it("recreates indexes", async () => {
    const definition = await introspect(connection);
    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);

    const posts = (await introspect(fresh)).tables.find((table) => table.name === "posts")!;
    expect(posts.indexes.map((index) => index.name)).toContain("index_posts_on_title");
  });

  // A database loaded from a dump must not look unmigrated, or the next
  // migrate run would replay everything.
  it("records the version so the database does not look unmigrated", async () => {
    const definition = await introspect(connection);
    definition.version = "20260101000001";

    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);

    expect(await currentVersion(fresh)).toBe("20260101000001");
  });

  it("accepts a schema with no tables", async () => {
    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, { version: null, tables: [] });

    expect((await introspect(fresh)).tables).toEqual([]);
  });

  // The real use case: prepare a database from the dump, then use models
  // against it. A schema that loads but that the ORM cannot write to would
  // pass every structural assertion above and still be useless.
  it("is usable by a model", async () => {
    const definition = await introspect(connection);
    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);
    setConnection(fresh);

    class Post extends Model<{ id: number; title: string; body: string | null }>("posts") {}

    const post = await Post.create({ title: "Hello", body: "World" });

    expect(post.id).toBe(1);
    expect((await Post.find(1)).title).toBe("Hello");
  });

  // NOT NULL survives the round trip, which is what makes the dump faithful
  // rather than merely structural.
  it("keeps a NOT NULL column enforced", async () => {
    const definition = await introspect(connection);
    const fresh = new Connection("sqlite://:memory:");
    await loadSchema(fresh, definition);

    await expect(
      fresh.execute("INSERT INTO posts (body) VALUES (?)", ["no title"]),
    ).rejects.toThrow();
  });
});
