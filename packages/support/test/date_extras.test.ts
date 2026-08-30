/**
 * The relative date names and time parts, ported from
 * `activesupport/test/core_ext/date_ext_test.rb`,
 * `date_time_ext_test.rb` and `time_zone_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  daysToWeekStart,
  fortnights,
  isDst,
  lastMonth,
  lastYear,
  localtime,
  monday,
  nextMonthSameDay,
  nsec,
  secondsToUtcOffset,
  subsec,
  sunday,
  thisMonth,
  thisWeek,
  thisYear,
  usec,
  utc,
  withoutSubsec,
} from "../src/date_extras.js";

describe("relative months", () => {
  it("goes back a month", () => {
    expect(lastMonth(new Date("2026-03-15T00:00:00Z")).toISOString()).toBe(
      "2026-02-15T00:00:00.000Z",
    );
  });

  /**
   * The case JavaScript gets wrong: plain arithmetic overflows 31 March into
   * 3 March, which is how a monthly report dated the 31st reports on the wrong
   * period twice a year.
   */
  it("clamps to the end of a short month", () => {
    expect(lastMonth(new Date("2026-03-31T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("clamps into a leap February", () => {
    expect(lastMonth(new Date("2024-03-31T00:00:00Z")).toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("goes forward a month, clamped the same way", () => {
    expect(nextMonthSameDay(new Date("2026-01-31T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(lastMonth(new Date("2026-01-15T00:00:00Z")).toISOString()).toBe(
      "2025-12-15T00:00:00.000Z",
    );
  });

  it("goes back a year", () => {
    expect(lastYear(new Date("2026-05-10T00:00:00Z")).toISOString()).toBe(
      "2025-05-10T00:00:00.000Z",
    );
  });

  it("clamps 29 February to 28", () => {
    expect(lastYear(new Date("2024-02-29T00:00:00Z")).toISOString()).toBe(
      "2023-02-28T00:00:00.000Z",
    );
  });

  it("keeps the time of day", () => {
    expect(lastMonth(new Date("2026-03-15T13:45:30Z")).toISOString()).toBe(
      "2026-02-15T13:45:30.000Z",
    );
  });
});

describe("the current period", () => {
  it("gives the start of the week", () => {
    // 2026-01-07 is a Wednesday; the week starts on Monday by default.
    expect(thisWeek(new Date("2026-01-07T12:00:00Z")).toISOString()).toBe(
      "2026-01-05T00:00:00.000Z",
    );
  });

  it("gives the start of the month", () => {
    expect(thisMonth(new Date("2026-03-15T12:00:00Z")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("gives the start of the year", () => {
    expect(thisYear(new Date("2026-03-15T12:00:00Z")).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("gives the Monday and the Sunday of the week", () => {
    const wednesday = new Date("2026-01-07T12:00:00Z");

    expect(monday(wednesday).toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(sunday(wednesday).toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });
});

describe("sub-second parts", () => {
  const moment = new Date("2026-01-01T00:00:00.250Z");

  it("gives microseconds", () => {
    expect(usec(moment)).toBe(250_000);
  });

  it("gives nanoseconds", () => {
    expect(nsec(moment)).toBe(250_000_000);
  });

  it("gives the fraction", () => {
    expect(subsec(moment)).toBe(0.25);
  });

  it("truncates to the second", () => {
    expect(withoutSubsec(moment).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is zero on a whole second", () => {
    expect(subsec(new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });
});

describe("secondsToUtcOffset", () => {
  it("writes whole hours", () => {
    expect(secondsToUtcOffset(3600)).toBe("+01:00");
  });

  /** India is +05:30 and Nepal +05:45; whole-hour division is wrong for both. */
  it("writes a half-hour zone", () => {
    expect(secondsToUtcOffset(19_800)).toBe("+05:30");
  });

  it("writes a quarter-hour zone", () => {
    expect(secondsToUtcOffset(20_700)).toBe("+05:45");
  });

  it("writes a negative offset", () => {
    expect(secondsToUtcOffset(-18_000)).toBe("-05:00");
  });

  it("writes UTC", () => {
    expect(secondsToUtcOffset(0)).toBe("+00:00");
  });

  it("drops the colon when asked", () => {
    expect(secondsToUtcOffset(19_800, false)).toBe("+0530");
  });
});

describe("daysToWeekStart", () => {
  it("is zero on the start day", () => {
    expect(daysToWeekStart(1)).toBe(0);
  });

  /** The modulo is what makes Sunday six days in rather than minus one. */
  it("wraps across the week", () => {
    expect(daysToWeekStart(0)).toBe(6);
  });

  it("counts forward within the week", () => {
    expect(daysToWeekStart(3)).toBe(2);
  });

  it("takes a different start", () => {
    expect(daysToWeekStart(0, 0)).toBe(0);
    expect(daysToWeekStart(1, 0)).toBe(1);
  });
});

describe("timezones", () => {
  /**
   * Compared against January and July rather than a table, which gets the
   * southern hemisphere right without knowing which hemisphere it is in.
   */
  it("sees daylight saving in the north", () => {
    expect(isDst(new Date("2026-07-01T12:00:00Z"), "America/New_York")).toBe(true);
    expect(isDst(new Date("2026-01-01T12:00:00Z"), "America/New_York")).toBe(false);
  });

  it("sees it in the south, where summer is in December", () => {
    expect(isDst(new Date("2026-01-01T12:00:00Z"), "Australia/Sydney")).toBe(true);
    expect(isDst(new Date("2026-07-01T12:00:00Z"), "Australia/Sydney")).toBe(false);
  });

  it("says no for a zone that has none", () => {
    expect(isDst(new Date("2026-07-01T12:00:00Z"), "UTC")).toBe(false);
    expect(isDst(new Date("2026-01-01T12:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  it("reads a moment in a zone", () => {
    const read = localtime(new Date("2026-01-01T12:00:00Z"), "Asia/Kolkata");

    expect(read.toISOString()).toBe("2026-01-01T17:30:00.000Z");
  });

  it("leaves UTC alone", () => {
    const moment = new Date("2026-01-01T12:00:00Z");

    expect(utc(moment).toISOString()).toBe(moment.toISOString());
  });
});

describe("fortnights", () => {
  it("is two weeks in milliseconds", () => {
    expect(fortnights(1)).toBe(14 * 24 * 60 * 60 * 1000);
    expect(fortnights(2)).toBe(28 * 24 * 60 * 60 * 1000);
  });
});
