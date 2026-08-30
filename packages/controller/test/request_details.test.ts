/**
 * Request introspection, ported from
 * `actionpack/test/dispatch/request_test.rb` and
 * `actionpack/test/dispatch/request/cache_control_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  cacheControlDirectives,
  hasContentType,
  idempotentMethod,
  ifModifiedSince,
  ifNoneMatch,
  ifNoneMatchEtags,
  isLocal,
  maxStale,
  mediaType,
  mustUnderstand,
  noCache,
  noTransform,
  onlyIfCached,
  originalUrl,
  port,
  protocol,
  queryString,
  requestMethod,
  requestUri,
  safeMethod,
  unsafeMethod,
} from "../src/request_details.js";

function get(url = "https://example.com/posts", init: RequestInit = {}): Request {
  return new Request(url, init);
}

describe("the method", () => {
  it("normalises to upper case", () => {
    expect(requestMethod(get("https://example.com/", { method: "post" }))).toBe("POST");
  });

  it("calls GET and HEAD safe", () => {
    expect(safeMethod(get())).toBe(true);
    expect(safeMethod(get("https://example.com/", { method: "HEAD" }))).toBe(true);
  });

  /** A check written inline is not obviously wrong when it forgets TRACE. */
  it("calls OPTIONS safe too", () => {
    expect(safeMethod(get("https://example.com/", { method: "OPTIONS" }))).toBe(true);
  });

  it("calls POST and DELETE unsafe", () => {
    expect(unsafeMethod(get("https://example.com/", { method: "POST" }))).toBe(true);
    expect(unsafeMethod(get("https://example.com/", { method: "DELETE" }))).toBe(true);
  });

  /** PUT is unsafe but repeatable; POST is neither. */
  it("separates idempotent from safe", () => {
    expect(idempotentMethod(get("https://example.com/", { method: "PUT" }))).toBe(true);
    expect(safeMethod(get("https://example.com/", { method: "PUT" }))).toBe(false);
    expect(idempotentMethod(get("https://example.com/", { method: "POST" }))).toBe(false);
  });
});

describe("the URL", () => {
  it("gives the query string without the question mark", () => {
    expect(queryString(get("https://example.com/posts?page=2&q=a"))).toBe("page=2&q=a");
  });

  it("gives an empty query string when there is none", () => {
    expect(queryString(get())).toBe("");
  });

  it("gives the path and query without the host", () => {
    expect(requestUri(get("https://example.com/posts?page=2"))).toBe("/posts?page=2");
  });

  it("gives the URL as it arrived", () => {
    expect(originalUrl(get("https://example.com/posts?page=2"))).toBe(
      "https://example.com/posts?page=2",
    );
  });

  it("gives the scheme without a colon", () => {
    expect(protocol(get())).toBe("https");
    expect(protocol(get("http://example.com/"))).toBe("http");
  });

  /** A URL omits the port when it is the default, so reading it raw gives "". */
  it("fills the port in from the scheme", () => {
    expect(port(get("https://example.com/"))).toBe(443);
    expect(port(get("http://example.com/"))).toBe(80);
  });

  it("uses an explicit port when there is one", () => {
    expect(port(get("http://example.com:3000/"))).toBe(3000);
  });
});

describe("isLocal", () => {
  it("recognises loopback", () => {
    expect(isLocal(get("http://127.0.0.1:3000/"))).toBe(true);
    expect(isLocal(get("http://localhost:3000/"))).toBe(true);
    expect(isLocal(get("http://[::1]:3000/"))).toBe(true);
  });

  /** Anything broader would show stack traces to the rest of the network. */
  it("does not treat a private address as local", () => {
    expect(isLocal(get("http://192.168.1.5/"))).toBe(false);
  });

  it("does not treat a public host as local", () => {
    expect(isLocal(get("https://example.com/"))).toBe(false);
  });
});

