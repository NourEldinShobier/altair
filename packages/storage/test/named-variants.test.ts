/**
 * Variants under a name, ported from
 * `activestorage/test/models/variant_test.rb`.
 *
 * A transformation written at the call site is written slightly differently at
 * the next one, and the day the design changes there are eleven places to find
 * and a twelfth to miss.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  declareVariants,
  namedVariant,
  namedVariants,
  resetNamedVariants,
  transformationsFor,
} from "../src/named-variants.js";
import { releaseConnection, storageConnection } from "./support/database.js";

beforeEach(() => {
  resetNamedVariants();
  declareVariants("User", "avatar", {
    thumb: { resize: [100, 100] },
    hero: { resize: [1200, 600] },
  });
});

afterEach(() => {
  resetNamedVariants();
});

describe("a declared name", () => {
  it("stands for its transformations", () => {
    expect(namedVariant("User", "avatar", "thumb")).toEqual({ resize: [100, 100] });
  });

  it("lists what is declared", () => {
    expect(namedVariants("User", "avatar")).toEqual(["hero", "thumb"]);
  });

  it("belongs to one attachment on one model", () => {
    expect(namedVariant("User", "banner", "thumb")).toBeUndefined();
    expect(namedVariant("Post", "avatar", "thumb")).toBeUndefined();
  });

  it("can be added to", () => {
    declareVariants("User", "avatar", { icon: { resize: [16, 16] } });

    expect(namedVariants("User", "avatar")).toEqual(["hero", "icon", "thumb"]);
  });
});

describe("asking for one", () => {
  it("resolves a name", () => {
    expect(transformationsFor("User", "avatar", "hero")).toEqual({ resize: [1200, 600] });
  });

  it("passes transformations through untouched", () => {
    expect(transformationsFor("User", "avatar", { resize: [50, 50] })).toEqual({
      resize: [50, 50],
    });
  });

  /**
   * A typo would otherwise hand back the original at full size, which looks
   * like the variant working until somebody notices the page weighs nine
   * megabytes.
   */
  it("refuses a name nobody declared", () => {
    expect(() => transformationsFor("User", "avatar", "thumbnail")).toThrow(/No variant named/);
  });

  it("says which names there are", () => {
    expect(() => transformationsFor("User", "avatar", "nope")).toThrow(/hero, thumb/);
  });

  it("says so when there are none at all", () => {
    expect(() => transformationsFor("Post", "cover", "thumb")).toThrow(/None are declared/);
  });
});

/**
 * Declared through the attachment rather than by hand, which is the only way
 * an application would ever reach it — a declaration nothing consults is the
 * shape this codebase has spent a day removing.
 */
describe("declared on a model", () => {
  it("is remembered by the attachment declaration", async () => {
    const { Model, SchemaStatements, setConnection } = await import("@altair/orm");
    const { hasOneAttached } = await import("../src/attachment.js");

    const connection = await storageConnection();
    setConnection(connection);
    await new SchemaStatements(connection).createTable("people", (t) => t.string("name"));

    class Person extends Model<{ id: number; name: string }>("people") {
      declare avatar: unknown;

      static {
        hasOneAttached(this as never, "avatar" as never, {
          variants: { square: { resize: [64, 64] } },
        });
      }
    }

    void Person;

    expect(namedVariant("Person", "avatar", "square")).toEqual({ resize: [64, 64] });

    await releaseConnection(connection);
  });
});
