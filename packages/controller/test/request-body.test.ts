/**
 * Reading a request's body, and the parts of it that identify the caller.
 * Ported from `actionpack/test/dispatch/request_test.rb` — the `raw_post`,
 * `fullpath`, `subdomains` and `remote_ip` cases.
 *
 * The body is the interesting one. `Request.body` is a stream and consuming it
 * consumes it, so the second thing that wants it gets nothing and reports
 * "missing parameter" rather than "somebody read this already".
 */

import { describe, expect, it } from "bun:test";
import {
  BodyStream,
  bodyRead,
  domainFrom,
  forgetBody,
  fullpath,
  isPrivateAddress,
  originalFullpath,
  rawPost,
  remoteAddr,
  remoteIp,
  serverSoftware,
  subdomainsFrom,
  urlFrom,
  userAgent,
  xmlHttpRequest,
} from "../src/request-body.js";

function posting(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/posts", { method: "POST", body, headers });
}

describe("reading the body", () => {
  it("gives it as a string", async () => {
    expect(await rawPost(posting('{"a":1}'))).toBe('{"a":1}');
  });

  /**
   * The whole point. Two readers is the ordinary case — a parser and an error
   * reporter, a signature check and everything after it.
   */
  it("gives the same body to a second reader", async () => {
    const request = posting("once only");

    expect(await rawPost(request)).toBe("once only");
    expect(await rawPost(request)).toBe("once only");
  });

  it("leaves the original request readable", async () => {
    const request = posting("still here");

    await rawPost(request);

    expect(await request.text()).toBe("still here");
  });

  it("says whether it has been read", async () => {
    const request = posting("x");

    expect(bodyRead(request)).toBe(false);

    await rawPost(request);

    expect(bodyRead(request)).toBe(true);
  });

  it("can be forgotten", async () => {
    const request = posting("x");
    await rawPost(request);

    forgetBody(request);

    expect(bodyRead(request)).toBe(false);
  });

  /**
   * The case the cache is actually for. Once something else has consumed the
   * stream, re-reading it is not possible — only the kept copy can answer.
   */
  it("still gives the body after the original stream was consumed", async () => {
    const request = posting("kept");
    await rawPost(request);

    await request.text();

    expect(await rawPost(request)).toBe("kept");
  });

  it("keeps two requests' bodies apart", async () => {
    expect(await rawPost(posting("first"))).toBe("first");
    expect(await rawPost(posting("second"))).toBe("second");
  });

  it("handles an empty body", async () => {
    expect(await rawPost(new Request("https://app.test/posts"))).toBe("");
  });
});

describe("a stream over the body", () => {
  it("reads it all", () => {
    expect(new BodyStream("hello").read()).toBe("hello");
  });

  it("reads a fixed number of characters", () => {
    const stream = new BodyStream("hello");

    expect(stream.read(2)).toBe("he");
    expect(stream.read(2)).toBe("ll");
  });

  it("stops at the end rather than past it", () => {
    const stream = new BodyStream("hi");

    expect(stream.read(10)).toBe("hi");
    expect(stream.read(10)).toBe("");
  });

  it("says when it is done", () => {
    const stream = new BodyStream("hi");

    expect(stream.eof()).toBe(false);

    stream.read();

    expect(stream.eof()).toBe(true);
  });

  it("is done immediately for an empty body", () => {
    expect(new BodyStream("").eof()).toBe(true);
  });

  /** What a middleware that peeked at the body owes the one after it. */
  it("goes back to the beginning", () => {
    const stream = new BodyStream("hello");
    stream.read();

    stream.rewind();

    expect(stream.eof()).toBe(false);
    expect(stream.read()).toBe("hello");
  });

  it("reports where it is", () => {
    const stream = new BodyStream("hello");
    stream.read(3);

    expect(stream.position).toBe(3);
    expect(stream.length).toBe(5);
  });

  /** Or `position` outruns `length`, and anything reporting progress lies. */
  it("does not let the position run past the end", () => {
    const stream = new BodyStream("hi");
    stream.read(10);

    expect(stream.position).toBe(2);
  });

  it("can be built from a request", async () => {
    expect((await BodyStream.of(posting("from a request"))).read()).toBe("from a request");
  });
});

describe("the path", () => {
  /**
   * Together, or a cache key treats `/posts?page=2` and `/posts` as the same
   * request and page two is served from page one's cache.
   */
  it("keeps the query string", () => {
    expect(fullpath(new Request("https://app.test/posts?page=2"))).toBe("/posts?page=2");
  });

  it("is just the path when there is no query", () => {
    expect(fullpath(new Request("https://app.test/posts"))).toBe("/posts");
  });

  it("is the same before a rewrite when nothing rewrote it", () => {
    expect(originalFullpath(new Request("https://app.test/posts"))).toBe("/posts");
  });

  /** The rewritten path is the wrong thing to log and to build a canonical URL from. */
  it("reports what a proxy rewrote", () => {
    const request = new Request("https://app.test/en/posts", {
      headers: { "x-original-url": "/posts" },
    });

    expect(originalFullpath(request)).toBe("/posts");
  });
});

