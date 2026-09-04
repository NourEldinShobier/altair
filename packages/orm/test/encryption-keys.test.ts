/**
 * Which key encrypts and which keys still decrypt, ported from
 * `activerecord/test/cases/encryption/key_provider_test.rb`,
 * `derived_secret_key_provider_test.rb` and the encryption context cases.
 *
 * One key for everything works until the day it has to change, and then it
 * does not work at all: every encrypted column was written with the old key,
 * so changing it makes all of them unreadable at once.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  EncryptionKey,
  KEY_LENGTH,
  KeyProvider,
  derivedKeyProvider,
  deriveKeyFrom,
  deterministicEncryptedAttributes,
  encryptedAttributeWasDeclared,
  encryptedAttributes,
  encryptionContext,
  forgetEncryptedAttributes,
  generateRandomHexKey,
  generateRandomKey,
  isDeterministicEncryptedAttribute,
  keyLength,
  keyProvider,
  onEncryptedAttributeDeclared,
  protectingEncryptedData,
  resetEncryptionKeys,
  setKeyProvider,
  setSupportUnencryptedData,
  supportUnencryptedData,
  withEncryptionContext,
  withoutEncryption,
} from "../src/encryption-keys.js";

afterEach(() => {
  resetEncryptionKeys();
  forgetEncryptedAttributes();
});

describe("keys", () => {
  it("is 32 bytes, for AES-256 and nothing else", () => {
    expect(keyLength()).toBe(32);
    expect(generateRandomKey().secret).toHaveLength(KEY_LENGTH);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => new EncryptionKey(Buffer.alloc(16))).toThrow("32 bytes");
  });

  it("makes a different key each time", () => {
    expect(generateRandomKey().secret.equals(generateRandomKey().secret)).toBe(false);
  });

  it("makes a hex key of the right length", () => {
    expect(generateRandomHexKey()).toHaveLength(KEY_LENGTH * 2);
  });

  /**
   * A password used directly as a key is as strong as the password, and the
   * whole point of a derivation is that it is not.
   */
  it("derives a key from a password", () => {
    expect(deriveKeyFrom("a password").secret).toHaveLength(KEY_LENGTH);
  });

  it("derives the same key from the same password", () => {
    expect(deriveKeyFrom("same").secret.equals(deriveKeyFrom("same").secret)).toBe(true);
  });

  it("derives different keys from different passwords", () => {
    expect(deriveKeyFrom("one").secret.equals(deriveKeyFrom("two").secret)).toBe(false);
  });

  it("derives different keys under different salts", () => {
    expect(deriveKeyFrom("p", "a").secret.equals(deriveKeyFrom("p", "b").secret)).toBe(false);
  });
});

describe("key ids", () => {
  /** A counter has to be kept somewhere; a digest is the same everywhere the key is. */
  it("names a key by a digest of itself", () => {
    const key = deriveKeyFrom("a password");

    expect(key.id).toBe(deriveKeyFrom("a password").id);
  });

  it("gives different keys different ids", () => {
    expect(deriveKeyFrom("one").id).not.toBe(deriveKeyFrom("two").id);
  });

  /** Truncated, so it is not a verifier either. */
  it("is short", () => {
    expect(generateRandomKey().id).toHaveLength(8);
  });

  it("is not the key", () => {
    const key = generateRandomKey();

    expect(key.id).not.toBe(key.secret.toString("hex"));
  });
});

describe("KeyProvider", () => {
  const older = deriveKeyFrom("older");
  const newer = deriveKeyFrom("newer");
  const provider = new KeyProvider([older, newer]);

  /** Oldest first, so a rotation appends — which is how a config file reads. */
  it("encrypts with the newest key", () => {
    expect(provider.encryptionKey()).toBe(newer);
  });

  it("says which key will encrypt next", () => {
    expect(provider.nextKey()).toBe(newer);
  });

  it("refuses to be built with no keys", () => {
    expect(() => new KeyProvider([])).toThrow("at least one key");
  });

  it("decrypts with a single key when there is one", () => {
    expect(new KeyProvider([older]).decryptionKeys()).toEqual([older]);
  });

  /** The newest is what most rows were written with. */
  it("offers every key newest first when the ciphertext names none", () => {
    expect(provider.decryptionKeys()).toEqual([newer, older]);
  });

  /**
   * A row written under the fifth-oldest key otherwise costs five failed
   * decryptions first, each a full AES pass over the value.
   */
  it("offers only the named key when the ciphertext names one", () => {
    expect(provider.decryptionKeys(older.id)).toEqual([older]);
  });

  it("offers nothing for an id no key has", () => {
    expect(provider.decryptionKeys("deadbeef")).toEqual([]);
  });

  it("lists every key with its id", () => {
    expect(Array.from(provider.eachKey()).map((each) => each.id)).toEqual([older.id, newer.id]);
  });

  /**
   * A new provider rather than a mutation: the old one may be captured by a
   * request in flight, and changing what it decrypts with halfway through is a
   * bug nobody will reproduce.
   */
  it("rotates into a new provider without changing the old one", () => {
    const third = deriveKeyFrom("third");
    const rotated = provider.rotate(third);

    expect(rotated.encryptionKey()).toBe(third);
    expect(provider.encryptionKey()).toBe(newer);
  });

  /** The whole point: the old key still reads what it wrote. */
  it("still decrypts with the old key after a rotation", () => {
    const rotated = provider.rotate(deriveKeyFrom("third"));

    expect(rotated.decryptionKeys(older.id)).toEqual([older]);
  });

  it("builds a provider from passwords", () => {
    const built = derivedKeyProvider(["one", "two"]);

    expect(built.encryptionKey().id).toBe(deriveKeyFrom("two").id);
  });
});

