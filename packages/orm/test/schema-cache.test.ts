/**
 * Remembering what a table looks like, ported from
 * `activerecord/test/cases/connection_adapters/schema_cache_test.rb`.
 *
 * Introspection is several queries per table, and the answer changes only when
 * a migration runs. The first request that touches a model otherwise pays for
 * that model's introspection — on every process, so a deploy that starts
 * twenty workers pays it twenty times at once, against a database that is also
 * serving.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import {
  SchemaCache,
  SchemaReflection,
  checkSchemaFile,
  defaultSchemaCachePath,
  isSchemaCacheCurrent,
  lazySchemaCachePath,
  schemaCachePath,
} from "../src/schema-cache.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;
/** Every query the cache lets through, so a hit can be told from a miss. */
let queries: string[];

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  queries = [];

  const schema = new SchemaStatements(connection);
  await schema.createTable("posts", (t) => {
    t.string("title");
    t.integer("views");
  });
  await schema.createTable("comments", (t) => {
    t.integer("post_id");
  });

  // A version to compare a dump against. Without one every cache is "unknown
  // version", which is refused — correctly, and it would hide every other
  // assertion here behind the same false.
  await connection.execute(
    "CREATE TABLE schema_migrations (version varchar(255) NOT NULL PRIMARY KEY)",
    [],
  );
  await connection.execute("INSERT INTO schema_migrations (version) VALUES ('20260101000000')", []);

  // Introspection reads through `query`, not `execute`.
  const query = connection.query.bind(connection);
  connection.query = (async (sql: string, binds?: unknown[]) => {
    queries.push(sql);

    return query(sql, binds as never);
  }) as typeof connection.query;
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("reading through the cache", () => {
  it("reads a table's columns", async () => {
    const cache = new SchemaCache();

    const columns = await cache.columns(connection, "posts");

    expect(columns.map((c) => c.name)).toContain("title");
  });

  /** The point: the second question costs nothing. */
  it("does not ask the database twice", async () => {
    const cache = new SchemaCache();

    await cache.columns(connection, "posts");
    const asked = queries.length;
    await cache.columns(connection, "posts");

    expect(queries.length).toBe(asked);
  });

  it("caches each table separately", async () => {
    const cache = new SchemaCache();

    await cache.columns(connection, "posts");
    const asked = queries.length;
    await cache.columns(connection, "comments");

    expect(queries.length).toBeGreaterThan(asked);
  });

  it("says which tables it already knows", async () => {
    const cache = new SchemaCache();

    expect(cache.cached("posts")).toBe(false);

    await cache.columns(connection, "posts");

    expect(cache.cached("posts")).toBe(true);
  });

  it("keys the columns by name, which is how they are looked up", async () => {
    const cache = new SchemaCache();

    const hash = await cache.columnsHash(connection, "posts");

    expect(hash["title"]?.name).toBe("title");
  });

  it("does not ask again for the keyed form", async () => {
    const cache = new SchemaCache();

    await cache.columns(connection, "posts");
    const asked = queries.length;
    await cache.columnsHash(connection, "posts");

    expect(queries.length).toBe(asked);
  });

  it("reads a table's indexes", async () => {
    const cache = new SchemaCache();

    await expect(cache.indexes(connection, "posts")).resolves.toBeArray();
  });

  it("does not ask for indexes twice either", async () => {
    const cache = new SchemaCache();

    await cache.indexes(connection, "posts");
    const asked = queries.length;
    await cache.indexes(connection, "posts");

    expect(queries.length).toBe(asked);
  });

  /**
   * Plural because a join table keyed on both foreign keys has two, and a
   * caller assuming one writes an UPDATE matching more rows than it meant to.
   */
  it("reports the primary key columns", async () => {
    const cache = new SchemaCache();

    expect(await cache.primaryKeys(connection, "posts")).toEqual(["id"]);
  });

  it("says whether a table exists", async () => {
    const cache = new SchemaCache();

    expect(await cache.dataSourceExists(connection, "posts")).toBe(true);
    expect(await cache.dataSourceExists(connection, "nowhere")).toBe(false);
  });

  /** A missing table is missing for the whole process; re-asking makes absence the expensive case. */
  it("caches a no as firmly as a yes", async () => {
    const cache = new SchemaCache();

    await cache.dataSourceExists(connection, "nowhere");
    const asked = queries.length;
    await cache.dataSourceExists(connection, "nowhere");

    expect(queries.length).toBe(asked);
  });

  it("can be told a table exists without asking", async () => {
    const cache = new SchemaCache();

    cache.add("posts");
    const asked = queries.length;

    expect(await cache.dataSourceExists(connection, "posts")).toBe(true);
    expect(queries.length).toBe(asked);
  });
});

