/**
 * Encrypted attributes, ported from `ActiveRecord::Encryption`.
 *
 * Rails encrypts a column so that a database dump, a replica, or a backup that
 * escapes does not carry the plaintext. The application still writes
 * `user.ssn = "..."` and reads it back; the ciphertext is what the column
 * holds.
 *
 *     class User extends Model<UserRow>("users") {
 *       static { this.encrypts("ssn") }
 *     }
 *
 * There are two modes and the difference matters. Non-deterministic encryption
 * uses a fresh nonce each time, so the same value encrypts differently and
 * nothing can be learned by comparing rows — but it cannot be searched for.
 * Deterministic encryption produces the same ciphertext for the same input, so
 * `where({ email })` works, at the cost of letting anyone holding the database
 * see which rows share a value. Rails makes the same trade and defaults to the
 * safer one.
 */

import { MessageEncryptor, KeyGenerator } from "@altair/support";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";

export interface EncryptedAttributeOptions {
  /**
   * Makes the ciphertext repeatable, so the column can be queried.
   *
   * Only for a column that has to be looked up. Two rows with the same value
   * become visibly the same to anyone with the data.
   */
  deterministic?: boolean;
  /**
   * Reads an unencrypted value if that is what the column holds.
   *
   * What makes it possible to encrypt a column that already has data in it:
   * rows are decrypted if they can be and returned as they are if not, so the
   * old rows keep working while they are migrated.
   */
  supportUnencrypted?: boolean;
  /**
   * Folds the value to lower case before encrypting. Rails' `downcase:`.
   *
   * This exists because a deterministic column is looked up by encrypting the
   * search value and comparing ciphertext, and the database can do nothing
   * else: it has no plaintext to apply `LOWER` to. So `where({ email:
   * "Bob@example.com" })` finds nothing at all when the row was stored as
   * `bob@example.com` — not an error, not a warning, an empty result. Folding
   * on the way in and on the way to a query is the only place the two can be
   * made to agree.
   *
   * The cost is that the original case is gone. Rails offers `ignore_case:` to
   * keep it in a second column; that is not here yet.
   */
  downcase?: boolean;
}

/** Raised when downcasing a column would lose information and buy nothing. */
export class PointlessDowncase extends Error {
  constructor() {
    super(
      "downcase only helps a deterministic column, where a lookup has to encrypt the search " +
        "value and compare ciphertext. On a non-deterministic one it throws the original case " +
        "away and enables nothing — use `normalizes` if the value should be stored folded.",
    );
    this.name = "PointlessDowncase";
  }
}

/** Raised when a column cannot be decrypted and is not allowed to be plaintext. */
export class UnreadableCiphertext extends Error {
  constructor(attribute: string) {
    super(
      `Could not decrypt "${attribute}". The key may have changed, or the column may hold ` +
        `unencrypted data — pass supportUnencrypted to read it while migrating.`,
    );
    this.name = "UnreadableCiphertext";
  }
}

const PREFIX = "altenc:";
const DETERMINISTIC_PREFIX = "altdet:";

let keys: { primary: Buffer; deterministic: Buffer } | undefined;

/**
 * Derives the keys from the application's secret.
 *
 * Two separate keys from one secret, so the deterministic scheme cannot be
 * used to learn anything about values encrypted under the other.
 */
export function configureEncryption(secretKeyBase: string): void {
  const generator = new KeyGenerator(secretKeyBase);

  keys = {
    primary: generator.generate("active record encryption"),
    deterministic: generator.generate("active record deterministic encryption"),
  };
}

export function resetEncryption(): void {
  keys = undefined;
}

export function isEncryptionConfigured(): boolean {
  return keys !== undefined;
}

function requireKeys(): { primary: Buffer; deterministic: Buffer } {
  if (!keys) {
    throw new Error(
      "Encryption is not configured. Call configureEncryption(secretKeyBase) before using an encrypted attribute.",
    );
  }
  return keys;
}

/** Whether a stored value is something this wrote. */
export function isEncrypted(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith(PREFIX) || value.startsWith(DETERMINISTIC_PREFIX))
  );
}

/**
 * Encrypts a value so that equal inputs produce equal output.
 *
 * The nonce is derived from the plaintext rather than drawn at random, which
 * is what makes the result repeatable. It is derived under a separate key, so
 * the nonce does not leak the value.
 */
function encryptDeterministic(plaintext: string, key: Buffer): string {
  const iv = createHmac("sha256", key).update(plaintext).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return (
    DETERMINISTIC_PREFIX +
    [encrypted.toString("base64url"), iv.toString("base64url"), tag.toString("base64url")].join(".")
  );
}

function decryptDeterministic(message: string, key: Buffer): string | null {
  const parts = message.slice(DETERMINISTIC_PREFIX.length).split(".");
  if (parts.length !== 3) return null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(parts[0]!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A tampered or wrongly-keyed value fails authentication, which is the
    // scheme working rather than an error to pass along.
    return null;
  }
}

/** Encrypts a value on its way into a column. */
export function encryptValue(value: unknown, options: EncryptedAttributeOptions = {}): unknown {
  // A null column stays null: encrypting it would make every empty row look
  // like it held something, and would break `where({ ssn: null })`.
  if (value === null || value === undefined) return value;

  if (options.downcase && !options.deterministic) throw new PointlessDowncase();

  const material = requireKeys();
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  // A non-string was serialised to JSON above, and folding that would change
  // the keys as well as the values — so only an actual string is folded.
  const plaintext = options.downcase && typeof value === "string" ? value.toLowerCase() : raw;

  if (options.deterministic) return encryptDeterministic(plaintext, material.deterministic);

  return PREFIX + new MessageEncryptor(material.primary).encrypt(plaintext);
}

/** Decrypts a value on its way out of a column. */
export function decryptValue(
  value: unknown,
  attribute: string,
  options: EncryptedAttributeOptions = {},
): unknown {
  if (value === null || value === undefined) return value;

  if (!isEncrypted(value)) {
    // A column being encrypted for the first time still holds plaintext.
    if (options.supportUnencrypted) return value;
    throw new UnreadableCiphertext(attribute);
  }

  const material = requireKeys();

  const plaintext = value.startsWith(DETERMINISTIC_PREFIX)
    ? decryptDeterministic(value, material.deterministic)
    : new MessageEncryptor(material.primary).decrypt<string>(value.slice(PREFIX.length));

  if (plaintext === null) throw new UnreadableCiphertext(attribute);
  return plaintext;
}
