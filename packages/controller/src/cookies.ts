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

  for (const [field, value] of [
    ["path", record.path],
    ["domain", record.domain],
  ] as const) {
    if (value === undefined) continue;
    if (ATTRIBUTE_BREAK.test(value)) throw new UnsafeCookie(field, value);
  }
}

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

  parts.push(`Path=${record.path ?? "/"}`);
  if (record.domain) parts.push(`Domain=${record.domain}`);
  if (record.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(record.maxAge)}`);
  if (record.expires) parts.push(`Expires=${record.expires.toUTCString()}`);
  if (record.secure) parts.push("Secure");
  if (record.httpOnly !== false) parts.push("HttpOnly");

  const sameSite = record.sameSite ?? "lax";
  parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);

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

export class CookieJar {
  readonly #incoming: Record<string, string>;
  readonly #outgoing = new Map<string, CookieRecord>();
  readonly #secrets: Secrets | undefined;

  constructor(request: Request, secrets?: Secrets) {
    this.#incoming = parseCookieHeader(request.headers.get("cookie"));
    this.#secrets = secrets;
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
    const verifier = this.#requireSecrets().verifier("cookie");
    return new SecureJar(
      this,
      (value, purpose) => (verifier as MessageVerifier).verified(value, purpose),
      (value, purpose) => (verifier as MessageVerifier).generate(value, purpose),
    );
  }

  /** Opaque to the client and not forgeable. */
  get encrypted(): SecureJar {
    const encryptor = this.#requireSecrets().encryptor("cookie");
    return new SecureJar(
      this,
      (value, purpose) => (encryptor as MessageEncryptor).decrypt(value, purpose),
      (value, purpose) => (encryptor as MessageEncryptor).encrypt(value, purpose),
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
