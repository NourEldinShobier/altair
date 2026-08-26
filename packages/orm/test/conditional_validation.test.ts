/**
 * Validations that only sometimes apply.
 *
 * Mirrors activemodel/test/cases/validations/conditional_validation_test.rb
 * and the `on:` cases in validations_test.rb.
 *
 * Without these there is no way to say "a password is required when the
 * account is created and not when it is edited", which every application with
 * a password needs on its first day.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface UserRow {
  id: number;
  email: string;
  password: string;
  paid_by: string;
  card: string;
}

class User extends Model<UserRow>("users") {
  static {
    this.validates("password", { presence: true, on: "create" });
    this.validates("nickname", { presence: true, on: "publish" });

    this.validates("card", {
      presence: true,
      if: (user: never) => (user as { paid_by?: string }).paid_by === "card",
    });

    this.validates("email", {
      presence: true,
      unless: (user: never) => (user as { paid_by?: string }).paid_by === "anonymous",
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
    t.string("password");
    t.string("paid_by");
    t.string("card");
    t.string("nickname");
  });
});

/**
 * The one every application needs: required when the account is created and
 * not when it is edited.
 */
describe("on", () => {
  it("applies to a record that has never been saved", async () => {
    const user = new User({ email: "a@b.c", paid_by: "cash" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("password")).toHaveLength(1);
  });

  it("does not apply once the record is saved", async () => {
    const user = new User({ email: "a@b.c", password: "secret", paid_by: "cash" });
    await user.save();

    user.password = "";

    expect(await user.validate()).toBe(true);
  });

  it("lets a save go through that a create would have refused", async () => {
    const user = new User({ email: "a@b.c", password: "secret", paid_by: "cash" });
    await user.save();

    user.password = "";

    expect(await user.save()).toBe(true);
  });

  it("takes the context it is given over the one it would derive", async () => {
    const user = new User({ email: "a@b.c", paid_by: "cash" });

    expect(await user.validate("update")).toBe(true);
  });

  // A context that is neither create nor update, which is Rails' `valid?(:x)`.
  it("supports a context of the caller's own", async () => {
    const user = new User({ email: "a@b.c", password: "x", paid_by: "cash" });

    expect(await user.validate("publish")).toBe(false);
    expect(user.errors.on("nickname")).toHaveLength(1);
  });

  it("leaves that context's rules out of the ordinary ones", async () => {
    const user = new User({ email: "a@b.c", password: "x", paid_by: "cash" });

    expect(await user.validate()).toBe(true);
  });
});

describe("if", () => {
  it("validates when the condition holds", async () => {
    const user = new User({ email: "a@b.c", password: "x", paid_by: "card" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("card")).toHaveLength(1);
  });

  it("does not when it does not", async () => {
    const user = new User({ email: "a@b.c", password: "x", paid_by: "cash" });

    expect(await user.validate()).toBe(true);
  });

  it("reads the record, so one attribute can depend on another", async () => {
    const user = new User({ email: "a@b.c", password: "x", paid_by: "card", card: "4111" });

    expect(await user.validate()).toBe(true);
  });
});

describe("unless", () => {
  it("skips the rule when the condition holds", async () => {
    const user = new User({ password: "x", paid_by: "anonymous" });

    expect(await user.validate()).toBe(true);
  });

  it("applies it when it does not", async () => {
    const user = new User({ password: "x", paid_by: "cash" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("email")).toHaveLength(1);
  });
});

/**
 * The condition is read before the rules rather than inside each one. A rule
 * that ran and then discarded its own result would still have done the work,
 * and a uniqueness check is a query.
 */
describe("when the condition is read", () => {
  it("does not run the rule it skipped", async () => {
    let asked = 0;

    class Counted extends Model<UserRow>("users") {
      static {
        this.validates("email", {
          uniqueness: true,
          if: () => {
            asked += 1;
            return false;
          },
        });
      }
    }

    const record = new Counted({ email: "a@b.c" });
    await record.validate();

    expect(asked).toBe(1);
    expect(record.errors.on("email")).toHaveLength(0);
  });

  it("takes a condition that answers asynchronously", async () => {
    class Async extends Model<UserRow>("users") {
      static {
        this.validates("email", {
          presence: true,
          if: async () => await Promise.resolve(true),
        });
      }
    }

    const record = new Async({});

    expect(await record.validate()).toBe(false);
  });
});
