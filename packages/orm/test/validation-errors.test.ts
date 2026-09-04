/**
 * The errors object, ported from `activemodel/test/cases/errors_test.rb`.
 *
 * The cases that matter here are the ones about the *type* of an error rather
 * than its message. A message is translated, so a caller matching on it works
 * in exactly one locale; the type is what survives.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection, ValidationErrors } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

describe("adding and reading", () => {
  it("records a message", () => {
    const errors = new ValidationErrors();
    errors.add("name", "cannot be nil");

    expect(errors.on("name")).toEqual(["cannot be nil"]);
  });

  /** Rails: more than one error can be added to the same attribute. */
  it("keeps several on one attribute", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too short");
    errors.add("name", "is invalid");

    expect(errors.on("name")).toEqual(["is too short", "is invalid"]);
    expect(errors.count).toBe(2);
  });

  it("gives nothing for an attribute with none", () => {
    expect(new ValidationErrors().on("absent")).toEqual([]);
  });

  /** Rails: errors.include? */
  it("reports which attributes have errors", () => {
    const errors = new ValidationErrors();
    errors.add("name", "cannot be nil");

    expect(errors.has("name")).toBe(true);
    expect(errors.has("age")).toBe(false);
    expect(errors.attributes).toEqual(["name"]);
  });

  it("starts empty", () => {
    const errors = new ValidationErrors();

    expect(errors.isEmpty).toBe(true);
    expect(errors.count).toBe(0);
  });

  it("clears", () => {
    const errors = new ValidationErrors();
    errors.add("name", "x");
    errors.clear();

    expect(errors.isEmpty).toBe(true);
  });

  /** Rails: delete returns the deleted messages. */
  it("deletes an attribute and hands back what it removed", () => {
    const errors = new ValidationErrors();
    errors.add("name", "cannot be nil");

    expect(errors.delete("name")).toEqual(["cannot be nil"]);
    expect(errors.on("name")).toEqual([]);
  });

  it("iterates attribute and message pairs", () => {
    const errors = new ValidationErrors();
    errors.add("name", "a");
    errors.add("age", "b");

    expect([...errors]).toEqual([
      { attribute: "name", message: "a" },
      { attribute: "age", message: "b" },
    ]);
  });
});

describe("error objects", () => {
  it("carries the attribute, message and type", () => {
    const errors = new ValidationErrors();
    errors.add("name", "cannot be nil", "blank");
    const [error] = errors.objects;

    expect(error?.attribute).toBe("name");
    expect(error?.message).toBe("cannot be nil");
    expect(error?.type).toBe("blank");
  });

  it("defaults the type to invalid", () => {
    const errors = new ValidationErrors();
    errors.add("name", "x");

    expect(errors.objects[0]?.type).toBe("invalid");
  });

  /** Rails: errors.where(:name, :too_long, count: 25) */
  it("narrows by attribute", () => {
    const errors = new ValidationErrors();
    errors.add("name", "a");
    errors.add("age", "b");

    expect(errors.where("name")).toHaveLength(1);
  });

  it("narrows by type", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long", { count: 25 });
    errors.add("name", "is invalid", "invalid");

    expect(errors.where("name", "too_long")).toHaveLength(1);
  });

  it("narrows by an option", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long", { count: 25 });

    expect(errors.where("name", "too_long", { count: 25 })).toHaveLength(1);
    expect(errors.where("name", "too_long", { count: 10 })).toHaveLength(0);
  });

  it("gives the messages for one attribute and type", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long");
    errors.add("name", "is invalid", "invalid");

    expect(errors.messagesFor("name", "too_long")).toEqual(["is too long"]);
  });

  /** Rails: group_by_attribute */
  it("groups the objects by attribute", () => {
    const errors = new ValidationErrors();
    errors.add("name", "a");
    errors.add("name", "b");
    errors.add("age", "c");
    const grouped = errors.groupByAttribute();

    expect(grouped.name).toHaveLength(2);
    expect(grouped.age).toHaveLength(1);
  });
});

describe("details", () => {
  /** Rails: errors.details — what an API renders instead of prose. */
  it("reports the type by attribute", () => {
    const errors = new ValidationErrors();
    errors.add("name", "cannot be nil", "blank");

    expect(errors.details()).toEqual({ name: [{ error: "blank" }] });
  });

  it("includes whatever the rule was given", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long", { count: 25 });

    expect(errors.details()).toEqual({ name: [{ error: "too_long", count: 25 }] });
  });

  it("reports several on one attribute", () => {
    const errors = new ValidationErrors();
    errors.add("name", "a", "blank");
    errors.add("name", "b", "invalid");

    expect(errors.details().name).toHaveLength(2);
  });

  it("is empty when nothing went wrong", () => {
    expect(new ValidationErrors().details()).toEqual({});
  });
});

