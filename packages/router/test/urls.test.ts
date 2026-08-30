/**
 * Escaping the pieces of a URL, and making a path absolute. Ported from
 * `actionpack/test/journey/router/utils_test.rb` and the `url_for` host cases
 * in `actionpack/test/controller/url_for_test.rb`.
 *
 * A URL is not one string with one escaping rule. `encodeURIComponent` escapes
 * everything that could be a delimiter anywhere in a URL, which in a path
 * segment is too much.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Route } from "../src/route.js";
import {
  MissingHost,
  canBuildFullUrl,
  defaultUrlOptions,
  escapeFragment,
  escapePath,
  escapeSegment,
  fullUrlFor,
  resetDefaultUrlOptions,
  setDefaultUrlOptions,
} from "../src/urls.js";

afterEach(() => {
  resetDefaultUrlOptions();
});

describe("escapeSegment", () => {
  /**
   * The whole point: a value containing one would otherwise add a segment, and
   * `/posts/a/b` is a different route from `/posts/a%2Fb` — the first probably
   * a 404 and the second the record somebody meant.
   */
  it("escapes a slash", () => {
    expect(escapeSegment("a/b")).toBe("a%2Fb");
  });

  /** Legal in a path segment, so escaping them makes an uglier URL for nothing. */
  it("leaves the characters a segment allows", () => {
    expect(escapeSegment("report:2026")).toBe("report:2026");
    expect(escapeSegment("a@b")).toBe("a@b");
    expect(escapeSegment("a=b")).toBe("a=b");
    expect(escapeSegment("a+b")).toBe("a+b");
    expect(escapeSegment("a,b")).toBe("a,b");
  });

  it("escapes a space", () => {
    expect(escapeSegment("a b")).toBe("a%20b");
  });

  it("escapes a question mark, which would start a query", () => {
    expect(escapeSegment("a?b")).toBe("a%3Fb");
  });

  it("escapes a hash, which would start a fragment", () => {
    expect(escapeSegment("a#b")).toBe("a%23b");
  });

  it("leaves an ordinary slug alone", () => {
    expect(escapeSegment("my-first-post")).toBe("my-first-post");
  });

  it("escapes something that is not ascii", () => {
    expect(escapeSegment("café")).toBe("caf%C3%A9");
  });

  it("survives an empty string", () => {
    expect(escapeSegment("")).toBe("");
  });
});

describe("escapePath", () => {
  /** Here a slash is a separator rather than data. */
  it("keeps a slash", () => {
    expect(escapePath("a/b")).toBe("a/b");
  });

  it("still escapes a space", () => {
    expect(escapePath("a b/c")).toBe("a%20b/c");
  });

  it("still escapes a question mark", () => {
    expect(escapePath("a/b?c")).toBe("a/b%3Fc");
  });
});

describe("escapeFragment", () => {
  it("keeps a question mark, which is ordinary after a hash", () => {
    expect(escapeFragment("a?b")).toBe("a?b");
  });

  it("keeps a slash", () => {
    expect(escapeFragment("a/b")).toBe("a/b");
  });

  it("still escapes a space", () => {
    expect(escapeFragment("a b")).toBe("a%20b");
  });
});

describe("fullUrlFor", () => {
  it("puts a host in front of a path", () => {
    expect(fullUrlFor("/posts", { host: "app.test" })).toBe("https://app.test/posts");
  });

  it("takes a protocol", () => {
    expect(fullUrlFor("/posts", { host: "app.test", protocol: "http" })).toBe(
      "http://app.test/posts",
    );
  });

  it("tolerates a protocol written with its punctuation", () => {
    expect(fullUrlFor("/posts", { host: "app.test", protocol: "http://" })).toBe(
      "http://app.test/posts",
    );
  });

  it("takes a port", () => {
    expect(fullUrlFor("/posts", { host: "app.test", port: 8080 })).toBe(
      "https://app.test:8080/posts",
    );
  });

  /**
   * A URL carrying :443 is the same URL and does not look like it: it will not
   * match a canonical tag, an OAuth redirect registration, or a cookie's
   * domain check, each of which fails naming something else.
   */
  it("leaves off the default port for the scheme", () => {
    expect(fullUrlFor("/a", { host: "app.test", port: 443 })).toBe("https://app.test/a");
    expect(fullUrlFor("/a", { host: "app.test", protocol: "http", port: 80 })).toBe(
      "http://app.test/a",
    );
  });

  it("keeps a non-default port for the scheme", () => {
    expect(fullUrlFor("/a", { host: "app.test", protocol: "http", port: 443 })).toBe(
      "http://app.test:443/a",
    );
  });

  it("prefixes a script name", () => {
    expect(fullUrlFor("/posts", { host: "app.test", scriptName: "/admin" })).toBe(
      "https://app.test/admin/posts",
    );
  });

  it("tolerates a script name written without its slash", () => {
    expect(fullUrlFor("/posts", { host: "app.test", scriptName: "admin/" })).toBe(
      "https://app.test/admin/posts",
    );
  });

  it("adds the leading slash to a path that has none", () => {
    expect(fullUrlFor("posts", { host: "app.test" })).toBe("https://app.test/posts");
  });

  it("uses what was configured", () => {
    setDefaultUrlOptions({ host: "app.test", protocol: "http" });

    expect(fullUrlFor("/posts")).toBe("http://app.test/posts");
  });

  it("lets a call override what was configured", () => {
    setDefaultUrlOptions({ host: "app.test" });

    expect(fullUrlFor("/posts", { host: "other.test" })).toBe("https://other.test/posts");
  });

  /**
   * A URL built against a guessed host is a link that goes somewhere wrong,
   * sent to somebody, and discovered by them.
   */
  it("refuses to guess a host", () => {
    expect(() => fullUrlFor("/posts")).toThrow(MissingHost);
  });

  it("says where to set one", () => {
    expect(() => fullUrlFor("/posts")).toThrow("setDefaultUrlOptions");
  });

  it("refuses an empty host too", () => {
    expect(() => fullUrlFor("/posts", { host: "" })).toThrow(MissingHost);
  });
});

describe("defaultUrlOptions", () => {
  it("starts empty", () => {
    expect(defaultUrlOptions()).toEqual({});
  });

  it("gives back what was set", () => {
    setDefaultUrlOptions({ host: "app.test" });

    expect(defaultUrlOptions().host).toBe("app.test");
  });

  it("gives a copy, so a caller cannot write through it", () => {
    setDefaultUrlOptions({ host: "app.test" });

    defaultUrlOptions().host = "changed";

    expect(defaultUrlOptions().host).toBe("app.test");
  });

  it("says whether a full url could be built", () => {
    expect(canBuildFullUrl()).toBe(false);

    setDefaultUrlOptions({ host: "app.test" });

    expect(canBuildFullUrl()).toBe(true);
  });

  it("counts a host given at the call", () => {
    expect(canBuildFullUrl({ host: "app.test" })).toBe(true);
  });
});

/**
 * The escaper is not a spare part: route generation goes through it, which is
 * the only reason the distinction above is visible to anybody.
 */
describe("route generation", () => {
  const route = new Route("GET", "/files/:name", "files", "show");

  it("leaves a colon in a segment alone", () => {
    expect(route.format({ name: "report:2026" })).toBe("/files/report:2026");
  });

  it("still escapes a slash, which would otherwise add a segment", () => {
    expect(route.format({ name: "a/b" })).toBe("/files/a%2Fb");
  });

  it("still escapes a space", () => {
    expect(route.format({ name: "my report" })).toBe("/files/my%20report");
  });
});
