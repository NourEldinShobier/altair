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
  /**
   * Folds the value for the ciphertext but keeps the original. Rails'
   * `ignore_case:`.
   *
   * `downcase` makes a deterministic column findable and loses how the value
   * was typed, which is fine for a lookup key and not fine for anything shown
   * back to the person who typed it. This keeps both: the column holds the
   * folded value so a lookup works, and a companion column holds the original
   * so the application can display it.
   *
   * The companion is encrypted too, and not deterministically — it is the same
   * secret, and storing it in the clear next to the ciphertext would hand back
   * everything the encryption was for.
   */
  ignoreCase?: boolean;
}

/** Where the original spelling of an `ignoreCase` attribute is kept. */
export function originalAttributeName(attribute: string): string {
  return `original_${attribute}`;
}

/** Raised when folding a column would lose information and buy nothing. */
export class PointlessDowncase extends Error {
  constructor(option = "downcase") {
    super(
      `${option} only helps a deterministic column, where a lookup has to encrypt the search ` +
        `value and compare ciphertext. On a non-deterministic one it throws the original case ` +
        `away and enables nothing — use \`normalizes\` if the value should be stored folded.`,
    );
    this.name = "PointlessDowncase";
  }
}

/** Whether a scheme folds the value before encrypting it. */
export function foldsCase(options: EncryptedAttributeOptions): boolean {
  return options.downcase === true || options.ignoreCase === true;
}

/** Raised when a column cannot be decrypted and is not allowed to be plaintext. */
export class UnreadableCiphertext extends Error {
  constructor(attribute: string) {
    super(
      `Could not decrypt "${attribute}" with the current key or any previous one. The key may ` +
        `have changed without the old one being kept — pass it as \`previous\` to ` +
        `configureEncryption — or the column may hold unencrypted data, which needs ` +
        `supportUnencrypted to read while migrating.`,
    );
    this.name = "UnreadableCiphertext";
  }
}

const PREFIX = "altenc:";
const DETERMINISTIC_PREFIX = "altdet:";

interface KeyMaterial {
  primary: Buffer;
  deterministic: Buffer;
}

let keys: KeyMaterial | undefined;
let retired: KeyMaterial[] = [];

/**
 * Derives the keys from the application's secret.
 *
 * Two separate keys from one secret, so the deterministic scheme cannot be
 * used to learn anything about values encrypted under the other.
 */
export function configureEncryption(
  secretKeyBase: string,
  { previous = [] }: { previous?: readonly string[] } = {},
): void {
  keys = deriveKeys(secretKeyBase);
  retired = previous.map((secret) => deriveKeys(secret));
}

function deriveKeys(secretKeyBase: string): KeyMaterial {
  const generator = new KeyGenerator(secretKeyBase);

  return {
    primary: generator.generate("active record encryption"),
    deterministic: generator.generate("active record deterministic encryption"),
  };
}

/**
 * The keys a column will still read, after the one it is written with. Rails'
 * `previous_types`.
 *
 * A rotation that could not read the old key would not be a rotation — it
 * would be an outage. Every encrypted row in the database was written under
 * the previous secret, and re-encrypting them all before the new one can be
 * deployed is a migration that has to run while the application is down.
 *
 * So the new key is what writes, the old ones are what still read, and rows
 * move over as they are next saved. The old secrets come out of the
 * configuration once nothing is left that needs them — and until then, this
 * being empty is what an application that never rotated looks like.
 */
export function previousTypes(): readonly KeyMaterial[] {
  return retired;
}

export function resetEncryption(): void {
  keys = undefined;
  retired = [];
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

  if (foldsCase(options) && !options.deterministic) {
    throw new PointlessDowncase(options.ignoreCase ? "ignoreCase" : "downcase");
  }

  const material = requireKeys();
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  // A non-string was serialised to JSON above, and folding that would change
  // the keys as well as the values — so only an actual string is folded.
  const plaintext = foldsCase(options) && typeof value === "string" ? value.toLowerCase() : raw;

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

  // A row is read under whichever key wrote it, and nothing has to know which
  // that was. The current key is tried first for speed rather than for
  // correctness: the cipher is authenticated, so a ciphertext decrypts under
  // exactly one of these and the order cannot change the answer — but most
  // rows were written under the current key, so most reads stop at the first.
  for (const material of [requireKeys(), ...retired]) {
    const plaintext = value.startsWith(DETERMINISTIC_PREFIX)
      ? decryptDeterministic(value, material.deterministic)
      : new MessageEncryptor(material.primary).decrypt<string>(value.slice(PREFIX.length));

    if (plaintext !== null) return plaintext;
  }

  throw new UnreadableCiphertext(attribute);
}
