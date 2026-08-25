/**
 * Typed attributes.
 *
 * Mirrors activemodel/test/cases/attributes_test.rb and type/boolean_test.rb.
 * The boolean cases are the ones that matter: an unchecked checkbox posts "0",
 * and a model that reached for `Boolean(value)` would read that as yes.
 */

import { describe, expect, it } from "bun:test";
import { ActiveModel, castBoolean, casterFor } from "../src/index.js";

class Search extends ActiveModel {
  declare query: string | null;
  declare page: number | null;
  declare ratio: number | null;
  declare unread: boolean | null;
  declare since: Date | null;
  declare filters: unknown;

  static {
    this.attribute("query", "string");
    this.attribute("page", "integer", { default: 1 });
    this.attribute("ratio", "float");
    this.attribute("unread", "boolean", { default: false });
    this.attribute("since", "date");
    this.attribute("filters", "json", { default: () => [] });
  }
}

describe("casting what a form posted", () => {
  it("turns a numeric string into a number", () => {
    const search = Search.build({ page: "2", ratio: "0.5" });

    expect(search.page).toBe(2);
    expect(search.ratio).toBe(0.5);
  });

  it("truncates rather than rounding an integer", () => {
    expect(Search.build({ page: "2.9" }).page).toBe(2);
  });

  it("gives null for something that is not a number", () => {
    expect(Search.build({ page: "many" }).page).toBeNull();
    expect(Search.build({ page: "" }).page).toBeNull();
  });

  it("keeps a string a string", () => {
    expect(Search.build({ query: "bun" }).query).toBe("bun");
    expect(Search.build({ query: 7 as unknown as string }).query).toBe("7");
  });

  it("parses a date", () => {
    expect(Search.build({ since: "2026-01-15" }).since?.toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
  });

  // A date with no time is the same date everywhere. Keeping a time on it
  // makes a birthday shift a day for anyone east or west of the server.
  it("strips the time from a date", () => {
    expect(Search.build({ since: "2026-01-15T23:30:00Z" }).since?.toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
  });

  it("parses json", () => {
    expect(Search.build({ filters: '["a","b"]' }).filters).toEqual(["a", "b"]);
  });

  // A malformed body is not a reason to fail the whole assignment; the
  // validation that cares can see it is null and say so in words.
  it("gives null for json it cannot parse", () => {
    expect(Search.build({ filters: "{not json" }).filters).toBeNull();
  });
});

// The reason this is written out rather than reaching for `Boolean(value)`.
describe("booleans", () => {
  it("reads an unchecked checkbox as no", () => {
    expect(castBoolean("0")).toBe(false);
    expect(Search.build({ unread: "0" }).unread).toBe(false);
  });

  it("reads the other spellings of no", () => {
    for (const value of ["", "f", "false", "FALSE", "off", "no", "n", " 0 "]) {
      expect(castBoolean(value)).toBe(false);
    }
  });

  it("reads a checked one as yes", () => {
    for (const value of ["1", "on", "true", "yes", "anything"]) {
      expect(castBoolean(value)).toBe(true);
    }
  });

  it("takes a real boolean as it is", () => {
    expect(castBoolean(true)).toBe(true);
    expect(castBoolean(false)).toBe(false);
  });

  it("reads zero as no and any other number as yes", () => {
    expect(castBoolean(0)).toBe(false);
    expect(castBoolean(-1)).toBe(true);
  });

  it("leaves nothing as nothing", () => {
    expect(castBoolean(null)).toBeNull();
    expect(castBoolean(undefined)).toBeNull();
  });
});

describe("defaults", () => {
  it("apply when nothing was given", () => {
    const search = Search.build({});

    expect(search.page).toBe(1);
    expect(search.unread).toBe(false);
  });

  it("give way to what was given", () => {
    expect(Search.build({ page: "5" }).page).toBe(5);
  });

  // A default of `[]` handed to every record is one array they all push into.
  it("are computed per record when they are a function", () => {
    const one = Search.build({});
    const two = Search.build({});

    (one.filters as unknown[]).push("mine");

    expect(two.filters).toEqual([]);
  });

  it("are cast like anything else", () => {
    class Paged extends ActiveModel {
      declare size: number | null;
      static {
        this.attribute("size", "integer", { default: "25" });
      }
    }

    expect(Paged.build({}).size).toBe(25);
  });
});

describe("the rest of the model still works", () => {
  it("includes declared attributes in `attributes()`", () => {
    expect(Search.build({ query: "bun", page: "3" }).attributes()).toMatchObject({
      query: "bun",
      page: 3,
    });
  });

  it("serializes them", () => {
    const json = JSON.parse(JSON.stringify(Search.build({ page: "3" }))) as { page: number };

    expect(json.page).toBe(3);
  });

  it("tracks changes on them", () => {
    const search = Search.build({ page: "1" });
    search.page = 4;

    expect(search.changed()).toContain("page");
    expect(search.attributeWas("page")).toBe(1);
  });

  it("validates them, against the cast value", async () => {
    class Bounded extends ActiveModel {
      declare page: number | null;
      static {
        this.attribute("page", "integer");
        this.validates("page", { numericality: { greaterThan: 0 } });
      }
    }

    const bad = Bounded.build({ page: "0" });

    expect(await bad.validate()).toBe(false);
    expect(await Bounded.build({ page: "2" }).validate()).toBe(true);
  });

  it("does not leak a subclass's attributes into its parent", () => {
    class Narrower extends Search {
      static {
        this.attribute("extra", "string");
      }
    }
    void Narrower;

    expect(Object.keys(Search.attributeTypes)).not.toContain("extra");
  });
});

describe("a caster of one's own", () => {
  it("is used as given", () => {
    const upper = casterFor((value: unknown) => String(value).toUpperCase());

    expect(upper("hello")).toBe("HELLO");
  });

  it("can be declared on a model", () => {
    class Tagged extends ActiveModel {
      declare tags: string[];
      static {
        this.attribute("tags", (value: unknown) =>
          typeof value === "string" ? value.split(",").map((tag) => tag.trim()) : (value ?? []),
        );
      }
    }

    expect(Tagged.build({ tags: "a, b ,c" }).tags).toEqual(["a", "b", "c"]);
  });
});
