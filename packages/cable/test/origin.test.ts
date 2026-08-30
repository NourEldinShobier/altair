/**
 * Who may open a socket, ported from
 * `actioncable/test/connection/cross_site_forgery_test.rb`.
 *
 * The attack these guard against: a WebSocket handshake is not subject to the
 * same-origin policy the way `fetch` is. Any page on any site can open one to
 * `wss://your-app/cable`, the browser attaches the user's cookies, and the
 * handshake succeeds. There is no preflight and no CORS header to stop it.
 * `Origin` is the only signal the server gets, and if the server does not read
 * it, that page is connected as the user — receiving every broadcast they are
 * subscribed to and sending commands under their identity.
 */

import { describe, expect, it } from "bun:test";
import { Cable } from "../src/server.js";
import {
  UnauthorizedConnection,
  allowRequestOrigin,
  originRejectedResponse,
  rejectUnauthorizedConnection,
} from "../src/origin.js";

function handshake(origin: string | null, url = "https://app.test/cable"): Request {
  return new Request(url, origin === null ? undefined : { headers: { origin } });
}

describe("allowRequestOrigin", () => {
  it("allows a page served by the same host", () => {
    expect(allowRequestOrigin(handshake("https://app.test"))).toBe(true);
  });

  /** The whole point. */
  it("refuses a page served by anybody else", () => {
    expect(allowRequestOrigin(handshake("https://evil.test"))).toBe(false);
  });

  it("counts the scheme, so http may not pose as https", () => {
    expect(allowRequestOrigin(handshake("http://app.test"))).toBe(false);
  });

  it("counts the port", () => {
    expect(allowRequestOrigin(handshake("https://app.test:8443"))).toBe(false);
  });

  /**
   * A prefix check would let this through, and the name reads as the real host
   * to anybody skimming.
   */
  it("refuses a host that merely starts with the right one", () => {
    expect(allowRequestOrigin(handshake("https://app.test.evil.test"))).toBe(false);
  });

  it("refuses a subdomain that was not asked for", () => {
    expect(allowRequestOrigin(handshake("https://cdn.app.test"))).toBe(false);
  });

  /**
   * Refused, following Rails. Every browser sends an Origin on a WebSocket
   * handshake, so its absence means the caller is not a browser — and a
   * non-browser caller has no cookies to hijack and can carry a token instead.
   * Allowing it would make the check bypassable by anything able to omit a
   * header, which is everything except the browsers it exists to constrain.
   */
  it("refuses a handshake with no origin at all", () => {
    expect(allowRequestOrigin(handshake(null))).toBe(false);
  });

  it("allows a listed origin", () => {
    const policy = { allowedRequestOrigins: ["https://admin.test"] };

    expect(allowRequestOrigin(handshake("https://admin.test"), policy)).toBe(true);
    expect(allowRequestOrigin(handshake("https://other.test"), policy)).toBe(false);
  });

  /**
   * A listed origin is matched whole, not as a prefix. `https://admin.test`
   * must not admit `https://admin.test.evil.test`, which is a domain anybody
   * can register and which passes a `startsWith` check.
   */
  it("matches a listed origin whole", () => {
    const policy = { allowedRequestOrigins: ["https://admin.test"] };

    expect(allowRequestOrigin(handshake("https://admin.test.evil.test"), policy)).toBe(false);
    expect(allowRequestOrigin(handshake("https://admin.test:9999"), policy)).toBe(false);
  });

  it("takes a regular expression, which is how a dev config names localhost", () => {
    const policy = { allowedRequestOrigins: [/^http:\/\/localhost:\d+$/] };

    expect(allowRequestOrigin(handshake("http://localhost:3000"), policy)).toBe(true);
    expect(allowRequestOrigin(handshake("http://localhost.evil.test"), policy)).toBe(false);
  });

  it("takes a function for anything a pattern cannot say", () => {
    const policy = { allowedRequestOrigins: [(origin: string) => origin.endsWith(".app.test")] };

    expect(allowRequestOrigin(handshake("https://team.app.test"), policy)).toBe(true);
    expect(allowRequestOrigin(handshake("https://team.app.test.evil.test"), policy)).toBe(false);
  });

  /** An application reached by two names should work at both without listing them. */
  it("compares against the url the request actually arrived at", () => {
    const request = handshake("https://alias.test", "https://alias.test/cable");

    expect(allowRequestOrigin(request)).toBe(true);
  });

  it("can be told not to trust its own host", () => {
    const policy = { allowSameOriginAsHost: false };

    expect(allowRequestOrigin(handshake("https://app.test"), policy)).toBe(false);
  });

  it("can be turned off outright", () => {
    const policy = { disableRequestForgeryProtection: true };

    expect(allowRequestOrigin(handshake("https://evil.test"), policy)).toBe(true);
    expect(allowRequestOrigin(handshake(null), policy)).toBe(true);
  });

  /** A socket that never opens is otherwise silent, and looks like a bug. */
  it("says what it refused", () => {
    const refused: (string | null)[] = [];

    allowRequestOrigin(handshake("https://evil.test"), {
      onRejected: (origin) => refused.push(origin),
    });
    allowRequestOrigin(handshake(null), { onRejected: (origin) => refused.push(origin) });

    expect(refused).toEqual(["https://evil.test", null]);
  });

  it("says nothing when it allows", () => {
    const refused: (string | null)[] = [];

    allowRequestOrigin(handshake("https://app.test"), {
      onRejected: (origin) => refused.push(origin),
    });

    expect(refused).toEqual([]);
  });
});

