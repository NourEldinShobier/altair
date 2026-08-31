/**
 * Arithmetic between durations, numbers and times, ported from
 * `activesupport/test/core_ext/duration_test.rb` and the calendar cases in
 * `activesupport/test/core_ext/time_ext_test.rb`.
 *
 * The subject is that a duration is not a number of seconds. It compares
 * against one happily, and every wrong answer here comes from treating it as
 * one — so most of these are about months, which have no fixed length.
 */

import { describe, expect, it } from "bun:test";
import {
  CALENDAR_UNITS,
  CalendarDurationInSeconds,
  atWithCoercion,
  beforeWithCoercion,
  coerce,
  compareWithCoercion,
  eqlWithCoercion,
  findBeginningOfWeek,
  future,
  isCalendarDuration,
  minusWithCoercion,
  minusWithDuration,
  multipleOf,
  negate,
  past,
  plusWithDuration,
  toDuration,
  toSeconds,
} from "../src/duration_arithmetic.js";

describe("which durations depend on when they land", () => {
  it("names the calendar units", () => {
    expect(CALENDAR_UNITS).toEqual(["months", "years"]);
  });

  it("says a month does", () => {
    expect(isCalendarDuration({ months: 1 })).toBe(true);
    expect(isCalendarDuration({ years: 1 })).toBe(true);
  });

  it("says days and below do not", () => {
    expect(isCalendarDuration({ days: 30 })).toBe(false);
    expect(isCalendarDuration({ weeks: 4, hours: 3 })).toBe(false);
  });

  it("ignores a zero calendar part", () => {
    expect(isCalendarDuration({ months: 0, days: 1 })).toBe(false);
  });
});

describe("turning a duration into seconds", () => {
  it("converts the fixed units", () => {
    expect(toSeconds({ days: 1 })).toBe(86_400);
    expect(toSeconds({ hours: 2, minutes: 30 })).toBe(9000);
  });

  it("adds the parts", () => {
    expect(toSeconds({ weeks: 1, days: 1 })).toBe(604_800 + 86_400);
  });

  /**
   * A month is 28 to 31 days, so the answer depends on when it is applied.
   * Rails answers the average, which is right for nothing in particular.
   */
  it("refuses a calendar duration", () => {
    expect(() => toSeconds({ months: 1 })).toThrow(CalendarDurationInSeconds);
  });

  it("says what to do instead", () => {
    expect(() => toSeconds({ months: 1 })).toThrow("Advance a date");
  });

  it("gives the average when explicitly asked", () => {
    expect(toSeconds({ months: 1 }, { allowAverage: true })).toBe(2_629_746);
  });

  it("converts nothing to zero", () => {
    expect(toSeconds({})).toBe(0);
  });
});

describe("adding durations", () => {
  /**
   * `1.month + 1.day` cannot be collapsed to a number without deciding how
   * long the month is, and that depends on when it is applied.
   */
  it("keeps the units apart", () => {
    expect(plusWithDuration({ months: 1 }, { days: 1 })).toEqual({ months: 1, days: 1 });
  });

  it("adds matching units", () => {
    expect(plusWithDuration({ days: 1 }, { days: 2 })).toEqual({ days: 3 });
  });

  it("drops a unit that cancels out", () => {
    expect(plusWithDuration({ days: 1 }, { days: -1 })).toEqual({});
  });

  it("subtracts", () => {
    expect(minusWithDuration({ days: 3 }, { days: 1 })).toEqual({ days: 2 });
  });

  it("negates every part", () => {
    expect(negate({ months: 1, days: -2 })).toEqual({ months: -1, days: 2 });
  });

  /**
   * A bare number can only mean seconds. Guessing the duration's own unit
   * would make `3 + 1.day` and `1.day + 3` different amounts.
   */
  it("reads a bare number as seconds", () => {
    expect(coerce(30)).toEqual({ seconds: 30 });
    expect(minusWithCoercion({ minutes: 1 }, 30)).toEqual({ minutes: 1, seconds: -30 });
  });
});

