/**
 * Sessions that live on the server, ported from
 * `ActionDispatch::Session::AbstractStore` and its cache-backed store.
 *
 * The cookie store next door keeps the whole session in the cookie, which is
 * right for almost everything: no lookup, no shared state, and it survives a
 * process restart. Two things it cannot do, and both come up:
 *
 *   - A session larger than about 4KB. The browser silently drops the cookie
 *     rather than erroring, so the symptom is a user who is quietly logged out
 *     the moment something puts one object too many in the session.
 *   - Revocation. A cookie session is valid until it expires, so "sign out
 *     everywhere" and "lock this account now" cannot be honoured — the
 *     credential is in the client's hands and the server has no record of it.
 *
 * A server-side store fixes both by keeping the data and giving the client only
 * an identifier.
 */

import { randomBytes } from "node:crypto";

export type SessionData = Record<string, unknown>;

/** What any session store must do. */
export interface SessionStore {
  findSession(id: string): Promise<SessionData | null>;
  writeSession(id: string, data: SessionData, ttlSeconds?: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

/**
 * A fresh session identifier. Rails' `generate_sid`.
 *
 * 32 bytes of randomness, hex-encoded. The length is the whole security
 * property: this is a bearer credential, so guessing one is signing in as
 * somebody, and there is no password behind it to fall back on.
 */
export function generateSid(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Whether a string could be one of ours. Rails' `extract_session_id`.
 *
 * Checked before it reaches the store rather than after, so a malformed
 * identifier — a truncated cookie, somebody's probe — is refused without a
 * lookup. That keeps a hostile client from turning cookie noise into database
 * load.
 */
export function extractSessionId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  return /^[0-9a-f]{32,128}$/.test(value) ? value : undefined;
}

/** A store kept in this process's memory. Useful in tests and single-process apps. */
export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, { data: SessionData; expiresAt?: number }>();

  async findSession(id: string): Promise<SessionData | null> {
    const held = this.#sessions.get(id);
    if (!held) return null;

    // Checked on read rather than swept on a timer: a session nobody asks
    // about costs nothing, and a sweep would be a background job for no
    // benefit that the read cannot deliver itself.
    if (held.expiresAt !== undefined && held.expiresAt <= Date.now()) {
      this.#sessions.delete(id);
      return null;
    }

    return { ...held.data };
  }

  async writeSession(id: string, data: SessionData, ttlSeconds?: number): Promise<void> {
    this.#sessions.set(id, {
      data: { ...data },
      expiresAt: ttlSeconds === undefined ? undefined : Date.now() + ttlSeconds * 1000,
    });
  }

  async deleteSession(id: string): Promise<void> {
    this.#sessions.delete(id);
  }

  /** Every live session id. What "sign out everywhere" iterates. */
  get sessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  clear(): void {
    this.#sessions.clear();
  }
}

/**
 * A session read from a store, tracked so only real changes are written back.
 *
 * The tracking is not an optimisation. Writing on every request refreshes the
 * expiry on every request, so a session that is merely being read never expires
 * — which quietly turns a one-hour timeout into an indefinite one for anybody
 * who leaves a tab open.
 */
export class StoredSession {
  #data: SessionData;
  #loaded: string;
  #destroyed = false;

  constructor(
    readonly id: string,
    data: SessionData = {},
  ) {
    this.#data = { ...data };
    this.#loaded = JSON.stringify(this.#data);
  }

  get(key: string): unknown {
    return this.#data[key];
  }

  set(key: string, value: unknown): void {
    this.#data[key] = value;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#data, key);
  }

  delete(key: string): void {
    delete this.#data[key];
  }

  get keys(): string[] {
    return Object.keys(this.#data);
  }

  toObject(): SessionData {
    return { ...this.#data };
  }

  /** Marks the session for deletion rather than emptying it. */
  destroy(): void {
    this.#destroyed = true;
    this.#data = {};
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Whether anything actually changed. */
  get changed(): boolean {
    return this.#destroyed || JSON.stringify(this.#data) !== this.#loaded;
  }
}

/**
 * Reads a session, or starts a new one. Rails' `load_session`.
 *
 * A cookie naming a session the store has forgotten gets a fresh session under
 * a new id rather than an error. The old one may have expired or been revoked,
 * and either way the right answer is the same as for a visitor with no cookie
 * at all — and reusing the id the client sent would let a client choose its own
 * session identifier, which is session fixation.
 */
export async function loadSession(
  store: SessionStore,
  cookieValue: string | null | undefined,
): Promise<StoredSession> {
  const id = extractSessionId(cookieValue);
  if (!id) return new StoredSession(generateSid());

  const data = await store.findSession(id);

  return data ? new StoredSession(id, data) : new StoredSession(generateSid());
}

/**
 * Writes a session back if it changed. Rails' `commit_session`.
 *
 * Returns the id to set on the cookie, or null when the session was destroyed
 * and the cookie should be cleared.
 */
export async function commitSession(
  store: SessionStore,
  session: StoredSession,
  ttlSeconds?: number,
): Promise<string | null> {
  if (session.destroyed) {
    await store.deleteSession(session.id);
    return null;
  }

  if (session.changed) {
    await store.writeSession(session.id, session.toObject(), ttlSeconds);
  }

  return session.id;
}

/**
 * Moves a session to a new id, keeping its contents. Rails does this on
 * sign-in.
 *
 * The defence against session fixation: an attacker who got a victim to use a
 * session id they know still holds that id after the victim signs in, unless
 * the id changes at exactly that moment.
 */
export async function rotateSession(
  store: SessionStore,
  session: StoredSession,
  ttlSeconds?: number,
): Promise<StoredSession> {
  const rotated = new StoredSession(generateSid(), session.toObject());

  await store.writeSession(rotated.id, rotated.toObject(), ttlSeconds);
  await store.deleteSession(session.id);

  return rotated;
}
