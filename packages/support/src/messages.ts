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
 * The cipher an encryptor uses. Rails' `MessageEncryptor.default_cipher`.
 *
 * Named rather than written at each call site because it is the thing that
 * changes: an application rotating to a new cipher has to be able to say which
 * one the old messages used, and a literal repeated in three places cannot.
 */
export const DEFAULT_CIPHER = "aes-256-gcm";

export function defaultCipher(): string {
  return DEFAULT_CIPHER;
}

/**
 * The key length a cipher needs, in bytes. Rails' `MessageEncryptor.key_len`.
 *
 * Read out of the name rather than tabulated, because the name is where the
 * number comes from: `aes-256-gcm` takes 256 bits. A table would be a second
 * place to update, and getting it wrong means deriving a key of the wrong
 * length — which fails at encryption time, in a deploy, and not in a test.
 */
export function keyLen(cipher: string = defaultCipher()): number {
  const bits = /^aes-(\d+)-/.exec(cipher)?.[1];

  if (bits === undefined) throw new Error(`Unknown cipher ${JSON.stringify(cipher)}.`);

  return Number(bits) / 8;
}

/**
 * How long a key file's contents must be. Rails'
 * `EncryptedFile.expected_key_length`.
 *
 * Twice the key length, because the file holds hex. Checking it when the key is
 * read is what turns "this file has a stray newline" into a message about the
 * key rather than a decryption failure against every encrypted file.
 */
export function expectedKeyLength(cipher: string = defaultCipher()): number {
  return keyLen(cipher) * 2;
}

/**
 * Signs a payload so tampering is detectable. The payload stays readable —
 * signing is not encryption.
 */
/**
 * How long a message is good for. Rails' `expires_in` / `expires_at`.
 *
 * Worth setting on anything that travels: a signed download link, a password
 * reset, a confirmation token. A signature says who made the message and says
 * nothing about when, so without an expiry a token that turns up in a log, a
 * referrer header, or somebody's browser history stays valid for as long as
 * the secret does — which is normally the life of the application.
 */
export interface MessageOptions {
  /** What this message is for. A message signed for one purpose is not another. */
  purpose?: string;
  /** Milliseconds from now. */
  expiresIn?: number;
  /** A specific moment. Wins over `expiresIn` if both are given. */
  expiresAt?: Date;
}

/** Callers may still pass a bare purpose, which is what most of them want. */
export type MessageOptionsOrPurpose = string | MessageOptions | undefined;

function optionsFor(given: MessageOptionsOrPurpose): MessageOptions {
  if (given === undefined) return {};

  return typeof given === "string" ? { purpose: given } : given;
}

/** When a message stops being good, as epoch milliseconds, or null for never. */
function expiryFor(options: MessageOptions): number | null {
  if (options.expiresAt !== undefined) return options.expiresAt.getTime();
  if (options.expiresIn !== undefined) return Date.now() + options.expiresIn;

  return null;
}

/** The envelope both classes put around a value. */
interface Envelope<T> {
  value: T;
  purpose: string | null;
  /** Absent on a message with no expiry, so old messages still parse. */
  exp?: number;
}

/**
 * Whether an envelope is still acceptable for this purpose and this moment.
 *
 * Checked after the signature rather than before, so an attacker learns
 * nothing from how long the answer took: an expired-but-valid message and a
 * forged one both come back as null having done the same work.
 */
function envelopeAccepted(
  envelope: { purpose: string | null; exp?: number },
  purpose?: string,
): boolean {
  if ((envelope.purpose ?? undefined) !== purpose) return false;

  return envelope.exp === undefined || envelope.exp > Date.now();
}

export class MessageVerifier {
  readonly #secret: Buffer;

  constructor(
    secret: string | Buffer,
    private readonly digest = "sha256",
  ) {
    this.#secret = Buffer.from(secret as string);
  }

  generate(value: unknown, options?: MessageOptionsOrPurpose): string {
    return this.createMessage(value, options);
  }

