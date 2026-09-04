/**
 * Where a redirect may send someone, ported from
 * `actionpack/test/controller/redirect_test.rb` and the open-redirect cases in
 * `actionpack/test/controller/request_forgery_protection_test.rb`.
 *
 * Nearly every test here is a bypass: a URL a string check reads one way and a
 * browser reads another. The happy path is one line; the rest is the reason
 * this file exists.
 */

import { describe, expect, it } from "bun:test";
import {
  type RedirectPolicy,
  UnsafeRedirect,
  changesMethod,
  hostAllowed,
  openRedirect,
  parseLocation,
  redirectBackOrTo,
  redirectStatus,
  redirectToUrl,
  safeRedirectHeader,
  sameHost,
} from "../src/redirect-safety.js";

const HOST = "app.example";
const policy: RedirectPolicy = { host: HOST };

describe("reading what a location points at", () => {
  it("reads a path as relative", () => {
    expect(parseLocation("/posts/7")).toBe("relative");
  });

  /**
   * The classic bypass. A browser reads `//evil.example` as
   * protocol-relative and goes there; a check that only looks for a scheme
   * reads it as a path.
   */
  it("does not read a protocol-relative url as relative", () => {
    expect(parseLocation("//evil.example")).not.toBe("relative");
    expect((parseLocation("//evil.example") as URL).hostname).toBe("evil.example");
  });

  /** Browsers normalise a backslash in the authority to a slash. */
  it("normalises backslashes before deciding", () => {
    expect((parseLocation("/\\evil.example") as URL).hostname).toBe("evil.example");
    expect((parseLocation("https:/\\evil.example") as URL).hostname).toBe("evil.example");
  });

  /**
   * No scheme and no `//` means it cannot name a host. Deciding that by
   * whether `new URL` throws would refuse a working relative redirect.
   */
  it("reads a bare name as relative", () => {
    expect(parseLocation("posts/7")).toBe("relative");
    expect(sameHost("posts/7", HOST)).toBe(true);
  });

  /** A scheme that still will not parse is not something to hand a browser. */
  it("refuses something malformed that claims a scheme", () => {
    expect(parseLocation("http://[nonsense")).toBeUndefined();
    expect(sameHost("http://[nonsense", HOST)).toBe(false);
  });

  it("reads an absolute url", () => {
    expect((parseLocation("https://evil.example/x") as URL).hostname).toBe("evil.example");
  });

  /** `new URL` puts everything before the `@` in userinfo, not the host. */
  it("reads past a userinfo section", () => {
    expect((parseLocation(`https://${HOST}@evil.example/x`) as URL).hostname).toBe("evil.example");
  });
});

describe("whether a location stays on this host", () => {
  it("allows a path", () => {
    expect(sameHost("/posts/7", HOST)).toBe(true);
  });

  it("allows the same host written out", () => {
    expect(sameHost(`https://${HOST}/posts`, HOST)).toBe(true);
  });

  it("ignores case in the host", () => {
    expect(sameHost(`https://APP.example/posts`, HOST)).toBe(true);
  });

  it("refuses another host", () => {
    expect(sameHost("https://evil.example", HOST)).toBe(false);
  });

  it("refuses a protocol-relative url", () => {
    expect(sameHost("//evil.example", HOST)).toBe(false);
  });

  it("refuses a backslash bypass", () => {
    expect(sameHost("/\\evil.example", HOST)).toBe(false);
    expect(sameHost("https:/\\evil.example", HOST)).toBe(false);
  });

  /** The userinfo trick: a reader sees the trusted host, a browser does not. */
  it("refuses a host hidden behind userinfo", () => {
    expect(sameHost(`https://${HOST}@evil.example/`, HOST)).toBe(false);
  });

  it("refuses a scheme that is not a location at all", () => {
    expect(sameHost("javascript:alert(1)", HOST)).toBe(false);
  });
});

describe("an allowlist", () => {
  it("allows a host that was named", () => {
    expect(hostAllowed("https://cdn.example/x", { ...policy, allowedHosts: ["cdn.example"] })).toBe(
      true,
    );
  });

  it("refuses one that was not", () => {
    expect(hostAllowed("https://evil.example", { ...policy, allowedHosts: ["cdn.example"] })).toBe(
      false,
    );
  });

  /**
   * Exact, never a suffix. `endsWith("example.com")` accepts
   * `evil-example.com` and `notexample.com`, which is how a check that looks
   * right lets everything through.
   */
  it("does not match by suffix", () => {
    expect(
      hostAllowed("https://evilcdn.example", { ...policy, allowedHosts: ["cdn.example"] }),
    ).toBe(false);
    expect(
      hostAllowed("https://cdn.example.evil.test", { ...policy, allowedHosts: ["cdn.example"] }),
    ).toBe(false);
  });

  it("ignores case in the allowlist", () => {
    expect(hostAllowed("https://CDN.example", { ...policy, allowedHosts: ["cdn.example"] })).toBe(
      true,
    );
  });

  it("allows anything when told to", () => {
    expect(hostAllowed("https://evil.example", { ...policy, allowOtherHost: true })).toBe(true);
  });

  it("still allows this host with no list", () => {
    expect(hostAllowed(`https://${HOST}/x`, policy)).toBe(true);
  });
});

