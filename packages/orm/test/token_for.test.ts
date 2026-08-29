/**
 * Signed tokens tied to a record's state.
 *
 * Mirrors activerecord/test/cases/tokens_test.rb.
 *
 * There is no column and no row — the token carries the id and is signed. Most
 * of what follows is about the ways it must fail, because a password reset
 * link is the one piece of a system that is handed to whoever reads an inbox.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { travelTo } from "@altair/support";
import {
  Connection,
  Model,
  SchemaStatements,
  configureTokens,
  resetTokens,
  setConnection,
} from "../src/index.js";
import { testConnection } from "./support/database.js";

interface UserRow {
  id: number;
  email: string;
  password_digest: string;
}

class User extends Model<UserRow>("users") {
  static {
    this.generatesTokenFor("passwordReset", { expiresIn: 900 }, (user: never) =>
      String((user as { password_digest?: string }).password_digest ?? "").slice(-10),
    );
    this.generatesTokenFor("emailConfirm", {});
  }
}

let connection: Connection;
let ada: User;

beforeEach(async () => {
  connection = await testConnection();
  setConnection(connection);
  configureTokens("s".repeat(64));

  User.columnCache = undefined;
  User.columnTypeCache = undefined;

  const schema = new SchemaStatements(connection);
  await schema.dropTable("users", { ifExists: true });
  await schema.createTable("users", (t) => {
    t.string("email");
    t.string("password_digest");
  });

  ada = await User.create({ email: "ada@example.com", password_digest: "digest-one" });
});

describe("a token that is what it says", () => {
  it("finds the record that made it", async () => {
    const found = await User.findByTokenFor("passwordReset", ada.generateTokenFor("passwordReset"));

    expect((found as User).email).toBe("ada@example.com");
  });

  it("names its own record and not another", async () => {
    const grace = await User.create({ email: "grace@example.com", password_digest: "other" });
    const found = await User.findByTokenFor("emailConfirm", grace.generateTokenFor("emailConfirm"));

    expect((found as User).email).toBe("grace@example.com");
  });

  it("needs no column to store anything in", async () => {
    const token = ada.generateTokenFor("emailConfirm");

    expect(Object.keys(ada.attributes())).not.toContain("token");
    expect(await User.findByTokenFor("emailConfirm", token)).not.toBeNull();
  });
});

/**
 * The reason the fingerprint exists. Without it a reset link keeps working
 * after the reset, and whoever read the email once still has a way in.
 */
describe("a token whose record has moved on", () => {
  it("stops working when what it was tied to changes", async () => {
    const token = ada.generateTokenFor("passwordReset");

    ada.password_digest = "digest-two";
    await ada.save();

    expect(await User.findByTokenFor("passwordReset", token)).toBeNull();
  });

  it("keeps working when something else changes", async () => {
    const token = ada.generateTokenFor("passwordReset");

    ada.email = "ada@newdomain.example";
    await ada.save();

    expect(await User.findByTokenFor("passwordReset", token)).not.toBeNull();
  });

  // A token with no fingerprint is tied to nothing, and says so.
  it("keeps working when the purpose declares no fingerprint", async () => {
    const token = ada.generateTokenFor("emailConfirm");

    ada.password_digest = "digest-two";
    await ada.save();

    expect(await User.findByTokenFor("emailConfirm", token)).not.toBeNull();
  });

  it("stops working when the record is gone", async () => {
    const token = ada.generateTokenFor("emailConfirm");
    await ada.destroy();

    expect(await User.findByTokenFor("emailConfirm", token)).toBeNull();
  });
});

describe("a token that is not what it says", () => {
  it("is refused when the signature was edited", async () => {
    const token = ada.generateTokenFor("passwordReset");

    expect(await User.findByTokenFor("passwordReset", `${token.slice(0, -3)}aaa`)).toBeNull();
  });

  it("is refused when the payload was edited", async () => {
    const token = ada.generateTokenFor("passwordReset");
    const [payload, signature] = token.split("--");

    expect(
      await User.findByTokenFor("passwordReset", `${payload}x--${signature ?? ""}`),
    ).toBeNull();
  });

  // A reset link is not also a confirmation link.
  it("is refused for a purpose it was not signed for", async () => {
    const token = ada.generateTokenFor("passwordReset");

    expect(await User.findByTokenFor("emailConfirm", token)).toBeNull();
  });

  it("is refused when it is not a token at all", async () => {
    for (const nonsense of ["", "nope", "a--b", "....."]) {
      expect(await User.findByTokenFor("passwordReset", nonsense)).toBeNull();
    }
  });

  // Signed under a different key, which is what a rotated secret looks like.
  it("is refused when the secret has changed", async () => {
    const token = ada.generateTokenFor("passwordReset");
    configureTokens("t".repeat(64));

    expect(await User.findByTokenFor("passwordReset", token)).toBeNull();
  });
});

describe("expiry", () => {
  it("works up to the moment it runs out", async () => {
    const token = ada.generateTokenFor("passwordReset");

    await travelTo(new Date(Date.now() + 899_000), async () => {
      expect(await User.findByTokenFor("passwordReset", token)).not.toBeNull();
    });
  });

  it("stops afterwards", async () => {
    const token = ada.generateTokenFor("passwordReset");

    await travelTo(new Date(Date.now() + 901_000), async () => {
      expect(await User.findByTokenFor("passwordReset", token)).toBeNull();
    });
  });

  it("does not expire when no expiry was asked for", async () => {
    const token = ada.generateTokenFor("emailConfirm");

    await travelTo(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), async () => {
      expect(await User.findByTokenFor("emailConfirm", token)).not.toBeNull();
    });
  });
});

describe("what it refuses to do", () => {
  it("will not sign for a purpose nobody declared", () => {
    expect(() => ada.generateTokenFor("nonsense")).toThrow(/no token defined/);
  });

  it("will not look up a purpose nobody declared", () => {
    expect(User.findByTokenFor("nonsense", "x")).rejects.toThrow(/no token defined/);
  });

  // Every unsaved record would share the one token, and none of them could be
  // found again.
  it("will not sign for a record that has never been saved", () => {
    expect(() => new User({ email: "x@y.z" }).generateTokenFor("emailConfirm")).toThrow(/unsaved/);
  });

  it("says so when no signing key was derived", async () => {
    resetTokens();

    expect(() => ada.generateTokenFor("emailConfirm")).toThrow(/signing key/);

    configureTokens("s".repeat(64));
  });
});
