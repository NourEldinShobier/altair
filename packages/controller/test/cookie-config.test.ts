/**
 * How a signed or encrypted cookie is produced, ported from
 * `actionpack/test/dispatch/cookies_test.rb` — the salt, cipher, digest and
 * metadata cases.
 *
 * Every setting here has a failure mode that is either "everybody is logged
 * out" or "a cookie can be forged", so the tests are mostly about which of
 * those a wrong value produces.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  ExpiredCookie,
  InvalidCookiePurpose,
  authenticatedEncryptedCookieSalt,
  commitCookieJar,
  configureCookieCrypto,
  cookieCryptoConfig,
  cookieSalts,
  cookiesSameSiteProtection,
  cookiesSerializer,
  encryptedCookieCipher,
  encryptedCookieSalt,
  encryptedSignedCookieSalt,
  haveCookieJar,
  httpAuthSalt,
  resetCookieCrypto,
  saltsAreDistinct,
  signedCookieDigest,
  signedCookieSalt,
  signedOrEncrypted,
  unwrapMetadata,
  updateCookiesFromJar,
  useAuthenticatedCookieEncryption,
  useCookiesWithMetadata,
  wrapWithMetadata,
} from "../src/cookie-config.js";

afterEach(() => {
  resetCookieCrypto();
});

describe("the defaults", () => {
  /**
   * Rails' current settings, not its historical ones. An application with
   * cookies already in browsers cannot change these without signing everybody
   * out, but a new one should never start on the old values.
   */
  it("authenticates its encryption", () => {
    expect(useAuthenticatedCookieEncryption()).toBe(true);
    expect(encryptedCookieCipher()).toBe("aes-256-gcm");
  });

  it("puts metadata in the payload", () => {
    expect(useCookiesWithMetadata()).toBe(true);
  });

  it("signs with SHA256, not SHA1", () => {
    expect(signedCookieDigest()).toBe("SHA256");
  });

  it("serializes as JSON", () => {
    expect(cookiesSerializer()).toBe("json");
  });

  it("defends against cross-site sends", () => {
    expect(cookiesSameSiteProtection()).toBe("lax");
  });

  it("can be changed", () => {
    configureCookieCrypto({ signedCookieDigest: "SHA1" });

    expect(signedCookieDigest()).toBe("SHA1");
  });

  it("goes back on reset", () => {
    configureCookieCrypto({ signedCookieDigest: "SHA1", useCookiesWithMetadata: false });
    resetCookieCrypto();

    expect(signedCookieDigest()).toBe("SHA256");
    expect(useCookiesWithMetadata()).toBe(true);
  });

  it("reports the whole config", () => {
    expect(cookieCryptoConfig().signedCookieSalt).toBe(signedCookieSalt());
  });

  it("gives a copy, so a caller cannot write through it", () => {
    cookieCryptoConfig().signedCookieDigest = "SHA1";

    expect(signedCookieDigest()).toBe("SHA256");
  });
});

describe("the salts", () => {
  it("names one per purpose", () => {
    expect(signedCookieSalt()).not.toBe("");
    expect(encryptedCookieSalt()).not.toBe("");
    expect(encryptedSignedCookieSalt()).not.toBe("");
    expect(authenticatedEncryptedCookieSalt()).not.toBe("");
    expect(httpAuthSalt()).not.toBe("");
  });

  /**
   * Two purposes sharing a salt share a key, so a value signed for one is
   * valid for the other — and one of the purposes is the session.
   */
  it("keeps every one of them different", () => {
    expect(saltsAreDistinct()).toBe(true);
    expect(new Set(cookieSalts()).size).toBe(cookieSalts().length);
  });

  it("notices when two are made the same", () => {
    configureCookieCrypto({ signedCookieSalt: "shared", encryptedCookieSalt: "shared" });

    expect(saltsAreDistinct()).toBe(false);
  });

  it("lists all five", () => {
    expect(cookieSalts()).toHaveLength(5);
  });
});

describe("which jar does what", () => {
  it("signs a signed cookie and does not encrypt it", () => {
    expect(signedOrEncrypted("signed")).toEqual({
      signs: true,
      encrypts: false,
      salt: signedCookieSalt(),
    });
  });

  /** An authenticating cipher detects tampering itself, so no separate signature. */
  it("does not sign separately when the cipher authenticates", () => {
    const encrypted = signedOrEncrypted("encrypted");

    expect(encrypted.encrypts).toBe(true);
    expect(encrypted.signs).toBe(false);
    expect(encrypted.salt).toBe(authenticatedEncryptedCookieSalt());
  });

  /**
   * The old scheme: encrypt, then sign separately. Two operations that can
   * disagree, which is the padding-oracle class of bug that authenticated
   * ciphers exist to end.
   */
  it("signs separately when it does not", () => {
    configureCookieCrypto({ useAuthenticatedCookieEncryption: false });

    const encrypted = signedOrEncrypted("encrypted");

    expect(encrypted.signs).toBe(true);
    expect(encrypted.salt).toBe(encryptedCookieSalt());
  });
});

