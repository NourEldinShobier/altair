/**
 * The headers a caller hands a response, in every shape the signature takes.
 *
 * `HeadersInit` is three things — a `Headers`, an array of pairs, or a record
 * — and only the record spreads into an object literal. The other two were
 * being spread anyway:
 *
 *     { ...new Headers({ "x-foo": "1" }) }   //=> {}
 *     { ...[["x-foo", "1"]] }                //=> { "0": ["x-foo", "1"] }
 *
 * So a caller passing a `Headers` had every header dropped without a word,
 * and one passing pairs got a header named `0`. Both are types the signature
 * accepts, so both were ordinary things to write.
 *
 * Found by the type-aware lint's `no-misused-spread`, which named the shape
 * exactly: "using the spread operator on an array in an object will result in
 * a list of indices".
 */

import { describe, expect, it } from "bun:test";
import { Controller } from "../src/controller.js";
import { eventStreamResponse, streamResponse } from "../src/streaming.js";

class Pages extends Controller {
  async show(): Promise<Response> {
    return this.render.text("hi", { headers: this.headersUnderTest });
  }

  headersUnderTest: ResponseInit["headers"];
}

async function textResponse(headers: ResponseInit["headers"]): Promise<Response> {
  const controller = new Pages({ request: new Request("http://test.example/pages/1") });

  controller.headersUnderTest = headers;

  return await controller.show();
}

describe("headers given to a rendered response", () => {
  it("keeps the ones in a plain record", async () => {
    const response = await textResponse({ "x-foo": "1" });

    expect(response.headers.get("x-foo")).toBe("1");
  });

  /** The regression: this used to arrive empty. */
  it("keeps the ones in a Headers", async () => {
    const response = await textResponse(new Headers({ "x-foo": "1" }));

    expect(response.headers.get("x-foo")).toBe("1");
  });

  /** And this used to write a header named `0`. */
  it("keeps the ones in a list of pairs", async () => {
    const response = await textResponse([["x-foo", "1"]]);

    expect(response.headers.get("x-foo")).toBe("1");
    expect(response.headers.get("0")).toBeNull();
  });

  it("still sets the content type when the caller gave none", async () => {
    const response = await textResponse({ "x-foo": "1" });

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  /** Theirs won before this changed, and has to keep winning. */
  it("lets the caller's content type win", async () => {
    const response = await textResponse({ "content-type": "text/csv" });

    expect(response.headers.get("content-type")).toBe("text/csv");
  });

  it("lets it win through a Headers too", async () => {
    const response = await textResponse(new Headers({ "content-type": "text/csv" }));

    expect(response.headers.get("content-type")).toBe("text/csv");
  });

  /**
   * A record may hold `undefined` for a header the caller decided against, and
   * `new Headers` writes that out as the five characters `undefined`.
   */
  it("leaves out a header whose value is undefined", async () => {
    const response = await textResponse({ "x-foo": undefined } as ResponseInit["headers"]);

    expect(response.headers.get("x-foo")).toBeNull();
  });

  it("works with no headers at all", async () => {
    const response = await textResponse(undefined);

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("headers given to a stream", () => {
  async function* one(): AsyncGenerator<string> {
    yield "a";
  }

  it("keeps the ones in a Headers", () => {
    const response = streamResponse(one(), { headers: new Headers({ "x-foo": "1" }) });

    expect(response.headers.get("x-foo")).toBe("1");
  });

  it("keeps the ones in a list of pairs", () => {
    const response = streamResponse(one(), { headers: [["x-foo", "1"]] });

    expect(response.headers.get("x-foo")).toBe("1");
    expect(response.headers.get("0")).toBeNull();
  });

  it("still defaults the content type", () => {
    expect(streamResponse(one(), {}).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("lets the caller's content type win", () => {
    const response = streamResponse(one(), { contentType: "text/csv" });

    expect(response.headers.get("content-type")).toBe("text/csv");
  });
});

describe("headers given to an event stream", () => {
  async function* one(): AsyncGenerator<{ data: string }> {
    yield { data: "a" };
  }

  it("keeps the caller's alongside the ones that make it work", () => {
    const response = eventStreamResponse(one(), { headers: new Headers({ "x-foo": "1" }) });

    expect(response.headers.get("x-foo")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  /**
   * The proxy headers are not decoration — `x-accel-buffering: no` is what
   * stops nginx collecting a live feed into bursts — but a caller who names
   * one means it.
   */
  it("lets the caller override one of them", () => {
    const response = eventStreamResponse(one(), { headers: { "cache-control": "no-store" } });

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });
});
