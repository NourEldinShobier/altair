/**
 * When a session is created, replaced and written back. Ported from
 * `ActionDispatch::Session` and the `Flash` middleware.
 *
 * `session.ts` holds the data and knows when it is dirty. What surrounds it is
 * the lifecycle, and the two moments that matter are the ones with security
 * consequences rather than convenience ones.
 *
 * **Resetting on privilege change.** Signing in must not keep the session
 * identifier the visitor arrived with. If it does, anyone who set that
 * identifier beforehand — through an XSS, a shared machine, a link with a
 * session in it — is now signed in as the person who just authenticated. That
 * is session fixation, it is silent, and the fix is one line that is easy to
 * leave out: throw the old session away and start a new one, carrying over
 * only what was deliberately chosen.
 *
 * **Sweeping the flash.** A flash entry is meant to survive exactly one
 * redirect. Sweeping too eagerly loses the message the redirect was carrying;
 * too late and it appears again on the page after, so a user sees "Signed in"
 * twice and one of them on a page they navigated to themselves.
 */

import { Flash, Session } from "./session.js";

/** What a session is allowed to carry across a reset. */
export interface SessionCarryOver {
  /** Keys to keep — a locale, a return path, a consent flag. */
  keep?: readonly string[];
}

/**
 * A fresh session with a new identifier. Rails' `reset_session`.
 *
 * Everything is dropped unless it was named. Naming what survives rather than
 * what does not is the safe direction: a key added later is dropped by
 * default, and the failure of dropping something is a user re-choosing their
 * language, while the failure of keeping something is a signed-in attacker.
 */
export function resetSession(session: Session, options: SessionCarryOver = {}): Session {
  const carried = createSession(session, options.keep ?? []);

  session.reset();

  for (const [key, value] of Object.entries(carried)) session.set(key, value);

  return session;
}

/**
 * The values a reset would carry over. Rails' `create_session`'s payload.
 *
 * Separated so a caller can see what survives before anything is thrown away —
 * which is the review a fixation fix actually needs.
 */
export function createSession(
  session: Session,
  keep: readonly string[] = [],
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};

  for (const key of keep) {
    if (session.has(key)) carried[key] = session.get(key);
  }

  return carried;
}

/** Empties a session completely. Rails' `new_session`. */
export function newSession(session: Session): Session {
  session.reset();

  return session;
}

/**
 * Copies chosen values from one session to another. Rails'
 * `copy_session_variables!`.
 *
 * By name, for the same reason `resetSession` keeps by name.
 */
export function copySessionVariables(from: Session, to: Session, keys: readonly string[]): void {
  for (const key of keys) {
    if (from.has(key)) to.set(key, from.get(key));
  }
}

/**
 * Whether a session should be written back. Rails' `commit_session?`.
 *
 * Only when something changed. Writing an unchanged session on every response
 * rotates the cookie constantly, which breaks a client that is comparing them
 * and defeats any cache keyed on `Set-Cookie` being absent.
 */
export function shouldCommitSession(session: Session, loaded: boolean): boolean {
  return session.isDirty || !loaded;
}

/** Whether a request arrived carrying a session at all. Rails' `loaded_session?`. */
export function loadedSession(cookieValue: string | undefined | null): boolean {
  return typeof cookieValue === "string" && cookieValue !== "";
}

/**
 * Whether a session is too old to trust. Rails' `stale_session_check!`.
 *
 * Separate from the cookie's own expiry, because a cookie's expiry is set by
 * the browser and can be edited by whoever holds it. The timestamp inside the
 * signed payload cannot be, which makes it the one worth checking.
 */
export function staleSessionCheck(
  createdAt: number | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (createdAt === undefined) return true;

  return now - createdAt >= maxAgeMs;
}

/**
 * Prepares a session for a request. Rails' `prepare_session`.
 *
 * A stale one is replaced rather than emptied, so its identifier changes too —
 * an expired session whose id survives is still a fixation target.
 */
export function prepareSession(
  session: Session,
  options: { createdAt?: number; maxAgeMs?: number; now?: number } = {},
): { session: Session; replaced: boolean } {
  if (options.maxAgeMs === undefined) return { session, replaced: false };

  if (!staleSessionCheck(options.createdAt, options.maxAgeMs, options.now)) {
    return { session, replaced: false };
  }

  // Destroyed rather than emptied, so the cookie is expired and the identifier
  // goes with it. An expired session whose id survives is still a fixation
  // target.
  session.destroy();

  return { session, replaced: true };
}

/** How a session value survives being stored. Rails' `to_session_value`. */
export function toSessionValue(value: unknown): unknown {
  if (value instanceof Date) return { __type: "date", value: value.toISOString() };
  if (value instanceof Set) return { __type: "set", value: Array.from(value) };

  return value;
}

/**
 * And back. Rails' `from_session_value`.
 *
 * Only the shapes written above are converted; anything else is returned
 * untouched. A session's contents arrive from a cookie the client holds, so
 * turning an arbitrary `__type` into an object to construct is the same class
 * of bug as deserialising a polymorphic type name.
 */
export function fromSessionValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("__type" in value)) return value;

  const { __type: type, value: held } = value as { __type: unknown; value: unknown };

  if (type === "date" && typeof held === "string") return new Date(held);
  if (type === "set" && Array.isArray(held)) return new Set(held);

  return value;
}

/**
 * Moves the flash on by one request. Rails' `sweep`.
 *
 * What was set last request is available this one and gone next. Sweeping at
 * the *start* of a request rather than the end is what makes a redirect work:
 * the entry set before the redirect has to survive the response that carries
 * it and be readable by the request that follows.
 */
export function sweep(flash: Flash): void {
  flash.commit();
}

/** The flash as a plain object, for a template or a test. Rails' `flash_hash`. */
export function flashHash(flash: Flash): Record<string, unknown> {
  return flash.toObject();
}

/** What the flash will carry into the next request. */
export function commitFlash(flash: Flash): Record<string, unknown> {
  return flash.pending();
}

/**
 * A session identifier for a test that has to name one. Rails'
 * `open_session` / `integration_session`.
 *
 * Two calls give two sessions, because a test that reuses one cannot tell a
 * bug that leaks state between users from a test that shares it deliberately.
 */
let openSessions = 0;

export function openSession(session: Session): { id: string; session: Session } {
  openSessions += 1;

  return { id: `integration-${String(openSessions)}`, session };
}

export function integrationSession(session: Session): Session {
  return openSession(session).session;
}

export function resetOpenSessions(): void {
  openSessions = 0;
}
