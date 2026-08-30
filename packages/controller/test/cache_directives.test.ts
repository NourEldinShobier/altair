/**
 * Caching directives beyond a plain expiry, ported from
 * `actionpack/test/controller/caching_test.rb` and the etag cases in
 * `actionpack/test/dispatch/request_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  FOREVER_SECONDS,
  acceptsUnlimitedStale,
  addVary,
  httpCacheForever,
  isStrongEtag,
  shouldApplyVaryHeader,
  strongEtag,
  weakEtag,
} from "../src/cache_directives.js";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/posts", { headers });
}

describe("etags", () => {
  it("marks a weak one", () => {
    expect(weakEtag("x").startsWith('W/"')).toBe(true);
  });

  it("leaves a strong one unmarked", () => {
    expect(strongEtag("x").startsWith('"')).toBe(true);
  });

  it("quotes both, as the header requires", () => {
    expect(weakEtag("x").endsWith('"')).toBe(true);
    expect(strongEtag("x").endsWith('"')).toBe(true);
  });

  it("gives the same digest for the same value", () => {
    expect(strongEtag("x")).toBe(strongEtag("x"));
  });

  it("gives different digests for different values", () => {
    expect(strongEtag("x")).not.toBe(strongEtag("y"));
  });

  /** The same content, said two ways: only the marker differs. */
  it("differs only by the marker for one value", () => {
    expect(weakEtag("x")).toBe(`W/${strongEtag("x")}`);
  });

  it("takes a record, as the conditional-get helpers do", () => {
    const record = { id: 1, updated_at: new Date("2026-01-01") };

    expect(strongEtag(record)).toBe(strongEtag({ id: 1, updated_at: new Date("2026-01-01") }));
  });

  /**
   * A range request may only be served against a strong etag, so telling them
   * apart is what decides whether a resumed download resumes or restarts.
   */
  it("says which is which", () => {
    expect(isStrongEtag(strongEtag("x"))).toBe(true);
    expect(isStrongEtag(weakEtag("x"))).toBe(false);
  });

  it("recognises a weak marker with leading space", () => {
    expect(isStrongEtag(' W/"abc"')).toBe(false);
  });
});

describe("httpCacheForever", () => {
  it("asks for a year", () => {
    expect(httpCacheForever()["cache-control"]).toContain(`max-age=${String(FOREVER_SECONDS)}`);
  });

  /**
   * Without it a browser still revalidates on reload — a round trip per asset
   * per reload that can only ever answer 304, paid most by the page a
   * developer reloads most.
   */
  it("says immutable", () => {
    expect(httpCacheForever()["cache-control"]).toContain("immutable");
  });

  it("is private by default, as in Rails", () => {
    expect(httpCacheForever()["cache-control"]).toContain("private");
  });

  it("can be public, for an asset a shared cache should keep", () => {
    const value = httpCacheForever({ public: true })["cache-control"];

    expect(value).toContain("public");
    expect(value).not.toContain("private");
  });

  it("is a year, which is the longest caches are asked to honour", () => {
    expect(FOREVER_SECONDS).toBe(31_536_000);
  });
});

describe("shouldApplyVaryHeader", () => {
  /**
   * The failure: a shared cache handing a JSON body to a browser that asked
   * for HTML, because nothing told it the two requests differed.
   */
  it("says yes when the response was negotiated", () => {
    expect(shouldApplyVaryHeader(true, null)).toBe(true);
  });

  /**
   * A cache split by Accept is a cache with roughly one entry per browser
   * version, so splitting it for a response that would have been the same
   * either way costs everything and buys nothing.
   */
  it("says no when it was not", () => {
    expect(shouldApplyVaryHeader(false, null)).toBe(false);
  });

  it("says no when Accept is already named", () => {
    expect(shouldApplyVaryHeader(true, "Accept")).toBe(false);
    expect(shouldApplyVaryHeader(true, "accept-encoding, accept")).toBe(false);
  });

  it("says yes when something else is named", () => {
    expect(shouldApplyVaryHeader(true, "Accept-Encoding")).toBe(true);
  });
});

describe("addVary", () => {
  it("adds to nothing", () => {
    expect(addVary(null, "Accept")).toBe("accept");
    expect(addVary("", "Accept")).toBe("accept");
  });

  it("keeps what was there", () => {
    expect(addVary("Accept-Encoding", "Accept")).toBe("accept-encoding, accept");
  });

  it("does not add one twice", () => {
    expect(addVary("accept, accept-encoding", "Accept")).toBe("accept, accept-encoding");
  });

  it("ignores case", () => {
    expect(addVary("ACCEPT", "accept")).toBe("accept");
  });

  /** Naming a header beside `*` says less than `*` already did. */
  it("leaves a wildcard alone", () => {
    expect(addVary("*", "Accept")).toBe("*");
  });

  it("tidies stray spaces and empties", () => {
    expect(addVary("accept ,, ", "accept-encoding")).toBe("accept, accept-encoding");
  });
});

describe("acceptsUnlimitedStale", () => {
  it("recognises a bare max-stale", () => {
    expect(acceptsUnlimitedStale(request({ "cache-control": "max-stale" }))).toBe(true);
  });

  /** `max-stale=600` is bounded and means something quite different. */
  it("does not treat a bounded max-stale as unlimited", () => {
    expect(acceptsUnlimitedStale(request({ "cache-control": "max-stale=600" }))).toBe(false);
  });

  it("finds it among other directives", () => {
    expect(acceptsUnlimitedStale(request({ "cache-control": "no-cache, max-stale" }))).toBe(true);
  });

  it("says no when there is no cache-control at all", () => {
    expect(acceptsUnlimitedStale(request())).toBe(false);
  });

  it("says no for an unrelated directive", () => {
    expect(acceptsUnlimitedStale(request({ "cache-control": "no-store" }))).toBe(false);
  });
});
