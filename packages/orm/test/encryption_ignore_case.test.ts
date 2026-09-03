/**
 * Keeping the original spelling of a folded encrypted value, ported from
 * `activerecord/test/cases/encryption/case_insensitive_querying_test.rb`.
 *
 * `downcase` makes a deterministic column findable and loses how the value was
 * typed. That is fine for a lookup key and not fine for an address shown back
 * to the person who typed it — so this keeps both halves, and the second one
 * is encrypted as well, because storing it in the clear beside the ciphertext
 * would hand back everything the encryption was for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import {
  PointlessDowncase,
  configureEncryption,
  encryptValue,
  foldsCase,
  originalAttributeName,
  resetEncryption,
} from "../src/encryption.js";

interface AccountRow {
  id: number;
  email: string | null;
  original_email: string | null;
}

class Account extends Model<AccountRow>("accounts") {
  static {
    this.encrypts("email", { deterministic: true, ignoreCase: true });
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
    t.string("original_email", { limit: 500 });
  });
});

afterEach(() => {
  resetEncryption();
});

describe("where the original goes", () => {
  it("has a name derived from the attribute", () => {
    expect(originalAttributeName("email")).toBe("original_email");
  });

  it("is declared as an encrypted attribute of its own", () => {
    expect(Account.encryptedAttributes["original_email"]).toBeDefined();
  });

  /** Deterministic ciphertext of the original would leak the case back. */
  it("is not deterministic", () => {
    expect(Account.encryptedAttributes["original_email"]?.deterministic).not.toBe(true);
  });
});

describe("reading and writing", () => {
  it("gives back the original spelling", async () => {
    const account = await Account.create({ email: "Bob@Example.com" });

    expect(account.email).toBe("Bob@Example.com");
  });

  it("gives it back after a reload", async () => {
    await Account.create({ email: "Bob@Example.com" });

    const found = await Account.where({ email: "bob@example.com" }).first();

    expect(found?.email).toBe("Bob@Example.com");
  });

  /** Which is the whole point: the lookup works however the search was typed. */
  it("finds the row by any spelling", async () => {
    await Account.create({ email: "Bob@Example.com" });

    expect(await Account.where({ email: "bob@example.com" }).exists()).toBe(true);
    expect(await Account.where({ email: "BOB@EXAMPLE.COM" }).exists()).toBe(true);
    expect(await Account.where({ email: "Bob@Example.com" }).exists()).toBe(true);
  });

  it("does not find a genuinely different value", async () => {
    await Account.create({ email: "Bob@Example.com" });

    expect(await Account.where({ email: "alice@example.com" }).exists()).toBe(false);
  });

  it("takes a new spelling on assignment", async () => {
    const account = await Account.create({ email: "Bob@Example.com" });

    account.email = "ROBERT@example.com";

    expect(account.email).toBe("ROBERT@example.com");
    await account.save();

    expect(await Account.where({ email: "robert@example.com" }).exists()).toBe(true);
  });

  /** Changing only the case is still a change to what gets shown back. */
  it("takes a new spelling of the same address", async () => {
    await Account.create({ email: "Bob@Example.com" });

    const found = (await Account.where({ email: "bob@example.com" }).first()) as Account;
    found.email = "BOB@EXAMPLE.COM";
    await found.save();

    const again = await Account.where({ email: "bob@example.com" }).first();

    expect(again?.email).toBe("BOB@EXAMPLE.COM");
  });

  it("carries a null through both halves", async () => {
    const account = await Account.create({ email: null });

    expect(account.email).toBeNull();
  });
});

describe("what the database holds", () => {
  it("is ciphertext in both columns", async () => {
    await Account.create({ email: "Bob@Example.com" });

    const rows = await connection.query<{ email: string; original_email: string }>(
      `SELECT ${connection.quote("email")}, ${connection.quote("original_email")} FROM ${connection.quote("accounts")}`,
    );

    expect(rows[0]?.email).not.toContain("example.com");
    expect(rows[0]?.original_email).not.toContain("Example.com");
  });

  /**
   * A row written before the option was added has no original to show, so the
   * folded column is the fallback rather than the answer.
   */
  it("falls back to the folded column when there is no original", async () => {
    await Account.create({ email: "Bob@Example.com" });
    await connection.execute(
      `UPDATE ${connection.quote("accounts")} SET ${connection.quote("original_email")} = NULL`,
    );

    const found = await Account.where({ email: "bob@example.com" }).first();

    expect(found?.email).toBe("bob@example.com");
  });
});

describe("the boundary of the hydration exception", () => {
  /**
   * Only an attribute that derives *another* column is skipped on hydration.
   * An ordinary transforming setter still runs, which is what normalizes a row
   * written before the normalizer was declared — and is the behaviour that
   * would be lost if the exception were widened to every setter.
   */
  it("still runs an ordinary setter on a loaded row", async () => {
    class Normalized extends Model<{ id: number; handle: string | null }>("handles") {
      static {
        this.normalizes("handle", (value: string) => value.trim().toLowerCase());
      }
    }

    await new SchemaStatements(connection).createTable("handles", (t) => {
      t.string("handle");
    });

    await connection.execute(
      `INSERT INTO ${connection.quote("handles")} (${connection.quote("handle")}) VALUES ('  MiXeD  ')`,
    );

    const found = await Normalized.first();

    expect(found?.handle).toBe("mixed");
  });
});

describe("folding at all", () => {
  it("is what either option asks for", () => {
    expect(foldsCase({ downcase: true })).toBe(true);
    expect(foldsCase({ ignoreCase: true })).toBe(true);
    expect(foldsCase({})).toBe(false);
    expect(foldsCase({ deterministic: true })).toBe(false);
  });

  /** On a column nobody can look up, folding enables nothing. */
  it("is refused on a column that is not deterministic", () => {
    expect(() => encryptValue("Bob", { ignoreCase: true })).toThrow(PointlessDowncase);
    expect(() => encryptValue("Bob", { ignoreCase: true })).toThrow("ignoreCase");
    expect(() => encryptValue("Bob", { downcase: true })).toThrow("downcase");
  });
});
