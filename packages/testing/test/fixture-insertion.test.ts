/**
 * Getting a fixture set into the database, ported from
 * `activerecord/test/cases/fixtures_test.rb` and the adapter fixture-statement
 * cases under `activerecord/test/cases/adapters`.
 *
 * The property every case is about: the load is all-or-nothing. Half a load is
 * far worse than none, because the database then looks loaded.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type FixtureConnection,
  type FixtureStatement,
  buildFixtureSql,
  cacheForConnectionPool,
  createFixtures,
  emptyAllTables,
  fixtureStatements,
  insertFixture,
  insertFixturesSet,
  instantiateAllLoadedFixtures,
  instantiateFixtures,
  resetColumnSequences,
  resetFixtureInsertionCache,
  updateAllLoadedFixtures,
  withYamlFallback,
} from "../src/fixture-insertion.js";
import { resetFixtureCache } from "../src/fixture-set.js";

interface Recorder extends FixtureConnection {
  ran: FixtureStatement[];
  depth: string[];
}

function recorder(overrides: Partial<FixtureConnection> = {}): Recorder {
  const ran: FixtureStatement[] = [];
  const depth: string[] = [];

  return {
    ran,
    depth,
    execute: (statement) => {
      ran.push(statement);
      depth.push("execute");
    },
    transaction: async (body) => {
      depth.push("begin");
      const value = await body();
      depth.push("commit");

      return value;
    },
    disableReferentialIntegrity: async (body) => {
      depth.push("relax");
      const value = await body();
      depth.push("restore");

      return value;
    },
    ...overrides,
  };
}

afterEach(() => {
  resetFixtureInsertionCache();
  resetFixtureCache();
});

describe("a value with no column type", () => {
  /**
   * A hash handed to a driver is either refused or — the one that gets shipped
   * — coerced to something like `[object Object]` and stored.
   */
  it("serialises a hash or an array", () => {
    expect(withYamlFallback({ a: 1 })).toBe('{"a":1}');
    expect(withYamlFallback([1, 2])).toBe("[1,2]");
  });

  /**
   * Scalars pass through: serialising them would store `"1"` where the fixture
   * said `1`, and every comparison on that column would read like a type bug in
   * the model.
   */
  it("leaves a scalar alone", () => {
    expect(withYamlFallback(1)).toBe(1);
    expect(withYamlFallback("a")).toBe("a");
    expect(withYamlFallback(true)).toBe(true);
    expect(withYamlFallback(null)).toBe(null);
  });

  /** A date has a column type; JSON would turn it into a string. */
  it("leaves a date alone", () => {
    const at = new Date(0);

    expect(withYamlFallback(at)).toBe(at);
  });
});

describe("the insert for a table", () => {
  /**
   * Every row in one statement. A statement per row is the difference between
   * loading fixtures in a moment and spending a suite in round trips.
   */
  it("puts every row in one statement", () => {
    const statement = buildFixtureSql([{ id: 1 }, { id: 2 }], "posts");

    expect(statement?.sql).toBe('INSERT INTO "posts" ("id") VALUES (?), (?)');
    expect(statement?.binds).toEqual([1, 2]);
  });

  /**
   * Two fixtures in one file need not set the same columns. Without the union,
   * a row that omitted one would shift every later value one place left — and
   * the insert still succeeds when the types happen to line up.
   */
  it("takes the union of every row's columns", () => {
    const statement = buildFixtureSql([{ id: 1 }, { id: 2, title: "b" }], "posts");

    expect(statement?.sql).toBe('INSERT INTO "posts" ("id", "title") VALUES (?, ?), (?, ?)');
    expect(statement?.binds).toEqual([1, null, 2, "b"]);
  });

  it("binds values rather than writing them into the text", () => {
    const statement = buildFixtureSql([{ title: "'; DROP TABLE posts --" }], "posts");

    expect(statement?.sql).not.toContain("DROP");
    expect(statement?.binds).toEqual(["'; DROP TABLE posts --"]);
  });

  it("serialises a value with no column type", () => {
    expect(buildFixtureSql([{ meta: { a: 1 } }], "posts")?.binds).toEqual(['{"a":1}']);
  });

  it("has nothing to run for no rows", () => {
    expect(buildFixtureSql([], "posts")).toBeUndefined();
  });

  /** `INSERT INTO posts () VALUES ()` is a syntax error. */
  it("has nothing to run for rows with no columns", () => {
    expect(buildFixtureSql([{}], "posts")).toBeUndefined();
  });

  it("takes the connection's quoting", () => {
    expect(buildFixtureSql([{ id: 1 }], "posts", (name) => `\`${name}\``)?.sql).toStartWith(
      "INSERT INTO `posts` (`id`)",
    );
  });

  it("writes one row on its own", () => {
    expect(insertFixture({ id: 1 }, "posts").sql).toBe('INSERT INTO "posts" ("id") VALUES (?)');
  });

  /** A row with no columns would produce `INSERT INTO posts () VALUES ()`. */
  it("refuses a row with no columns", () => {
    expect(() => insertFixture({}, "posts")).toThrow("at least one column");
  });
});

