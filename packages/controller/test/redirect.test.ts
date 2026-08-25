/**
 * Where a redirect is allowed to go.
 *
 * Mirrors actionpack/test/controller/redirect_test.rb's `allow_other_host`
 * cases, which Rails added in 7.0 and defaults to off.
 *
 * The pattern this protects is `redirectTo(this.params.get("return_to"))` —
 * how "back to where you were" is written everywhere, and how a link from your
 * own domain ends up delivering someone to a copy of your login page. Before
 * this the Location header was whatever it was handed.
 */

import { describe, expect, it } from "bun:test";
import { Controller, UnsafeRedirect, redirectAllowed } from "../src/index.js";

const request = new Request("https://app.example/login");

class Pages extends Controller {
  async go(to: string, allowOtherHost = false) {
    return this.redirectTo(to, { allowOtherHost });
  }
}

const controller = () =>
  new Pages({ request, secrets: "x".repeat(64) } as unknown as ConstructorParameters<
    typeof Pages
  >[0]);

describe("a redirect that stays put", () => {
  it("allows a relative path", () => {
    expect(redirectAllowed("/dashboard", request)).toBe(true);
  });

  it("allows a query or a fragment on their own", () => {
    expect(redirectAllowed("?page=2", request)).toBe(true);
    expect(redirectAllowed("#top", request)).toBe(true);
  });

  it("allows an absolute URL on the same host", () => {
    expect(redirectAllowed("https://app.example/ok", request)).toBe(true);
  });

  // A browser reads a backslash in a URL as a slash, so a single leading one
  // is a relative path on this host and not a way out.
  it("allows a single leading backslash, which is a path", () => {
    expect(redirectAllowed("\\evil.example", request)).toBe(true);
  });

  it("sets the header it was given", async () => {
    const response = await controller().go("/dashboard");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
  });
});

describe("a redirect that leaves", () => {
  it("is refused", () => {
    expect(redirectAllowed("https://evil.example/phish", request)).toBe(false);
  });

  // No scheme but a host all the same, and `new URL` with no base rejects it —
  // so without the check first it would pass as "relative".
  it("is refused when it is protocol-relative", () => {
    expect(redirectAllowed("//evil.example/phish", request)).toBe(false);
  });

  // Browsers normalise these to `//evil.example`; deciding on the raw string
  // would be deciding about a URL the browser is not going to follow.
  it("is refused however the slashes are spelled", () => {
    for (const location of ["\\\\evil.example/x", "/\\evil.example/x", "\\/evil.example/x"]) {
      expect(redirectAllowed(location, request)).toBe(false);
    }
  });

  // Reads as app.example to a person and resolves to evil.example.
  it("is refused when the real host hides after an @", () => {
    expect(redirectAllowed("https://app.example@evil.example/x", request)).toBe(false);
  });

  it("is refused for a subdomain, which is a different host", () => {
    expect(redirectAllowed("https://evil.app.example/x", request)).toBe(false);
  });

  it("is not fooled by case", () => {
    expect(redirectAllowed("HTTPS://EVIL.EXAMPLE/x", request)).toBe(false);
  });

  it("throws rather than redirecting", () => {
    expect(controller().go("https://evil.example/phish")).rejects.toBeInstanceOf(UnsafeRedirect);
  });

  it("says where it would have gone and what it would have left", () => {
    expect(controller().go("https://evil.example/x")).rejects.toThrow(/evil\.example/);
    expect(controller().go("https://evil.example/x")).rejects.toThrow(/app\.example/);
  });

  it("names the way out in the message, since it is sometimes meant", () => {
    expect(controller().go("https://evil.example/x")).rejects.toThrow(/allowOtherHost/);
  });
});

describe("leaving on purpose", () => {
  it("is allowed when asked for", async () => {
    const response = await controller().go("https://stripe.example/checkout", true);

    expect(response.headers.get("location")).toBe("https://stripe.example/checkout");
  });
});

// A divergence from Rails, recorded rather than left to be discovered: Rails
// allows a URL with no host at all, so `javascript:` passes its check. It is
// inert in a Location header, but emitting it is still wrong, and a scheme
// that is genuinely wanted — `myapp://callback` in an OAuth flow — can say so.
describe("a scheme that is not http", () => {
  it("is refused by default", () => {
    expect(redirectAllowed("javascript:alert(1)", request)).toBe(false);
    expect(redirectAllowed("myapp://callback", request)).toBe(false);
  });

  it("is allowed when asked for", async () => {
    const response = await controller().go("myapp://callback", true);

    expect(response.headers.get("location")).toBe("myapp://callback");
  });
});