describe("the refusal response", () => {
  /** 403 would confirm there is a cable here and that only the asker was wrong. */
  it("is a 404, so it says nothing about what is at this path", () => {
    expect(originRejectedResponse().status).toBe(404);
  });
});

describe("rejectUnauthorizedConnection", () => {
  it("throws so a connection can refuse from inside a helper", () => {
    expect(() => {
      rejectUnauthorizedConnection();
    }).toThrow(UnauthorizedConnection);
  });

  it("carries a message when given one", () => {
    expect(() => {
      rejectUnauthorizedConnection("not a member of this account");
    }).toThrow("not a member of this account");
  });
});

describe("the cable's handshake", () => {
  it("refuses an upgrade from another site before authorize runs", async () => {
    let asked = false;
    const cable = new Cable({
      authorize: () => {
        asked = true;

        return { request: new Request("https://app.test") } as never;
      },
    });

    expect(await cable.upgradeData(handshake("https://evil.test"))).toBeNull();
    expect(asked).toBe(false);
  });

  it("allows an upgrade from its own host", async () => {
    const cable = new Cable();

    expect(await cable.upgradeData(handshake("https://app.test"))).not.toBeNull();
  });

  it("takes the policy it was configured with", async () => {
    const cable = new Cable({ origins: { allowedRequestOrigins: ["https://admin.test"] } });

    expect(await cable.upgradeData(handshake("https://admin.test"))).not.toBeNull();
    expect(await cable.upgradeData(handshake("https://evil.test"))).toBeNull();
  });

  /** Rejecting is an answer, not a crash: the same answer as returning null. */
  it("treats a rejected connection as a refusal", async () => {
    const cable = new Cable({
      authorize: () => rejectUnauthorizedConnection("suspended"),
    });

    expect(await cable.upgradeData(handshake("https://app.test"))).toBeNull();
  });

  /** Anything else is a bug in authorize and must not read as "not allowed". */
  it("lets an unexpected failure out", async () => {
    const cable = new Cable({
      authorize: () => {
        throw new TypeError("bad session store");
      },
    });

    expect(cable.upgradeData(handshake("https://app.test"))).rejects.toThrow("bad session store");
  });

  it("exposes the check so a caller can answer the handshake itself", () => {
    const cable = new Cable();

    expect(cable.allowRequestOrigin(handshake("https://app.test"))).toBe(true);
    expect(cable.allowRequestOrigin(handshake("https://evil.test"))).toBe(false);
  });
});
