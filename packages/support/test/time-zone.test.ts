/**
 * A zone as a thing you can hold, ported from
 * `activesupport/test/time_zone_test.rb`.
 *
 * Most of the questions an application asks come zone-first: a user picks one
 * in a form, a report is run for the Berlin office, a job schedules 9am
 * wherever the account is. Without something to hold the zone by, the string
 * is carried around and re-validated at every step — or, more often, not
 * validated at all until a date lands a day out.
 */

import { describe, expect, it } from "bun:test";
import { TimeZone } from "../src/time-zone.js";

const LONDON = TimeZone.create("Europe/London");
const TOKYO = TimeZone.create("Asia/Tokyo");
const SYDNEY = TimeZone.create("Australia/Sydney");
const UTC = TimeZone.create("UTC");

/** Midsummer and midwinter, so a hemisphere's summer time is unambiguous. */
const JUNE = new Date("2026-06-15T12:00:00Z");
const JANUARY = new Date("2026-01-15T12:00:00Z");

describe("finding a zone", () => {
  it("finds one by its identifier", () => {
    expect(TimeZone.find("Europe/London")?.name).toBe("Europe/London");
  });

  /** The caller normally holds a value from a form, and null is an answer. */
  it("gives null for something that is not a zone", () => {
    expect(TimeZone.find("Middle/Earth")).toBeNull();
    expect(TimeZone.find("")).toBeNull();
  });

  it("throws from create, for a caller that would rather be told", () => {
    expect(() => TimeZone.create("Middle/Earth")).toThrow("Unknown time zone");
  });

  it("names an identifier a person can act on in the message", () => {
    expect(() => TimeZone.create("PST")).toThrow("IANA");
  });

  it("says whether an identifier is one without building it", () => {
    expect(TimeZone.isValid("Europe/London")).toBe(true);
    expect(TimeZone.isValid("Middle/Earth")).toBe(false);
  });
});

describe("listing zones", () => {
  it("lists what the platform knows", () => {
    const all = TimeZone.all();

    expect(all.length).toBeGreaterThan(100);
    expect(all.map((one) => one.name)).toContain("Europe/London");
  });

  it("lists the zones of one area", () => {
    const european = TimeZone.zonesIn("Europe").map((one) => one.name);

    expect(european).toContain("Europe/Berlin");
    expect(european).not.toContain("Asia/Tokyo");
  });

  /**
   * An area, not a prefix. Under a prefix match a half-typed area would come
   * back with results, which reads as "there are eleven zones in Europe/Lon"
   * rather than as the typo it is.
   */
  it("matches the whole first segment", () => {
    const american = TimeZone.zonesIn("America").map((one) => one.name);

    expect(american.every((name) => name.startsWith("America/"))).toBe(true);
    expect(TimeZone.zonesIn("Europe/Lon")).toEqual([]);
    expect(TimeZone.zonesIn("Euro")).toEqual([]);
  });

  it("gives nothing for an area nobody has", () => {
    expect(TimeZone.zonesIn("Atlantis")).toEqual([]);
  });
});

describe("reading a time in a zone", () => {
  it("reads a unix timestamp", () => {
    const moment = UTC.at(0);

    expect(moment.year).toBe(1970);
    expect(moment.hour).toBe(0);
  });

  it("reads the same instant differently in two zones", () => {
    expect(UTC.at(0).hour).toBe(0);
    expect(TOKYO.at(0).hour).toBe(9);
  });

  it("builds a wall-clock time in the zone", () => {
    const nine = LONDON.local({ year: 2026, month: 6, day: 1, hour: 9 });

    expect(nine.hour).toBe(9);
    // London is an hour ahead of UTC in June, so 9am there is 8am UTC.
    expect(nine.toDate().getUTCHours()).toBe(8);
  });
});

