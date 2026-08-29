/**
 * Logging in without telling an attacker which addresses have accounts,
 * ported from `activemodel/test/cases/secure_password_test.rb` and Rails 7.1's
 * `authenticate_by`.
 *
 * Finding nothing is fast. Finding a record and verifying an argon2 hash is
 * deliberately slow. So `findBy(...)` then `authenticate(...)` answers a wrong
 * email in a millisecond and a wrong password in a hundred — and anyone who can
 * time the login form can read off which addresses have accounts. One request
 * each, no lockout, nothing in the logs to see.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hasSecurePassword, Model, SchemaStatements, setConnection } from "../src/index.js";
import { isSqlite, testConnection } from "./support/database.js";
import type { Connection } from "../src/connection.js";

let connection: Connection;

interface UserRow {
  id: number;
  email: string;
  password_digest: string;
  active: boolean | null;
}

class User extends Model<UserRow>("users") {
  declare password: string | undefined;
  declare authenticate: (password: string) => Promise<User | null>;
}

hasSecurePassword(User, { algorithm: "bcrypt" });

const authenticateBy = (attributes: Record<string, unknown>) =>
  (
    User as unknown as { authenticateBy(a: Record<string, unknown>): Promise<User | null> }
  ).authenticateBy(attributes);

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("users", (t) => {
    t.string("email");
    t.string("password_digest");
    t.boolean("active");
  });

  User.columnCache = undefined;
  User.columnTypeCache = undefined;

  const user = new User({ email: "martin@example.com", active: true });
  user.password = "correct horse battery staple";
  await user.save();
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("logging in", () => {
  it("returns the record when everything matches", async () => {
    const user = await authenticateBy({
      email: "martin@example.com",
      password: "correct horse battery staple",
    });

    expect(user?.email).toBe("martin@example.com");
  });

  it("returns null for the wrong password", async () => {
    expect(await authenticateBy({ email: "martin@example.com", password: "hunter2" })).toBeNull();
  });

  it("returns null for an address nobody has", async () => {
    expect(
      await authenticateBy({
        email: "nobody@example.com",
        password: "correct horse battery staple",
      }),
    ).toBeNull();
  });

  it("takes more than one attribute to look up by", async () => {
    const user = await authenticateBy({
      email: "martin@example.com",
      active: true,
      password: "correct horse battery staple",
    });

    expect(user).not.toBeNull();
  });

  it("returns null when the other attributes do not match", async () => {
    expect(
      await authenticateBy({
        email: "martin@example.com",
        active: false,
        password: "correct horse battery staple",
      }),
    ).toBeNull();
  });
});

/**
 * The whole reason this exists rather than `findBy` then `authenticate`.
 *
 * Measured as a ratio rather than against a fixed millisecond count: an
 * absolute threshold on a shared CI runner is a test that fails on a Tuesday.
 * What matters is that the two paths are within the same order of magnitude,
 * not that either is fast.
 */
describe("how long the two answers take", () => {
  const timed = async (body: () => Promise<unknown>) => {
    const started = Bun.nanoseconds();
    await body();

    return Bun.nanoseconds() - started;
  };

  it("takes about as long to reject an unknown address as a wrong password", async () => {
    // Warmed first: the first hash of the process pays for setup that has
    // nothing to do with either path.
    await authenticateBy({ email: "martin@example.com", password: "x" });

    const wrongPassword = await timed(() =>
      authenticateBy({ email: "martin@example.com", password: "hunter2" }),
    );

    const unknownAddress = await timed(() =>
      authenticateBy({ email: "nobody@example.com", password: "hunter2" }),
    );

    const ratio = Math.max(wrongPassword, unknownAddress) / Math.min(wrongPassword, unknownAddress);

    expect(ratio).toBeLessThan(10);
  });

  /**
   * The contrast, and the bug this closes: the obvious version leaks, and
   * measurably so. Kept as a test rather than a comment because a future
   * change that made `authenticateBy` skip the dummy hash would look
   * reasonable in review.
   */
  it("is not what the obvious version does", async () => {
    await authenticateBy({ email: "martin@example.com", password: "x" });

    const found = await timed(async () => {
      const user = await User.findBy({ email: "martin@example.com" });
      await user?.authenticate("hunter2");
    });

    const missing = await timed(async () => {
      const user = await User.findBy({ email: "nobody@example.com" });
      await user?.authenticate("hunter2");
    });

    // The naive path skips the hash entirely when there is no record, so it is
    // dramatically faster — which is the signal being leaked.
    expect(found / Math.max(missing, 1)).toBeGreaterThan(10);
  });
});

describe("what it refuses to do", () => {
  it("refuses without a password", async () => {
    await expect(authenticateBy({ email: "martin@example.com" })).rejects.toThrow(/password/);
  });

  it("refuses with an empty password", async () => {
    await expect(authenticateBy({ email: "martin@example.com", password: "" })).rejects.toThrow(
      /password/,
    );
  });

  it("refuses with nothing to look up by", async () => {
    await expect(authenticateBy({ password: "x" })).rejects.toThrow(/besides/);
  });
});