describe("the statements a load runs", () => {
  /**
   * All the deletes before any insert: a table emptied after another was filled
   * deletes rows the same load inserted, when two fixture sets share a table.
   */
  it("empties every table before filling any", () => {
    const statements = fixtureStatements({ posts: [{ id: 1 }], authors: [{ id: 2 }] }, [
      "posts",
      "authors",
    ]);

    expect(statements.map((each) => each.sql.split(" ").slice(0, 2).join(" "))).toEqual([
      "DELETE FROM",
      "DELETE FROM",
      "INSERT INTO",
      "INSERT INTO",
    ]);
  });

  it("skips a table with no rows", () => {
    expect(fixtureStatements({ posts: [] })).toEqual([]);
  });

  it("deletes tables it has no rows for", () => {
    expect(fixtureStatements({}, ["posts"])[0]?.sql).toBe('DELETE FROM "posts"');
  });
});

describe("loading a set", () => {
  /**
   * A run that emptied `posts` and failed on `comments` leaves a database that
   * looks loaded and is missing a table's worth of rows, and the tests that
   * follow fail one by one with nothing pointing back here.
   */
  it("runs everything in one transaction", async () => {
    const connection = recorder();
    await insertFixturesSet(connection, { posts: [{ id: 1 }] }, ["posts"]);

    expect(connection.depth[0]).toBe("begin");
    expect(connection.depth.at(-1)).toBe("commit");
  });

  /**
   * Every row arrives in the same transaction, so a post referring to an author
   * inserted two statements later is not a broken reference. There is no
   * ordering at all that makes a cycle work without this.
   */
  it("suspends referential integrity for the load", async () => {
    const connection = recorder();
    await insertFixturesSet(connection, { posts: [{ id: 1 }] });

    expect(connection.depth).toEqual(["begin", "relax", "execute", "restore", "commit"]);
  });

  /** An adapter without it still loads; it simply cannot load a cycle. */
  it("loads against a connection that cannot suspend it", async () => {
    const connection = recorder({ disableReferentialIntegrity: undefined });
    await insertFixturesSet(connection, { posts: [{ id: 1 }] });

    expect(connection.ran).toHaveLength(1);
  });

  it("does not commit when a statement fails", async () => {
    const connection = recorder({
      execute: () => {
        throw new Error("boom");
      },
    });

    await expect(insertFixturesSet(connection, { posts: [{ id: 1 }] })).rejects.toThrow("boom");
    expect(connection.depth).not.toContain("commit");
  });
});

describe("emptying everything", () => {
  /**
   * Every table, not the ones a fixture set names: leaving out the tables no
   * fixture mentions is how a stray row survives to fail one test in a hundred
   * runs.
   */
  it("empties every table the connection has", async () => {
    const connection = recorder({ tables: () => ["posts", "comments"] });
    const emptied = await emptyAllTables(connection);

    expect(emptied).toEqual(["posts", "comments"]);
    expect(connection.ran.map((each) => each.sql)).toEqual([
      'DELETE FROM "posts"',
      'DELETE FROM "comments"',
    ]);
  });

  it("is one transaction", async () => {
    const connection = recorder({ tables: () => ["posts"] });
    await emptyAllTables(connection);

    expect(connection.depth).toEqual(["begin", "execute", "commit"]);
  });

  it("has nothing to do against a connection that lists no tables", async () => {
    const connection = recorder();

    expect(await emptyAllTables(connection)).toEqual([]);
  });
});

describe("the sequences after a load", () => {
  /**
   * A fixture's id is derived from its label rather than taken from the
   * sequence, so after a load the sequence is still where it was and the next
   * record a *test* creates collides with a fixture — a unique-key violation in
   * a test that never mentioned fixtures.
   */
  it("is the highest id each table was given", () => {
    expect(resetColumnSequences({ posts: [{ id: 3 }, { id: 7 }], authors: [{ id: 1 }] })).toEqual({
      posts: 7,
      authors: 1,
    });
  });

  it("ignores a table whose keys are not numbers", () => {
    expect(resetColumnSequences({ posts: [{ id: "abc" }] })).toEqual({});
  });

  it("takes a different primary key", () => {
    expect(resetColumnSequences({ posts: [{ uuid: 4 }] }, "uuid")).toEqual({ posts: 4 });
  });
});