  /**
   * The message this verifier makes. Rails' `create_message`.
   *
   * Its own method because it is the seam rotation is defined against: a
   * rotation reads with an older secret and never writes with one, so having
   * exactly one place that writes is what makes that statement checkable.
   */
  createMessage(value: unknown, options?: MessageOptionsOrPurpose): string {
    const resolved = optionsFor(options);
    const expiry = expiryFor(resolved);
    const envelope: Envelope<unknown> = {
      value,
      purpose: resolved.purpose ?? null,
      // Left off entirely when there is none, so a message generated before
      // expiries existed still parses and a message with none is not one
      // claiming to expire at the epoch.
      ...(expiry === null ? {} : { exp: expiry }),
    };
    const payload = encode(JSON.stringify(envelope));

    return `${payload}${SEPARATOR}${this.#digestFor(payload)}`;
  }

  /**
   * Older secrets this verifier will still accept. Rails' `rotate`.
   *
   * What makes changing a secret possible at all. A cookie signed with the old
   * one is still in a browser, and a deploy that only knows the new secret
   * signs everybody out — so the new secret signs, and the old ones are tried
   * when the new one does not match.
   *
   * They are tried in the order given, so the most recent goes first.
   */
  #rotations: MessageVerifier[] = [];

  rotate(secret: string | Buffer, digest = "sha256"): this {
    this.#rotations.push(new MessageVerifier(secret, digest));

    return this;
  }

  /**
   * Accept messages made with the library's default digest. Rails'
   * `rotate_defaults`.
   *
   * For a verifier constructed with a digest of its own: the messages already
   * in browsers were signed with the default, and without this the day the
   * digest changes is the day every session ends. It rotates to the *same*
   * secret, because the secret did not change — only how it was applied.
   */
  rotateDefaults(): this {
    if (this.digest !== "sha256") this.rotate(this.#secret, "sha256");

    return this;
  }

  #onRotationCallback: (() => void) | undefined;

  /**
   * Called when a message was read by an older secret. Rails' `on_rotation`.
   *
   * The only way to know whether a secret can be retired. Without it the
   * question "is anything still using the old key" has no answer, so either the
   * old key is kept for ever — which is the same as not having rotated — or it
   * is dropped on a guess and some fraction of visitors is signed out.
   */
  onRotation(callback: () => void): this {
    this.#onRotationCallback = callback;

    return this;
  }

  /** Forgets the older secrets. For a test, and for the day one is retired. */
  clearRotations(): this {
    this.#rotations = [];

    return this;
  }

  /** Returns the value, or null when the message is missing or tampered with. */
  verified<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    return this.readMessage<T>(message, purpose);
  }

  /**
   * Rails' `read_message` — the read that knows about rotations.
   *
   * Older secrets are tried only after the current one has failed, so the
   * common path costs nothing and rotating is not a way to make every request
   * slower.
   */
  readMessage<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    const current = this.#verifiedWith<T>(message, purpose);
    if (current !== null) return current;

    for (const older of this.#rotations) {
      const value = older.readMessage<T>(message, purpose);

      if (value !== null) {
        this.#onRotationCallback?.();

        return value;
      }
    }

