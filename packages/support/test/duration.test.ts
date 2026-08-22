/**
 * Durations and time zones.
 *
 * Mirrors activesupport/test/core_ext/duration_test.rb and
 * time_with_zone_test.rb. The cases that earn their place are the ones a
 * duration collapsed to seconds gets wrong: a month is not thirty days, and
 * the 31st has no counterpart in February.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  advanceMonths,
  days,
  daysInMonth,
  duration,
  hours,
  minutes,
  months,
  seconds,
  weeks,
  years,
} from "../src/duration.js";
import {
  defaultZone,
  inTimeZone,
  isTimeZone,
  partsInZone,
  setDefaultZone,
  TimeWithZone,
  timeZones,
  zoneOffset,
} from "../src/time.js";

const at = (iso: string) => new Date(iso);

afterEach(() => {
  setDefaultZone("UTC");
});

describe("building durations", () => {
  it("counts fixed units in seconds", () => {
    expect(seconds(30).inSeconds).toBe(30);
    expect(minutes(2).inSeconds).toBe(120);
    expect(hours(1).inSeconds).toBe(3600);
    expect(days(1).inSeconds).toBe(86_400);
    expect(weeks(1).inSeconds).toBe(604_800);
  });

  it("adds and subtracts", () => {
    expect(hours(1).plus(minutes(30)).inSeconds).toBe(5400);
    expect(hours(2).minus(minutes(30)).inSeconds).toBe(5400);
  });

  it("negates", () => {
    expect(days(2).negated().inSeconds).toBe(-172_800);
  });

  it("compares by length", () => {
    expect(hours(1) < days(1)).toBe(true);
    expect(minutes(60).inSeconds === hours(1).inSeconds).toBe(true);
  });

  it("says what it is", () => {
    expect(days(2).toString()).toBe("2 days");
    expect(days(1).toString()).toBe("1 day");
    expect(hours(1).plus(minutes(30)).toString()).toBe("1 hour and 30 minutes");
    expect(duration({}).toString()).toBe("0 seconds");
  });
});

describe("fixed arithmetic", () => {
  it("moves forward", () => {
    expect(days(1).after(at("2026-03-04T10:00:00Z")).toISOString()).toBe(
      "2026-03-05T10:00:00.000Z",
    );
  });

  it("moves back", () => {
    expect(days(1).ago(at("2026-03-04T10:00:00Z")).toISOString()).toBe("2026-03-03T10:00:00.000Z");
  });

  it("combines parts", () => {
    const moment = duration({ days: 1, hours: 2 }).after(at("2026-03-04T10:00:00Z"));
    expect(moment.toISOString()).toBe("2026-03-05T12:00:00.000Z");
  });
});

// The reason a duration keeps its parts instead of collapsing to seconds.
describe("calendar arithmetic", () => {
  it("moves whole months", () => {
    expect(months(1).after(at("2026-01-15T00:00:00Z")).toISOString()).toBe(
      "2026-02-15T00:00:00.000Z",
    );
  });

  // Thirty days past January 31st is March 2nd, which is not what "next month"
  // means to anyone.
  it("lands on the last day when the target month is shorter", () => {
    expect(months(1).after(at("2026-01-31T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("does the same going backwards", () => {
    expect(months(1).ago(at("2026-03-31T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("knows about leap years", () => {
    expect(months(1).after(at("2028-01-31T00:00:00Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(years(1).after(at("2028-02-29T00:00:00Z")).toISOString()).toBe(
      "2029-02-28T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(months(2).after(at("2026-12-15T00:00:00Z")).toISOString()).toBe(
      "2027-02-15T00:00:00.000Z",
    );
  });

  it("moves years", () => {
    expect(years(2).after(at("2026-06-01T00:00:00Z")).toISOString()).toBe(
      "2028-06-01T00:00:00.000Z",
    );
  });

  it("keeps the time of day", () => {
    expect(months(1).after(at("2026-01-15T13:45:30Z")).toISOString()).toBe(
      "2026-02-15T13:45:30.000Z",
    );
  });

  it("applies the calendar part before the fixed part", () => {
    const moment = duration({ months: 1, days: 1 }).after(at("2026-01-31T00:00:00Z"));
    // January 31st plus a month is February 28th; plus a day is March 1st.
    expect(moment.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("counts the days in a month", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 0)).toBe(31);
  });

  it("advances months on its own", () => {
    expect(advanceMonths(at("2026-01-31T00:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });
});

describe("zones", () => {
  it("knows the ones the runtime does", () => {
    expect(timeZones().length).toBeGreaterThan(100);
    expect(isTimeZone("Asia/Tokyo")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  it("refuses a zone it does not know", () => {
    expect(() => setDefaultZone("Mars/Olympus")).toThrow("not a time zone");
  });

  it("has a default that can be set", () => {
    expect(defaultZone()).toBe("UTC");
    setDefaultZone("Asia/Tokyo");
    expect(defaultZone()).toBe("Asia/Tokyo");
  });

  it("reads the wall clock in a zone", () => {
    const parts = partsInZone(at("2026-03-04T10:00:00Z"), "Asia/Tokyo");
    expect(parts).toEqual({ year: 2026, month: 3, day: 4, hour: 19, minute: 0, second: 0 });
  });

  // Midnight comes back as hour 24 from this formatter, not hour 0.
  it("reads midnight as hour zero", () => {
    expect(partsInZone(at("2026-03-04T00:00:00Z"), "UTC").hour).toBe(0);
  });

  it("reports an offset", () => {
    expect(zoneOffset(at("2026-03-04T10:00:00Z"), "Asia/Tokyo")).toBe(540);
    expect(zoneOffset(at("2026-03-04T10:00:00Z"), "UTC")).toBe(0);
  });

  // Asking the zone what it actually reads is what makes this work without a
  // table of rules to keep up to date.
  it("follows daylight saving", () => {
    expect(zoneOffset(at("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(zoneOffset(at("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
  });
});

describe("a time in a zone", () => {
  const moment = at("2026-03-04T10:00:00Z");

  it("reads its components there", () => {
    const tokyo = inTimeZone(moment, "Asia/Tokyo");

    expect(tokyo.year).toBe(2026);
    expect(tokyo.month).toBe(3);
    expect(tokyo.day).toBe(4);
    expect(tokyo.hour).toBe(19);
  });

  // The same instant, two zones: equal as moments, different in every part.
  it("is the same moment in another zone", () => {
    const tokyo = inTimeZone(moment, "Asia/Tokyo");
    const york = tokyo.inZone("America/New_York");

    expect(york.equals(tokyo)).toBe(true);
    expect(york.hour).toBe(5);
    expect(york.day).toBe(4);
  });

  it("crosses the date line", () => {
    const late = inTimeZone(at("2026-03-04T22:00:00Z"), "Asia/Tokyo");
    expect(late.day).toBe(5);
    expect(late.hour).toBe(7);
  });

  it("writes ISO 8601 with its own offset", () => {
    expect(inTimeZone(moment, "Asia/Tokyo").toISO()).toBe("2026-03-04T19:00:00+09:00");
    expect(inTimeZone(moment, "America/New_York").toISO()).toBe("2026-03-04T05:00:00-05:00");
    expect(inTimeZone(moment, "UTC").toISO()).toBe("2026-03-04T10:00:00+00:00");
  });

  it("serializes to JSON as the instant", () => {
    expect(JSON.parse(JSON.stringify({ at: inTimeZone(moment, "Asia/Tokyo") })).at).toBe(
      "2026-03-04T10:00:00.000Z",
    );
  });

  it("formats in its own zone", () => {
    const formatted = inTimeZone(moment, "Asia/Tokyo").format(
      { dateStyle: "short", timeStyle: "short" },
      "en-US",
    );
    expect(formatted).toContain("7:00");
  });
});

describe("reading a wall clock into an instant", () => {
  it("finds the instant a local time names", () => {
    const tokyo = TimeWithZone.local({ year: 2026, month: 3, day: 4, hour: 19 }, "Asia/Tokyo");

    expect(tokyo.moment.toISOString()).toBe("2026-03-04T10:00:00.000Z");
  });

  // The offset depends on the instant and the instant on the offset, so this
  // has to settle rather than guess once.
  it("gets it right on the far side of a daylight change", () => {
    const summer = TimeWithZone.local(
      { year: 2026, month: 7, day: 15, hour: 12 },
      "America/New_York",
    );

    expect(summer.moment.toISOString()).toBe("2026-07-15T16:00:00.000Z");
    expect(summer.hour).toBe(12);
  });

  it("gets it right in winter too", () => {
    const winter = TimeWithZone.local(
      { year: 2026, month: 1, day: 15, hour: 12 },
      "America/New_York",
    );

    expect(winter.moment.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(winter.hour).toBe(12);
  });

  it("finds the start and end of the day here", () => {
    const tokyo = inTimeZone(at("2026-03-04T10:00:00Z"), "Asia/Tokyo");

    expect(tokyo.startOfDay().toISO()).toBe("2026-03-04T00:00:00+09:00");
    expect(tokyo.endOfDay().toISO()).toBe("2026-03-04T23:59:59+09:00");
  });

  // Midnight in Tokyo is the previous afternoon in UTC.
  it("puts the start of the day at the right instant", () => {
    const tokyo = inTimeZone(at("2026-03-04T10:00:00Z"), "Asia/Tokyo");
    expect(tokyo.startOfDay().moment.toISOString()).toBe("2026-03-03T15:00:00.000Z");
  });
});

describe("moving a zoned time", () => {
  it("adds a fixed duration", () => {
    const tokyo = inTimeZone(at("2026-03-04T10:00:00Z"), "Asia/Tokyo");
    expect(tokyo.plus(hours(2)).toISO()).toBe("2026-03-04T21:00:00+09:00");
  });

  it("subtracts", () => {
    const tokyo = inTimeZone(at("2026-03-04T10:00:00Z"), "Asia/Tokyo");
    expect(tokyo.minus(days(1)).toISO()).toBe("2026-03-03T19:00:00+09:00");
  });

  // "A month from now" should be the same date and time locally, whatever the
  // offset does in between.
  it("adds a month by the local calendar", () => {
    const york = inTimeZone(at("2026-01-15T17:00:00Z"), "America/New_York");
    expect(york.hour).toBe(12);

    const later = york.plus(months(6));
    expect(later.hour).toBe(12);
    expect(later.month).toBe(7);
    expect(later.day).toBe(15);
  });

  it("clamps the day when the target month is shorter", () => {
    const york = inTimeZone(at("2026-01-31T17:00:00Z"), "America/New_York");
    const later = york.plus(months(1));

    expect(later.month).toBe(2);
    expect(later.day).toBe(28);
    expect(later.hour).toBe(12);
  });

  it("keeps the zone", () => {
    const tokyo = inTimeZone(at("2026-03-04T10:00:00Z"), "Asia/Tokyo");
    expect(tokyo.plus(days(1)).zone).toBe("Asia/Tokyo");
  });
});

// Rails distinguishes a calendar day from twenty-four hours, and the
// difference only shows up twice a year — which is exactly when it matters.
describe("daylight saving", () => {
  // New York springs forward 2026-03-08: 02:00 becomes 03:00.
  const saturday = TimeWithZone.local(
    { year: 2026, month: 3, day: 7, hour: 12 },
    "America/New_York",
  );

  it("keeps the wall clock when adding a day", () => {
    const sunday = saturday.plus(days(1));

    expect(sunday.hour).toBe(12);
    expect(sunday.day).toBe(8);
    expect(sunday.utcOffset).toBe(-240);
  });

  it("moves the wall clock when adding twenty-four hours", () => {
    expect(saturday.plus(hours(24)).hour).toBe(13);
  });

  it("treats a week as seven calendar days", () => {
    const later = saturday.plus(weeks(1));

    expect(later.hour).toBe(12);
    expect(later.day).toBe(14);
  });

  it("keeps the wall clock going back across the change too", () => {
    const sunday = TimeWithZone.local(
      { year: 2026, month: 3, day: 8, hour: 12 },
      "America/New_York",
    );
    expect(sunday.minus(days(1)).hour).toBe(12);
  });

  // The southern hemisphere changes the other way round, which a rule table
  // gets wrong and asking the zone does not.
  it("follows a southern hemisphere change", () => {
    const january = TimeWithZone.local(
      { year: 2026, month: 1, day: 15, hour: 11 },
      "Australia/Sydney",
    );

    expect(january.utcOffset).toBe(660);
    expect(january.plus(months(6)).utcOffset).toBe(600);
    expect(january.plus(months(6)).hour).toBe(11);
  });

  // An hour a zone skips names no instant. Landing on the moment before the
  // jump beats refusing, so a stored appointment still says something.
  it("resolves a wall-clock time that never happened", () => {
    const skipped = TimeWithZone.local(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    );

    expect(skipped.moment.toISOString()).toBe("2026-03-08T06:30:00.000Z");
  });
});

describe("odd offsets", () => {
  it("handles zones that are not a whole hour from UTC", () => {
    const moment = at("2026-03-04T10:00:00Z");

    expect(inTimeZone(moment, "Asia/Kolkata").toISO()).toBe("2026-03-04T15:30:00+05:30");
    expect(inTimeZone(moment, "Asia/Kathmandu").toISO()).toBe("2026-03-04T15:45:00+05:45");
    expect(inTimeZone(moment, "Pacific/Chatham").toISO()).toBe("2026-03-04T23:45:00+13:45");
  });

  // Local mean time before the zones were standardised was not a whole number
  // of minutes, and ISO 8601 has no way to say so.
  it("writes a valid offset for a historic one that is not whole minutes", () => {
    const paris = inTimeZone(at("1890-01-01T00:00:00Z"), "Europe/Paris");

    expect(paris.toISO()).toBe("1890-01-01T00:09:21+00:09");
    expect(paris.toISO()).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});
