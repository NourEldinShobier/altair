/**
 * Rescuable and the number formatters, ported from
 * `activesupport/test/rescuable_test.rb` and
 * `activesupport/test/number_helper_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  RescueHandlers,
  handlerForRescue,
  rescueFrom,
  rescueWithHandler,
} from "../src/rescuable.js";
import {
  clamp,
  digitCount,
  isMultipleOf,
  numberToDelimited,
  numberToRounded,
} from "../src/numbers.js";

class NotFound extends Error {}
class Gone extends NotFound {}
class Unrelated extends Error {}

describe("rescueFrom", () => {
  it("handles a matching class", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, () => "handled");

    expect(await rescueWithHandler(handlers, new NotFound())).toBe("handled");
  });

  it("hands the error to the handler", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, (error) => (error as Error).message);

    expect(await rescueWithHandler(handlers, new NotFound("gone away"))).toBe("gone away");
  });

  /** Rails: a handler for a class catches its subclasses. */
  it("handles a subclass", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, () => "handled");

    expect(await rescueWithHandler(handlers, new Gone())).toBe("handled");
  });

  /**
   * An error nobody declared a handler for is not handled. Returning undefined
   * would turn every unanticipated failure into a silently empty response.
   */
  it("rethrows what it does not handle", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, () => "handled");

    await expect(rescueWithHandler(handlers, new Unrelated("boom"))).rejects.toThrow("boom");
  });

  it("rethrows when nothing is declared", async () => {
    await expect(rescueWithHandler(new RescueHandlers(), new Error("boom"))).rejects.toThrow(
      "boom",
    );
  });

  /** Rails matches most-recently-declared first. */
  it("prefers the most recent declaration", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, () => "first");
    rescueFrom(handlers, NotFound, () => "second");

    expect(await rescueWithHandler(handlers, new NotFound())).toBe("second");
  });

  it("matches by class name as well", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, "NotFound", () => "by name");

    expect(await rescueWithHandler(handlers, new NotFound())).toBe("by name");
  });

  it("matches a subclass by its parent's name", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, "NotFound", () => "by name");

    expect(await rescueWithHandler(handlers, new Gone())).toBe("by name");
  });

  it("does not match an unrelated name", () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, "NotFound", () => "by name");

    expect(handlers.handles(new Unrelated())).toBe(false);
  });

  it("reports the handler without running it", () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, () => "handled");

    expect(handlerForRescue(handlers, new NotFound())).toBeDefined();
    expect(handlerForRescue(handlers, new Unrelated())).toBeUndefined();
  });

  it("takes an async handler", async () => {
    const handlers = new RescueHandlers<string>();
    rescueFrom(handlers, NotFound, async () => await Promise.resolve("later"));

    expect(await rescueWithHandler(handlers, new NotFound())).toBe("later");
  });

  /** A subclass must be able to add without disturbing its parent's list. */
  it("clones without sharing", async () => {
    const parent = new RescueHandlers<string>();
    rescueFrom(parent, NotFound, () => "parent");

    const child = parent.clone();
    rescueFrom(child, NotFound, () => "child");

    expect(await rescueWithHandler(child, new NotFound())).toBe("child");
    expect(await rescueWithHandler(parent, new NotFound())).toBe("parent");
    expect(parent.size).toBe(1);
  });
});

describe("numberToDelimited", () => {
  it("groups in threes", () => {
    expect(numberToDelimited(1234567)).toBe("1,234,567");
  });

  /** Grouping the fraction too gives "1,234.567,89", which nobody meant. */
  it("leaves the fraction alone", () => {
    expect(numberToDelimited(1234567.89)).toBe("1,234,567.89");
  });

  it("keeps a small number unchanged", () => {
    expect(numberToDelimited(123)).toBe("123");
  });

  it("keeps the sign", () => {
    expect(numberToDelimited(-1234567)).toBe("-1,234,567");
  });

  it("takes a different delimiter and separator", () => {
    expect(numberToDelimited(1234567.89, { delimiter: ".", separator: "," })).toBe("1.234.567,89");
  });

  /** Grouping is not universal: the Indian system groups threes then twos. */
  it("takes a different grouping pattern", () => {
    expect(numberToDelimited(10000000, { pattern: /(\d)(?=(\d\d)+\d(?!\d))/g })).toBe(
      "1,00,00,000",
    );
  });
});

describe("numberToRounded", () => {
  it("rounds to the given places", () => {
    expect(numberToRounded(1.23456, { precision: 2 })).toBe("1.23");
  });

  /**
   * 2.50 and 2.5 are the same number and different claims about precision. A
   * price list showing one of each looks like bad data.
   */
  it("keeps trailing zeros", () => {
    expect(numberToRounded(2.5, { precision: 2 })).toBe("2.50");
  });

  it("strips them when asked", () => {
    expect(numberToRounded(2.5, { precision: 2, stripInsignificantZeros: true })).toBe("2.5");
  });

  it("rounds to no places", () => {
    expect(numberToRounded(1.6, { precision: 0 })).toBe("2");
  });

  /** Three significant digits of 0.00123 is 0.00123, not 0.001. */
  it("counts significant digits when asked", () => {
    expect(numberToRounded(0.00123456, { precision: 3, significant: true })).toBe("0.00123");
  });

  it("does not fall into exponential notation", () => {
    expect(numberToRounded(1234567, { precision: 3, significant: true })).not.toContain("e");
  });

  it("groups when given a delimiter", () => {
    expect(numberToRounded(1234567.891, { precision: 2, delimiter: "," })).toBe("1,234,567.89");
  });

  it("passes something that is not a number through", () => {
    expect(numberToRounded("abc")).toBe("abc");
  });
});

describe("the small ones", () => {
  it("counts digits", () => {
    expect(digitCount(0)).toBe(1);
    expect(digitCount(9)).toBe(1);
    expect(digitCount(10)).toBe(2);
    expect(digitCount(-1234)).toBe(4);
  });

  /** 0.3 % 0.1 is 0.09999999999999998, so the obvious check says no. */
  it("sees through floating point when checking multiples", () => {
    expect(isMultipleOf(0.3, 0.1)).toBe(true);
    expect(isMultipleOf(10, 5)).toBe(true);
    expect(isMultipleOf(10, 3)).toBe(false);
  });

  it("treats a zero factor as only dividing zero", () => {
    expect(isMultipleOf(0, 0)).toBe(true);
    expect(isMultipleOf(1, 0)).toBe(false);
  });

  it("clamps", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-1, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
  });
});
