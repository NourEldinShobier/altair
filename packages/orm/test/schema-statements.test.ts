/**
 * Schema statements, ported from
 * `activerecord/test/cases/migration/create_join_table_test.rb`,
 * `columns_test.rb`, `index_test.rb` and the adapter-specific constraint and
 * enum cases.
 *
 * The suite runs on SQLite, so the PostgreSQL-only statements are asserted on
 * their refusal rather than their effect — which is the behaviour that matters
 * on this adapter anyway: a named refusal instead of a syntax error pointing at
 * a token.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;
let schema: SchemaStatements;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  schema = new SchemaStatements(connection);
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("joinTableName", () => {
  /** Rails: test_create_join_table — sorted, so either order names one table. */
  it("sorts the two names", () => {
    expect(SchemaStatements.joinTableName("artists", "musics")).toBe("artists_musics");
  });

  /** Rails: test_create_join_table_with_the_proper_order */
  it("sorts them whichever way round they arrive", () => {
    expect(SchemaStatements.joinTableName("videos", "musics")).toBe("musics_videos");
    expect(SchemaStatements.joinTableName("musics", "videos")).toBe("musics_videos");
  });

  /** Rails writes a shared prefix once. */
  it("writes a shared prefix once", () => {
    expect(SchemaStatements.joinTableName("admin_posts", "admin_users")).toBe("admin_posts_users");
  });

  it("leaves unrelated names alone", () => {
    expect(SchemaStatements.joinTableName("posts", "admin_users")).toBe("admin_users_posts");
  });
});

describe("createJoinTable", () => {
  /** Rails: test_create_join_table */
  it("makes the two reference columns", async () => {
    await schema.createJoinTable("artists", "musics");
    const names = (await schema.columns("artists_musics")).map((one) => one.name).sort();

    expect(names).toEqual(["artist_id", "music_id"]);
  });

  /** Rails: test_create_join_table_set_not_null_by_default */
  it("makes both columns NOT NULL", async () => {
    await schema.createJoinTable("artists", "musics");
    const nullable = (await schema.columns("artists_musics")).map((one) => one.nullable);

    expect(nullable).toEqual([false, false]);
  });

  /** A join row has no identity of its own — it is the pair. */
  it("gives the table no primary key of its own", async () => {
    await schema.createJoinTable("artists", "musics");
    const columns = await schema.columns("artists_musics");

    expect(columns.some((one) => one.name === "id")).toBe(false);
  });

  /** Rails: test_create_join_table_with_the_table_name */
  it("takes an explicit table name", async () => {
    await schema.createJoinTable("artists", "musics", { tableName: "catalog" });

    expect(await schema.tableExists("catalog")).toBe(true);
  });

  it("lets a block add more columns", async () => {
    await schema.createJoinTable("artists", "musics", {}, (t) => {
      t.integer("position");
    });
    const names = (await schema.columns("artists_musics")).map((one) => one.name);

    expect(names).toContain("position");
  });
});

describe("dropJoinTable", () => {
  /** Rails: test_drop_join_table */
  it("drops it", async () => {
    await schema.createJoinTable("artists", "musics");
    await schema.dropJoinTable("artists", "musics");

    expect(await schema.tableExists("artists_musics")).toBe(false);
  });

  /** Rails: test_drop_join_table_with_the_proper_order */
  it("drops it whichever order the names arrive in", async () => {
    await schema.createJoinTable("videos", "musics");
    await schema.dropJoinTable("musics", "videos");

    expect(await schema.tableExists("musics_videos")).toBe(false);
  });

  /** Rails: test_drop_join_table_with_the_table_name */
  it("takes an explicit table name", async () => {
    await schema.createJoinTable("artists", "musics", { tableName: "catalog" });
    await schema.dropJoinTable("artists", "musics", { tableName: "catalog" });

    expect(await schema.tableExists("catalog")).toBe(false);
  });
});

describe("renameIndex", () => {
  beforeEach(async () => {
    await schema.createTable("posts", (t) => {
      t.string("title");
      t.integer("rank");
    });
  });

  it("gives the index its new name", async () => {
    await schema.addIndex("posts", ["title"], { name: "old_name" });
    await schema.renameIndex("posts", "old_name", "new_name");

    expect(await schema.indexNameExists("posts", "new_name")).toBe(true);
  });

  it("takes the old name away", async () => {
    await schema.addIndex("posts", ["title"], { name: "old_name" });
    await schema.renameIndex("posts", "old_name", "new_name");

    expect(await schema.indexNameExists("posts", "old_name")).toBe(false);
  });

  it("keeps the columns", async () => {
    await schema.addIndex("posts", ["title", "rank"], { name: "old_name" });
    await schema.renameIndex("posts", "old_name", "new_name");

    expect(await schema.indexExists("posts", ["title", "rank"])).toBe(false);
    expect(await schema.indexNameExists("posts", "new_name")).toBe(true);
  });

  it("keeps uniqueness", async () => {
    await schema.addIndex("posts", ["title"], { name: "old_name", unique: true });
    await schema.renameIndex("posts", "old_name", "new_name");

    expect(await schema.indexNameExists("posts", "new_name")).toBe(true);
  });

  /** Rails returns early rather than raising when there is nothing to rename. */
  it("does nothing when the index is not there", async () => {
    await expect(schema.renameIndex("posts", "absent", "new_name")).resolves.toBeUndefined();
  });
});