describe("comparing", () => {
  it("orders two fixed durations", () => {
    expect(compareWithCoercion({ days: 1 }, { hours: 25 })).toBe(-1);
    expect(compareWithCoercion({ days: 1 }, { hours: 24 })).toBe(0);
    expect(compareWithCoercion({ days: 2 }, { days: 1 })).toBe(1);
  });

  it("compares against a bare number of seconds", () => {
    expect(compareWithCoercion({ minutes: 1 }, 60)).toBe(0);
  });

  it("uses the average for a calendar duration rather than refusing", () => {
    expect(compareWithCoercion({ months: 1 }, { days: 30 })).toBe(1);
  });

  /**
   * Stricter than equality of length: `1.month` and `30.days` are the same
   * length and not the same duration, which is what stops a cache keyed on one
   * treating them as identical.
   */
  it("is equal only when the parts match", () => {
    expect(eqlWithCoercion({ days: 1 }, { days: 1 })).toBe(true);
    expect(eqlWithCoercion({ days: 1 }, { hours: 24 })).toBe(false);
  });

  it("ignores a missing zero part", () => {
    expect(eqlWithCoercion({ days: 1 }, { days: 1, hours: 0 })).toBe(true);
  });

  it("says whether one divides another", () => {
    expect(multipleOf({ hours: 2 }, { hours: 1 })).toBe(true);
    expect(multipleOf({ minutes: 90 }, { hours: 1 })).toBe(false);
  });

  it("is not a multiple of nothing", () => {
    expect(multipleOf({ hours: 1 }, {})).toBe(false);
  });
});

describe("advancing a time", () => {
  const at = (iso: string) => new Date(iso);

  it("adds fixed units", () => {
    expect(atWithCoercion(at("2026-03-01T00:00:00Z"), { hours: 2 }).toISOString()).toBe(
      "2026-03-01T02:00:00.000Z",
    );
  });

  /**
   * `now + 1.month` lands on the same day number next month; `now + 2592000`
   * lands wherever thirty days later happens to be, which differs in February
   * and every leap year.
   */
  it("adds a month by the calendar, not by thirty days", () => {
    const advanced = atWithCoercion(at("2026-01-31T00:00:00Z"), { months: 1 });

    expect(advanced.getUTCMonth()).toBe(1);
    expect(advanced.getTime()).not.toBe(at("2026-01-31T00:00:00Z").getTime() + 30 * 86_400_000);
  });

  it("adds a year by the calendar", () => {
    expect(atWithCoercion(at("2026-03-01T00:00:00Z"), { years: 1 }).getUTCFullYear()).toBe(2027);
  });

  /**
   * Calendar units resolve first: adding a month to 31 January has to become
   * 28 February *before* any days are added, or the answer depends on the
   * order of operations.
   */
  it("resolves the month before adding days", () => {
    const advanced = atWithCoercion(at("2026-01-31T00:00:00Z"), { months: 1, days: 1 });

    expect(advanced.getUTCMonth()).toBe(2);
    expect(advanced.getUTCDate()).toBe(1);
  });

  it("goes backwards", () => {
    expect(beforeWithCoercion(at("2026-03-02T00:00:00Z"), { days: 1 }).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("leaves a moment alone for an empty duration", () => {
    const moment = at("2026-03-01T00:00:00Z");

    expect(atWithCoercion(moment, {}).getTime()).toBe(moment.getTime());
  });
});

describe("where a moment sits", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("says which side of now it is", () => {
    expect(future(new Date("2026-06-16T00:00:00Z"), now)).toBe(true);
    expect(past(new Date("2026-06-14T00:00:00Z"), now)).toBe(true);
    expect(future(now, now)).toBe(false);
    expect(past(now, now)).toBe(false);
  });
});

describe("the start of a week", () => {
  /** Monday in most of Europe, Sunday in the United States. */
  it("goes back to Monday by default", () => {
    const wednesday = new Date(2026, 5, 17);

    expect(findBeginningOfWeek(wednesday).getDay()).toBe(1);
  });

  /**
   * Cultural rather than technical: a weekly report starting on Sunday in one
   * place and Monday in another is two different reports.
   */
  it("goes back to Sunday when told to", () => {
    const wednesday = new Date(2026, 5, 17);

    expect(findBeginningOfWeek(wednesday, 0).getDay()).toBe(0);
  });

  it("stays put on the first day itself", () => {
    const monday = new Date(2026, 5, 15);

    expect(findBeginningOfWeek(monday).getDate()).toBe(15);
  });

  it("clears the time", () => {
    const found = findBeginningOfWeek(new Date(2026, 5, 17, 14, 30));

    expect([found.getHours(), found.getMinutes(), found.getSeconds()]).toEqual([0, 0, 0]);
  });
});

describe("building a duration", () => {
  it("wraps plain parts", () => {
    expect(toDuration({ days: 1 })).toBeInstanceOf(Object);
    expect(toDuration({ days: 1 }).parts.days).toBe(1);
  });
});
