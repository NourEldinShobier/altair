/**
 * Reading rows written under a retired key, ported from the
 * `previous:` cases in
 * `activerecord/test/cases/encryption/encryptable_record_test.rb`.
 *
 * A rotation that cannot read the old key is not a rotation, it is an outage:
 * every encrypted row in the database was written under the previous secret,
 * and re-encrypting them all before the new one can be deployed is a migration
 * that has to run while the application is down.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  UnreadableCiphertext,
  configureEncryption,
  decryptValue,
  encryptValue,
  previousTypes,
  resetEncryption,
} from "../src/encryption.js";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const NEVER_USED = "c".repeat(64);

interface VaultRow {
  id: number;
  ssn: string | null;
  email: string | null;
}

class Vault extends Model<VaultRow>("vaults") {
  static {
    this.encrypts("ssn");
    this.encrypts("email", { deterministic: true });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  Vault.resetColumnInformation();

  await new SchemaStatements(connection).createTable("vaults", (t) => {
    t.string("ssn", { limit: 500 });
    t.string("email", { limit: 500 });
  });
});

afterEach(() => {
  resetEncryption();
});

describe("the keys that still read", () => {
  it("are none until a rotation", () => {
    configureEncryption(NEW);

    expect(previousTypes()).toHaveLength(0);
  });

  it("are the ones the configuration kept", () => {
    configureEncryption(NEW, { previous: [OLD] });

    expect(previousTypes()).toHaveLength(1);
  });

  /**
   * Replaced, not added to. A key is retired so it can eventually be dropped,
   * and a list that only ever grew would mean every secret the application has
   * ever used stays able to read the database.
   */
  it("are replaced by the next configuration, not added to", () => {
    configureEncryption(NEW, { previous: [OLD] });
    configureEncryption(NEW);

    expect(previousTypes()).toHaveLength(0);
  });

  it("are forgotten by a reset", () => {
    configureEncryption(NEW, { previous: [OLD] });
    resetEncryption();

    expect(previousTypes()).toHaveLength(0);
  });
});

describe("a value written under the old key", () => {
  it("is read under the new one", () => {
    configureEncryption(OLD);
    const written = encryptValue("123-45-6789");

    configureEncryption(NEW, { previous: [OLD] });

    expect(decryptValue(written, "ssn")).toBe("123-45-6789");
  });

  it("is read when it was deterministic", () => {
    configureEncryption(OLD);
    const written = encryptValue("bob@example.com", { deterministic: true });

    configureEncryption(NEW, { previous: [OLD] });

    expect(decryptValue(written, "email", { deterministic: true })).toBe("bob@example.com");
  });

  /** Which is what makes a rotation an outage without this. */
  it("is unreadable when the old key was not kept", () => {
    configureEncryption(OLD);
    const written = encryptValue("123-45-6789");

    configureEncryption(NEW);

    expect(() => decryptValue(written, "ssn")).toThrow(UnreadableCiphertext);
  });

  /**
   * Two causes look identical from here — a key that changed and a column
   * that was never encrypted — and the message has to name both, because the
   * fix for one is nothing like the fix for the other.
   */
  it("says the old key may not have been kept", () => {
    configureEncryption(OLD);
    const written = encryptValue("123-45-6789");

    configureEncryption(NEW);

    expect(() => decryptValue(written, "ssn")).toThrow("without the old one being kept");
    expect(() => decryptValue(written, "ssn")).toThrow("configureEncryption");
    expect(() => decryptValue(written, "ssn")).toThrow("supportUnencrypted");
  });

  it("is still unreadable under a key that never wrote it", () => {
    configureEncryption(OLD);
    const written = encryptValue("123-45-6789");

    configureEncryption(NEW, { previous: [NEVER_USED] });

    expect(() => decryptValue(written, "ssn")).toThrow(UnreadableCiphertext);
  });

  it("is found among several retired keys", () => {
    configureEncryption(OLD);
    const written = encryptValue("123-45-6789");

    configureEncryption(NEW, { previous: [NEVER_USED, OLD] });

    expect(decryptValue(written, "ssn")).toBe("123-45-6789");
  });
});

describe("what gets written after a rotation", () => {
  /** The new key writes; the old ones only read. */
  it("is under the new key alone", () => {
    configureEncryption(NEW, { previous: [OLD] });
    const written = encryptValue("123-45-6789");

    // Readable with the new key and nothing retired at all.
    configureEncryption(NEW);

    expect(decryptValue(written, "ssn")).toBe("123-45-6789");
  });

  /** Rows move over as they are next saved, not in one migration. */
  it("moves a row over when it is saved again", async () => {
    configureEncryption(OLD);
    const created = await Vault.create({ ssn: "123-45-6789" });

    configureEncryption(NEW, { previous: [OLD] });
    const found = (await Vault.find(created.id)) as Vault;

    expect(found.ssn).toBe("123-45-6789");

    found.ssn = "987-65-4321";
    await found.save();

    configureEncryption(NEW);
    const again = await Vault.find(created.id);

    expect(again?.ssn).toBe("987-65-4321");
  });
});

describe("through a model", () => {
  it("reads a row written before the rotation", async () => {
    configureEncryption(OLD);
    const created = await Vault.create({ ssn: "123-45-6789", email: "bob@example.com" });

    configureEncryption(NEW, { previous: [OLD] });
    const found = await Vault.find(created.id);

    expect(found?.ssn).toBe("123-45-6789");
  });

  /**
   * A deterministic column is looked up by encrypting the search value, so a
   * row written under the old key is findable only by re-encrypting under
   * that key — which is what the retired keys cannot help with. The row still
   * reads; it just does not answer a query until it is saved again.
   */
  it("cannot find a deterministic row written under the old key", async () => {
    configureEncryption(OLD);
    await Vault.create({ email: "bob@example.com" });

    configureEncryption(NEW, { previous: [OLD] });

    expect(await Vault.where({ email: "bob@example.com" }).exists()).toBe(false);
  });
});