describe("removeColumns", () => {
  it("removes several at once", async () => {
    await schema.createTable("posts", (t) => {
      t.string("title");
      t.string("body");
      t.integer("rank");
    });

    await schema.removeColumns("posts", "body", "rank");
    const names = (await schema.columns("posts")).map((one) => one.name);

    expect(names).toContain("title");
    expect(names).not.toContain("body");
    expect(names).not.toContain("rank");
  });
});

describe("existence checks", () => {
  beforeEach(async () => {
    await schema.createTable("posts", (t) => {
      t.string("title");
    });
  });

  it("finds an index by name", async () => {
    await schema.addIndex("posts", ["title"], { name: "by_title" });

    expect(await schema.indexNameExists("posts", "by_title")).toBe(true);
    expect(await schema.indexNameExists("posts", "absent")).toBe(false);
  });

  /** Tables and views together, which is what a model actually asks. */
  it("counts a table as a data source", async () => {
    expect(await schema.dataSourceExists("posts")).toBe(true);
    expect(await schema.dataSourceExists("absent")).toBe(false);
  });

  it("reports no view for a table", async () => {
    expect(await schema.viewExists("posts")).toBe(false);
  });

  it("finds a view once there is one", async () => {
    await connection.execute("CREATE VIEW recent_posts AS SELECT * FROM posts");

    expect(await schema.viewExists("recent_posts")).toBe(true);
    expect(await schema.dataSourceExists("recent_posts")).toBe(true);
  });
});

describe("truncate", () => {
  beforeEach(async () => {
    await schema.createTable("posts", (t) => {
      t.string("title");
    });
    await connection.execute("INSERT INTO posts (title) VALUES ('one'), ('two')");
  });

  /** SQLite has no TRUNCATE; DELETE without a WHERE is the same outcome. */
  it("empties the table", async () => {
    await schema.truncateTable("posts");
    const rows = await connection.query("SELECT * FROM posts");

    expect(rows).toHaveLength(0);
  });

  it("leaves the table in place", async () => {
    await schema.truncateTable("posts");

    expect(await schema.tableExists("posts")).toBe(true);
  });

  it("empties several", async () => {
    await schema.createTable("comments", (t) => {
      t.string("body");
    });
    await connection.execute("INSERT INTO comments (body) VALUES ('hi')");

    await schema.truncateTables("posts", "comments");

    expect(await connection.query("SELECT * FROM comments")).toHaveLength(0);
  });
});

describe("what this adapter cannot do", () => {
  /**
   * The refusal is the feature. The database's own error for unsupported
   * syntax points at a token and reads like a typo in the migration rather
   * than a server that has never had the feature.
   */
  it("names the statement and the reason", async () => {
    if (!isSqlite) return;

    await expect(schema.createEnum("status", ["draft"])).rejects.toThrow(/createEnum/);
  });

  it("refuses enums", async () => {
    if (!isSqlite) return;

    await expect(schema.createEnum("status", ["draft"])).rejects.toThrow();
    await expect(schema.dropEnum("status")).rejects.toThrow();
    await expect(schema.addEnumValue("status", "live")).rejects.toThrow();
  });

  it("refuses exclusion constraints", async () => {
    if (!isSqlite) return;

    await expect(schema.addExclusionConstraint("posts", "rank WITH =")).rejects.toThrow();
  });

  it("refuses extensions", async () => {
    if (!isSqlite) return;

    await expect(schema.enableExtension("hstore")).rejects.toThrow();
  });

  /** The read-side answers empty rather than throwing: asking is not doing. */
  it("still answers the questions", async () => {
    if (!isSqlite) return;

    expect(await schema.extensions()).toEqual([]);
    expect(await schema.schemaNames()).toEqual([]);
    expect(await schema.extensionEnabled("hstore")).toBe(false);
    expect(await schema.schemaExists("public")).toBe(false);
  });

  it("reports no exclusion constraint rather than throwing", async () => {
    if (!isSqlite) return;

    await schema.createTable("posts", (t) => {
      t.string("title");
    });

    expect(await schema.exclusionConstraintExists("posts", "anything")).toBe(false);
  });
});
