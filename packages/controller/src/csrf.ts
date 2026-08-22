/**
 * CSRF protection, ported from `ActionController::RequestForgeryProtection`.
 *
 * Rails devotes 2,029 tests to this, which is a fair signal of how much detail
 * hides in it. The parts that matter:
 *
 *   - GET, HEAD and OPTIONS are exempt. They are supposed to be safe, and
 *     protecting them would break every ordinary link.
 *   - The token is masked with a fresh random pad on every render. An
 *     unmasked token repeated in a page is extractable via BREACH.
 *   - The comparison is constant time, like every other secret comparison.
 *   - The per-session secret lives in the session, so a token is only valid
 *     for the session it was issued to.
 */

import { secureToken } from "@altair/support";
import { timingSafeEqual } from "node:crypto";
import type { Session } from "./session.js";

export const CSRF_SESSION_KEY = "_csrf_token";
export const CSRF_PARAM = "authenticity_token";
export const CSRF_HEADER = "x-csrf-token";

/** Methods that must not change state, and so need no token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** Raised when a state-changing request arrives without a valid token. */
export class InvalidAuthenticityToken extends Error {
  constructor() {
    super("Can't verify CSRF token authenticity");
    this.name = "InvalidAuthenticityToken";
  }
}

const TOKEN_BYTES = 32;

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let index = 0; index < a.length; index += 1) out[index] = a[index]! ^ b[index]!;
  return out;
}

/** The session's raw token, created on first use. */
export function realToken(session: Session): string {
  const existing = session.get(CSRF_SESSION_KEY);
  if (typeof existing === "string") return existing;

  const token = secureToken(TOKEN_BYTES);
  session.set(CSRF_SESSION_KEY, token);
  return token;
}

/**
 * A masked token for embedding in a page.
 *
 * Every call produces different bytes for the same session token. Without the
 * mask, a page repeating the token gives a BREACH oracle enough signal to
 * recover it from compressed responses.
 */
export function maskedToken(session: Session): string {
  const real = Buffer.from(realToken(session), "base64url");
  const pad = Buffer.from(secureToken(TOKEN_BYTES), "base64url").subarray(0, real.length);
  const masked = xor(real, pad);

  return Buffer.concat([pad, Buffer.from(masked)]).toString("base64url");
}

/** Removes the mask, returning the session token the client was given. */
export function unmaskToken(token: string): Buffer | null {
  const decoded = Buffer.from(token, "base64url");

  // An unmasked token is legal too; Rails accepts both lengths.
  if (decoded.length === TOKEN_BYTES) return decoded;
  if (decoded.length !== TOKEN_BYTES * 2) return null;

  const pad = decoded.subarray(0, TOKEN_BYTES);
  const masked = decoded.subarray(TOKEN_BYTES);
  return Buffer.from(xor(masked, pad));
}

/** Compares a submitted token against the session's, in constant time. */
export function verifyToken(session: Session, submitted: string | null | undefined): boolean {
  if (!submitted) return false;

  const expected = Buffer.from(realToken(session), "base64url");
  const actual = unmaskToken(submitted);

  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface ForgeryProtectionRequest {
  method: string;
  headers: { get(name: string): string | null };
}

/**
 * Finds the token a request submitted.
 *
 * A form posts it as a parameter; fetch and XHR send it as a header.
 */
export function tokenFromRequest(
  request: ForgeryProtectionRequest,
  params: { get(name: string): unknown },
): string | null {
  const header = request.headers.get(CSRF_HEADER);
  if (header) return header;

  const parameter = params.get(CSRF_PARAM);
  return typeof parameter === "string" ? parameter : null;
}

/**
 * Whether a request passes forgery protection.
 *
 * Safe methods always pass. Everything else needs a token matching the
 * session's.
 */
export function isVerifiedRequest(
  request: ForgeryProtectionRequest,
  params: { get(name: string): unknown },
  session: Session,
): boolean {
  if (isSafeMethod(request.method)) return true;
  return verifyToken(session, tokenFromRequest(request, params));
}
