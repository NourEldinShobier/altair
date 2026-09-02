/**
 * Whether two values differing only in case collide, ported from the
 * `case_sensitive:` cases in
 * `activerecord/test/cases/validations/uniqueness_validation_test.rb`.
 *
 * The failure this prevents is not cosmetic: a sign-up form that accepts
 * `Bob@example.com` alongside `bob@example.com` has handed two accounts to one
 * person, and a password reset then goes to whichever row was found first.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { testConnection } from "./support/database.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import { MESSAGES } from "../src/validations.js";
import { uniquenessComparison } from "../src/predicate_builder.js";

interface UserAttributes {
  id: number;
  email: string;
  account_id: number;
  tenant: string;
}

let connection: Connection;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("users", (t) => {
    t.string("email");
    t.integer("account_id");
    t.string("tenant");
  });
});

function userClass(configure: (klass: ReturnType<typeof makeUserClass>) => void) {
  const User = makeUserClass();
  configure(User);
  return User;
}

function makeUserClass() {
  return class extends Model<UserAttributes>("users") {};
}

describe("a case-insensitive uniqueness check", () => {
  it("rejects a value that differs only in case", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: { caseSensitive: false } }));
    await User.create({ email: "bob@example.com" });

    const duplicate = User.build({ email: "Bob@Example.com" });

    expect(await duplicate.validate()).toBe(false);
    expect(duplicate.errors.on("email")).toEqual([MESSAGES.taken]);
  });

  it("still accepts a genuinely different value", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: { caseSensitive: false } }));
    await User.create({ email: "bob@example.com" });

    expect(await User.build({ email: "alice@example.com" }).validate()).toBe(true);
  });

  it("does not collide with itself on update", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: { caseSensitive: false } }));
    const user = await User.create({ email: "bob@example.com" });

    expect(await user.save()).toBe(true);
  });

  /**
   * The scope narrows the search; folding its case would widen it. It matters
   * for a scope like a tenant slug that is deliberately case-sensitive.
   */
  it("leaves the scope columns case-sensitive", async () => {
    const User = userClass((k) =>
      k.validates("email", { uniqueness: { scope: "tenant", caseSensitive: false } }),
    );
    await User.create({ email: "bob@example.com", tenant: "acme" });

    expect(await User.build({ email: "BOB@example.com", tenant: "acme" }).validate()).toBe(false);
    // The same tenant spelled differently is a different tenant.
    expect(await User.build({ email: "BOB@example.com", tenant: "ACME" }).validate()).toBe(true);
  });

  it("still narrows by a numeric scope", async () => {
    const User = userClass((k) =>
      k.validates("email", { uniqueness: { scope: "account_id", caseSensitive: false } }),
    );
    await User.create({ email: "bob@example.com", account_id: 1 });

    expect(await User.build({ email: "BOB@example.com", account_id: 1 }).validate()).toBe(false);
    expect(await User.build({ email: "BOB@example.com", account_id: 2 }).validate()).toBe(true);
  });
});

describe("the default", () => {
  /** Rails' default is `true`, and changing it would break every existing model. */
  it("is case-sensitive", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: true }));
    await User.create({ email: "bob@example.com" });

    expect(await User.build({ email: "Bob@Example.com" }).validate()).toBe(true);
  });

  it("is case-sensitive when asked for explicitly", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: { caseSensitive: true } }));
    await User.create({ email: "bob@example.com" });

    expect(await User.build({ email: "Bob@Example.com" }).validate()).toBe(true);
    expect(await User.build({ email: "bob@example.com" }).validate()).toBe(false);
  });
});

describe("the comparison it builds", () => {
  const quote = (name: string) => `"${name}"`;

  it("lowers both sides for a string", () => {
    expect(uniquenessComparison("email", "bob@example.com", quote)).toBe(
      'LOWER("email") = LOWER(?)',
    );
  });

  /**
   * `LOWER` on a numeric column is a hard error on PostgreSQL, so folding one
   * would turn every validation of that record into a failed query rather
   * than a failed rule.
   */
  it("leaves a value with no case alone", () => {
    expect(uniquenessComparison("account_id", 1, quote)).toBe('"account_id" = ?');
    expect(uniquenessComparison("account_id", null, quote)).toBe('"account_id" = ?');
    expect(uniquenessComparison("created_at", new Date(0), quote)).toBe('"created_at" = ?');
  });

  it("quotes the column the way it was told to", () => {
    expect(uniquenessComparison("email", "x", (name) => `\`${name}\``)).toBe(
      "LOWER(`email`) = LOWER(?)",
    );
  });
});