describe("clearing", () => {
  /**
   * A migration changed one table; throwing away everything means the next
   * request re-reads schema it already had.
   */
  it("forgets one table and keeps the rest", async () => {
    const cache = new SchemaCache();
    await cache.columns(connection, "posts");
    await cache.columns(connection, "comments");

    cache.clearDataSourceCache("posts");

    expect(cache.cached("posts")).toBe(false);
    expect(cache.cached("comments")).toBe(true);
  });

  it("asks again for a table it forgot", async () => {
    const cache = new SchemaCache();
    await cache.columns(connection, "posts");
    cache.clearDataSourceCache("posts");

    const asked = queries.length;
    await cache.columns(connection, "posts");

    expect(queries.length).toBeGreaterThan(asked);
  });

  it("forgets everything", async () => {
    const cache = new SchemaCache();
    await cache.columns(connection, "posts");
    await cache.columns(connection, "comments");

    cache.clear();

    expect(cache.cached("posts")).toBe(false);
    expect(cache.size).toBe(0);
  });
});

describe("dumping and loading", () => {
  it("reads every table at once", async () => {
    const cache = new SchemaCache();

    await cache.addAll(connection);

    expect(cache.cached("posts")).toBe(true);
    expect(cache.cached("comments")).toBe(true);
  });

  it("carries the migration version it was taken at", async () => {
    const cache = new SchemaCache();

    await cache.addAll(connection);

    expect(cache.schemaVersion).toBe(await currentVersionOf(connection));
  });

  it("round-trips through a dump", async () => {
    const cache = new SchemaCache();
    await cache.addAll(connection);

    const loaded = SchemaCache.fromDump(cache.toDump());

    expect(loaded.cached("posts")).toBe(true);
    expect((await loaded.columns(connection, "posts")).map((c) => c.name)).toEqual(
      (await cache.columns(connection, "posts")).map((c) => c.name),
    );
  });

  /** The whole point of the file: a loaded cache answers without a connection. */
  it("answers from a dump without asking the database", async () => {
    const cache = new SchemaCache();
    await cache.addAll(connection);
    const loaded = SchemaCache.fromDump(cache.toDump());

    const asked = queries.length;
    await loaded.columns(connection, "posts");
    await loaded.indexes(connection, "posts");
    await loaded.dataSourceExists(connection, "posts");

    expect(queries.length).toBe(asked);
  });

  it("knows it was loaded rather than filled in", async () => {
    const cache = new SchemaCache();
    await cache.addAll(connection);

    expect(cache.schemaLoaded).toBe(false);
    expect(SchemaCache.fromDump(cache.toDump()).schemaLoaded).toBe(true);
  });

  it("writes and reads a file", async () => {
    const path = `${tmp()}/schema_cache.json`;
    const cache = new SchemaCache();
    await cache.addAll(connection);
    await cache.dumpTo(path);

    const loaded = await SchemaCache.load(path);

    expect(loaded?.cached("posts")).toBe(true);
  });

  /**
   * A cache is an optimisation. An application that will not boot because its
   * dump is corrupt has turned a saved query into an outage.
   */
  it("gives nothing rather than throwing for a missing file", async () => {
    expect(await SchemaCache.load(`${tmp()}/not_here.json`)).toBeUndefined();
  });

  it("gives nothing for a file that is not a dump", async () => {
    const path = `${tmp()}/junk.json`;
    await Bun.write(path, "not json at all");

    expect(await SchemaCache.load(path)).toBeUndefined();
  });

  it("gives nothing for json that is the wrong shape", async () => {
    const path = `${tmp()}/wrong.json`;
    await Bun.write(path, '{"something": "else"}');

    expect(await SchemaCache.load(path)).toBeUndefined();
  });
});