describe("parsing", () => {
  /**
   * The one worth having. `new Date("2026-06-01 09:00")` reads the string in
   * whatever zone the machine is set to — a laptop in one place, a server in
   * UTC in another — so the same input becomes different instants and the
   * difference shows up as an appointment an hour out.
   */
  it("reads a time with no zone as one in this zone", () => {
    const london = LONDON.parse("2026-06-01 09:00");
    const tokyo = TOKYO.parse("2026-06-01 09:00");

    expect(london?.hour).toBe(9);
    expect(tokyo?.hour).toBe(9);
    expect(london?.toDate().getTime()).not.toBe(tokyo?.toDate().getTime());
  });

  it("takes a date on its own as midnight", () => {
    const midnight = LONDON.parse("2026-06-01");

    expect(midnight?.hour).toBe(0);
    expect(midnight?.day).toBe(1);
  });

  it("takes seconds", () => {
    expect(LONDON.parse("2026-06-01 09:30:45")?.second).toBe(45);
  });

  it("takes the T separator", () => {
    expect(LONDON.parse("2026-06-01T09:30")?.hour).toBe(9);
  });

  /** It already names an instant; re-reading it in this zone would move it. */
  it("respects an offset the string already carries", () => {
    const withZone = LONDON.parse("2026-06-01T09:00:00Z");

    expect(withZone?.toDate().toISOString()).toBe("2026-06-01T09:00:00.000Z");
    // Read in London, that instant is ten o'clock.
    expect(withZone?.hour).toBe(10);
  });

  it("respects a written offset", () => {
    expect(LONDON.parse("2026-06-01T09:00:00+09:00")?.toDate().toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  it("gives null for something that is not a time", () => {
    expect(LONDON.parse("next tuesday")).toBeNull();
    expect(LONDON.parse("")).toBeNull();
    expect(LONDON.parse("   ")).toBeNull();
  });

  /**
   * `Date.UTC` turns 31 February into 3 March without complaint, so a typo
   * becomes a real date three days off rather than an error somebody can see.
   */
  it("refuses a date that does not exist", () => {
    expect(LONDON.parse("2026-02-31")).toBeNull();
    expect(LONDON.parse("2026-13-01")).toBeNull();
    expect(LONDON.parse("2026-00-01")).toBeNull();
  });

  it("takes a leap day in a leap year and refuses it otherwise", () => {
    expect(LONDON.parse("2028-02-29")?.day).toBe(29);
    expect(LONDON.parse("2026-02-29")).toBeNull();
  });

  it("refuses an impossible clock time", () => {
    expect(LONDON.parse("2026-06-01 25:00")).toBeNull();
    expect(LONDON.parse("2026-06-01 09:61")).toBeNull();
  });

  it("ignores surrounding space", () => {
    expect(LONDON.parse("  2026-06-01 09:00  ")?.hour).toBe(9);
  });
});

describe("offsets", () => {
  it("gives the offset in minutes", () => {
    expect(UTC.utcOffset(JUNE)).toBe(0);
    expect(TOKYO.utcOffset(JUNE)).toBe(540);
  });

  it("gives a negative offset for the other side", () => {
    expect(TimeZone.create("America/New_York").utcOffset(JANUARY)).toBe(-300);
  });

  it("formats it the way it is written down", () => {
    expect(TOKYO.formattedOffset(JUNE)).toBe("+09:00");
    expect(UTC.formattedOffset(JUNE)).toBe("+00:00");
    expect(TimeZone.create("America/New_York").formattedOffset(JANUARY)).toBe("-05:00");
  });

  it("formats a half-hour offset", () => {
    expect(TimeZone.create("Asia/Kolkata").formattedOffset(JUNE)).toBe("+05:30");
  });

  it("moves with the season", () => {
    expect(LONDON.utcOffset(JANUARY)).toBe(0);
    expect(LONDON.utcOffset(JUNE)).toBe(60);
  });
});

describe("summer time", () => {
  it("knows when a northern zone is on it", () => {
    expect(LONDON.isDst(JUNE)).toBe(true);
    expect(LONDON.isDst(JANUARY)).toBe(false);
  });

  /** Why this cannot just look at January. */
  it("knows when a southern zone is on it", () => {
    expect(SYDNEY.isDst(JANUARY)).toBe(true);
    expect(SYDNEY.isDst(JUNE)).toBe(false);
  });

  it("says no for a zone that does not keep it", () => {
    expect(TOKYO.isDst(JUNE)).toBe(false);
    expect(TOKYO.isDst(JANUARY)).toBe(false);
    expect(UTC.isDst(JUNE)).toBe(false);
  });
});

describe("days", () => {
  it("gives midnight in the zone", () => {
    expect(LONDON.today().hour).toBe(0);
    expect(TOKYO.today().hour).toBe(0);
  });

  it("moves a day either way", () => {
    const today = LONDON.today();

    expect(LONDON.tomorrow().toDate().getTime()).toBeGreaterThan(today.toDate().getTime());
    expect(LONDON.yesterday().toDate().getTime()).toBeLessThan(today.toDate().getTime());
  });

  it("keeps midnight on both", () => {
    expect(LONDON.tomorrow().hour).toBe(0);
    expect(LONDON.yesterday().hour).toBe(0);
  });
});

describe("as a value", () => {
  it("reads as its identifier, which is what gets stored", () => {
    expect(String(LONDON)).toBe("Europe/London");
    expect(JSON.stringify({ zone: LONDON })).toBe('{"zone":"Europe/London"}');
  });

  it("compares by identifier", () => {
    expect(LONDON.equals(TimeZone.create("Europe/London"))).toBe(true);
    expect(LONDON.equals(TOKYO)).toBe(false);
  });

  it("has a current one", () => {
    expect(TimeZone.isValid(TimeZone.current().name)).toBe(true);
  });
});
