/**
 * A serializer that gives back what it was handed, ported from
 * `activesupport/test/message_pack_test.rb` and
 * `activesupport/test/message_pack/extensions_test.rb`.
 *
 * Every case here is a round trip, because that is the only thing the feature
 * promises and the only thing that catches the bugs it exists to stop: JSON
 * loses a Date, a Set, a Map and an `undefined` without saying so, and the
 * failure appears one deploy later in whatever reads the cache.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Duration } from "../src/duration.js";
import { TimeZone } from "../src/time-zone.js";
import {
  DUMP_VERSION,
  InvalidFormatError,
  MissingClassError,
  TypedSerializer,
  UnserializableObjectError,
  defaultCodecs,
  dumpClass,
  dumpTimeZone,
  forgetRegisteredClasses,
  raiseInvalidFormat,
  raiseUnserializable,
  readClass,
  readDate,
  readSet,
  registerClass,
  writeDate,
  writeSet,
} from "../src/typed-serializer.js";

const serializer = new TypedSerializer();

/** What a value survives being written and read. */
function roundTrip(value: unknown): unknown {
  return serializer.load(serializer.dump(value));
}

afterEach(() => {
  forgetRegisteredClasses();
});

describe("what JSON would have lost", () => {
  /** Through JSON this comes back a string, and every later date sum is NaN. */
  it("keeps a date a date", () => {
    const date = new Date("2026-03-04T05:06:07.008Z");

    const back = roundTrip(date);

    expect(back).toBeInstanceOf(Date);
    expect((back as Date).getTime()).toBe(date.getTime());
  });

  it("keeps the milliseconds", () => {
    const date = new Date(1_772_000_000_123);

    expect((roundTrip(date) as Date).getTime()).toBe(1_772_000_000_123);
  });

  /** Through JSON a Set comes back `{}` — not wrong-looking, empty. */
  it("keeps a set a set", () => {
    const back = roundTrip(new Set([1, 2, 3]));

    expect(back).toBeInstanceOf(Set);
    expect(Array.from(back as Set<number>)).toEqual([1, 2, 3]);
  });

  it("keeps a map a map", () => {
    const back = roundTrip(
      new Map<unknown, unknown>([
        ["a", 1],
        ["b", 2],
      ]),
    );

    expect(back).toBeInstanceOf(Map);
    expect((back as Map<string, number>).get("b")).toBe(2);
  });

  /** A Map's keys are not only strings, and an object would make them so. */
  it("keeps a map's non-string keys", () => {
    const key = { id: 1 };
    const back = roundTrip(new Map<unknown, unknown>([[key, "held"]])) as Map<unknown, unknown>;

    expect(Array.from(back.keys())[0]).toEqual(key);
  });

  it("keeps a map's dates as dates on both sides", () => {
    const back = roundTrip(new Map([[new Date(1000), new Date(2000)]])) as Map<Date, Date>;
    const [key, held] = Array.from(back.entries())[0] as [Date, Date];

    expect(key).toBeInstanceOf(Date);
    expect(held.getTime()).toBe(2000);
  });

  /**
   * Through JSON an `undefined` key vanishes, so a key meaning "explicitly
   * unset" comes back meaning "never mentioned".
   */
  it("keeps an explicit undefined", () => {
    const back = roundTrip({ chosen: undefined, other: 1 }) as Record<string, unknown>;

    expect("chosen" in back).toBe(true);
    expect(back["chosen"]).toBeUndefined();
  });

  it("keeps an undefined inside an array, where JSON makes it null", () => {
    expect(roundTrip([1, undefined, 3])).toEqual([1, undefined, 3]);
  });

  /** Through JSON these become null, so an overflowed average reads as missing. */
  it("keeps the non-finite numbers", () => {
    expect(roundTrip(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundTrip(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(roundTrip(Number.NaN)).toBeNaN();
  });

  it("leaves an ordinary number alone", () => {
    expect(roundTrip(42)).toBe(42);
    expect(roundTrip(-0.5)).toBe(-0.5);
  });

  /** JSON throws on one of these, which is at least loud. */
  it("keeps a bigint, including one no number could hold", () => {
    expect(roundTrip(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
  });

  it("keeps a regexp and its flags", () => {
    const back = roundTrip(/ab+c/giu) as RegExp;

    expect(back).toBeInstanceOf(RegExp);
    expect(back.source).toBe("ab+c");
    expect(back.flags).toBe("giu");
  });

  it("keeps a url", () => {
    const back = roundTrip(new URL("https://app.test/a?b=1#c")) as URL;

    expect(back).toBeInstanceOf(URL);
    expect(back.href).toBe("https://app.test/a?b=1#c");
  });

  it("keeps bytes", () => {
    const bytes = new Uint8Array([0, 127, 255]);
    const back = roundTrip(bytes) as Uint8Array;

    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back)).toEqual([0, 127, 255]);
  });
});

describe("our own types", () => {
  /**
   * The parts, not the total seconds: a month is not a fixed number of
   * seconds, so collapsing and expanding turns "1 month" into 30 days — the
   * wrong date for eleven months of the year.
   */
  it("keeps a duration's parts rather than its seconds", () => {
    const back = roundTrip(new Duration({ months: 1 })) as Duration;

    expect(back).toBeInstanceOf(Duration);
    expect(back.parts.months).toBe(1);
    expect(back.parts.days).toBe(0);
  });

  it("keeps a compound duration", () => {
    const back = roundTrip(new Duration({ years: 1, hours: 3 })) as Duration;

    expect(back.parts.years).toBe(1);
    expect(back.parts.hours).toBe(3);
  });

  it("keeps a time zone", () => {
    const back = roundTrip(TimeZone.create("Europe/London")) as TimeZone;

    expect(back).toBeInstanceOf(TimeZone);
    expect(back.name).toBe("Europe/London");
  });

  it("writes a zone as its identifier and nothing else", () => {
    expect(dumpTimeZone(TimeZone.create("Europe/London"))).toBe("Europe/London");
  });

  it("refuses a payload naming a zone that is not one", () => {
    expect(() => serializer.load({ $: 6, v: "Middle/Earth" })).toThrow(InvalidFormatError);
  });
});

describe("nesting", () => {
  it("keeps a date inside an object", () => {
    const back = roundTrip({ at: new Date(5000) }) as { at: Date };

    expect(back.at).toBeInstanceOf(Date);
    expect(back.at.getTime()).toBe(5000);
  });

  it("keeps a set inside an array inside an object", () => {
    const back = roundTrip({ groups: [new Set(["a"])] }) as { groups: Set<string>[] };

    expect(back.groups[0]).toBeInstanceOf(Set);
    expect(back.groups[0]?.has("a")).toBe(true);
  });

  it("keeps types held inside a set", () => {
    const back = roundTrip(new Set([new Date(1), new Date(2)])) as Set<Date>;

    expect(Array.from(back).every((each) => each instanceof Date)).toBe(true);
  });

  it("keeps a deeply nested one", () => {
    const back = roundTrip({ a: { b: { c: [{ d: new Date(9) }] } } }) as never;

    expect((back as { a: { b: { c: { d: Date }[] } } }).a.b.c[0]?.d).toBeInstanceOf(Date);
  });

  it("leaves an ordinary object ordinary", () => {
    expect(roundTrip({ a: 1, b: "two", c: [3], d: null })).toEqual({
      a: 1,
      b: "two",
      c: [3],
      d: null,
    });
  });

  it("survives an empty everything", () => {
    expect(roundTrip({})).toEqual({});
    expect(roundTrip([])).toEqual([]);
    expect(Array.from(roundTrip(new Set()) as Set<unknown>)).toEqual([]);
  });
});

describe("what it refuses", () => {
  class Anything {
    held = 1;
  }

  /** A job queue would rather refuse now than run later without the class. */
  it("refuses an unknown type by default", () => {
    expect(() => serializer.dump(new Anything())).toThrow(UnserializableObjectError);
  });

  it("names the type it refused", () => {
    expect(() => serializer.dump(new Anything())).toThrow("Anything");
  });

  it("refuses a function", () => {
    expect(() => serializer.dump(() => 1)).toThrow(UnserializableObjectError);
  });

  /** A cache would rather store something approximate than fail a request. */
  it("falls back to a plain object when told to", () => {
    const lenient = TypedSerializer.installUnregisteredTypeFallback();

    expect(lenient.load(lenient.dump(new Anything()))).toEqual({ held: 1 });
  });

  it("still keeps known types inside a fallback object", () => {
    const lenient = TypedSerializer.installUnregisteredTypeFallback();
    const value = new Anything() as unknown as { held: number; at: Date };
    value.at = new Date(7);

    expect((lenient.load(lenient.dump(value)) as { at: Date }).at).toBeInstanceOf(Date);
  });

  it("refuses explicitly when asked for that", () => {
    const strict = TypedSerializer.installUnregisteredTypeError();

    expect(() => strict.dump(new Anything())).toThrow(UnserializableObjectError);
  });

  /**
   * A cycle would otherwise recurse until the stack ends, and the stack ending
   * during a cache write is an outage rather than a bad cache entry.
   */
  it("refuses a cycle rather than recursing forever", () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;

    expect(() => serializer.dump(value)).toThrow(UnserializableObjectError);
  });

  /** No object in the loop to catch it, so the array itself has to be tracked. */
  it("refuses an array that holds itself", () => {
    const holder: unknown[] = [];
    holder.push(holder);

    expect(() => serializer.dump(holder)).toThrow(UnserializableObjectError);
  });

  it("allows the same array appearing twice", () => {
    const shared = [1, 2];

    expect(roundTrip({ a: shared, b: shared })).toEqual({ a: [1, 2], b: [1, 2] });
  });

  it("refuses a cycle through an array", () => {
    const holder: unknown[] = [];
    holder.push({ back: holder });

    expect(() => serializer.dump(holder)).toThrow(UnserializableObjectError);
  });

  /** The same object twice is not a cycle, and must still be written. */
  it("allows the same object appearing twice", () => {
    const shared = { a: 1 };

    expect(roundTrip({ first: shared, second: shared })).toEqual({
      first: { a: 1 },
      second: { a: 1 },
    });
  });

  it("refuses a payload with a code nothing registered", () => {
    expect(() => serializer.load({ $: 9999, v: 1 })).toThrow(InvalidFormatError);
  });

  it("refuses a payload whose body is the wrong shape", () => {
    expect(() => serializer.load({ $: 1, v: "not a number" })).toThrow(InvalidFormatError);
  });
});

describe("classes", () => {
  class SomeJob {}

  /** A payload that loses the subclass runs the parent's code. */
  it("keeps a registered class", () => {
    registerClass("SomeJob", SomeJob);

    expect(readClass(dumpClass(SomeJob as { name: string }))).toBe(SomeJob);
  });

  it("names a class this process does not have", () => {
    expect(() => readClass("GoneJob")).toThrow(MissingClassError);
  });

  it("says which one", () => {
    expect(() => readClass("GoneJob")).toThrow("GoneJob");
  });

  it("refuses an anonymous class, which has no name to write", () => {
    expect(() => dumpClass({ name: "" })).toThrow(UnserializableObjectError);
  });

  it("refuses a payload that is not a name", () => {
    expect(() => readClass(42)).toThrow(InvalidFormatError);
  });
});

describe("the version stamp", () => {
  it("stamps a payload", () => {
    expect(serializer.dumped({ a: 1 }).version).toBe(DUMP_VERSION);
  });

  it("reads its own back", () => {
    const back = serializer.loadDumped(serializer.dumped({ at: new Date(3) })) as { at: Date };

    expect(back.at).toBeInstanceOf(Date);
  });

  /**
   * An older payload read with today's codes against yesterday's meanings
   * produces a value rather than an error, which is the worse outcome.
   */
  it("refuses a payload from another version", () => {
    expect(() => serializer.loadDumped({ version: DUMP_VERSION + 1, body: {} })).toThrow(
      InvalidFormatError,
    );
  });

  it("refuses a payload with no stamp at all", () => {
    expect(() => serializer.loadDumped({ body: {} })).toThrow(InvalidFormatError);
  });

  it("refuses something that is not a payload", () => {
    expect(() => serializer.loadDumped("just a string")).toThrow(InvalidFormatError);
  });
});

describe("the registry", () => {
  /**
   * Codes are fixed and never reused: a payload written before a type was
   * dropped is still in a cache somewhere, and would load as whatever took its
   * number.
   */
  it("gives every type its own code", () => {
    const codes = defaultCodecs().map((codec) => codec.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("names every type", () => {
    expect(defaultCodecs().every((codec) => codec.name !== "")).toBe(true);
  });

  it("takes a narrower set of types", () => {
    const dateOnly = new TypedSerializer({
      codecs: defaultCodecs().filter((codec) => codec.name === "Date"),
    });

    expect(dateOnly.load(dateOnly.dump(new Date(4)))).toBeInstanceOf(Date);
    expect(() => dateOnly.dump(new Set([1]))).toThrow(UnserializableObjectError);
  });
});

describe("the pairs on their own", () => {
  it("writes a date as milliseconds, not a string a parser has to guess at", () => {
    expect(writeDate(new Date(1234))).toBe(1234);
    expect(readDate(1234).getTime()).toBe(1234);
  });

  it("writes a set as an array", () => {
    expect(writeSet(new Set([1, 2]), (v) => v)).toEqual([1, 2]);
    expect(Array.from(readSet([1, 2], (v) => v))).toEqual([1, 2]);
  });

  it("refuses a set payload that is not an array", () => {
    expect(() => readSet("nope", (v) => v)).toThrow(InvalidFormatError);
  });

  it("raises for something unserializable", () => {
    expect(() => raiseUnserializable(Symbol("x"))).toThrow(UnserializableObjectError);
  });

  it("raises for a bad format", () => {
    expect(() => raiseInvalidFormat("because")).toThrow("because");
  });
});
