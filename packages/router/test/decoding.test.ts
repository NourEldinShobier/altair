/**
 * Percent-encoded path segments.
 *
 * Mirrors actionpack/test/dispatch/routing_test.rb's encoding cases.
 *
 * A browser sends `/posts/caf%C3%A9` for a slug with an accent and `%20` for
 * one with a space. Without decoding, the action looked the encoded text up
 * and found nothing — every route with a non-numeric id, which is most of the
 * routes anybody writes.
 */

import { describe, expect, it } from "bun:test";
import { Router } from "../src/index.js";

const router = new Router();
router.draw((r) => {
  r.resources("posts");
  r.get("/files/*path", { to: "files#show" });
  r.get("/numbered/:id", { to: "numbered#show", constraints: { id: /^\d+$/ } });
  r.get("/noslash/:id", { to: "noslash#show", constraints: { id: /^[^/]+$/ } });
});

const params = (path: string) => router.recognize("GET", path)?.params ?? null;

describe("a segment a browser encoded", () => {
  it("comes back as what the user typed", () => {
    expect(params("/posts/my%20post")).toEqual({ id: "my post" });
  });

  it("handles an accent", () => {
    expect(params("/posts/caf%C3%A9")).toEqual({ id: "café" });
  });

  it("handles an alphabet that is not Latin", () => {
    expect(params("/posts/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82")).toEqual({ id: "привет" });
  });

  it("handles the characters that mean something in a URL", () => {
    expect(params("/posts/a%26b")).toEqual({ id: "a&b" });
    expect(params("/posts/a%23b")).toEqual({ id: "a#b" });
    expect(params("/posts/a%3Fb")).toEqual({ id: "a?b" });
    expect(params("/posts/a%2Bb")).toEqual({ id: "a+b" });
  });

  // An encoded slash is a slash inside one segment, not two segments.
  it("keeps an encoded slash inside the value", () => {
    expect(params("/posts/a%2Fb")).toEqual({ id: "a/b" });
  });

  it("decodes across a glob", () => {
    expect(params("/files/dir/my%20file.txt")).toEqual({ path: "dir/my file.txt" });
  });

  it("leaves a segment with nothing to decode alone", () => {
    expect(params("/posts/1")).toEqual({ id: "1" });
    expect(params("/posts/plain-slug")).toEqual({ id: "plain-slug" });
  });
});

/**
 * The order that matters. A constraint written to keep a slash out of an id
 * would otherwise be tested against `%2F`, pass, and hand the action a slash.
 */
describe("a constraint", () => {
  it("is checked against the decoded value", () => {
    expect(params("/noslash/ok")).toEqual({ id: "ok" });
    expect(params("/noslash/a%2Fb")).toBeNull();
  });

  it("still refuses what it always refused", () => {
    expect(params("/numbered/12")).toEqual({ id: "12" });
    expect(params("/numbered/abc")).toBeNull();
  });

  // A constraint is checked twice, and the two are not the same check. It is
  // compiled into the route's own pattern, which matches the raw path, and it
  // is checked again against the decoded value. So `%31%32` — "12" once
  // decoded — never reaches the second check: the pattern rejects it first.
  //
  // Left as it is rather than "fixed". Matching an encoded path against the
  // pattern is what Rails' router does too, and a constraint that accepted
  // `%31%32` for a numeric id would be a constraint an attacker can spell
  // around.
  it("is compiled into the pattern, so an encoded digit does not match", () => {
    expect(params("/numbered/%31%32")).toBeNull();
  });
});

/**
 * `decodeURIComponent` raises on these, and a request that cannot be parsed
 * should not become a stack trace — the call the cookie parser makes, for the
 * same reason. The value matches nothing and the request ends as the 404 it is.
 */
describe("an escape that is not one", () => {
  it("does not throw", () => {
    expect(() => params("/posts/a%zz")).not.toThrow();
    expect(() => params("/posts/100%")).not.toThrow();
    expect(() => params("/posts/%E0%A4%A")).not.toThrow();
  });

  it("keeps the raw text", () => {
    expect(params("/posts/a%zz")).toEqual({ id: "a%zz" });
  });
});
