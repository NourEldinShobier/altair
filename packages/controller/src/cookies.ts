/**
 * Cookies, ported from `ActionDispatch::Cookies`.
 *
 * Rails exposes three jars over the same header: plain, signed and encrypted.
 * A signed cookie is readable but not forgeable; an encrypted one is neither.
 * Session data goes in the encrypted jar.
 *
 * Defaults lean secure — `httpOnly` and `sameSite: "lax"` unless overridden —
 * because the failure mode of a permissive default is a stolen session.
 */

import type { MessageEncryptor, MessageVerifier, Secrets } from "@altair/support";

export interface CookieOptions {
  path?: string;
  domain?: string;
  /** Seconds. Rails' `expires` accepts a duration; this is the header's value. */
  maxAge?: number;
  expires?: Date;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

interface CookieRecord extends CookieOptions {
  name: string;
  value: string;
  deleted?: boolean;
}

/** Parses a `Cookie` request header. */
export function parseCookieHeader(header: string | null): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) continue;

    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      // A malformed escape should not take down the request.
      jar[name] = value;
    }
  }
  return jar;
}

/** Raised when a cookie's name or attributes would write a different cookie. */
export class UnsafeCookie extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `Refusing to write a cookie whose ${field} is ${JSON.stringify(value)}: it would change what the header says.`,
    );
    this.name = "UnsafeCookie";
  }
}

/**
 * A cookie name, per RFC 6265: an HTTP token and nothing else.
 *
 * The characters left out are the ones that mean something in the header —
 * `;` separates cookies from attributes, `=` separates a name from a value —
 * so a name containing them stops being a name.
 */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/;

/**
 * Refuses a name or attribute that would write a cookie other than the one
 * asked for.
 *
 * The value needs no guarding: it is percent-encoded, so a `;` in it stays a
 * `;` in it. The name is not, and a name of `sess=stolen; x` sets a cookie
 * called `sess` — any cookie, the session included, from a call that appears
 * to write something harmless. `path` and `domain` are interpolated too, and
 * a `;` in either does the same thing one attribute later.
 *
 * Refused rather than escaped: there is no encoding for a cookie name, and a
 * caller building one out of user input has a bug worth hearing about.
 */
export function assertCookieSafe(record: { name: string; path?: string; domain?: string }): void {
  if (!COOKIE_NAME.test(record.name)) throw new UnsafeCookie("name", record.name);

  assertAttributesSafe(record);
}

/**
 * The attributes alone, without a name to check.
 *
 * Separate because the defaults are attributes with no cookie attached, and
 * they reach the header by exactly the same interpolation.
 */
function assertAttributesSafe(record: { path?: string; domain?: string }): void {
  for (const [field, value] of [
    ["path", record.path],
    ["domain", record.domain],
  ] as const) {
    if (value === undefined) continue;
    if (ATTRIBUTE_BREAK.test(value)) throw new UnsafeCookie(field, value);
  }
}

const SAME_SITE: Record<string, string | undefined> = {
  strict: "Strict",
  lax: "Lax",
  none: "None",
};

/** A separator or a control character — either ends the attribute it is in. */
const ATTRIBUTE_BREAK = new RegExp(
  `[;,${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}]`,
);

