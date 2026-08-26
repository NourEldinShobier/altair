/**
 * Date arithmetic, ported from ActiveSupport's `Date` and `Time` extensions.
 *
 * Rails puts these on `Date` and `Time` themselves; JavaScript's `Date` is not
 * ours to extend, so they are functions taking one. The names and the meanings
 * are Rails': `beginningOfWeek` starts on Monday, `endOfDay` is the last
 * millisecond rather than the next midnight, and `monthsSince` clamps rather
 * than overflowing — the 31st of January plus one month is the 28th or 29th of
 * February, not the 2nd or 3rd of March.
 *
 *     beginningOfMonth(new Date("2026-08-27T13:00:00Z"))  // 1 August, 00:00
 *     monthsSince(new Date("2026-01-31"), 1)              // 28 February
 *
 * All of it works on the local calendar of the date it is given, which is what
 * `TimeWithZone` hands over when a zone is in play.
 */

import { advanceMonths, daysInMonth } from "./duration.js";

/** A day of the week, as `Date#getDay` numbers them. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Where a week starts. Rails defaults to Monday and lets an application say
 * otherwise, because half the world disagrees and both halves are right.
 */
let weekStart: Weekday = 1;

export function setBeginningOfWeek(day: Weekday): void {
  weekStart = day;
}

export function beginningOfWeekDay(): Weekday {
  return weekStart;
}

const DAY = 86_400_000;

/** A copy, so nothing here edits the date it was given. */
function copy(date: Date): Date {
  return new Date(date.getTime());
}

