/**
 * The methods a model gets for free from its attributes, ported from
 * `activemodel/test/cases/attribute_methods_test.rb`,
 * `activemodel/test/cases/type/date_time_test.rb` and the normalisation cases
 * in `activerecord/test/cases/normalized_attribute_test.rb`.
 *
 * The cases worth having are the ordering one — `reset_title!` has two
 * readings and only one of them is right — and the casting ones, where a value
 * silently becomes a different value.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  applyPendingAttributeModifications,
  applySecondsPrecision,
  assignAttributes,
  assignDataWithTypeCasting,
  attributeMethodAffix,
  attributeMethodPrefix,
  attributeMethodSuffix,
  decorateAttributes,
  defineAttributeAccessorMethod,
  defineOn,
  findBy_,
  forceEquality,
  itselfIfSerializeCastValueCompatible,
  normalizeAttribute,
  queryConditionValue,
  registeredPatterns,
  resetPatterns,
  serializeCastValueCompatible,
  strictMatch,
  toImmutableString,
  transformsQueryPredicates,
  userInputInTimeZone,
} from "../src/attribute_patterns.js";

afterEach(() => {
  resetPatterns();
});

describe("declaring a family of methods", () => {
  it("registers a prefix", () => {
    expect(attributeMethodPrefix("reset_")[0]).toEqual({
      prefix: "reset_",
      suffix: "",
      target: "reset_attribute",
    });
  });

  it("registers a suffix", () => {
    expect(attributeMethodSuffix("_changed?")[0]?.target).toBe("attribute_changed?");
  });

  it("registers an affix", () => {
    expect(attributeMethodAffix({ prefix: "reset_", suffix: "!" })[0]?.target).toBe(
      "reset_attribute!",
    );
  });

  it("registers several at once", () => {
    attributeMethodSuffix("_changed?", "_was");

    expect(registeredPatterns()).toHaveLength(2);
  });
});

describe("matching a method name to a pattern", () => {
  /**
   * The whole reason affixes are a separate kind: `reset_title!` matches the
   * `reset_` prefix and the `!` suffix independently, and resolving it that
   * way asks for the attribute `title!`, which does not exist.
   */
  it("prefers the longest match", () => {
    attributeMethodPrefix("reset_");
    attributeMethodSuffix("!");
    attributeMethodAffix({ prefix: "reset_", suffix: "!" });

    const found = strictMatch("reset_title!");

    expect(found?.attribute).toBe("title");
    expect(found?.pattern.target).toBe("reset_attribute!");
  });

  /**
   * Sorted by length rather than by declaration order, so the behaviour does
   * not depend on which of two unrelated concerns happened to load first.
   */
  it("does not depend on declaration order", () => {
    attributeMethodAffix({ prefix: "reset_", suffix: "!" });
    attributeMethodPrefix("reset_");

    expect(strictMatch("reset_title!")?.attribute).toBe("title");
  });

  it("matches a plain prefix", () => {
    attributeMethodPrefix("reset_");

    expect(strictMatch("reset_title")?.attribute).toBe("title");
  });

  it("matches nothing it does not recognise", () => {
    attributeMethodPrefix("reset_");

    expect(strictMatch("save")).toBeUndefined();
  });

  /** Both ends have to match, or `title_was` resolves under a `_changed?` pattern. */
  it("requires the suffix as well as the prefix", () => {
    attributeMethodAffix({ prefix: "reset_", suffix: "!" });

    expect(strictMatch("reset_title")).toBeUndefined();
    expect(strictMatch("reset_title!")?.attribute).toBe("title");
  });

  /** A pattern matching an empty attribute would resolve `reset_` itself. */
  it("does not match an empty attribute", () => {
    attributeMethodPrefix("reset_");

    expect(strictMatch("reset_")).toBeUndefined();
  });

  it("checks the attribute exists when it is given the list", () => {
    attributeMethodPrefix("reset_");

    expect(strictMatch("reset_title", registeredPatterns(), ["title"])?.attribute).toBe("title");
    expect(strictMatch("reset_absent", registeredPatterns(), ["title"])).toBeUndefined();
  });
});

