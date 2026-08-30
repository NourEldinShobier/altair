/**
 * What a request looks like once the secrets are taken out, ported from
 * `actionpack/test/dispatch/request/filter_parameters_test.rb`.
 *
 * A request log line carries the URL, a URL carries its query string, and a
 * query string carries the password-reset token and the API key somebody put
 * in a link. Every one of those then sits in the log aggregator, in the load
 * balancer's access log, and in whatever a support engineer pastes into a
 * ticket.
 */

import { describe, expect, it } from "bun:test";
import { ParameterFilter } from "@altair/support";
import {
  filteredParameters,
  filteredPath,
  filteredUrl,
  pathParameters,
  queryParametersOf,
  requestParameters,
} from "../src/filtered_logging.js";

const request = (url: string): Request => new Request(url);

describe("filteredPath", () => {
  /** The leak this exists for. */
  it("redacts a secret in the query string", () => {
    expect(filteredPath(request("https://app.test/reset?token=abc123"))).toBe(
      "/reset?token=[FILTERED]",
    );
  });

  /**
   * The value replaced rather than the parameter dropped: `token=[FILTERED]`
   * says a token was sent and `?` says nothing, and the difference matters
   * when the question is why a request failed.
   */
  it("keeps the parameter so the shape is still legible", () => {
    expect(filteredPath(request("https://app.test/reset?token=abc"))).toContain("token=");
  });

  it("leaves an ordinary parameter alone", () => {
    expect(filteredPath(request("https://app.test/posts?page=2"))).toBe("/posts?page=2");
  });

  it("redacts one among several", () => {
    const path = filteredPath(request("https://app.test/posts?page=2&api_key=xyz&sort=title"));

    expect(path).toContain("page=2");
    expect(path).toContain("sort=title");
    expect(path).not.toContain("xyz");
  });

  it("leaves a path with no query alone", () => {
    expect(filteredPath(request("https://app.test/posts"))).toBe("/posts");
  });

  it("catches a spelling the filter matches loosely", () => {
    expect(filteredPath(request("https://app.test/?password_confirmation=x"))).toContain(
      "[FILTERED]",
    );
  });

  it("takes a filter of its own", () => {
    const filter = new ParameterFilter(["page"]);

    expect(filteredPath(request("https://app.test/posts?page=2"), filter)).toBe(
      "/posts?page=[FILTERED]",
    );
  });

  /** A log line that escapes them does not match the one the client sent. */
  it("does not escape brackets", () => {
    expect(filteredPath(request("https://app.test/posts?tag[]=a&tag[]=b"))).toBe(
      "/posts?tag[]=a&tag[]=b",
    );
  });

  it("keeps the parameters in the order they arrived", () => {
    expect(filteredPath(request("https://app.test/?b=2&a=1"))).toBe("/?b=2&a=1");
  });

  it("takes a string as readily as a request", () => {
    expect(filteredPath("https://app.test/reset?token=abc")).toBe("/reset?token=[FILTERED]");
  });

  it("gives back something that is not a url unchanged", () => {
    expect(filteredPath("not a url at all")).toBe("/not%20a%20url%20at%20all");
  });
});

describe("filteredUrl", () => {
  it("keeps the host", () => {
    expect(filteredUrl(request("https://app.test/reset?token=abc"))).toBe(
      "https://app.test/reset?token=[FILTERED]",
    );
  });

  it("keeps the scheme and port", () => {
    expect(filteredUrl(request("http://app.test:8080/a?b=1"))).toBe("http://app.test:8080/a?b=1");
  });
});

describe("the three sources", () => {
  it("gives back what the router matched", () => {
    expect(pathParameters({ path: { id: "7" } })).toEqual({ id: "7" });
  });

  it("gives back the query string", () => {
    expect(queryParametersOf(request("https://app.test/?page=2"))).toEqual({ page: "2" });
  });

  /** `?tag=a&tag=b` means both, and keeping only `b` drops half a filter. */
  it("collects a repeated query parameter into a list", () => {
    expect(queryParametersOf(request("https://app.test/?tag=a&tag=b"))).toEqual({
      tag: ["a", "b"],
    });
  });

  it("collects three of them", () => {
    expect(queryParametersOf(request("https://app.test/?t=a&t=b&t=c"))).toEqual({
      t: ["a", "b", "c"],
    });
  });

  it("gives back the body", () => {
    expect(requestParameters({ request: { title: "x" } })).toEqual({ title: "x" });
  });

  /**
   * Merging them first makes an unanswerable question of whether a token came
   * from a body or a URL — and one of those is logged and shared.
   */
  it("keeps them apart", () => {
    const sources = { path: { id: "7" }, query: { page: "2" }, request: { title: "x" } };

    expect(pathParameters(sources)).toEqual({ id: "7" });
    expect(requestParameters(sources)).toEqual({ title: "x" });
  });

  it("gives a copy, so a caller cannot write through it", () => {
    const sources = { path: { id: "7" } };

    pathParameters(sources).id = "changed";

    expect(sources.path.id).toBe("7");
  });

  it("survives sources that are not there", () => {
    expect(pathParameters({})).toEqual({});
    expect(requestParameters({})).toEqual({});
  });
});

describe("filteredParameters", () => {
  it("redacts across every source", () => {
    const filtered = filteredParameters({
      path: { id: "7" },
      query: { api_key: "xyz" },
      request: { password: "hunter2", title: "x" },
    });

    expect(filtered).toEqual({
      id: "7",
      api_key: "[FILTERED]",
      password: "[FILTERED]",
      title: "x",
    });
  });

  it("takes a filter of its own", () => {
    const filtered = filteredParameters(
      { request: { title: "x" } },
      new ParameterFilter(["title"]),
    );

    expect(filtered.title).toBe("[FILTERED]");
  });

  it("survives having nothing to filter", () => {
    expect(filteredParameters({})).toEqual({});
  });
});