describe("mediaType", () => {
  /** Comparing the whole header fails on requests that spell the charset out. */
  it("drops the parameters", () => {
    const request = get("https://example.com/", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    expect(mediaType(request)).toBe("application/json");
  });

  it("lower-cases it", () => {
    const request = get("https://example.com/", {
      method: "POST",
      headers: { "content-type": "Application/JSON" },
    });

    expect(mediaType(request)).toBe("application/json");
  });

  it("gives null when none was declared", () => {
    expect(mediaType(get())).toBeNull();
    expect(hasContentType(get())).toBe(false);
  });
});

describe("cache control", () => {
  function withCacheControl(value: string): Request {
    return get("https://example.com/", { headers: { "cache-control": value } });
  }

  it("parses a bare directive as true", () => {
    expect(cacheControlDirectives(withCacheControl("no-cache"))).toEqual({ "no-cache": true });
  });

  it("parses a valued directive", () => {
    expect(cacheControlDirectives(withCacheControl("max-age=60"))).toEqual({ "max-age": "60" });
  });

  it("parses several", () => {
    expect(cacheControlDirectives(withCacheControl("no-cache, max-age=0, no-store"))).toEqual({
      "no-cache": true,
      "max-age": "0",
      "no-store": true,
    });
  });

  it("unquotes a value", () => {
    expect(cacheControlDirectives(withCacheControl('private="set-cookie"'))).toEqual({
      private: "set-cookie",
    });
  });

  it("lower-cases the names", () => {
    expect(cacheControlDirectives(withCacheControl("No-Cache"))).toEqual({ "no-cache": true });
  });

  it("gives nothing when the header is absent", () => {
    expect(cacheControlDirectives(get())).toEqual({});
  });

  it("answers the named questions", () => {
    expect(noCache(withCacheControl("no-cache"))).toBe(true);
    expect(onlyIfCached(withCacheControl("only-if-cached"))).toBe(true);
    expect(noTransform(withCacheControl("no-transform"))).toBe(true);
    expect(mustUnderstand(withCacheControl("must-understand"))).toBe(true);
    expect(noCache(get())).toBe(false);
  });

  it("reads max-stale as a number", () => {
    expect(maxStale(withCacheControl("max-stale=30"))).toBe(30);
  });

  /** Bare max-stale means any staleness, which is not the same as zero. */
  it("reads a bare max-stale as unlimited", () => {
    expect(maxStale(withCacheControl("max-stale"))).toBe("unlimited");
  });

  it("keeps zero distinguishable from unlimited", () => {
    expect(maxStale(withCacheControl("max-stale=0"))).toBe(0);
  });

  it("gives null when it is absent", () => {
    expect(maxStale(get())).toBeNull();
  });
});

describe("conditional headers", () => {
  it("parses If-Modified-Since", () => {
    const request = get("https://example.com/", {
      headers: { "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });

    expect(ifModifiedSince(request)?.toISOString()).toBe("2026-10-21T07:28:00.000Z");
  });

  it("gives null for an unparseable date", () => {
    const request = get("https://example.com/", { headers: { "if-modified-since": "not a date" } });

    expect(ifModifiedSince(request)).toBeNull();
  });

  it("gives null when absent", () => {
    expect(ifModifiedSince(get())).toBeNull();
    expect(ifNoneMatch(get())).toBeNull();
    expect(ifNoneMatchEtags(get())).toEqual([]);
  });

  /** The client sends back what the server gave it, quotes and all. */
  it("unquotes the etags", () => {
    const request = get("https://example.com/", { headers: { "if-none-match": '"abc", "def"' } });

    expect(ifNoneMatchEtags(request)).toEqual(["abc", "def"]);
  });

  it("strips the weakness marker", () => {
    const request = get("https://example.com/", { headers: { "if-none-match": 'W/"abc"' } });

    expect(ifNoneMatchEtags(request)).toEqual(["abc"]);
  });

  it("leaves a star alone", () => {
    const request = get("https://example.com/", { headers: { "if-none-match": "*" } });

    expect(ifNoneMatchEtags(request)).toEqual(["*"]);
  });
});
