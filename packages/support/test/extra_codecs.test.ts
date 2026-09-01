/**
 * The types a plain object graph cannot carry, ported from
 * `activesupport/test/message_pack_test.rb` and
 * `activesupport/test/message_pack/extensions_test.rb`.
 *
 * Each of these round-trips through a plain object into something that is
 * *equal* and behaves differently, so the cases are all about what would be
 * lost.
 */

import { describe, expect, it } from "bun:test";
import { defaultCodecs } from "../src/typed_serializer.js";
import {
  extraCodecs,
  isComplex,
  isIpAddress,
  isRange,
  isRational,
  isSafeBuffer,
  isZonedTime,
  messagePackFactory,
  pack,
  readComplex,
  readDatetime,
  readIpaddr,
  readRange,
  readRational,
  readSafeBuffer,
  readTime,
  readTimeWithZone,
  typeForString,
  unpack,
  writeClass,
  writeComplex,
  writeDatetime,
  writeIpaddr,
  writeRange,
  writeRational,
  writeSafeBuffer,
  writeTime,
  writeTimeWithZone,
  writeTimeZone,
} from "../src/extra_codecs.js";

const codecs = messagePackFactory(defaultCodecs());

/**
 * Through JSON, not just through `pack`/`unpack` in memory. A value that was
 * never tagged survives an in-memory round trip unchanged — it is the same
 * object — so only a real serialization shows what would have been lost.
 */
const roundTrip = (value: unknown) =>
  unpack(JSON.parse(JSON.stringify(pack(value, codecs))), codecs);

describe("ranges", () => {
  /**
   * A range dumped without its exclusivity comes back inclusive, so `1...5`
   * becomes `1..5` — one extra element, silently, in whatever it was
   * filtering.
   */
  it("carries whether the end is excluded", () => {
    const exclusive = { begin: 1, end: 5, excludeEnd: true };

    expect(roundTrip(exclusive)).toEqual(exclusive);
    expect(roundTrip({ begin: 1, end: 5, excludeEnd: false })).toEqual({
      begin: 1,
      end: 5,
      excludeEnd: false,
    });
  });

  it("dumps its ends through the registry too", () => {
    const withDates = {
      begin: new Date("2026-01-01"),
      end: new Date("2026-02-01"),
      excludeEnd: false,
    };
    const back = roundTrip(withDates) as typeof withDates;

    expect(back.begin).toBeInstanceOf(Date);
    expect(back.begin.getTime()).toBe(withDates.begin.getTime());
  });

  /**
   * The packed form itself, not only what comes back: an untagged value is the
   * same object on the way out, so an in-memory round trip cannot tell a codec
   * that ran from one that did not.
   */
  it("tags what it packs", () => {
    const packed = pack({ begin: 1, end: 5, excludeEnd: true }, codecs) as { $: number };

    expect(packed.$).toBe(20);
    expect(packed).toHaveProperty("v");
  });

  it("recognises one", () => {
    expect(isRange({ begin: 1, end: 5, excludeEnd: false })).toBe(true);
    expect(isRange({ begin: 1, end: 5 })).toBe(false);
    expect(isRange(null)).toBe(false);
  });

  it("reads a missing exclusivity as inclusive rather than undefined", () => {
    expect(readRange([1, 5, undefined], (value) => value).excludeEnd).toBe(false);
  });

  it("writes the three fields", () => {
    expect(writeRange({ begin: 1, end: 5, excludeEnd: true }, (value) => value)).toEqual([
      1,
      5,
      true,
    ]);
  });
});

describe("exact numbers", () => {
  /**
   * Dumped as a float, `1/3` comes back close, sums differently, and cannot be
   * told apart from a value that was always approximate.
   */
  it("keeps a rational as a pair", () => {
    const third = { numerator: 1, denominator: 3 };

    expect(roundTrip(third)).toEqual(third);
    expect(writeRational(third)).toEqual([1, 3]);
  });

  /**
   * Reading one back as Infinity would let a corrupt payload become a value
   * that spreads through every later calculation.
   */
  it("refuses a zero denominator", () => {
    expect(() => readRational([1, 0])).toThrow("spreads through every later calculation");
  });

  it("keeps a complex number as a pair", () => {
    const value = { real: 1, imaginary: 2 };

    expect(roundTrip(value)).toEqual(value);
    expect(writeComplex(value)).toEqual([1, 2]);
    expect(readComplex([1, 2])).toEqual(value);
  });

  it("recognises each", () => {
    expect(isRational({ numerator: 1, denominator: 2 })).toBe(true);
    expect(isComplex({ real: 1, imaginary: 0 })).toBe(true);
    expect(isRational({ real: 1, imaginary: 0 })).toBe(false);
  });
});

