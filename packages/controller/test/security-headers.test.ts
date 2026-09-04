/**
 * Authentication challenges and security headers, ported from
 * `actionpack/test/controller/http_basic_authentication_test.rb`,
 * `http_digest_authentication_test.rb`,
 * `actionpack/test/dispatch/content_security_policy_test.rb` and
 * `actionpack/test/dispatch/ssl_test.rb`.
 *
 * Each of these headers has a way of being present and doing nothing, so the
 * cases worth having are the ones where the wrong version still looks
 * configured.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_HSTS_MAX_AGE,
  NONCE_DIRECTIVES,
  authenticationHeader,
  buildContentSecurityPolicy,
  contentSecurityPolicyNonce,
  contentSecurityPolicyNonceDirectives,
  contentSecurityPolicyNonceGenerator,
  contentSecurityPolicyReportOnly,
  cookiesDigest,
  cookiesRotations,
  defaultHstsOptions,
  hstsHeader,
  httpBasicAuthenticateOrRequestWith,
  httpBasicAuthenticateWith,
  readWithRotation,
  requestForgeryProtectionToken,
  requestHttpDigestAuthentication,
  resetRotations,
  rotate,
  secretToken,
  tokenAndOptions,
  tokenParamsFrom,
  userNameAndPassword,
} from "../src/security-headers.js";
import { secureCompare } from "@altair/support";

afterEach(() => {
  resetRotations();
});

const basic = (name: string, password: string) => `Basic ${btoa(`${name}:${password}`)}`;

/**
 * `secureCompare` lives in `@altair/support` — these cases are here because
 * this module is what depends on the property, and a change to it that broke
 * authentication should fail beside authentication.
 */
describe("comparing a secret", () => {
  it("compares equal strings as equal", () => {
    expect(secureCompare("abc", "abc")).toBe(true);
    expect(secureCompare("", "")).toBe(true);
  });

  it("compares different ones as different", () => {
    expect(secureCompare("abc", "abd")).toBe(false);
    expect(secureCompare("abc", "abcd")).toBe(false);
  });

  /**
   * An early length check tells an attacker the length of the secret, which is
   * most of the search space for a short one.
   */
  it("folds the lengths in rather than checking them first", () => {
    expect(secureCompare("a", "aaaaaaaaaa")).toBe(false);
    expect(secureCompare("aaaaaaaaaa", "a")).toBe(false);
  });

  /**
   * The padding used to compare past the end of the shorter string is a zero
   * byte, so a secret whose only difference is a trailing NUL would compare
   * equal on the bytes alone. The length is what separates them.
   */
  it("separates a string from itself plus a trailing NUL", () => {
    const withNul = `abc${String.fromCharCode(0)}`;

    expect(withNul).toHaveLength(4);
    expect(secureCompare("abc", withNul)).toBe(false);
  });
});

describe("the Basic challenge", () => {
  /**
   * Without a realm a browser offers every stored credential for the host,
   * since the realm is what scopes a saved password to part of a site.
   */
  it("carries a realm", () => {
    expect(authenticationHeader("Admin")).toBe('Basic realm="Admin"');
    expect(authenticationHeader()).toContain('realm="Application"');
  });

  /**
   * A quote would close the parameter early and let the rest be read as
   * another — a header the browser parses differently from what was written.
   */
  it("strips a quote from the realm", () => {
    expect(authenticationHeader('Ad"min')).toBe('Basic realm="Admin"');
  });
});

describe("reading Basic credentials", () => {
  it("decodes a name and password", () => {
    expect(userNameAndPassword(basic("ada", "secret"))).toEqual(["ada", "secret"]);
  });

  /**
   * Splitting on every colon silently truncates a password containing one, so
   * the user is refused with a correct password and nothing says why.
   */
  it("splits on the first colon only", () => {
    expect(userNameAndPassword(basic("ada", "a:b:c"))).toEqual(["ada", "a:b:c"]);
  });

  it("reads nothing from a missing or malformed header", () => {
    expect(userNameAndPassword(null)).toBeUndefined();
    expect(userNameAndPassword("Basic !!!not base64!!!")).toBeUndefined();
  });

  /**
   * The scheme is checked, not just the payload. A Bearer header carrying
   * something that happens to decode as `name:password` is not Basic
   * credentials, and reading it as such authenticates a token holder as a user.
   */
  it("reads nothing from another scheme carrying a decodable payload", () => {
    expect(userNameAndPassword(`Bearer ${btoa("ada:secret")}`)).toBeUndefined();
  });

  it("reads nothing when there is no colon at all", () => {
    expect(userNameAndPassword(`Basic ${btoa("noseparator")}`)).toBeUndefined();
  });
});