describe("defining a generated method", () => {
  /**
   * Silently overwriting is how an attribute called `class` or `send` breaks a
   * model in a way that has nothing to do with the attribute.
   */
  it("refuses to replace something the class already has", () => {
    const target = { save: () => undefined };

    expect(() => defineAttributeAccessorMethod(target, "save", () => 1)).toThrow("already defined");
  });

  it("defines one that is free", () => {
    const target: Record<string, unknown> = {};
    defineAttributeAccessorMethod(target, "title", () => "a");

    expect(typeof target["title"]).toBe("function");
  });

  it("replaces when told to", () => {
    const target: Record<string, unknown> = { title: 1 };

    expect(() =>
      defineAttributeAccessorMethod(target, "title", () => 2, { force: true }),
    ).not.toThrow();
  });

  /**
   * A separate container, so an application method of the same name shadows
   * the generated one rather than being overwritten by it.
   */
  it("puts generated methods somewhere of their own, and keeps it", () => {
    const owner: { generated?: Record<string, unknown> } = {};
    const first = defineOn(owner);
    first["title"] = () => "a";

    // A fresh container per call would drop every method defined so far, which
    // reads as an attribute that exists and has no reader.
    expect(defineOn(owner)).toBe(first);
    expect(defineOn(owner)["title"]).toBeDefined();
  });
});

describe("dynamic finders", () => {
  const attributes = ["title", "author"];

  it("parses one attribute", () => {
    expect(findBy_("findByTitle", attributes)).toEqual({ attributes: ["title"], bang: false });
  });

  it("parses several", () => {
    expect(findBy_("findByTitleAndAuthor", attributes)?.attributes).toEqual(["title", "author"]);
  });

  it("notices the bang form", () => {
    expect(findBy_("findByTitleBang", attributes)?.bang).toBe(true);
  });

  /**
   * A partial match would build a query against a column that is not there,
   * which fails in the adapter with a message about SQL rather than about the
   * method that was called.
   */
  it("refuses a name that is not an attribute", () => {
    expect(findBy_("findByTitleAndAbsent", attributes)).toBeUndefined();
  });

  it("ignores anything that is not a finder", () => {
    expect(findBy_("save", attributes)).toBeUndefined();
  });
});

describe("pending declarations", () => {
  /**
   * A later declaration wins, but only for what it actually said: declaring a
   * type without a default must not clear a default declared earlier.
   */
  it("merges rather than replacing", () => {
    const applied = applyPendingAttributeModifications([
      { name: "price", type: "integer", default: 0 },
      { name: "price", type: "decimal" },
    ]);

    expect(applied.get("price")).toEqual({ name: "price", type: "decimal", default: 0 });
  });

  it("keeps declarations for different names apart", () => {
    expect(applyPendingAttributeModifications([{ name: "a" }, { name: "b" }]).size).toBe(2);
  });

  /** An explicitly absent key is silence, not an instruction to clear. */
  it("does not let an undefined value clear an earlier one", () => {
    const applied = applyPendingAttributeModifications([
      { name: "price", default: 0 },
      { name: "price", type: "integer", default: undefined },
    ]);

    expect(applied.get("price")?.default).toBe(0);
  });

  /** A decorator that invented a type would hide the missing column. */
  it("decorates only names that have a type", () => {
    const decorated = decorateAttributes(
      new Map([["price", "integer"]]),
      ["price", "absent"],
      (type) => `encrypted(${type})`,
    );

    expect(decorated.get("price")).toBe("encrypted(integer)");
    expect(decorated.has("absent")).toBe(false);
  });

  /**
   * Ignoring a name nothing recognises is how a typo in a form or a fixture
   * becomes a value that is never saved and never reported.
   */
  it("refuses an unknown attribute", () => {
    expect(() => assignAttributes({}, { titel: "a" }, ["title"])).toThrow("titel");
  });

  it("assigns what it recognises", () => {
    const record: Record<string, unknown> = {};

    expect(assignAttributes(record, { title: "a" }, ["title"])).toEqual(["title"]);
    expect(record["title"]).toBe("a");
  });
});