/** Renders one `Set-Cookie` header value. */
export function serializeCookie(record: CookieRecord): string {
  // Checked here as well as at `set`, because this is the chokepoint every
  // outgoing cookie passes through however it was written.
  assertCookieSafe(record);

  const parts = [`${record.name}=${encodeURIComponent(record.value)}`];

  // The application's defaults fill in what this cookie did not say. A
  // `SameSite` set on eleven cookies and forgotten on the twelfth is a hole in
  // one place, and the twelfth is always the one added in a hurry.
  const applied = { ...defaults, ...stripUndefined(record) };

  // The merged attributes, not the record's own. A cookie that names no path
  // or domain — which is most of them — is written with the defaults, and
  // checking only what the caller passed left those unread: a domain of
  // `example.com; SameSite=None` put a second `SameSite` in front of the
  // intended one, and a browser takes the first. Every cookie in the
  // application would have lost its CSRF protection from one line of config.
  assertAttributesSafe(applied);

  parts.push(`Path=${applied.path ?? "/"}`);
  if (applied.domain) parts.push(`Domain=${applied.domain}`);
  if (record.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(record.maxAge)}`);
  if (record.expires) parts.push(`Expires=${record.expires.toUTCString()}`);
  if (applied.secure) parts.push("Secure");
  if (applied.httpOnly !== false) parts.push("HttpOnly");

  // Read from a table rather than capitalised in place. The type says this is
  // one of three words and a JavaScript caller is not bound by the type, so
  // the value that reaches the header is one this file chose either way.
  const sameSite = SAME_SITE[applied.sameSite ?? "lax"];

  if (sameSite === undefined) throw new UnsafeCookie("sameSite", String(applied.sameSite));

  parts.push(`SameSite=${sameSite}`);

  return parts.join("; ");
}

/** A jar that signs or encrypts on the way out and verifies on the way in. */
export class SecureJar {
  constructor(
    private readonly jar: CookieJar,
    private readonly read: (value: string, purpose: string) => unknown,
    private readonly write: (value: unknown, purpose: string) => string,
  ) {}

  get<T = unknown>(name: string): T | null {
    const raw = this.jar.get(name);
    if (raw === undefined) return null;
    // The cookie name is the purpose, so a value lifted from one cookie into
    // another fails to verify.
    return (this.read(raw, `cookie.${name}`) as T) ?? null;
  }

  set(name: string, value: unknown, options: CookieOptions = {}): void {
    this.jar.set(name, this.write(value, `cookie.${name}`), options);
  }

  delete(name: string, options: CookieOptions = {}): void {
    this.jar.delete(name, options);
  }
}

/**
 * How cookies are written across an application, ported from Rails'
 * `config.action_dispatch.cookies_*` settings.
 *
 * Defaults rather than options on every call: a `SameSite` set on eleven
 * cookies and forgotten on the twelfth is a CSRF hole in one place, and the
 * twelfth is always the one somebody added in a hurry.
 */
export interface CookieDefaults {
  sameSite?: "strict" | "lax" | "none";
  secure?: boolean;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
}

let defaults: CookieDefaults = { sameSite: "lax", httpOnly: true, path: "/" };

/** Rails' `cookies_same_site_protection` and the settings beside it. */
export function configureCookies(options: CookieDefaults): void {
  // Checked here as well, because this is where the mistake is made and where
  // the error can name it. `serializeCookie` checks again on the way out,
  // which is what makes the guarantee hold however a default was set.
  assertAttributesSafe(options);

  defaults = { ...defaults, ...options };
}

/** Only the keys a cookie actually set, so a default is not overwritten by undefined. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, one]) => one !== undefined),
  ) as Partial<T>;
}

export function cookieDefaults(): CookieDefaults {
  return { ...defaults };
}

export function resetCookieDefaults(): void {
  defaults = { sameSite: "lax", httpOnly: true, path: "/" };
}

/**
 * Older secrets a signed or encrypted cookie will still be read with. Rails'
 * `cookies_rotations`.
 *
 * The same reason the message verifier has them: a cookie signed with the old
 * secret is still in a browser, and a deploy that only knows the new one signs
 * everybody out at once.
 */
const rotations: string[] = [];

export function rotateCookieSecret(secret: string): void {
  if (!rotations.includes(secret)) rotations.push(secret);
}

export function cookieRotations(): readonly string[] {
  return rotations;
}

export function clearCookieRotations(): void {
  rotations.length = 0;
}

export class CookieJar {
  readonly #incoming: Record<string, string>;
  readonly #outgoing = new Map<string, CookieRecord>();
  readonly #secrets: Secrets | undefined;
  /** Older secrets a cookie may still have been written with. */
  readonly #rotations: Secrets[] = [];

  constructor(request: Request, secrets?: Secrets, rotations: readonly Secrets[] = []) {
    this.#incoming = parseCookieHeader(request.headers.get("cookie"));
    this.#secrets = secrets;
    this.#rotations = [...rotations];
  }

  /**
   * Accepts cookies written with an older secret. Rails' `cookies_rotations`.
   *
   * What makes changing `secret_key_base` possible at all. Every signed and
   * encrypted cookie in every browser was written with the old one, so a
   * deploy that only knows the new secret signs every session out at once —
   * which looks to a user like the application logging them out for no reason,
   * and to an operator like a login storm.
   *
   * Reading only. Anything written goes out under the current secret, so a
   * rotation empties itself as people come back: every cookie read under an
   * old secret is rewritten under the new one, and the old secret can be
   * dropped once the longest cookie lifetime has passed.
   */
  rotate(secrets: Secrets): this {
    this.#rotations.push(secrets);

    return this;
  }

  /** The older secrets currently accepted. */
  get rotations(): readonly Secrets[] {
    return this.#rotations;
  }

  /** The value a client sent, or one set during this request. */
  get(name: string): string | undefined {
    const pending = this.#outgoing.get(name);
    if (pending) return pending.deleted ? undefined : pending.value;
    return this.#incoming[name];
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    assertCookieSafe({ name, ...options });

    this.#outgoing.set(name, { name, value, ...options });
  }

  /** Expires a cookie by setting it empty and dated in the past. */
  delete(name: string, options: CookieOptions = {}): void {
    this.#outgoing.set(name, {
      name,
      value: "",
      ...options,
      expires: new Date(0),
      maxAge: 0,
      deleted: true,
    });
  }

  /** Readable by the client, but not forgeable. */
  get signed(): SecureJar {
    const verifier = this.#requireSecrets().verifier("cookie") as MessageVerifier;
    const older = this.#rotations.map((one) => one.verifier("cookie") as MessageVerifier);

    return new SecureJar(
      this,
      (value, purpose) => {
        const current = verifier.verified(value, purpose);

        if (current !== null) return current;

        // Only after the current secret has failed, so the common path costs
        // nothing and a rotation is not a way to make every request slower.
        for (const one of older) {
          const value_ = one.verified(value, purpose);

          if (value_ !== null) return value_;
        }

        return null;
      },
      // Written under the current secret whatever it was read with, so a
      // rotation drains itself rather than needing a second deploy to finish.
      (value, purpose) => verifier.generate(value, purpose),
    );
  }

  /** Opaque to the client and not forgeable. */
  get encrypted(): SecureJar {
    const encryptor = this.#requireSecrets().encryptor("cookie") as MessageEncryptor;
    const older = this.#rotations.map((one) => one.encryptor("cookie") as MessageEncryptor);

    return new SecureJar(
      this,
      (value, purpose) => {
        const current = encryptor.decrypt(value, purpose);

        if (current !== null) return current;

        for (const one of older) {
          const value_ = one.decrypt(value, purpose);

          if (value_ !== null) return value_;
        }

        return null;
      },
      (value, purpose) => encryptor.encrypt(value, purpose),
    );
  }

  #requireSecrets(): Secrets {
    if (!this.#secrets) {
      throw new Error(
        "Signed and encrypted cookies need secrets. Pass `secrets` in the controller context.",
      );
    }
    return this.#secrets;
  }

  /** The `Set-Cookie` values for everything written during this request. */
  toHeaders(): string[] {
    return [...this.#outgoing.values()].map((record) => serializeCookie(record));
  }

  /** Copies the pending cookies onto a response. */
  applyTo(response: Response): Response {
    const headers = this.toHeaders();
    if (headers.length === 0) return response;

    // Response headers are immutable once constructed, so this rebuilds rather
    // than mutating. `append` matters: several Set-Cookie headers are legal and
    // `set` would keep only the last.
    const merged = new Headers(response.headers);
    for (const header of headers) merged.append("set-cookie", header);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  }
}
