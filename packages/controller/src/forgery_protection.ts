/**
 * The rest of CSRF protection, ported from
 * `ActionController::RequestForgeryProtection`.
 *
 * `csrf.ts` has the token: how it is made, masked, and compared. This has the
 * three things Rails wraps around that token, each answering a way the token
 * alone is not enough.
 *
 *   - **Origin checking.** A token can leak — through a referrer, a log, an
 *     error report, a third-party script. The `Origin` header cannot be set by
 *     a page, so checking it means a leaked token is still not enough to post
 *     from somewhere else.
 *   - **Per-form tokens.** One token for the whole session means a token
 *     scraped from a harmless page — a search form on a public page — can be
 *     replayed against `DELETE /account`. A per-form token is derived from the
 *     path and method it was issued for and is worth nothing anywhere else.
 *   - **Strategies.** What to do when a request fails. Raising is right for an
 *     application with forms; an endpoint that also serves token-authenticated
 *     clients wants the session dropped and the request allowed to continue as
 *     an anonymous one, which is what Rails calls a null session.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { realToken, unmaskToken, verifyToken } from "./csrf.js";
import type { Session } from "./session.js";

/** Raised when a state-changing request came from somewhere else. */
export class InvalidCrossOriginRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCrossOriginRequest";
  }
}

/** What the origin check needs from a request. */
export interface OriginCheckedRequest {
  url: string;
  headers: { get(name: string): string | null };
}

export interface ForgeryProtectionConfig {
  /**
   * Whether to check `Origin` as well as the token. Rails'
   * `forgery_protection_origin_check`. On by default.
   */
  forgeryProtectionOriginCheck?: boolean;
  /**
   * Other origins allowed to post here. Rails'
   * `forgery_protection_trusted_origins`.
   *
   * Matched whole. A prefix check would admit `https://app.test.evil.test`,
   * which is a domain anybody can register.
   */
  forgeryProtectionTrustedOrigins?: string[];
  /**
   * Whether a form's token is tied to the path and method it was rendered for.
   * Rails' `per_form_csrf_tokens`.
   */
  perFormCsrfTokens?: boolean;
  /** What to do with a request that fails. Rails' `protect_from_forgery with:`. */
  forgeryProtectionStrategy?: ForgeryStrategyName;
}

/**
 * The base URL a request arrived at, which is what `Origin` must equal.
 *
 * Taken from the request rather than from configuration, so an application
 * reached by more than one name works at each without listing them.
 */
export function requestBaseUrl(request: OriginCheckedRequest): string {
  const url = new URL(request.url);

  return `${url.protocol}//${url.host}`;
}

/**
 * Whether the request came from this site. Rails' `valid_request_origin?`.
 *
 * A missing `Origin` passes, following Rails: some user agents do not send one
 * on a same-origin form post, and refusing them would break ordinary browsing
 * for the sake of a check the token already covers. A literal `"null"` origin
 * does not pass — that is what a sandboxed iframe or a `data:` document sends,
 * and there is no legitimate form post from one.
 */
export function isValidRequestOrigin(
  request: OriginCheckedRequest,
  config: ForgeryProtectionConfig = {},
): boolean {
  if (config.forgeryProtectionOriginCheck === false) return true;

  const origin = request.headers.get("origin");

  if (origin === null || origin === "") return true;

  if (origin === "null") {
    throw new InvalidCrossOriginRequest(
      "Origin is 'null', which is what a sandboxed document sends. Refusing the request.",
    );
  }

  if (origin === requestBaseUrl(request)) return true;

  return (config.forgeryProtectionTrustedOrigins ?? []).includes(origin);
}

/** The message Rails logs, which says which of the checks did the refusing. */
export function unverifiedRequestWarning(
  request: OriginCheckedRequest,
  config: ForgeryProtectionConfig = {},
): string {
  let originValid: boolean;

  try {
    originValid = isValidRequestOrigin(request, config);
  } catch {
    originValid = false;
  }

  if (!originValid) {
    const origin = request.headers.get("origin") ?? "(none)";

    return `HTTP Origin header (${origin}) didn't match request base url (${requestBaseUrl(request)})`;
  }

  return "Can't verify CSRF token authenticity.";
}

/**
 * A token valid only for one path and method. Rails' `per_form_csrf_token`.
 *
 * An HMAC over `path#method` keyed by the session's real token. The point is
 * narrowness: a token scraped from a search form on a public page cannot be
 * replayed against `DELETE /account`, because it was never a token for that.
 */
