/**
 * Digests, ported from `activesupport/test/digest_test.rb`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  digestOf,
  hashDigestAlgorithm,
  hexdigest,
  setHashDigestAlgorithm,
  uuidFromHash,
} from "../src/digest.js";

afterEach(() => {
  setHashDigestAlgorithm("sha256");
});

describe("hexdigest", () => {
  it("is stable for the same input", () => {
    expect(hexdigest("hello")).toBe(hexdigest("hello"));
  });

  it("differs for different input", () => {
    expect(hexdigest("hello")).not.toBe(hexdigest("world"));
  });

  /** 64 characters is no less collision-proof and makes a log line unscannable. */
  it("is truncated to 32 characters", () => {
    expect(hexdigest("hello")).toHaveLength(32);
  });

  it("takes a different length", () => {
    expect(hexdigest("hello", 8)).toHaveLength(8);
  });

  it("is hex", () => {
    expect(hexdigest("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("uses the configured algorithm", () => {
    const before = hexdigest("hello");
    setHashDigestAlgorithm("sha1");

    expect(hashDigestAlgorithm()).toBe("sha1");
    expect(hexdigest("hello")).not.toBe(before);
  });

  /** Failing at configuration time, with the line that set it. */
  it("refuses an algorithm that does not exist", () => {
    expect(() => setHashDigestAlgorithm("not-a-hash")).toThrow();
    expect(hashDigestAlgorithm()).toBe("sha256");
  });
});

describe("digestOf", () => {
  it("digests a scalar", () => {
    expect(digestOf(42)).toHaveLength(32);
  });

  /**
   * Sorted keys, or two objects that mean the same thing digest differently
   * depending on the order they were built in — a cache key that misses on
   * every other request.
   */
  it("ignores the order keys were built in", () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(digestOf({ outer: { a: 1, b: 2 } })).toBe(digestOf({ outer: { b: 2, a: 1 } }));
  });

  /** Array order is meaningful, unlike key order. */
  it("respects array order", () => {
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]));
  });

  it("differs for different values", () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });

  it("handles a date", () => {
    const at = new Date("2026-01-01T00:00:00Z");

    expect(digestOf({ at })).toBe(digestOf({ at: new Date("2026-01-01T00:00:00Z") }));
  });

  it("handles nothing", () => {
    expect(digestOf(null)).toHaveLength(32);
    expect(digestOf(undefined)).not.toBe(digestOf(null));
  });
});

describe("uuidFromHash", () => {
  /** What makes it usable as an idempotency key. */
  it("is the same for the same input", () => {
    expect(uuidFromHash("order-42")).toBe(uuidFromHash("order-42"));
  });

  it("differs for different input", () => {
    expect(uuidFromHash("order-42")).not.toBe(uuidFromHash("order-43"));
  });

  it("looks like a UUID", () => {
    expect(uuidFromHash("x")).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  /** Without the version and variant bits a strict parser rejects it. */
  it("is a version 5 UUID", () => {
    expect(uuidFromHash("x")[14]).toBe("5");
  });

  it("has the RFC variant bits", () => {
    expect("89ab").toContain(uuidFromHash("x")[19] as string);
  });
});
