/**
 * The small ActiveSupport utilities, ported from
 * `activesupport/test/core_ext/`, `digest/uuid_test.rb` and
 * `parameter_filter_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { FILTERED, ParameterFilter } from "../src/filter.js";
import {
  fixedLengthSecureCompare,
  gigabytes,
  indent,
  inquiry,
  kilobytes,
  megabytes,
  nilUuid,
  secureCompare,
  squish,
  truncateBytes,
  tryCall,
  uuidV3,
  uuidV5,
  UUID_NAMESPACES,
} from "../src/misc.js";

describe("bytes", () => {
  // 1024, as Rails counts them and as a filesystem reports them.
  it("counts in powers of two", () => {
    expect(kilobytes(1)).toBe(1024);
    expect(megabytes(1)).toBe(1_048_576);
    expect(gigabytes(2)).toBe(2_147_483_648);
  });
});

describe("a string that answers about itself", () => {
  it("says which one it is", () => {
    const env = inquiry("production");

    expect(env.production).toBe(true);
    expect(env.development).toBe(false);
  });

  it("is still a string", () => {
    expect(String(inquiry("production"))).toBe("production");
    expect(inquiry("production").length).toBe(10);
  });

  /**
   * A typo in a comparison is silently false, and so is a typo here — unless
   * the caller says what the values are, which is the only way to catch it.
   */
  it("refuses a name that was never a possible value", () => {
    const env = inquiry("production", ["production", "development"] as const);

    expect(env.production).toBe(true);
    expect(() => (env as unknown as Record<string, boolean>).prodution).toThrow(/not one of/);
  });
});

describe("calling a method that may not be there", () => {
  it("calls it when there is something to call", () => {
    expect(tryCall("abc", "toUpperCase")).toBe("ABC");
  });

  it("says nothing when there is not", () => {
    expect(tryCall(null, "toUpperCase")).toBeUndefined();
    expect(tryCall(undefined, "anything")).toBeUndefined();
    expect(tryCall({}, "missing")).toBeUndefined();
  });

  it("passes the arguments along", () => {
    expect(tryCall("a,b", "split", ",")).toEqual(["a", "b"]);
  });
});

/**
 * The same namespace and name always give the same uuid, which is the point:
 * an id for an external record that needs no table to remember it.
 */
describe("uuids derived from a name", () => {
  it("is the same every time", () => {
    const once = uuidV5(UUID_NAMESPACES.dns, "example.com");
    const again = uuidV5(UUID_NAMESPACES.dns, "example.com");

    expect(once).toBe(again);
  });

  it("differs for a different name", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "a.example")).not.toBe(
      uuidV5(UUID_NAMESPACES.dns, "b.example"),
    );
  });

  it("differs for a different namespace", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "x")).not.toBe(uuidV5(UUID_NAMESPACES.url, "x"));
  });

  // The version nibble and the variant bits are what make it a uuid rather
  // than sixteen bytes of hash.
  it("says which version it is", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "x")[14]).toBe("5");
    expect(uuidV3(UUID_NAMESPACES.dns, "x")[14]).toBe("3");
  });

  it("matches the shape of a uuid", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "x")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("has one that means none", () => {
    expect(nilUuid()).toBe("00000000-0000-0000-0000-000000000000");
  });
});

/**
 * A normal comparison stops at the first difference, so how long it took says
 * how much of the secret was right.
 */
describe("comparing secrets", () => {
  it("says when they match", () => {
    expect(secureCompare("token", "token")).toBe(true);
  });

  it("says when they do not", () => {
    expect(secureCompare("token", "tokeN")).toBe(false);
  });

  // Hashed rather than returning early, so the time taken does not say how
  // long the secret was either.
  it("handles different lengths without giving the length away", () => {
    expect(secureCompare("a", "abcdefgh")).toBe(false);
  });

  it("compares bytes of equal length", () => {
    const a = new Uint8Array([1, 2, 3]);

    expect(fixedLengthSecureCompare(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(fixedLengthSecureCompare(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(fixedLengthSecureCompare(a, new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("strings", () => {
  it("collapses whitespace", () => {
    expect(squish("  a   b \n c  ")).toBe("a b c");
  });

  it("indents every line but not the empty ones", () => {
    expect(indent("a\nb", 2)).toBe("  a\n  b");
    expect(indent("a\n\nb", 2)).toBe("  a\n\n  b");
  });

  // Bytes rather than characters, without splitting one in half — which is
  // what a naive slice does to anything outside ASCII.
  it("cuts to a byte length without breaking a character", () => {
    expect(truncateBytes("hello", 10)).toBe("hello");

    const cut = truncateBytes("ありがとうございます", 12);

    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(12);
    expect(cut.endsWith("…")).toBe(true);
  });
});

/**
 * Rails filters `password` out of every logged parameter hash. This framework
 * logs no parameters at all today, so nothing is leaking — but an application
 * that logs its own needs this, and so does anything reporting an exception
 * with the request attached.
 */
describe("filtering parameters", () => {
  const filter = new ParameterFilter();

  it("replaces a password anywhere in the tree", () => {
    expect(filter.filter({ user: { password: "hunter2", name: "Ada" } })).toEqual({
      user: { password: FILTERED, name: "Ada" },
    });
  });

  // `passw` catches `password`, `password_confirmation` and `PasswordDigest`
  // without any of them being listed, which is how one stops being missed.
  it("matches a name anywhere in the key, in any case", () => {
    const filtered = filter.filter({
      password_confirmation: "x",
      PasswordDigest: "y",
      api_token: "z",
    }) as Record<string, string>;

    expect(Object.values(filtered)).toEqual([FILTERED, FILTERED, FILTERED]);
  });

  it("leaves everything else alone", () => {
    expect(filter.filter({ title: "A", count: 2 })).toEqual({ title: "A", count: 2 });
  });

  // A filtered key filters everything under it: `credentials: { aws: { key } }`
  // should not leak because the inner key was spelled differently.
  it("filters everything under a filtered key", () => {
    expect(filter.filter({ secret: { aws: { anything: "x" } } })).toEqual({
      secret: { aws: { anything: FILTERED } },
    });
  });

  it("reaches through arrays", () => {
    expect(filter.filter({ tokens: ["a", "b"] })).toEqual({ tokens: [FILTERED, FILTERED] });
  });

  /**
   * A copy, not an edit. The thing being filtered is usually the parameters
   * the request is still using, and filtering them for a log must not change
   * what the controller reads.
   */
  it("does not change what it was given", () => {
    const params = { user: { password: "hunter2" } };
    filter.filter(params);

    expect(params.user.password).toBe("hunter2");
  });

  it("takes its own list", () => {
    const only = new ParameterFilter(["pin"]);

    expect(only.filter({ pin: "1234", password: "x" })).toEqual({
      pin: FILTERED,
      password: "x",
    });
  });

  it("takes a pattern", () => {
    const byPattern = new ParameterFilter([/^card_/]);

    expect(byPattern.filter({ card_number: "4111", name: "Ada" })).toEqual({
      card_number: FILTERED,
      name: "Ada",
    });
  });
});
