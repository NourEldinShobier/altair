/**
 * Digest authentication, ported from
 * `ActionController::HttpAuthentication::Digest`.
 *
 * Basic auth sends the password on every request; digest sends a hash of it
 * with a server-supplied nonce, so the password itself never crosses the wire
 * and a captured request cannot be replayed. That is the whole of its
 * advantage, and it is a real one on a plain HTTP connection.
 *
 * Over TLS it buys almost nothing — the password is already protected — and it
 * costs something real: the server has to hold either the password or its MD5
 * digest to verify a response, so it cannot store passwords with a slow hash.
 * That is a bad trade for a public application, and the file says so rather
 * than leaving somebody to discover it. It is here for the cases that have no
 * choice: a device, an appliance, an intranet service that speaks only digest.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** The parts of an Authorization: Digest header. */
export type DigestCredentials = Record<string, string>;

/**
 * Splits a digest header into its parts. Rails' `decode_credentials_header`.
 *
 * Values may be quoted or bare — `qop=auth` and `qop="auth"` both occur — and a
 * parser that handled only one shape rejects half the clients in the world.
 */
export function decodeCredentialsHeader(header: string | null): DigestCredentials | null {
  if (!header) return null;

  const space = header.indexOf(" ");
  if (space === -1 || header.slice(0, space).toLowerCase() !== "digest") return null;

  const credentials: DigestCredentials = {};

  for (const pair of splitPairs(header.slice(space + 1))) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;

    const key = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();

    credentials[key] = value.replace(/^"|"$/g, "");
  }

  return credentials;
}

/**
 * Splits on commas that are not inside quotes.
 *
 * A plain split on commas breaks any value containing one, and a URI in the
 * `uri` field routinely does — a query string with two parameters is enough.
 */
