/**
 * Loading fixtures into a database, ported from
 * `activerecord/test/cases/fixtures_test.rb` and the association cases in
 * `activerecord/test/cases/fixtures/...`.
 *
 * Everything turns on ids being derived from labels rather than assigned, so
 * most of these check the consequences of that: no insertion order, references
 * that resolve before anything exists, and the same id in every process.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { cacheFixtures, resetFixtureCache } from "../src/fixture_set.js";
import {
  type FixtureSet,
  UnknownFixture,
  allLoadedFixtures,
  deletionOrder,
  fixture,
  fixtureId,
  fixtureTimestamps,
  modelMetadata,
  parsingCacheEnabled,
  resolveReferences,
  setupFixtureAccessors,
  tableRows,
  withoutParsingCache,
} from "../src/fixture_loading.js";

const AUTHORS: FixtureSet = {
  table: "authors",
  rows: [
    { label: "david", attributes: { name: "David" } },
    { label: "mary", attributes: { name: "Mary" } },
  ],
};

afterEach(() => {
  resetFixtureCache();
});

describe("the rows a set inserts", () => {
  it("derives an id from the label", () => {
    const rows = tableRows(AUTHORS);

    expect(rows[0]?.["id"]).toBe(fixtureId("david"));
  });

  /** So a test can hard-code the id and it does not change between runs. */
  it("derives the same id every time", () => {
    expect(tableRows(AUTHORS)[0]?.["id"]).toBe(tableRows(AUTHORS)[0]?.["id"]);
  });

  it("gives two labels different ids", () => {
    const rows = tableRows(AUTHORS);

    expect(rows[0]?.["id"]).not.toBe(rows[1]?.["id"]);
  });

  it("keeps an id the fixture named itself", () => {
    const rows = tableRows({ table: "authors", rows: [{ label: "x", attributes: { id: 99 } }] });

    expect(rows[0]?.["id"]).toBe(99);
  });

  it("keeps the other columns", () => {
    expect(tableRows(AUTHORS)[0]?.["name"]).toBe("David");
  });

  it("takes a different primary key", () => {
    const rows = tableRows(
      { table: "authors", rows: [{ label: "x", attributes: {} }] },
      {
        primaryKey: "uuid",
      },
    );

    expect(rows[0]?.["uuid"]).toBeDefined();
  });
});

describe("references written as labels", () => {
  const associations = { author: { foreignKey: "author_id" } };

  /**
   * Resolved from the label, never looked up — so a fixture may reference one
   * that has not been inserted yet, including one below it in the same file.
   */
  it("resolves a label to its id", () => {
    expect(resolveReferences({ author: "david" }, associations)).toEqual({
      author_id: fixtureId("david"),
    });
  });

  it("leaves other columns alone", () => {
    expect(resolveReferences({ title: "Hello" }, associations)).toEqual({ title: "Hello" });
  });

  it("leaves a foreign key written directly alone", () => {
    expect(resolveReferences({ author_id: 7 }, associations)).toEqual({ author_id: 7 });
  });

  /**
   * Only a *label* is resolved. An id written under the association name is
   * already an id, and hashing it would produce a foreign key pointing at
   * nothing.
   */
  it("leaves an id written under the association name alone", () => {
    expect(resolveReferences({ author: 7 }, associations)).toEqual({ author: 7 });
  });

  it("resolves to the same id the referenced row gets", () => {
    const resolved = resolveReferences({ author: "david" }, associations);

    expect(resolved["author_id"]).toBe(tableRows(AUTHORS)[0]?.["id"]);
  });
});

