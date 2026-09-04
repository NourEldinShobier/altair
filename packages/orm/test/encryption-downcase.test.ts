/**
 * Folding a deterministically encrypted value, ported from the `downcase:`
 * cases in
 * `activerecord/test/cases/encryption/downcase_encrypted_attribute_type_test.rb`.
 *
 * The failure this exists for is silent. A deterministic column is looked up
 * by encrypting the search value and comparing ciphertext — the database has
 * no plaintext to apply `LOWER` to — so a search for `Bob@example.com` against
 * a row stored as `bob@example.com` returns nothing at all. Not an error, not
 * a warning: an empty result, which reads as "no such user".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  PointlessDowncase,
  configureEncryption,
  decryptValue,
  encryptValue,
  resetEncryption,
} from "../src/encryption.js";

interface AccountRow {
  id: number;
  email: string | null;
  exact: string | null;
}

class Account extends Model<AccountRow>("accounts") {
  static {
    this.encrypts("email", { deterministic: true, downcase: true });
    this.encrypts("exact", { deterministic: true });
  }
}

let connection: Connection;

beforeEach(async () => {
  configureEncryption("a".repeat(64));

  connection = await testConnection();
  setConnection(connection);
  Account.resetColumnInformation();

  await new SchemaStatements(connection).createTable("accounts", (t) => {
    t.string("email", { limit: 500 });
    t.string("exact", { limit: 500 });
  });
});

afterEach(() => {
  resetEncryption();
});

describe("the value that gets encrypted", () => {
  it("is folded to lower case", () => {
    const options = { deterministic: true, downcase: true };

    expect(decryptValue(encryptValue("Bob@Example.com", options), "email", options)).toBe(
      "bob@example.com",
    );
  });

  /** Which is what makes the two sides of a lookup agree. */
  it("is the same ciphertext however it was typed", () => {
    const options = { deterministic: true, downcase: true };

    expect(encryptValue("Bob@Example.com", options)).toBe(encryptValue("bob@example.com", options));
  });

  it("leaves the value alone without the option", () => {
    const options = { deterministic: true };

    expect(encryptValue("Bob@Example.com", options)).not.toBe(
      encryptValue("bob@example.com", options),
    );
  });

  /**
   * A non-string was serialised to JSON first, and folding that would change
   * the keys as well as the values.
   */
  it("does not fold a value that is not a string", () => {
    const options = { deterministic: true, downcase: true };

    expect(decryptValue(encryptValue({ Name: "Bob" }, options), "email", options)).toBe(
      '{"Name":"Bob"}',
    );
  });

  it("still leaves null alone", () => {
    const options = { deterministic: true, downcase: true };

    expect(encryptValue(null, options)).toBeNull();
    expect(encryptValue(undefined, options)).toBeUndefined();
  });
});

describe("downcasing a column nobody can look up", () => {
  /**
   * On a non-deterministic column there is nothing to look up, so folding
   * throws the original case away and enables nothing.
   */
  it("is refused", () => {
    expect(() => encryptValue("Bob", { downcase: true })).toThrow(PointlessDowncase);
    expect(() => encryptValue("Bob", { downcase: true })).toThrow("normalizes");
  });
});

describe("through a model", () => {
  it("finds the row however the search was typed", async () => {
    await Account.create({ email: "Bob@Example.com", exact: "Bob@Example.com" });

    expect(await Account.where({ email: "bob@example.com" }).exists()).toBe(true);
    expect(await Account.where({ email: "BOB@EXAMPLE.COM" }).exists()).toBe(true);
  });

  /** The column without the option is the one that shows why it is needed. */
  it("does not find a differently typed value without it", async () => {
    await Account.create({ email: "Bob@Example.com", exact: "Bob@Example.com" });

    expect(await Account.where({ exact: "bob@example.com" }).exists()).toBe(false);
    expect(await Account.where({ exact: "Bob@Example.com" }).exists()).toBe(true);
  });

  it("reads back folded, which is the cost", async () => {
    await Account.create({ email: "Bob@Example.com" });

    const found = await Account.where({ email: "bob@example.com" }).first();

    expect(found?.email).toBe("bob@example.com");
  });

  it("holds ciphertext in the column either way", async () => {
    await Account.create({ email: "Bob@Example.com" });

    const rows = await connection.query<{ email: string }>(
      `SELECT ${connection.quote("email")} FROM ${connection.quote("accounts")}`,
    );

    expect(rows[0]?.email).not.toContain("example.com");
  });
});
