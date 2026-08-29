/**
 * The race-free counterpart to `findOrCreateBy`, ported from
 * `activerecord/test/cases/relations_test.rb`.
 *
 * `findOrCreateBy` has a race and cannot not have one: two requests both find
 * nothing, both insert, and one gets a duplicate-key error — or worse, two rows
 * exist where the schema meant one. The window is small and the traffic is not.
 *
 * `createOrFindBy` turns the race around. The insert is attempted first, and a
 * unique violation means somebody else won, so the row is read instead. The
 * database arbitrates rather than the application, which is the only place the
 * question can be settled.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isUniqueViolation, Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

class Tag extends Model<{ id: number; name: string; colour: string | null }>("tags") {}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("tags", (t) => {
    t.string("name");
    t.string("colour");
  });

  // The unique index is not optional. Without one there is no violation to
  // catch and this is `create` with extra steps.
  await schema.addIndex("tags", ["name"], { unique: true });

  Tag.columnCache = undefined;
  Tag.columnTypeCache = undefined;
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("when nothing is there", () => {
  it("creates the record", async () => {
    const tag = await Tag.createOrFindBy({ name: "ruby" });

    expect(tag.name).toBe("ruby");
    expect(await Tag.count()).toBe(1);
  });

  it("takes extra attributes that are not part of the lookup", async () => {
    const tag = await Tag.createOrFindBy({ name: "ruby" }, { colour: "red" });

    expect(tag.colour).toBe("red");
  });
});

describe("when the row already exists", () => {
  it("returns the one that is there", async () => {
    const first = await Tag.create({ name: "ruby", colour: "red" });
    const second = await Tag.createOrFindBy({ name: "ruby" });

    expect(second.id).toBe(first.id);
  });

  it("does not make a second one", async () => {
    await Tag.create({ name: "ruby" });
    await Tag.createOrFindBy({ name: "ruby" });

    expect(await Tag.count()).toBe(1);
  });

  /**
   * The extra attributes are for creating, not for updating. Rails does the
   * same: a record that already exists is returned as it is.
   */
  it("leaves the existing row alone", async () => {
    await Tag.create({ name: "ruby", colour: "red" });
    const found = await Tag.createOrFindBy({ name: "ruby" }, { colour: "blue" });

    expect(found.colour).toBe("red");
  });
});

/**
 * The two called at the same time. Not a proof of the race — a single process
 * cannot interleave two inserts — but it does exercise the path where the
 * insert loses and the read has to answer.
 */
describe("several at once", () => {
  it("ends with one row and every caller holding it", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => Tag.createOrFindBy({ name: "ruby" })),
    );

    expect(await Tag.count()).toBe(1);
    expect(new Set(results.map((tag) => tag.id)).size).toBe(1);
  });
});

/**
 * A failure that is not a duplicate is somebody else's problem and has to stay
 * visible. Swallowing it would turn a NOT NULL violation into a silent null.
 *
 * Two things stop that, and this covers the second: even if the error were
 * misjudged as a duplicate, the lookup that follows finds nothing and the
 * original error is re-raised. A positive control removing the first check
 * leaves this passing, which is the point — the safety does not rest on
 * classifying the error correctly.
 */
describe("a failure that is not a duplicate", () => {
  it("is raised rather than swallowed", async () => {
    await expect(Tag.createOrFindBy({ nonexistent_column: "x" } as never)).rejects.toThrow();
  });

  it("comes back as the error it was", async () => {
    let raised: unknown;

    try {
      await Tag.createOrFindBy({ nonexistent_column: "x" } as never);
    } catch (error) {
      raised = error;
    }

    expect(isUniqueViolation(raised)).toBe(false);
  });
});

describe("recognising a duplicate", () => {
  it("knows one when it sees it", async () => {
    await Tag.create({ name: "ruby" });

    let caught: unknown;
    try {
      await Tag.create({ name: "ruby" });
    } catch (error) {
      caught = error;
    }

    // Matched on the database's own code rather than on a message, which is
    // localised, changes between versions and differs per driver.
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("does not mistake an ordinary error for one", () => {
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("nope")).toBe(false);
  });
});
