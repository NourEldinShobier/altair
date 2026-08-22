/**
 * Validation suite.
 *
 * Mirrors activemodel/test/cases/validations/ — presence, length, format,
 * inclusion, numericality, confirmation, acceptance and uniqueness. Messages
 * are asserted verbatim, because applications display them.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";
import { MESSAGES, isBlank } from "../src/validations.js";

interface UserAttributes {
  id: number;
  name: string;
  email: string;
  age: number;
  role: string;
  terms: number;
  account_id: number;
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  const schema = new SchemaStatements(connection);
  await schema.createTable("users", (t) => {
    t.string("name");
    t.string("email");
    t.integer("age");
    t.string("role");
    t.integer("terms");
    t.integer("account_id");
  });
});

/**
 * A fresh model class per test, so declarations never leak between cases.
 *
 * The callback parameter is deliberately not named `declare`: as a statement,
 * `declare(User)` parses as a TypeScript ambient declaration and the call is
 * erased at transpile time, silently skipping every validation.
 */
function userClass(configure: (klass: ReturnType<typeof makeUserClass>) => void) {
  const User = makeUserClass();
  configure(User);
  return User;
}

function makeUserClass() {
  return class extends Model<UserAttributes>("users") {};
}

describe("isBlank", () => {
  it("matches Rails' blank?", () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank("")).toBe(true);
    expect(isBlank("   ")).toBe(true);
    expect(isBlank([])).toBe(true);
    expect(isBlank("x")).toBe(false);
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
  });
});

