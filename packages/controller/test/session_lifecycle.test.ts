/**
 * When a session is created, replaced and written back. Ported from
 * `actionpack/test/dispatch/session/cookie_store_test.rb` and the flash cases
 * in `actionpack/test/controller/flash_test.rb`.
 *
 * The moment that matters is signing in. A session identifier that survives a
 * privilege change means anyone who set it beforehand is now signed in as the
 * person who just authenticated — silently, and with no way to tell from the
 * logs.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import { CookieJar } from "../src/cookies.js";
import { Flash, Session } from "../src/session.js";
import {
  commitFlash,
  copySessionVariables,
  createSession,
  flashHash,
  fromSessionValue,
  integrationSession,
  loadedSession,
  newSession,
  openSession,
  prepareSession,
  resetOpenSessions,
  resetSession,
  shouldCommitSession,
  staleSessionCheck,
  sweep,
  toSessionValue,
} from "../src/session_lifecycle.js";

const secrets = new Secrets("a".repeat(64));

function sessionWith(values: Record<string, unknown> = {}): Session {
  const session = new Session(new CookieJar(new Request("https://app.test/"), secrets));

  for (const [key, value] of Object.entries(values)) session.set(key, value);

  return session;
}

afterEach(() => {
  resetOpenSessions();
});

describe("resetting on a privilege change", () => {
  /**
   * The whole point. Anything the visitor arrived holding has to go, or
   * whoever put it there is signed in as the person who just authenticated.
   */
  it("drops everything by default", () => {
    const session = sessionWith({ user_id: 1, cart: ["a"] });

    resetSession(session);

    expect(session.keys).toEqual([]);
  });

  /**
   * Naming what survives rather than what does not is the safe direction: a
   * key added later is dropped by default, and the cost of dropping one is a
   * user re-choosing their language.
   */
  it("keeps only what was named", () => {
    const session = sessionWith({ user_id: 1, locale: "fr", return_to: "/posts" });

    resetSession(session, { keep: ["locale"] });

    expect(session.keys).toEqual(["locale"]);
    expect(session.get("locale")).toBe("fr");
  });

  it("keeps several", () => {
    const session = sessionWith({ user_id: 1, locale: "fr", return_to: "/posts" });

    resetSession(session, { keep: ["locale", "return_to"] });

    expect(session.keys.sort()).toEqual(["locale", "return_to"]);
  });

  it("ignores a name the session does not hold", () => {
    const session = sessionWith({ locale: "fr" });

    resetSession(session, { keep: ["locale", "nothing"] });

    expect(session.keys).toEqual(["locale"]);
  });

  /** So a fixation fix can be reviewed before anything is thrown away. */
  it("says what would survive without doing it", () => {
    const session = sessionWith({ user_id: 1, locale: "fr" });

    expect(createSession(session, ["locale"])).toEqual({ locale: "fr" });
    expect(session.get("user_id")).toBe(1);
  });

  it("empties one completely", () => {
    const session = sessionWith({ user_id: 1 });

    newSession(session);

    expect(session.keys).toEqual([]);
  });
});

describe("copying between sessions", () => {
  it("copies what was named", () => {
    const from = sessionWith({ locale: "fr", user_id: 1 });
    const to = sessionWith();

    copySessionVariables(from, to, ["locale"]);

    expect(to.keys).toEqual(["locale"]);
  });

  it("leaves the source alone", () => {
    const from = sessionWith({ locale: "fr" });

    copySessionVariables(from, sessionWith(), ["locale"]);

    expect(from.get("locale")).toBe("fr");
  });

  it("skips a name the source does not hold", () => {
    const to = sessionWith();

    copySessionVariables(sessionWith(), to, ["missing"]);

    expect(to.keys).toEqual([]);
  });
});

describe("whether to write it back", () => {
  /**
   * Writing an unchanged session on every response rotates the cookie
   * constantly, which breaks a client comparing them and defeats any cache
   * keyed on `Set-Cookie` being absent.
   */
  it("does not write an unchanged session that arrived with the request", () => {
    expect(shouldCommitSession(sessionWith(), true)).toBe(false);
  });

  it("writes a changed one", () => {
    expect(shouldCommitSession(sessionWith({ user_id: 1 }), true)).toBe(true);
  });

  it("writes one for a request that arrived without", () => {
    expect(shouldCommitSession(sessionWith(), false)).toBe(true);
  });

  it("knows whether a request carried one", () => {
    expect(loadedSession("abc")).toBe(true);
    expect(loadedSession("")).toBe(false);
    expect(loadedSession(undefined)).toBe(false);
    expect(loadedSession(null)).toBe(false);
  });
});

