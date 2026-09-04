/**
 * What a blank value does to a validator, ported from
 * `activemodel/test/cases/validations/`.
 *
 * `length` and `format` skipped a blank value outright, so
 * `validates("email", { format: { with: /@/ } })` accepted an empty string —
 * and a form submitted with the field left blank sends "" rather than nothing.
 * The validation written to catch exactly that let it through.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

interface UserRow {
  id: number;
  email: string | null;
  name: string | null;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("users", (t) => {
    t.string("email");
    t.string("name");
  });
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

/** Builds a model with one validation, so each case reads on its own. */
const modelWith = (attribute: string, options: object) => {
  class Subject extends Model<UserRow>("users") {
    static {
      this.validates(attribute, options as never);
    }
  }

  Subject.resetColumnInformation();

  return Subject;
};

const errorsFor = async (
  Subject: ReturnType<typeof modelWith>,
  values: Partial<UserRow>,
): Promise<string[]> => {
  const record = new Subject(values);
  await record.validate();

  return record.errors.fullMessages();
};

describe("a format validation", () => {
  it("refuses an empty string", async () => {
    const Subject = modelWith("email", { format: { with: /@/ } });

    expect(await errorsFor(Subject, { email: "" })).toEqual(["Email is invalid"]);
  });

  it("refuses a missing value", async () => {
    const Subject = modelWith("email", { format: { with: /@/ } });

    expect(await errorsFor(Subject, { email: null })).toEqual(["Email is invalid"]);
  });

  it("accepts one that matches", async () => {
    const Subject = modelWith("email", { format: { with: /@/ } });

    expect(await errorsFor(Subject, { email: "ada@example.com" })).toEqual([]);
  });

  // How a caller asks for the lenient behaviour, which is the point of the
  // option existing.
  it("lets a missing value through when told to", async () => {
    const Subject = modelWith("email", { format: { with: /@/ }, allowNil: true });

    expect(await errorsFor(Subject, { email: null })).toEqual([]);
  });

  /**
   * `allowNil` is not `allowBlank`, and the difference is the whole point: an
   * empty form field sends "" rather than nothing, so a validation skipped for
   * nil still has to see the empty string.
   */
  it("still refuses an empty string when only nil is allowed", async () => {
    const Subject = modelWith("email", { format: { with: /@/ }, allowNil: true });

    expect(await errorsFor(Subject, { email: "" })).toEqual(["Email is invalid"]);
  });

  it("lets a blank through when that is what was asked for", async () => {
    const Subject = modelWith("email", { format: { with: /@/ }, allowBlank: true });

    expect(await errorsFor(Subject, { email: "" })).toEqual([]);
  });
});

describe("a length validation", () => {
  it("refuses an empty string that is too short", async () => {
    const Subject = modelWith("name", { length: { minimum: 3 } });

    expect(await errorsFor(Subject, { name: "" })).toEqual([
      "Name is too short (minimum is 3 characters)",
    ]);
  });

  it("refuses a missing value that is too short", async () => {
    const Subject = modelWith("name", { length: { minimum: 3 } });

    expect(await errorsFor(Subject, { name: null })).toEqual([
      "Name is too short (minimum is 3 characters)",
    ]);
  });

  it("accepts one that is long enough", async () => {
    const Subject = modelWith("name", { length: { minimum: 3 } });

    expect(await errorsFor(Subject, { name: "Ada" })).toEqual([]);
  });

  it("lets a missing value through when told to", async () => {
    const Subject = modelWith("name", { length: { minimum: 3 }, allowNil: true });

    expect(await errorsFor(Subject, { name: null })).toEqual([]);
  });

  // A maximum has nothing to say about an empty value, so this passes either
  // way — it is here to show the change did not make blanks fail everything.
  it("says nothing about an empty value under a maximum", async () => {
    const Subject = modelWith("name", { length: { maximum: 5 } });

    expect(await errorsFor(Subject, { name: "" })).toEqual([]);
  });
});
