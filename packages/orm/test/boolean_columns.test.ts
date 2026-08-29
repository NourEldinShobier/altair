/**
 * Booleans, round-tripped through whichever database the suite is pointed at.
 *
 * The three disagree about what a boolean is. SQLite has no such type and
 * stores 0 or 1; PostgreSQL has a real BOOLEAN and refuses an integer for it;
 * MySQL uses TINYINT(1) and takes either. Writing 0/1 everywhere therefore
 * worked on two adapters out of three, and failed on Postgres with
 * `column "active" is of type boolean but expression is of type integer` — for
 * every boolean write in the framework.
 *
 * It went unnoticed because nothing in the suite wrote a boolean on Postgres
 * until a login test did. This file is here so nothing has to again.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;

interface FlagRow {
  id: number;
  name: string;
  active: boolean | null;
}

class Flag extends Model<FlagRow>("flags") {}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("flags", (t) => {
    t.string("name");
    t.boolean("active");
  });

  Flag.columnCache = undefined;
  Flag.columnTypeCache = undefined;
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/** Every adapter reads one back its own way; what matters is truthiness. */
const truthy = (value: unknown) => value === true || value === 1 || value === "1";

describe("writing one", () => {
  it("stores true", async () => {
    const flag = await Flag.create({ name: "beta", active: true });

    expect(truthy((await Flag.find(flag.id)).active)).toBe(true);
  });

  it("stores false", async () => {
    const flag = await Flag.create({ name: "beta", active: false });

    expect(truthy((await Flag.find(flag.id)).active)).toBe(false);
  });

  it("stores null", async () => {
    const flag = await Flag.create({ name: "beta", active: null });

    expect((await Flag.find(flag.id)).active).toBeNull();
  });

  it("updates one that already exists", async () => {
    const flag = await Flag.create({ name: "beta", active: false });

    flag.active = true;
    await flag.save();

    expect(truthy((await Flag.find(flag.id)).active)).toBe(true);
  });
});

describe("matching on one", () => {
  beforeEach(async () => {
    await Flag.create({ name: "on", active: true });
    await Flag.create({ name: "off", active: false });
  });

  it("finds the true ones", async () => {
    const found = await Flag.where({ active: true });

    expect(found.map((flag) => flag.name)).toEqual(["on"]);
  });

  it("finds the false ones", async () => {
    const found = await Flag.where({ active: false });

    expect(found.map((flag) => flag.name)).toEqual(["off"]);
  });
});

describe("writing several at once", () => {
  it("carries booleans through a bulk insert", async () => {
    await Flag.insertAll([
      { name: "a", active: true },
      { name: "b", active: false },
    ]);

    const found = await Flag.where({ active: true });

    expect(found.map((flag) => flag.name)).toEqual(["a"]);
  });

  it("carries them through updateAll", async () => {
    await Flag.create({ name: "a", active: false });

    await Flag.all().updateAll({ active: true });

    expect(await Flag.where({ active: true }).count()).toBe(1);
  });
});
