/**
 * Sessions and flash, ported from `ActionDispatch::Session::CookieStore` and
 * `ActionDispatch::Flash`.
 *
 * The session lives in an encrypted cookie, as Rails' default store does: no
 * server-side state, and the client cannot read or forge it.
 *
 * The flash is a session entry with a one-request lifetime. Rails sweeps it
 * after the request that reads it, which is what makes "set a message, then
 * redirect" work without leaving the message on the next page too.
 */

import type { CookieJar, CookieOptions } from "./cookies.js";

export const SESSION_COOKIE = "_altair_session";
const FLASH_KEY = "__flash";

export interface SessionOptions extends CookieOptions {
  cookieName?: string;
}

type Data = Record<string, unknown>;

export class Session {
  #data: Data;
  #loaded: Data;
  #destroyed = false;

  constructor(
    private readonly cookies: CookieJar,
    private readonly options: SessionOptions = {},
  ) {
    const cookieName = options.cookieName ?? SESSION_COOKIE;
    const stored = cookies.encrypted.get<Data>(cookieName);

    this.#data = stored && typeof stored === "object" ? { ...stored } : {};
    this.#loaded = { ...this.#data };
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

  /**
   * Empties the session.
   *
   * Rails calls this `reset_session`, and it is what you call on sign-out or
   * privilege change so a fixated session identifier cannot be reused.
   */
  reset(): void {
    this.#data = {};
  }

  /** Clears the session and expires its cookie. */
  destroy(): void {
    this.#data = {};
    this.#destroyed = true;
  }

  toObject(): Data {
    return { ...this.#data };
  }

  /** Whether anything changed, so an unchanged session sends no header. */
  get isDirty(): boolean {
    return this.#destroyed || JSON.stringify(this.#data) !== JSON.stringify(this.#loaded);
  }

  /** Writes the session back to its cookie, if it changed. */
  commit(): void {
    if (!this.isDirty) return;

    const cookieName = this.options.cookieName ?? SESSION_COOKIE;
    const { cookieName: _ignored, ...cookieOptions } = this.options;

    if (this.#destroyed || Object.keys(this.#data).length === 0) {
      this.cookies.delete(cookieName, cookieOptions);
      return;
    }

    this.cookies.encrypted.set(cookieName, this.#data, cookieOptions);
  }
}

/**
 * Messages that survive exactly one redirect.
 *
 * Entries written this request are readable next request and swept after.
 */
export class Flash {
  #now: Data;
  #next: Data = {};

  constructor(private readonly session: Session) {
    const carried = session.get(FLASH_KEY);
    this.#now = carried && typeof carried === "object" ? { ...(carried as Data) } : {};
  }

  /** A message from the previous request. */
  get(key: string): unknown {
    return this.#now[key];
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#now, key);
  }

  /** Sets a message for the next request. Rails' `flash[:notice] = ...`. */
  set(key: string, value: unknown): void {
    this.#next[key] = value;
  }

  /**
   * Sets a message for this request only.
   *
   * Rails' `flash.now[:alert]`, for rendering rather than redirecting.
   */
  now(key: string, value: unknown): void {
    this.#now[key] = value;
  }

  /** Carries a message from this request into the next one. Rails' `keep`. */
  keep(key?: string): void {
    if (key === undefined) {
      this.#next = { ...this.#now, ...this.#next };
      return;
    }
    if (Object.hasOwn(this.#now, key)) this.#next[key] = this.#now[key];
  }

  /**
   * Every message this request should show.
   *
   * A view reads these rather than asking key by key, since it does not know
   * which ones an action set.
   */
  toObject(): Data {
    return { ...this.#now };
  }

  /**
   * Stores what was set for the next request and drops what was read.
   *
   * The sweep is why a flash does not survive two redirects.
   */
  commit(): void {
    if (Object.keys(this.#next).length > 0) {
      this.session.set(FLASH_KEY, this.#next);
    } else if (this.session.has(FLASH_KEY)) {
      this.session.delete(FLASH_KEY);
    }
  }
}
