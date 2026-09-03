/**
 * The values a `where` binds, ported from the type-cast cases in
 * `activerecord/test/cases/relation/where_test.rb` and Rails' rule that a
 * predicate goes through the column's type on the way to the database, the
 * same as a write does.
 *
 * `create` has always serialized and `where` did not, so the two disagreed
 * about what a value is. Handing a Date straight to bun's SQLite driver is
 * refused outright — "Binding expected string, TypedArray, boolean, number,
 * bigint or null" — which means that finding a record by the timestamp you
 * just wrote to it threw.
 *
 * That is the shape worth keeping an eye on here: not a clever predicate, but
 * a read and a write of one column that have to agree on what its values look
 * like.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface EventRow {
  id: number;
  name: string;
  at: string | null;
  live: number | null;
}

class Event extends Model<EventRow>("events") {
  declare id: number;
  declare name: string;
  declare at: string | null;
  declare live: number | null;
}

const NOON = new Date("2026-06-01T12:00:00.000Z");
const MIDNIGHT = new Date("2026-06-02T00:00:00.000Z");
const LATER = new Date("2026-06-03T09:30:00.000Z");

let connection: Connection;

async function names(relation: { toArray(): Promise<Event[]> }): Promise<string[]> {
  return (await relation.toArray()).map((event) => event.name);
}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  Event.resetColumnInformation();

  await new SchemaStatements(connection).createTable("events", (t) => {
    t.string("name");
    t.datetime("at");
    t.boolean("live");
  });

  await Event.create({ name: "noon", at: NOON as never, live: true as never });
  await Event.create({ name: "midnight", at: MIDNIGHT as never, live: false as never });
  await Event.create({ name: "later", at: LATER as never, live: true as never });
});

describe("a Date in a condition", () => {
  /** The regression: this threw at the driver rather than returning nothing. */
  it("finds the record it was written to", async () => {
    expect(await names(Event.where({ at: NOON }))).toEqual(["noon"]);
  });

  it("finds nothing for a moment nothing happened at", async () => {
    expect(await names(Event.where({ at: new Date("2020-01-01T00:00:00.000Z") }))).toEqual([]);
  });

  it("works in a range, which is how a date is usually asked for", async () => {
    expect(await names(Event.where({ at: { from: NOON, to: MIDNIGHT } }).order("at"))).toEqual([
      "noon",
      "midnight",
    ]);
  });

  it("works as a one-ended range", async () => {
    expect(await names(Event.where({ at: { from: MIDNIGHT } }).order("at"))).toEqual([
      "midnight",
      "later",
    ]);
  });

  it("works in a list", async () => {
    expect(await names(Event.where({ at: [NOON, LATER] }).order("at"))).toEqual(["noon", "later"]);
  });

  it("works in a negated condition", async () => {
    expect(await names(Event.all().whereNot({ at: NOON }).order("at"))).toEqual([
      "midnight",
      "later",
    ]);
  });

  it("works in a negated list", async () => {
    expect(await names(Event.all().whereNot({ at: [NOON, LATER] }))).toEqual(["midnight"]);
  });

  it("works in raw SQL with a bound value", async () => {
    expect(await names(Event.where("at = ?", NOON))).toEqual(["noon"]);
  });
});

describe("a boolean in a condition", () => {
  it("finds the rows it was written to", async () => {
    expect(await names(Event.where({ live: true }).order("at"))).toEqual(["noon", "later"]);
  });

  it("finds the others when it is false", async () => {
    expect(await names(Event.where({ live: false }))).toEqual(["midnight"]);
  });
});

describe("combining", () => {
  /**
   * `or` merges bindings that have already been serialized once, so the pass
   * has to leave a serialized value alone. A second conversion of a timestamp
   * string would produce a JSON-quoted string and match nothing.
   */
  it("keeps a serialized value serialized through an or", async () => {
    const relation = Event.where({ at: NOON }).or(Event.where({ at: LATER }));

    expect((await names(relation.order("at"))).sort()).toEqual(["later", "noon"]);
  });

  it("keeps it through a second where", async () => {
    expect(await names(Event.where({ at: NOON }).where({ live: true }))).toEqual(["noon"]);
  });
});

describe("a Date in a having", () => {
  /** The same question asked of a group, and it had the same hole. */
  it("filters the groups it was written to", async () => {
    const rows = await Event.all()
      .select("live")
      .group("live")
      .having("MAX(at) > ?", MIDNIGHT)
      .toArray();

    expect(rows).toHaveLength(1);
  });
});

describe("what a condition still remembers", () => {
  /**
   * The value a condition carries is what `whereValues` reports and what a
   * `build` off the relation seeds a new record from, so it stays as the
   * caller wrote it. Serializing that too would put a formatted string into a
   * new record's attributes and skip the type on the way back out.
   */
  it("reports the value it was given, not the one it bound", async () => {
    expect(Event.where({ at: LATER }).whereValues().at).toBe(LATER);
  });

  it("seeds a new record with it", async () => {
    const fresh = Event.where({ name: "fresh", at: LATER }).build();

    expect(fresh.at).toBe(LATER as never);
  });
});
