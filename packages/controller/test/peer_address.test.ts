/**
 * The address the connection came from, ported from `ActionDispatch::Request#ip`
 * and the `REMOTE_ADDR` handling in `ActionDispatch::RemoteIp`.
 *
 * `client_ip.ts` has always taken a `socketAddress` and documented what it is
 * for: "the default is to trust nothing and use the socket address, because an
 * application that has not been told its shape is an application behind zero
 * proxies until somebody says otherwise."
 *
 * Nothing supplied it. `Bun.serve` hands the fetch handler a server that can
 * answer `requestIP`, and the handler never asked, so the default resolved to
 * undefined and every address in the process fell through to `X-Real-Ip` — a
 * header any client can write. The file exists to stop an address being read
 * out of a header a client wrote, and that is what it was doing.
 *
 * These pin the two halves: that the peer is observed and carried, and that
 * both resolvers start from it.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { clientIp } from "../src/client_ip.js";
import { remoteAddr, remoteIp } from "../src/request_body.js";

const from = (headers: Record<string, string> = {}): Request =>
  new Request("https://example.com/", { headers });

describe("with an address observed on the socket", () => {
  it("is what clientIp answers when no proxies were declared", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(clientIp(from())).toBe("203.0.113.9");
    });
  });

  /** The point: a forged header does not become the answer. */
  it("beats an X-Forwarded-For nobody was told to trust", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(clientIp(from({ "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.9");
    });
  });

  it("beats an X-Real-Ip in remoteAddr", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(remoteAddr(from({ "x-real-ip": "1.2.3.4" }))).toBe("203.0.113.9");
    });
  });

  it("is the floor remoteIp falls back to", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(remoteIp(from({ "x-real-ip": "1.2.3.4" }))).toBe("203.0.113.9");
    });
  });

  /**
   * Still a default, not a decision: a caller who knows better says so, which
   * is what a test and a proxy-terminating middleware both need.
   */
  it("gives way to an address the caller passed", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(clientIp(from(), { socketAddress: "198.51.100.1" })).toBe("198.51.100.1");
    });
  });

  /** Declared proxies still win, because that is the deployment speaking. */
  it("is stepped past when proxies were declared", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      const request = from({ "x-forwarded-for": "1.2.3.4, 198.51.100.1" });

      expect(clientIp(request, { trustedProxies: 1 })).toBe("198.51.100.1");
    });
  });

  /**
   * Fewer entries than declared proxies means the request did not come through
   * them, and the observed address is the honest answer.
   */
  it("is the answer again when the chain is shorter than declared", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      const request = from({ "x-forwarded-for": "1.2.3.4" });

      expect(clientIp(request, { trustedProxies: 3 })).toBe("203.0.113.9");
    });
  });
});

describe("with nothing observed", () => {
  it("leaves clientIp with no answer rather than a forged one", () => {
    expect(clientIp(from({ "x-forwarded-for": "1.2.3.4" }))).toBeUndefined();
  });

  /**
   * `X-Real-Ip` stays as the last resort. It is right in a deployment where a
   * proxy writes it and this process is not reachable directly, and there is
   * nothing better to offer when the socket said nothing.
   */
  it("falls back to the header in remoteAddr, which is what it is for", () => {
    expect(remoteAddr(from({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("answers null when there is not even that", () => {
    expect(remoteAddr(from())).toBeNull();
  });
});

describe("scoping", () => {
  /** One request's peer must never leak into the request running beside it. */
  it("does not escape the request it belongs to", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(clientIp(from())).toBe("203.0.113.9");
    });

    expect(clientIp(from())).toBeUndefined();
  });
});
