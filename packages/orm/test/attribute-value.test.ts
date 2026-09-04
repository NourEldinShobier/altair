/**
 * Every attribute of a record together, ported from
 * `activemodel/test/cases/attribute_set_test.rb` and the dirty-tracking cases
 * in `activerecord/test/cases/dirty_test.rb`.
 *
 * The questions here are about the record rather than the column, and they are
 * the ones a save asks: which columns changed, what did they hold before, what
 * goes in the placeholders, and whether to issue a statement at all.
 */

import { describe, expect, it } from "bun:test";
import { Attribute } from "../src/attribute.js";
import { IntegerType, StringType } from "../src/types.js";
import {
  AttributeSet,
  UNTYPED,
  attributeChangedInPlace,
  cameFromUser,
  dupOrShare,
  initialized,
  serializable,
  serializeCastValue,
  typeCast,
  valueConstructedByMassAssignment,
  withUserDefault,
} from "../src/attribute-value.js";

const string = new StringType();
const integer = new IntegerType();

describe("building a set", () => {
  it("holds a row from the database", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello", views: 3 });

    expect(set.fetchValue("title")).toBe("hello");
    expect(set.size).toBe(2);
  });

  it("casts through the type it was given", () => {
    const set = AttributeSet.buildFromDatabase({ views: "3" }, { views: integer });

    expect(set.fetchValue("views")).toBe(3);
  });

  it("gives nothing for a name it does not hold", () => {
    expect(AttributeSet.buildFromDatabase({}).fetchValue("nope")).toBeUndefined();
  });

  it("hands back the attribute itself", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });

    expect(set.resolveValue("title")).toBeInstanceOf(Attribute);
  });

  it("says which names it holds", () => {
    const set = AttributeSet.buildFromDatabase({ title: "a", body: "b" });

    expect(set.keys().sort()).toEqual(["body", "title"]);
    expect(set.has("title")).toBe(true);
    expect(set.has("nope")).toBe(false);
  });

  /**
   * Uninitialized, not null. A column nobody assigned takes the database's
   * default; one explicitly set to null is written as NULL. Collapsing them is
   * how a `created_at` with a default comes out null.
   */
  it("starts declared columns uninitialized rather than null", () => {
    const set = AttributeSet.initAttributes({ title: string, views: integer });

    expect(initialized(set.resolveValue("title") as Attribute)).toBe(false);
    expect(Object.keys(set.valuesForDatabase())).toEqual([]);
  });
});

describe("what changed", () => {
  /** A value from the database is not a change, whatever it equals. */
  it("reports nothing changed on a freshly loaded row", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });

    expect(set.anyChanges()).toBe(false);
    expect(set.changedAttributeNames()).toEqual([]);
  });

  it("reports a change once something is assigned", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });

    set.writeFromUser("title", "goodbye");

    expect(set.anyChanges()).toBe(true);
    expect(set.changedAttributeNames()).toEqual(["title"]);
  });

  it("reports what it held before", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });
    set.writeFromUser("title", "goodbye");

    expect(set.changedValues()).toEqual({ title: "hello" });
  });

  /** Two assignments still compare against what was loaded, not against the first. */
  it("compares against the loaded value through several assignments", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });
    set.writeFromUser("title", "middle");
    set.writeFromUser("title", "goodbye");

    expect(set.changedValues()).toEqual({ title: "hello" });
  });

  it("reports nothing changed when the value was assigned back", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });

    set.writeFromUser("title", "hello");

    expect(set.anyChanges()).toBe(false);
  });

  it("leaves other attributes out", () => {
    const set = AttributeSet.buildFromDatabase({ title: "a", body: "b" });
    set.writeFromUser("title", "changed");

    expect(set.changedAttributeNames()).toEqual(["title"]);
  });

  /** A reload is not a change. */
  it("reports nothing changed after a value from the database", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });

    set.writeFromDatabase("title", "reloaded");

    expect(set.anyChanges()).toBe(false);
    expect(set.fetchValue("title")).toBe("reloaded");
  });
});

describe("values for the database", () => {
  it("gives what goes in the placeholders", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello", views: 3 });

    expect(set.valuesForDatabase()).toEqual({ title: "hello", views: 3 });
  });

  /**
   * Left out of the INSERT so the column takes its database default.
   *
   * The key's *absence* is the assertion, not the object's shape: `toEqual`
   * treats a key holding `undefined` as equal to one that is not there, so an
   * uninitialized column leaking into the statement would pass unnoticed.
   */
  it("leaves out a column nobody touched", () => {
    const set = AttributeSet.initAttributes({ title: string, created_at: string });
    set.writeFromUser("title", "hello", string);

    expect(Object.keys(set.valuesForDatabase())).toEqual(["title"]);
  });

  /**
   * What a validation error echoes back — showing the cast value shows `0` to
   * somebody who typed `banana`.
   */
  it("keeps what each attribute arrived as", () => {
    const set = AttributeSet.buildFromDatabase({ views: "banana" }, { views: integer });

    expect(set.valuesBeforeTypeCast()).toEqual({ views: "banana" });
  });
});

