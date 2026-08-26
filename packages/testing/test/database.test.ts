/**
 * Transactional tests and test databases.
 *
 * Mirrors activerecord/test/cases/transactional_tests_test.rb and the setup
 * half of fixtures_test.rb. The load-bearing case is the pair of tests that
 * write the same row: if isolation is broken they pass in isolation and fail
 * together, which is the worst failure a test helper can have.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Model, connection, type SchemaDefinition } from "@altair/orm";
import { TestDatabase, transactionalTests } from "../src/database.js";

// Set by CI to run this suite against a real server, where a transaction
// has to be pinned to one pooled connection to isolate anything.
const url = process.env.ALTAIR_TEST_DATABASE_URL;

const SCHEMA: SchemaDefinition = {
  version: "20260101000001",
  tables: [
    {
      name: "posts",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, default: null, primaryKey: true },
        { name: "title", type: "VARCHAR(255)", nullable: false, default: null, primaryKey: false },
        { name: "views", type: "INTEGER", nullable: true, default: "0", primaryKey: false },
      ],
      indexes: [],
    },
  ],
};

interface PostRow {
  id: number;
  title: string;
  views: number | null;
}

class Post extends Model<PostRow>("posts") {}

describe("preparing a test database", () => {
  it("creates every table in the schema", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url });

    expect(database.tables).toEqual(["posts"]);
    expect(await database.count("posts")).toBe(0);

    await database.close();
  });

  // The point of preparing from a dump rather than replaying migrations.
  it("records the schema version", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url });

    const rows = await database.connection.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    expect(rows[0]?.version).toBe("20260101000001");

    await database.close();
  });

  it("becomes the connection models use", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url });

    expect(connection()).toBe(database.connection);

    await database.close();
  });

  it("leaves the global connection alone when asked to", async () => {
    const before = connection();
    const database = await TestDatabase.prepare(SCHEMA, { url, global: false });

    expect(connection()).toBe(before);

    await database.close();
  });
});

describe("transactional tests", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await TestDatabase.prepare(SCHEMA, { url });
  });

  afterAll(async () => {
    await database.close();
  });

  const { setup, teardown } = transactionalTests(() => database);
  beforeEach(setup);
  afterEach(teardown);

  // These two are a pair. Either both pass, or isolation does not work.
  it("writes a record", async () => {
    await Post.create({ title: "First" });
    expect(await Post.count()).toBe(1);
  });

  it("does not see what the previous test wrote", async () => {
    expect(await Post.count()).toBe(0);
  });

  it("rolls back a record created in a helper too", async () => {
    await Post.create({ title: "From a helper" });
    await Post.create({ title: "And another" });
    expect(await Post.count()).toBe(2);
  });

  it("still starts empty", async () => {
    expect(await Post.count()).toBe(0);
  });

  // A test that opens its own transaction nests inside the test's, rather than
  // committing through it — which would leak past the rollback.
  it("allows a transaction inside a test", async () => {
    await Post.transaction(async () => {
      await Post.create({ title: "Inside" });
    });

    expect(await Post.count()).toBe(1);
  });

  it("rolls back a nested transaction that committed", async () => {
    expect(await Post.count()).toBe(0);
  });
});

describe("transaction bookkeeping", () => {
  it("refuses to open a second transaction", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url, global: false });
    await database.begin();

    await expect(database.begin()).rejects.toThrow("already open");

    await database.close();
  });

  it("tolerates a rollback with nothing open", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url, global: false });

    await database.rollback();

    await database.close();
  });

  /**
   * This asserted nothing at all: it created a row, closed, and ended. It
   * passed whether `close` rolled back or committed, which is the one thing it
   * exists to tell apart — and a helper that commits between tests is how a
   * suite starts passing in isolation and failing together.
   */
  it("rolls back on close", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url });
    await database.begin();
    await Post.create({ title: "Never committed" });

    expect(await database.count("posts")).toBe(1);

    await database.close();

    // Asked of a new connection, because the old one went with the rollback.
    const after = await TestDatabase.prepare(SCHEMA, { url });

    try {
      expect(await after.count("posts")).toBe(0);
    } finally {
      await after.close();
    }
  });
});

describe("the truncation strategy", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await TestDatabase.prepare(SCHEMA, { url, strategy: "truncation" });
  });

  afterAll(async () => {
    await database.close();
  });

  const { setup, teardown } = transactionalTests(() => database);
  beforeEach(setup);
  afterEach(teardown);

  it("writes a record", async () => {
    await Post.create({ title: "First" });
    expect(await Post.count()).toBe(1);
  });

  it("starts from an empty table", async () => {
    expect(await Post.count()).toBe(0);
  });

  // Ids climbing across tests would make an assertion about id 1 depend on
  // which tests ran before it.
  it("restarts the primary key", async () => {
    const post = await Post.create({ title: "First again" });
    expect(post.id).toBe(1);
  });
});
