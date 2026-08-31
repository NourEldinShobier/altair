/**
 * How a CSRF token is stored, checked and rotated, ported from
 * `ActionController::RequestForgeryProtection` — the storage strategies, the
 * verification strategies, and what happens when a token does not match.
 *
 * `csrf.ts` generates and masks tokens; `forgery_protection.ts` runs the check.
 * This is the configuration around them, and the reason it is configuration at
 * all is that the right answer differs per application in ways that are not
 * cosmetic:
 *
 * **Where the token lives.** In the session by default, which is right for a
 * server-rendered application. An API that issues tokens per request cannot use
 * a session at all, and a single-page application that never reloads needs the
 * token to survive a session rotation. Getting this wrong does not produce a
 * security hole — it produces an application where every form submission fails
 * after a while, which is reported as "the site logs me out".
 *
 * **What a failed check does.** Raising is right in development and wrong in
 * production, where a mismatched token is far more often a user with two tabs
 * or a stale cached page than an attack. Rails' default resets the session and
 * carries on, which turns an attack into a no-op and a stale form into a
 * re-login rather than a 500.
 *
 * The one thing that is *not* configurable is whether the token is compared in
 * constant time. A comparison that returns early leaks the token a character at
 * a time, and any application that turned that off would be handing out the
 * thing the whole mechanism protects.
 */

/** Rails' `csrf_token_storage_strategy`. */
export type TokenStorage = "session" | "cookie" | "none";

/** Rails' `protect_from_forgery with:`. */
export type ForgeryStrategy = "exception" | "reset_session" | "null_session";

export interface ForgeryOptions {
  storage?: TokenStorage;
  strategy?: ForgeryStrategy;
  /** Rails' `allow_forgery_protection` — off in test, on everywhere else. */
  enabled?: boolean;
}

/** Rails' `request_forgery_protection_token`. */
export const FORGERY_TOKEN_PARAM = "authenticity_token";

/** The header a JavaScript client sends it in. */
export const FORGERY_TOKEN_HEADER = "x-csrf-token";

/** Rails' `default_protect_from_forgery_with`. */
export function defaultProtectFromForgeryWith(): ForgeryStrategy {
  // Resetting the session rather than raising: in production a mismatch is far
  // more often two tabs or a cached page than an attack, and a 500 tells the
  // user nothing they can act on.
  return "reset_session";
}

/**
 * Rails' `allow_forgery_protection`.
 *
 * Off in test, because every controller test would otherwise have to obtain a
 * token to do anything — and a suite that works around the check is a suite
 * that cannot notice when the check breaks. Left *on* in development, where
 * the same bug is worth finding.
 */
export function allowForgeryProtection(env: string): boolean {
  return env !== "test";
}

/**
 * Rails' `protect_from_forgery`.
 *
 * Refuses an unknown strategy rather than falling back to the default. A typo
 * that quietly became `null_session` would turn the protection off across the
 * whole application, which is the one failure mode nothing else here would
 * report.
 */
export function protectFromForgery(options: ForgeryOptions = {}): Required<ForgeryOptions> {
  const strategy = options.strategy ?? defaultProtectFromForgeryWith();

  if (!["exception", "reset_session", "null_session"].includes(strategy)) {
    throw new Error(
      `Unknown forgery protection strategy ${JSON.stringify(strategy)}. One of: exception, ` +
        `reset_session, null_session. Falling back to a default here would let a typo turn the ` +
        `protection off across the whole application.`,
    );
  }

  return {
    storage: options.storage ?? "session",
    strategy,
    enabled: options.enabled ?? true,
  };
}

/** Rails' `protect_against_forgery?`. */
export function protectAgainstForgery(options: Required<ForgeryOptions>): boolean {
  return options.enabled && options.storage !== "none";
}

// --- where the token lives -------------------------------------------------

export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

/**
 * Rails' `csrf_token_storage_strategy` resolved to a store.
 *
 * The `none` strategy is a real option rather than an oversight: an API
 * authenticating every request with a bearer token has no cookie for a browser
 * to send automatically, so there is no cross-site request to forge — and a
 * token it cannot store would fail every request instead.
 */