export function beginningOfDay(date: Date): Date {
  const next = copy(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

/**
 * The last millisecond of the day, not the first of the next.
 *
 * Rails' choice, and the reason a `BETWEEN` over `beginningOfDay(d)` and
 * `endOfDay(d)` does not quietly include midnight tomorrow.
 */
export function endOfDay(date: Date): Date {
  const next = copy(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

export function beginningOfHour(date: Date): Date {
  const next = copy(date);
  next.setMinutes(0, 0, 0);
  return next;
}

export function endOfHour(date: Date): Date {
  const next = copy(date);
  next.setMinutes(59, 59, 999);
  return next;
}

export function beginningOfMinute(date: Date): Date {
  const next = copy(date);
  next.setSeconds(0, 0);
  return next;
}

export function endOfMinute(date: Date): Date {
  const next = copy(date);
  next.setSeconds(59, 999);
  return next;
}

/** Midday, which Rails calls `middle_of_day`. */
export function middleOfDay(date: Date): Date {
  const next = copy(date);
  next.setHours(12, 0, 0, 0);
  return next;
}

export function beginningOfWeek(date: Date, startsOn: Weekday = weekStart): Date {
  const next = beginningOfDay(date);
  const shift = (next.getDay() - startsOn + 7) % 7;

  next.setDate(next.getDate() - shift);

  return next;
}

export function endOfWeek(date: Date, startsOn: Weekday = weekStart): Date {
  const next = beginningOfWeek(date, startsOn);
  next.setDate(next.getDate() + 6);

  return endOfDay(next);
}

export function beginningOfMonth(date: Date): Date {
  const next = beginningOfDay(date);
  next.setDate(1);
  return next;
}

export function endOfMonth(date: Date): Date {
  const next = beginningOfDay(date);
  // Zero-based, as `Date#getMonth` counts and as `daysInMonth` expects.
  next.setDate(daysInMonth(next.getFullYear(), next.getMonth()));

  return endOfDay(next);
}

export function beginningOfQuarter(date: Date): Date {
  const next = beginningOfMonth(date);
  next.setMonth(Math.floor(next.getMonth() / 3) * 3);

  return next;
}

export function endOfQuarter(date: Date): Date {
  const next = beginningOfQuarter(date);
  next.setMonth(next.getMonth() + 2);

  return endOfMonth(next);
}

export function beginningOfYear(date: Date): Date {
  const next = beginningOfDay(date);
  next.setMonth(0, 1);
  return next;
}

export function endOfYear(date: Date): Date {
  const next = beginningOfDay(date);
  next.setMonth(11, 31);

  return endOfDay(next);
}

/** Which quarter of the year it falls in, 1 through 4. */
export function quarter(date: Date): number {
  return Math.floor(date.getMonth() / 3) + 1;
}

export function daysAgo(date: Date, count: number): Date {
  return new Date(date.getTime() - count * DAY);
}

export function daysSince(date: Date, count: number): Date {
  return new Date(date.getTime() + count * DAY);
}

export function weeksAgo(date: Date, count: number): Date {
  return daysAgo(date, count * 7);
}

export function weeksSince(date: Date, count: number): Date {
  return daysSince(date, count * 7);
}

/**
 * Rails clamps rather than overflowing: 31 January plus one month is the last
 * day of February, not the 2nd or 3rd of March. `advanceMonths` already does
 * that, and every month and year helper goes through it so they agree.
 */
export function monthsSince(date: Date, count: number): Date {
  return advanceMonths(date, count);
}

export function monthsAgo(date: Date, count: number): Date {
  return advanceMonths(date, -count);
}

export function yearsSince(date: Date, count: number): Date {
  return advanceMonths(date, count * 12);
}

export function yearsAgo(date: Date, count: number): Date {
  return advanceMonths(date, -count * 12);
}

export function nextDay(date: Date): Date {
  return daysSince(date, 1);
}

export function prevDay(date: Date): Date {
  return daysAgo(date, 1);
}

export function nextWeek(date: Date, startsOn: Weekday = weekStart): Date {
  return beginningOfWeek(daysSince(date, 7), startsOn);
}

export function prevWeek(date: Date, startsOn: Weekday = weekStart): Date {
  return beginningOfWeek(daysAgo(date, 7), startsOn);
}

export function nextMonth(date: Date): Date {
  return monthsSince(date, 1);
}

export function prevMonth(date: Date): Date {
  return monthsAgo(date, 1);
}

export function nextQuarter(date: Date): Date {
  return monthsSince(date, 3);
}

export function prevQuarter(date: Date): Date {
  return monthsAgo(date, 3);
}

export function nextYear(date: Date): Date {
  return yearsSince(date, 1);
}

export function prevYear(date: Date): Date {
  return yearsAgo(date, 1);
}

export function isToday(date: Date, now: Date = new Date()): boolean {
  return beginningOfDay(date).getTime() === beginningOfDay(now).getTime();
}

export function tomorrow(now: Date = new Date()): Date {
  return beginningOfDay(daysSince(now, 1));
}

export function yesterday(now: Date = new Date()): Date {
  return beginningOfDay(daysAgo(now, 1));
}

export function today(now: Date = new Date()): Date {
  return beginningOfDay(now);
}

export function isPast(date: Date, now: Date = new Date()): boolean {
  return date.getTime() < now.getTime();
}

export function isFuture(date: Date, now: Date = new Date()): boolean {
  return date.getTime() > now.getTime();
}

export function isWeekend(date: Date): boolean {
  return date.getDay() === 0 || date.getDay() === 6;
}

export function isWeekday(date: Date): boolean {
  return !isWeekend(date);
}

/**
 * The next day that is not a weekend. Rails' `next_weekday`.
 *
 * Always moves at least one day, so asking on a Monday gives Tuesday rather
 * than the Monday you already had.
 */
export function nextWeekday(date: Date): Date {
  let next = nextDay(date);
  while (isWeekend(next)) next = nextDay(next);

  return next;
}

export function prevWeekday(date: Date): Date {
  let previous = prevDay(date);
  while (isWeekend(previous)) previous = prevDay(previous);

  return previous;
}

/** The next date that falls on a given weekday, never today. Rails' `next_occurring`. */
export function nextOccurring(date: Date, day: Weekday): Date {
  const shift = (day - date.getDay() + 7) % 7 || 7;

  return daysSince(date, shift);
}

export function prevOccurring(date: Date, day: Weekday): Date {
  const shift = (date.getDay() - day + 7) % 7 || 7;

  return daysAgo(date, shift);
}

/** The whole of a day, week, month, quarter or year, as a pair to range over. */
export function allDay(date: Date): [Date, Date] {
  return [beginningOfDay(date), endOfDay(date)];
}

export function allWeek(date: Date, startsOn: Weekday = weekStart): [Date, Date] {
  return [beginningOfWeek(date, startsOn), endOfWeek(date, startsOn)];
}

export function allMonth(date: Date): [Date, Date] {
  return [beginningOfMonth(date), endOfMonth(date)];
}

export function allQuarter(date: Date): [Date, Date] {
  return [beginningOfQuarter(date), endOfQuarter(date)];
}

export function allYear(date: Date): [Date, Date] {
  return [beginningOfYear(date), endOfYear(date)];
}

/** How many seconds into the day it is. */
export function secondsSinceMidnight(date: Date): number {
  return (date.getTime() - beginningOfDay(date).getTime()) / 1000;
}

export function secondsUntilEndOfDay(date: Date): number {
  return (endOfDay(date).getTime() - date.getTime()) / 1000;
}

/** 365, or 366. */
export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
