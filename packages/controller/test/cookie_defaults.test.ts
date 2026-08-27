/**
 * Cookie settings across an application, ported from
 * `actionpack/test/dispatch/cookies_test.rb`.
 *
 * Defaults rather than options on every call: a `SameSite` set on eleven
 * cookies and forgotten on the twelfth is a hole in one place, and the twelfth
 * is always the one somebody added in a hurry.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import {
  clearCookieRotations,
  configureCookies,
  cookieDefaults,
  cookieRotations,
  CookieJar,
  resetCookieDefaults,
  rotateCookieSecret,
} from "../src/cookies.js";

const written = (jar: CookieJar) => jar.toHeaders()[0] ?? "";

const jar = () => new CookieJar(new Request("https://app.example/"), new Secrets("x".repeat(64)));

afterEach(() => {
  resetCookieDefaults();
  clearCookieRotations();
});

describe("what a cookie gets without being told", () => {
  it("leans secure out of the box", () => {
    const one = jar();
    one.set("a", "1");

    expect(written(one)).toContain("HttpOnly");
    expect(written(one)).toContain("SameSite=Lax");
    expect(written(one)).toContain("Path=/");
  });

  it("takes the application's defaults", () => {
    configureCookies({ sameSite: "strict", secure: true, domain: "app.example" });

    const one = jar();
    one.set("a", "1");

    expect(written(one)).toContain("SameSite=Strict");
    expect(written(one)).toContain("Secure");
    expect(written(one)).toContain("Domain=app.example");
  });

  it("still lets one cookie say otherwise", () => {
    configureCookies({ sameSite: "strict" });

    const one = jar();
    one.set("a", "1", { sameSite: "none", secure: true });

    expect(written(one)).toContain("SameSite=None");
  });

  /**
   * A cookie that says nothing about a setting must take the default, not
   * overwrite it with undefined — which is the bug a naive spread produces.
   */
  it("is not overwritten by a setting a cookie left out", () => {
    configureCookies({ secure: true });

    const one = jar();
    one.set("a", "1", { path: "/admin" });

    expect(written(one)).toContain("Secure");
    expect(written(one)).toContain("Path=/admin");
  });

  it("says what the defaults are", () => {
    configureCookies({ sameSite: "strict" });

    expect(cookieDefaults().sameSite).toBe("strict");
  });

  it("goes back to the shipped ones", () => {
    configureCookies({ sameSite: "none" });
    resetCookieDefaults();

    expect(cookieDefaults().sameSite).toBe("lax");
  });
});

/**
 * The same reason the message verifier has them: a cookie signed with the old
 * secret is still in a browser, and a deploy that only knows the new one signs
 * everybody out at once.
 */
describe("older secrets", () => {
  it("remembers each once", () => {
    rotateCookieSecret("old");
    rotateCookieSecret("older");
    rotateCookieSecret("old");

    expect(cookieRotations()).toEqual(["old", "older"]);
  });

  it("can be forgotten", () => {
    rotateCookieSecret("old");
    clearCookieRotations();

    expect(cookieRotations()).toEqual([]);
  });
});