describe("the context", () => {
  it("has no keys until it is given some", () => {
    expect(() => keyProvider()).toThrow("No encryption keys configured");
  });

  it("says how to configure them", () => {
    expect(() => keyProvider()).toThrow("setKeyProvider");
  });

  it("serves the provider it was given", () => {
    const provider = derivedKeyProvider(["secret"]);
    setKeyProvider(provider);

    expect(keyProvider()).toBe(provider);
  });

  it("reports the whole context", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    expect(encryptionContext().encrypting).toBe(true);
  });

  it("gives a copy, so a caller cannot write through it", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    encryptionContext().encrypting = false;

    expect(encryptionContext().encrypting).toBe(true);
  });

  /**
   * Leaving it on means a row whose ciphertext is corrupt reads back as
   * whatever bytes are in the column, silently, rather than failing.
   */
  it("does not allow plaintext by default", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    expect(supportUnencryptedData()).toBe(false);
  });

  it("allows it while a column is being migrated", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));
    setSupportUnencryptedData(true);

    expect(supportUnencryptedData()).toBe(true);
  });
});

describe("running under different settings", () => {
  it("changes them for the block", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    const seen = withEncryptionContext({ encrypting: false }, () => encryptionContext().encrypting);

    expect(seen).toBe(false);
  });

  it("puts them back afterwards", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    withEncryptionContext({ encrypting: false }, () => undefined);

    expect(encryptionContext().encrypting).toBe(true);
  });

  /**
   * Without the finally, one throwing block leaves the process reading
   * plaintext — the setting you would least like left on by accident.
   */
  it("puts them back even when the block throws", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    expect(() =>
      withEncryptionContext({ supportUnencryptedData: true }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(supportUnencryptedData()).toBe(false);
  });

  it("keeps the keys through a change", () => {
    const provider = derivedKeyProvider(["secret"]);
    setKeyProvider(provider);

    withEncryptionContext({ encrypting: false }, () => {
      expect(keyProvider()).toBe(provider);
    });
  });

  /** For a bulk load whose values are already ciphertext. */
  it("runs without encrypting", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));

    withoutEncryption(() => {
      expect(encryptionContext().encrypting).toBe(false);
      expect(supportUnencryptedData()).toBe(true);
    });

    expect(encryptionContext().encrypting).toBe(true);
  });

  /**
   * The opposite guard, and the one worth having in a console: it stops a
   * well-meant update from replacing a ciphertext with what somebody read off
   * the screen.
   */
  it("runs protecting what is already encrypted", () => {
    setKeyProvider(derivedKeyProvider(["secret"]));
    setSupportUnencryptedData(true);

    protectingEncryptedData(() => {
      expect(supportUnencryptedData()).toBe(false);
      expect(encryptionContext().encrypting).toBe(true);
    });

    expect(supportUnencryptedData()).toBe(true);
  });

  it("refuses to change a context that does not exist", () => {
    expect(() => withEncryptionContext({}, () => 1)).toThrow("No encryption context");
  });
});

describe("declared attributes", () => {
  it("records one", () => {
    encryptedAttributeWasDeclared("Post", "secret");

    expect(encryptedAttributes("Post")).toEqual(["secret"]);
  });

  it("records several without repeating one", () => {
    encryptedAttributeWasDeclared("Post", "secret");
    encryptedAttributeWasDeclared("Post", "secret");
    encryptedAttributeWasDeclared("Post", "other");

    expect(encryptedAttributes("Post")).toEqual(["secret", "other"]);
  });

  it("keeps each model's separate", () => {
    encryptedAttributeWasDeclared("Post", "a");
    encryptedAttributeWasDeclared("User", "b");

    expect(encryptedAttributes("Post")).toEqual(["a"]);
    expect(encryptedAttributes("User")).toEqual(["b"]);
  });

  it("reports none for a model with none", () => {
    expect(encryptedAttributes("Nothing")).toEqual([]);
  });

  /**
   * A deterministic column is the one that can be looked up; a query against a
   * non-deterministic one silently matches nothing, which looks like missing
   * data rather than a mistake.
   */
  it("records which ones can be queried", () => {
    encryptedAttributeWasDeclared("Post", "email", { deterministic: true });
    encryptedAttributeWasDeclared("Post", "notes");

    expect(deterministicEncryptedAttributes("Post")).toEqual(["email"]);
    expect(isDeterministicEncryptedAttribute("Post", "email")).toBe(true);
    expect(isDeterministicEncryptedAttribute("Post", "notes")).toBe(false);
  });

  it("counts a non-deterministic one among the encrypted ones", () => {
    encryptedAttributeWasDeclared("Post", "notes");

    expect(encryptedAttributes("Post")).toContain("notes");
  });

  it("tells a listener when one is declared", () => {
    const seen: string[] = [];
    onEncryptedAttributeDeclared((model, attribute) => seen.push(`${model}.${attribute}`));

    encryptedAttributeWasDeclared("Post", "secret");

    expect(seen).toEqual(["Post.secret"]);
  });

  it("tells it whether the attribute can be queried", () => {
    let deterministic: boolean | undefined;
    onEncryptedAttributeDeclared((_model, _attribute, options) => {
      deterministic = options.deterministic;
    });

    encryptedAttributeWasDeclared("Post", "email", { deterministic: true });

    expect(deterministic).toBe(true);
  });

  it("tells every listener", () => {
    let first = 0;
    let second = 0;
    onEncryptedAttributeDeclared(() => (first += 1));
    onEncryptedAttributeDeclared(() => (second += 1));

    encryptedAttributeWasDeclared("Post", "a");

    expect([first, second]).toEqual([1, 1]);
  });
});
