/**
 * The cookie defaults, held to the same rule as a cookie's own attributes.
 *
 * `serializeCookie` calls itself "the chokepoint every outgoing cookie passes
 * through however it was written", and it checked the record rather than the
 * attributes it was about to write. A cookie that names no path or domain —
 * which is most of them — is written with the defaults, and those were never
 * read:
 *
 *     configureCookies({ domain: "example.com; SameSite=None" })
 *     // sid=abc; Path=/; Domain=example.com; SameSite=None; HttpOnly; SameSite=Lax
 *
 * A browser takes the first occurrence of a repeated attribute, so that is
 * `SameSite=None` on every cookie in the application, from one line of
 * configuration. The equivalent through `path` adds a `Domain` the
 * application never set.
 *
 * Configuration is not a request, which is why this is a guard rather than a
 * patched hole — but a domain read from an environment variable is a short
 * walk from a deploy, and a chokepoint with an exception is not one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  configureCookies,
  resetCookieDefaults,
  serializeCookie,
  UnsafeCookie,
} from "../src/cookies.js";

afterEach(() => {
  resetCookieDefaults();
});

describe("a default that would add an attribute", () => {
  it("is refused when it is set", () => {
    expect(() => configureCookies({ domain: "example.com; SameSite=None" })).toThrow(UnsafeCookie);
  });

  it("is refused through the path too", () => {
    expect(() => configureCookies({ path: "/x; Domain=evil.test" })).toThrow(UnsafeCookie);
  });

  it("says which field it refused", () => {
    expect(() => configureCookies({ domain: "a.test; Secure" })).toThrow(/domain/);
  });

  it("leaves the defaults as they were", () => {
    try {
      configureCookies({ domain: "example.com; Secure" });
    } catch {
      // The refusal is the point; what matters is what it did not change.
    }

    expect(serializeCookie({ name: "sid", value: "abc" })).not.toContain("Domain=");
  });

  it("refuses a comma as well as a semicolon", () => {
    expect(() => configureCookies({ domain: "a.test,b.test" })).toThrow(UnsafeCookie);
  });

  it("refuses a control character", () => {
    expect(() => configureCookies({ path: "/a\r\nSet-Cookie: x=y" })).toThrow(UnsafeCookie);
  });
});

describe("a default that is ordinary", () => {
  it("is accepted and used", () => {
    configureCookies({ domain: "example.com", path: "/app" });

    const header = serializeCookie({ name: "sid", value: "abc" });

    expect(header).toContain("Domain=example.com");
    expect(header).toContain("Path=/app");
  });

  it("is still overridden by a cookie that names its own", () => {
    configureCookies({ domain: "example.com" });

    expect(serializeCookie({ name: "sid", value: "abc", domain: "other.test" })).toContain(
      "Domain=other.test",
    );
  });
});

describe("SameSite", () => {
  /**
   * The type says one of three words, and a JavaScript caller is not bound by
   * a type. The value written is one this file chose rather than one that was
   * passed in, so there is nothing to interpolate.
   */
  it("writes only a word it recognises", () => {
    for (const [given, written] of [
      ["strict", "SameSite=Strict"],
      ["lax", "SameSite=Lax"],
      ["none", "SameSite=None"],
    ] as const) {
      configureCookies({ sameSite: given });

      expect(serializeCookie({ name: "sid", value: "abc" })).toContain(written);
    }
  });

  it("refuses one it does not", () => {
    configureCookies({ sameSite: "lax; Domain=evil.test" as never });

    expect(() => serializeCookie({ name: "sid", value: "abc" })).toThrow(UnsafeCookie);
  });
});

describe("what was already guarded", () => {
  it("still refuses a cookie's own unsafe domain", () => {
    expect(() => serializeCookie({ name: "sid", value: "abc", domain: "a; Secure" })).toThrow(
      UnsafeCookie,
    );
  });

  it("still refuses an unsafe name", () => {
    expect(() => serializeCookie({ name: "sid=stolen; x", value: "abc" })).toThrow(UnsafeCookie);
  });

  it("still needs no guard on the value, which is encoded", () => {
    expect(serializeCookie({ name: "sid", value: "a; Domain=evil.test" })).toContain(
      "sid=a%3B%20Domain%3Devil.test",
    );
  });
});
