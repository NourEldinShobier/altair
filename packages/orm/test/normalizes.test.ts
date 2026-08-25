/**
 * Attribute normalization.
 *
 * Mirrors activerecord/test/cases/normalized_attribute_test.rb. The query
 * tests are the ones that matter: normalizing only on write is the version
 * people write by hand, and it leaves a table of tidy values that a signup
 * form can still create a duplicate in.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface UserRow {
  id: number;
  email: string;
  nickname: string | null;
  postcode: string;
}

class User extends Model<UserRow>("users") {
  static {
    this.normalizes("email", (value: string) => value.trim().toLowerCase());
    this.normalizes("postcode", (value: string) => value.replaceAll(" ", "").toUpperCase());
    this.normalizes("nickname", (value: string | null) => value?.trim() ?? "anonymous", {
      applyToNil: true,
    });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);
  User.columnCache = undefined;
  User.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("users", { ifExists: true });
  await schema.createTable("users", (t) => {
    t.string("email");
    t.string("nickname");
    t.string("postcode");
  });
});

describe("on the way in", () => {
  it("tidies what the constructor was given", async () => {
    const user = await User.create({ email: "  Ada@Example.COM ", postcode: "sw1a 1aa" });

    expect(user.email).toBe("ada@example.com");
    expect(user.postcode).toBe("SW1A1AA");
  });

  it("tidies a plain assignment", async () => {
    const user = await User.create({ email: "a@b.com", postcode: "x" });
    user.email = "  OTHER@B.COM  ";

    expect(user.email).toBe("other@b.com");
  });

  it("tidies what `assign` was given", async () => {
    const user = await User.create({ email: "a@b.com", postcode: "x" });
    user.assign({ email: " THIRD@B.COM " });

    expect(user.email).toBe("third@b.com");
  });

  it("stores the tidied value", async () => {
    await User.create({ email: "  Ada@Example.COM ", postcode: "x" });

    const [row] = await connection.query<{ email: string }>("SELECT email FROM users");
    expect(row?.email).toBe("ada@example.com");
  });

  it("survives a reload", async () => {
    const user = await User.create({ email: " Ada@Example.COM ", postcode: "x" });
    await user.reload();

    expect(user.email).toBe("ada@example.com");
  });

  it("leaves a column with no normalizer alone", async () => {
    const user = await User.create({ email: "a@b.com", postcode: "  keep Me  " });

    expect(user.postcode).toBe("KEEPME");
  });
});

// Calling `.trim()` on nothing is a crash rather than a normalization, and a
// column that is empty is not a value that needs tidying.
describe("null", () => {
  it("is left alone by default", async () => {
    const user = await User.create({ email: "a@b.com", postcode: "x" });

    expect(user.email).toBe("a@b.com");
    expect(() => {
      (user as unknown as { email: unknown }).email = null;
    }).not.toThrow();
  });

  it("is normalized when the declaration asks for it", async () => {
    const user = User.build({ email: "a@b.com", postcode: "x" });
    (user as unknown as { nickname: unknown }).nickname = null;

    expect(user.nickname).toBe("anonymous");
  });
});

// The half people forget. A tidy table that a signup form can still duplicate,
// because the uniqueness check looked for the untidy version and found nothing.
describe("in the lookups", () => {
  beforeEach(async () => {
    await User.create({ email: "ada@example.com", postcode: "SW1A1AA" });
  });

  it("finds a row from an untidy value", async () => {
    expect(await User.where({ email: "  ADA@Example.com " }).count()).toBe(1);
  });

  it("finds it with findBy too", async () => {
    expect((await User.findBy({ email: " Ada@EXAMPLE.com" }))?.id).toBeDefined();
  });

  it("normalizes every member of an IN", async () => {
    const found = await User.where({ email: ["  ADA@EXAMPLE.COM  ", "nobody@example.com"] });

    expect(found).toHaveLength(1);
  });

  it("leaves other columns alone", async () => {
    expect(await User.where({ id: 1 }).count()).toBe(1);
  });

  it("normalizes a value on request, for a caller doing its own query", () => {
    expect(User.normalizeValueFor("email", "  A@B.COM ")).toBe("a@b.com");
    expect(User.normalizeValueFor("id", "  1 ")).toBe("  1 ");
  });
});

// A uniqueness check that looked for the untidy value would find nothing and
// let the duplicate through — which is the bug this exists to prevent.
describe("with a uniqueness validation", () => {
  class Account extends Model<UserRow>("users") {
    static {
      this.normalizes("email", (value: string) => value.trim().toLowerCase());
      this.validates("email", { uniqueness: true });
    }
  }

  beforeEach(() => {
    Account.columnCache = undefined;
    Account.columnTypeCache = undefined;
  });

  it("catches a duplicate written untidily", async () => {
    await Account.create({ email: "ada@example.com", postcode: "x" });

    const duplicate = Account.build({ email: "  ADA@Example.COM ", postcode: "y" });

    expect(await duplicate.validate()).toBe(false);
    expect(duplicate.errors.on("email")).toContain("has already been taken");
  });
});
