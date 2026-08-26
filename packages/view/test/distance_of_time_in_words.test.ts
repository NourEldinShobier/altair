/**
 * `distance_of_time_in_words`, ported from
 * actionview/test/template/date_helper_test.rb.
 *
 * Every assertion below is Rails' own, including the ones that look wrong:
 * 45 minutes is "about 1 hour", 30 days is "about 1 month", and a span of two
 * years and three months is "about 2 years" while two years and three months
 * and a day is "over 2 years". The wording is a convention, not a calculation,
 * and an application with one of these in a template has it in a test too.
 */

import { describe, expect, it } from "bun:test";
import { distanceOfTimeInWords, timeAgoInWords } from "../src/helpers.js";

/** Rails' `from` in that file. */
const FROM = Date.UTC(2004, 5, 6, 21, 45, 0);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Ruby's `time + 2.years - 3.months + 1.day`.
 *
 * ActiveSupport advances the calendar parts in order rather than adding a
 * fixed number of seconds, which is the whole reason the year branch has to
 * count leap days. Doing it any other way here would test a different span
 * than Rails does.
 */
function advance(
  from: number,
  parts: { years?: number; months?: number; days?: number; seconds?: number },
): Date {
  const date = new Date(from);
  const shifted = Date.UTC(
    date.getUTCFullYear() + (parts.years ?? 0),
    date.getUTCMonth() + (parts.months ?? 0),
    date.getUTCDate() + (parts.days ?? 0),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );

  return new Date(shifted + (parts.seconds ?? 0) * SECOND);
}

/** The distance from Rails' `from` to `from` plus this many milliseconds. */
const after = (milliseconds: number, includeSeconds?: boolean) =>
  distanceOfTimeInWords(FROM, FROM + milliseconds, { includeSeconds });

describe("the first minute, counted in seconds", () => {
  it("words each threshold as Rails does", () => {
    expect(after(0, true)).toBe("less than 5 seconds");
    expect(after(4 * SECOND, true)).toBe("less than 5 seconds");
    expect(after(5 * SECOND, true)).toBe("less than 10 seconds");
    expect(after(9 * SECOND, true)).toBe("less than 10 seconds");
    expect(after(10 * SECOND, true)).toBe("less than 20 seconds");
    expect(after(19 * SECOND, true)).toBe("less than 20 seconds");
    expect(after(20 * SECOND, true)).toBe("half a minute");
    expect(after(39 * SECOND, true)).toBe("half a minute");
    expect(after(40 * SECOND, true)).toBe("less than a minute");
    expect(after(59 * SECOND, true)).toBe("less than a minute");
    expect(after(60 * SECOND, true)).toBe("1 minute");
    expect(after(89 * SECOND, true)).toBe("1 minute");
  });
});

describe("the first minute, not counted in seconds", () => {
  it("is all one phrase until the rounding tips it", () => {
    expect(after(0)).toBe("less than a minute");
    expect(after(20 * SECOND)).toBe("less than a minute");
    // 29s rounds down to 0 minutes, 30s rounds up to 1.
    expect(after(29 * SECOND)).toBe("less than a minute");
    expect(after(30 * SECOND)).toBe("1 minute");
    expect(after(89 * SECOND)).toBe("1 minute");
  });
});

describe("minutes and hours", () => {
  it("counts minutes up to 45", () => {
    expect(after(MINUTE + 30 * SECOND)).toBe("2 minutes");
    expect(after(44 * MINUTE + 29 * SECOND)).toBe("44 minutes");
  });

  // 45 minutes is "about 1 hour". Rails is deliberately vague here.
  it("rounds to hours from 45 minutes", () => {
    expect(after(44 * MINUTE + 30 * SECOND)).toBe("about 1 hour");
    expect(after(89 * MINUTE + 29 * SECOND)).toBe("about 1 hour");
    expect(after(89 * MINUTE + 30 * SECOND)).toBe("about 2 hours");
    expect(after(23 * HOUR + 59 * MINUTE + 29 * SECOND)).toBe("about 24 hours");
  });
});

describe("days", () => {
  it("switches to days just before 24 hours", () => {
    expect(after(23 * HOUR + 59 * MINUTE + 30 * SECOND)).toBe("1 day");
    expect(after(41 * HOUR + 59 * MINUTE + 29 * SECOND)).toBe("1 day");
    expect(after(41 * HOUR + 59 * MINUTE + 30 * SECOND)).toBe("2 days");
    expect(after(2 * DAY + 12 * HOUR)).toBe("3 days");
    expect(after(29 * DAY + 23 * HOUR + 59 * MINUTE + 29 * SECOND)).toBe("30 days");
  });
});

