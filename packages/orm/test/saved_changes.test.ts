/**
 * What the last save changed, ported from
 * `activerecord/test/cases/dirty_test.rb`.
 *
 * By the time an after-save callback runs the record is clean — that is the
 * point of saving — so `changes()` is empty and "did the email change?" has no
 * answer. Rails added `saved_changes` for exactly that, and it is the question
 * every confirmation email and every cache expiry is built on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";

interface UserRow {
  id: number;
  email: string;
  name: string | null;
}

class User extends Model<UserRow>("users") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  User.columnCache = undefined;
  User.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("users", (t) => {
    t.string("email");
    t.string("name");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("after an update", () => {
  it("says what changed, and to what", async () => {
    const user = await User.create({ email: "ada@example.com", name: "Ada" });

    user.email = "ada@lovelace.example";
    await user.save();

    expect(user.savedChanges().email).toEqual(["ada@example.com", "ada@lovelace.example"]);
  });

  it("says nothing about what did not", async () => {
    const user = await User.create({ email: "ada@example.com", name: "Ada" });

    user.email = "ada@lovelace.example";
    await user.save();

    expect("name" in user.savedChanges()).toBe(false);
  });

  it("answers the question directly", async () => {
    const user = await User.create({ email: "ada@example.com", name: "Ada" });

    user.email = "ada@lovelace.example";
    await user.save();

    expect(user.hasSavedChange("email")).toBe(true);
    expect(user.hasSavedChange("name")).toBe(false);
    expect(user.hasSavedChange()).toBe(true);
  });

  it("remembers what it held before", async () => {
    const user = await User.create({ email: "ada@example.com", name: "Ada" });

    user.email = "ada@lovelace.example";
    await user.save();

    expect(user.attributeBeforeLastSave("email")).toBe("ada@example.com");
  });

  /**
   * The whole reason this exists. `changed()` is empty here — the record is
   * clean — so anything asking after the save has only this to go on.
   */
  it("is there when the record itself is clean again", async () => {
    const user = await User.create({ email: "ada@example.com" });

    user.email = "ada@lovelace.example";
    await user.save();

    expect(user.changed()).toEqual([]);
    expect(user.hasSavedChange("email")).toBe(true);
  });
});

describe("in an after-save callback", () => {
  it("can see what the save did", async () => {
    const seen: string[] = [];

    class Member extends Model<UserRow>("users") {
      static {
        this.setCallback("save", "after", function (this: Member) {
          if (this.hasSavedChange("email"))
            seen.push(String(this.attributeBeforeLastSave("email")));
        });
      }
    }

    const member = await Member.create({ email: "first@example.com" });
    member.email = "second@example.com";
    await member.save();

    // Once for the create, once for the update — and the update knows what the
    // address used to be, which is what a confirmation email needs.
    expect(seen).toEqual(["undefined", "first@example.com"]);
  });
});

describe("after a create", () => {
  it("counts every attribute as changed", async () => {
    const user = await User.create({ email: "ada@example.com", name: "Ada" });

    expect(user.hasSavedChange("email")).toBe(true);
    expect(user.savedChanges().email?.[1]).toBe("ada@example.com");
  });
});

describe("before anything has been saved", () => {
  it("has nothing to report", async () => {
    const user = new User({ email: "ada@example.com" });

    expect(user.savedChanges()).toEqual({});
    expect(user.hasSavedChange()).toBe(false);
    expect(user.hasSavedChange("email")).toBe(false);
  });
});

describe("a save that changed nothing", () => {
  it("reports nothing", async () => {
    const user = await User.create({ email: "ada@example.com" });

    await user.save();

    expect(user.hasSavedChange()).toBe(false);
  });
});

// Handed out rather than shared: a caller that edits what it is given should
// not be editing the record's own record of the save.
describe("the map it answers with", () => {
  it("is a copy", async () => {
    const user = await User.create({ email: "ada@example.com" });

    user.email = "b@example.com";
    await user.save();

    delete user.savedChanges().email;

    expect(user.hasSavedChange("email")).toBe(true);
  });
});
