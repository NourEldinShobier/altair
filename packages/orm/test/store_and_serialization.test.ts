/**
 * Store accessors and serialization, ported from
 * `activerecord/test/cases/store_test.rb` and
 * `activemodel/test/cases/serializers/json_serialization_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";
import { storeAccessor, storeKeyDeclared, storedAttributes } from "../src/store.js";
import {
  asJson,
  readAttributeForSerialization,
  setIncludeRootInJson,
  toJson,
  toXml,
} from "../src/serialization.js";

interface UserRow {
  id: number;
  name: string;
  settings: Record<string, unknown> | null;
  preferences: Record<string, unknown> | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("users", (t) => {
    t.string("name");
    t.json("settings");
    t.json("preferences");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
  setIncludeRootInJson(false);
});

function userClass() {
  class User extends Model<UserRow>("users") {
    declare theme: string | undefined;
    declare locale: string | undefined;
  }
  User.columnCache = undefined;
  User.columnTypeCache = undefined;
  User.serialize("settings");
  User.serialize("preferences");
  return User;
}

describe("storeAccessor", () => {
  it("reads a key through the accessor", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);

    const user = User.build({ settings: { theme: "dark" } });

    expect(user.theme).toBe("dark");
  });

  it("writes a key through the accessor", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);

    const user = User.build({ settings: {} });
    user.theme = "light";

    expect(user.settings).toEqual({ theme: "light" });
  });

  /** An old row written before the column existed has no store at all. */
  it("reads undefined from a null store", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);

    expect(User.build({ settings: null }).theme).toBeUndefined();
  });

  it("creates the store on write", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);

    const user = User.build({ settings: null });
    user.theme = "dark";

    expect(user.settings).toEqual({ theme: "dark" });
  });

  it("keeps the other keys when writing one", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme", "locale"]);

    const user = User.build({ settings: { theme: "dark", locale: "en" } });
    user.theme = "light";

    expect(user.settings).toEqual({ theme: "light", locale: "en" });
  });

  /**
   * Replaced rather than mutated: dirty tracking compares the value to the one
   * it loaded, and mutating in place leaves both sides the same object.
   */
  it("replaces the store object rather than mutating it", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);

    const original = { theme: "dark" };
    const user = User.build({ settings: original });
    user.theme = "light";

    expect(original).toEqual({ theme: "dark" });
  });

  it("round-trips through the database", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);

    const user = await User.create({ name: "Ada", settings: { theme: "dark" } });
    const found = await User.find(user.id);

    expect(found.theme).toBe("dark");
  });

  /** Rails: prefix: true lets two stores hold the same key. */
  it("prefixes with the column name", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"], { prefix: true });
    storeAccessor(User, "preferences", ["theme"], { prefix: true });

    const user = User.build({ settings: { theme: "dark" }, preferences: { theme: "light" } });

    expect((user as unknown as Record<string, unknown>).settings_theme).toBe("dark");
    expect((user as unknown as Record<string, unknown>).preferences_theme).toBe("light");
  });

  it("takes an explicit prefix and suffix", async () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"], { prefix: "my", suffix: "setting" });

    const user = User.build({ settings: { theme: "dark" } });

    expect((user as unknown as Record<string, unknown>).my_theme_setting).toBe("dark");
  });

  /** Recorded, or the keys exist only as accessor names and nothing can list them. */
  it("records what each store holds", () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme", "locale"]);

    expect(storedAttributes(User).settings).toEqual(["theme", "locale"]);
    expect(storeKeyDeclared(User, "settings", "theme")).toBe(true);
    expect(storeKeyDeclared(User, "settings", "other")).toBe(false);
  });

  it("keeps two stores' keys apart in the registry", () => {
    const User = userClass();
    storeAccessor(User, "settings", ["theme"]);
    storeAccessor(User, "preferences", ["locale"]);

    expect(storedAttributes(User).settings).toEqual(["theme"]);
    expect(storedAttributes(User).preferences).toEqual(["locale"]);
  });
});

describe("asJson", () => {
  it("gives the attributes", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(asJson(user).name).toBe("Ada");
  });

  it("respects only", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada", settings: { a: 1 } });

    expect(Object.keys(asJson(user, { only: ["name"] }))).toEqual(["name"]);
  });

  it("respects except", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada", settings: { a: 1 } });

    expect(Object.keys(asJson(user, { except: ["settings"] }))).not.toContain("settings");
  });

  /** Rails: include_root_in_json. */
  it("wraps in a root when asked", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(asJson(user, { root: true, only: ["name"] })).toEqual({ user: { name: "Ada" } });
  });

  it("takes an explicit root name", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(asJson(user, { root: "person", only: ["name"] })).toEqual({ person: { name: "Ada" } });
  });

  it("wraps when the global setting is on", async () => {
    setIncludeRootInJson(true);
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(Object.keys(asJson(user, { only: ["name"] }))).toEqual(["user"]);
  });

  it("stringifies", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(JSON.parse(toJson(user, { only: ["name"] }))).toEqual({ name: "Ada" });
  });
});

describe("readAttributeForSerialization", () => {
  /** The seam that lets a model present a value differently from how it stores it. */
  it("reads a plain attribute", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(readAttributeForSerialization(user, "name")).toBe("Ada");
  });

  it("calls a method", () => {
    const record = {
      greeting(): string {
        return "hi";
      },
    };

    expect(readAttributeForSerialization(record, "greeting")).toBe("hi");
  });
});

describe("toXml", () => {
  it("names the root after the model", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(toXml(user, { only: ["name"] })).toContain("<user>");
  });

  it("writes an element per attribute", async () => {
    const User = userClass();
    const user = User.build({ name: "Ada" });

    expect(toXml(user, { only: ["name"] })).toContain("<name>Ada</name>");
  });

  /** The reason a shared implementation exists: this is where injection goes. */
  it("escapes the values", async () => {
    const User = userClass();
    const user = User.build({ name: "<script>&" });

    expect(toXml(user, { only: ["name"] })).toContain("&lt;script&gt;&amp;");
  });

  it("marks a null", async () => {
    const User = userClass();
    const user = User.build({ name: null as unknown as string });

    expect(toXml(user, { only: ["name"] })).toContain('<name nil="true"/>');
  });

  it("types a number", async () => {
    const User = userClass();
    const user = await User.create({ name: "Ada" });

    expect(toXml(user, { only: ["id"] })).toContain('type="integer"');
  });
});