describe("the metadata envelope", () => {
  it("wraps a value with its purpose and expiry", () => {
    const wrapped = wrapWithMetadata("the value", "login", new Date("2030-01-01T00:00:00Z")) as {
      _rails: { message: unknown; pur: string; exp: string };
    };

    expect(wrapped._rails.message).toBe("the value");
    expect(wrapped._rails.pur).toBe("login");
    expect(wrapped._rails.exp).toBe("2030-01-01T00:00:00.000Z");
  });

  it("wraps nothing when metadata is off", () => {
    configureCookieCrypto({ useCookiesWithMetadata: false });

    expect(wrapWithMetadata("the value", "login", null)).toBe("the value");
  });

  it("takes the value back out", () => {
    const wrapped = wrapWithMetadata("the value", "login", null);

    expect(unwrapMetadata(wrapped, "login")).toBe("the value");
  });

  /**
   * The whole point. Without this a signed cookie is a signed blob: valid is
   * valid, so a value lifted out of one cookie can be pasted into another,
   * since both carry the same signature from the same key.
   */
  it("refuses a value signed for something else", () => {
    const wrapped = wrapWithMetadata("the value", "remember_me", null);

    expect(() => unwrapMetadata(wrapped, "session")).toThrow(InvalidCookiePurpose);
  });

  it("says which purpose it found and which was wanted", () => {
    const wrapped = wrapWithMetadata("the value", "remember_me", null);

    expect(() => unwrapMetadata(wrapped, "session")).toThrow("remember_me");
    expect(() => unwrapMetadata(wrapped, "session")).toThrow("session");
  });

  it("refuses an unscoped value where a purpose was expected", () => {
    const wrapped = wrapWithMetadata("the value", null, null);

    expect(() => unwrapMetadata(wrapped, "session")).toThrow(InvalidCookiePurpose);
  });

  it("refuses a purposed value where none was expected", () => {
    const wrapped = wrapWithMetadata("the value", "session", null);

    expect(() => unwrapMetadata(wrapped, null)).toThrow(InvalidCookiePurpose);
  });

  it("refuses one that has expired", () => {
    const wrapped = wrapWithMetadata("the value", null, new Date("2020-01-01T00:00:00Z"));

    expect(() => unwrapMetadata(wrapped, null)).toThrow(ExpiredCookie);
  });

  it("accepts one that has not", () => {
    const wrapped = wrapWithMetadata("the value", null, new Date("2030-01-01T00:00:00Z"));

    expect(unwrapMetadata(wrapped, null)).toBe("the value");
  });

  it("treats the exact moment of expiry as expired", () => {
    const at = new Date("2030-01-01T00:00:00Z");
    const wrapped = wrapWithMetadata("the value", null, at);

    expect(() => unwrapMetadata(wrapped, null, at)).toThrow(ExpiredCookie);
  });

  /**
   * Turning metadata on must not sign out everybody holding a cookie written
   * before the change. An absent envelope is a different thing from a wrongly
   * purposed one.
   */
  it("accepts a value with no envelope at all", () => {
    expect(unwrapMetadata("a bare value", "session")).toBe("a bare value");
  });

  it("is not fooled by something that merely looks like an envelope", () => {
    expect(unwrapMetadata({ _rails: "not an envelope" }, null)).toEqual({
      _rails: "not an envelope",
    });
  });
});

describe("committing a jar", () => {
  it("says whether anything changed", () => {
    expect(haveCookieJar(undefined)).toBe(false);
    expect(haveCookieJar({ set: new Map(), deleted: new Set() })).toBe(false);
    expect(haveCookieJar({ set: new Map([["a", "a=1"]]), deleted: new Set() })).toBe(true);
    expect(haveCookieJar({ set: new Map(), deleted: new Set(["a"]) })).toBe(true);
  });

  it("writes a header per cookie set", () => {
    const headers = commitCookieJar({
      set: new Map([
        ["a", "a=1; Path=/"],
        ["b", "b=2; Path=/"],
      ]),
      deleted: new Set(),
    });

    expect(headers).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("expires what was deleted", () => {
    const headers = commitCookieJar({ set: new Map(), deleted: new Set(["a"]) });

    expect(headers[0]).toContain("Max-Age=0");
  });

  /**
   * Both in one response is a mistake either way, and expiring is the safe
   * reading — leaving a stale value in the browser is how a signed-out session
   * comes back.
   */
  it("lets a deletion win over a set of the same name", () => {
    const headers = commitCookieJar({
      set: new Map([["a", "a=1"]]),
      deleted: new Set(["a"]),
    });

    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("Max-Age=0");
  });

  it("applies what a jar recorded", () => {
    expect(
      updateCookiesFromJar(
        { a: "old", c: "kept" },
        { set: new Map([["a", "new"]]), deleted: new Set(["c"]) },
      ),
    ).toEqual({ a: "new" });
  });

  it("does not change what it was given", () => {
    const current = { a: "old" };

    updateCookiesFromJar(current, { set: new Map([["a", "new"]]), deleted: new Set() });

    expect(current).toEqual({ a: "old" });
  });
});
