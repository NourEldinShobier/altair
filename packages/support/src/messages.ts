/**
 * Signed and encrypted messages, ported from `ActiveSupport::MessageVerifier`,
 * `MessageEncryptor` and `KeyGenerator`.
 *
 * These carry session data and signed cookies, so the details matter more here
 * than anywhere else in the framework:
 *
 *   - Signatures are compared in constant time. A byte-by-byte comparison that
 *     returns early leaks the correct value one byte at a time.
 *   - Encryption is AES-256-GCM, which authenticates as well as encrypts, so a
 *     tampered payload fails to decrypt rather than decrypting to garbage.
 *   - Keys are derived per purpose, so the key signing a cookie is not the key
 *     encrypting a session.
 *   - Parts are joined with `.`, not Rails' `--`. base64url includes `-`, so a
 *     payload can contain `--` by chance and split into the wrong number of
 *     parts. `.` is outside the base64url alphabet, which is why JWT uses it.
 *
 * Everything is built on `node:crypto`, which Bun implements natively.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Raised when a message fails its signature or cannot be decrypted. */
export class InvalidSignature extends Error {
  constructor(message = "Message signature is invalid") {
    super(message);
    this.name = "InvalidSignature";
  }
}

/**
 * Derives a key for a purpose from a secret.
 *
 * Rails' KeyGenerator, with the same defaults: PBKDF2-HMAC-SHA256, 2^16
 * iterations. Two purposes derived from one secret cannot be used against each
 * other.
 */
export class KeyGenerator {
  constructor(
    private readonly secret: string,
    private readonly iterations = 65_536,
  ) {}

  generate(salt: string, length = 32): Buffer {
    return pbkdf2Sync(this.secret, salt, this.iterations, length, "sha256");
  }
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * Separates the parts of a message.
 *
 * Not `--`: base64url's alphabet contains `-`, so roughly one message in fifty
 * happens to contain `--` and splits into the wrong number of parts. That
 * failure is silent — the message simply does not verify — and shows up as a
 * session that occasionally vanishes.
 */
const SEPARATOR = ".";

/**
 * Signs a payload so tampering is detectable. The payload stays readable —
 * signing is not encryption.
 */
export class MessageVerifier {
  readonly #secret: Buffer;

  constructor(
    secret: string | Buffer,
    private readonly digest = "sha256",
  ) {
    this.#secret = Buffer.from(secret as string);
  }

  generate(value: unknown, purpose?: string): string {
    const payload = encode(JSON.stringify({ value, purpose: purpose ?? null }));
    return `${payload}${SEPARATOR}${this.#digestFor(payload)}`;
  }

  /** Returns the value, or null when the message is missing or tampered with. */
  verified<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    if (!message) return null;

    const parts = message.split(SEPARATOR);
    if (parts.length !== 2) return null;

    const [payload, signature] = parts as [string, string];

    if (!this.#matches(this.#digestFor(payload), signature)) return null;

    try {
      const parsed = JSON.parse(decode(payload).toString("utf8")) as {
        value: T;
        purpose: string | null;
      };
      // A message signed for one purpose must not be accepted for another.
      if ((parsed.purpose ?? undefined) !== purpose) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  /** Like `verified`, but throws instead of returning null. */
  verify<T = unknown>(message: string | null | undefined, purpose?: string): T {
    const value = this.verified<T>(message, purpose);
    if (value === null) throw new InvalidSignature();
    return value;
  }

  #digestFor(payload: string): string {
    return createHmac(this.digest, this.#secret).update(payload).digest("hex");
  }

  /**
   * Compares in constant time.
   *
   * `a === b` returns as soon as it finds a difference, which tells an attacker
   * how much of a forged signature was right.
   */
  #matches(expected: string, given: string): boolean {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(given, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * Encrypts and authenticates a payload.
 *
 * AES-256-GCM: the tag covers the ciphertext, so a modified payload fails to
 * decrypt rather than decrypting into something unexpected.
 */
export class MessageEncryptor {
  readonly #key: Buffer;

  constructor(key: Buffer | string) {
    const material = Buffer.from(key as string);
    if (material.length !== 32) {
      throw new Error(
        `AES-256-GCM needs a 32-byte key, got ${material.length}. Derive one with KeyGenerator.`,
      );
    }
    this.#key = material;
  }

  encrypt(value: unknown, purpose?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);

    const plaintext = JSON.stringify({ value, purpose: purpose ?? null });
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [encode(encrypted), encode(iv), encode(tag)].join(SEPARATOR);
  }

  /** Returns the value, or null when the message cannot be authenticated. */
  decrypt<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    if (!message) return null;

    const parts = message.split(SEPARATOR);
    if (parts.length !== 3) return null;

    try {
      const [payload, iv, tag] = parts as [string, string, string];
      const decipher = createDecipheriv("aes-256-gcm", this.#key, decode(iv));
      decipher.setAuthTag(decode(tag));

      const plaintext = Buffer.concat([
        decipher.update(decode(payload)),
        decipher.final(),
      ]).toString("utf8");

      const parsed = JSON.parse(plaintext) as { value: T; purpose: string | null };
      if ((parsed.purpose ?? undefined) !== purpose) return null;
      return parsed.value;
    } catch {
      // A failed tag check throws; that is the intended signal, not an error
      // worth surfacing, since it means the payload was tampered with.
      return null;
    }
  }
}

/**
 * The per-application secret and the verifiers derived from it.
 *
 * Rails calls this `secret_key_base`. One secret, many purpose-specific keys.
 */
export class Secrets {
  readonly #generator: KeyGenerator;
  readonly #verifiers = new Map<string, MessageVerifier>();
  readonly #encryptors = new Map<string, MessageEncryptor>();

  constructor(readonly secretKeyBase: string) {
    if (secretKeyBase.length < 32) {
      throw new Error("secretKeyBase must be at least 32 characters");
    }
    this.#generator = new KeyGenerator(secretKeyBase);
  }

  verifier(purpose: string): MessageVerifier {
    let verifier = this.#verifiers.get(purpose);
    if (!verifier) {
      verifier = new MessageVerifier(this.#generator.generate(`signed ${purpose}`));
      this.#verifiers.set(purpose, verifier);
    }
    return verifier;
  }

  encryptor(purpose: string): MessageEncryptor {
    let encryptor = this.#encryptors.get(purpose);
    if (!encryptor) {
      encryptor = new MessageEncryptor(this.#generator.generate(`encrypted ${purpose}`));
      this.#encryptors.set(purpose, encryptor);
    }
    return encryptor;
  }
}

/** A cryptographically random token, for CSRF and session identifiers. */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
