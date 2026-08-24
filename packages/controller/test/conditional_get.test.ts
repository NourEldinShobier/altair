/**
 * HTTP caching.
 *
 * Mirrors actionpack/test/controller/conditional_get_test.rb, plus the parts
 * of RFC 9110 that the Rails suite takes for granted — weak comparison and
 * second-resolution dates, both of which quietly disable the whole mechanism
 * when they are wrong.
 */

import { describe, expect, it } from "bun:test";
import { Controller } from "../src/controller.js";
import {
  cacheControl,
  etagFor,
  etagMatches,
  etagSource,
  freshnessFor,
  notModifiedSince,
} from "../src/conditional_get.js";

const MODIFIED = new Date("2026-01-15T12:00:00Z");

const get = (headers: Record<string, string> = {}) =>
  new Request("http://test.host/posts/1", { headers });

class PostsController extends Controller {
  static post = { id: 1, updated_at: MODIFIED };

  show(): void {
    if (this.stale({ etag: PostsController.post, lastModified: MODIFIED })) {
      this.render.json({ title: "rendered" });
    }
  }

  listing(): void {
    this.expiresIn(300, { public: true });
    this.render.json({ posts: [] });
  }
}

const run = async (request: Request, action: "show" | "listing") =>
  await new PostsController({ request, session: {} }).processAction(action);

describe("what an etag is built from", () => {
  it("takes a string as given", () => {
    expect(etagSource("v1")).toBe("v1");
  });

  // A model knows what makes it a version; an id alone never changes when the
  // record does, which is worse than no etag — the browser keeps a stale page.
  it("prefers a record's own cache key", () => {
    expect(etagSource({ cacheKey: () => "posts/1-20260115120000", id: 9 })).toBe(
      "posts/1-20260115120000",
    );
  });

  it("falls back to the id and the timestamp", () => {
    expect(etagSource({ id: 1, updated_at: MODIFIED })).toContain("2026-01-15");
  });

  it("combines a list, so a collection gets one etag", () => {
    const one = etagSource([
      { id: 1, updated_at: MODIFIED },
      { id: 2, updated_at: MODIFIED },
    ]);
    const two = etagSource([
      { id: 1, updated_at: MODIFIED },
      { id: 3, updated_at: MODIFIED },
    ]);

    expect(one).not.toBe(two);
  });

  it("changes when the record does", () => {
    const before = etagFor({ id: 1, updated_at: MODIFIED });
    const after = etagFor({ id: 1, updated_at: new Date("2026-02-01T00:00:00Z") });

    expect(before).not.toBe(after);
  });

  // Nothing that renders a template can honestly promise identical octets.
  it("is weak by default", () => {
    expect(etagFor("v1")).toStartWith('W/"');
    expect(etagFor("v1", false)).toStartWith('"');
  });
});

describe("matching If-None-Match", () => {
  const etag = etagFor("v1");

  it("matches the same etag", () => {
    expect(etagMatches(etag, etag)).toBe(true);
  });

  it("does not match a different one", () => {
    expect(etagMatches(etagFor("v2"), etag)).toBe(false);
  });

  it("matches one of several", () => {
    expect(etagMatches(`${etagFor("v0")}, ${etag}`, etag)).toBe(true);
  });

  // RFC 9110: a conditional GET uses weak comparison, so the prefix is not
  // part of the comparison even though it is part of the value.
  it("compares weakly", () => {
    expect(etagMatches(etag.replace("W/", ""), etag)).toBe(true);
  });

  it("matches the wildcard", () => {
    expect(etagMatches("*", etag)).toBe(true);
  });

  it("does not match an absent header", () => {
    expect(etagMatches(null, etag)).toBe(false);
  });
});

describe("matching If-Modified-Since", () => {
  // The header carries seconds. Comparing milliseconds makes every request
  // stale by a fraction and silently turns the whole mechanism off.
  it("compares at second precision", () => {
    const withMillis = new Date("2026-01-15T12:00:00.750Z");

    expect(notModifiedSince(MODIFIED.toUTCString(), withMillis)).toBe(true);
  });

  it("is stale when the record is newer", () => {
    expect(notModifiedSince(MODIFIED.toUTCString(), new Date("2026-01-15T12:00:01Z"))).toBe(false);
  });

  it("is fresh when the client has seen something newer", () => {
    expect(notModifiedSince(new Date("2026-02-01T00:00:00Z").toUTCString(), MODIFIED)).toBe(true);
  });

  it("ignores a header it cannot read", () => {
    expect(notModifiedSince("not a date", MODIFIED)).toBe(false);
    expect(notModifiedSince(null, MODIFIED)).toBe(false);
  });
});

