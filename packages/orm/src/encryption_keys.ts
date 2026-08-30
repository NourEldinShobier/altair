/**
 * Which key encrypts, and which keys still decrypt. Ported from
 * `ActiveRecord::Encryption::KeyProvider`, `DerivedSecretKeyProvider` and the
 * encryption context.
 *
 * `encryption.ts` derives one key from the application's secret and uses it
 * for everything. That works until the day the key has to change, and then it
 * does not work at all: every encrypted column in the database was written
 * with the old key, so changing it makes every one of them unreadable at once.
 *
 * The fix is to separate the two questions. One key encrypts — the newest.
 * Several may decrypt — the newest and every older one, tried in order. A
 * rotation is then adding a key at the front and leaving the old one listed;
 * rows re-encrypt as they are written, and nothing has to happen in one go.
 * The old key is dropped later, when nothing is left that needs it.
 *
 * A key id in the ciphertext is what makes that cheap. Without it, reading a
 * row written under the fifth-oldest key means five failed decryptions first,
 * and each failure is a full AES pass over the value. With it, the reader goes
 * straight to the right key, and a wrong id is refused rather than guessed at.
 */

import { createHash, randomBytes } from "node:crypto";
import { KeyGenerator } from "@altair/support";

/** How long a key is, in bytes. AES-256 and nothing else. */
export const KEY_LENGTH = 32;

export function keyLength(): number {
  return KEY_LENGTH;
}

/** One key, and the short id that names it in a ciphertext. */
export class EncryptionKey {
  readonly secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length !== KEY_LENGTH) {
      throw new Error(
        `An encryption key must be ${String(KEY_LENGTH)} bytes; got ${String(secret.length)}.`,
      );
    }

    this.secret = secret;
  }

  /**
   * A short digest of the key, written into the ciphertext so a reader knows
   * which key to try.
   *
   * A digest rather than a counter, because a counter has to be kept somewhere
   * and two deploys that both add "key 3" then disagree about what 3 means. A
   * digest is the same everywhere the key is, and says nothing about the key —
   * it is truncated, so it is not a verifier either.
   */
  get id(): string {
    return createHash("sha256").update(this.secret).digest("hex").slice(0, 8);
  }
}

/** A key from raw bytes. */
export function generateRandomKey(): EncryptionKey {
  return new EncryptionKey(randomBytes(KEY_LENGTH));
}

/** The same as hex, for putting in an environment variable. */
export function generateRandomHexKey(): string {
  return randomBytes(KEY_LENGTH).toString("hex");
}

/**
 * A key from a password. Rails' `derive_key_from`.
 *
 * Through the key generator rather than hashing the password, because a
 * password used directly as a key is as strong as the password — and the
 * whole point of a derivation is that it is not.
 */
export function deriveKeyFrom(password: string, salt = "active record encryption"): EncryptionKey {
  return new EncryptionKey(new KeyGenerator(password).generate(salt, KEY_LENGTH));
}

/**
 * Serves keys. Rails' `KeyProvider`.
 *
 * Ordered oldest first, matching Rails, so the newest — the one that encrypts
 * — is the last. That ordering is the one a config file reads naturally: a
 * rotation appends.
 */
export class KeyProvider {
  readonly keys: readonly EncryptionKey[];

  constructor(keys: readonly EncryptionKey[]) {
    if (keys.length === 0) throw new Error("A key provider needs at least one key.");

    this.keys = keys;
  }

  /** The key new values are written with. Rails' `encryption_key`. */
  encryptionKey(): EncryptionKey {
    return this.keys[this.keys.length - 1] as EncryptionKey;
  }

  /**
   * The keys a value might be readable with. Rails' `decryption_keys`.
   *
   * When the ciphertext names its key, only that one — so a row written under
   * an old key costs one decryption rather than one per key tried before it.
   * When it does not, all of them, newest first, because the newest is what
   * most rows were written with.
   */
  decryptionKeys(keyId?: string): EncryptionKey[] {
    if (keyId !== undefined) {
      return this.keys.filter((key) => key.id === keyId);
    }

    return Array.from(this.keys).reverse();
  }

  /** The key that will encrypt next, for a caller checking a rotation took. */
  nextKey(): EncryptionKey {
    return this.encryptionKey();
  }

  /** Each key with its id, for a task that reports what is in use. */
  *eachKey(): Generator<{ id: string; key: EncryptionKey }> {
    for (const key of this.keys) yield { id: key.id, key };
  }

  /**
   * The same provider with one more key, which becomes the one that encrypts.
   *
   * A new provider rather than a mutation: the old one may be captured by a
   * request already in flight, and a rotation that changes what that request
   * decrypts with halfway through is a bug nobody will reproduce.
   */
  rotate(key: EncryptionKey): KeyProvider {
    return new KeyProvider([...this.keys, key]);
  }
}

