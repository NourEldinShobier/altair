/**
 * Turning one kind of value into another without lying about it, ported from
 * `activesupport/test/core_ext/string_ext_test.rb`,
 * `core_ext/numeric_ext_test.rb` and the UUID cases in
 * `activesupport/test/core_ext/digest/uuid_test.rb`.
 *
 * Every function here has a shorter wrong version that passes casual testing,
 * so the cases are almost all about input that is *nearly* valid.
 */

import { describe, expect, it } from "bun:test";
import {
  BYTE_UNITS,
  bytesplice,
  chr,
  decompose,
  existence,
  humanSize,
  inBytes,
  multiline,
  parseIntStrictly,
  readableInspect,
  tidyBytes,
  toF,
  toFs,
  toI,
  toR,
  toS,
  validEncoding,
  zettabytes,
} from "../src/conversions.js";

describe("reading a number out of text", () => {
  /**
   * `parseInt` semantics deliberately: a form field containing "12 items"
   * should give 12, which is what makes this usable at all.
   */
  it("takes the leading integer", () => {
    expect(toI("12")).toBe(12);
    expect(toI("12 items")).toBe(12);
    expect(toI("  -3  ")).toBe(-3);
  });

  /** The cost of that: a genuinely bad value gives zero rather than an error. */
  it("gives zero for something with no number in it", () => {
    expect(toI("none")).toBe(0);
    expect(toI(null)).toBe(0);
  });

  it("truncates a number rather than rounding it", () => {
    expect(toI(3.9)).toBe(3);
    expect(toI(-3.9)).toBe(-3);
  });

  /**
   * Which is why anything that needs to *know* asks separately — the two
   * answers for "12abc" are 12 and "that is not a number", and both are right
   * for different callers.
   */
  it("can be asked strictly instead", () => {
    expect(parseIntStrictly("12")).toBe(12);
    expect(parseIntStrictly("12abc")).toBeUndefined();
    expect(parseIntStrictly("")).toBeUndefined();
    expect(parseIntStrictly("-3")).toBe(-3);
  });

  it("reads a float the same way", () => {
    expect(toF("1.5")).toBe(1.5);
    expect(toF("1.5kg")).toBe(1.5);
    expect(toF("none")).toBe(0);
    expect(toF(2.5)).toBe(2.5);
  });
});

describe("an exact ratio", () => {
  /**
   * `0.1 + 0.2` is not `0.3` in binary floating point, and a total built from
   * a few hundred of those is visibly wrong on an invoice.
   */
  it("keeps a decimal exactly", () => {
    expect(toR("0.1")).toEqual({ numerator: 1, denominator: 10 });
    expect(toR("1.25")).toEqual({ numerator: 5, denominator: 4 });
  });

  /** Reduced, so two values that are equal compare equal. */
  it("reduces", () => {
    expect(toR("0.50")).toEqual({ numerator: 1, denominator: 2 });
    expect(toR("2.0")).toEqual({ numerator: 2, denominator: 1 });
  });

  it("keeps a sign", () => {
    expect(toR("-0.5")).toEqual({ numerator: -1, denominator: 2 });
  });

  it("reads a whole number", () => {
    expect(toR("3")).toEqual({ numerator: 3, denominator: 1 });
  });

  it("gives zero for something that is not a number", () => {
    expect(toR("none")).toEqual({ numerator: 0, denominator: 1 });
  });
});

describe("formatting a number", () => {
  /**
   * Separate from `toS` because a delimited "1,234" in a JSON document parses
   * as the number 1.
   */
  it("groups and fixes for a person", () => {
    expect(toFs(1234567.891, { precision: 2, delimiter: "," })).toBe("1,234,567.89");
  });

  it("takes a different separator", () => {
    expect(toFs(1234.5, { precision: 1, delimiter: ".", separator: "," })).toBe("1.234,5");
  });

  it("leaves a plain number plain", () => {
    expect(toFs(1234)).toBe("1234");
  });

  it("gives back something a machine can read", () => {
    expect(toS(1234.5)).toBe("1234.5");
    expect(toS(null)).toBe("");
    expect(toS(undefined)).toBe("");
    expect(toS(Number.NaN)).toBe("NaN");
  });
});

describe("sizes", () => {
  /**
   * Binary by default because that is what a filesystem reports, and an
   * interface disagreeing with the file manager beside it reads as a bug in
   * the interface.
   */
  it("counts in powers of 1024 by default", () => {
    expect(inBytes(1, "KB")).toBe(1024);
    expect(inBytes(1, "MB")).toBe(1024 * 1024);
  });

  /** Picking one silently makes every size off by 2.4% per order of magnitude. */
  it("counts in powers of 1000 when asked", () => {
    expect(inBytes(1, "KB", { binary: false })).toBe(1000);
    expect(zettabytes(1, { binary: false })).toBe(1000 ** 7);
    expect(zettabytes(1)).toBe(1024 ** 7);
  });

  it("refuses a unit it does not know", () => {
    expect(() => inBytes(1, "QB")).toThrow("factor of a thousand");
  });

  it("knows the units in order", () => {
    expect(BYTE_UNITS[0]).toBe("B");
    expect(BYTE_UNITS.at(-1)).toBe("ZB");
  });

  /**
   * The unit is chosen so the number has at most one leading group — "1.2 GB"
   * rather than "1234 MB" — because the point is that somebody can read it at
   * a glance.
   */
  it("picks a unit a person can read", () => {
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(1024 ** 3 * 1.25)).toBe("1.3 GB");
    expect(humanSize(512)).toBe("512 B");
  });

  it("does not run past the largest unit", () => {
    expect(humanSize(1024 ** 9)).toContain("ZB");
  });
});

