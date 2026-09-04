/**
 * Reading a request, ported from
 * `actionpack/test/dispatch/request_test.rb`.
 *
 * Three of these have a wrong answer that looks right: the domain of a
 * `.co.uk` host, the order of an Accept header, and which entry of
 * `X-Forwarded-For` is the client.
 */

import { describe, expect, it } from "bun:test";
import { Current } from "@altair/support";
import { clientIp } from "../src/client-ip.js";
import {
  acceptedTypes,
  contentMimeType,
  extractDomain,
  extractSubdomain,
  extractSubdomains,
  fullPath,
  isSsl,
  isXhr,
  remoteAddress,
  requestFormat,
} from "../src/request-info.js";

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("the domain", () => {
  it("is the last two labels", () => {
    expect(extractDomain("shop.example.com")).toBe("example.com");
    expect(extractDomain("example.com")).toBe("example.com");
  });

  /**
   * Three labels when the second-to-last is a public suffix. Getting this
   * wrong is how a cookie meant for one site is set for `.co.uk`.
   */
  it("is three when the suffix is two", () => {
    expect(extractDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(extractDomain("example.co.uk")).toBe("example.co.uk");
  });

  it("takes a level count when asked", () => {
    expect(extractDomain("a.b.example.com", 3)).toBe("b.example.com");
  });

  it("leaves a single label alone", () => {
    expect(extractDomain("localhost")).toBe("localhost");
  });
});

describe("subdomains", () => {
  it("are everything in front of the domain", () => {
    expect(extractSubdomains("a.b.example.com")).toEqual(["a", "b"]);
    expect(extractSubdomain("a.b.example.com")).toBe("a.b");
  });

  it("are nothing on a bare domain", () => {
    expect(extractSubdomains("example.com")).toEqual([]);
    expect(extractSubdomain("example.com")).toBe("");
  });

  it("account for a two-part suffix", () => {
    expect(extractSubdomains("shop.example.co.uk")).toEqual(["shop"]);
  });

  // An address is not a name, and slicing labels off one produces nonsense
  // that looks like a subdomain.
  it("are nothing for an address", () => {
    expect(extractSubdomains("192.168.0.1")).toEqual([]);
    expect(extractSubdomains("[::1]")).toEqual([]);
  });
});

describe("what the client sent and wants", () => {
  it("reads the content type without its parameters", () => {
    expect(
      contentMimeType(
        request("https://a.example/", { "content-type": "application/json; charset=utf-8" }),
      ),
    ).toBe("application/json");
    expect(contentMimeType(request("https://a.example/"))).toBeNull();
  });

  /**
   * Sorted by quality, which is the whole point of the header and the part a
   * naive split ignores: `text/html;q=0.8, application/json` prefers JSON, and
   * reading them in order gets it backwards.
   */
  it("puts the most wanted type first", () => {
    const accepted = acceptedTypes(
      request("https://a.example/", { accept: "text/html;q=0.8, application/json" }),
    );

    expect(accepted[0]).toBe("application/json");
  });

  it("keeps the written order when the qualities match", () => {
    expect(
      acceptedTypes(request("https://a.example/", { accept: "text/html, application/json" })),
    ).toEqual(["text/html", "application/json"]);
  });

  it("is empty when nothing was said", () => {
    expect(acceptedTypes(request("https://a.example/"))).toEqual([]);
  });

  it("takes the format from the path before the header", () => {
    expect(requestFormat(request("https://a.example/posts.json", { accept: "text/html" }))).toBe(
      "json",
    );
    expect(requestFormat(request("https://a.example/posts", { accept: "application/json" }))).toBe(
      "json",
    );
    expect(requestFormat(request("https://a.example/posts", { accept: "*/*" }))).toBeNull();
  });
});

/**
 * The client is the last entry a proxy you control did not add. Taking the
 * first trusts a header anybody can send; taking the last trusts your own
 * proxy and nobody else.
 */
describe("where the request came from", () => {
  const chained = (value: string) => request("https://a.example/", { "x-forwarded-for": value });

  /**
   * Nothing, by default. This used to take the last entry, which is the
   * proxy's opinion when there is a proxy and whatever the client typed when
   * there is not — so anyone sending `X-Forwarded-For: 1.2.3.4` was 1.2.3.4.
   */
  it("reads nothing from the header until told how many proxies there are", () => {
    expect(remoteAddress(chained("1.1.1.1, 2.2.2.2, 3.3.3.3"))).toBeNull();
  });

  it("takes the entry your own proxy wrote", () => {
    expect(remoteAddress(chained("1.1.1.1, 2.2.2.2, 3.3.3.3"), { trustedProxies: 1 })).toBe(
      "3.3.3.3",
    );
  });

  it("walks back one more per proxy you control", () => {
    expect(remoteAddress(chained("1.1.1.1, 2.2.2.2, 3.3.3.3"), { trustedProxies: 2 })).toBe(
      "2.2.2.2",
    );
    expect(remoteAddress(chained("1.1.1.1, 2.2.2.2, 3.3.3.3"), { trustedProxies: 3 })).toBe(
      "1.1.1.1",
    );
  });

  /**
   * Fewer entries than declared proxies means the request did not come through
   * them. This used to clamp to the first entry — the one anybody can write,
   * and the exact value counting from the right exists to avoid.
   */
  it("refuses the chain rather than clamping to its first entry", () => {
    expect(remoteAddress(chained("1.1.1.1"), { trustedProxies: 9 })).toBeNull();
  });

  /**
   * One question, one answer. Two implementations of this disagreed by a hop,
   * so an application that rate-limited through one and logged through the
   * other throttled one address and recorded another.
   */
  it("agrees with clientIp, which is the same function underneath", () => {
    const request = chained("1.1.1.1, 2.2.2.2, 3.3.3.3");

    for (const trustedProxies of [0, 1, 2, 3, 9]) {
      expect(remoteAddress(request, { trustedProxies })).toBe(
        clientIp(request, { trustedProxies }) ?? null,
      );
    }
  });

  /**
   * `X-Real-Ip` is the last resort, not the first. It is written by a proxy in
   * a correct deployment and by anybody at all in the rest of them, so an
   * address the resolver could produce always beats it.
   */
  it("prefers a resolved address to the real-ip header", async () => {
    await Current.run({ peerAddress: "203.0.113.9" }, () => {
      expect(remoteAddress(request("https://a.example/", { "x-real-ip": "1.2.3.4" }))).toBe(
        "203.0.113.9",
      );
    });
  });

  it("falls back to the real-ip header", () => {
    expect(remoteAddress(request("https://a.example/", { "x-real-ip": "9.9.9.9" }))).toBe(
      "9.9.9.9",
    );
    expect(remoteAddress(request("https://a.example/"))).toBeNull();
  });
});

describe("the rest", () => {
  it("knows a fetch from a page load", () => {
    expect(isXhr(request("https://a.example/", { "x-requested-with": "XMLHttpRequest" }))).toBe(
      true,
    );
    expect(isXhr(request("https://a.example/", { "sec-fetch-mode": "cors" }))).toBe(true);
    expect(isXhr(request("https://a.example/"))).toBe(false);
  });

  it("gives the path with its query", () => {
    expect(fullPath(request("https://a.example/posts?page=2"))).toBe("/posts?page=2");
    expect(fullPath(request("https://a.example/posts"))).toBe("/posts");
  });

  // Behind a load balancer the connection here is plaintext and the one the
  // person made was not.
  it("takes a proxy's word about TLS", () => {
    expect(isSsl(request("https://a.example/"))).toBe(true);
    expect(isSsl(request("http://a.example/"))).toBe(false);
    expect(isSsl(request("http://a.example/", { "x-forwarded-proto": "https" }))).toBe(true);
  });
});
