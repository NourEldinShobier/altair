/**
 * Arithmetic on a time that has a zone, ported from
 * `activesupport/test/time_zone_test.rb` and `time_with_zone_test.rb`.
 *
 * "A day" means two things and both are right: 24 hours, or the same
 * wall-clock time tomorrow. They differ twice a year, and every test here that
 * crosses a DST boundary is checking that the two have not been confused.
 *
 * The dates are real: the US moved to daylight saving on 2026-03-08 and back
 * on 2026-11-01; the UK moved on 2026-03-29 and back on 2026-10-25.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { TimeZone } from "../src/time-zone.js";
import {
  US_ZONE_NAMES,
  advanceByCalendar,
  advanceByDuration,
  civilFromFormat,
  countryZones,
  currentZoneName,
  dst,
  fieldsIn,
  findZone,
  instantFor,
  loadTimeZone,
  offsetMinutes,
  onWeekday,
  onWeekend,
  period,
  quarterStart,
  resetZone,
  secFraction,
  thisQuarter,
  useZone,
  usZones,
  weekdayIn,
} from "../src/zoned-arithmetic.js";

afterEach(() => {
  resetZone();
});

const NEW_YORK = "America/New_York";
const LONDON = "Europe/London";
const UTC = "UTC";

describe("reading the clock in a zone", () => {
  it("reads the fields somebody there would see", () => {
    const at = new Date("2026-06-15T18:30:45.500Z");

    expect(fieldsIn(at, NEW_YORK)).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 14,
      minute: 30,
      second: 45,
      millisecond: 500,
    });
  });

  /**
   * Some ICU versions render midnight as "24" under `hour12: false`, which
   * would put the time on the wrong day. This runtime gives "00", so this test
   * documents the contract rather than catching a live bug.
   */
  it("reads midnight as hour zero", () => {
    expect(fieldsIn(new Date("2026-06-15T04:00:00Z"), NEW_YORK).hour).toBe(0);
  });

  it("reports the offset", () => {
    expect(offsetMinutes(new Date("2026-01-15T12:00:00Z"), NEW_YORK)).toBe(-300);
    expect(offsetMinutes(new Date("2026-06-15T12:00:00Z"), NEW_YORK)).toBe(-240);
  });

  it("reports no offset for UTC", () => {
    expect(offsetMinutes(new Date("2026-06-15T12:00:00Z"), UTC)).toBe(0);
  });
});

