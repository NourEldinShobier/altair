/**
 * Rows identified by more than one column, ported from the
 * `query_constraints` cases in
 * `activerecord/test/cases/query_constraints_test.rb`.
 *
 * The consequence of getting this wrong is not a failed save. An UPDATE whose
 * WHERE names too few columns matches the wrong row, or several, and writes to
 * all of them — so a save reports success and edits somebody else's record.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface EntryRow {
  id: number;
  tenant_id: number;
  /** Unique within a tenant, and only within one. */
  reference: number;
  title: string;
}

class Entry extends Model<EntryRow>("entries") {}

/**
 * The same table keyed on `reference`, which is unique within a tenant and not
 * across them — the situation the feature exists for. Told which columns
 * actually identify a row.
 */
class ScopedEntry extends Model<EntryRow>("entries", {
  primaryKey: "reference",
  queryConstraints: ["tenant_id", "reference"],
}) {}

/** The same again, without being told — so `reference` alone is the key. */
class UnscopedEntry extends Model<EntryRow>("entries", { primaryKey: "reference" }) {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  for (const model of [Entry, ScopedEntry, UnscopedEntry]) {
    model.resetColumnInformation();
  }

  await new SchemaStatements(connection).createTable("entries", (t) => {
    t.integer("tenant_id");
    t.integer("reference");
    t.string("title");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

async function seed(): Promise<void> {
  await connection.execute(
    "INSERT INTO entries (tenant_id, reference, title) VALUES (1, 100, 'first tenant')",
    [],
  );
  await connection.execute(
    "INSERT INTO entries (tenant_id, reference, title) VALUES (2, 100, 'second tenant')",
    [],
  );
}

describe("queryConstraintsList", () => {
  it("is the primary key when nothing else was declared", () => {
    expect(Entry.queryConstraintsList()).toEqual(["id"]);
  });

  it("is what the model declared", () => {
    expect(ScopedEntry.queryConstraintsList()).toEqual(["tenant_id", "reference"]);
  });

  it("leaves an undeclared model reporting none", () => {
    expect(Entry.queryConstraints).toBeUndefined();
  });
});

describe("saving", () => {
  it("still writes the right row for an ordinary model", async () => {
    await seed();

    const entry = (await Entry.where({ tenant_id: 1 }).first()) as Entry;
    entry.title = "changed";
    await entry.save();

    expect((await Entry.where({ tenant_id: 1 }).first())?.title).toBe("changed");
    expect((await Entry.where({ tenant_id: 2 }).first())?.title).toBe("second tenant");
  });

  /** The point: both columns are named, so exactly one row matches. */
  it("writes only the row both columns identify", async () => {
    await seed();

    const entry = (await ScopedEntry.where({ tenant_id: 1 }).first()) as ScopedEntry;
    entry.title = "changed";
    await entry.save();

    expect((await Entry.where({ tenant_id: 1 }).first())?.title).toBe("changed");
    expect((await Entry.where({ tenant_id: 2 }).first())?.title).toBe("second tenant");
  });

  /**
   * The bug it prevents, shown by the model that does not declare them: with
   * `reference` alone as the key, both tenants share the value, so the UPDATE
   * matches both rows and reports success having edited the other tenant's
   * record.
   */
  it("shows what happens without them", async () => {
    await seed();

    const entry = (await UnscopedEntry.where({ tenant_id: 1 }).first()) as UnscopedEntry;
    entry.title = "changed";
    await entry.save();

    expect((await Entry.where({ tenant_id: 2 }).first())?.title).toBe("changed");
  });

  it("leaves the other tenant's row alone when the reference is shared", async () => {
    await seed();

    const entry = (await ScopedEntry.where({ tenant_id: 2 }).first()) as ScopedEntry;
    entry.title = "only mine";
    await entry.save();

    expect((await Entry.where({ tenant_id: 1 }).first())?.title).toBe("first tenant");
  });

  it("writes every changed column", async () => {
    await seed();

    const entry = (await ScopedEntry.where({ tenant_id: 1 }).first()) as ScopedEntry;
    entry.title = "changed";
    entry.reference = 100;
    await entry.save();

    expect((await Entry.where({ tenant_id: 1 }).first())?.title).toBe("changed");
  });
});

describe("destroying", () => {
  it("removes only the row both columns identify", async () => {
    await seed();

    const entry = (await ScopedEntry.where({ tenant_id: 1 }).first()) as ScopedEntry;
    await entry.destroy();

    expect(await Entry.all().count()).toBe(1);
    expect((await Entry.first())?.tenant_id).toBe(2);
  });

  /** Without them, a DELETE on a shared key takes both rows. */
  it("shows what happens without them", async () => {
    await seed();

    const entry = (await UnscopedEntry.where({ tenant_id: 1 }).first()) as UnscopedEntry;
    await entry.destroy();

    expect(await Entry.all().count()).toBe(0);
  });

  it("still removes the right row for an ordinary model", async () => {
    await seed();

    const entry = (await Entry.where({ tenant_id: 1 }).first()) as Entry;
    await entry.destroy();

    expect(await Entry.all().count()).toBe(1);
  });

  it("leaves nothing behind when both are destroyed", async () => {
    await seed();

    for (const entry of await ScopedEntry.all()) await entry.destroy();

    expect(await Entry.all().count()).toBe(0);
  });
});