describe("ofKind", () => {
  /** Rails: of_kind? takes a type or a whole message. */
  it("matches a type", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long");

    expect(errors.ofKind("name", "too_long")).toBe(true);
    expect(errors.ofKind("name", "not_too_long")).toBe(false);
  });

  it("matches a whole message", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long");

    expect(errors.ofKind("name", "is too long")).toBe(true);
  });

  /** Rails: a partial message does not match. */
  it("does not match part of a message", () => {
    const errors = new ValidationErrors();
    errors.add("name", "is too long", "too_long");

    expect(errors.ofKind("name", "is too")).toBe(false);
  });

  it("is false for an attribute with no errors", () => {
    expect(new ValidationErrors().ofKind("name")).toBe(false);
  });
});

describe("importErrors and copy", () => {
  /** Rails: errors.import, for nested and associated records. */
  it("takes another object's errors", () => {
    const source = new ValidationErrors();
    source.add("title", "cannot be nil", "blank");

    const target = new ValidationErrors();
    target.importErrors(source);

    expect(target.on("title")).toEqual(["cannot be nil"]);
    expect(target.objects[0]?.type).toBe("blank");
  });

  it("prefixes the attribute when asked", () => {
    const source = new ValidationErrors();
    source.add("title", "cannot be nil");

    const target = new ValidationErrors();
    target.importErrors(source, "post");

    expect(target.attributes).toEqual(["post.title"]);
  });

  it("keeps what it already had", () => {
    const source = new ValidationErrors();
    source.add("title", "a");

    const target = new ValidationErrors();
    target.add("body", "b");
    target.importErrors(source);

    expect(target.count).toBe(2);
  });

  /** Rails: copy! replaces rather than merges. */
  it("replaces on copy", () => {
    const source = new ValidationErrors();
    source.add("title", "a");

    const target = new ValidationErrors();
    target.add("body", "b");
    target.copy(source);

    expect(target.attributes).toEqual(["title"]);
  });
});

/**
 * The types have to reach the errors object from the validators, or `details`
 * reports `invalid` for everything and is worth nothing.
 */
describe("the types the validators record", () => {
  interface EntryRow {
    id: number;
    title: string | null;
    rank: number | null;
  }

  let connection: Connection;

  beforeEach(async () => {
    connection = await testConnection();
    setConnection(connection);

    await new SchemaStatements(connection).createTable("entries", (t) => {
      t.string("title");
      t.integer("rank");
    });
  });

  afterEach(async () => {
    if (isSqlite) await connection.close();
  });

  function model() {
    class Entry extends Model<EntryRow>("entries") {}
    Entry.resetColumnInformation();
    return Entry;
  }

  it("records blank for presence", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");
    const entry = Entry.build({});
    await entry.validate();

    expect(entry.errors.details()).toEqual({ title: [{ error: "blank" }] });
  });

  it("records too_short with the count", async () => {
    const Entry = model();
    Entry.validatesLengthOf("title", { minimum: 5 });
    const entry = Entry.build({ title: "ab" });
    await entry.validate();

    expect(entry.errors.details()).toEqual({ title: [{ error: "too_short", count: 5 }] });
  });

  it("records too_long with the count", async () => {
    const Entry = model();
    Entry.validatesLengthOf("title", { maximum: 2 });
    const entry = Entry.build({ title: "abcdef" });
    await entry.validate();

    expect(entry.errors.details().title?.[0]).toEqual({ error: "too_long", count: 2 });
  });

  it("records inclusion", async () => {
    const Entry = model();
    Entry.validatesInclusionOf("title", { in: ["draft"] });
    const entry = Entry.build({ title: "other" });
    await entry.validate();

    expect(entry.errors.details().title?.[0]?.error).toBe("inclusion");
  });

  it("records greater_than with the bound", async () => {
    const Entry = model();
    Entry.validatesNumericalityOf("rank", { greaterThan: 3 });
    const entry = Entry.build({ rank: 1 });
    await entry.validate();

    expect(entry.errors.details().rank?.[0]).toEqual({ error: "greater_than", count: 3 });
  });

  it("records not_a_number", async () => {
    const Entry = model();
    Entry.validatesNumericalityOf("title", {});
    const entry = Entry.build({ title: "abc" });
    await entry.validate();

    expect(entry.errors.details().title?.[0]?.error).toBe("not_a_number");
  });

  /** The type is what a caller branches on, so it must survive a custom message. */
  it("keeps the type when the message was overridden", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title", { message: "is required" });
    const entry = Entry.build({});
    await entry.validate();

    expect(entry.errors.on("title")).toEqual(["is required"]);
    expect(entry.errors.details().title?.[0]?.error).toBe("blank");
  });

  it("lets a caller ask by kind", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");
    const entry = Entry.build({});
    await entry.validate();

    expect(entry.errors.ofKind("title", "blank")).toBe(true);
    expect(entry.errors.ofKind("title", "too_long")).toBe(false);
  });
});
