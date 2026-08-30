/**
 * Attribute types, ported from `activemodel/test/cases/type/*_test.rb`.
 *
 * The cases carried over are the ones about the four questions a type answers
 * that a plain cast function cannot: deserialize, serialize, changed, and
 * changedInPlace.
 */

import { describe, expect, it } from "bun:test";
import {
  BigIntegerType,
  BinaryType,
  BooleanType,
  DateTimeType,
  DateType,
  DecimalType,
  FloatType,
  ImmutableStringType,
  IntegerType,
  JsonType,
  StringType,
  TimeType,
  Type,
  lookupType,
  registerType,
  typeNames,
  typeRegistered,
} from "../src/types.js";

describe("the base type", () => {
  it("passes values through", () => {
    expect(new Type().cast("anything")).toBe("anything");
  });

  it("names itself value", () => {
    expect(new Type().type).toBe("value");
  });

  it("keeps null as null", () => {
    expect(new Type().cast(null)).toBeNull();
    expect(new Type().cast(undefined)).toBeNull();
  });

  it("carries its limit, precision and scale", () => {
    const type = new Type({ limit: 10, precision: 5, scale: 2 });

    expect(type.limit).toBe(10);
    expect(type.precision).toBe(5);
    expect(type.scale).toBe(2);
  });

  it("says it is neither mutable nor binary", () => {
    expect(new Type().mutable).toBe(false);
    expect(new Type().binary).toBe(false);
  });
});

describe("boolean", () => {
  /** Rails: the false values. Boolean("0") is true, which is the whole point. */
  it("treats Rails' false values as false", () => {
    const type = new BooleanType();

    for (const value of ["", "0", "f", "false", "off", "no", "n"]) {
      expect(type.cast(value), value).toBe(false);
    }
  });

  it("treats anything else present as true", () => {
    const type = new BooleanType();

    for (const value of ["1", "t", "true", "on", "yes", "anything"]) {
      expect(type.cast(value), String(value)).toBe(true);
    }
  });

  it("takes a real boolean unchanged", () => {
    expect(new BooleanType().cast(true)).toBe(true);
    expect(new BooleanType().cast(false)).toBe(false);
  });

  it("treats zero as false and other numbers as true", () => {
    expect(new BooleanType().cast(0)).toBe(false);
    expect(new BooleanType().cast(2)).toBe(true);
  });

  it("ignores case and surrounding space", () => {
    expect(new BooleanType().cast(" FALSE ")).toBe(false);
  });

  it("keeps null as null", () => {
    expect(new BooleanType().cast(null)).toBeNull();
  });
});

describe("integer", () => {
  it("parses a string", () => {
    expect(new IntegerType().cast("42")).toBe(42);
  });

  it("truncates rather than rounds", () => {
    expect(new IntegerType().cast("2.9")).toBe(2);
    expect(new IntegerType().cast(-2.9)).toBe(-2);
  });

  it("gives null for an empty string", () => {
    expect(new IntegerType().cast("")).toBeNull();
  });

  it("gives null for something that is not a number", () => {
    expect(new IntegerType().cast("abc")).toBeNull();
  });

  /** Rails casts a boolean to 1 and 0. */
  it("casts a boolean", () => {
    expect(new IntegerType().cast(true)).toBe(1);
    expect(new IntegerType().cast(false)).toBe(0);
  });
});

describe("big integer", () => {
  /**
   * Above 2^53 a Number loses precision, and a primary key that silently
   * rounds points at a different row.
   */
  it("keeps a value too wide for a number", () => {
    const wide = "9007199254740993";

    expect(new BigIntegerType().cast(wide)).toBe(wide);
  });

  it("takes a bigint", () => {
    expect(new BigIntegerType().cast(12345678901234567890n)).toBe("12345678901234567890");
  });

  it("gives null for something that is not an integer", () => {
    expect(new BigIntegerType().cast("1.5")).toBeNull();
    expect(new BigIntegerType().cast("abc")).toBeNull();
  });

  it("keeps a sign", () => {
    expect(new BigIntegerType().cast("-42")).toBe("-42");
  });
});

describe("float", () => {
  it("keeps the fraction", () => {
    expect(new FloatType().cast("2.5")).toBe(2.5);
  });

  it("gives null for an empty string", () => {
    expect(new FloatType().cast("")).toBeNull();
  });
});

describe("decimal", () => {
  it("fixes the number of decimal places", () => {
    expect(new DecimalType({ scale: 2 }).cast("1.5")).toBe("1.50");
  });

  /** The reason it is a string: 0.1 + 0.2 is not 0.3 in binary floating point. */
  it("keeps the value as text", () => {
    expect(typeof new DecimalType({ scale: 2 }).cast(1.5)).toBe("string");
  });

  /** Rails: 1.0 and 1.00 are the same amount. */
  it("does not report a change between equal amounts", () => {
    const type = new DecimalType({ scale: 2 });

    expect(type.changed("1.0", "1.00", null)).toBe(false);
  });

  it("reports a real change", () => {
    const type = new DecimalType({ scale: 2 });

    expect(type.changed("1.00", "1.01", null)).toBe(true);
  });
});

describe("string", () => {
  it("stringifies", () => {
    expect(new StringType().cast(42)).toBe("42");
  });

  /** Rails casts booleans to "t" and "f" for a string column. */
  it("casts a boolean to t and f", () => {
    expect(new StringType().cast(true)).toBe("t");
    expect(new StringType().cast(false)).toBe("f");
  });

  it("freezes when immutable", () => {
    const value = new ImmutableStringType().cast("hello") as string;

    expect(Object.isFrozen(value)).toBe(true);
  });
});