describe("who sent it", () => {
  it("reports the user agent", () => {
    expect(
      userAgent(new Request("https://app.test", { headers: { "user-agent": "curl/8" } })),
    ).toBe("curl/8");
  });

  it("reports none when there is none", () => {
    expect(userAgent(new Request("https://app.test"))).toBeNull();
  });

  /** A hint, never evidence: the header is set by whatever is making the call. */
  it("recognises an XHR", () => {
    const xhr = new Request("https://app.test", {
      headers: { "x-requested-with": "XMLHttpRequest" },
    });

    expect(xmlHttpRequest(xhr)).toBe(true);
  });

  it("ignores its case", () => {
    const xhr = new Request("https://app.test", {
      headers: { "x-requested-with": "xmlhttprequest" },
    });

    expect(xmlHttpRequest(xhr)).toBe(true);
  });

  it("is false for an ordinary request", () => {
    expect(xmlHttpRequest(new Request("https://app.test"))).toBe(false);
  });

  it("takes the connection address over any header", () => {
    const request = new Request("https://app.test", { headers: { "x-real-ip": "1.2.3.4" } });

    expect(remoteAddr(request, "9.9.9.9")).toBe("9.9.9.9");
  });

  it("falls back to the header when there is no connection address", () => {
    const request = new Request("https://app.test", { headers: { "x-real-ip": "1.2.3.4" } });

    expect(remoteAddr(request)).toBe("1.2.3.4");
  });

  /**
   * Anything can send `X-Forwarded-For: 1.2.3.4`, so an entry naming a private
   * address is a hop inside your own network and never the client — reporting
   * one is how a rate limiter throttles the load balancer.
   */
  it("knows which addresses are not routable", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
  });

  it("knows which are", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });

  /**
   * Nothing is trusted until the deployment says how many proxies are in front
   * of it. A default that reads the header lets a client name its own address
   * in exactly the applications that never configured one.
   */
  it("ignores the forwarded header until proxies are declared", () => {
    const request = new Request("https://app.test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });

    expect(remoteIp(request)).toBeNull();
  });

  it("resolves the client's address once they are", () => {
    const request = new Request("https://app.test", {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.1" },
    });

    expect(remoteIp(request, { trustedProxies: 1, socketAddress: "10.0.0.1" })).toBe("10.0.0.1");
  });

  it("falls back to the direct address when nothing resolves", () => {
    const request = new Request("https://app.test", { headers: { "x-real-ip": "5.6.7.8" } });

    expect(remoteIp(request)).toBe("5.6.7.8");
  });

  it("names the server software", () => {
    expect(serverSoftware(new Headers({ server: "nginx/1.25.3" }))).toBe("nginx");
  });

  it("reports none when the response does not say", () => {
    expect(serverSoftware(new Headers())).toBeNull();
  });
});

describe("host parts", () => {
  it("reports the subdomains", () => {
    expect(subdomainsFrom("api.staging.app.test")).toEqual(["api", "staging"]);
  });

  it("reports none for a bare domain", () => {
    expect(subdomainsFrom("app.test")).toEqual([]);
  });

  /** Splitting an address on dots gives four "labels" that mean nothing. */
  it("reports none for an address", () => {
    expect(subdomainsFrom("192.168.1.1")).toEqual([]);
    expect(domainFrom("192.168.1.1")).toBeNull();
  });

  it("takes a longer suffix", () => {
    expect(subdomainsFrom("api.app.co.uk", 2)).toEqual(["api"]);
  });

  it("reports the registrable domain", () => {
    expect(domainFrom("api.staging.app.test")).toBe("app.test");
    expect(domainFrom("app.co.uk", 2)).toBe("app.co.uk");
  });

  it("reports none for a single label", () => {
    expect(domainFrom("localhost")).toBeNull();
  });
});

describe("building a url", () => {
  it("puts the parts together", () => {
    expect(urlFrom({ host: "app.test", path: "/posts" })).toBe("https://app.test/posts");
  });

  it("takes a protocol and a port", () => {
    expect(urlFrom({ protocol: "http", host: "app.test", port: 8080, path: "/a" })).toBe(
      "http://app.test:8080/a",
    );
  });

  /** A URL carrying `:443` is the same URL and does not look like it. */
  it("leaves off the default port for the scheme", () => {
    expect(urlFrom({ host: "app.test", port: 443, path: "/a" })).toBe("https://app.test/a");
    expect(urlFrom({ protocol: "http", host: "app.test", port: 80, path: "/a" })).toBe(
      "http://app.test/a",
    );
  });

  it("keeps a non-default port", () => {
    expect(urlFrom({ protocol: "http", host: "app.test", port: 443, path: "/a" })).toBe(
      "http://app.test:443/a",
    );
  });

  it("adds a query string", () => {
    expect(urlFrom({ host: "app.test", path: "/a", query: "page=2" })).toBe(
      "https://app.test/a?page=2",
    );
  });

  it("tolerates a query written with its question mark", () => {
    expect(urlFrom({ host: "app.test", path: "/a", query: "?page=2" })).toBe(
      "https://app.test/a?page=2",
    );
  });

  it("tolerates a protocol written with its punctuation", () => {
    expect(urlFrom({ protocol: "http://", host: "app.test" })).toBe("http://app.test");
  });
});
