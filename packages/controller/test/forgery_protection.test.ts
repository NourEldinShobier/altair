/**
 * Origin checking, per-form tokens and unverified-request strategies, ported
 * from `actionpack/test/controller/request_forgery_protection_test.rb`.
 *
 * Each of these answers a way the token on its own is not enough. A token can
 * leak — through a referrer, a log, an error report, a third-party script — and
 * one token for the whole session means a token scraped from a search form on
 * a public page is also a token for `DELETE /account`.
 */

import { describe, expect, it } from "bun:test";
import { Secrets } from "@altair/support";
import { CookieJar } from "../src/cookies.js";
import { Session } from "../src/session.js";
import { CSRF_SESSION_KEY, maskedToken, realToken } from "../src/csrf.js";
import {
  InvalidCrossOriginRequest,
  NullSession,
  csrfTokenHmac,
  handleUnverifiedRequest,
  isValidRequestOrigin,
  perFormCsrfToken,
  requestBaseUrl,
  unverifiedRequestWarning,
  verifyAuthenticityToken,
  verifyPerFormToken,
} from "../src/forgery_protection.js";

const secrets = new Secrets("a".repeat(64));

function request(origin?: string | null, url = "https://app.test/posts"): Request {
  return new Request(url, {
    method: "POST",
    headers: origin === undefined || origin === null ? {} : { origin },
  });
}

function sessionFor(): Session {
  return new Session(new CookieJar(new Request("https://app.test/posts"), secrets));
}

describe("the origin check", () => {
  it("accepts a post from this site", () => {
    expect(isValidRequestOrigin(request("https://app.test"))).toBe(true);
  });

  /** A leaked token is then still not enough to post from somewhere else. */
  it("refuses a post from another site", () => {
    expect(isValidRequestOrigin(request("https://evil.test"))).toBe(false);
  });

  it("counts the scheme and the port", () => {
    expect(isValidRequestOrigin(request("http://app.test"))).toBe(false);
    expect(isValidRequestOrigin(request("https://app.test:8443"))).toBe(false);
  });

  /** A domain anybody can register, which a prefix check would admit. */
  it("refuses a host that merely starts with this one", () => {
    expect(isValidRequestOrigin(request("https://app.test.evil.test"))).toBe(false);
  });

  /**
   * Accepted, following Rails: some user agents send no Origin on a
   * same-origin form post, and refusing them would break ordinary browsing for
   * a check the token already covers.
   */
  it("accepts a request with no origin at all", () => {
    expect(isValidRequestOrigin(request())).toBe(true);
    expect(isValidRequestOrigin(request(""))).toBe(true);
  });

  /** What a sandboxed iframe or a data: document sends. No form post is one. */
  it("refuses a literal null origin, loudly", () => {
    expect(() => isValidRequestOrigin(request("null"))).toThrow(InvalidCrossOriginRequest);
  });

  it("accepts a trusted origin", () => {
    const config = { forgeryProtectionTrustedOrigins: ["https://admin.test"] };

    expect(isValidRequestOrigin(request("https://admin.test"), config)).toBe(true);
    expect(isValidRequestOrigin(request("https://other.test"), config)).toBe(false);
  });

  it("matches a trusted origin whole", () => {
    const config = { forgeryProtectionTrustedOrigins: ["https://admin.test"] };

    expect(isValidRequestOrigin(request("https://admin.test.evil.test"), config)).toBe(false);
  });

  it("can be switched off", () => {
    const config = { forgeryProtectionOriginCheck: false };

    expect(isValidRequestOrigin(request("https://evil.test"), config)).toBe(true);
    expect(isValidRequestOrigin(request("null"), config)).toBe(true);
  });

  /** Against the url the request arrived at, so an alias works unlisted. */
  it("compares against the request's own host", () => {
    const arrived = request("https://alias.test", "https://alias.test/posts");

    expect(isValidRequestOrigin(arrived)).toBe(true);
    expect(requestBaseUrl(arrived)).toBe("https://alias.test");
  });
});

describe("the warning message", () => {
  it("names the origin when that was what refused", () => {
    expect(unverifiedRequestWarning(request("https://evil.test"))).toBe(
      "HTTP Origin header (https://evil.test) didn't match request base url (https://app.test)",
    );
  });

  it("names the token otherwise", () => {
    expect(unverifiedRequestWarning(request("https://app.test"))).toBe(
      "Can't verify CSRF token authenticity.",
    );
  });

  /** A thrown null origin is a refusal, and the message has to say which. */
  it("reports a null origin rather than throwing out of the log line", () => {
    expect(unverifiedRequestWarning(request("null"))).toContain("HTTP Origin header");
  });
});