describe("what may go in the header", () => {
  /**
   * A newline ends the Location header and starts another, which turns a
   * redirect into an arbitrary response header — or an arbitrary body.
   */
  it("refuses a newline", () => {
    expect(safeRedirectHeader("/posts\r\nSet-Cookie: admin=1")).toBe(false);
    expect(safeRedirectHeader("/posts\nX: y")).toBe(false);
  });

  it("refuses a null byte", () => {
    expect(safeRedirectHeader("/posts\u0000")).toBe(false);
  });

  it("allows an ordinary path", () => {
    expect(safeRedirectHeader("/posts/7?page=2")).toBe(true);
  });
});

describe("deciding a redirect", () => {
  it("hands back a location it allows", () => {
    expect(redirectToUrl("/posts", policy)).toBe("/posts");
  });

  it("refuses one it does not", () => {
    expect(() => redirectToUrl("https://evil.example", policy)).toThrow(UnsafeRedirect);
  });

  it("refuses a header injection even to this host", () => {
    expect(() => redirectToUrl(`https://${HOST}/x\r\nX: y`, policy)).toThrow(UnsafeRedirect);
  });

  it("says what was permitted", () => {
    expect(() =>
      redirectToUrl("https://evil.example", { ...policy, allowedHosts: ["cdn.example"] }),
    ).toThrow("cdn.example");
  });

  it("says what to do if it was intended", () => {
    expect(() => redirectToUrl("https://evil.example", policy)).toThrow("allowOtherHost");
  });

  it("answers the question without throwing", () => {
    expect(openRedirect("https://evil.example", policy)).toBe(true);
    expect(openRedirect("/posts", policy)).toBe(false);
  });
});

describe("going back where the user came from", () => {
  it("uses the referrer when it is safe", () => {
    expect(redirectBackOrTo(`https://${HOST}/posts`, "/", policy)).toBe(`https://${HOST}/posts`);
  });

  /** The referrer is a request header, so it is user-supplied like anything else. */
  it("falls back when the referrer points elsewhere", () => {
    expect(redirectBackOrTo("https://evil.example", "/", policy)).toBe("/");
  });

  /**
   * Falls back rather than throwing: a user arriving from an external search
   * engine should land somewhere sensible, not on an error page.
   */
  it("falls back rather than raising", () => {
    expect(() => redirectBackOrTo("https://evil.example", "/", policy)).not.toThrow();
  });

  it("falls back when there is no referrer", () => {
    expect(redirectBackOrTo(null, "/", policy)).toBe("/");
    expect(redirectBackOrTo(undefined, "/", policy)).toBe("/");
  });

  /** The fallback is checked too — it is often built from parameters. */
  it("still refuses an unsafe fallback", () => {
    expect(() => redirectBackOrTo(null, "https://evil.example", policy)).toThrow(UnsafeRedirect);
  });
});

describe("the status a redirect uses", () => {
  it("is temporary by default", () => {
    expect(redirectStatus()).toBe(302);
  });

  /**
   * 301 is cached indefinitely and is close to irreversible: a mistaken
   * permanent redirect keeps sending returning users to the wrong place long
   * after it is fixed, with no way to reach them.
   */
  it("is permanent only when asked", () => {
    expect(redirectStatus({ permanent: true })).toBe(301);
  });

  it("preserves the method when asked", () => {
    expect(redirectStatus({ preserveMethod: true })).toBe(307);
    expect(redirectStatus({ preserveMethod: true, permanent: true })).toBe(308);
  });

  /**
   * A form submission needs the method changed: without it a browser may
   * repeat the POST at the new location, which for a payment is one charge or
   * two.
   */
  it("says which statuses turn a POST into a GET", () => {
    expect(changesMethod(302)).toBe(true);
    expect(changesMethod(303)).toBe(true);
    expect(changesMethod(307)).toBe(false);
    expect(changesMethod(308)).toBe(false);
  });
});