describe("finding the instant behind a wall-clock time", () => {
  it("resolves an ordinary time", () => {
    const at = instantFor(
      { year: 2026, month: 6, day: 15, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    expect(at.toISOString()).toBe("2026-06-15T13:00:00.000Z");
  });

  it("resolves one in winter", () => {
    const at = instantFor(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    expect(at.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  /** 02:30 does not happen on the day a zone enters daylight saving. */
  it("moves a missing time forward rather than failing", () => {
    const at = instantFor(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    expect(fieldsIn(at, NEW_YORK).hour).toBe(3);
  });

  /** 01:30 happens twice on the day it leaves; the first is the answer. */
  it("resolves a repeated time to the first of them", () => {
    const at = instantFor(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    expect(at.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  /**
   * The second pass earns its keep in zones far from UTC. Auckland is +12/+13,
   * so a wall-clock time near midnight lands on the other side of a transition
   * when it is first read as UTC — and one pass gives an answer an hour out,
   * on an ordinary day with no ambiguity at all.
   */
  it("corrects an offset misread in a zone far from UTC", () => {
    const auckland = "Pacific/Auckland";
    const at = instantFor(
      { year: 2026, month: 4, day: 4, hour: 23, minute: 30, second: 0, millisecond: 0 },
      auckland,
    );

    expect(fieldsIn(at, auckland).hour).toBe(23);
    expect(fieldsIn(at, auckland).day).toBe(4);
  });

  it("corrects it the other way at the spring transition", () => {
    const auckland = "Pacific/Auckland";
    const at = instantFor(
      { year: 2026, month: 9, day: 26, hour: 23, minute: 30, second: 0, millisecond: 0 },
      auckland,
    );

    expect(fieldsIn(at, auckland).hour).toBe(23);
  });

  it("round-trips through the fields", () => {
    const at = new Date("2026-06-15T13:00:00.000Z");

    expect(instantFor(fieldsIn(at, LONDON), LONDON).toISOString()).toBe(at.toISOString());
  });
});

describe("adding a duration", () => {
  it("adds the seconds it was given", () => {
    expect(advanceByDuration(new Date("2026-06-15T12:00:00Z"), 3600).toISOString()).toBe(
      "2026-06-15T13:00:00.000Z",
    );
  });

  /**
   * A token that lasts an hour lasts an hour across a DST change, because the
   * thing being protected does not care what the clock says.
   */
  it("keeps the same elapsed time across a DST change", () => {
    const before = new Date("2026-03-08T06:30:00Z");

    expect(advanceByDuration(before, 3600).getTime() - before.getTime()).toBe(3_600_000);
  });
});

describe("adding a calendar step", () => {
  /**
   * The whole point. Adding 24 hours across the spring change gives 10am, so a
   * daily digest drifts an hour every spring and back every autumn.
   */
  it("keeps the wall-clock time across the spring change", () => {
    const before = instantFor(
      { year: 2026, month: 3, day: 7, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    const after = advanceByCalendar(before, NEW_YORK, { days: 1 });

    expect(fieldsIn(after, NEW_YORK).hour).toBe(9);
    expect(fieldsIn(after, NEW_YORK).day).toBe(8);
  });

  /** And the other way: adding 24 hours here would give 8am, running a job twice. */
  it("keeps it across the autumn change", () => {
    const before = instantFor(
      { year: 2026, month: 10, day: 31, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    const after = advanceByCalendar(before, NEW_YORK, { days: 1 });

    expect(fieldsIn(after, NEW_YORK).hour).toBe(9);
    expect(fieldsIn(after, NEW_YORK).day).toBe(1);
  });

  it("is not the same as adding 24 hours, on those days", () => {
    const before = instantFor(
      { year: 2026, month: 3, day: 7, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK,
    );

    expect(advanceByCalendar(before, NEW_YORK, { days: 1 }).getTime()).not.toBe(
      advanceByDuration(before, 86_400).getTime(),
    );
  });

  it("is the same on an ordinary day", () => {
    const before = new Date("2026-06-15T13:00:00Z");

    expect(advanceByCalendar(before, NEW_YORK, { days: 1 }).getTime()).toBe(
      advanceByDuration(before, 86_400).getTime(),
    );
  });

  it("moves whole weeks", () => {
    const before = new Date("2026-06-15T13:00:00Z");

    expect(fieldsIn(advanceByCalendar(before, NEW_YORK, { weeks: 2 }), NEW_YORK).day).toBe(29);
  });

  it("moves months", () => {
    const before = new Date("2026-06-15T13:00:00Z");

    expect(fieldsIn(advanceByCalendar(before, NEW_YORK, { months: 2 }), NEW_YORK).month).toBe(8);
  });

  it("moves years", () => {
    const before = new Date("2026-06-15T13:00:00Z");

    expect(fieldsIn(advanceByCalendar(before, NEW_YORK, { years: 1 }), NEW_YORK).year).toBe(2027);
  });

  /**
   * 31 January plus one month is 28 February, not 3 March. Rolling over turns
   * a monthly subscription into one that drifts forward every short month.
   */
  it("clamps to the end of a shorter month", () => {
    const january = instantFor(
      { year: 2026, month: 1, day: 31, hour: 12, minute: 0, second: 0, millisecond: 0 },
      UTC,
    );

    const february = fieldsIn(advanceByCalendar(january, UTC, { months: 1 }), UTC);

    expect(february.month).toBe(2);
    expect(february.day).toBe(28);
  });

  it("crosses a year boundary in months", () => {
    const december = instantFor(
      { year: 2026, month: 12, day: 15, hour: 12, minute: 0, second: 0, millisecond: 0 },
      UTC,
    );

    const after = fieldsIn(advanceByCalendar(december, UTC, { months: 2 }), UTC);

    expect([after.year, after.month]).toEqual([2027, 2]);
  });

  it("goes backwards", () => {
    const at = instantFor(
      { year: 2026, month: 3, day: 15, hour: 12, minute: 0, second: 0, millisecond: 0 },
      UTC,
    );

    expect(fieldsIn(advanceByCalendar(at, UTC, { months: -3 }), UTC).month).toBe(12);
  });

  it("moves hours and minutes as a duration", () => {
    const at = new Date("2026-06-15T12:00:00Z");

    expect(advanceByCalendar(at, UTC, { hours: 2, minutes: 30 }).toISOString()).toBe(
      "2026-06-15T14:30:00.000Z",
    );
  });

  it("leaves an empty step alone", () => {
    const at = new Date("2026-06-15T12:00:00Z");

    expect(advanceByCalendar(at, UTC, {}).getTime()).toBe(at.getTime());
  });
});

describe("daylight saving", () => {
  it("is on in summer and off in winter", () => {
    expect(dst(new Date("2026-06-15T12:00:00Z"), NEW_YORK)).toBe(true);
    expect(dst(new Date("2026-01-15T12:00:00Z"), NEW_YORK)).toBe(false);
  });

  /** A zone with no daylight saving has one offset all year. */
  it("is never on in a zone that does not use it", () => {
    expect(dst(new Date("2026-06-15T12:00:00Z"), "America/Phoenix")).toBe(false);
    expect(dst(new Date("2026-06-15T12:00:00Z"), UTC)).toBe(false);
  });

  it("reports the offset and whether it is on together", () => {
    expect(period(new Date("2026-06-15T12:00:00Z"), NEW_YORK)).toEqual({
      offsetMinutes: -240,
      dst: true,
    });
  });
});

describe("the calendar", () => {
  /**
   * In the zone, not in UTC. Saturday morning in Auckland is still Friday in
   * UTC, and a job that skips weekends would run.
   */
  it("reads the day of the week where somebody is", () => {
    const at = new Date("2026-06-14T02:00:00Z");

    expect(weekdayIn(at, UTC)).toBe(0);
    expect(weekdayIn(at, NEW_YORK)).toBe(6);
  });

  it("knows a weekend from a weekday", () => {
    const saturday = new Date("2026-06-13T12:00:00Z");
    const monday = new Date("2026-06-15T12:00:00Z");

    expect(onWeekend(saturday, UTC)).toBe(true);
    expect(onWeekday(saturday, UTC)).toBe(false);
    expect(onWeekday(monday, UTC)).toBe(true);
  });

  it("counts Sunday as the weekend too", () => {
    expect(onWeekend(new Date("2026-06-14T12:00:00Z"), UTC)).toBe(true);
  });

  it("reports the quarter", () => {
    expect(thisQuarter(new Date("2026-02-15T12:00:00Z"), UTC)).toBe(1);
    expect(thisQuarter(new Date("2026-05-15T12:00:00Z"), UTC)).toBe(2);
    expect(thisQuarter(new Date("2026-08-15T12:00:00Z"), UTC)).toBe(3);
    expect(thisQuarter(new Date("2026-12-15T12:00:00Z"), UTC)).toBe(4);
  });

  it("reports where a quarter starts", () => {
    expect(quarterStart(new Date("2026-05-15T12:00:00Z"), UTC).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
  });

  it("reports the fraction of a second", () => {
    expect(secFraction(new Date("2026-06-15T12:00:00.250Z"))).toBe(0.25);
  });
});

describe("parsing a wall-clock string", () => {
  /**
   * Without a zone, `new Date("2026-03-04 09:00")` is parsed in whatever zone
   * the *server* is in — which is how a form submitted at 9am local becomes
   * 9am UTC and the reminder goes out at the wrong hour.
   */
  it("reads it as a time in the zone given", () => {
    expect(civilFromFormat("2026-06-15 09:00", NEW_YORK)?.toISOString()).toBe(
      "2026-06-15T13:00:00.000Z",
    );
  });

  it("takes a T between the date and the time", () => {
    expect(civilFromFormat("2026-06-15T09:00", NEW_YORK)?.toISOString()).toBe(
      "2026-06-15T13:00:00.000Z",
    );
  });

  it("takes a date on its own as midnight", () => {
    expect(civilFromFormat("2026-06-15", UTC)?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("takes seconds", () => {
    expect(civilFromFormat("2026-06-15 09:00:30", UTC)?.toISOString()).toBe(
      "2026-06-15T09:00:30.000Z",
    );
  });

  it("gives nothing for something that is not a date", () => {
    expect(civilFromFormat("not a date", UTC)).toBeNull();
  });
});

describe("finding zones", () => {
  it("finds one by name", () => {
    expect(findZone(NEW_YORK)?.name).toBe(NEW_YORK);
    expect(loadTimeZone(NEW_YORK)?.name).toBe(NEW_YORK);
  });

  it("gives nothing for a name that is not a zone", () => {
    expect(findZone("Middle/Earth")).toBeNull();
    expect(loadTimeZone("Middle/Earth")).toBeNull();
  });

  it("finds one by offset", () => {
    expect(findZone(0)).toBeInstanceOf(TimeZone);
  });

  it("lists the zones of a region", () => {
    expect(countryZones("Europe").length).toBeGreaterThan(0);
    expect(countryZones("Europe").every((zone) => zone.name.startsWith("Europe/"))).toBe(true);
  });

  it("lists the American ones", () => {
    expect(usZones().map((zone) => zone.name)).toEqual([...US_ZONE_NAMES]);
  });
});

describe("running in a zone", () => {
  it("has none by default", () => {
    expect(currentZoneName()).toBeUndefined();
  });

  it("sets one for the block", () => {
    useZone(NEW_YORK, () => {
      expect(currentZoneName()).toBe(NEW_YORK);
    });
  });

  it("puts the old one back", () => {
    useZone(NEW_YORK, () => undefined);

    expect(currentZoneName()).toBeUndefined();
  });

  it("nests", () => {
    useZone(NEW_YORK, () => {
      useZone(LONDON, () => {
        expect(currentZoneName()).toBe(LONDON);
      });

      expect(currentZoneName()).toBe(NEW_YORK);
    });
  });

  /**
   * A test that throws while a zone is set otherwise leaves every later test
   * running in it, and the failures appear in tests that had nothing to do
   * with time.
   */
  it("puts it back even when the block throws", () => {
    expect(() =>
      useZone(NEW_YORK, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(currentZoneName()).toBeUndefined();
  });
});
