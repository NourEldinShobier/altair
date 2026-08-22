/**
 * Migration and schema suite.
 *
 * Mirrors activerecord/test/cases/migration_test.rb and the schema statement
 * tests. Runs against an in-memory SQLite database through Bun.sql, so it needs
 * no setup and no external service.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, adapterFor } from "../src/connection.js";
import { columnNamesOf, indexNamesOf, testConnection } from "./support/database.js";
import { Migrator, SchemaStatements, type Migration } from "../src/schema.js";

let connection: Connection;
let schema: SchemaStatements;

beforeEach(async () => {
  connection = await testConnection();
  schema = new SchemaStatements(connection);
});

describe("adapter detection", () => {
  it("reads the adapter from the URL", () => {
    expect(adapterFor("sqlite://app.db")).toBe("sqlite");
    expect(adapterFor("postgres://localhost/app")).toBe("postgres");
    expect(adapterFor("postgresql://localhost/app")).toBe("postgres");
    expect(adapterFor("mysql://localhost/app")).toBe("mysql");
    expect(adapterFor("mysql2://localhost/app")).toBe("mysql");
  });

  it("quotes identifiers per adapter", () => {
    expect(new Connection("sqlite://:memory:").quote("posts")).toBe('"posts"');
    expect(connection.quote('we"ird')).toBe('"we""ird"');
  });

  it("numbers placeholders only where the adapter needs it", () => {
    expect(connection.placeholder(0)).toBe("?");
    expect(connection.placeholder(3)).toBe("?");
  });
});

describe("createTable", () => {
  it("creates a table with an id and typed columns", async () => {
    await schema.createTable("posts", (t) => {
      t.string("title", { null: false });
      t.text("body");
      t.boolean("published", { default: false });
      t.integer("views", { default: 0 });
      t.timestamps();
    });

    expect(await schema.tableExists("posts")).toBe(true);

    await connection.execute(
      "INSERT INTO posts (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ["Hello", "World", "2026-01-01", "2026-01-01"],
    );

    const rows = await connection.query<{ id: number; title: string; views: number }>(
      "SELECT * FROM posts",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.title).toBe("Hello");
    expect(rows[0]!.views).toBe(0);
  });

  // Rails: NOT NULL is enforced by the database, not the model.
  it("enforces null: false", async () => {
    await schema.createTable("posts", (t) => t.string("title", { null: false }));

    await expect(connection.execute("INSERT INTO posts (title) VALUES (NULL)")).rejects.toThrow();
  });

  it("creates a table without an id when asked", async () => {
    await schema.createTable("joins", (t) => t.integer("left_id"), { id: false });

    expect(await columnNamesOf(connection, "joins")).toEqual(["left_id"]);
  });

  // Rails: t.references adds <name>_id and indexes it.
  it("adds a reference column with an index", async () => {
    await schema.createTable("posts", (t) => t.string("title"));
    await schema.createTable("comments", (t) => {
      t.text("body");
      t.references("post");
    });

    expect(await columnNamesOf(connection, "comments")).toContain("post_id");
    expect(await indexNamesOf(connection, "comments")).toContain("index_comments_on_post_id");
  });

  // Rails: t.timestamps adds both columns, NOT NULL.
  it("adds timestamps", async () => {
    await schema.createTable("posts", (t) => t.timestamps());

    const names = await columnNamesOf(connection, "posts");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
  });

  it("honours ifNotExists", async () => {
    await schema.createTable("posts", (t) => t.string("title"));
    await schema.createTable("posts", (t) => t.string("title"), { ifNotExists: true });
    expect(await schema.tableExists("posts")).toBe(true);
  });

  it("applies a unique column", async () => {
    await schema.createTable("users", (t) => t.string("email", { unique: true }));

    await connection.execute("INSERT INTO users (email) VALUES ('a@b.c')");
    await expect(
      connection.execute("INSERT INTO users (email) VALUES ('a@b.c')"),
    ).rejects.toThrow();
  });
});

describe("altering", () => {
  beforeEach(async () => {
    await schema.createTable("posts", (t) => t.string("title"));
  });

  it("adds a column", async () => {
    await schema.addColumn("posts", "slug", "string");
    expect(await columnNamesOf(connection, "posts")).toContain("slug");
  });

  it("removes a column", async () => {
    await schema.addColumn("posts", "slug", "string");
    await schema.removeColumn("posts", "slug");
    expect(await columnNamesOf(connection, "posts")).not.toContain("slug");
  });

  it("renames a table", async () => {
    await schema.renameTable("posts", "articles");
    expect(await schema.tableExists("articles")).toBe(true);
    expect(await schema.tableExists("posts")).toBe(false);
  });

  it("drops a table", async () => {
    await schema.dropTable("posts");
    expect(await schema.tableExists("posts")).toBe(false);
  });

  it("adds and removes an index", async () => {
    await schema.addIndex("posts", ["title"], { unique: true });
    expect(await indexNamesOf(connection, "posts")).toContain("index_posts_on_title");

    await schema.removeIndex("posts", { name: "index_posts_on_title" });
    expect(await indexNamesOf(connection, "posts")).not.toContain("index_posts_on_title");
  });

  it("lists tables, ignoring sqlite internals", async () => {
    await schema.createTable("comments", (t) => t.text("body"));
    const tables = await schema.tables();

    expect(tables).toContain("posts");
    expect(tables).toContain("comments");
    expect(tables.some((t) => t.startsWith("sqlite_"))).toBe(false);
  });
});

describe("migrator", () => {
  const createPosts: Migration = {
    version: "20260101000001",
    name: "CreatePosts",
    up: async (s) => s.createTable("posts", (t) => t.string("title")),
    down: async (s) => s.dropTable("posts"),
  };

  const addSlug: Migration = {
    version: "20260101000002",
    name: "AddSlugToPosts",
    up: async (s) => s.addColumn("posts", "slug", "string"),
    down: async (s) => s.removeColumn("posts", "slug"),
  };

  it("runs pending migrations in version order", async () => {
    const migrator = new Migrator(connection, [addSlug, createPosts]);
    const ran = await migrator.up();

    expect(ran.map((m) => m.version)).toEqual([createPosts.version, addSlug.version]);

    expect(await columnNamesOf(connection, "posts")).toContain("slug");
  });

  // Rails: a migration runs once, and is recorded in schema_migrations.
  it("does not run a migration twice", async () => {
    const migrator = new Migrator(connection, [createPosts]);

    expect(await migrator.up()).toHaveLength(1);
    expect(await migrator.up()).toHaveLength(0);
    expect(await migrator.appliedVersions()).toEqual([createPosts.version]);
  });

  it("reports what is pending", async () => {
    const migrator = new Migrator(connection, [createPosts, addSlug]);
    expect(await migrator.pending()).toHaveLength(2);

    await migrator.up();
    expect(await migrator.pending()).toHaveLength(0);
  });

  // Rails: db:rollback reverts the last migration.
  it("rolls back the last migration", async () => {
    const migrator = new Migrator(connection, [createPosts, addSlug]);
    await migrator.up();

    const reverted = await migrator.down();
    expect(reverted.map((m) => m.version)).toEqual([addSlug.version]);

    const columns = await connection.query<{ name: string }>("PRAGMA table_info(posts)");
    expect(columns.map((c) => c.name)).not.toContain("slug");
    expect(await migrator.appliedVersions()).toEqual([createPosts.version]);
  });

  it("rolls back several steps", async () => {
    const migrator = new Migrator(connection, [createPosts, addSlug]);
    await migrator.up();

    await migrator.down(2);
    expect(await migrator.appliedVersions()).toEqual([]);
    expect(await schema.tableExists("posts")).toBe(false);
  });

  // Rails: IrreversibleMigration
  it("refuses to roll back a migration with no down", async () => {
    const irreversible: Migration = {
      version: "20260101000003",
      up: async (s) => s.createTable("logs", (t) => t.text("message")),
    };
    const migrator = new Migrator(connection, [irreversible]);
    await migrator.up();

    await expect(migrator.down()).rejects.toThrow("irreversible");
  });
});

describe("transactions", () => {
  beforeEach(async () => {
    await schema.createTable("posts", (t) => t.string("title"));
  });

  it("commits when the block returns", async () => {
    await connection.transaction(async (tx) => {
      await tx.execute("INSERT INTO posts (title) VALUES ('committed')");
    });

    expect(await connection.query("SELECT * FROM posts")).toHaveLength(1);
  });

  it("rolls back when the block throws", async () => {
    await expect(
      connection.transaction(async (tx) => {
        await tx.execute("INSERT INTO posts (title) VALUES ('rolled back')");
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(await connection.query("SELECT * FROM posts")).toHaveLength(0);
  });

  it("returns the block's value", async () => {
    const result = await connection.transaction(async () => "value");
    expect(result).toBe("value");
  });
});
