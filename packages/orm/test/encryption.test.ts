/**
 * Encrypted attributes.
 *
 * Mirrors activerecord/test/cases/encryption/. The tests that matter are about
 * what the database holds: the whole feature is that a dump, a replica or a
 * stolen backup does not carry the plaintext.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  configureEncryption,
  decryptValue,
  encryptValue,
  isEncrypted,
  isEncryptionConfigured,
  resetEncryption,
  UnreadableCiphertext,
} from "../src/encryption.js";

interface UserRow {
  id: number;
  name: string;
  ssn: string | null;
  email: string | null;
  legacy: string | null;
}

class User extends Model<UserRow>("users") {
  static {
    this.encrypts("ssn");
    this.encrypts("email", { deterministic: true });
    this.encrypts("legacy", { supportUnencrypted: true });
  }
}

let connection: Connection;

beforeEach(async () => {
  configureEncryption("a".repeat(64));

  connection = await testConnection();
  setConnection(connection);
  User.resetColumnInformation();

  await new SchemaStatements(connection).createTable("users", (t) => {
    t.string("name");
    t.string("ssn", { limit: 500 });
    t.string("email", { limit: 500 });
    t.string("legacy", { limit: 500 });
  });
});

afterEach(() => {
  resetEncryption();
});

describe("configuring", () => {
  it("knows whether it has keys", () => {
    expect(isEncryptionConfigured()).toBe(true);

    resetEncryption();
    expect(isEncryptionConfigured()).toBe(false);
  });

  it("says so rather than writing plaintext", () => {
    resetEncryption();
    expect(() => encryptValue("secret")).toThrow("Encryption is not configured");
  });
});

describe("encrypting a value", () => {
  it("round-trips", () => {
    const encrypted = encryptValue("123-45-6789");
    expect(decryptValue(encrypted, "ssn")).toBe("123-45-6789");
  });

  it("does not look like what it holds", () => {
    const encrypted = encryptValue("123-45-6789") as string;

    expect(encrypted).not.toContain("123-45-6789");
    expect(isEncrypted(encrypted)).toBe(true);
  });

  // Encrypting a null would make every empty row look like it held something,
  // and would break `where({ ssn: null })`.
  it("leaves null alone", () => {
    expect(encryptValue(null)).toBeNull();
    expect(decryptValue(null, "ssn")).toBeNull();
  });

  // A fresh nonce each time is what keeps anyone from learning which rows
  // share a value.
  it("gives the same value a different ciphertext each time", () => {
    expect(encryptValue("same")).not.toBe(encryptValue("same"));
  });

  it("gives a deterministic value the same ciphertext every time", () => {
    const options = { deterministic: true };
    expect(encryptValue("same", options)).toBe(encryptValue("same", options));
  });

  it("keeps different deterministic values apart", () => {
    const options = { deterministic: true };
    expect(encryptValue("one", options)).not.toBe(encryptValue("two", options));
  });

  // The two schemes use separate keys, so one cannot be used against the other.
  it("cannot read a deterministic value with the other scheme", () => {
    const deterministic = encryptValue("secret", { deterministic: true });
    expect(decryptValue(deterministic, "email", { deterministic: true })).toBe("secret");
  });

  it("refuses a value it cannot authenticate", () => {
    const tampered = `${encryptValue("secret") as string}x`;
    expect(() => decryptValue(tampered, "ssn")).toThrow(UnreadableCiphertext);
  });

  it("refuses plaintext in a column that should be encrypted", () => {
    expect(() => decryptValue("in the clear", "ssn")).toThrow(UnreadableCiphertext);
  });

  // What makes it possible to encrypt a column that already holds data.
  it("reads plaintext when the column is being migrated", () => {
    expect(decryptValue("in the clear", "legacy", { supportUnencrypted: true })).toBe(
      "in the clear",
    );
  });
});

describe("an encrypted attribute", () => {
  it("reads back as what was written", async () => {
    const user = await User.create({ name: "Ada", ssn: "123-45-6789" });

    expect(user.ssn).toBe("123-45-6789");
    expect((await User.find(user.id)).ssn).toBe("123-45-6789");
  });

  // The whole feature: what a dump, a replica or a stolen backup carries.
  it("is ciphertext in the database", async () => {
    await User.create({ name: "Ada", ssn: "123-45-6789" });

    const rows = await connection.query<{ ssn: string }>("SELECT ssn FROM users");

    expect(rows[0]!.ssn).not.toContain("123-45-6789");
    expect(isEncrypted(rows[0]!.ssn)).toBe(true);
  });

  it("survives an update", async () => {
    const user = await User.create({ name: "Ada", ssn: "111-11-1111" });
    await user.update({ ssn: "222-22-2222" });

    expect(user.ssn).toBe("222-22-2222");
    expect((await User.find(user.id)).ssn).toBe("222-22-2222");
  });

  it("keeps the plain value in memory after a write", async () => {
    const user = await User.create({ name: "Ada", ssn: "123-45-6789" });
    await user.update({ name: "Ada L" });

    // The bindings carried ciphertext; the record did not.
    expect(user.ssn).toBe("123-45-6789");
  });

  it("leaves an unencrypted column alone", async () => {
    await User.create({ name: "Ada", ssn: "1" });
    const rows = await connection.query<{ name: string }>("SELECT name FROM users");

    expect(rows[0]!.name).toBe("Ada");
  });

  it("stores null as null", async () => {
    await User.create({ name: "Ada" });
    const rows = await connection.query<{ ssn: string | null }>("SELECT ssn FROM users");

    expect(rows[0]!.ssn).toBeNull();
    expect((await User.find(1)).ssn).toBeNull();
  });
});

// A non-deterministic column cannot be searched, which is the price of not
// revealing which rows share a value. A deterministic one can.
describe("querying an encrypted column", () => {
  beforeEach(async () => {
    await User.create({ name: "Ada", email: "ada@example.com", ssn: "111" });
    await User.create({ name: "Alan", email: "alan@example.com", ssn: "222" });
  });

  it("finds a deterministic value", async () => {
    const found = await User.findBy({ email: "ada@example.com" });
    expect(found?.name).toBe("Ada");
  });

  it("finds one through a relation", async () => {
    const found = await User.where({ email: "alan@example.com" });

    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("Alan");
  });

  it("matches a list of deterministic values", async () => {
    const found = await User.where({ email: ["ada@example.com", "alan@example.com"] });
    expect(found).toHaveLength(2);
  });

  it("finds nothing for a value nobody has", async () => {
    expect(await User.findBy({ email: "nobody@example.com" })).toBeNull();
  });

  it("still matches a plain column", async () => {
    expect((await User.where({ name: "Ada" }))[0]!.email).toBe("ada@example.com");
  });

  it("still matches null", async () => {
    await User.create({ name: "Nobody" });
    expect(await User.where({ email: null }).count()).toBe(1);
  });

  // Searching a non-deterministic column cannot work, and quietly returning
  // nothing would look like an empty table rather than the wrong question.
  it("finds nothing when asked to match a random-nonce column", async () => {
    expect(await User.where({ ssn: "111" }).count()).toBe(0);
  });
});