describe("finalizing after a save", () => {
  /**
   * Without this the next save writes the same values again, and
   * `saved_changes` reports a change that happened two saves ago.
   */
  it("makes everything count as unchanged", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });
    set.writeFromUser("title", "goodbye");

    set.finalizeChanges();

    expect(set.anyChanges()).toBe(false);
    expect(set.changedAttributeNames()).toEqual([]);
  });

  it("keeps the values it was given", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });
    set.writeFromUser("title", "goodbye");

    set.finalizeChanges();

    expect(set.fetchValue("title")).toBe("goodbye");
  });

  it("makes the new value the one a later change compares against", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });
    set.writeFromUser("title", "goodbye");
    set.finalizeChanges();

    set.writeFromUser("title", "again");

    expect(set.changedValues()).toEqual({ title: "goodbye" });
  });

  /**
   * For `touch`, and for a column the database computes: nothing new to write
   * but the row has to be written.
   */
  it("can force one to count as changed", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });

    set.forceChange("title");

    expect(set.changedAttributeNames()).toEqual(["title"]);
  });

  it("can forget one change without forgetting the others", () => {
    const set = AttributeSet.buildFromDatabase({ title: "a", body: "b" });
    set.writeFromUser("title", "changed");
    set.writeFromUser("body", "changed");

    set.forgetChange("title");

    expect(set.changedAttributeNames()).toEqual(["body"]);
  });

  /** Or the record stays permanently dirty and every later save writes again. */
  it("clears a forced change too", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello" });
    set.forceChange("title");

    set.finalizeChanges();

    expect(set.anyChanges()).toBe(false);
    expect(set.changedAttributeNames()).toEqual([]);
  });

  it("does nothing for a name it does not hold", () => {
    const set = AttributeSet.buildFromDatabase({});

    expect(() => set.forceChange("nope")).not.toThrow();
    expect(() => set.forgetChange("nope")).not.toThrow();
  });
});

describe("copying", () => {
  /**
   * Sharing a mutable value means an in-place edit on the copy is one on the
   * original, so a `dup`ed record marks the record it came from as changed.
   */
  it("does not share an array between copies", () => {
    const set = AttributeSet.buildFromDatabase({ tags: ["a"] });
    const copy = set.dupOrShare();

    (copy.fetchValue("tags") as string[]).push("b");

    expect(set.fetchValue("tags")).toEqual(["a"]);
  });

  it("does not share an object either", () => {
    const set = AttributeSet.buildFromDatabase({ settings: { theme: "dark" } });
    const copy = set.dupOrShare();

    (copy.fetchValue("settings") as Record<string, unknown>)["theme"] = "light";

    expect(set.fetchValue("settings")).toEqual({ theme: "dark" });
  });

  /** Most attributes, on every dup of every record. */
  it("shares an immutable value rather than copying it", () => {
    const attribute = Attribute.fromDatabase("title", "hello", string);

    expect(dupOrShare(attribute)).toBe(attribute);
  });

  it("shares a date rather than treating it as a plain object", () => {
    const attribute = Attribute.fromDatabase("at", new Date(0), string);

    expect(dupOrShare(attribute)).toBe(attribute);
  });

  it("keeps the copy's own values readable", () => {
    const set = AttributeSet.buildFromDatabase({ title: "hello", tags: ["a"] });

    expect(set.dupOrShare().fetchValue("title")).toBe("hello");
  });
});

describe("asking an attribute about itself", () => {
  it("says where it came from", () => {
    expect(cameFromUser(Attribute.fromUser("title", "x", string))).toBe(true);
    expect(cameFromUser(Attribute.fromDatabase("title", "x", string))).toBe(false);
  });

  it("says whether it has a value at all", () => {
    expect(initialized(Attribute.fromDatabase("title", "x", string))).toBe(true);
    expect(initialized(Attribute.uninitialized("title", string))).toBe(false);
  });

  it("says whether it can be written", () => {
    expect(serializable(Attribute.fromDatabase("title", "x", string))).toBe(true);
    expect(serializable(Attribute.uninitialized("title", string))).toBe(false);
  });

  it("casts a value through the attribute's type", () => {
    expect(typeCast(Attribute.fromDatabase("views", 1, integer), "3")).toBe(3);
  });

  it("serializes one", () => {
    expect(serializeCastValue(Attribute.fromDatabase("views", 1, integer), 3)).toBe(3);
  });

  it("reports an in-place change", () => {
    const attribute = Attribute.fromDatabase("title", "x", string);

    expect(attributeChangedInPlace(attribute)).toBe(false);
  });
});

describe("a value that is really a nested form", () => {
  /**
   * A nested hash or array assigned to one attribute is almost always a nested
   * form's parameters, and treating it as a value stores `[object Object]`.
   */
  it("recognises one", () => {
    expect(valueConstructedByMassAssignment({ title: "x" })).toBe(true);
    expect(valueConstructedByMassAssignment([1, 2])).toBe(true);
  });

  it("leaves an ordinary value alone", () => {
    expect(valueConstructedByMassAssignment("hello")).toBe(false);
    expect(valueConstructedByMassAssignment(3)).toBe(false);
    expect(valueConstructedByMassAssignment(null)).toBe(false);
    expect(valueConstructedByMassAssignment(new Date())).toBe(false);
  });
});

describe("a default for what the user did not give", () => {
  it("fills in an attribute nobody set", () => {
    const attribute = withUserDefault(Attribute.uninitialized("status", string), "draft");

    expect(attribute.value).toBe("draft");
  });

  it("leaves one that was set alone", () => {
    const attribute = Attribute.fromUser("status", "published", string);

    expect(withUserDefault(attribute, "draft")).toBe(attribute);
  });

  /** An explicit null is a value, not an absence. */
  it("leaves an explicit null alone", () => {
    const attribute = Attribute.fromUser("status", null, string);

    expect(withUserDefault(attribute, "draft").value).toBeNull();
  });
});

describe("the untyped fallback", () => {
  it("exists for an attribute nobody declared a type for", () => {
    const set = AttributeSet.buildFromDatabase({ whatever: "x" });

    expect(set.resolveValue("whatever")?.type).toBe(UNTYPED);
  });
});