describe("bytes that cannot be encoded", () => {
  /**
   * A lone surrogate is valid in a JavaScript string and invalid as UTF-8, so
   * it survives every check inside the process and fails at the moment the
   * value reaches a socket — far from whatever produced it.
   */
  it("replaces a lone surrogate", () => {
    const lone = `bad${String.fromCharCode(0xd800)}value`;

    expect(validEncoding(lone)).toBe(false);
    expect(tidyBytes(lone)).toBe("bad�value");
  });

  it("replaces a lone low surrogate too", () => {
    expect(tidyBytes(String.fromCharCode(0xdc00))).toBe("�");
  });

  /**
   * Replacing loses information; raising loses the record — a user who cannot
   * be displayed at all because of one character in one field.
   */
  it("leaves a valid pair alone", () => {
    expect(tidyBytes("a 🎉 b")).toBe("a 🎉 b");
    expect(validEncoding("a 🎉 b")).toBe(true);
  });

  it("leaves ordinary text alone", () => {
    expect(tidyBytes("hello")).toBe("hello");
  });
});

describe("taking a piece of a string", () => {
  /**
   * `value[0]` on an emoji gives half a surrogate pair, which is not a
   * character and cannot be encoded — so a truncation built on it produces a
   * string that is invalid rather than short.
   */
  it("takes a whole first character", () => {
    expect(chr("🎉ab")).toBe("🎉");
    expect(chr("abc")).toBe("a");
    expect(chr("")).toBe("");
  });

  /**
   * A byte offset landing inside a multi-byte character would split it,
   * producing exactly the invalid sequence `tidyBytes` exists to clean up —
   * from code that was only trying to truncate.
   */
  it("snaps a byte range to character boundaries", () => {
    const spliced = bytesplice("a🎉b", 1, 2, "-");

    expect(validEncoding(spliced)).toBe(true);
    expect(spliced).toBe("a-🎉b");
  });

  it("replaces a whole character when the range covers it", () => {
    expect(bytesplice("a🎉b", 1, 4, "-")).toBe("a-b");
  });

  /**
   * An offset landing *inside* the emoji is the case the snapping exists for:
   * applied literally it would cut the character in half.
   */
  it("snaps a start that lands inside a character", () => {
    const spliced = bytesplice("a🎉b", 3, 2, "-");

    expect(validEncoding(spliced)).toBe(true);
    expect(spliced).toBe("a-b");
  });

  it("clamps a range past the end", () => {
    expect(bytesplice("abc", 1, 99, "-")).toBe("a-");
  });
});

describe("patterns and inspection", () => {
  /**
   * A validation written against a single line and applied to a multi-line
   * value passes on the first line alone — which is why a "username" field can
   * contain a newline followed by anything at all.
   */
  it("notices a pattern that does not anchor the whole value", () => {
    expect(multiline(/^\w+$/)).toBe(true);
    expect(multiline(/\w+/m)).toBe(true);
    expect(multiline(/\w+/)).toBe(false);
  });

  /**
   * An inspect that does not say it was truncated is read as the whole value,
   * and whatever was cut off is assumed absent.
   */
  it("says when it truncated", () => {
    const long = "a".repeat(200);

    expect(readableInspect(long, { limit: 10 })).toContain("more characters");
    expect(readableInspect("short")).toBe('"short"');
  });

  /**
   * Zero and false are values, not absences — treating them as blank is the
   * single most common source of "why did my count of 0 disappear".
   */
  it("keeps zero and false", () => {
    expect(existence(0)).toBe(0);
    expect(existence(false)).toBe(false);
    expect(existence("a")).toBe("a");
  });

  it("drops what is genuinely absent", () => {
    expect(existence(null)).toBeUndefined();
    expect(existence(undefined)).toBeUndefined();
    expect(existence("   ")).toBeUndefined();
    expect(existence([])).toBeUndefined();
  });
});

describe("taking a UUID apart", () => {
  it("splits the five groups", () => {
    expect(decompose("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toEqual([
      "6ba7b810",
      "9dad",
      "11d1",
      "80b4",
      "00c04fd430c8",
    ]);
  });

  /**
   * A value that is merely hexadecimal would be accepted here and rejected by
   * the database, which reports it as a type error on a column rather than as
   * a malformed value.
   */
  it("refuses something that is not one", () => {
    expect(() => decompose("6ba7b8109dad11d180b400c04fd430c8")).toThrow("8-4-4-4-12");
    expect(() => decompose("too-short")).toThrow();
  });

  /** Five groups of the wrong lengths is the shape a loose check accepts. */
  it("refuses five groups that are not the right lengths", () => {
    expect(() => decompose("1-2-3-4-5")).toThrow("8-4-4-4-12");
  });
});
