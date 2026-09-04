/**
 * The namespace a derived uuid is derived under, ported from
 * `activesupport/test/core_ext/digest/uuid_test.rb`.
 *
 * A uuid derived under the wrong namespace is stable, plausible, and different
 * from what every other RFC 4122 implementation produces. Nothing reports it;
 * it is found out when something has to interoperate.
 */

import { describe, expect, it } from "bun:test";
import { uuidFromHash } from "../src/digest.js";
import { UUID_NAMESPACES, packUuidNamespace, uuidV3, uuidV5 } from "../src/misc.js";

describe("a namespace as the bytes that are hashed", () => {
  it("is the sixteen bytes the uuid names", () => {
    const packed = packUuidNamespace(UUID_NAMESPACES.dns);

    expect(packed).toHaveLength(16);
    expect(packed.slice(0, 4)).toEqual(new Uint8Array([0x6b, 0xa7, 0xb8, 0x10]));
  });

  it("does not mind whether the dashes are there", () => {
    expect([...packUuidNamespace(UUID_NAMESPACES.oid)]).toEqual([
      ...packUuidNamespace(UUID_NAMESPACES.oid.replaceAll("-", "")),
    ]);
  });

  it("takes either case", () => {
    expect([...packUuidNamespace(UUID_NAMESPACES.url.toUpperCase())]).toEqual([
      ...packUuidNamespace(UUID_NAMESPACES.url),
    ]);
  });

  /**
   * Parsed leniently, a typo produces zero bytes where the hex was unreadable
   * — and the result is a uuid that is wrong in a way nothing can see: still
   * stable, still the right shape, derived from a namespace nobody chose.
   */
  it("refuses one that is not a uuid", () => {
    expect(() => packUuidNamespace("not-a-uuid")).toThrow("Only uuids are valid");
    expect(() => packUuidNamespace("6ba7b810-9dad-11d1-80b4-00c04fd430")).toThrow("Only uuids");
    expect(() => packUuidNamespace("zzzzzzzz-9dad-11d1-80b4-00c04fd430c8")).toThrow("Only uuids");
    expect(() => packUuidNamespace("")).toThrow("Only uuids");
  });

  it("names the namespace it refused", () => {
    expect(() => packUuidNamespace("nope")).toThrow('"nope"');
  });
});

describe("a uuid derived from a name", () => {
  /**
   * The values RFC 4122 gives for these inputs. Getting them right is the whole
   * point: an id derived here has to be the id another system derives.
   */
  it("matches the values the RFC defines", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    expect(uuidV3(UUID_NAMESPACES.dns, "www.example.com")).toBe(
      "5df41881-3aed-3515-88a7-2f4a814cf09e",
    );
  });

  /**
   * The namespace is part of the value: the same name under two namespaces is
   * two ids, which is what keeps two systems from colliding on "order-42".
   */
  it("differs by namespace", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "x")).not.toBe(uuidV5(UUID_NAMESPACES.url, "x"));
  });

  /** The version is part of the value, not two spellings of one uuid. */
  it("differs by version", () => {
    expect(uuidV5(UUID_NAMESPACES.dns, "x")).not.toBe(uuidV3(UUID_NAMESPACES.dns, "x"));
    expect(uuidV5(UUID_NAMESPACES.dns, "x")[14]).toBe("5");
    expect(uuidV3(UUID_NAMESPACES.dns, "x")[14]).toBe("3");
  });
});

describe("the one-argument form", () => {
  /**
   * Two derivations of one idea is how the fixture ids stopped matching Rails':
   * this one hashed the name alone and ignored the namespace, so it agreed with
   * nothing — including itself under another name.
   */
  it("is the OID namespace, and the same derivation", () => {
    expect(uuidFromHash("david")).toBe(uuidV5(UUID_NAMESPACES.oid, "david"));
  });

  it("takes another namespace", () => {
    expect(uuidFromHash("david", UUID_NAMESPACES.url)).toBe(uuidV5(UUID_NAMESPACES.url, "david"));
  });
});
