/**
 * Optimistic locking.
 *
 * Mirrors activerecord/test/cases/locking_test.rb. The case that matters is
 * two people reading the same row and both saving: without a version column
 * the second save silently discards the first, and nobody finds out.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model, StaleObjectError } from "../src/model.js";

interface PersonAttributes {
  id: number;
  name: string;
  title: string;
  lock_version: number;
}

class Person extends Model<PersonAttributes>("people") {}

/** The same table without the version column, to show locking stays opt-in. */
interface NoteAttributes {
  id: number;
  body: string;
}

class Note extends Model<NoteAttributes>("notes") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Person.columnCache = undefined;
  Note.columnCache = undefined;

  const schema = new SchemaStatements(connection);

  await schema.createTable("people", (t) => {
    t.string("name");
    t.string("title");
    t.integer("lock_version", { default: 0 });
  });

  await schema.createTable("notes", (t) => t.string("body"));
});

describe("locking", () => {
  it("turns itself on when the table has the column", async () => {
    expect(await Person.lockingEnabled()).toBe(true);
    expect(await Note.lockingEnabled()).toBe(false);
  });

  it("starts a new record at version zero", async () => {
    const person = await Person.create({ name: "Ada" });
    expect(person.lock_version).toBe(0);
  });

  it("counts up on every save", async () => {
    const person = await Person.create({ name: "Ada" });

    await person.update({ name: "Ada L" });
    expect(person.lock_version).toBe(1);

    await person.update({ name: "Ada Lovelace" });
    expect(person.lock_version).toBe(2);
  });

  // The whole point. Two people read the same row; the second save is refused
  // rather than quietly overwriting the first.
  it("refuses a save made against a stale read", async () => {
    await Person.create({ name: "Ada" });

    const first = await Person.find(1);
    const second = await Person.find(1);

    await first.update({ title: "Countess" });

    second.name = "Someone else";
    await expect(second.save()).rejects.toThrow(StaleObjectError);
  });

  it("names the record it refused", async () => {
    await Person.create({ name: "Ada" });
    const first = await Person.find(1);
    const second = await Person.find(1);
    await first.update({ title: "Countess" });

    second.name = "Someone else";
    await expect(second.save()).rejects.toThrow("stale Person (id 1)");
  });

  // The refused save must leave the database as the winner left it.
  it("keeps the first writer's value", async () => {
    await Person.create({ name: "Ada" });
    const first = await Person.find(1);
    const second = await Person.find(1);

    await first.update({ name: "First" });
    second.name = "Second";
    await expect(second.save()).rejects.toThrow(StaleObjectError);

    expect((await Person.find(1)).name).toBe("First");
  });

  it("lets the loser save after reloading", async () => {
    await Person.create({ name: "Ada" });
    const first = await Person.find(1);
    const second = await Person.find(1);

    await first.update({ name: "First" });
    second.name = "Second";
    await expect(second.save()).rejects.toThrow(StaleObjectError);

    await second.reload();
    second.name = "Second";
    expect(await second.save()).toBe(true);
    expect((await Person.find(1)).name).toBe("Second");
  });

  it("leaves a table without the column alone", async () => {
    const note = await Note.create({ body: "no version here" });
    expect(await note.update({ body: "changed" })).toBe(true);
    expect((await Note.find(1)).body).toBe("changed");
  });

  // A save with nothing to write does not touch the row, so it must not spend
  // a version either — otherwise a no-op save invalidates everyone else's copy.
  it("does not count up when nothing changed", async () => {
    const person = await Person.create({ name: "Ada" });
    await person.save();

    expect(person.lock_version).toBe(0);
  });

  it("does not guard a delete", async () => {
    await Person.create({ name: "Ada" });
    const first = await Person.find(1);
    const second = await Person.find(1);

    await first.update({ name: "First" });

    // ponytail: Rails' lock check covers destroy too. Skipped, because a
    // delete that loses a race deletes the row either way.
    expect(await second.destroy()).toBe(true);
    expect(await Person.count()).toBe(0);
  });
});