describe("staleness", () => {
  /**
   * Separate from the cookie's expiry, which the browser holds and whoever
   * holds it can edit. The timestamp inside the signed payload cannot be.
   */
  it("is stale once the age passes", () => {
    expect(staleSessionCheck(1000, 5000, 6000)).toBe(true);
  });

  it("is not stale before it", () => {
    expect(staleSessionCheck(1000, 5000, 5999)).toBe(false);
  });

  it("is stale exactly on the boundary", () => {
    expect(staleSessionCheck(1000, 5000, 6000)).toBe(true);
  });

  /** A session with no timestamp cannot be shown to be fresh. */
  it("is stale when nothing recorded when it started", () => {
    expect(staleSessionCheck(undefined, 5000, 1)).toBe(true);
  });

  it("leaves a session alone when no maximum age was set", () => {
    const session = sessionWith({ user_id: 1 });

    expect(prepareSession(session).replaced).toBe(false);
    expect(session.get("user_id")).toBe(1);
  });

  it("keeps a fresh one", () => {
    const session = sessionWith({ user_id: 1 });

    expect(prepareSession(session, { createdAt: 1000, maxAgeMs: 5000, now: 2000 }).replaced).toBe(
      false,
    );
    expect(session.get("user_id")).toBe(1);
  });

  /** An expired session whose identifier survives is still a fixation target. */
  it("destroys a stale one rather than emptying it", () => {
    const session = sessionWith({ user_id: 1 });

    const { replaced } = prepareSession(session, { createdAt: 1000, maxAgeMs: 5000, now: 9000 });

    expect(replaced).toBe(true);
    expect(session.keys).toEqual([]);
    expect(session.isDirty).toBe(true);
  });
});

describe("values that are not strings", () => {
  it("survives a date", () => {
    const at = new Date("2026-06-15T12:00:00Z");

    expect(fromSessionValue(toSessionValue(at))).toEqual(at);
  });

  it("survives a set", () => {
    expect(fromSessionValue(toSessionValue(new Set([1, 2])))).toEqual(new Set([1, 2]));
  });

  it("leaves an ordinary value alone", () => {
    expect(toSessionValue("hello")).toBe("hello");
    expect(fromSessionValue(42)).toBe(42);
    expect(fromSessionValue(null)).toBeNull();
  });

  it("leaves a plain object alone", () => {
    expect(fromSessionValue({ a: 1 })).toEqual({ a: 1 });
  });

  /**
   * A session's contents arrive from a cookie the client holds. Turning an
   * arbitrary `__type` into an object to construct is the same class of bug as
   * deserialising a polymorphic type name.
   */
  it("does not act on a type it did not write", () => {
    const hostile = { __type: "Model", value: "User" };

    expect(fromSessionValue(hostile)).toEqual(hostile);
  });

  it("does not act on a known type with the wrong payload", () => {
    const wrong = { __type: "date", value: { not: "a string" } };

    expect(fromSessionValue(wrong)).toEqual(wrong);
  });
});

describe("the flash", () => {
  const flashFor = () => new Flash(sessionWith());

  /**
   * `set` queues for the *next* request and `flashHash` shows *this* one. They
   * are different collections, and reading the wrong one is a test that passes
   * for the wrong reason — which is what the first draft of this file did.
   */
  it("shows what this request should show", () => {
    const flash = flashFor();
    flash.now("alert", "Something went wrong");

    expect(flashHash(flash)).toEqual({ alert: "Something went wrong" });
  });

  it("does not show what was queued for the next request", () => {
    const flash = flashFor();
    flash.set("notice", "Signed in");

    expect(flashHash(flash)).toEqual({});
  });

  /**
   * The entry set before a redirect has to survive the response carrying it
   * and be readable by the request that follows.
   */
  it("carries what was set into the next request", () => {
    const flash = flashFor();
    flash.set("notice", "Signed in");

    expect(commitFlash(flash)).toEqual({ notice: "Signed in" });
  });

  it("does not carry what was only for this request", () => {
    const flash = flashFor();
    flash.now("alert", "Something went wrong");

    expect(commitFlash(flash)).toEqual({});
  });

  it("sweeps without throwing", () => {
    const flash = flashFor();
    flash.set("notice", "Signed in");

    expect(() => sweep(flash)).not.toThrow();
  });

  it("shows nothing from an empty flash", () => {
    expect(flashHash(flashFor())).toEqual({});
  });
});

describe("sessions for a test", () => {
  /**
   * Two calls give two identifiers, because a test that reuses one cannot tell
   * a bug that leaks state between users from a test that shares it
   * deliberately.
   */
  it("names each one differently", () => {
    expect(openSession(sessionWith()).id).not.toBe(openSession(sessionWith()).id);
  });

  it("hands back the session it was given", () => {
    const session = sessionWith({ user_id: 1 });

    expect(openSession(session).session).toBe(session);
    expect(integrationSession(session)).toBe(session);
  });

  it("starts numbering again on reset", () => {
    const first = openSession(sessionWith()).id;
    resetOpenSessions();

    expect(openSession(sessionWith()).id).toBe(first);
  });
});
