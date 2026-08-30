/**
 * Attributes, ported from `activemodel/test/cases/attribute_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import { Attribute } from "../src/attribute.js";
import { BooleanType, DateTimeType, IntegerType, JsonType, StringType } from "../src/types.js";

describe("where the value came from", () => {
  /** For most types these agree, which is exactly why the distinction is lost. */
  it("deserializes a value from the database", () => {
    expect(Attribute.fromDatabase("a", "42", new IntegerType()).value).toBe(42);
  });

  it("casts a value from a user", () => {
    expect(Attribute.fromUser("a", "42", new IntegerType()).value).toBe(42);
  });

  it("leaves an already-cast value alone", () => {
    expect(Attribute.withCastValue("a", 42, new IntegerType()).value).toBe(42);
  });

  /** The case where they differ: a JSON column round-trips through a string. */
  it("parses a JSON column from the database but not from a cast value", () => {
    const fromDatabase = Attribute.fromDatabase("a", '{"x":1}', new JsonType());
    const alreadyCast = Attribute.withCastValue("a", { x: 1 }, new JsonType());

    expect(fromDatabase.value).toEqual({ x: 1 });
    expect(alreadyCast.value).toEqual({ x: 1 });
  });

  it("keeps the value it was given before casting", () => {
    expect(Attribute.fromUser("a", "42", new IntegerType()).valueBeforeTypeCast).toBe("42");
  });

  it("reports its source", () => {
    expect(Attribute.fromUser("a", 1, new IntegerType()).source).toBe("user");
    expect(Attribute.fromDatabase("a", 1, new IntegerType()).source).toBe("database");
  });

  /** Casting is not always cheap, and an attribute is read far more than written. */
  it("computes the value once", () => {
    let casts = 0;
    class Counting extends StringType {
      protected override castValue(value: unknown): string {
        casts += 1;
        return String(value);
      }
    }

    const attribute = Attribute.fromUser("a", 1, new Counting());
    const first = attribute.value;
    const second = attribute.value;

    expect(first).toBe(second);
    expect(casts).toBe(1);
  });
});

describe("uninitialized", () => {
  /**
   * Distinct from holding null, and the difference shows on save: a column
   * nobody assigned takes the database default, one set to null is written as
   * NULL. Collapsing them is how a created_at with a default comes out null.
   */
  it("is not the same as null", () => {
    const never = Attribute.uninitialized("a", new IntegerType());
    const explicit = Attribute.fromUser("a", null, new IntegerType());

    expect(never.isUninitialized).toBe(true);
    expect(explicit.isUninitialized).toBe(false);
    expect(never.value).toBeUndefined();
    expect(explicit.value).toBeNull();
  });

  it("never reports an in-place change", () => {
    expect(Attribute.uninitialized("a", new JsonType()).changedInPlace()).toBe(false);
  });
});

describe("valueForDatabase", () => {
  it("serializes through the type", () => {
    expect(Attribute.fromUser("a", { x: 1 }, new JsonType()).valueForDatabase()).toBe('{"x":1}');
  });

  it("serializes a boolean the way the type does", () => {
    expect(Attribute.fromUser("a", "0", new BooleanType()).valueForDatabase()).toBe(false);
  });
});

describe("changes", () => {
  it("reports no change without an original", () => {
    expect(Attribute.fromDatabase("a", 1, new IntegerType()).changed()).toBe(false);
  });

  it("reports a change against what it replaced", () => {
    const loaded = Attribute.fromDatabase("a", 1, new IntegerType());
    const assigned = loaded.withValueFromUser(2);

    expect(assigned.changed()).toBe(true);
    expect(assigned.originalValue()).toBe(1);
  });

  /** "1" and 1 are the same integer, so a resubmitted form is not an edit. */
  it("does not report a change for the same value in another form", () => {
    const loaded = Attribute.fromDatabase("a", 1, new IntegerType());

    expect(loaded.withValueFromUser("1").changed()).toBe(false);
  });

  /** What counts as a change is the type's business. */
  it("asks the type, so two Dates for one instant are unchanged", () => {
    const loaded = Attribute.fromDatabase("a", "2026-01-01T00:00:00Z", new DateTimeType());
    const assigned = loaded.withValueFromUser(new Date("2026-01-01T00:00:00Z"));

    expect(assigned.changed()).toBe(false);
  });

  it("keeps the first original across several assignments", () => {
    const loaded = Attribute.fromDatabase("a", 1, new IntegerType());
    const twice = loaded.withValueFromUser(2).withValueFromUser(3);

    expect(twice.originalValue()).toBe(1);
    expect(twice.value).toBe(3);
  });

  it("reports the original in its database form", () => {
    const loaded = Attribute.fromDatabase("a", { x: 1 }, new JsonType());
    const assigned = loaded.withValueFromUser({ x: 2 });

    expect(assigned.originalValueForDatabase()).toBe('{"x":1}');
  });
});

describe("changedInPlace", () => {
  /** Both sides are the same object, so an equality check sees nothing. */
  it("notices a mutation of a parsed value", () => {
    const attribute = Attribute.fromDatabase("a", '{"tags":["x"]}', new JsonType());
    const held = attribute.value as { tags: string[] };

    expect(attribute.changedInPlace()).toBe(false);

    held.tags.push("y");

    expect(attribute.changedInPlace()).toBe(true);
  });

  it("says no for an immutable type", () => {
    expect(Attribute.fromDatabase("a", "1", new IntegerType()).changedInPlace()).toBe(false);
  });

  it("counts either kind of change", () => {
    const attribute = Attribute.fromDatabase("a", '{"tags":[]}', new JsonType());
    (attribute.value as { tags: string[] }).tags.push("y");

    expect(attribute.changedInAnyWay()).toBe(true);
  });
});

describe("rebuilding", () => {
  it("takes a new type, keeping the raw value", () => {
    const asString = Attribute.fromDatabase("a", "42", new StringType());
    const asInteger = asString.withType(new IntegerType());

    expect(asString.value).toBe("42");
    expect(asInteger.value).toBe(42);
  });

  /** After a save the record must stop reporting a change it has written. */
  it("forgets the assignment", () => {
    const loaded = Attribute.fromDatabase("a", 1, new IntegerType());
    const saved = loaded.withValueFromUser(2).forgettingAssignment();

    expect(saved.value).toBe(2);
    expect(saved.changed()).toBe(false);
  });

  /** And a later in-place edit is still noticed afterwards. */
  it("still notices an in-place change after forgetting", () => {
    const loaded = Attribute.fromDatabase("a", '{"tags":[]}', new JsonType());
    const saved = loaded.withValueFromUser({ tags: ["x"] }).forgettingAssignment();

    expect(saved.changedInPlace()).toBe(false);

    (saved.value as { tags: string[] }).tags.push("y");

    expect(saved.changedInPlace()).toBe(true);
  });
});
