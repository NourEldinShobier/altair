/**
 * Hosts an application says a redirect may leave for, ported from
 * `_allowed_redirect_hosts` in
 * `actionpack/lib/action_controller/metal/redirecting.rb` and the open-redirect
 * cases in `actionpack/test/controller/redirect_test.rb`.
 *
 * `hostAllowed` has understood `allowedHosts` since it was written and nothing
 * filled it in: `redirectAllowed` went through `sameHost`, which is the same
 * check with the list hard-coded empty. So the only way to permit a second
 * host was `allowOtherHost: true` — and that permits *every* host, for that
 * call, including a location that came from a parameter.
 *
 * Which is the whole thing the check is for. An application redirecting to its
 * own accounts domain has one legitimate destination, and naming it is
 * narrower than turning the check off.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Controller, redirectAllowed } from "../src/controller.js";
import {
  allowedRedirectHosts,
  configureAllowedRedirectHosts,
  resetAllowedRedirectHosts,
  sameHost,
  UnsafeRedirect,
} from "../src/redirect_safety.js";

const here = new Request("https://app.example/posts");

afterEach(() => {
  resetAllowedRedirectHosts();
});

describe("with nothing configured", () => {
  it("allows this host", () => {
    expect(redirectAllowed("https://app.example/x", here)).toBe(true);
  });

  it("allows a relative location", () => {
    expect(redirectAllowed("/posts/1", here)).toBe(true);
  });

  it("refuses another host", () => {
    expect(redirectAllowed("https://evil.example/x", here)).toBe(false);
  });
});

describe("with a host configured", () => {
  /** The regression: this used to be false however the application was configured. */
  it("allows the one that was named", () => {
    configureAllowedRedirectHosts("accounts.example");

    expect(redirectAllowed("https://accounts.example/sso", here)).toBe(true);
  });

  it("still refuses one that was not", () => {
    configureAllowedRedirectHosts("accounts.example");

    expect(redirectAllowed("https://evil.example/x", here)).toBe(false);
  });

  it("allows several", () => {
    configureAllowedRedirectHosts("accounts.example", "cdn.example");

    expect(redirectAllowed("https://cdn.example/x", here)).toBe(true);
    expect(redirectAllowed("https://accounts.example/x", here)).toBe(true);
  });

  it("matches without regard to case", () => {
    configureAllowedRedirectHosts("Accounts.Example");

    expect(redirectAllowed("https://accounts.example/x", here)).toBe(true);
  });

  /**
   * Exactly, never by suffix. `endsWith("example.com")` accepts
   * `evil-example.com`, which is a domain anybody can register.
   */
  it("does not match a host that merely ends with one", () => {
    configureAllowedRedirectHosts("example.com");

    expect(redirectAllowed("https://evil-example.com/x", here)).toBe(false);
    expect(redirectAllowed("https://notexample.com/x", here)).toBe(false);
  });

  it("does not weaken the parsing it sits on", () => {
    configureAllowedRedirectHosts("accounts.example");

    expect(redirectAllowed("//evil.example", here)).toBe(false);
    expect(redirectAllowed("https:/\\evil.example", here)).toBe(false);
  });

  /**
   * `sameHost` answers a different question and must keep answering it: a
   * caller asking "is this link leaving the site" wants the literal host, and
   * a redirect being permitted elsewhere is not a reason to call another host
   * our own.
   */
  it("does not make a configured host into this host", () => {
    configureAllowedRedirectHosts("accounts.example");

    expect(redirectAllowed("https://accounts.example/x", here)).toBe(true);
    expect(sameHost("https://accounts.example/x", "app.example")).toBe(false);
  });

  it("reports what was configured, as it was written", () => {
    configureAllowedRedirectHosts("Accounts.Example");

    expect(allowedRedirectHosts()).toEqual(["Accounts.Example"]);
  });

  it("reports what is configured", () => {
    configureAllowedRedirectHosts("accounts.example");

    expect(allowedRedirectHosts()).toEqual(["accounts.example"]);
  });

  it("replaces rather than adding to what was there", () => {
    configureAllowedRedirectHosts("a.example");
    configureAllowedRedirectHosts("b.example");

    expect(allowedRedirectHosts()).toEqual(["b.example"]);
  });
});

describe("a host written as a URL", () => {
  /**
   * Refused where it is written. A URL here reads as working and matches
   * nothing, so the redirect it was meant to permit is refused in production
   * and nowhere else.
   */
  it("is refused rather than normalised", () => {
    expect(() => configureAllowedRedirectHosts("https://accounts.example/")).toThrow(/not a URL/);
    expect(() => configureAllowedRedirectHosts("accounts.example/path")).toThrow(/not a URL/);
    expect(() => configureAllowedRedirectHosts("accounts.example:443")).toThrow(/not a URL/);
  });

  it("leaves what was configured before alone", () => {
    configureAllowedRedirectHosts("accounts.example");

    try {
      configureAllowedRedirectHosts("https://cdn.example");
    } catch {
      // The refusal is the point; what matters is what it did not change.
    }

    expect(allowedRedirectHosts()).toEqual(["accounts.example"]);
  });
});

describe("through a controller", () => {
  class Posts extends Controller {
    async show(): Promise<Response> {
      return this.redirectTo("https://accounts.example/sso");
    }
  }

  const controller = (): Posts => new Posts({ request: here });

  it("redirects to a configured host", async () => {
    configureAllowedRedirectHosts("accounts.example");

    expect((await controller().show()).headers.get("location")).toBe(
      "https://accounts.example/sso",
    );
  });

  it("refuses it when nothing is configured", async () => {
    await expect(controller().show()).rejects.toThrow(UnsafeRedirect);
  });

  /** The error names what is allowed, so it says what to do about it. */
  it("names the hosts that are allowed", async () => {
    configureAllowedRedirectHosts("cdn.example");

    await expect(controller().show()).rejects.toThrow(/cdn\.example/);
  });
});