export function perFormCsrfToken(session: Session, path: string, method: string): string {
  return csrfTokenHmac(session, `${path}#${method.toLowerCase()}`);
}

/** The HMAC a per-form token is. Rails' `csrf_token_hmac`. */
export function csrfTokenHmac(session: Session, identifier: string): string {
  return createHmac("sha256", Buffer.from(realToken(session), "base64url"))
    .update(identifier)
    .digest("base64url");
}

/** Whether a submitted token is the one issued for this path and method. */
export function verifyPerFormToken(
  session: Session,
  submitted: string | null | undefined,
  path: string,
  method: string,
): boolean {
  if (!submitted) return false;

  const expected = Buffer.from(perFormCsrfToken(session, path, method), "base64url");
  const actual = unmaskToken(submitted);

  if (actual === null || actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

/**
 * Whether a submitted token is acceptable for this request. Rails'
 * `valid_authenticity_token?`.
 *
 * The session-wide token is accepted whether or not per-form tokens are on,
 * and the per-form one is accepted as well when they are. That is Rails'
 * order and it is deliberate: a page rendered before the setting was switched
 * on, and a client that keeps one token for everything, both keep working.
 * The narrowing is a second lock on top of the first, not a replacement — a
 * per-form-only rule would log everybody out the moment the setting changed.
 */
export function verifyAuthenticityToken(
  session: Session,
  submitted: string | null | undefined,
  request: { method: string; url: string },
  config: ForgeryProtectionConfig = {},
): boolean {
  if (verifyToken(session, submitted)) return true;

  if (config.perFormCsrfTokens !== true) return false;

  return verifyPerFormToken(session, submitted, new URL(request.url).pathname, request.method);
}

/** What Rails calls `protect_from_forgery with:`. */
export type ForgeryStrategyName = "exception" | "null_session" | "reset_session";

/** The part of a session the rest of a request uses. */
export interface SessionLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  readonly keys: string[];
}

/**
 * A session that reads empty and forgets what is written to it. Rails'
 * `NullSessionHash`.
 *
 * The stored session is left exactly as it was, which is the point: a forged
 * request must not be able to log somebody out. It simply does not get to see
 * or change who they are.
 */
export class NullSession implements SessionLike {
  // The parameters are named and ignored rather than omitted, so this is a
  // drop-in wherever a Session is passed and a caller cannot tell by its shape
  // that it has been swapped.
  get(_key: string): unknown {
    return undefined;
  }

  set(_key: string, _value: unknown): void {
    // Discarded on purpose. A forged request that writes to the session must
    // not leave anything behind for the next real one to read.
  }

  has(_key: string): boolean {
    return false;
  }

  delete(_key: string): void {
    // Nothing to delete, and nothing stored to reach.
  }

  get keys(): string[] {
    return [];
  }
}

/** What a strategy decided, and which session the request should carry on with. */
export interface ForgeryStrategyOutcome {
  /** Whether the request may continue. */
  proceed: boolean;
  /** The session the rest of the request should use. */
  session: SessionLike;
}

/**
 * Handles a request that failed verification. Rails'
 * `handle_unverified_request`.
 *
 * `exception` raises, and is the right default for an application with forms:
 * a failed check means either an attack or a bug, and both want to be loud.
 *
 * `null_session` hands back a session that reads empty and discards writes,
 * and leaves the stored one alone. It exists for an endpoint that also serves
 * clients authenticating by token, where a browser forgery should degrade to
 * "not logged in" rather than to a 500 — the forged request then does what a
 * stranger's request would do, which is nothing. Crucially it does not log the
 * real user out, so a forgery aimed at a signed-in person is not also a way to
 * end their session.
 *
 * `reset_session` does empty the stored session, for an application that would
 * rather sign somebody out than serve a request it cannot account for.
 */
export function handleUnverifiedRequest(
  session: Session,
  strategy: ForgeryStrategyName = "exception",
  message = "Can't verify CSRF token authenticity.",
): ForgeryStrategyOutcome {
  switch (strategy) {
    case "null_session":
      return { proceed: true, session: new NullSession() };

    case "reset_session":
      session.reset();

      return { proceed: true, session };

    default:
      throw new InvalidAuthenticityTokenWithMessage(message);
  }
}

/** The exception strategy's error, carrying which check refused. */
export class InvalidAuthenticityTokenWithMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthenticityToken";
  }
}
