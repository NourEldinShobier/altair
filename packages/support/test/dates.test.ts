/**
 * Date arithmetic, ported from `activesupport/test/core_ext/date_ext_test.rb`
 * and `time_ext_test.rb`.
 *
 * The cases worth having are the ones where the obvious implementation is
 * wrong: a month added to the 31st, an end-of-day that is the next midnight, a
 * week that starts on Sunday, and a `next_weekday` asked on a Monday.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  allMonth,
  allWeek,
  beginningOfDay,
  beginningOfMonth,
  beginningOfQuarter,
  beginningOfWeek,
  beginningOfYear,
  daysAgo,
  daysInYear,
  daysSince,
  endOfDay,
  endOfHour,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  isFuture,
  isLeapYear,
  isPast,
  isToday,
  isWeekday,
  isWeekend,
  middleOfDay,
  monthsAgo,
  monthsSince,
  nextOccurring,
  nextWeekday,
  prevOccurring,
  prevWeekday,
  quarter,
  secondsSinceMidnight,
  setBeginningOfWeek,
  tomorrow,
  yearsSince,
  yesterday,
} from "../src/dates.js";

/** A Thursday, mid-afternoon. */
const thursday = () => new Date(2026, 7, 27, 15, 30, 45, 500);

beforeEach(() => {
  setBeginningOfWeek(1);
});

describe("the edges of a day", () => {
  it("starts at midnight", () => {
    expect(beginningOfDay(thursday()).toISOString()).toBe(
      new Date(2026, 7, 27, 0, 0, 0, 0).toISOString(),
    );
  });

  /**
   * The last millisecond, not the next midnight. Rails' choice, and the reason
   * a `BETWEEN` over a day does not quietly include the day after it.
   */
  it("ends on the last millisecond", () => {
    const end = endOfDay(thursday());

    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ]);
    expect(end.getDate()).toBe(27);
  });

  it("has a middle", () => {
    expect(middleOfDay(thursday()).getHours()).toBe(12);
  });

  it("leaves the date it was given alone", () => {
    const original = thursday();
    beginningOfDay(original);

    expect(original.getHours()).toBe(15);
  });

  it("counts the seconds into it", () => {
    expect(secondsSinceMidnight(new Date(2026, 7, 27, 1, 0, 30))).toBe(3630);
  });
});

describe("the edges of a week", () => {
  it("starts on Monday", () => {
    expect(beginningOfWeek(thursday()).getDate()).toBe(24);
  });

  it("ends on Sunday night", () => {
    const end = endOfWeek(thursday());

    expect([end.getDate(), end.getHours()]).toEqual([30, 23]);
  });

  // Half the world disagrees and both halves are right.
  it("starts on Sunday when an application says so", () => {
    setBeginningOfWeek(0);

    expect(beginningOfWeek(thursday()).getDate()).toBe(23);
  });

  it("takes a start for one call without changing the default", () => {
    expect(beginningOfWeek(thursday(), 0).getDate()).toBe(23);
    expect(beginningOfWeek(thursday()).getDate()).toBe(24);
  });

  it("stays put when it is already the first day", () => {
    const monday = new Date(2026, 7, 24, 9, 0);

    expect(beginningOfWeek(monday).getDate()).toBe(24);
  });
});

describe("the edges of a month and a year", () => {
  it("starts on the first", () => {
    expect(beginningOfMonth(thursday()).getDate()).toBe(1);
  });

  it("ends on the last, whatever that is", () => {
    expect(endOfMonth(new Date(2026, 1, 10)).getDate()).toBe(28);
    expect(endOfMonth(new Date(2024, 1, 10)).getDate()).toBe(29);
    expect(endOfMonth(new Date(2026, 3, 10)).getDate()).toBe(30);
  });

  it("knows its quarter", () => {
    expect(quarter(new Date(2026, 0, 5))).toBe(1);
    expect(quarter(new Date(2026, 7, 5))).toBe(3);

    expect(beginningOfQuarter(thursday()).getMonth()).toBe(6);
    expect(endOfQuarter(thursday()).getMonth()).toBe(8);
    expect(endOfQuarter(thursday()).getDate()).toBe(30);
  });

  it("runs from January to December", () => {
    expect(beginningOfYear(thursday()).getMonth()).toBe(0);
    expect(endOfYear(thursday()).getMonth()).toBe(11);
    expect(endOfYear(thursday()).getDate()).toBe(31);
  });
});