describe("timestamps", () => {
  const metadata = modelMetadata(AUTHORS, { timestampColumns: ["created_at", "updated_at"] });

  it("fills in the ones the fixture did not set", () => {
    const now = new Date(0);

    expect(fixtureTimestamps(metadata, {}, now)).toEqual({ created_at: now, updated_at: now });
  });

  it("leaves one the fixture set", () => {
    const now = new Date(0);
    const set = new Date(1000);

    expect(fixtureTimestamps(metadata, { created_at: set }, now)).toEqual({ updated_at: now });
  });

  /**
   * One timestamp for the whole load. Per row, a suite asserting on ordering
   * by `created_at` would depend on how long the insert took — a test that
   * passes on a laptop and fails in CI.
   */
  it("uses the one timestamp it was given", () => {
    const now = new Date(0);
    const first = fixtureTimestamps(metadata, {}, now);
    const second = fixtureTimestamps(metadata, {}, now);

    expect(first["created_at"]).toEqual(second["created_at"]);
  });

  it("fills none for a table with no timestamp columns", () => {
    expect(fixtureTimestamps(modelMetadata(AUTHORS), {}, new Date())).toEqual({});
  });

  it("describes the model", () => {
    expect(modelMetadata(AUTHORS)).toEqual({
      table: "authors",
      primaryKey: "id",
      timestampColumns: [],
    });
  });
});

describe("the order tables empty in", () => {
  /**
   * Children before parents: foreign keys are enforced, and deleting a parent
   * whose children remain fails on exactly the schemas careful enough to
   * declare the constraint.
   */
  it("deletes dependents first", () => {
    const order = deletionOrder(["authors", "posts"], { authors: ["posts"] });

    expect(order.indexOf("posts")).toBeLessThan(order.indexOf("authors"));
  });

  it("keeps every table", () => {
    expect(deletionOrder(["authors", "posts"], { authors: ["posts"] }).sort()).toEqual([
      "authors",
      "posts",
    ]);
  });

  it("handles a table with no dependents", () => {
    expect(deletionOrder(["authors"])).toEqual(["authors"]);
  });

  /**
   * A cycle is legitimate here — an author with a favourite post — so it is
   * broken rather than reported. The rows still delete, because the whole set
   * goes together.
   */
  it("survives a cycle", () => {
    const order = deletionOrder(["authors", "posts"], {
      authors: ["posts"],
      posts: ["authors"],
    });

    expect(order.sort()).toEqual(["authors", "posts"]);
  });

  it("does not list a table twice", () => {
    const order = deletionOrder(["a", "b", "c"], { a: ["b"], c: ["b"] });

    expect(new Set(order).size).toBe(order.length);
  });
});

describe("the parse cache", () => {
  it("is on by default", () => {
    expect(parsingCacheEnabled()).toBe(true);
  });

  /** For a test that edits a fixture file and expects the change to be read. */
  it("is off inside the block", async () => {
    await withoutParsingCache(() => {
      expect(parsingCacheEnabled()).toBe(false);
    });
  });

  it("is on again afterwards", async () => {
    await withoutParsingCache(() => undefined);

    expect(parsingCacheEnabled()).toBe(true);
  });

  /**
   * In a `finally`, or one test that threw makes every later test re-parse
   * every file — a suite that gets slower for a reason nobody can see.
   */
  it("is on again when the body throws", async () => {
    await expect(
      withoutParsingCache(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(parsingCacheEnabled()).toBe(true);
  });

  it("reports nothing cached while it is off", async () => {
    cacheFixtures("authors", AUTHORS);

    expect(allLoadedFixtures(["authors"])).toEqual([AUTHORS]);

    await withoutParsingCache(() => {
      expect(allLoadedFixtures(["authors"])).toEqual([undefined]);
    });
  });

  it("hands back what the body returned", async () => {
    expect(await withoutParsingCache(() => 7)).toBe(7);
  });
});

describe("reaching a fixture from a test", () => {
  it("finds one by label", () => {
    expect(fixture(AUTHORS, "david").attributes["name"]).toBe("David");
  });

  /** A test that receives `undefined` fails later, on an unrelated line. */
  it("refuses an unknown label", () => {
    expect(() => fixture(AUTHORS, "dvaid")).toThrow(UnknownFixture);
  });

  it("says what is defined", () => {
    expect(() => fixture(AUTHORS, "dvaid")).toThrow("david");
  });

  /** Sorted, so a generated list of accessors does not reorder between runs. */
  it("names the accessors a suite gets, in order", () => {
    expect(setupFixtureAccessors([{ table: "posts", rows: [] }, AUTHORS])).toEqual([
      "authors",
      "posts",
    ]);
  });

  it("answers the id a label means without loading anything", () => {
    expect(fixtureId("david")).toBe(fixtureId("david"));
  });
});
