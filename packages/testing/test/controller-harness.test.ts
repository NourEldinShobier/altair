/**
 * Driving a controller from a test, ported from
 * `actionpack/test/controller/test_case_test.rb` and
 * `actionpack/test/controller/integration_test.rb`.
 *
 * The failures worth testing are the contaminating ones: state left over from
 * the first request in a test changes the second, and neither fails — they
 * pass, differently.
 */

import { describe, expect, it } from "bun:test";
import {
  NotAnHtmlResponse,
  assertTemplate,
  assignParameters,
  buildRequest,
  buildResponse,
  debugHash,
  debugHeaders,
  debugParams,
  defaultEnv,
  documentRootElement,
  fileFixtureUpload,
  filteredEnv,
  filteredLocation,
  htmlDocument,
  makeResponse,
  newHarnessState,
  normalizeEnv,
  parsedBody,
  rackStatusCode,
  recycle,
  renderedViews,
} from "../src/controller-harness.js";

describe("the environment a request is built from", () => {
  /**
   * Fixed rather than whatever the machine has: a test depending on its host
   * passes locally and fails in CI for a reason nobody looks for.
   */
  it("is the same everywhere", () => {
    expect(defaultEnv()["HTTP_HOST"]).toBe("test.host");
    expect(defaultEnv()["REMOTE_ADDR"]).toBe("0.0.0.0");
  });

  it("takes overrides", () => {
    expect(normalizeEnv({ HTTP_HOST: "example.com" })["HTTP_HOST"]).toBe("example.com");
  });

  /** A test should be able to write whichever form reads better. */
  it("accepts a header name in either form", () => {
    expect(normalizeEnv({ "user-agent": "Mine" })["HTTP_USER_AGENT"]).toBe("Mine");
    expect(normalizeEnv({ HTTP_USER_AGENT: "Mine" })["HTTP_USER_AGENT"]).toBe("Mine");
  });

  it("leaves a rack key alone", () => {
    expect(normalizeEnv({ "rack.url_scheme": "https" })["rack.url_scheme"]).toBe("https");
  });

  it("keeps the defaults it was not given", () => {
    expect(normalizeEnv({ HTTP_HOST: "example.com" })["REMOTE_ADDR"]).toBe("0.0.0.0");
  });
});

describe("where a request's parameters go", () => {
  /**
   * A `GET` with a body is not what a browser sends, and a controller reading
   * `params` would not notice until something downstream did.
   */
  it("puts them in the query for a GET", () => {
    const built = assignParameters({ method: "GET", path: "/posts", params: { page: 2 } });

    expect(built.path).toBe("/posts?page=2");
    expect(built.body).toBeUndefined();
  });

  it("puts them in the body for a POST", () => {
    const built = assignParameters({ method: "POST", path: "/posts", params: { title: "a" } });

    expect(built.path).toBe("/posts");
    expect(built.body).toBe("title=a");
    expect(built.headers["content-type"]).toContain("form-urlencoded");
  });

  it("appends to a path that already has a query", () => {
    expect(assignParameters({ method: "GET", path: "/posts?a=1", params: { b: 2 } }).path).toBe(
      "/posts?a=1&b=2",
    );
  });

  it("changes nothing with no parameters", () => {
    expect(assignParameters({ method: "POST", path: "/posts" })).toEqual({
      path: "/posts",
      headers: {},
    });
  });

  it("lets the caller override the content type", () => {
    const built = assignParameters({
      method: "POST",
      path: "/posts",
      params: { a: 1 },
      headers: { "content-type": "application/json" },
    });

    expect(built.headers["content-type"]).toBe("application/json");
  });

  it("builds a request from a spec", () => {
    const request = buildRequest({ method: "get", path: "/posts", params: { page: 2 } });

    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/posts");
    expect(new URL(request.url).searchParams.get("page")).toBe("2");
  });

  it("uses the host from the environment", () => {
    const request = buildRequest(
      { method: "GET", path: "/" },
      normalizeEnv({ HTTP_HOST: "example.com" }),
    );

    expect(new URL(request.url).host).toBe("example.com");
  });
});

describe("responses", () => {
  it("builds one", async () => {
    const response = buildResponse("hello", { status: 201 });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("hello");
  });

  it("makes an empty one", () => {
    expect(makeResponse().status).toBe(200);
  });

  it("reads the status", () => {
    expect(rackStatusCode(buildResponse("", { status: 404 }))).toBe(404);
  });
});

