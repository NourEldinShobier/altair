/**
 * How a signed or encrypted cookie is actually produced. Ported from the
 * `ActionDispatch::Cookies` configuration — the salts, the cipher, the digest,
 * the serializer and the metadata envelope.
 *
 * `cookies.ts` has the jars and the secret rotation. What it does not have is
 * the set of choices underneath them, and every one of these has a failure
 * mode that is either "everybody is logged out" or "a cookie can be forged".
 *
 * **The salts are why one secret can be used for several purposes.** A signed
 * cookie and an encrypted cookie derive different keys from the same
 * `secretKeyBase`, because deriving the same key would mean a value signed for
 * one purpose is valid for the other — and the session cookie is one of those
 * purposes.
 *
 * **The metadata envelope is what makes a purpose enforceable.** Without it a
 * signed cookie is a signed blob: valid is valid, and a value lifted out of a
 * `remember_me` cookie can be pasted into the session cookie, since both carry
 * the same signature from the same key. With it, the purpose and the expiry
 * are inside the signed payload, so a cookie is only valid where it was meant
 * to be used and only until it was meant to expire.
 *
 * The defaults here are Rails' current ones, not its historical ones. The
 * older settings exist as options because an application with cookies already
 * in browsers cannot change them without signing everybody out — but a new one
 * should never start on them.
 */

/** How a signed cookie is signed. */
export type CookieDigest = "SHA256" | "SHA1";

/** How an encrypted cookie is encrypted. */
export type CookieCipher = "aes-256-gcm" | "aes-256-cbc";

export interface CookieCryptoConfig {
  /**
   * The salt for signed cookies.
   *
   * A different string from the one below, so the two derive different keys.
   */
  signedCookieSalt: string;
  /** The salt for encrypted cookies, when the cipher does not authenticate. */
  encryptedCookieSalt: string;
  /** The salt for the signature over an encrypted cookie. */
  encryptedSignedCookieSalt: string;
  /** The salt for an authenticated cipher, which needs only one. */
  authenticatedEncryptedCookieSalt: string;
  /** The salt for HTTP auth tokens, which are not cookies but share the secret. */
  httpAuthSalt: string;
  signedCookieDigest: CookieDigest;
  encryptedCookieCipher: CookieCipher;
  /**
   * Whether an encrypted cookie uses a cipher that authenticates its own
   * ciphertext. Rails' `use_authenticated_cookie_encryption`.
   *
   * On means AES-GCM, which detects tampering as part of decrypting. Off means
   * AES-CBC plus a separate signature — which works, and is two operations
   * that can disagree, and was the source of the padding-oracle class of bug
   * that authenticated ciphers exist to end.
   */
  useAuthenticatedCookieEncryption: boolean;
  /**
   * Whether the purpose and expiry travel inside the signed payload. Rails'
   * `use_cookies_with_metadata`.
   *
   * Off, a signed cookie is a signed blob and any of them is valid anywhere
   * another is — so a value from one cookie can be pasted into another.
   */
  useCookiesWithMetadata: boolean;
  /** How the value is turned into bytes. Rails' `cookies_serializer`. */
  cookiesSerializer: CookieSerializerName;
  /** Rails' `cookies_same_site_protection`. */
  cookiesSameSiteProtection: "strict" | "lax" | "none";
}

export type CookieSerializerName = "json" | "marshal" | "hybrid";

const DEFAULTS: CookieCryptoConfig = {
  signedCookieSalt: "signed cookie",
  encryptedCookieSalt: "encrypted cookie",
  encryptedSignedCookieSalt: "signed encrypted cookie",
  authenticatedEncryptedCookieSalt: "authenticated encrypted cookie",
  httpAuthSalt: "http authentication",
  signedCookieDigest: "SHA256",
  encryptedCookieCipher: "aes-256-gcm",
  useAuthenticatedCookieEncryption: true,
  useCookiesWithMetadata: true,
  cookiesSerializer: "json",
  cookiesSameSiteProtection: "lax",
};

let config: CookieCryptoConfig = { ...DEFAULTS };

export function cookieCryptoConfig(): CookieCryptoConfig {
  return { ...config };
}

export function configureCookieCrypto(options: Partial<CookieCryptoConfig>): void {
  config = { ...config, ...options };
}

export function resetCookieCrypto(): void {
  config = { ...DEFAULTS };
}

// Each of these is a reader rather than a property access so a caller reads
// the setting at the moment it is used, not at the moment it imported.

export function signedCookieSalt(): string {
  return config.signedCookieSalt;
}

export function encryptedCookieSalt(): string {
  return config.encryptedCookieSalt;
}

export function encryptedSignedCookieSalt(): string {
  return config.encryptedSignedCookieSalt;
}

export function authenticatedEncryptedCookieSalt(): string {
  return config.authenticatedEncryptedCookieSalt;
}

export function httpAuthSalt(): string {
  return config.httpAuthSalt;
}

export function signedCookieDigest(): CookieDigest {
  return config.signedCookieDigest;
}

export function encryptedCookieCipher(): CookieCipher {
  return config.encryptedCookieCipher;
}

export function useAuthenticatedCookieEncryption(): boolean {
  return config.useAuthenticatedCookieEncryption;
}

export function useCookiesWithMetadata(): boolean {
  return config.useCookiesWithMetadata;
}

export function cookiesSerializer(): CookieSerializerName {
  return config.cookiesSerializer;
}

