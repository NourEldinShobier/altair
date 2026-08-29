/**
 * A second name for a column, ported from
 * `activerecord/test/cases/attribute_methods/alias_attribute_test.rb`.
 *
 * For the schema you did not choose and cannot change — a legacy table, a
 * column named by an import, a name a vendor owns. Without it the bad name
 * spreads through every view and controller that touches it, which is how a
 * rename stops being possible.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Model, SchemaStatements, setConnection } from "../src/index.js";
import type { Connection } from "../src/connection.js";
import { isSqlite, testConnection } from "./support/database.js";

let connection: Connection;

interface UserRow {
  id: number;
  email_address_txt: string | null;
  legacy_ctr: number | null;
}

class User extends Model<UserRow>("users") {
  static {
    this.aliasAttribute("email", "email_address_txt");
    this.aliasAttribute("count", "legacy_ctr");
  }

  declare email: string | null;
  declare count: number | null;
}

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);

  await new SchemaStatements(connection).createTable("users", (t) => {
    t.string("email_address_txt");
    t.integer("legacy_ctr");
  });

  User.columnCache = undefined;
  User.columnTypeCache = undefined;
});

afterEach(async () => {
  if (isSqlite) await connection.close();
});

describe("reading and writing through the alias", () => {
  it("writes the column the alias names", async () => {
    await User.create({ email: "a@b.com" } as Partial<UserRow>);

    const [row] = await connection.query<UserRow>("SELECT * FROM users");

    expect(row!.email_address_txt).toBe("a@b.com");
  });

  it("reads it back under either name", async () => {
    await User.create({ email: "a@b.com" } as Partial<UserRow>);

    const user = (await User.all().first())!;

    expect(user.email).toBe("a@b.com");
    expect(user.email_address_txt).toBe("a@b.com");
  });

  it("follows the alias on assignment too", async () => {
    const user = await User.create({ email: "a@b.com" } as Partial<UserRow>);

    user.email = "c@d.com";
    await user.save();

    const [row] = await connection.query<UserRow>("SELECT * FROM users");

    expect(row!.email_address_txt).toBe("c@d.com");
  });

  /**
   * The constructor writes columns directly rather than through the proxy, so
   * an alias resolved only in the proxy works for assignment and not for
   * `new User({ email })` — which is the more common of the two.
   */
  it("follows it from the constructor, not just the setter", () => {
    const user = new User({ email: "a@b.com" } as Partial<UserRow>);

    expect(user.email_address_txt).toBe("a@b.com");
  });

  it("says the record has the attribute", () => {
    const user = new User({ email: "a@b.com" } as Partial<UserRow>);

    expect("email" in user).toBe(true);
  });
});

describe("querying through the alias", () => {
  it("matches on the column the alias names", async () => {
    await User.create({ email: "a@b.com" } as Partial<UserRow>);
    await User.create({ email: "c@d.com" } as Partial<UserRow>);

    const found = await User.where({ email: "a@b.com" } as never);

    expect(found).toHaveLength(1);
    expect(found[0]!.email).toBe("a@b.com");
  });

  it("still takes the real column name", async () => {
    await User.create({ email: "a@b.com" } as Partial<UserRow>);

    expect(await User.where({ email_address_txt: "a@b.com" })).toHaveLength(1);
  });
});

describe("ordering and plucking", () => {
  it("sorts by the column the alias names", async () => {
    await User.create({ email: "b@b.com" } as Partial<UserRow>);
    await User.create({ email: "a@b.com" } as Partial<UserRow>);

    const sorted = await User.all().order("email");

    expect(sorted.map((user) => user.email)).toEqual(["a@b.com", "b@b.com"]);
  });

  it("plucks it", async () => {
    await User.create({ email: "a@b.com" } as Partial<UserRow>);

    expect(await User.all().pluck("email")).toEqual(["a@b.com"]);
  });

  /**
   * Resolved once and reused for both the query and the read-back, or a
   * plucked alias selects the right column and then looks for the wrong key.
   */
  it("plucks several, including an aliased one", async () => {
    await User.create({ email: "a@b.com", count: 3 } as Partial<UserRow>);

    expect(await User.all().pluck("email", "count")).toEqual([["a@b.com", 3]]);
  });

  /**
   * Ordering and `pluck` take a column name straight through to the database.
   * Rewriting strings that might be expressions is how a query builder starts
   * guessing, so these are documented rather than covered.
   */
  /**
   * Only a bare identifier is rewritten. A qualified name already says which
   * table it means, and an expression would need SQL parsed to rewrite
   * safely — `order` refuses those outright, one layer up.
   */
  it("leaves a qualified name alone", () => {
    const { sql } = User.all().select("users.email").toSql();

    // Untouched: a qualified name already says which table it means, so
    // rewriting it is not this layer's job.
    expect(sql).toContain("email");
    expect(sql).not.toContain("email_address_txt");
  });

  it("refuses an expression, as it did before aliases existed", () => {
    expect(() =>
      User.all()
        .order("email DESC" as never)
        .toSql(),
    ).toThrow(/Invalid column name/);
  });
});

describe("declaring one", () => {
  it("refuses an alias for itself", () => {
    class Broken extends Model<UserRow>("users") {}

    expect(() => Broken.aliasAttribute("email", "email")).toThrow(/itself/);
  });

  it("leaves the parent alone when a subclass declares one", () => {
    class Parent extends Model<UserRow>("users") {}
    class Child extends Parent {}

    Parent.aliasAttribute("email", "email_address_txt");
    Child.aliasAttribute("tally", "legacy_ctr");

    expect(Parent.attributeAliases.tally).toBeUndefined();
    expect((Child as typeof Parent).attributeAliases.email).toBe("email_address_txt");
  });
});
