/**
 * Doing arithmetic on a time that has a zone. Ported from
 * `ActiveSupport::TimeWithZone` and `TimeZone`'s calendar helpers.
 *
 * `time-zone.ts` can tell you what time it is somewhere and what the offset is.
 * What it cannot do is add a day to it, and that turns out to be the whole
 * problem, because "a day" means two different things and both are right:
 *
 *   - **A duration.** 24 hours. What you want for a rate limit, a token
 *     expiry, an SLA.
 *   - **A calendar step.** The same wall-clock time tomorrow. What you want
 *     for a subscription renewal, a daily digest, "due tomorrow at 9am".
 *
 * They differ twice a year. On the day a zone enters daylight saving, 9am plus
 * 24 hours is 10am; the subscription that renews "daily at 9am" drifts an hour
 * every spring and back every autumn, and the digest goes out at the wrong
 * time for six months. On the day it leaves, adding 24 hours to 9am gives 8am
 * — and a job that runs "every day at midnight" runs twice.
 *
 * So the two are separate functions with names that say which they are, and
 * neither is the default. A single `add` would be one of them silently.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { TimeZone } from "./time-zone.js";

/** The parts of a time as somebody in a zone would read them. */
export interface ZonedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** What a calendar step can move. */
export interface CalendarStep {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

const PARTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/** What the clock says in a zone at an instant. */
export function fieldsIn(at: Date, zone: string): ZonedFields {
  const parts = new Intl.DateTimeFormat("en-US", { ...PARTS, timeZone: zone }).formatToParts(at);
  const read = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Defensive: `hour12: false` renders midnight as "24" in some ICU
    // versions rather than "00", which would put the time on the wrong day.
    // This runtime gives "00", so the modulo changes nothing here — it is
    // guarding the runtimes it might not.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
    millisecond: at.getMilliseconds(),
  };
}

/** The offset of a zone at an instant, in minutes east of UTC. */
export function offsetMinutes(at: Date, zone: string): number {
  const fields = fieldsIn(at, zone);
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.millisecond,
  );

  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The instant at which a zone shows these fields. Rails' `TimeZone#local`.
 *
 * A wall-clock time does not always name exactly one instant. On the day a
 * zone leaves daylight saving, 01:30 happens twice; on the day it enters,
 * 02:30 never happens at all. The first pass gives an answer that may be an
 * hour out, and the second pass corrects it using the offset that actually
 * applies there — which resolves the repeated hour to the first occurrence and
 * the missing hour forward, matching what Rails and every calendar app do.
 */
export function instantFor(fields: ZonedFields, zone: string): Date {
  const naive = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.millisecond,
  );

  const firstGuess = new Date(naive - offsetMinutes(new Date(naive), zone) * 60_000);
  const corrected = new Date(naive - offsetMinutes(firstGuess, zone) * 60_000);

  // The correction is right when the answer reads back as the time that was
  // asked for. When it does not, the wall-clock time never happened — the zone
  // skipped it — and the first pass is the forward-shifted instant, which is
  // what Rails and every calendar application land on. Without this check the
  // correction lands an hour *before* the missing time, which is worse than
  // either answer: a reminder set for 02:30 fires at 01:30.
  return sameClock(fieldsIn(corrected, zone), fields) ? corrected : firstGuess;
}

function sameClock(a: ZonedFields, b: ZonedFields): boolean {
  return a.hour === b.hour && a.minute === b.minute && a.day === b.day;
}

/**
 * Adds a duration. The same number of seconds, whatever the clock does.
 *
 * For anything measured rather than scheduled: a token that lasts an hour
 * lasts an hour across a DST change, because the thing being protected does
 * not care what the clock says.
 */
export function advanceByDuration(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1000);
}

/**
 * Moves by calendar steps, keeping the wall-clock time. Rails' `advance`.
 *
 * For anything scheduled: "the same time tomorrow" stays the same time
 * tomorrow, so a daily digest does not drift an hour every spring.
 *
 * The order is deliberate — years, then months, then days, then time. Adding a
 * month to 31 January has to land in February before a day is added, or the
 * answer depends on which was applied first.
 */
export function advanceByCalendar(at: Date, zone: string, step: CalendarStep): Date {
  const fields = fieldsIn(at, zone);

  const year = fields.year + (step.years ?? 0);
  const monthIndex = fields.month - 1 + (step.months ?? 0);
  const yearsFromMonths = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;

  // Clamped, because 31 January plus one month is 28 February and not 3 March.
  // Rolling over is what turns a monthly subscription into one that drifts
  // forward every time it lands on a short month.
  const daysInMonth = new Date(Date.UTC(year + yearsFromMonths, month + 1, 0)).getUTCDate();

  const moved: ZonedFields = {
    ...fields,
    year: year + yearsFromMonths,
    month: month + 1,
    day: Math.min(fields.day, daysInMonth),
  };

  const afterMonths = instantFor(moved, zone);
  const days = (step.days ?? 0) + (step.weeks ?? 0) * 7;

  if (days !== 0) {
    const shifted = fieldsIn(afterMonths, zone);
    const asUtc = new Date(Date.UTC(shifted.year, shifted.month - 1, shifted.day));
    asUtc.setUTCDate(asUtc.getUTCDate() + days);

    return instantFor(
      {
        ...shifted,
        year: asUtc.getUTCFullYear(),
        month: asUtc.getUTCMonth() + 1,
        day: asUtc.getUTCDate(),
      },
      zone,
    );
  }

  const seconds = (step.hours ?? 0) * 3600 + (step.minutes ?? 0) * 60 + (step.seconds ?? 0);

  return seconds === 0 ? afterMonths : advanceByDuration(afterMonths, seconds);
}

