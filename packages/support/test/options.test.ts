/**
 * Configuration objects, ported from
 * `activesupport/test/ordered_options_test.rb` and
 * `activesupport/test/array_inquirer_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { ArrayInquirer, InheritableOptions, OrderedOptions, arrayInquiry } from "../src/options.js";

describe("OrderedOptions", () => {
  it("reads what it was given", () => {
    expect(new OrderedOptions({ host: "example.com" }).get("host")).toBe("example.com");
  });

  it("gives undefined for what it was not", () => {
    expect(new OrderedOptions().get("missing")).toBeUndefined();
  });

  it("sets and chains", () => {
    const config = new OrderedOptions().set("a", 1).set("b", 2);

    expect(config.get("a")).toBe(1);
    expect(config.keys.sort()).toEqual(["a", "b"]);
  });

  it("reports what it has", () => {
    const config = new OrderedOptions({ a: 1 });

    expect(config.has("a")).toBe(true);
    expect(config.has("b")).toBe(false);
  });

  /** An explicitly stored undefined is set, which is not the same as absent. */
  it("counts an explicit undefined as set", () => {
    expect(new OrderedOptions({ a: undefined }).has("a")).toBe(true);
  });

  it("deletes", () => {
    const config = new OrderedOptions({ a: 1 });

    expect(config.delete("a")).toBe(true);
    expect(config.delete("a")).toBe(false);
    expect(config.has("a")).toBe(false);
  });

  /**
   * The reason fetch exists: a typo returns undefined from `get` exactly as a
   * genuinely unset value does, so the feature is quietly off and nothing says
   * why.
   */
  it("throws on fetch for something unset", () => {
    expect(() => new OrderedOptions({ cacheTimeout: 5 }).fetch("cache_timeout")).toThrow(
      /No configuration named "cache_timeout"/,
    );
  });

  it("lists what is set in the message", () => {
    expect(() => new OrderedOptions({ cacheTimeout: 5 }).fetch("typo")).toThrow(/cacheTimeout/);
  });

  it("says nothing when nothing is set", () => {
    expect(() => new OrderedOptions().fetch("anything")).toThrow(/nothing/);
  });

  it("fetches what is there", () => {
    expect(new OrderedOptions({ a: 1 }).fetch("a")).toBe(1);
  });

  it("merges into a new object", () => {
    const base = new OrderedOptions({ a: 1 });
    const merged = base.merge({ b: 2 });

    expect(merged.keys.sort()).toEqual(["a", "b"]);
    expect(base.has("b")).toBe(false);
  });

  it("copies what it was constructed with", () => {
    const values = { a: 1 };
    const config = new OrderedOptions(values);
    values.a = 2;

    expect(config.get("a")).toBe(1);
  });
});

describe("InheritableOptions", () => {
  /** Each environment is a short list of differences, not a full copy. */
  it("falls back to the parent", () => {
    const shared = new OrderedOptions({ host: "example.com", port: 80 });
    const development = new InheritableOptions({ port: 3000 }, shared);

    expect(development.get("host")).toBe("example.com");
    expect(development.get("port")).toBe(3000);
  });

  it("reports inherited keys as present", () => {
    const shared = new OrderedOptions({ host: "example.com" });
    const development = new InheritableOptions({}, shared);

    expect(development.has("host")).toBe(true);
    expect(development.has("missing")).toBe(false);
  });

  it("lists its own keys and the inherited ones", () => {
    const shared = new OrderedOptions({ host: "x", port: 80 });
    const development = new InheritableOptions({ port: 3000 }, shared);

    expect(development.keys.sort()).toEqual(["host", "port"]);
  });

  /** What a diff of two environments actually wants. */
  it("separates its own keys from the inherited ones", () => {
    const shared = new OrderedOptions({ host: "x", port: 80 });
    const development = new InheritableOptions({ port: 3000 }, shared);

    expect(development.ownKeys).toEqual(["port"]);
  });

  it("fetches through the parent", () => {
    const shared = new OrderedOptions({ host: "x" });

    expect(new InheritableOptions({}, shared).fetch("host")).toBe("x");
  });

  it("throws for what neither has", () => {
    const shared = new OrderedOptions({ host: "x" });

    expect(() => new InheritableOptions({}, shared).fetch("missing")).toThrow(/missing/);
  });

  it("works with no parent at all", () => {
    const config = new InheritableOptions({ a: 1 });

    expect(config.get("a")).toBe(1);
    expect(config.get("b")).toBeUndefined();
  });

  /** Setting on the child must not reach back into the shared defaults. */
  it("does not write through to the parent", () => {
    const shared = new OrderedOptions({ host: "x" });
    const development = new InheritableOptions({}, shared);
    development.set("host", "localhost");

    expect(development.get("host")).toBe("localhost");
    expect(shared.get("host")).toBe("x");
  });
});

describe("ArrayInquirer", () => {
  const formats = new ArrayInquirer(["html", "json"]);

  it("answers membership", () => {
    expect(formats.is("json")).toBe(true);
    expect(formats.is("xml")).toBe(false);
  });

  /** Where a chain of || is what somebody eventually mistypes. */
  it("answers any", () => {
    expect(formats.any("xml", "json")).toBe(true);
    expect(formats.any("xml", "csv")).toBe(false);
  });

  it("answers all", () => {
    expect(formats.all("html", "json")).toBe(true);
    expect(formats.all("html", "xml")).toBe(false);
  });

  it("is empty-safe", () => {
    const none = new ArrayInquirer([]);

    expect(none.is("html")).toBe(false);
    expect(none.any("html")).toBe(false);
    expect(none.all()).toBe(true);
    expect(none.length).toBe(0);
  });

  it("iterates", () => {
    expect([...formats]).toEqual(["html", "json"]);
    expect(formats.toArray()).toEqual(["html", "json"]);
  });

  it("is what arrayInquiry builds", () => {
    expect(arrayInquiry(["a"]).is("a")).toBe(true);
  });
});