describe("reading a response", () => {
  const html = buildResponse("<html><body><p>Hi</p></body></html>", {
    headers: { "content-type": "text/html" },
  });

  it("reads an HTML body", () => {
    expect(htmlDocument(html, "<p>Hi</p>")).toBe("<p>Hi</p>");
  });

  /**
   * Parsing JSON as HTML finds no elements, so the assertion fails saying the
   * element is missing — which sends the reader to the template instead of to
   * the format.
   */
  it("refuses one that is not HTML", () => {
    const json = buildResponse("{}", { headers: { "content-type": "application/json" } });

    expect(() => htmlDocument(json, "{}")).toThrow(NotAnHtmlResponse);
  });

  it("says what it got instead", () => {
    const json = buildResponse("{}", { headers: { "content-type": "application/json" } });

    expect(() => htmlDocument(json, "{}")).toThrow("application/json");
  });

  it("names the outermost element", () => {
    expect(documentRootElement("<html><body></body></html>")).toBe("html");
    expect(documentRootElement("  <DIV>x</DIV>")).toBe("div");
  });

  it("names none for markup-free text", () => {
    expect(documentRootElement("plain")).toBeUndefined();
  });

  /** A JSON body served as HTML is a bug worth failing on; guessing hides it. */
  it("parses by what the response says it is", () => {
    expect(parsedBody("application/json", '{"a":1}')).toEqual({ a: 1 });
    expect(parsedBody("text/html", '{"a":1}')).toBe('{"a":1}');
    expect(parsedBody(null, "plain")).toBe("plain");
  });
});

describe("which template rendered", () => {
  it("passes when it did", () => {
    expect(() => assertTemplate(["posts/index"], "posts/index")).not.toThrow();
  });

  it("fails when it did not", () => {
    expect(() => assertTemplate(["posts/show"], "posts/index")).toThrow("posts/index");
  });

  it("says what did render instead", () => {
    expect(() => assertTemplate(["posts/show"], "posts/index")).toThrow("posts/show");
  });

  it("says when nothing rendered", () => {
    expect(() => assertTemplate([], "posts/index")).toThrow("nothing was");
  });
});

describe("uploads", () => {
  /**
   * The declared type is carried explicitly, because most upload tests are
   * about what the application does with a declared type — including one that
   * disagrees with the bytes.
   */
  it("carries the declared content type", () => {
    const upload = fileFixtureUpload("evil.png", new Uint8Array([1]), "image/png");

    expect(upload.contentType).toBe("image/png");
    expect(upload.filename).toBe("evil.png");
  });

  it("defaults to bytes", () => {
    expect(fileFixtureUpload("x", new Uint8Array()).contentType).toBe("application/octet-stream");
  });
});

describe("between two requests in one test", () => {
  /**
   * Left uncleared, a flash from the first request makes a "no flash"
   * assertion on the second pass for the wrong reason.
   */
  it("clears the flash", () => {
    const state = newHarnessState();
    state.flash["notice"] = "Saved";

    recycle(state);

    expect(state.flash).toEqual({});
  });

  it("clears the parameters", () => {
    const state = newHarnessState();
    state.params["title"] = "a";

    recycle(state);

    expect(state.params).toEqual({});
  });

  it("clears what rendered", () => {
    const state = newHarnessState();
    state.renderedViews.push("posts/index");

    recycle(state);

    expect(renderedViews(state)).toEqual([]);
  });

  /**
   * The session stays: a test that signs in and then makes a second request is
   * the normal case, and clearing it makes every multi-request test re-sign-in
   * — failing somewhere with nothing to do with the session.
   */
  it("keeps the session", () => {
    const state = newHarnessState();
    state.session["user_id"] = 7;

    recycle(state);

    expect(state.session["user_id"]).toBe(7);
  });

  it("hands the state back", () => {
    const state = newHarnessState();

    expect(recycle(state)).toBe(state);
  });
});

describe("what a failure prints", () => {
  /**
   * Sorted, because a message that reordered between runs cannot be diffed
   * against the last one — and diffing two failures is how anybody works out
   * what changed.
   */
  it("sorts a hash", () => {
    expect(debugHash({ b: 2, a: 1 })).toBe("  a: 1\n  b: 2");
  });

  it("prints nothing for an empty hash", () => {
    expect(debugHash({})).toBe("");
  });

  it("prints the parameters", () => {
    const state = newHarnessState();
    state.params["title"] = "a";

    expect(debugParams(state)).toContain("title");
  });

  it("prints the headers", () => {
    expect(debugHeaders(new Headers({ "x-a": "1" }))).toContain("x-a");
  });

  /**
   * An environment printed in CI ends up in a log anybody with access to the
   * build can read.
   */
  it("hides secrets in the environment", () => {
    const filtered = filteredEnv({ HTTP_HOST: "test.host", SECRET_KEY_BASE: "abc" });

    expect(filtered["SECRET_KEY_BASE"]).toBe("[FILTERED]");
    expect(filtered["HTTP_HOST"]).toBe("test.host");
  });

  it("hides a token in a query string", () => {
    expect(filteredLocation("/back?reset_token=abc&page=2")).toBe(
      "/back?reset_token=%5BFILTERED%5D&page=2",
    );
  });

  it("leaves a location with no query alone", () => {
    expect(filteredLocation("/posts")).toBe("/posts");
  });
});