/**
 * The case that separates a real implementation from adding 30 days: Rails
 * clamps to the end of the month rather than overflowing into the next one.
 */
describe("moving by months and years", () => {
  it("clamps the 31st rather than overflowing", () => {
    const end = monthsSince(new Date(2026, 0, 31), 1);

    expect([end.getMonth(), end.getDate()]).toEqual([1, 28]);
  });

  it("clamps into a leap February", () => {
    const end = monthsSince(new Date(2024, 0, 31), 1);

    expect([end.getMonth(), end.getDate()]).toEqual([1, 29]);
  });

  it("goes backwards the same way", () => {
    const end = monthsAgo(new Date(2026, 2, 31), 1);

    expect([end.getMonth(), end.getDate()]).toEqual([1, 28]);
  });

  it("moves a year from a leap day", () => {
    const end = yearsSince(new Date(2024, 1, 29), 1);

    expect([end.getMonth(), end.getDate()]).toEqual([1, 28]);
  });

  it("moves whole days without touching the clock", () => {
    expect(daysSince(thursday(), 3).getDate()).toBe(30);
    expect(daysAgo(thursday(), 3).getDate()).toBe(24);
  });
});

describe("weekdays", () => {
  it("knows which is which", () => {
    expect(isWeekend(new Date(2026, 7, 29))).toBe(true);
    expect(isWeekend(new Date(2026, 7, 30))).toBe(true);
    expect(isWeekday(thursday())).toBe(true);
  });

  // Always moves at least one day, so asking on a Monday gives Tuesday rather
  // than the Monday you already had.
  it("moves to the next one, never staying put", () => {
    expect(nextWeekday(new Date(2026, 7, 24)).getDate()).toBe(25);
  });

  it("skips the weekend", () => {
    expect(nextWeekday(new Date(2026, 7, 28)).getDate()).toBe(31);
    expect(prevWeekday(new Date(2026, 7, 31)).getDate()).toBe(28);
  });

  it("finds the next given day, never today", () => {
    // Thursday the 27th; the next Thursday is the 3rd.
    expect(nextOccurring(thursday(), 4).getDate()).toBe(3);
    expect(nextOccurring(thursday(), 5).getDate()).toBe(28);
    expect(prevOccurring(thursday(), 4).getDate()).toBe(20);
  });
});

describe("relative to now", () => {
  const now = new Date(2026, 7, 27, 12, 0);

  it("knows today from yesterday and tomorrow", () => {
    expect(isToday(new Date(2026, 7, 27, 23, 0), now)).toBe(true);
    expect(isToday(new Date(2026, 7, 28, 0, 30), now)).toBe(false);

    expect(tomorrow(now).getDate()).toBe(28);
    expect(yesterday(now).getDate()).toBe(26);
  });

  it("knows past from future", () => {
    expect(isPast(new Date(2026, 7, 26), now)).toBe(true);
    expect(isFuture(new Date(2026, 7, 28), now)).toBe(true);
    expect(isPast(new Date(2026, 7, 28), now)).toBe(false);
  });
});

describe("a whole period, as a pair to range over", () => {
  it("covers a week end to end", () => {
    const [from, to] = allWeek(thursday());

    expect([from.getDate(), to.getDate()]).toEqual([24, 30]);
  });

  it("covers a month end to end", () => {
    const [from, to] = allMonth(thursday());

    expect([from.getDate(), to.getDate()]).toEqual([1, 31]);
  });
});

describe("leap years", () => {
  it("follows the hundred and four hundred year rules", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it("counts the days", () => {
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2026)).toBe(365);
  });
});

describe("the hour", () => {
  it("ends on its last millisecond", () => {
    const end = endOfHour(thursday());

    expect([end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([15, 59, 59]);
  });
});