describe("presence", () => {
  it("rejects a blank value", async () => {
    const User = userClass((k) => k.validates("name", { presence: true }));
    const user = User.build({ name: "" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("name")).toEqual([MESSAGES.blank]);
  });

  it("rejects whitespace", async () => {
    const User = userClass((k) => k.validates("name", { presence: true }));
    expect(await User.build({ name: "   " }).validate()).toBe(false);
  });

  it("accepts a value", async () => {
    const User = userClass((k) => k.validates("name", { presence: true }));
    expect(await User.build({ name: "Ada" }).validate()).toBe(true);
  });

  it("stops save", async () => {
    const User = userClass((k) => k.validates("name", { presence: true }));

    expect(await User.build({ name: "" }).save()).toBe(false);
    expect(await User.count()).toBe(0);
  });
});

describe("absence", () => {
  it("rejects a present value", async () => {
    const User = userClass((k) => k.validates("name", { absence: true }));
    const user = User.build({ name: "Ada" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("name")).toEqual([MESSAGES.present]);
  });

  it("accepts a blank value", async () => {
    const User = userClass((k) => k.validates("name", { absence: true }));
    expect(await User.build({}).validate()).toBe(true);
  });
});

describe("length", () => {
  it("enforces a minimum", async () => {
    const User = userClass((k) => k.validates("name", { length: { minimum: 3 } }));
    const user = User.build({ name: "ab" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("name")).toEqual([MESSAGES.tooShort(3)]);
  });

  it("enforces a maximum", async () => {
    const User = userClass((k) => k.validates("name", { length: { maximum: 5 } }));
    const user = User.build({ name: "abcdef" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("name")).toEqual([MESSAGES.tooLong(5)]);
  });

  it("enforces an exact length", async () => {
    const User = userClass((k) => k.validates("name", { length: { is: 4 } }));

    expect(await User.build({ name: "abc" }).validate()).toBe(false);
    expect(await User.build({ name: "abcd" }).validate()).toBe(true);
  });

  it("reports every bound that fails", async () => {
    const User = userClass((k) => k.validates("name", { length: { minimum: 5, is: 9 } }));
    const user = User.build({ name: "abc" });

    await user.validate();
    expect(user.errors.on("name")).toHaveLength(2);
  });
});

describe("format", () => {
  it("rejects a non-matching value", async () => {
    const User = userClass((k) => k.validates("email", { format: { with: /@/ } }));
    const user = User.build({ email: "nope" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("email")).toEqual([MESSAGES.invalid]);
  });

  it("accepts a matching value", async () => {
    const User = userClass((k) => k.validates("email", { format: { with: /@/ } }));
    expect(await User.build({ email: "a@b.c" }).validate()).toBe(true);
  });

  it("supports without:", async () => {
    const User = userClass((k) => k.validates("name", { format: { without: /\d/ } }));

    expect(await User.build({ name: "abc1" }).validate()).toBe(false);
    expect(await User.build({ name: "abc" }).validate()).toBe(true);
  });
});

describe("inclusion and exclusion", () => {
  it("requires membership", async () => {
    const User = userClass((k) => k.validates("role", { inclusion: { in: ["admin", "user"] } }));
    const user = User.build({ role: "root" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("role")).toEqual([MESSAGES.inclusion]);
    expect(await User.build({ role: "admin" }).validate()).toBe(true);
  });

  it("forbids membership", async () => {
    const User = userClass((k) => k.validates("name", { exclusion: { in: ["admin"] } }));
    const user = User.build({ name: "admin" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("name")).toEqual([MESSAGES.exclusion]);
  });
});

describe("numericality", () => {
  it("rejects a non-number", async () => {
    const User = userClass((k) => k.validates("age", { numericality: true }));
    const user = User.build({ age: "abc" as never });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("age")).toEqual([MESSAGES.notANumber]);
  });

  it("requires an integer", async () => {
    const User = userClass((k) => k.validates("age", { numericality: { onlyInteger: true } }));

    expect(await User.build({ age: 1.5 }).validate()).toBe(false);
    expect(await User.build({ age: 2 }).validate()).toBe(true);
  });

  it("enforces bounds", async () => {
    const User = userClass((k) =>
      k.validates("age", { numericality: { greaterThan: 0, lessThanOrEqualTo: 120 } }),
    );

    expect(await User.build({ age: 0 }).validate()).toBe(false);
    expect(await User.build({ age: 121 }).validate()).toBe(false);
    expect(await User.build({ age: 30 }).validate()).toBe(true);
  });

  it("names the bound in the message", async () => {
    const User = userClass((k) => k.validates("age", { numericality: { greaterThan: 18 } }));
    const user = User.build({ age: 10 });

    await user.validate();
    expect(user.errors.on("age")).toEqual([MESSAGES.greaterThan(18)]);
  });
});

describe("confirmation and acceptance", () => {
  it("compares against the confirmation attribute", async () => {
    const User = userClass((k) => k.validates("email", { confirmation: true }));

    const mismatched = User.build({ email: "a@b.c" });
    (mismatched as unknown as Record<string, unknown>).email_confirmation = "x@y.z";
    expect(await mismatched.validate()).toBe(false);
    expect(mismatched.errors.on("email")).toEqual([MESSAGES.confirmation]);

    const matched = User.build({ email: "a@b.c" });
    (matched as unknown as Record<string, unknown>).email_confirmation = "a@b.c";
    expect(await matched.validate()).toBe(true);
  });

  // Rails: no confirmation attribute means there is nothing to check.
  it("skips confirmation when the field is absent", async () => {
    const User = userClass((k) => k.validates("email", { confirmation: true }));
    expect(await User.build({ email: "a@b.c" }).validate()).toBe(true);
  });

  it("requires acceptance", async () => {
    const User = userClass((k) => k.validates("terms", { acceptance: true }));

    expect(await User.build({ terms: 0 }).validate()).toBe(false);
    expect(await User.build({ terms: 1 }).validate()).toBe(true);
  });
});

describe("allowNil and allowBlank", () => {
  it("skips later rules for nil", async () => {
    const User = userClass((k) => k.validates("name", { length: { minimum: 5 }, allowNil: true }));

    expect(await User.build({}).validate()).toBe(true);
    expect(await User.build({ name: "ab" }).validate()).toBe(false);
  });

  it("skips later rules for blank", async () => {
    const User = userClass((k) =>
      k.validates("name", { length: { minimum: 5 }, allowBlank: true }),
    );

    expect(await User.build({ name: "" }).validate()).toBe(true);
  });

  // Rails runs presence before the allow_* short-circuit.
  it("still enforces presence", async () => {
    const User = userClass((k) =>
      k.validates("name", { presence: true, length: { minimum: 5 }, allowBlank: true }),
    );
    const user = User.build({ name: "" });

    expect(await user.validate()).toBe(false);
    expect(user.errors.on("name")).toEqual([MESSAGES.blank]);
  });
});

describe("uniqueness", () => {
  it("rejects a duplicate", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: true }));
    await User.create({ email: "a@b.c" });

    const duplicate = User.build({ email: "a@b.c" });
    expect(await duplicate.validate()).toBe(false);
    expect(duplicate.errors.on("email")).toEqual([MESSAGES.taken]);
  });

  it("accepts a distinct value", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: true }));
    await User.create({ email: "a@b.c" });

    expect(await User.build({ email: "d@e.f" }).validate()).toBe(true);
  });

  // Rails excludes the record being validated, or every update would fail.
  it("does not collide with itself on update", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: true }));
    const user = await User.create({ email: "a@b.c" });

    user.name = "Renamed";
    expect(await user.save()).toBe(true);
  });

  it("honours a scope", async () => {
    const User = userClass((k) => k.validates("email", { uniqueness: { scope: "account_id" } }));
    await User.create({ email: "a@b.c", account_id: 1 });

    expect(await User.build({ email: "a@b.c", account_id: 2 }).validate()).toBe(true);
    expect(await User.build({ email: "a@b.c", account_id: 1 }).validate()).toBe(false);
  });
});

describe("messages and combination", () => {
  it("overrides the message", async () => {
    const User = userClass((k) =>
      k.validates("name", { presence: true, message: "is required, please" }),
    );
    const user = User.build({ name: "" });

    await user.validate();
    expect(user.errors.on("name")).toEqual(["is required, please"]);
  });

  it("collects errors from several attributes", async () => {
    const User = userClass((k) => {
      k.validates("name", { presence: true });
      k.validates("email", { presence: true });
    });
    const user = User.build({});

    await user.validate();
    expect(user.errors.attributes.sort()).toEqual(["email", "name"]);
    expect(user.errors.fullMessages().sort()).toEqual([
      "email can't be blank",
      "name can't be blank",
    ]);
  });

  it("clears errors between runs", async () => {
    const User = userClass((k) => k.validates("name", { presence: true }));
    const user = User.build({ name: "" });

    await user.validate();
    user.name = "Ada";
    await user.validate();

    expect(user.errors.isEmpty).toBe(true);
  });

  it("does not leak a subclass's validations to the parent", () => {
    const User = userClass((k) => k.validates("name", { presence: true }));
    class Admin extends User {}
    Admin.validates("role", { presence: true });

    expect(Admin.validations).toHaveLength(2);
    expect(User.validations).toHaveLength(1);
  });
});
