/**
 * Which algorithm hashed a password, ported from
 * `activemodel/test/cases/secure_password_test.rb`'s algorithm cases.
 *
 * The feature exists so an application can *change* algorithm, so the cases
 * are about a corpus of digests written by more than one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  type PasswordAlgorithm,
  UnknownPasswordAlgorithm,
  algorithmName,
  algorithmRegistry,
  castTypes,
  lookupAlgorithm,
  needsRehash,
  passwordSalt,
  preferredAlgorithm,
  registerAlgorithm,
  resetAlgorithms,
} from "../src/password-algorithms.js";

function algorithm(overrides: Partial<PasswordAlgorithm> = {}): PasswordAlgorithm {
  return {
    name: "bcrypt",
    prefix: "$2a$",
    preferred: false,
    hash: (password) => `$2a$${password}`,
    verify: (password, digest) => digest === `$2a$${password}`,
    ...overrides,
  };
}

afterEach(() => {
  resetAlgorithms();
});

describe("the registry", () => {
  /**
   * A replaced algorithm makes every digest it wrote unverifiable, and the
   * failure is "wrong password" for people whose password is right — which is
   * indistinguishable from an attack and gets investigated as one.
   */
  it("refuses a second registration under one name", () => {
    registerAlgorithm(algorithm());

    expect(() => registerAlgorithm(algorithm({ prefix: "$other$" }))).toThrow("already registered");
  });

  it("allows registering the same one twice", () => {
    const bcrypt = algorithm();
    registerAlgorithm(bcrypt);

    expect(() => registerAlgorithm(bcrypt)).not.toThrow();
  });

  it("hands back a copy of the registry", () => {
    registerAlgorithm(algorithm());
    const registry = algorithmRegistry();
    registry.clear();

    expect(algorithmRegistry().size).toBe(1);
  });
});

describe("which algorithm wrote a digest", () => {
  /**
   * Configuration says what to write *now*, and a stored digest is whatever
   * was configured when it was written — reading configuration would make
   * every password from before the last change fail to verify.
   */
  it("reads it from the digest's own prefix", () => {
    registerAlgorithm(algorithm());
    registerAlgorithm(algorithm({ name: "argon2", prefix: "$argon2id$", preferred: true }));

    expect(algorithmName("$2a$abc")).toBe("bcrypt");
    expect(algorithmName("$argon2id$abc")).toBe("argon2");
  });

  it("recognises nothing it was not told about", () => {
    expect(algorithmName("$scrypt$abc")).toBeUndefined();
  });

  /**
   * Treating an unrecognised digest as a failed password locks out everybody
   * whose hash an algorithm this deployment forgot to register wrote — which
   * reads as a compromise rather than a configuration mistake.
   */
  it("raises rather than reporting a failed password", () => {
    expect(() => lookupAlgorithm("$scrypt$abc")).toThrow(UnknownPasswordAlgorithm);
    expect(() => lookupAlgorithm("$scrypt$abc")).toThrow("looks like a compromise");
  });

  it("finds the algorithm for a digest it knows", () => {
    registerAlgorithm(algorithm());

    expect(lookupAlgorithm("$2a$abc").name).toBe("bcrypt");
  });
});

describe("which algorithm to write with", () => {
  it("is the one marked preferred", () => {
    registerAlgorithm(algorithm());
    registerAlgorithm(algorithm({ name: "argon2", prefix: "$argon2id$", preferred: true }));

    expect(preferredAlgorithm().name).toBe("argon2");
  });

  /** A default would be whichever registered first, which is load order. */
  it("refuses when none is marked", () => {
    registerAlgorithm(algorithm());

    expect(() => preferredAlgorithm()).toThrow("load order");
  });

  /**
   * The rewrite takes as long as people take to come back, rather than
   * requiring everybody to reset — which is what makes a migration possible at
   * all.
   */
  it("says which digests are worth rewriting", () => {
    registerAlgorithm(algorithm());
    registerAlgorithm(algorithm({ name: "argon2", prefix: "$argon2id$", preferred: true }));

    expect(needsRehash("$2a$abc")).toBe(true);
    expect(needsRehash("$argon2id$abc")).toBe(false);
  });

  /**
   * An unrecognised digest is not "worth rewriting" — it is one nothing can
   * verify, and saying yes here would have a caller rewrite a password it
   * never checked.
   */
  it("says nothing about a digest it does not recognise", () => {
    expect(needsRehash("$scrypt$abc")).toBe(false);
  });
});

describe("the salt", () => {
  /**
   * Padded: a byte below 0x10 written as one character shortens the salt and
   * makes two different byte strings produce the same text — which is the one
   * thing a salt must not do.
   */
  it("is hexadecimal, padded, and the requested length", () => {
    expect(passwordSalt((bytes) => new Uint8Array(bytes).fill(0xab))).toBe("ab".repeat(16));
    expect(passwordSalt((bytes) => new Uint8Array(bytes).fill(0x0a))).toBe("0a".repeat(16));
  });

  /**
   * Two of them collide in a table of ordinary size, and two identical salts
   * are what a precomputed table needs.
   */
  it("refuses one short enough to collide", () => {
    expect(() => passwordSalt(undefined, 8)).toThrow("precomputed table");
  });

  /**
   * Derived from an id or an email, two people with the same password get the
   * same digest — so a leaked table shows which accounts share one.
   */
  it("is different every time", () => {
    expect(passwordSalt()).not.toBe(passwordSalt());
  });
});

describe("what a password attribute accepts", () => {
  it("takes a string", () => {
    expect(castTypes("secret")).toBe("secret");
  });

  it("treats nothing and an empty string as unset", () => {
    expect(castTypes(null)).toBeUndefined();
    expect(castTypes(undefined)).toBeUndefined();
    expect(castTypes("")).toBeUndefined();
  });

  /**
   * Coercing would hash the decimal form of a number, so `1234` and `"1234"`
   * produce one digest for two different values.
   */
  it("refuses anything else", () => {
    expect(() => castTypes(1234)).toThrow("one digest for two different values");
    expect(() => castTypes({})).toThrow();
  });
});