describe("checking Basic credentials", () => {
  it("accepts the right pair", () => {
    expect(httpBasicAuthenticateWith(basic("ada", "secret"), "ada", "secret")).toBe(true);
  });

  it("refuses a wrong password", () => {
    expect(httpBasicAuthenticateWith(basic("ada", "wrong"), "ada", "secret")).toBe(false);
  });

  it("refuses a wrong name", () => {
    expect(httpBasicAuthenticateWith(basic("eve", "secret"), "ada", "secret")).toBe(false);
  });

  it("refuses a missing header", () => {
    expect(httpBasicAuthenticateWith(null, "ada", "secret")).toBe(false);
  });

  /**
   * A 403 says "you may not" and a 401 says "who are you" — only the second
   * causes the dialog the whole scheme depends on.
   */
  it("answers a failure with a 401 and the challenge", () => {
    const answer = httpBasicAuthenticateOrRequestWith(null, "ada", "secret", "Admin");

    expect(answer).toEqual({
      authenticated: false,
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
    });
  });

  it("says nothing more on success", () => {
    expect(httpBasicAuthenticateOrRequestWith(basic("ada", "secret"), "ada", "secret")).toEqual({
      authenticated: true,
    });
  });
});

describe("token authentication", () => {
  it("reads a bare token", () => {
    expect(tokenAndOptions("Bearer abc123")).toEqual({ token: "abc123", options: {} });
  });

  it("reads the Token spelling too", () => {
    expect(tokenAndOptions("Token abc123")?.token).toBe("abc123");
  });

  /**
   * A client that sends parameters and is ignored looks to itself like it
   * authenticated with them.
   */
  it("reads the parameters after the token", () => {
    expect(tokenAndOptions('Token token="abc", nonce="xyz"')).toEqual({
      token: "abc",
      options: { nonce: "xyz" },
    });
  });

  it("reads an unquoted token parameter", () => {
    expect(tokenAndOptions("Token token=abc")?.token).toBe("abc");
  });

  it("reads nothing from another scheme", () => {
    expect(tokenAndOptions("Basic abc")).toBeUndefined();
    expect(tokenAndOptions(null)).toBeUndefined();
  });

  it("parses the pairs", () => {
    expect(tokenParamsFrom('a="1", b=2')).toEqual({ a: "1", b: "2" });
    expect(tokenParamsFrom("")).toEqual({});
  });
});

describe("the Digest challenge", () => {
  /**
   * Digest is only as good as its nonce: a reused one lets a captured response
   * be replayed against a later request, which is the whole thing it exists to
   * prevent.
   */
  it("carries a realm, a nonce and qop", () => {
    const header = requestHttpDigestAuthentication("Admin", "abc");

    expect(header).toContain('realm="Admin"');
    expect(header).toContain('nonce="abc"');
    expect(header).toContain("qop=auth");
  });

  it("carries an opaque value when there is one", () => {
    expect(requestHttpDigestAuthentication("A", "n", { opaque: "o" })).toContain('opaque="o"');
    expect(requestHttpDigestAuthentication("A", "n")).not.toContain("opaque");
  });

  /**
   * Omitting `stale` turns an expired nonce into a password prompt, which the
   * user reads as a rejected password.
   */
  it("says when the nonce merely expired", () => {
    expect(requestHttpDigestAuthentication("A", "n", { stale: true })).toContain("stale=true");
    expect(requestHttpDigestAuthentication("A", "n")).not.toContain("stale");
  });
});

describe("content security policy nonces", () => {
  /**
   * A nonce on `img-src` means nothing — the attribute does not exist on an
   * image — so listing more directives produces a policy that looks stricter
   * and is not.
   */
  it("applies to scripts and styles only", () => {
    expect(contentSecurityPolicyNonceDirectives()).toEqual(["script-src", "style-src"]);
    expect(NONCE_DIRECTIVES).not.toContain("img-src");
  });

  it("generates a value", () => {
    expect(contentSecurityPolicyNonceGenerator().length).toBeGreaterThan(10);
  });

  /** Reused, a nonce is a value read from one page and replayed into another. */
  it("generates a different one each time", () => {
    expect(contentSecurityPolicyNonceGenerator()).not.toBe(contentSecurityPolicyNonceGenerator());
  });

  /**
   * Generated twice, the policy blocks exactly the scripts it was written to
   * allow — and the failure shows up in a browser console rather than
   * anywhere the application can see.
   */
  it("is the same value for one request", () => {
    const request = {};

    expect(contentSecurityPolicyNonce(request)).toBe(contentSecurityPolicyNonce(request));
  });

  it("differs between requests", () => {
    expect(contentSecurityPolicyNonce({})).not.toBe(contentSecurityPolicyNonce({}));
  });
});