describe("months", () => {
  it("is vague for the first two and exact after", () => {
    expect(after(29 * DAY + 23 * HOUR + 59 * MINUTE + 30 * SECOND)).toBe("about 1 month");
    expect(after(44 * DAY + 23 * HOUR + 59 * MINUTE + 29 * SECOND)).toBe("about 1 month");
    expect(after(44 * DAY + 23 * HOUR + 59 * MINUTE + 30 * SECOND)).toBe("about 2 months");
    expect(after(59 * DAY + 23 * HOUR + 59 * MINUTE + 29 * SECOND)).toBe("about 2 months");
    expect(after(59 * DAY + 23 * HOUR + 59 * MINUTE + 30 * SECOND)).toBe("2 months");
  });
});

/**
 * The branch with the leap-year correction. Without it, two dates a calendar
 * year apart word as "over 1 year" whenever a February 29th falls between
 * them — which is why these are calendar spans rather than fixed durations.
 */
describe("years", () => {
  const span = (parts: Parameters<typeof advance>[1]) =>
    distanceOfTimeInWords(FROM, advance(FROM, parts));

  it("is still months up to the last half minute", () => {
    expect(span({ years: 1, seconds: -31 })).toBe("12 months");
    expect(span({ years: 1, seconds: -30 })).toBe("about 1 year");
  });

  it("says about, over, and almost at the quarters", () => {
    expect(span({ years: 1, months: 3, days: -1 })).toBe("about 1 year");
    expect(span({ years: 1, months: 6 })).toBe("over 1 year");
    expect(span({ years: 2, months: -3, days: 1 })).toBe("almost 2 years");
    expect(span({ years: 2, months: 3, days: -1 })).toBe("about 2 years");
    expect(span({ years: 2, months: 3, days: 1 })).toBe("over 2 years");
    expect(span({ years: 2, months: 9, days: -1 })).toBe("over 2 years");
    expect(span({ years: 2, months: 9, days: 1 })).toBe("almost 3 years");
  });

  it("holds over five years", () => {
    expect(span({ years: 5, months: -3, days: 1 })).toBe("almost 5 years");
    expect(span({ years: 5, months: 3, days: -1 })).toBe("about 5 years");
    expect(span({ years: 5, months: 3, days: 1 })).toBe("over 5 years");
    expect(span({ years: 5, months: 9, days: -1 })).toBe("over 5 years");
    expect(span({ years: 5, months: 9, days: 1 })).toBe("almost 6 years");
  });

  it("holds over ten, where the leap days have piled up", () => {
    expect(span({ years: 10, months: -3, days: 1 })).toBe("almost 10 years");
    expect(span({ years: 10, months: 3, days: -1 })).toBe("about 10 years");
    expect(span({ years: 10, months: 3, days: 1 })).toBe("over 10 years");
    expect(span({ years: 10, months: 9, days: -1 })).toBe("over 10 years");
    expect(span({ years: 10, months: 9, days: 1 })).toBe("almost 11 years");
  });
});

// A length, not a direction: which end is which does not change the answer.
describe("a `to` before the `from`", () => {
  it("words the same distance", () => {
    expect(distanceOfTimeInWords(FROM + 4 * HOUR, FROM)).toBe("about 4 hours");
    expect(distanceOfTimeInWords(FROM + 19 * SECOND, FROM, { includeSeconds: true })).toBe(
      "less than 20 seconds",
    );
    expect(distanceOfTimeInWords(FROM + 19 * SECOND, FROM)).toBe("less than a minute");
  });
});

describe("timeAgoInWords", () => {
  it("measures from now, and does not say ago", () => {
    expect(timeAgoInWords(Date.now() - 3 * DAY)).toBe("3 days");
  });
});

// Rails raises ArgumentError on a nil. Without this the value falls past every
// threshold — `NaN < 45` is false — and comes back as "about NaN years".
describe("something that is not a date", () => {
  it("is refused rather than worded", () => {
    expect(() => distanceOfTimeInWords("last tuesday")).toThrow(/not a date/);
    expect(() => distanceOfTimeInWords(FROM, "whenever")).toThrow(/not a date/);
  });
});
