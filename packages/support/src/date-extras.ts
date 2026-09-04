/**
 * The date and time helpers ActiveSupport adds that [dates.ts](./dates.ts) does
 * not already cover, ported from `ActiveSupport::CoreExt::DateTime` and
 * `TimeWithZone`.
 *
 * The neighbouring file has the boundaries — beginning and end of day, week,
 * month, quarter, year — and the arithmetic. These are the relative names
 * people actually write (`lastMonth`, `thisWeek`), the sub-second parts, and
 * the pieces a timezone needs.
 */

import { beginningOfMonth, beginningOfWeek, beginningOfYear, type Weekday } from "./dates.js";
import { partsInZone, zoneOffset } from "./time.js";

/**
 * The same day one month back, clamped to the end of a short month.
 *
 * `lastMonth` on 31 March is 28 February, not 3 March. JavaScript's own
 * arithmetic overflows into the next month, which is how a monthly report
 * dated the 31st silently reports on the wrong period twice a year.
 */
export function lastMonth(date: Date = new Date()): Date {
  return shiftMonths(date, -1);
}

/** The same day one month on, clamped the same way. */
export function nextMonthSameDay(date: Date = new Date()): Date {
  return shiftMonths(date, 1);
}

/** One year back, clamped so 29 February becomes 28 February. */
export function lastYear(date: Date = new Date()): Date {
  return shiftMonths(date, -12);
}

function shiftMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** The start of the week this date is in. Rails' `this_week`. */
export function thisWeek(date: Date = new Date(), startsOn?: Weekday): Date {
  return startsOn === undefined ? beginningOfWeek(date) : beginningOfWeek(date, startsOn);
}

/** The start of the month this date is in. Rails' `this_month`. */
export function thisMonth(date: Date = new Date()): Date {
  return beginningOfMonth(date);
}

/** The start of the year this date is in. Rails' `this_year`. */
export function thisYear(date: Date = new Date()): Date {
  return beginningOfYear(date);
}

/** The Monday of this date's week. Rails' `monday`. */
export function monday(date: Date = new Date()): Date {
  return beginningOfWeek(date, MONDAY);
}

/** The Sunday of this date's week. Rails' `sunday`. */
export function sunday(date: Date = new Date()): Date {
  return beginningOfWeek(date, SUNDAY);
}

/** Microseconds within the second. Rails' `usec`. */
export function usec(date: Date): number {
  return date.getUTCMilliseconds() * 1000;
}

/** Nanoseconds within the second. Rails' `nsec`. */
export function nsec(date: Date): number {
  return date.getUTCMilliseconds() * 1_000_000;
}

/**
 * The fraction of a second, as a number between 0 and 1. Rails' `subsec`.
 *
 * A JavaScript Date holds milliseconds and nothing finer, so `usec` and `nsec`
 * are exact multiples rather than real precision. That is worth knowing before
 * comparing against a database timestamp, which usually has microseconds and
 * will not round-trip through a Date unchanged.
 */
export function subsec(date: Date): number {
  return date.getUTCMilliseconds() / 1000;
}

/** The same instant with the sub-second part removed. */
export function withoutSubsec(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * Whether daylight saving is in force in a zone. Rails' `dst?`.
 *
 * Compared against January and July in the same year rather than a table:
 * whichever of the two has the smaller offset is standard time, and a date
 * offset differently from that is in daylight saving. It gets the southern
 * hemisphere right, where summer is in December, without needing to know
 * which hemisphere it is looking at.
 */
export function isDst(date: Date, zone: string): boolean {
  const year = date.getUTCFullYear();
  const january = zoneOffset(new Date(Date.UTC(year, 0, 1)), zone);
  const july = zoneOffset(new Date(Date.UTC(year, 6, 1)), zone);
  const standard = Math.min(january, july);

  return zoneOffset(date, zone) !== standard;
}

/**
 * A UTC offset in minutes, written the way a timestamp does. Rails'
 * `seconds_to_utc_offset` in its minute form.
 *
 *     secondsToUtcOffset(19800)   // "+05:30"
 *
 * Half-hour and quarter-hour zones are the reason this is not integer division:
 * India is +05:30 and Nepal +05:45, and a formatter that assumed whole hours is
 * wrong for a sixth of the planet.
 */
export function secondsToUtcOffset(seconds: number, colon = true): string {
  const sign = seconds < 0 ? "-" : "+";
  const total = Math.abs(Math.round(seconds / 60));
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");

  return `${sign}${hours}${colon ? ":" : ""}${minutes}`;
}

/** The two week starts anybody actually configures. */
const SUNDAY: Weekday = 0;
const MONDAY: Weekday = 1;

/**
 * How many days into the week a given day falls. Rails' `days_to_week_start`.
 *
 * The modulo is what makes it work across the wrap: with the week starting on
 * Monday, Sunday is six days in rather than minus one.
 */
export function daysToWeekStart(day: Weekday, startsOn: Weekday = MONDAY): number {
  return (day - startsOn + 7) % 7;
}

/** The same instant, read in a zone. Rails' `localtime`. */
export function localtime(date: Date, zone: string): Date {
  const parts = partsInZone(date, zone);

  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      date.getUTCMilliseconds(),
    ),
  );
}

/** The same instant as UTC, which for a Date it already is. Rails' `utc`. */
export function utc(date: Date): Date {
  return new Date(date.getTime());
}

/** A fortnight is two weeks, and Rails names it. */
export function fortnights(count = 1): number {
  return count * 14 * 24 * 60 * 60 * 1000;
}