describe("date", () => {
  it("parses a date", () => {
    expect((new DateType().cast("2026-01-02") as Date).toISOString()).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  /** A birthday must not shift a day for anyone east or west of the server. */
  it("drops the time", () => {
    const cast = new DateType().cast("2026-01-02T23:30:00Z") as Date;

    expect(cast.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("serializes to a bare date", () => {
    expect(new DateType().serialize("2026-01-02T23:30:00Z")).toBe("2026-01-02");
  });

  it("gives null for something unparseable", () => {
    expect(new DateType().cast("not a date")).toBeNull();
  });

  it("does not report a change between the same day", () => {
    const type = new DateType();

    expect(type.changed("2026-01-02", new Date("2026-01-02T00:00:00Z"), null)).toBe(false);
  });
});

describe("datetime", () => {
  it("keeps the time", () => {
    expect((new DateTimeType().cast("2026-01-02T03:04:05Z") as Date).toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  /** Two Dates for one instant are different objects and the same time. */
  it("compares by instant, not identity", () => {
    const type = new DateTimeType();
    const a = new Date("2026-01-02T03:04:05Z");
    const b = new Date("2026-01-02T03:04:05Z");

    expect(a === b).toBe(false);
    expect(type.changed(a, b, null)).toBe(false);
  });

  it("serializes to ISO", () => {
    expect(new DateTimeType().serialize(new Date("2026-01-02T03:04:05Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
});

describe("time", () => {
  it("parses a time of day", () => {
    expect(new TimeType().cast("9:05")).toBe("09:05:00");
  });

  it("keeps seconds when they are given", () => {
    expect(new TimeType().cast("09:05:07")).toBe("09:05:07");
  });

  it("takes the time off a Date", () => {
    expect(new TimeType().cast(new Date("2026-01-02T03:04:05Z"))).toBe("03:04:05");
  });

  it("gives null for something that is not a time", () => {
    expect(new TimeType().cast("lunchtime")).toBeNull();
  });
});

describe("binary", () => {
  it("says it is binary and mutable", () => {
    expect(new BinaryType().binary).toBe(true);
    expect(new BinaryType().mutable).toBe(true);
  });

  it("encodes a string as bytes", () => {
    expect(new BinaryType().cast("hi")).toEqual(new Uint8Array([104, 105]));
  });

  /** Bytes compare by content: two buffers holding the same bytes are equal. */
  it("compares by content", () => {
    const type = new BinaryType();

    expect(type.changed(new Uint8Array([1, 2]), new Uint8Array([1, 2]), null)).toBe(false);
    expect(type.changed(new Uint8Array([1, 2]), new Uint8Array([1, 3]), null)).toBe(true);
  });

  it("notices a different length", () => {
    const type = new BinaryType();

    expect(type.changed(new Uint8Array([1]), new Uint8Array([1, 2]), null)).toBe(true);
  });
});

describe("json", () => {
  it("parses a string", () => {
    expect(new JsonType().cast('{"a":1}')).toEqual({ a: 1 });
  });

  it("leaves an object alone", () => {
    expect(new JsonType().cast({ a: 1 })).toEqual({ a: 1 });
  });

  it("gives null for a malformed body", () => {
    expect(new JsonType().cast("{not json")).toBeNull();
  });

  it("serializes back to a string", () => {
    expect(new JsonType().serialize({ a: 1 })).toBe('{"a":1}');
  });

  it("compares by value, not identity", () => {
    expect(new JsonType().changed({ a: 1 }, { a: 1 }, null)).toBe(false);
    expect(new JsonType().changed({ a: 1 }, { a: 2 }, null)).toBe(true);
  });

  /**
   * The case a plain equality check cannot see: the value was modified rather
   * than reassigned, so comparing it to itself reports nothing.
   */
  it("notices a mutation in place", () => {
    const type = new JsonType();
    const raw = '{"tags":["a"]}';
    const value = type.deserialize(raw) as { tags: string[] };

    expect(type.changedInPlace(raw, value)).toBe(false);

    value.tags.push("b");

    expect(type.changedInPlace(raw, value)).toBe(true);
  });

  it("says an immutable type never changes in place", () => {
    expect(new IntegerType().changedInPlace("1", 1)).toBe(false);
  });
});

describe("the registry", () => {
  it("looks a type up by name", () => {
    expect(lookupType("integer")).toBeInstanceOf(IntegerType);
    expect(lookupType("json")).toBeInstanceOf(JsonType);
  });

  it("passes the options through", () => {
    expect(lookupType("decimal", { scale: 2 }).scale).toBe(2);
  });

  /** A column nobody taught the ORM about should still be readable, just uncast. */
  it("gives the base type for an unknown name", () => {
    expect(lookupType("geography").type).toBe("value");
  });

  it("reports what it knows", () => {
    expect(typeRegistered("integer")).toBe(true);
    expect(typeRegistered("geography")).toBe(false);
    expect(typeNames()).toContain("decimal");
  });

  /** The point of the registry: an application can add its own. */
  it("takes a type of your own", () => {
    class MoneyType extends Type {
      override get type(): "integer" {
        return "integer";
      }
      protected override castValue(value: unknown): number {
        return Math.round(Number(value) * 100);
      }
    }

    registerType("money", () => new MoneyType());

    expect(lookupType("money").cast("1.50")).toBe(150);
    expect(typeRegistered("money")).toBe(true);
  });
});