describe("the cache a run shares", () => {
  /**
   * Per pool: an application with two databases has two sets of tables, and a
   * shared cache would report a set as loaded into a database it was never
   * loaded into — every test against it then runs on empty tables.
   */
  it("is one per pool", () => {
    cacheForConnectionPool("primary").add("posts");

    expect(cacheForConnectionPool("animals").has("posts")).toBe(false);
  });

  it("is the same set each time for one pool", () => {
    cacheForConnectionPool("primary").add("posts");

    expect(cacheForConnectionPool("primary").has("posts")).toBe(true);
  });

  it("remembers a set by name", () => {
    updateAllLoadedFixtures("primary", { posts: { david: { id: 1 } } });

    expect(cacheForConnectionPool("primary").has("posts")).toBe(true);
  });
});

describe("loading the named sets", () => {
  const rowsFor = () => ({ posts: [{ id: 1 }] });

  it("reads and inserts a set it has not seen", async () => {
    const connection = recorder();
    const loaded = await createFixtures(connection, ["posts"], () => ({ david: { id: 1 } }), {
      tableRowsFor: rowsFor,
    });

    expect(loaded).toEqual({ posts: { david: { id: 1 } } });
    // Emptied as well as filled: a run that only inserted would double every
    // fixture against a database the last run left behind.
    expect(connection.ran.map((each) => each.sql.split(" ")[0])).toEqual(["DELETE", "INSERT"]);
  });

  /**
   * The cache is the reason a suite starts at all: without it every test class
   * re-reads and re-inserts every file.
   */
  it("does not read or insert a set already loaded", async () => {
    let reads = 0;
    const read = () => {
      reads += 1;

      return { david: { id: 1 } };
    };

    await createFixtures(recorder(), ["posts"], read, { tableRowsFor: rowsFor });

    const second = recorder();
    const loaded = await createFixtures(second, ["posts"], read, { tableRowsFor: rowsFor });

    expect(reads).toBe(1);
    expect(second.ran).toEqual([]);
    // Still answered, so a caller cannot tell except in how long it took.
    expect(loaded).toEqual({ posts: { david: { id: 1 } } });
  });

  it("reads a set that another pool loaded", async () => {
    await createFixtures(recorder(), ["posts"], () => ({ david: { id: 1 } }), {
      tableRowsFor: rowsFor,
    });

    const other = recorder();
    await createFixtures(other, ["posts"], () => ({ david: { id: 1 } }), {
      pool: "animals",
      tableRowsFor: rowsFor,
    });

    expect(other.ran.some((each) => each.sql.startsWith("INSERT"))).toBe(true);
  });

  /**
   * A set marked loaded whose insert then failed would be skipped by every
   * later call, and the tests would run against tables nobody filled.
   */
  it("does not mark a set loaded when the insert failed", async () => {
    const failing = recorder({
      execute: () => {
        throw new Error("boom");
      },
    });

    await expect(
      createFixtures(failing, ["posts"], () => ({ david: { id: 1 } }), { tableRowsFor: rowsFor }),
    ).rejects.toThrow("boom");

    expect(cacheForConnectionPool("primary").has("posts")).toBe(false);
  });
});

describe("reaching the fixtures from a test", () => {
  it("sets one property per fixture", () => {
    const target: Record<string, unknown> = {};
    instantiateFixtures(target, { david: { id: 1 } });

    expect(target["david"]).toEqual({ id: 1 });
  });

  /**
   * A model object per fixture costs a query each, and a suite with a few
   * hundred fixtures pays that per test.
   */
  it("sets nothing when instances were not asked for", () => {
    const target: Record<string, unknown> = {};
    instantiateFixtures(target, { david: { id: 1 } }, false);

    expect(target).toEqual({});
  });

  it("does every loaded set", () => {
    const target: Record<string, unknown> = {};
    instantiateAllLoadedFixtures(target, {
      authors: { david: { id: 1 } },
      posts: { welcome: { id: 2 } },
    });

    expect(Object.keys(target).sort()).toEqual(["david", "welcome"]);
  });

  /**
   * Two files may legitimately both define `david`, and refusing the load would
   * break a suite over a name neither file's author chose.
   */
  it("lets a later set win a name", () => {
    const target: Record<string, unknown> = {};
    instantiateAllLoadedFixtures(target, {
      authors: { david: { from: "authors" } },
      posts: { david: { from: "posts" } },
    });

    expect(target["david"]).toEqual({ from: "posts" });
  });

  it("sets nothing for any set when instances were not asked for", () => {
    const target: Record<string, unknown> = {};
    instantiateAllLoadedFixtures(target, { authors: { david: { id: 1 } } }, false);

    expect(target).toEqual({});
  });
});
