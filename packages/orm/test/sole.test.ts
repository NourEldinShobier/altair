/**
 * Exactly one record.
 *
 * Mirrors activerecord/test/cases/relations_test.rb's `sole` and
 * `find_sole_by` cases.
 *
 * The point is not that it finds a record — `first` does that. It is that it
 * refuses when there are two. A lookup meant to be unique that quietly returns
 * the first of two is a duplicate nobody finds out about until the wrong one
 * is charged, emailed, or deleted.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  Model,
  RecordNotFound,
  SchemaStatements,
  SoleRecordExceeded,
  setConnection,
} from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { testConnection } from "./support/database.js";

interface UserRow {
  id: number;
  email: string;
  team: string;
}

class User extends Model<UserRow>("users") {}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  User.columnCache = undefined;
  User.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("users", { ifExists: true });
  await schema.createTable("users", (t) => {
    t.string("email");
    t.string("team");
  });

  await User.create({ email: "ada@example.com", team: "one" });
  await User.create({ email: "dup@example.com", team: "two" });
  await User.create({ email: "dup@example.com", team: "two" });
});

describe("when exactly one matches", () => {
  it("returns it", async () => {
    expect((await User.findSoleBy({ email: "ada@example.com" })).email).toBe("ada@example.com");
  });

  it("works on a relation too", async () => {
    expect((await User.where({ email: "ada@example.com" }).sole()).team).toBe("one");
  });

  it("works after other clauses", async () => {
    const found = await User.where({ team: "one" }).where({ email: "ada@example.com" }).sole();

    expect(found.team).toBe("one");
  });

  // A prior `limit(1)` does not make two rows into one. It has to fetch two to
  // know there are two, so the limit it was given is not the limit it uses —
  // which is what Rails does, and worth saying out loud because the call reads
  // like it should succeed.
  it("looks past a limit that would have hidden the second row", () => {
    expect(User.where({ email: "dup@example.com" }).limit(1).sole()).rejects.toBeInstanceOf(
      SoleRecordExceeded,
    );
  });
});

describe("when more than one matches", () => {
  it("refuses rather than choosing", () => {
    expect(User.findSoleBy({ email: "dup@example.com" })).rejects.toBeInstanceOf(
      SoleRecordExceeded,
    );
  });

  it("says which table it was looking in", () => {
    expect(User.findSoleBy({ email: "dup@example.com" })).rejects.toThrow(/users/);
  });

  // The behaviour this exists to contrast with, kept in front of the reader.
  it("is the case findBy answers anyway", async () => {
    expect(await User.findBy({ email: "dup@example.com" })).not.toBeNull();
  });

  // Two rows are fetched, not counted separately, so a third row changes
  // nothing about the answer.
  it("refuses the same way for three", async () => {
    await User.create({ email: "dup@example.com", team: "three" });

    expect(User.findSoleBy({ email: "dup@example.com" })).rejects.toBeInstanceOf(
      SoleRecordExceeded,
    );
  });
});

describe("when nothing matches", () => {
  // A different failure from finding two, and worth telling apart: one means
  // the record is missing, the other means the data has a duplicate.
  it("raises the not-found error, not the too-many one", () => {
    expect(User.findSoleBy({ email: "nobody@example.com" })).rejects.toBeInstanceOf(RecordNotFound);
  });

  it("is not the same error as finding two", () => {
    expect(User.findSoleBy({ email: "nobody@example.com" })).rejects.not.toBeInstanceOf(
      SoleRecordExceeded,
    );
  });
});