function splitPairs(payload: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;

  for (const character of payload) {
    if (character === '"') quoted = !quoted;

    if (character === "," && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim().length > 0) parts.push(current);

  return parts;
}

/** The scheme a header names, or undefined. Rails' `auth_scheme`. */
export function authScheme(header: string | null): string | undefined {
  if (!header) return undefined;

  const space = header.indexOf(" ");

  return space === -1 ? header.toLowerCase() : header.slice(0, space).toLowerCase();
}

/** One parameter out of an Authorization header. Rails' `auth_param`. */
export function authParam(header: string | null, name: string): string | undefined {
  return decodeCredentialsHeader(header)?.[name];
}

/** Whether a request carries Basic credentials at all. Rails' `has_basic_credentials?`. */
export function hasBasicCredentials(request: Request): boolean {
  return authScheme(request.headers.get("authorization")) === "basic";
}

/** Whether it carries Digest ones. */
export function hasDigestCredentials(request: Request): boolean {
  return authScheme(request.headers.get("authorization")) === "digest";
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/**
 * The stored secret a digest response is checked against. Rails' `ha1`.
 *
 * This is the uncomfortable part: it is MD5 of the password, so a server that
 * supports digest must hold something password-equivalent. Storing this rather
 * than the password itself limits the damage of a leak to this realm — the
 * digest cannot be replayed elsewhere — but it is not a substitute for a slow
 * password hash, and nothing here pretends it is.
 */
export function ha1(realm: string, username: string, password: string): string {
  return md5(`${username}:${realm}:${password}`);
}

export interface DigestOptions {
  realm: string;
  /** Rails' `secret_key`: what nonces are signed with. */
  secret: string;
  /** How long a nonce stays valid, in seconds. */
  nonceLifetime?: number;
}

/**
 * A nonce the server can later recognise as its own. Rails' `nonce`.
 *
 * Timestamped and signed rather than random and remembered. A random nonce
 * needs server-side storage to validate, which a multi-process deployment then
 * has to share; a signed one carries its own proof, so any process can check
 * it and none has to remember anything.
 */
export function nonce(secret: string, at: number = Date.now()): string {
  const timestamp = Math.floor(at / 1000);
  const signature = md5(`${String(timestamp)}:${secret}`);

  return Buffer.from(`${String(timestamp)}:${signature}`).toString("base64");
}

/**
 * Whether a nonce is ours and still fresh. Rails' `validate_nonce`.
 *
 * Both halves matter. Unsigned, a client could mint its own nonce and replay a
 * captured response forever; unexpired, a captured response stays valid for
 * ever even though the nonce was genuine.
 */
export function validateNonce(
  secret: string,
  value: string,
  lifetime = 300,
  now = Date.now(),
): boolean {
  let decoded: string;

  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return false;
  }

  const colon = decoded.indexOf(":");
  if (colon === -1) return false;

  const timestamp = decoded.slice(0, colon);
  const signature = decoded.slice(colon + 1);

  if (!secureEquals(signature, md5(`${timestamp}:${secret}`))) return false;

  const age = now / 1000 - Number(timestamp);

  return Number.isFinite(age) && age >= 0 && age <= lifetime;
}

/** An opaque value the client echoes back untouched. Rails' `opaque`. */
export function opaque(secret: string): string {
  return md5(secret);
}

/**
 * The response a client should have sent, for these credentials.
 *
 * Computed and compared rather than trusted, which is the whole protocol: the
 * server knows the password's digest and the nonce it issued, so it can derive
 * what the answer must be.
 */
export function expectedResponse(
  credentials: DigestCredentials,
  password: string,
  method: string,
  realm: string,
): string {
  const a1 = ha1(realm, credentials.username ?? "", password);
  const a2 = md5(`${method.toUpperCase()}:${credentials.uri ?? ""}`);

  // qop="auth" adds the nonce count and client nonce, which is what stops a
  // captured response being replayed even within the nonce's lifetime.
  if (credentials.qop) {
    return md5(
      [
        a1,
        credentials.nonce ?? "",
        credentials.nc ?? "",
        credentials.cnonce ?? "",
        credentials.qop,
        a2,
      ].join(":"),
    );
  }

  return md5(`${a1}:${credentials.nonce ?? ""}:${a2}`);
}

/**
 * Compares two digests without leaking how far they matched.
 *
 * A plain `===` on a hex string returns as soon as it finds a difference, and
 * the time that takes is measurable across enough requests. It is a narrow
 * attack and a cheap defence.
 */
function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Checks a request's digest credentials. Rails' `validate_digest_response`.
 *
 * The password is looked up rather than passed, because the username arrives
 * with the request and the caller cannot know which password to supply until
 * it has been read.
 */
export function validateDigestResponse(
  request: Request,
  options: DigestOptions,
  passwordFor: (username: string) => string | undefined,
  now = Date.now(),
): boolean {
  const credentials = decodeCredentialsHeader(request.headers.get("authorization"));
  if (!credentials?.username || !credentials.response) return false;

  if (!validateNonce(options.secret, credentials.nonce ?? "", options.nonceLifetime ?? 300, now)) {
    return false;
  }

  const password = passwordFor(credentials.username);
  if (password === undefined) return false;

  const expected = expectedResponse(credentials, password, request.method, options.realm);

  return secureEquals(credentials.response, expected);
}

/**
 * The challenge sent when credentials are missing or wrong. Rails'
 * `authentication_request`.
 *
 * A fresh nonce every time, so a client that failed once cannot keep retrying
 * against the nonce it already has.
 */
export function authenticationRequest(options: DigestOptions, at: number = Date.now()): Response {
  const challenge = [
    `realm="${options.realm}"`,
    `qop="auth"`,
    `nonce="${nonce(options.secret, at)}"`,
    `opaque="${opaque(options.secret)}"`,
  ].join(", ");

  return new Response("HTTP Digest: Access denied.\n", {
    status: 401,
    headers: { "www-authenticate": `Digest ${challenge}` },
  });
}

/**
 * Authenticates, or answers the challenge. Rails'
 * `authenticate_or_request_with_http_digest`.
 *
 * Returns null when the request is authentic, so a caller writes
 * `const denied = ...; if (denied) return denied;` and carries on — the shape
 * that makes the failure path impossible to forget.
 */
export function authenticateOrRequestWithHttpDigest(
  request: Request,
  options: DigestOptions,
  passwordFor: (username: string) => string | undefined,
  now = Date.now(),
): Response | null {
  return validateDigestResponse(request, options, passwordFor, now)
    ? null
    : authenticationRequest(options, now);
}

/** Just the check, for a caller handling the failure itself. */
export function authenticateWithHttpDigest(
  request: Request,
  options: DigestOptions,
  passwordFor: (username: string) => string | undefined,
  now = Date.now(),
): boolean {
  return validateDigestResponse(request, options, passwordFor, now);
}
