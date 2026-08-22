/**
 * Fixtures and factories.
 *
 * Mirrors activerecord/test/cases/fixtures_test.rb: records referred to by
 * name, loaded once, and an error that names the fixture rather than failing
 * later with a null.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Model, type SchemaDefinition } from "@altair/orm";
import { TestDatabase, transactionalTests } from "../src/database.js";

import { defineFactory, defineFixtures, FixtureNotFound } from "../src/fixtures.js";

// Set by CI to run this suite against a real server, where a transaction
// has to be pinned to one pooled connection to isolate anything.
const url = process.env.ALTAIR_TEST_DATABASE_URL;

const SCHEMA: SchemaDefinition = {
  version: null,
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

const posts = defineFixtures(Post, {
  welcome: { title: "Welcome", views: 10 },
  goodbye: { title: "Goodbye", views: 2 },
});

const postFactory = defineFactory(Post, (sequence) => ({
  title: `Post ${sequence}`,
  views: 0,
}));

describe("factories", () => {
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

  beforeEach(() => {
    postFactory.reset();
  });

  it("builds without touching the database", async () => {
    const post = postFactory.build();

    expect(post.title).toBe("Post 1");
    expect(await Post.count()).toBe(0);
  });

  it("counts up, so a unique column stays unique", () => {
    expect(postFactory.build().title).toBe("Post 1");
    expect(postFactory.build().title).toBe("Post 2");
  });

  it("takes overrides", () => {
    expect(postFactory.build({ title: "Custom" }).title).toBe("Custom");
  });

  it("saves a record", async () => {
    const post = await postFactory.create();

    expect(post.isPersisted).toBe(true);
    expect(await Post.count()).toBe(1);
  });

  it("saves a list, each with its own sequence", async () => {
    const created = await postFactory.createList(3);

    expect(created.map((post) => post.title)).toEqual(["Post 1", "Post 2", "Post 3"]);
    expect(await Post.count()).toBe(3);
  });

  it("restarts the counter", () => {
    postFactory.build();
    postFactory.reset();

    expect(postFactory.build().title).toBe("Post 1");
  });
});

describe("fixtures", () => {
  let database: TestDatabase;

  // Loaded once, before the per-test transaction opens, so every test starts
  // from the same rows. Loading inside the transaction would roll them back.
  beforeAll(async () => {
    database = await TestDatabase.prepare(SCHEMA, { url });
    await posts.load();
  });

  afterAll(async () => {
    await database.close();
  });

  const { setup, teardown } = transactionalTests(() => database);
  beforeEach(setup);
  afterEach(teardown);

  it("inserts every record", async () => {
    expect(await Post.count()).toBe(2);
  });

  it("finds a record by name", () => {
    expect(posts.get("welcome").title).toBe("Welcome");
    expect(posts.get("goodbye").views).toBe(2);
  });

  it("hands back a persisted record with its id", () => {
    const welcome = posts.get("welcome");

    expect(welcome.isPersisted).toBe(true);
    expect(welcome.id).toBeGreaterThan(0);
    expect(posts.id("welcome")).toBe(welcome.id);
  });

  it("lists the names it knows", () => {
    expect(posts.names).toEqual(["welcome", "goodbye"]);
  });

  // A shared instance would let a test that mutated one leak into the next,
  // which the rollback does not undo — it covers the database, not objects
  // held in memory.
  it("hands back a fresh instance each time", () => {
    const first = posts.get("welcome");
    first.title = "Mutated";

    expect(posts.get("welcome").title).toBe("Welcome");
  });

  it("survives a test that deleted everything", async () => {
    await Post.destroyAll();
    expect(await Post.count()).toBe(0);
  });

  it("still has both records", async () => {
    expect(await Post.count()).toBe(2);
  });

  it("names the fixture when there is no such one", () => {
    // @ts-expect-error the name is not one of the defined fixtures
    expect(() => posts.get("missing")).toThrow(FixtureNotFound);
    // @ts-expect-error the name is not one of the defined fixtures
    expect(() => posts.get("missing")).toThrow("welcome, goodbye");
  });
});

describe("fixtures that were never loaded", () => {
  it("says so, rather than reporting the name as unknown", async () => {
    const database = await TestDatabase.prepare(SCHEMA, { url });
    const unloaded = defineFixtures(Post, { welcome: { title: "Welcome" } });

    expect(() => unloaded.get("welcome")).toThrow("have not been loaded");

    await database.close();
  });
});