describe("building the policy", () => {
  it("writes the directives", () => {
    expect(buildContentSecurityPolicy({ "default-src": ["'self'"] })).toBe("default-src 'self'");
  });

  it("adds the nonce to the directives it applies to", () => {
    const header = buildContentSecurityPolicy(
      { "script-src": ["'self'"], "img-src": ["'self'"] },
      "abc",
    );

    expect(header.split("; ")).toEqual(["script-src 'self' 'nonce-abc'", "img-src 'self'"]);
  });

  /**
   * Browsers ignore `unsafe-inline` beside a nonce, so leaving both is not
   * wrong — but it reads as though inline scripts are allowed, and somebody
   * removing the nonce later would silently re-enable them.
   */
  it("drops unsafe-inline from a directive that got a nonce", () => {
    expect(buildContentSecurityPolicy({ "script-src": ["'self'", "'unsafe-inline'"] }, "abc")).toBe(
      "script-src 'self' 'nonce-abc'",
    );
  });

  it("leaves unsafe-inline alone with no nonce", () => {
    expect(buildContentSecurityPolicy({ "script-src": ["'unsafe-inline'"] })).toContain(
      "'unsafe-inline'",
    );
  });

  /**
   * A different header name, not a flag: under the enforcing name a
   * report-only policy blocks things nobody has tested.
   */
  it("uses a different header when reporting only", () => {
    expect(contentSecurityPolicyReportOnly(true)).toBe("Content-Security-Policy-Report-Only");
    expect(contentSecurityPolicyReportOnly(false)).toBe("Content-Security-Policy");
  });
});

describe("strict transport security", () => {
  /**
   * A browser enforces the policy only for as long as the header said, so a
   * short max-age protects nobody who has not visited recently — and that
   * reads as configured while doing nearly nothing.
   */
  it("defaults to two years with subdomains", () => {
    expect(defaultHstsOptions()).toEqual({
      maxAge: DEFAULT_HSTS_MAX_AGE,
      subdomains: true,
      preload: false,
    });
    expect(DEFAULT_HSTS_MAX_AGE).toBeGreaterThanOrEqual(63_072_000);
  });

  it("writes the header", () => {
    expect(hstsHeader()).toBe(`max-age=${DEFAULT_HSTS_MAX_AGE}; includeSubDomains`);
  });

  it("takes a shorter max-age when asked", () => {
    expect(hstsHeader({ maxAge: 300, subdomains: false })).toBe("max-age=300");
  });

  /**
   * Off by default because it is close to irreversible: getting a domain off
   * the list takes months, during which every browser refuses plain HTTP.
   */
  it("adds preload only when asked", () => {
    expect(hstsHeader()).not.toContain("preload");
    expect(hstsHeader({ preload: true })).toContain("preload");
  });

  /**
   * The list requires both, so sending `preload` without them produces a
   * header rejected on submission — after somebody has relied on it.
   */
  it("refuses preload without what the list requires", () => {
    expect(() => hstsHeader({ preload: true, subdomains: false })).toThrow("includeSubDomains");
    expect(() => hstsHeader({ preload: true, maxAge: 300 })).toThrow("two years");
  });
});

describe("signed cookies", () => {
  it("uses SHA-256 unless told otherwise", () => {
    expect(cookiesDigest()).toBe("SHA256");
    expect(cookiesDigest("SHA1")).toBe("SHA1");
  });

  it("has no rotations to begin with", () => {
    expect(cookiesRotations()).toEqual([]);
  });

  it("reads with the current secret first", () => {
    rotate({ secret: "old" });
    const read = readWithRotation("value", { secret: "new" }, (value, rotation) =>
      rotation.secret === "new" ? value : undefined,
    );

    expect(read).toEqual({ value: "value", rotated: false });
  });

  /**
   * Reports which secret worked, so an application can tell whether a rotation
   * is finished — without that the old secret is kept forever "just in case",
   * which is the state a rotation was supposed to end.
   */
  it("says when an old secret was needed", () => {
    rotate({ secret: "old" });
    const read = readWithRotation("value", { secret: "new" }, (value, rotation) =>
      rotation.secret === "old" ? value : undefined,
    );

    expect(read).toEqual({ value: "value", rotated: true });
  });

  it("reads nothing when no secret works", () => {
    expect(readWithRotation("value", { secret: "new" }, () => undefined)).toBeUndefined();
  });

  /**
   * Supporting it quietly would give an application worse security than it
   * believes it has.
   */
  it("refuses the legacy secret entirely", () => {
    expect(() => secretToken()).toThrow("secret_key_base");
  });

  it("names the forgery parameter", () => {
    expect(requestForgeryProtectionToken()).toBe("authenticity_token");
    expect(requestForgeryProtectionToken("csrf")).toBe("csrf");
  });
});