export function cookiesSameSiteProtection(): "strict" | "lax" | "none" {
  return config.cookiesSameSiteProtection;
}

/**
 * Every salt in use, so a check can assert they are all different.
 *
 * Two purposes sharing a salt share a key, which means a value signed for one
 * is valid for the other — and one of the purposes is the session.
 */
export function cookieSalts(): string[] {
  return [
    config.signedCookieSalt,
    config.encryptedCookieSalt,
    config.encryptedSignedCookieSalt,
    config.authenticatedEncryptedCookieSalt,
    config.httpAuthSalt,
  ];
}

export function saltsAreDistinct(): boolean {
  const salts = cookieSalts();

  return new Set(salts).size === salts.length;
}

/** What a cookie carries when metadata is on. */
export interface CookieEnvelope {
  /** The value itself. */
  _rails: { message: unknown; exp: string | null; pur: string | null };
}

/**
 * Wraps a value with what it is for and when it stops being valid.
 *
 * Inside the signed payload rather than beside it — beside it would mean an
 * attacker can change the purpose without invalidating the signature, which is
 * the same as not having one.
 */
export function wrapWithMetadata(
  value: unknown,
  purpose: string | null,
  expiresAt: Date | null,
): CookieEnvelope | unknown {
  if (!config.useCookiesWithMetadata) return value;

  return {
    _rails: {
      message: value,
      exp: expiresAt === null ? null : expiresAt.toISOString(),
      pur: purpose,
    },
  } satisfies CookieEnvelope;
}

/** Raised when a cookie is valid but not valid *here*. */
export class InvalidCookiePurpose extends Error {
  constructor(expected: string | null, found: string | null) {
    super(
      `This cookie was signed for ${found === null ? "no particular purpose" : `"${found}"`}, ` +
        `but is being read as ${expected === null ? "unscoped" : `"${expected}"`}. ` +
        `A cookie is only valid where it was meant to be used.`,
    );
    this.name = "InvalidCookiePurpose";
  }
}

export class ExpiredCookie extends Error {
  constructor() {
    super("This cookie has expired.");
    this.name = "ExpiredCookie";
  }
}

/**
 * Takes the value back out, checking what the envelope says. Rails'
 * `verify_and_upgrade`-adjacent behaviour.
 *
 * An unwrapped value is accepted when metadata is off, and also when it is on
 * — because turning it on has to not sign out everybody holding a cookie
 * written before the change. What it must not do is accept a *wrongly
 * purposed* envelope, which is a different thing from an absent one.
 */
export function unwrapMetadata(
  value: unknown,
  purpose: string | null = null,
  now: Date = new Date(),
): unknown {
  if (!isEnvelope(value)) return value;

  const { message, exp, pur } = value._rails;

  if (pur !== purpose) throw new InvalidCookiePurpose(purpose, pur);
  if (exp !== null && new Date(exp).getTime() <= now.getTime()) throw new ExpiredCookie();

  return message;
}

function isEnvelope(value: unknown): value is CookieEnvelope {
  if (typeof value !== "object" || value === null || !("_rails" in value)) return false;

  const inner = (value as CookieEnvelope)._rails;

  return typeof inner === "object" && inner !== null && "message" in inner;
}

/**
 * Whether a jar signs, encrypts, or both. Rails' `signed_or_encrypted`.
 *
 * Encrypted implies signed when the cipher authenticates, which is why the
 * modern setting needs one salt where the old one needed two.
 */
export function signedOrEncrypted(jar: "signed" | "encrypted"): {
  signs: boolean;
  encrypts: boolean;
  salt: string;
} {
  if (jar === "signed") {
    return { signs: true, encrypts: false, salt: config.signedCookieSalt };
  }

  return {
    signs: !config.useAuthenticatedCookieEncryption,
    encrypts: true,
    salt: config.useAuthenticatedCookieEncryption
      ? config.authenticatedEncryptedCookieSalt
      : config.encryptedCookieSalt,
  };
}

/**
 * Which jar a cookie name has been written to, so the response can be built
 * once. Rails' `commit_cookie_jar!` and `update_cookies_from_jar`.
 */
export interface CookieJarChanges {
  set: Map<string, string>;
  deleted: Set<string>;
}

export function haveCookieJar(changes: CookieJarChanges | undefined): boolean {
  return changes !== undefined && (changes.set.size > 0 || changes.deleted.size > 0);
}

/**
 * Folds a jar's changes into the headers.
 *
 * A deletion wins over a set of the same name. Both in one response is a
 * mistake either way, and expiring the cookie is the safe reading of it —
 * leaving a stale value in the browser is how a signed-out session comes back.
 */
export function commitCookieJar(changes: CookieJarChanges): string[] {
  const headers: string[] = [];

  for (const [name, serialized] of changes.set) {
    if (changes.deleted.has(name)) continue;

    headers.push(serialized);
  }

  for (const name of changes.deleted) {
    headers.push(`${name}=; Max-Age=0; Path=/`);
  }

  return headers;
}

/** Applies what a jar recorded onto an existing set of cookies. */
export function updateCookiesFromJar(
  current: Record<string, string>,
  changes: CookieJarChanges,
): Record<string, string> {
  const updated = { ...current };

  for (const [name, value] of changes.set) updated[name] = value;
  for (const name of changes.deleted) delete updated[name];

  return updated;
}