describe("staleness", () => {
  /**
   * A dump taken before the last migration describes columns that have since
   * changed. Using it is worse than having none: the application starts,
   * serves, and fails on the one query touching the new column.
   */
  it("refuses a dump from an older migration", async () => {
    const cache = new SchemaCache();
    await cache.addAll(connection);

    expect(isSchemaCacheCurrent(cache, "20250601000000")).toBe(false);
  });

  it("accepts one from the same migration", async () => {
    const cache = new SchemaCache();
    await cache.addAll(connection);

    expect(isSchemaCacheCurrent(cache, cache.schemaVersion)).toBe(true);
  });

  /** Two unknowns are not a match — they are two things nobody checked. */
  it("refuses when either version is unknown", () => {
    expect(isSchemaCacheCurrent(new SchemaCache(), null)).toBe(false);
    expect(isSchemaCacheCurrent(new SchemaCache(), "20250601000000")).toBe(false);
  });

  it("checks a file against the database", async () => {
    const path = `${tmp()}/checked.json`;
    const cache = new SchemaCache();
    await cache.addAll(connection);
    await cache.dumpTo(path);

    expect(await checkSchemaFile(path, cache.schemaVersion)).toBe(true);
    expect(await checkSchemaFile(path, "20990101000000")).toBe(false);
  });

  it("reports a missing file as not current", async () => {
    expect(await checkSchemaFile(`${tmp()}/absent.json`, "1")).toBe(false);
  });
});

describe("paths", () => {
  it("has a default", () => {
    expect(defaultSchemaCachePath("/app")).toBe("/app/db/schema_cache.json");
  });

  it("uses the default for the primary database", () => {
    expect(lazySchemaCachePath("primary", "/app")).toBe("/app/db/schema_cache.json");
  });

  /**
   * A file per database, because each migrates on its own schedule — one
   * shared file would be stale for every database whenever any one moved.
   */
  it("names the database in the file for any other", () => {
    expect(lazySchemaCachePath("analytics", "/app")).toBe("/app/db/analytics_schema_cache.json");
  });

  it("prefers a configured path", () => {
    expect(schemaCachePath("/somewhere/else.json", "/app")).toBe("/somewhere/else.json");
    expect(schemaCachePath(undefined, "/app")).toBe("/app/db/schema_cache.json");
  });
});

describe("SchemaReflection", () => {
  it("holds a cache", () => {
    expect(new SchemaReflection().schemaCache).toBeInstanceOf(SchemaCache);
  });

  it("dumps the whole schema to a file", async () => {
    const path = `${tmp()}/reflected.json`;
    const reflection = new SchemaReflection();

    await reflection.dumpSchemaCache(connection, path);

    expect((await SchemaCache.load(path))?.cached("posts")).toBe(true);
  });

  it("loads a current dump", async () => {
    const path = `${tmp()}/current.json`;
    const reflection = new SchemaReflection();
    await reflection.dumpSchemaCache(connection, path);

    const fresh = new SchemaReflection();

    expect(await fresh.loadFrom(path, reflection.schemaCache.schemaVersion)).toBe(true);
    expect(fresh.schemaLoaded).toBe(true);
  });

  /**
   * The check lives here because the tempting thing to write at a call site is
   * `cache ?? new SchemaCache()`, which uses a stale dump exactly as happily
   * as a current one.
   */
  it("refuses a stale one and keeps the empty cache", async () => {
    const path = `${tmp()}/stale.json`;
    const reflection = new SchemaReflection();
    await reflection.dumpSchemaCache(connection, path);

    const fresh = new SchemaReflection();

    expect(await fresh.loadFrom(path, "20990101000000")).toBe(false);
    expect(fresh.schemaCache.cached("posts")).toBe(false);
  });

  it("reports a missing file as not loaded", async () => {
    expect(await new SchemaReflection().loadFrom(`${tmp()}/gone.json`, "1")).toBe(false);
  });

  it("throws the cache away", async () => {
    const reflection = new SchemaReflection();
    await reflection.schemaCache.columns(connection, "posts");

    reflection.clearSchemaCache();

    expect(reflection.schemaCache.cached("posts")).toBe(false);
  });
});

/** The database's own idea of the current version, for comparing against. */
async function currentVersionOf(open: Connection): Promise<string | null> {
  const { currentVersion } = await import("../src/introspect.js");

  return currentVersion(open);
}

function tmp(): string {
  return process.env["TMPDIR"] ?? process.env["TEMP"] ?? ".";
}