describe("cache-control", () => {
  it("is private and revalidated by default", () => {
    expect(cacheControl({})).toBe("private, no-cache");
  });

  it("can be shared", () => {
    expect(cacheControl({ public: true })).toBe("public, no-cache");
  });

  it("takes a max-age", () => {
    expect(cacheControl({ public: true, expiresIn: 300 })).toBe("public, max-age=300");
  });

  it("refuses to go negative", () => {
    expect(cacheControl({ expiresIn: -5 })).toBe("private, max-age=0");
  });

  it("says no-store when nothing may keep it", () => {
    expect(cacheControl({ noStore: true, public: true })).toBe("no-store");
  });
});

describe("working out freshness", () => {
  // Answering 304 for a request that sent no validators would return an empty
  // body for a page the browser has never seen.
  it("is never fresh with nothing to compare", () => {
    expect(freshnessFor(get(), {}).fresh).toBe(false);
  });

  it("is never fresh when the request sent no validators", () => {
    expect(freshnessFor(get(), { etag: "v1" }).fresh).toBe(false);
  });

  it("is fresh when the etag matches", () => {
    const etag = etagFor("v1");
    expect(freshnessFor(get({ "if-none-match": etag }), { etag: "v1" }).fresh).toBe(true);
  });

  it("is fresh when the date is not older", () => {
    const request = get({ "if-modified-since": MODIFIED.toUTCString() });
    expect(freshnessFor(request, { lastModified: MODIFIED }).fresh).toBe(true);
  });

  // An etag is exact where a timestamp is a second-resolution guess, so a
  // request carrying both should be judged by the better of the two.
  it("lets the etag decide when both are sent", () => {
    const request = get({
      "if-none-match": etagFor("old"),
      "if-modified-since": MODIFIED.toUTCString(),
    });

    expect(freshnessFor(request, { etag: "new", lastModified: MODIFIED }).fresh).toBe(false);
  });

  it("sets the headers either way", () => {
    const { headers } = freshnessFor(get(), { etag: "v1", lastModified: MODIFIED });

    expect(headers.etag).toStartWith('W/"');
    expect(headers["last-modified"]).toBe(MODIFIED.toUTCString());
    expect(headers["cache-control"]).toBe("private, no-cache");
  });
});

describe("in an action", () => {
  it("renders when the client has nothing", async () => {
    const response = await run(get(), "show");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "rendered" });
    expect(response.headers.get("etag")).toStartWith('W/"');
  });

  // The saving is the render that does not run, not the bytes not sent.
  it("answers 304 with no body when the client is current", async () => {
    const etag = etagFor({ id: 1, updated_at: MODIFIED });
    const response = await run(get({ "if-none-match": etag }), "show");

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("answers 304 on the date alone", async () => {
    const response = await run(get({ "if-modified-since": MODIFIED.toUTCString() }), "show");
    expect(response.status).toBe(304);
  });

  it("renders again once the record has changed", async () => {
    const stale = etagFor({ id: 1, updated_at: new Date("2020-01-01T00:00:00Z") });
    const response = await run(get({ "if-none-match": stale }), "show");

    expect(response.status).toBe(200);
  });

  // The validators are worked out before the action decides what to render,
  // so they have to travel with whatever it turns out to be.
  it("carries the validators onto the rendered body", async () => {
    const response = await run(get(), "show");

    expect(response.headers.get("last-modified")).toBe(MODIFIED.toUTCString());
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("carries them onto the 304 as well", async () => {
    const etag = etagFor({ id: 1, updated_at: MODIFIED });
    const response = await run(get({ "if-none-match": etag }), "show");

    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  // A 304 carrying content-type is what makes some proxies cache the empty
  // response as though it were the real one.
  it("describes no body it is not sending", async () => {
    const etag = etagFor({ id: 1, updated_at: MODIFIED });
    const response = await run(get({ "if-none-match": etag }), "show");

    expect(response.headers.get("content-type")).toBeNull();
  });

  it("takes an expiry with no validators at all", async () => {
    const response = await run(get(), "listing");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