    return null;
  }

  /**
   * Whether the signature is this verifier's. Rails' `valid_message?`.
   *
   * The signature alone: no purpose, no expiry, nothing deserialised. It
   * answers "did we make this" for a message that is going to be rejected
   * anyway, which is what separates "somebody is forging messages" from "this
   * link is three months old" in a log.
   */
  validMessage(message: string | null | undefined): boolean {
    if (!message) return false;

    const parts = message.split(SEPARATOR);
    if (parts.length !== 2) return false;

    const [payload, signature] = parts as [string, string];

    return this.#matches(this.#digestFor(payload), signature);
  }

  #verifiedWith<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    if (!message) return null;

    const parts = message.split(SEPARATOR);
    if (parts.length !== 2) return null;

    const [payload, signature] = parts as [string, string];

    if (!this.#matches(this.#digestFor(payload), signature)) return null;

    try {
      const parsed = JSON.parse(decode(payload).toString("utf8")) as Envelope<T>;

      // A message signed for one purpose must not be accepted for another, and
      // one that has run out is no longer a message.
      if (!envelopeAccepted(parsed, purpose)) return null;

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
    if (material.length !== keyLen()) {
      throw new Error(
        `${DEFAULT_CIPHER} needs a ${keyLen()}-byte key, got ${material.length}. ` +
          `Derive one with KeyGenerator.`,
      );
    }
    this.#key = material;
  }

  /**
   * Older keys this encryptor will still read. Rails' `rotate`.
   *
   * The same reason the verifier has them: an encrypted cookie signed with the
   * old key is still in somebody's browser, and a deploy that only knows the
   * new key logs everybody out. The new key encrypts; the old ones are tried
   * only when the new one fails to authenticate.
   */
  #rotations: MessageEncryptor[] = [];

  rotate(key: Buffer | string): this {
    this.#rotations.push(new MessageEncryptor(key));

    return this;
  }

  /** Forgets the older keys. For a test, and for the day one is retired. */
  clearRotations(): this {
    this.#rotations = [];

    return this;
  }

  encrypt(value: unknown, options?: MessageOptionsOrPurpose): string {
    return this.createMessage(value, options);
  }

  /**
   * The message this encryptor makes. Rails' `create_message`.
   *
   * The single place a message is written, which is what lets "a rotation only
   * ever reads" be a fact about the code rather than a convention.
   */
  createMessage(value: unknown, options?: MessageOptionsOrPurpose): string {
    const resolved = optionsFor(options);
    const expiry = expiryFor(resolved);
    const iv = randomBytes(12);
    const cipher = createCipheriv(DEFAULT_CIPHER, this.#key, iv);

    const plaintext = JSON.stringify({
      value,
      purpose: resolved.purpose ?? null,
      ...(expiry === null ? {} : { exp: expiry }),
    });
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [encode(encrypted), encode(iv), encode(tag)].join(SEPARATOR);
  }

  #onRotationCallback: (() => void) | undefined;

  /**
   * Called when a message was read by an older key. Rails' `on_rotation`.
   *
   * The same reason the verifier has it: without a signal, an old key is either
   * kept for ever — which is the same as not having rotated — or dropped on a
   * guess, and the guess costs some fraction of visitors their session.
   */
  onRotation(callback: () => void): this {
    this.#onRotationCallback = callback;

    return this;
  }

  /** Returns the value, or null when the message cannot be authenticated. */
  decrypt<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    return this.readMessage<T>(message, purpose);
  }

  /**
   * Rails' `read_message` — the read that knows about rotations.
   *
   * Older keys are tried only after the current one has failed, so the common
   * path costs nothing and rotating is not a way to make every request slower.
   */
  readMessage<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    const current = this.#decryptWith<T>(message, purpose);

    if (current !== null) return current;

    for (const older of this.#rotations) {
      const value = older.readMessage<T>(message, purpose);

      if (value !== null) {
        this.#onRotationCallback?.();

        return value;
      }
    }

    return null;
  }

  #decryptWith<T = unknown>(message: string | null | undefined, purpose?: string): T | null {
    if (!message) return null;

    const parts = message.split(SEPARATOR);
    if (parts.length !== 3) return null;

    try {
      const [payload, iv, tag] = parts as [string, string, string];
      const decipher = createDecipheriv(DEFAULT_CIPHER, this.#key, decode(iv));
      decipher.setAuthTag(decode(tag));

      const plaintext = Buffer.concat([
        decipher.update(decode(payload)),
        decipher.final(),
      ]).toString("utf8");

      const parsed = JSON.parse(plaintext) as Envelope<T>;

      if (!envelopeAccepted(parsed, purpose)) return null;

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
