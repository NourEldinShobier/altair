/**
 * How a CSRF token is stored, checked and rotated, ported from
 * `actionpack/test/controller/request_forgery_protection_test.rb`.
 *
 * The failures worth testing are mostly not security holes but usability ones:
 * a token in the wrong place makes every form submission fail after a while,
 * which users report as "the site logs me out".
 */

import { describe, expect, it } from "bun:test";
import {
  FORGERY_TOKEN_HEADER,
  FORGERY_TOKEN_PARAM,
  type TokenStore,
  allowForgeryProtection,
  commitCsrfToken,
  csrfJavascriptBlocked,
  csrfRequestBlocked,
  csrfTokenFallback,
  csrfTokenStorageStrategy,
  defaultProtectFromForgeryWith,
  forgeryProtectionVerificationStrategy,
  logWarningOnCsrfFailure,
  protectAgainstForgery,
  protectFromForgery,
  requiresForgeryCheck,
  resetCsrfToken,
} from "../src/csrf-strategies.js";

const store = (): TokenStore & { value?: string } => {
  const held: { value?: string } = {};

  return {
    get: () => held.value,
    set: (token: string) => {
      held.value = token;
    },
    clear: () => {
      held.value = undefined;
    },
    get value() {
      return held.value;
    },
  };
};

const headers = (values: Record<string, string> = {}) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

describe("configuring the protection", () => {
  /**
   * In production a mismatch is far more often two tabs or a cached page than
   * an attack, and a 500 tells the user nothing they can act on.
   */
  it("resets the session by default rather than raising", () => {
    expect(defaultProtectFromForgeryWith()).toBe("reset_session");
    expect(protectFromForgery().strategy).toBe("reset_session");
  });

  it("takes a strategy", () => {
    expect(protectFromForgery({ strategy: "exception" }).strategy).toBe("exception");
  });

  /**
   * A typo that quietly became `null_session` would turn the protection off
   * across the whole application — the one failure nothing else here reports.
   */
  it("refuses an unknown strategy", () => {
    expect(() => protectFromForgery({ strategy: "excepton" as never })).toThrow("Unknown");
  });

  it("says what it would have accepted", () => {
    expect(() => protectFromForgery({ strategy: "nope" as never })).toThrow("null_session");
  });

  it("stores in the session by default", () => {
    expect(protectFromForgery().storage).toBe("session");
  });

  it("is on by default", () => {
    expect(protectAgainstForgery(protectFromForgery())).toBe(true);
  });

  it("is off when disabled", () => {
    expect(protectAgainstForgery(protectFromForgery({ enabled: false }))).toBe(false);
  });

  it("is off with nowhere to store a token", () => {
    expect(protectAgainstForgery(protectFromForgery({ storage: "none" }))).toBe(false);
  });

  /**
   * Off in test, or every controller test would have to obtain a token — and a
   * suite that works around the check cannot notice when the check breaks. On
   * in development, where the same bug is worth finding.
   */
  it("is off in test and on elsewhere", () => {
    expect(allowForgeryProtection("test")).toBe(false);
    expect(allowForgeryProtection("development")).toBe(true);
    expect(allowForgeryProtection("production")).toBe(true);
  });
});

describe("where the token lives", () => {
  it("uses the session store", () => {
    const session = store();

    expect(csrfTokenStorageStrategy("session", session, store())).toBe(session);
  });

  it("uses the cookie store", () => {
    const cookie = store();

    expect(csrfTokenStorageStrategy("cookie", store(), cookie)).toBe(cookie);
  });

  /**
   * A real option: an API authenticating every request with a bearer token has
   * no cookie a browser sends automatically, so there is no cross-site request
   * to forge — and a token it cannot store would fail every request instead.
   */
  it("uses none when there is nothing to protect", () => {
    expect(csrfTokenStorageStrategy("none", store(), store())).toBeUndefined();
  });

  it("writes the token where it will be found", () => {
    const session = store();
    commitCsrfToken(session, "abc");

    expect(session.get()).toBe("abc");
  });

  it("writes nothing with no store", () => {
    expect(() => commitCsrfToken(undefined, "abc")).not.toThrow();
  });

  it("writes nothing when there is no token", () => {
    const session = store();
    commitCsrfToken(session, undefined);

    expect(session.get()).toBeUndefined();
  });

  /**
   * A token surviving a change of user would let a form rendered for one
   * session be submitted under another — session fixation wearing a different
   * hat.
   */
  it("clears the token on sign-in or sign-out", () => {
    const session = store();
    session.set("abc");

    resetCsrfToken(session);

    expect(session.get()).toBeUndefined();
  });

  it("clears nothing with no store", () => {
    expect(() => resetCsrfToken(undefined)).not.toThrow();
  });
});

