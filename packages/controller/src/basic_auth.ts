/**
 * HTTP Basic authentication, ported from
 * `ActionController::HttpAuthentication::Basic`.
 *
 *     if (!this.authenticateOrRequest((name, password) => name === "admin" && ...)) return
 *
 * Not for a real login — the credentials travel on every request and a browser
 * gives no way to log out — but exactly right for the things it is still used
 * for: an internal dashboard, a staging site, a metrics endpoint behind a
 * password nobody needs to remember.
 */

import { timingSafeEqual } from "node:crypto";

export interface Credentials {
  name: string;
  password: string;
}

/**
 * Reads the header, or nothing.
 *
 * A password may contain a colon; a username may not, which is why the split
 * is on the first one and not the last. Splitting the other way lets someone
 * with a colon in their password log in as a different account.
 */
export function decodeBasic(header: string | null): Credentials | undefined {
  if (!header) return undefined;

  const [scheme, encoded] = header.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;

  return { name: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Compares two secrets without leaking how far they matched.
 *
 * `===` returns as soon as two bytes differ, so the time it takes says how
 * much of the guess was right — which is enough to find a password one
 * character at a time over enough requests. Hashing first makes both sides the
 * same length, since `timingSafeEqual` refuses to compare buffers that are
 * not, and the length of a secret is itself something not worth leaking.
 */
export function secretsMatch(given: string, expected: string): boolean {
  const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

/** Checks a name and password against fixed values, in constant time. */
export function credentialsMatch(given: Credentials, expected: Credentials): boolean {
  // Both are always compared, rather than short-circuiting on the name: which
  // half failed is not something to time either.
  const name = secretsMatch(given.name, expected.name);
  const password = secretsMatch(given.password, expected.password);

  return name && password;
}

/** The 401 that makes a browser ask. */
export function requestAuthentication(realm = "Application"): Response {
  // The realm is quoted and appears in the browser's prompt, so a quote in it
  // would end the parameter early.
  const safe = realm.replaceAll('"', "");

  return new Response("HTTP Basic: Access denied.\n", {
    status: 401,
    headers: {
      "www-authenticate": `Basic realm="${safe}", charset="UTF-8"`,
      "cache-control": "no-store",
    },
  });
}