/** A provider built from passwords. Rails' `DerivedSecretKeyProvider`. */
export function derivedKeyProvider(passwords: readonly string[]): KeyProvider {
  return new KeyProvider(passwords.map((password) => deriveKeyFrom(password)));
}

/** What is in force right now. */
export interface EncryptionContext {
  keyProvider: KeyProvider;
  /**
   * Whether a column may hold plaintext.
   *
   * True while a column is being encrypted for the first time, and false
   * after: leaving it on means a row whose ciphertext is corrupt reads back as
   * whatever bytes are in the column, silently, rather than failing.
   */
  supportUnencryptedData: boolean;
  /** Whether writes encrypt at all. */
  encrypting: boolean;
}

let context: EncryptionContext | undefined;

export function setKeyProvider(provider: KeyProvider): void {
  context = {
    keyProvider: provider,
    supportUnencryptedData: context?.supportUnencryptedData ?? false,
    encrypting: true,
  };
}

/** The provider in force. Rails' `key_provider`. */
export function keyProvider(): KeyProvider {
  if (!context) {
    throw new Error(
      "No encryption keys configured. Call setKeyProvider(derivedKeyProvider([secret])) first.",
    );
  }

  return context.keyProvider;
}

export function encryptionContext(): EncryptionContext {
  if (!context) throw new Error("No encryption context. Call setKeyProvider first.");

  return { ...context };
}

export function resetEncryptionKeys(): void {
  context = undefined;
}

export function supportUnencryptedData(): boolean {
  return context?.supportUnencryptedData ?? false;
}

export function setSupportUnencryptedData(enabled: boolean): void {
  if (context) context.supportUnencryptedData = enabled;
}

/**
 * Runs something under different settings. Rails' `with_encryption_context`.
 *
 * Restored in a `finally`, because the alternative is that one throwing block
 * leaves the process reading plaintext — which is exactly the setting you
 * would least like to leave on by accident.
 */
export function withEncryptionContext<T>(changes: Partial<EncryptionContext>, body: () => T): T {
  const previous = context;

  context = { ...encryptionContext(), ...changes };

  try {
    return body();
  } finally {
    context = previous;
  }
}

/**
 * Runs something without encrypting. Rails' `without_encryption`.
 *
 * For a bulk load whose values are already ciphertext, and for a migration
 * that is copying rows rather than reading them.
 */
export function withoutEncryption<T>(body: () => T): T {
  return withEncryptionContext({ encrypting: false, supportUnencryptedData: true }, body);
}

/**
 * Runs something that must not write plaintext. Rails'
 * `protecting_encrypted_data`.
 *
 * The opposite guard, and the one worth having in a console: it stops a
 * well-meant `update` from replacing a ciphertext with the value somebody read
 * off the screen.
 */
export function protectingEncryptedData<T>(body: () => T): T {
  return withEncryptionContext({ supportUnencryptedData: false, encrypting: true }, body);
}

/**
 * Which attributes on which models are encrypted, and which of those can be
 * queried.
 *
 * Kept because a deterministic column is the one that can be looked up, and a
 * query against a non-deterministic one silently matches nothing — a bug that
 * looks like missing data rather than a mistake.
 */
const declared = new Map<string, Set<string>>();
const deterministic = new Map<string, Set<string>>();

export type EncryptedAttributeListener = (
  model: string,
  attribute: string,
  options: { deterministic: boolean },
) => void;

const listeners: EncryptedAttributeListener[] = [];

/** Rails' `on_encrypted_attribute_declared`. */
export function onEncryptedAttributeDeclared(listener: EncryptedAttributeListener): void {
  listeners.push(listener);
}

/** Rails' `encrypted_attribute_was_declared`. */
export function encryptedAttributeWasDeclared(
  model: string,
  attribute: string,
  options: { deterministic?: boolean } = {},
): void {
  addTo(declared, model, attribute);

  if (options.deterministic === true) addTo(deterministic, model, attribute);

  for (const listener of listeners) {
    listener(model, attribute, { deterministic: options.deterministic === true });
  }
}

function addTo(into: Map<string, Set<string>>, model: string, attribute: string): void {
  let names = into.get(model);

  if (!names) {
    names = new Set();
    into.set(model, names);
  }

  names.add(attribute);
}

export function encryptedAttributes(model: string): string[] {
  return Array.from(declared.get(model) ?? []);
}

/** Rails' `deterministic_encrypted_attributes`. */
export function deterministicEncryptedAttributes(model: string): string[] {
  return Array.from(deterministic.get(model) ?? []);
}

export function isDeterministicEncryptedAttribute(model: string, attribute: string): boolean {
  return deterministic.get(model)?.has(attribute) ?? false;
}

export function forgetEncryptedAttributes(): void {
  declared.clear();
  deterministic.clear();
  listeners.length = 0;
}