describe("finding the token on a request", () => {
  it("reads it from a form parameter", () => {
    expect(csrfTokenFallback({ [FORGERY_TOKEN_PARAM]: "abc" }, headers())).toBe("abc");
  });

  /** A JavaScript client sends the header; supporting only one breaks the other. */
  it("reads it from a header", () => {
    expect(csrfTokenFallback({}, headers({ [FORGERY_TOKEN_HEADER]: "abc" }))).toBe("abc");
  });

  it("prefers the parameter when both are present", () => {
    expect(
      csrfTokenFallback(
        { [FORGERY_TOKEN_PARAM]: "form" },
        headers({ [FORGERY_TOKEN_HEADER]: "header" }),
      ),
    ).toBe("form");
  });

  it("ignores an empty parameter", () => {
    expect(
      csrfTokenFallback({ [FORGERY_TOKEN_PARAM]: "" }, headers({ [FORGERY_TOKEN_HEADER]: "abc" })),
    ).toBe("abc");
  });

  it("finds nothing when there is nothing", () => {
    expect(csrfTokenFallback({}, headers())).toBeUndefined();
  });

  it("ignores a parameter that is not a string", () => {
    expect(csrfTokenFallback({ [FORGERY_TOKEN_PARAM]: 7 }, headers())).toBeUndefined();
  });
});

describe("what a failed check does", () => {
  it("maps each strategy to an outcome", () => {
    expect(forgeryProtectionVerificationStrategy("exception")).toBe("raise");
    expect(forgeryProtectionVerificationStrategy("reset_session")).toBe("reset");
    expect(forgeryProtectionVerificationStrategy("null_session")).toBe("null_session");
  });

  /**
   * Logged whatever the strategy. `null_session` in particular carries on with
   * no session, and a signed-in user seeing signed-out pages cannot be
   * diagnosed without a line saying the token failed.
   */
  it("names the request it blocked", () => {
    const line = csrfRequestBlocked("POST", "/posts", "null_session");

    expect(line).toContain("POST /posts");
    expect(line).toContain("null_session");
  });

  it("warns unless silenced", () => {
    expect(logWarningOnCsrfFailure(undefined)).toBe(true);
    expect(logWarningOnCsrfFailure(true)).toBe(true);
    expect(logWarningOnCsrfFailure(false)).toBe(false);
  });

  /** A different cause: a script tag reading a response, not a forged write. */
  it("reports a cross-origin script separately", () => {
    expect(csrfJavascriptBlocked("/posts.js", "https://evil.example")).toContain("evil.example");
    expect(csrfJavascriptBlocked("/posts.js", undefined)).toContain("/posts.js");
  });
});

describe("which requests are checked", () => {
  it("checks the ones that change things", () => {
    expect(requiresForgeryCheck("POST")).toBe(true);
    expect(requiresForgeryCheck("PATCH")).toBe(true);
    expect(requiresForgeryCheck("DELETE")).toBe(true);
  });

  /**
   * A GET that changes something has a bigger problem than CSRF, since a
   * crawler will find it.
   */
  it("does not check the safe ones", () => {
    expect(requiresForgeryCheck("GET")).toBe(false);
    expect(requiresForgeryCheck("HEAD")).toBe(false);
    expect(requiresForgeryCheck("OPTIONS")).toBe(false);
  });

  it("ignores the case of the method", () => {
    expect(requiresForgeryCheck("get")).toBe(false);
    expect(requiresForgeryCheck("post")).toBe(true);
  });
});
