/**
 * Columns holding a structure.
 *
 * Mirrors activerecord/test/cases/serialized_attribute_test.rb and
 * store_test.rb. The dirty-tracking test is the one worth having: editing a
 * key inside the structure mutates the object in place, so a comparison by
 * reference sees nothing and the save writes nothing — an edit that vanishes
 * without an error.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface UserRow {
  id: number;
  name: string;
  preferences: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
}

class User extends Model<UserRow>("users") {
  declare theme: string | null;
  declare locale: string | null;

  static {
    this.serialize("preferences");
    this.store("settings", ["theme", "locale"]);
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  User.columnCache = undefined;
  User.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("users", { ifExists: true });
  await schema.createTable("users", (t) => {
    t.string("name");
    t.text("preferences");
    t.text("settings");
  });
});

describe("a serialized column", () => {
  it("writes a structure and reads it back", async () => {
    await User.create({ name: "ada", preferences: { theme: "dark", size: 14 } });

    const found = await User.findBy({ name: "ada" });
    expect(found?.preferences).toEqual({ theme: "dark", size: 14 });
  });

  // Every driver hands a text column back as a string, so without this the
  // application gets `'{"theme":"dark"}'` and reaches for `.theme` on it.
  it("stores it as text", async () => {
    await User.create({ name: "ada", preferences: { theme: "dark" } });

    const [row] = await connection.query<{ preferences: string }>("SELECT preferences FROM users");
    expect(typeof row?.preferences).toBe("string");
    expect(JSON.parse(row?.preferences as string)).toEqual({ theme: "dark" });
  });

  it("handles an array as happily as an object", async () => {
    await User.create({ name: "ada", preferences: ["a", "b"] as never });

    expect((await User.findBy({ name: "ada" }))?.preferences).toEqual(["a", "b"] as never);
  });

  it("leaves null alone", async () => {
    await User.create({ name: "ada" });

    expect((await User.findBy({ name: "ada" }))?.preferences).toBeNull();
  });

  // A row someone edited by hand should not take down a page.
  it("reads unparseable text as null", async () => {
    await connection.execute("INSERT INTO users (name, preferences) VALUES ('bad', '{not json')");

    expect((await User.findBy({ name: "bad" }))?.preferences).toBeNull();
  });

  it("gives the same object each time it is read", async () => {
    await User.create({ name: "ada", preferences: { theme: "dark" } });
    const found = (await User.findBy({ name: "ada" })) as User;

    expect(found.preferences).toBe(found.preferences as never);
  });
});

// The reason this file exists. `preferences.theme = "dark"` mutates the object
// in place, so both sides of the comparison are the same reference — and a
// save that writes nothing loses the edit without an error.
describe("editing inside the structure", () => {
  it("counts as a change", async () => {
    const user = await User.create({ name: "ada", preferences: { theme: "light" } });

    (user.preferences as Record<string, unknown>).theme = "dark";

    expect(user.hasChanged("preferences")).toBe(true);
  });

  it("is written by save", async () => {
    const user = await User.create({ name: "ada", preferences: { theme: "light" } });

    (user.preferences as Record<string, unknown>).theme = "dark";
    await user.save();

    expect((await User.find(user.id)).preferences).toEqual({ theme: "dark" });
  });

  it("leaves an untouched record clean", async () => {
    const user = await User.create({ name: "ada", preferences: { theme: "light" } });
    await user.reload();

    void user.preferences;

    expect(user.hasChanged("preferences")).toBe(false);
  });

  // A structure rebuilt in another order is not a change, or every save of an
  // untouched record would write.
  it("does not count a different key order as a change", async () => {
    const user = await User.create({ name: "ada", preferences: { a: 1, b: 2 } });

    user.preferences = { b: 2, a: 1 };

    expect(user.hasChanged("preferences")).toBe(false);
  });
});

describe("a store with accessors", () => {
  it("reads through them", async () => {
    await User.create({ name: "ada", settings: { theme: "dark", locale: "fr" } });
    const found = (await User.findBy({ name: "ada" })) as User;

    expect(found.theme).toBe("dark");
    expect(found.locale).toBe("fr");
  });

  it("writes through them", async () => {
    const user = await User.create({ name: "ada" });

    user.theme = "dark";
    await user.save();

    expect((await User.find(user.id)).settings).toEqual({ theme: "dark" });
  });

  it("keeps the other keys when one is written", async () => {
    const user = await User.create({ name: "ada", settings: { theme: "dark", locale: "fr" } });

    user.theme = "light";
    await user.save();

    expect((await User.find(user.id)).settings).toEqual({ theme: "light", locale: "fr" });
  });

  it("gives null for one that was never set", async () => {
    const user = await User.create({ name: "ada" });

    expect(user.theme).toBeNull();
  });

  it("marks the column changed when an accessor is written", async () => {
    const user = await User.create({ name: "ada", settings: { theme: "dark" } });

    user.theme = "light";

    expect(user.hasChanged("settings")).toBe(true);
  });
});

describe("declaring it", () => {
  it("does not leak into a parent", () => {
    class Narrower extends User {
      static {
        this.serialize("other");
      }
    }

    expect(Object.keys(Narrower.serializedColumns)).toContain("other");
    expect(Object.keys(User.serializedColumns)).not.toContain("other");
  });
});