export function csrfTokenStorageStrategy(
  storage: TokenStorage,
  session: TokenStore,
  cookie: TokenStore,
): TokenStore | undefined {
  if (storage === "session") return session;
  if (storage === "cookie") return cookie;

  return undefined;
}

/**
 * Rails' `commit_csrf_token` — writes the token where it will be found again.
 *
 * Deferred to the end of the request rather than written when generated,
 * because a request that generates a token and then raises should not leave a
 * token behind that the failed response never showed the user.
 */
export function commitCsrfToken(store: TokenStore | undefined, token: string | undefined): void {
  if (!store || token === undefined) return;

  store.set(token);
}

/**
 * Rails' `reset_csrf_token`.
 *
 * Called on sign-in and sign-out. A token that survived a change of user would
 * let a form rendered for one session be submitted under another, which is
 * session fixation wearing a different hat.
 */
export function resetCsrfToken(store: TokenStore | undefined): void {
  store?.clear();
}

/**
 * Rails' `csrf_token_fallback` — where else to look.
 *
 * A request may carry the token in a parameter or a header; a JavaScript
 * client uses the header, a form uses the parameter, and both are legitimate.
 * The order matters only in that both must be checked: supporting one is how
 * an application works until somebody adds fetch calls.
 */
export function csrfTokenFallback(
  params: Record<string, unknown>,
  headers: { get(name: string): string | null },
): string | undefined {
  const fromParam = params[FORGERY_TOKEN_PARAM];

  if (typeof fromParam === "string" && fromParam !== "") return fromParam;

  return headers.get(FORGERY_TOKEN_HEADER) ?? undefined;
}

// --- what a failure does ---------------------------------------------------

export class InvalidAuthenticityTokenError extends Error {
  constructor() {
    super(
      "The authenticity token did not match. In production this is usually two tabs or a page " +
        "cached before the session changed, rather than an attack — which is why the default " +
        "resets the session instead of raising.",
    );
    this.name = "InvalidAuthenticityTokenError";
  }
}

export type FailureOutcome = "raise" | "reset" | "null_session";

/** Rails' `handle_unverified_request` per strategy. */
export function forgeryProtectionVerificationStrategy(strategy: ForgeryStrategy): FailureOutcome {
  switch (strategy) {
    case "exception":
      return "raise";
    case "reset_session":
      return "reset";
    case "null_session":
      return "null_session";
  }
}

/**
 * Rails' `csrf_request_blocked` / `log_warning_on_csrf_failure`.
 *
 * A blocked request is logged whatever the strategy, including the ones that
 * carry on. `null_session` in particular continues with no session at all, and
 * the resulting behaviour — a signed-in user seeing signed-out pages — is
 * impossible to diagnose without a line saying the token failed.
 */
export function csrfRequestBlocked(
  method: string,
  path: string,
  strategy: ForgeryStrategy,
): string {
  return `Can't verify CSRF token authenticity for ${method} ${path} (${strategy})`;
}

/** Rails' `log_warning_on_csrf_failure`. */
export function logWarningOnCsrfFailure(configured: boolean | undefined): boolean {
  // On unless explicitly silenced. A check that fails silently is a check
  // nobody knows has started failing.
  return configured !== false;
}

/**
 * Rails' `csrf_javascript_blocked` — a cross-origin script reading a response.
 *
 * A separate event from a blocked form, because the cause is different: this
 * one means a `<script src>` on another site is loading a URL that answers
 * with JavaScript containing user data, which is a leak rather than a forged
 * write.
 */
export function csrfJavascriptBlocked(path: string, referrer: string | undefined): string {
  return (
    `Blocked a cross-origin script request for ${path}` +
    (referrer ? ` from ${referrer}` : "") +
    ". A script tag on another site can read what this responds with."
  );
}

/**
 * Whether a request needs checking at all. Rails' `verified_request?` half.
 *
 * Safe methods are exempt because they are not supposed to change anything —
 * and a GET that does change something has a bigger problem than CSRF, since a
 * crawler will find it.
 */
export function requiresForgeryCheck(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS", "TRACE"].includes(method.toUpperCase());
}
