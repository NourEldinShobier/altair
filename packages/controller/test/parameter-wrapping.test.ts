/**
 * Nesting a JSON body under the model's name, ported from
 * `actionpack/test/controller/params_wrapper_test.rb`, and the parser registry
 * from `actionpack/test/dispatch/request/json_params_parsing_test.rb`.
 *
 * The problem: a form generated for Post sends `post[title]=x`, so the action
 * reads `params.require("post")`. An API client sends `{"title":"x"}` — flat,
 * because that is what every other JSON API takes — and the same require finds
 * nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { parseBody } from "../src/dispatcher.js";
import {
  isWrappableContentType,
  parameterParserFor,
  parameterParsers,
  registerParameterParser,
  removeParameterParser,
  resetParameterParsers,
  wrapParameters,
} from "../src/parameter-wrapping.js";

afterEach(() => {
  resetParameterParsers();
});

describe("wrapping", () => {
  it("nests a flat body under the model's name", () => {
    const wrapped = wrapParameters({ title: "x", body: "y" }, { name: "post" });

    expect(wrapped.post).toEqual({ title: "x", body: "y" });
  });

  /**
   * Beside rather than instead, which is Rails' behaviour: an action reading
   * `params.get("title")` keeps working and one reading `require("post")`
   * starts. Replacing would break every existing action the day wrapping was
   * switched on.
   */
  it("leaves the original keys where they were", () => {
    const wrapped = wrapParameters({ title: "x" }, { name: "post" });

    expect(wrapped.title).toBe("x");
  });

  /** Wrapping again gives post[post][title], which nothing reads. */
  it("does nothing when the body is already nested", () => {
    const already = { post: { title: "x" } };

    expect(wrapParameters(already, { name: "post" })).toEqual(already);
  });

  it("moves only what it was told to include", () => {
    const wrapped = wrapParameters(
      { title: "x", admin: true },
      { name: "post", include: ["title"] },
    );

    expect(wrapped.post).toEqual({ title: "x" });
  });

  it("moves nothing it was told to exclude", () => {
    const wrapped = wrapParameters(
      { title: "x", secret: "s" },
      { name: "post", exclude: ["secret"] },
    );

    expect(wrapped.post).toEqual({ title: "x" });
  });

  /**
   * Protocol, not attributes. Wrapped, the authenticity token would sit where
   * forgery protection does not look, so every JSON post would start failing
   * its CSRF check for a reason nothing reports.
   */
  it("never wraps the keys that are protocol", () => {
    const wrapped = wrapParameters(
      {
        title: "x",
        controller: "posts",
        action: "create",
        authenticity_token: "t",
        format: "json",
      },
      { name: "post" },
    );

    expect(wrapped.post).toEqual({ title: "x" });
    expect(wrapped.authenticity_token).toBe("t");
  });

  it("does nothing when there would be nothing inside", () => {
    const only = { controller: "posts", action: "create" };

    expect(wrapParameters(only, { name: "post" })).toEqual(only);
  });

  it("does nothing to an empty body", () => {
    expect(wrapParameters({}, { name: "post" })).toEqual({});
  });

  it("keeps nested values as they are", () => {
    const wrapped = wrapParameters({ author: { name: "A" } }, { name: "post" });

    expect(wrapped.post).toEqual({ author: { name: "A" } });
  });
});

describe("which bodies are wrappable", () => {
  it("takes json", () => {
    expect(isWrappableContentType("application/json")).toBe(true);
    expect(isWrappableContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("takes a vendor json type", () => {
    expect(isWrappableContentType("application/vnd.api+json")).toBe(true);
  });

  /** A form body is already nested; wrapping it gives post[post][title]. */
  it("leaves a form body alone", () => {
    expect(isWrappableContentType("application/x-www-form-urlencoded")).toBe(false);
    expect(isWrappableContentType("multipart/form-data; boundary=x")).toBe(false);
  });

  it("says no to nothing at all", () => {
    expect(isWrappableContentType(null)).toBe(false);
    expect(isWrappableContentType("")).toBe(false);
  });
});

describe("the parser registry", () => {
  const parse = async (request: Request): Promise<Record<string, unknown>> => ({
    raw: await request.text(),
  });

  it("finds a registered parser", () => {
    registerParameterParser("application/x-msgpack", parse);

    expect(parameterParserFor("application/x-msgpack")).toBe(parse);
  });

  /** The failure that looks like the registration never happened. */
  it("finds one despite a charset on the header", () => {
    registerParameterParser("application/x-msgpack", parse);

    expect(parameterParserFor("application/x-msgpack; charset=binary")).toBe(parse);
  });

  it("ignores case", () => {
    registerParameterParser("Application/X-MsgPack", parse);

    expect(parameterParserFor("application/x-msgpack")).toBe(parse);
  });

  it("finds none for a type nobody registered", () => {
    expect(parameterParserFor("application/x-msgpack")).toBeUndefined();
    expect(parameterParserFor(null)).toBeUndefined();
  });

  it("lists what it knows", () => {
    registerParameterParser("application/x-msgpack", parse);

    expect(parameterParsers()).toEqual(["application/x-msgpack"]);
  });

  it("forgets one", () => {
    registerParameterParser("application/x-msgpack", parse);
    removeParameterParser("application/x-msgpack");

    expect(parameterParserFor("application/x-msgpack")).toBeUndefined();
  });
});

describe("reading a body", () => {
  function post(body: string, contentType: string): Request {
    return new Request("https://app.test/posts", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  }

  it("uses a registered parser", async () => {
    registerParameterParser("application/x-thing", async (request) => ({
      thing: await request.text(),
    }));

    expect(await parseBody(post("hello", "application/x-thing"))).toEqual({ thing: "hello" });
  });

  /** An application can teach the framework a format, not fight it. */
  it("prefers a registered parser over the built-in json one", async () => {
    registerParameterParser("application/json", async () => ({ mine: true }));

    expect(await parseBody(post('{"title":"x"}', "application/json"))).toEqual({ mine: true });
  });

  it("still reads json when nothing is registered", async () => {
    expect(await parseBody(post('{"title":"x"}', "application/json"))).toEqual({ title: "x" });
  });

  it("still reads a form when nothing is registered", async () => {
    expect(await parseBody(post("title=x&body=y", "application/x-www-form-urlencoded"))).toEqual({
      title: "x",
      body: "y",
    });
  });

  /** A parser is given untrusted input; one that throws must not be a 500. */
  it("gives no params when a registered parser throws", async () => {
    registerParameterParser("application/x-thing", () => {
      throw new Error("bad body");
    });

    expect(await parseBody(post("hello", "application/x-thing"))).toEqual({});
  });
});