describe("per-form tokens", () => {
  it("differs by path", () => {
    const session = sessionFor();

    expect(perFormCsrfToken(session, "/posts", "post")).not.toBe(
      perFormCsrfToken(session, "/account", "post"),
    );
  });

  it("differs by method", () => {
    const session = sessionFor();

    expect(perFormCsrfToken(session, "/posts", "post")).not.toBe(
      perFormCsrfToken(session, "/posts", "delete"),
    );
  });

  it("ignores the case of the method, since a form writes either", () => {
    const session = sessionFor();

    expect(perFormCsrfToken(session, "/posts", "POST")).toBe(
      perFormCsrfToken(session, "/posts", "post"),
    );
  });

  it("is stable for the same form in the same session", () => {
    const session = sessionFor();

    expect(perFormCsrfToken(session, "/posts", "post")).toBe(
      perFormCsrfToken(session, "/posts", "post"),
    );
  });

  it("differs between sessions", () => {
    expect(perFormCsrfToken(sessionFor(), "/posts", "post")).not.toBe(
      perFormCsrfToken(sessionFor(), "/posts", "post"),
    );
  });

  it("is keyed by the session's real token, not derivable without it", () => {
    const session = sessionFor();
    const expected = csrfTokenHmac(session, "/posts#post");

    expect(perFormCsrfToken(session, "/posts", "post")).toBe(expected);
  });

  it("verifies the token it issued", () => {
    const session = sessionFor();
    const token = perFormCsrfToken(session, "/posts", "post");

    expect(verifyPerFormToken(session, token, "/posts", "post")).toBe(true);
  });

  /** The point of the whole thing. */
  it("refuses a token issued for another form", () => {
    const session = sessionFor();
    const token = perFormCsrfToken(session, "/search", "get");

    expect(verifyPerFormToken(session, token, "/account", "delete")).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(verifyPerFormToken(sessionFor(), null, "/posts", "post")).toBe(false);
    expect(verifyPerFormToken(sessionFor(), "", "/posts", "post")).toBe(false);
  });

  it("refuses rubbish", () => {
    expect(verifyPerFormToken(sessionFor(), "not-a-token", "/posts", "post")).toBe(false);
  });
});

describe("verifying a submitted token", () => {
  it("takes the session-wide token", () => {
    const session = sessionFor();
    const token = maskedToken(session);

    expect(verifyAuthenticityToken(session, token, request("https://app.test"))).toBe(true);
  });

  /**
   * Rails' order, and deliberate: a page rendered before per-form tokens were
   * switched on, and a client that keeps one token for everything, both keep
   * working. A per-form-only rule would log everybody out the moment the
   * setting changed.
   */
  it("still takes the session-wide token when per-form is on", () => {
    const session = sessionFor();
    const token = maskedToken(session);
    const config = { perFormCsrfTokens: true };

    expect(verifyAuthenticityToken(session, token, request("https://app.test"), config)).toBe(true);
  });

  it("takes a per-form token when per-form is on", () => {
    const session = sessionFor();
    const token = perFormCsrfToken(session, "/posts", "POST");

    expect(
      verifyAuthenticityToken(session, token, request("https://app.test"), {
        perFormCsrfTokens: true,
      }),
    ).toBe(true);
  });

  it("does not take a per-form token when per-form is off", () => {
    const session = sessionFor();
    const token = perFormCsrfToken(session, "/posts", "POST");

    expect(verifyAuthenticityToken(session, token, request("https://app.test"))).toBe(false);
  });

  it("does not take a per-form token for a different form", () => {
    const session = sessionFor();
    const token = perFormCsrfToken(session, "/search", "GET");

    expect(
      verifyAuthenticityToken(session, token, request("https://app.test"), {
        perFormCsrfTokens: true,
      }),
    ).toBe(false);
  });
});

describe("handling an unverified request", () => {
  it("raises by default, because an attack and a bug both want to be loud", () => {
    expect(() => handleUnverifiedRequest(sessionFor())).toThrow("Can't verify CSRF token");
  });

  it("carries the message it was given", () => {
    expect(() => handleUnverifiedRequest(sessionFor(), "exception", "origin didn't match")).toThrow(
      "origin didn't match",
    );
  });

  describe("with a null session", () => {
    it("lets the request continue", () => {
      const outcome = handleUnverifiedRequest(sessionFor(), "null_session");

      expect(outcome.proceed).toBe(true);
    });

    it("hands back a session that reads empty", () => {
      const session = sessionFor();
      session.set("user_id", 7);

      const outcome = handleUnverifiedRequest(session, "null_session");

      expect(outcome.session.get("user_id")).toBeUndefined();
      expect(outcome.session.has("user_id")).toBe(false);
      expect(outcome.session.keys).toEqual([]);
    });

    /**
     * The reason it is a separate session rather than an emptied one: a
     * forgery aimed at a signed-in person must not also be a way to end their
     * session.
     */
    it("leaves the real session alone", () => {
      const session = sessionFor();
      session.set("user_id", 7);

      handleUnverifiedRequest(session, "null_session");

      expect(session.get("user_id")).toBe(7);
    });

    it("forgets what is written to it", () => {
      const outcome = handleUnverifiedRequest(sessionFor(), "null_session");

      outcome.session.set("user_id", 9);

      expect(outcome.session.get("user_id")).toBeUndefined();
    });
  });

  describe("with a reset session", () => {
    it("empties the real session, for an application that would rather sign out", () => {
      const session = sessionFor();
      session.set("user_id", 7);

      const outcome = handleUnverifiedRequest(session, "reset_session");

      expect(outcome.proceed).toBe(true);
      expect(session.get("user_id")).toBeUndefined();
    });

    /** The CSRF token goes with it, so the next page gets a fresh one. */
    it("drops the csrf token too", () => {
      const session = sessionFor();
      const before = realToken(session);

      handleUnverifiedRequest(session, "reset_session");

      expect(session.get(CSRF_SESSION_KEY)).toBeUndefined();
      expect(realToken(session)).not.toBe(before);
    });
  });
});

describe("NullSession", () => {
  it("is empty however it is asked", () => {
    const session = new NullSession();

    session.set("a", 1);
    session.delete("a");

    expect(session.get("a")).toBeUndefined();
    expect(session.has("a")).toBe(false);
    expect(session.keys).toEqual([]);
  });
});
