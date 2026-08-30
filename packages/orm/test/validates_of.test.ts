/**
 * The validates_*_of family and validator introspection, ported from
 * `activemodel/test/cases/validations/*_validation_test.rb`.
 *
 * These are Rails' older API and they are wrappers over `validates`, so the
 * tests are about the wrapping: that several attributes really get the rule,
 * that the options survive, and that a subclass does not disturb its parent.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface EntryRow {
  id: number;
  title: string | null;
  body: string | null;
  rank: number | null;
  state: string | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("entries", (t) => {
    t.string("title");
    t.string("body");
    t.integer("rank");
    t.string("state");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

function model() {
  class Entry extends Model<EntryRow>("entries") {}
  Entry.columnCache = undefined;
  Entry.columnTypeCache = undefined;
  return Entry;
}

describe("validatesPresenceOf", () => {
  it("applies to every attribute named", async () => {
    const Entry = model();
    Entry.validatesPresenceOf(["title", "body"]);

    const entry = Entry.build({});

    expect(await entry.validate()).toBe(false);
    expect(entry.errors.has("title")).toBe(true);
    expect(entry.errors.has("body")).toBe(true);
  });

  it("takes a single attribute as a bare string", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");

    expect(await Entry.build({ title: null }).validate()).toBe(false);
  });

  it("passes when the attributes are there", async () => {
    const Entry = model();
    Entry.validatesPresenceOf(["title", "body"]);

    expect(await Entry.build({ title: "a", body: "b" }).validate()).toBe(true);
  });

  /** The options have to survive the wrapping, or `on:` silently stops working. */
  it("keeps the options", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title", { message: "is required" });

    const entry = Entry.build({});
    await entry.validate();

    expect(entry.errors.on("title")).toContain("is required");
  });
});

describe("the rest of the family", () => {
  it("validates absence", async () => {
    const Entry = model();
    Entry.validatesAbsenceOf("title");

    expect(await Entry.build({ title: "here" }).validate()).toBe(false);
    expect(await Entry.build({}).validate()).toBe(true);
  });

  it("validates length", async () => {
    const Entry = model();
    Entry.validatesLengthOf("title", { minimum: 3 });

    expect(await Entry.build({ title: "ab" }).validate()).toBe(false);
    expect(await Entry.build({ title: "abc" }).validate()).toBe(true);
  });

  it("validates format", async () => {
    const Entry = model();
    Entry.validatesFormatOf("title", { with: /^[a-z]+$/ });

    expect(await Entry.build({ title: "AB" }).validate()).toBe(false);
    expect(await Entry.build({ title: "ab" }).validate()).toBe(true);
  });

  it("validates inclusion", async () => {
    const Entry = model();
    Entry.validatesInclusionOf("state", { in: ["draft", "live"] });

    expect(await Entry.build({ state: "other" }).validate()).toBe(false);
    expect(await Entry.build({ state: "draft" }).validate()).toBe(true);
  });

  it("validates exclusion", async () => {
    const Entry = model();
    Entry.validatesExclusionOf("state", { in: ["banned"] });

    expect(await Entry.build({ state: "banned" }).validate()).toBe(false);
    expect(await Entry.build({ state: "fine" }).validate()).toBe(true);
  });

  it("validates numericality", async () => {
    const Entry = model();
    Entry.validatesNumericalityOf("rank", { greaterThan: 0 });

    expect(await Entry.build({ rank: 0 }).validate()).toBe(false);
    expect(await Entry.build({ rank: 1 }).validate()).toBe(true);
  });

  it("spreads a rule across several attributes", async () => {
    const Entry = model();
    Entry.validatesLengthOf(["title", "body"], { minimum: 2 });

    const entry = Entry.build({ title: "a", body: "b" });
    await entry.validate();

    expect(entry.errors.attributes.sort()).toEqual(["body", "title"]);
  });
});

describe("introspection", () => {
  it("lists the validations for one attribute", () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");
    Entry.validatesLengthOf("title", { minimum: 3 });

    expect(Entry.validatorsOn("title")).toHaveLength(2);
  });

  it("gives nothing for an attribute with no rules", () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");

    expect(Entry.validatorsOn("body")).toEqual([]);
  });

  it("lists every validation", () => {
    const Entry = model();
    Entry.validatesPresenceOf(["title", "body"]);

    expect(Entry.validators()).toHaveLength(2);
  });

  it("hands back a copy rather than the live list", () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");
    Entry.validators().push({ attribute: "body", options: { presence: true } });

    expect(Entry.validators()).toHaveLength(1);
  });

  it("clears them", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");
    Entry.clearValidators();

    expect(Entry.validators()).toEqual([]);
    expect(await Entry.build({}).validate()).toBe(true);
  });

  /** Copy on write: clearing a subclass must not disarm its parent. */
  it("does not disturb the parent when a subclass clears", async () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");

    class Draft extends Entry {}
    Draft.clearValidators();

    expect(Draft.validators()).toEqual([]);
    expect(Entry.validators()).toHaveLength(1);
    expect(await Entry.build({}).validate()).toBe(false);
  });

  /** And the same the other way: declaring on a subclass leaves the parent. */
  it("does not disturb the parent when a subclass declares", () => {
    const Entry = model();
    Entry.validatesPresenceOf("title");

    class Draft extends Entry {}
    Draft.validatesPresenceOf("body");

    expect(Draft.validators()).toHaveLength(2);
    expect(Entry.validators()).toHaveLength(1);
  });
});