/** Whether a zone is on daylight saving at an instant. Rails' `dst?`. */
export function dst(at: Date, zone: string): boolean {
  const january = offsetMinutes(new Date(Date.UTC(fieldsIn(at, zone).year, 0, 1)), zone);
  const july = offsetMinutes(new Date(Date.UTC(fieldsIn(at, zone).year, 6, 1)), zone);

  // The standard offset is the smaller of the two: daylight saving moves a
  // zone *east*, and a zone with no daylight saving has one offset all year.
  return offsetMinutes(at, zone) > Math.min(january, july);
}

/** What a zone's offset and name are at an instant. Rails' `period_for_utc`. */
export function period(at: Date, zone: string): { offsetMinutes: number; dst: boolean } {
  return { offsetMinutes: offsetMinutes(at, zone), dst: dst(at, zone) };
}

/** The fraction of a second, for a format that wants it separately. Rails' `sec_fraction`. */
export function secFraction(at: Date): number {
  return at.getMilliseconds() / 1000;
}

/** Which day of the week it is where somebody is. 0 is Sunday. */
export function weekdayIn(at: Date, zone: string): number {
  const fields = fieldsIn(at, zone);

  return new Date(Date.UTC(fields.year, fields.month - 1, fields.day)).getUTCDay();
}

/**
 * Rails' `on_weekday?` and `on_weekend?`.
 *
 * In the zone rather than in UTC. A Friday evening in Auckland is a Friday
 * there and a Friday morning in UTC — but a Saturday morning in Auckland is
 * still Friday in UTC, and a job that skips weekends would run.
 */
export function onWeekend(at: Date, zone: string): boolean {
  const day = weekdayIn(at, zone);

  return day === 0 || day === 6;
}

export function onWeekday(at: Date, zone: string): boolean {
  return !onWeekend(at, zone);
}

/** The quarter an instant falls in, 1 to 4. Rails' `this_quarter`. */
export function thisQuarter(at: Date, zone: string): number {
  return Math.floor((fieldsIn(at, zone).month - 1) / 3) + 1;
}

/** The start of the quarter, in the zone. */
export function quarterStart(at: Date, zone: string): Date {
  const fields = fieldsIn(at, zone);
  const month = (thisQuarter(at, zone) - 1) * 3 + 1;

  return instantFor(
    { ...fields, month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 },
    zone,
  );
}

/**
 * Parses a wall-clock string as a time in a zone. Rails' `civil_from_format`.
 *
 * Without a zone `new Date("2026-03-04 09:00")` is parsed in whatever zone the
 * *server* is in, which is how a form submitted at 9am local becomes 9am UTC
 * and the reminder goes out at the wrong hour for everybody outside London.
 */
export function civilFromFormat(value: string, zone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());

  if (!match) return null;

  return instantFor(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] ?? 0),
      minute: Number(match[5] ?? 0),
      second: Number(match[6] ?? 0),
      millisecond: 0,
    },
    zone,
  );
}

/** Every zone whose identifier starts with a region. Rails' `country_zones`. */
export function countryZones(region: string): TimeZone[] {
  return TimeZone.zonesIn(region);
}

/** The ones an American application usually offers. Rails' `us_zones`. */
export const US_ZONE_NAMES: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export function usZones(): TimeZone[] {
  return US_ZONE_NAMES.map((name) => TimeZone.find(name)).filter(
    (zone): zone is TimeZone => zone !== null,
  );
}

/** Rails' `TimeZone[]` by name or by offset. */
export function findZone(nameOrOffsetSeconds: string | number): TimeZone | null {
  if (typeof nameOrOffsetSeconds === "string") return TimeZone.find(nameOrOffsetSeconds);

  const wanted = nameOrOffsetSeconds / 60;
  const now = new Date();

  return TimeZone.all().find((zone) => offsetMinutes(now, zone.name) === wanted) ?? null;
}

/** Whether a name is a zone this platform knows. Rails' `load_time_zone`. */
export function loadTimeZone(name: string): TimeZone | null {
  return TimeZone.find(name);
}

/**
 * The zone in force: what a `useZone` block chose, or what the process was
 * told to use.
 *
 * The block's is scoped. Swapping a module-level variable put one request's
 * zone on every request rendering beside it, so a page could show a timestamp
 * in a zone belonging to somebody else's session — wrong in a way that reads
 * as right, since the number is plausible and the label is missing.
 *
 * Rails keeps `Time.zone` per fiber for exactly this. The comment that used
 * to be here worried about a test that throws leaving the zone set, which is
 * the failure one thread can have; there is nothing left to leave now.
 */
let current: string | undefined;

/** The zone a `useZone` block is in, which is not the process's. */
const scopedZone = new AsyncLocalStorage<string | undefined>();

export function currentZoneName(): string | undefined {
  return scopedZone.getStore() ?? current;
}

export function useZone<T>(zone: string, body: () => T): T {
  return scopedZone.run(zone, body);
}

export function resetZone(): void {
  current = undefined;
}
