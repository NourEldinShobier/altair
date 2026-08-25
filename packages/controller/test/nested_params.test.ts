/**
 * Bracket notation in parameter names.
 *
 * Mirrors rack/test/spec_utils.rb's `parse_nested_query` cases, which is what
 * Rails relies on: `form_with model: @post` names its fields `post[title]`,
 * and `params.require("post").permit("title")` only works because something
 * turned that into a nested object on the way in.
 */

import { describe, expect, it } from "bun:test";
import { keyPath, parseNestedParams } from "../src/nested_params.js";

const parse = (query: string) => parseNestedParams(new URLSearchParams(query).entries());

describe("a parameter name", () => {
  it("splits into its segments", () => {
    expect(keyPath("post[tags][]")).toEqual(["post", "tags", ""]);
    expect(keyPath("title")).toEqual(["title"]);
  });

  // Guessing at `a[b` is how a parameter nobody meant comes into being.
  it("stays literal when the brackets do not close", () => {
    expect(keyPath("a[b")).toEqual(["a[b"]);
    expect(keyPath("a[b]c")).toEqual(["a[b]c"]);
    expect(keyPath("a]b")).toEqual(["a]b"]);
  });
});

describe("parsing", () => {
  it("reads a flat pair", () => {
    expect(parse("a=1&b=2")).toEqual({ a: "1", b: "2" });
  });

  it("reads an empty value", () => {
    expect(parse("a=")).toEqual({ a: "" });
  });

  it("nests", () => {
    expect(parse("post[title]=Hello&post[body]=x")).toEqual({
      post: { title: "Hello", body: "x" },
    });
  });

  it("nests as deep as it is asked to", () => {
    expect(parse("a[b][c][d]=1")).toEqual({ a: { b: { c: { d: "1" } } } });
  });

  it("collects a repeated bracket name into an array", () => {
    expect(parse("tags[]=a&tags[]=b")).toEqual({ tags: ["a", "b"] });
  });

  it("collects an array inside a nesting", () => {
    expect(parse("post[title]=Hello&post[tags][]=a&post[tags][]=b")).toEqual({
      post: { title: "Hello", tags: ["a", "b"] },
    });
  });

  // What `fields_for` emits for nested attributes. Rails reads the index back
  // as a key rather than a position, so an object is the right answer.
  it("keeps an index as a key", () => {
    expect(parse("post[comments_attributes][0][body]=hi")).toEqual({
      post: { comments_attributes: { 0: { body: "hi" } } },
    });
  });

  it("keeps the last of a repeated scalar, as Rack does", () => {
    expect(parse("a=1&a=2")).toEqual({ a: "2" });
  });

  it("leaves a malformed name as a key of its own", () => {
    expect(parse("a[b=1&c]=2")).toEqual({ "a[b": "1", "c]": "2" });
  });

  // `a[][b]` is an array of objects, which no form Rails generates produces.
  // Keeping the value reachable beats quietly reshaping it.
  it("leaves an array of objects alone", () => {
    expect(parse("a[][b]=1")).toEqual({ "a[][b]": "1" });
  });

  it("does not lose the array when a later name collides with it", () => {
    expect(parse("a[]=1&a[]=2&a[]=3")).toEqual({ a: ["1", "2", "3"] });
  });
});

// A query string is attacker-controlled: `?__proto__[admin]=1` is a request
// anybody can make, and one that lands would put `admin` on every object in
// the process.
describe("a hostile name", () => {
  it("is dropped rather than written", () => {
    expect(parse("__proto__[admin]=1&b=ok")).toEqual({ b: "ok" });
    expect(parse("a[__proto__][x]=1&b=ok")).toEqual({ b: "ok" });
    expect(parse("a[constructor][prototype][x]=1&b=ok")).toEqual({ b: "ok" });
  });

  it("leaves the prototype untouched", () => {
    parse("__proto__[admin]=1");
    parse("a[__proto__][admin]=1");

    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("admin");
  });

  // Nesting is cheap to send and expensive to walk.
  it("is refused past a depth limit", () => {
    expect(parse(`a${"[b]".repeat(40)}=1`)).toEqual({});
    expect(parse(`a${"[b]".repeat(4)}=1`)).not.toEqual({});
  });
});