describe("casting", () => {
  /**
   * Casting lazily on read would mean two reads of an unsaved value can
   * differ — the first through the cast, the second from a cache holding the
   * raw input.
   */
  it("casts on the way in", () => {
    expect(assignDataWithTypeCasting({ price: "7" }, (_name, value) => Number(value))).toEqual({
      price: 7,
    });
  });

  /**
   * Truncates rather than rounds: rounding can move a timestamp forward past
   * the moment it describes, so a record created at 12:00:00.9 would claim to
   * have been created at 12:00:01 — a moment that had not happened.
   */
  it("truncates a timestamp to the column's precision", () => {
    const at = new Date("2026-01-01T12:00:00.900Z");

    expect(applySecondsPrecision(at, 0).toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(applySecondsPrecision(at, 1).toISOString()).toBe("2026-01-01T12:00:00.900Z");
  });

  it("leaves a value alone at full precision", () => {
    const at = new Date("2026-01-01T12:00:00.123Z");

    expect(applySecondsPrecision(at, 3)).toBe(at);
    expect(applySecondsPrecision(at, undefined)).toBe(at);
  });

  /**
   * A string a person typed has no zone, and reading it as UTC shifts every
   * time somebody enters by their offset.
   */
  it("reads a typed time in the application's zone", () => {
    expect(userInputInTimeZone("2026-01-01 09:00", 60)?.toISOString()).toBe(
      "2026-01-01T08:00:00.000Z",
    );
  });

  it("reads seconds when they are given", () => {
    expect(userInputInTimeZone("2026-01-01 09:00:30", 0)?.toISOString()).toBe(
      "2026-01-01T09:00:30.000Z",
    );
  });

  it("leaves a string that already has a zone alone", () => {
    expect(userInputInTimeZone("2026-01-01T09:00:00Z", 60)?.toISOString()).toBe(
      "2026-01-01T09:00:00.000Z",
    );
  });

  it("reads nothing from something that is not a time", () => {
    expect(userInputInTimeZone("not a time", 0)).toBeUndefined();
  });
});

describe("how a value reaches a condition", () => {
  /**
   * A type that answered wrongly turns `where(id: 1..3)` into `id = '1..3'`,
   * which matches nothing and reports no error.
   */
  it("says which values are not plain equality", () => {
    expect(forceEquality(1)).toBe(true);
    expect(forceEquality("a")).toBe(true);
    expect(forceEquality([1, 2])).toBe(false);
    expect(forceEquality(new Set([1]))).toBe(false);
    expect(forceEquality({ begin: 1, end: 3 })).toBe(false);
  });

  it("does not mistake an ordinary object for a range", () => {
    expect(forceEquality({ begin: 1 })).toBe(true);
  });

  /**
   * Declared rather than inferred: a type that quietly rewrote a predicate
   * would make an index somebody built stop being used with nothing to point
   * at.
   */
  it("says whether a type rewrites the comparison", () => {
    expect(transformsQueryPredicates({ transformsPredicates: true })).toBe(true);
    expect(transformsQueryPredicates({})).toBe(false);
  });

  it("serializes each element of a list", () => {
    expect(queryConditionValue([1, 2], (value) => String(value))).toEqual(["1", "2"]);
    expect(queryConditionValue(1, (value) => String(value))).toBe("1");
  });
});

describe("handing a value out", () => {
  /**
   * Ruby freezes here because its strings are mutable. A JavaScript string
   * primitive already is, so the conversion is the whole guarantee — what it
   * buys is that an object with a `toString` is not handed out as a live
   * reference to itself.
   */
  it("hands out a string rather than the object behind it", () => {
    const live = { value: "a", toString: () => "a" };
    const handed = toImmutableString(live);

    live.value = "b";

    expect(handed).toBe("a");
    expect(typeof handed).toBe("string");
    expect(toImmutableString(7)).toBe("7");
  });
});

describe("whether cast and serialize agree", () => {
  /**
   * A time is the clearest case: casting truncates to the column's precision,
   * and serializing from the truncated value would truncate a second time.
   */
  it("says no for a type with a precision", () => {
    expect(serializeCastValueCompatible({ precision: 6 })).toBe(false);
    expect(itselfIfSerializeCastValueCompatible({ precision: 6 })).toBeUndefined();
  });

  it("says yes when there is one conversion", () => {
    const same = () => 1;

    expect(serializeCastValueCompatible({ cast: same, serialize: same })).toBe(true);
    expect(serializeCastValueCompatible({ cast: same })).toBe(true);
  });

  it("says no when they differ", () => {
    expect(serializeCastValueCompatible({ cast: () => 1, serialize: () => 2 })).toBe(false);
  });

  it("hands the type back when they agree", () => {
    const type = { precision: undefined, cast: undefined, serialize: undefined };

    expect(itselfIfSerializeCastValueCompatible(type)).toBe(type);
  });
});

describe("normalising an attribute", () => {
  const trim = (value: unknown) => String(value).trim();

  it("normalises on write", () => {
    expect(normalizeAttribute("  a  ", trim)).toBe("a");
  });

  /**
   * Applied on read as well, a record loaded from a row written before the
   * normalisation existed would report itself unchanged while holding a
   * different value than the row — and the next save would write the
   * normalised form with no record of why.
   */
  it("leaves a loaded value alone", () => {
    expect(normalizeAttribute("  a  ", trim, { onRead: true })).toBe("  a  ");
  });

  /** Normalising a null would turn "no value" into the string "null". */
  it("leaves an absent value alone", () => {
    expect(normalizeAttribute(null, trim)).toBe(null);
    expect(normalizeAttribute(undefined, trim)).toBe(undefined);
  });
});
