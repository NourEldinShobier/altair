/**
 * What travels alongside a ciphertext, and what happens when the scheme
 * changes. Ported from `ActiveRecord::Encryption::Properties`, `Message`,
 * `Scheme#previous_schemes` and `Cipher::Aes256Gcm`.
 *
 * `encryption.ts` encrypts a column and decrypts it again. That works for as
 * long as nothing changes, and something always changes: a key is rotated, an
 * algorithm is replaced, a deterministic column is switched to a
 * non-deterministic one. The rows already in the table were encrypted the old
 * way and cannot be re-encrypted without reading them first — which requires
 * decrypting them the old way.
 *
 * So a message carries *headers*, and the reader keeps a list of *previous
 * schemes*. Both exist for the same reason and both fail the same way when
 * they are missing: an encrypted column whose scheme changed reads as
 * unreadable ciphertext, which looks exactly like corruption. The difference
 * matters, because corruption gets restored from a backup and a rotation gets
 * a scheme added to a list.
 *
 * The headers are stored under one- and two-letter keys, and that is not
 * premature: they are written into every encrypted value in the table, so the
 * difference between `k` and `encrypted_data_key` is a byte count multiplied
 * by the row count.
 */

/** What a header may hold. Rails' `ALLOWED_VALUE_CLASSES`. */
export type PropertyValue = string | number | boolean | null;

/**
 * The short keys headers are stored under, and the names they are read by.
 * Rails' `DEFAULT_PROPERTIES`.
 */
export const PROPERTY_KEYS = {
  encryptedDataKey: "k",
  encryptedDataKeyId: "i",
  compressed: "c",
  iv: "iv",
  authTag: "at",
  encoding: "e",
} as const;

export type PropertyName = keyof typeof PROPERTY_KEYS;

export class ForbiddenPropertyClass extends TypeError {
  constructor(value: unknown) {
    super(
      `A header cannot hold a ${typeof value}. Headers are serialised into every encrypted ` +
        `value, so only a string, a number, a boolean or null can go in one — anything else ` +
        `serialises to something that will not come back as what it was.`,
    );
    this.name = "ForbiddenPropertyClass";
  }
}

export class EncryptedContentIntegrity extends Error {
  constructor(key: string) {
    super(
      `The header ${JSON.stringify(key)} is already set and cannot be overwritten. A header set ` +
        `twice means two things believe they decide it, and the value that decrypts is whichever ` +
        `wrote last.`,
    );
    this.name = "EncryptedContentIntegrity";
  }
}

/**
 * Rails' `validate_value_type`.
 *
 * Checked when the header is *set* rather than when the message is serialised.
 * A value that cannot survive the round trip is a mistake at the line that
 * wrote it, and caught at serialisation it is instead a failure inside the
 * encryptor, on a value nobody there can name.
 */
export function validateValueType(value: unknown): asserts value is PropertyValue {
  if (value === null) return;
  if (["string", "number", "boolean"].includes(typeof value)) return;

  throw new ForbiddenPropertyClass(value);
}

/**
 * The headers on a message. Rails' `Properties`.
 *
 * Write-once: a header already set is refused rather than replaced. Two things
 * that both believe they decide the key id produce a message that decrypts
 * under whichever wrote last — and the one that fails does so months later,
 * when the other key is retired.
 */
export class EncryptionProperties {
  readonly #data = new Map<string, PropertyValue>();

  constructor(initial: Record<string, unknown> = {}) {
    this.add(initial);
  }

  set(key: string, value: unknown): void {
    if (this.#data.has(key)) throw new EncryptedContentIntegrity(key);

    validateValueType(value);
    this.#data.set(key, value);
  }

  get(key: string): PropertyValue | undefined {
    return this.#data.get(key);
  }

  has(key: string): boolean {
    return this.#data.has(key);
  }

  add(properties: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(properties)) this.set(key, value);
  }

  /** Reads a header by its readable name rather than its stored key. */
  read(name: PropertyName): PropertyValue | undefined {
    return this.get(PROPERTY_KEYS[name]);
  }

  write(name: PropertyName, value: unknown): void {
    this.set(PROPERTY_KEYS[name], value);
  }

  toJSON(): Record<string, PropertyValue> {
    return Object.fromEntries(this.#data);
  }
}

// --- the cipher ------------------------------------------------------------

export const CIPHER_TYPE = "aes-256-gcm";

/** Rails' `Cipher::Aes256Gcm.key_length`. */
export function cipherKeyLength(): number {
  return 32;
}

/**
 * Rails' `Cipher::Aes256Gcm.iv_length`.
 *
 * Twelve bytes, which is GCM's own size rather than the block size. A
 * sixteen-byte IV is accepted by most libraries and is *not* the same
 * construction: GCM derives its counter differently outside twelve bytes, so a
 * value encrypted with one and read with the other authenticates and produces
 * the wrong plaintext.
 */
export function ivLength(): number {
  return 12;
}

// --- schemes that came before ----------------------------------------------

/**
 * How a column is encrypted. Rails' `Scheme`.
 *
 * `deterministic` is the part that cannot silently differ: the same value
 * encrypts to the same ciphertext, which is what lets `where({ email })` work
 * and what lets anyone holding the database see which rows share a value.
 */
export interface EncryptionScheme {
  deterministic?: boolean;
  downcase?: boolean;
  keyId?: string;
  compress?: boolean;
}

/**
 * Rails' `Scheme#compatible_with?`.
 *
 * Only the deterministic flag. Two schemes that disagree there cannot be
 * alternatives for one column: a deterministic read of a non-deterministic
 * value is not a decryption failure, it is a *query* that quietly matches
 * nothing, because the ciphertext being searched for was never the ciphertext
 * stored.
 */
export function schemeCompatibleWith(scheme: EncryptionScheme, other: EncryptionScheme): boolean {
  return Boolean(scheme.deterministic) === Boolean(other.deterministic);
}

/**
 * The schemes a column will still read. Rails' `previous_schemes`.
 *
 * The application's global list first, then the ones this attribute declared,
 * because the global list is the older rotation: a value is tried against the
 * current scheme, then against each of these in turn, and the order is the
 * order they were retired in.
 *
 * Incompatible schemes are dropped rather than kept and skipped later. Kept,
 * they turn every read of an old value into a deterministic search that finds
 * nothing — which is indistinguishable from the record not being there.
 */
export function previousSchemes(
  scheme: EncryptionScheme,
  global: readonly EncryptionScheme[] = [],
  declared: readonly EncryptionScheme[] = [],
): EncryptionScheme[] {
  return [...global, ...declared]
    .filter((previous) => schemeCompatibleWith(scheme, previous))
    .map((previous) => ({ ...scheme, ...previous }));
}

/**
 * Every scheme to try, in order. Rails' `previous_schemes_including_clean_text`.
 *
 * The plaintext "scheme" goes last, and only when the column was told to accept
 * unencrypted data. Tried first it would read an encrypted value as its own
 * ciphertext — a string that is not an error and is not the data.
 */
export function schemesToTry(
  scheme: EncryptionScheme,
  previous: readonly EncryptionScheme[],
  supportUnencryptedData = false,
): (EncryptionScheme | "clear")[] {
  return [scheme, ...previous, ...(supportUnencryptedData ? (["clear"] as const) : [])];
}