describe("times", () => {
  /**
   * An ISO string carries an *offset*, which is not a zone: `-05:00` is New
   * York in January and nowhere in particular in July, so a round trip through
   * one prints an hour out for half the year.
   */
  it("keeps the zone rather than an offset", () => {
    const value = { epochMs: 1_767_225_600_000, zone: "America/New_York" };

    expect(roundTrip(value)).toEqual(value);
    expect(writeTimeWithZone(value)).toEqual([1_767_225_600_000, "America/New_York"]);
    expect(readTimeWithZone([1, "UTC"])).toEqual({ epochMs: 1, zone: "UTC" });
  });

  it("recognises one", () => {
    expect(isZonedTime({ epochMs: 1, zone: "UTC" })).toBe(true);
    expect(isZonedTime({ epochMs: 1 })).toBe(false);
  });

  it("writes a zone on its own as its name", () => {
    expect(writeTimeZone({ name: "Europe/Paris" })).toBe("Europe/Paris");
  });

  it("keeps sub-millisecond precision alongside an instant", () => {
    expect(writeTime({ epochMs: 1, nanos: 500 })).toEqual([1, 500]);
    expect(writeTime({ epochMs: 1 })).toEqual([1, 0]);
    expect(readTime([1, 500])).toEqual({ epochMs: 1, nanos: 500 });
  });

  it("keeps a civil date and time with no instant", () => {
    const civil = { year: 2026, month: 1, day: 1, hour: 12, minute: 30, second: 0 };

    expect(readDatetime(writeDatetime(civil))).toEqual(civil);
  });
});

describe("addresses", () => {
  /**
   * An address dumped without its prefix comes back as a single host rather
   * than a network, so a rule about `10.0.0.0/8` silently applies to one
   * machine.
   */
  it("carries the prefix", () => {
    expect(writeIpaddr({ address: "10.0.0.0", prefix: 8 })).toEqual(["10.0.0.0", 8]);
    expect(readIpaddr(["10.0.0.0", 8])).toEqual({ address: "10.0.0.0", prefix: 8 });
  });

  /** A host with no prefix is not a network with prefix zero. */
  it("tells a host from a network", () => {
    expect(writeIpaddr({ address: "10.0.0.1" })).toEqual(["10.0.0.1", null]);
    expect(readIpaddr(["10.0.0.1", null])).toEqual({ address: "10.0.0.1" });
  });

  it("recognises one", () => {
    expect(isIpAddress({ address: "10.0.0.1" })).toBe(true);
    expect(isIpAddress({ host: "10.0.0.1" })).toBe(false);
  });
});

describe("markup that was already escaped", () => {
  /**
   * A safe buffer dumped as a plain string comes back unsafe, so a cached
   * fragment renders escaped — and a cache warm-up makes the bug appear only
   * for users who missed the cache.
   */
  it("keeps the safety flag", () => {
    const safe = { html: "<p>hi</p>", htmlSafe: true } as const;

    expect(roundTrip(safe)).toEqual(safe);
    expect(writeSafeBuffer(safe)).toBe("<p>hi</p>");
    expect(readSafeBuffer("<p>hi</p>")).toEqual(safe);
  });

  /**
   * The reverse is worse, and is why this is a distinct type rather than a
   * flag on strings: a plain string read back as safe renders whatever a user
   * typed as markup.
   */
  it("does not claim a plain string is safe", () => {
    expect(isSafeBuffer("<p>hi</p>")).toBe(false);
    expect(isSafeBuffer({ html: "<p>hi</p>" })).toBe(false);
    expect(roundTrip("<p>hi</p>")).toBe("<p>hi</p>");
  });

  /**
   * A class cannot be reconstructed from a payload, so what crosses is a name
   * the other side looks up in its own registry.
   */
  it("writes a class as its name", () => {
    expect(writeClass({ name: "Post" })).toBe("Post");
  });
});

describe("the registry", () => {
  /**
   * Codes are never reused: a payload written before a type was dropped is
   * still in a cache somewhere and would load as whatever took its number.
   */
  it("refuses a code that is already taken", () => {
    const clashing = [...defaultCodecs(), { ...extraCodecs()[0]!, code: 20 }];

    expect(() => messagePackFactory(clashing)).toThrow("never reused");
  });

  /**
   * Several of these are plain objects and the first matching codec wins, so a
   * looser test placed earlier would claim values belonging to a stricter one.
   */
  it("puts the stricter matchers first", () => {
    const zoned = { epochMs: 1, zone: "UTC" };

    expect(roundTrip(zoned)).toEqual(zoned);
  });

  it("finds a codec by name", () => {
    expect(typeForString("Range", codecs)?.code).toBe(20);
    expect(typeForString("Nothing", codecs)).toBeUndefined();
  });

  it("leaves a value nothing matches alone", () => {
    expect(pack(7, codecs)).toBe(7);
    expect(unpack(7, codecs)).toBe(7);
  });

  /**
   * A payload naming a type this process does not have was written by a
   * version that did — reading it as a plain object would produce a value that
   * is the right shape and the wrong type.
   */
  it("refuses a payload for a type it does not know", () => {
    expect(() => unpack({ $: 999, v: 1 }, codecs)).toThrow("right shape and the wrong type");
  });
});
