/**
 * What travels alongside a ciphertext, and what happens when the scheme
 * changes. Ported from
 * `activerecord/test/cases/encryption/properties_test.rb`,
 * `message_serializer_test.rb` and the previous-scheme cases in
 * `encryptable_record_test.rb`.
 *
 * Every failure here reads as corruption. That is the point of the cases: a
 * rotation gets a scheme added to a list, and corruption gets restored from a
 * backup, and telling them apart afterwards is nearly impossible.
 */

import { describe, expect, it } from "bun:test";
import {
  EncryptedContentIntegrity,
  EncryptionProperties,
  type EncryptionScheme,
  ForbiddenPropertyClass,
  PROPERTY_KEYS,
  cipherKeyLength,
  ivLength,
  previousSchemes,
  schemeCompatibleWith,
  schemesToTry,
  validateValueType,
} from "../src/encryption-properties.js";

describe("what a header may hold", () => {
  it("takes what survives a round trip", () => {
    for (const value of ["a", 1, true, false, null]) {
      expect(() => validateValueType(value)).not.toThrow();
    }
  });

  /**
   * Anything else serialises to something that does not come back as what it
   * was — and it comes back, so nothing reports it.
   */
  it("refuses anything else", () => {
    expect(() => validateValueType({ a: 1 })).toThrow(ForbiddenPropertyClass);
    expect(() => validateValueType([1])).toThrow(ForbiddenPropertyClass);
    expect(() => validateValueType(() => 1)).toThrow(ForbiddenPropertyClass);
    expect(() => validateValueType(undefined)).toThrow(ForbiddenPropertyClass);
  });

  /**
   * Checked where it is written, not where it is serialised: caught at
   * serialisation it is a failure inside the encryptor, on a value nobody
   * there can name.
   */
  it("is checked as it is set", () => {
    expect(() => new EncryptionProperties().set("k", { a: 1 })).toThrow(ForbiddenPropertyClass);
  });
});

describe("the headers on a message", () => {
  it("holds what it was given", () => {
    const headers = new EncryptionProperties({ k: "key", c: true });

    expect(headers.get("k")).toBe("key");
    expect(headers.has("c")).toBe(true);
    expect(headers.has("iv")).toBe(false);
  });

  /**
   * Two things that both believe they decide the key id produce a message that
   * decrypts under whichever wrote last, and the one that fails does so months
   * later, when the other key is retired.
   */
  it("refuses to overwrite one that is set", () => {
    const headers = new EncryptionProperties({ k: "first" });

    expect(() => headers.set("k", "second")).toThrow(EncryptedContentIntegrity);
    expect(headers.get("k")).toBe("first");
  });

  it("names the header it refused", () => {
    const headers = new EncryptionProperties({ i: "one" });

    expect(() => headers.set("i", "two")).toThrow('"i"');
  });

  /**
   * Short keys because they are written into every encrypted value in the
   * table: the difference is a byte count multiplied by the row count.
   */
  it("stores under a short key and reads by a readable name", () => {
    const headers = new EncryptionProperties();
    headers.write("encryptedDataKey", "key");

    expect(headers.read("encryptedDataKey")).toBe("key");
    expect(headers.get("k")).toBe("key");
    expect(PROPERTY_KEYS.encryptedDataKey).toBe("k");
  });

  it("reads nothing for a header that was not set", () => {
    expect(new EncryptionProperties().read("iv")).toBeUndefined();
  });

  it("adds several at once", () => {
    const headers = new EncryptionProperties();
    headers.add({ k: "key", at: "tag" });

    expect(headers.toJSON()).toEqual({ k: "key", at: "tag" });
  });

  it("serialises to the short keys", () => {
    const headers = new EncryptionProperties();
    headers.write("compressed", true);
    headers.write("iv", "abc");

    expect(headers.toJSON()).toEqual({ c: true, iv: "abc" });
  });
});

describe("the cipher's sizes", () => {
  it("is a 256-bit key", () => {
    expect(cipherKeyLength()).toBe(32);
  });

  /**
   * GCM's own size, not the block size. A sixteen-byte IV is accepted by most
   * libraries and is a different construction: written with one and read with
   * the other, the value authenticates and decrypts to the wrong plaintext.
   */
  it("is a twelve-byte iv", () => {
    expect(ivLength()).toBe(12);
  });
});

describe("whether two schemes are alternatives", () => {
  /**
   * A deterministic read of a non-deterministic value is not a decryption
   * failure — it is a query that matches nothing, because the ciphertext being
   * searched for was never the ciphertext stored.
   */
  it("turns on the deterministic flag alone", () => {
    expect(schemeCompatibleWith({ deterministic: true }, { deterministic: true })).toBe(true);
    expect(schemeCompatibleWith({ deterministic: true }, { deterministic: false })).toBe(false);
    expect(schemeCompatibleWith({}, { deterministic: false })).toBe(true);
  });

  it("does not care about the other options", () => {
    expect(schemeCompatibleWith({ downcase: true }, { downcase: false, keyId: "old" })).toBe(true);
  });
});

describe("the schemes a column will still read", () => {
  const current: EncryptionScheme = { deterministic: false, keyId: "2024" };

  it("is the global list then the declared one", () => {
    const schemes = previousSchemes(current, [{ keyId: "2022" }], [{ keyId: "2023" }]);

    expect(schemes.map((scheme) => scheme.keyId)).toEqual(["2022", "2023"]);
  });

  /** Each keeps whatever the current scheme said and it did not. */
  it("fills each one in from the current scheme", () => {
    const schemes = previousSchemes({ deterministic: false, downcase: true }, [{ keyId: "2022" }]);

    expect(schemes[0]).toEqual({ deterministic: false, downcase: true, keyId: "2022" });
  });

  /**
   * Dropped rather than kept and skipped later: kept, every read of an old
   * value becomes a deterministic search that finds nothing, which is
   * indistinguishable from the record not being there.
   */
  it("drops one that is not an alternative", () => {
    const schemes = previousSchemes(current, [{ deterministic: true, keyId: "2022" }]);

    expect(schemes).toEqual([]);
  });

  it("is empty when nothing came before", () => {
    expect(previousSchemes(current)).toEqual([]);
  });
});

describe("the order a value is tried in", () => {
  const current: EncryptionScheme = { keyId: "2024" };

  it("starts with the current scheme", () => {
    expect(schemesToTry(current, [{ keyId: "2022" }])).toEqual([current, { keyId: "2022" }]);
  });

  /**
   * Tried first, plaintext would read an encrypted value as its own ciphertext
   * — a string that is not an error and is not the data.
   */
  it("puts plaintext last, and only when it was asked for", () => {
    expect(schemesToTry(current, [], true)).toEqual([current, "clear"]);
    expect(schemesToTry(current, [], false)).toEqual([current]);
  });
});
