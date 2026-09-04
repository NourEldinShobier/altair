/**
 * Arithmetic between durations, numbers and times, ported from
 * `ActiveSupport::Duration`'s coercion methods and `Time`'s `advance`.
 *
 * `duration.ts` builds durations and advances a date by one. This is what
 * happens when a duration meets something that is not a duration, which is
 * where the surprising answers live.
 *
 * The whole subject is that **a duration is not a number of seconds**. It looks
 * like one — `1.month` will happily compare against `2592000` — and the moment
 * it is treated as one, three things go wrong:
 *
 * - A month is 28, 29, 30 or 31 days. `now + 1.month` lands on the same day
 *   number next month; `now + 2592000` lands wherever thirty days later
 *   happens to be, which is a different day in February and a different day
 *   every leap year.
 * - A day is not always 86,400 seconds. Across a daylight-saving boundary it
 *   is 23 or 25 hours, so a "daily at 09:00" job computed in seconds drifts an
 *   hour twice a year and then stays wrong until the next boundary.
 * - Adding a duration to a duration has to keep the parts separate.
 *   `1.month + 1.day` cannot be collapsed to a number without deciding how
 *   long the month is — and the answer depends on when it is applied, which is
 *   not known yet.
 *
 * So the arithmetic here keeps units, and only collapses to seconds when
 * something explicitly asks for a number.
 */

import { Duration, type DurationParts, advanceMonths } from "./duration.js";

/** Units that have a fixed length in seconds. */
const FIXED_SECONDS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86_400,
  weeks: 604_800,
};

/** Units whose length depends on when they are applied. */
export const CALENDAR_UNITS: readonly string[] = ["months", "years"];

/**
 * Whether a duration can be turned into a number at all. Rails treats a
 * calendar duration as a number only under protest.
 *
 * `1.month.to_i` in Rails answers 2,629,746 — the average month — which is
 * right for nothing in particular and wrong for every actual month. Naming
 * the question lets a caller avoid asking it.
 */
export function isCalendarDuration(parts: DurationParts): boolean {
  return CALENDAR_UNITS.some((unit) => (parts[unit as keyof DurationParts] ?? 0) !== 0);
}

/**
 * Rails' `coerce` — a number meeting a duration.
 *
 * The number becomes seconds, because that is the only unit a bare number can
 * mean. Guessing anything else — days, because the duration was in days —
 * would make `3 + 1.day` and `1.day + 3` different amounts.
 */
export function coerce(value: number): DurationParts {
  return { seconds: value };
}

/** Rails' `+` between two durations — parts kept apart. */
export function plusWithDuration(left: DurationParts, right: DurationParts): DurationParts {
  const sum: DurationParts = {};

  for (const unit of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const total =
      (left[unit as keyof DurationParts] ?? 0) + (right[unit as keyof DurationParts] ?? 0);

    if (total !== 0) sum[unit as keyof DurationParts] = total;
  }

  return sum;
}

/** Rails' `-` between two durations. */
export function minusWithDuration(left: DurationParts, right: DurationParts): DurationParts {
  return plusWithDuration(left, negate(right));
}

export function negate(parts: DurationParts): DurationParts {
  return Object.fromEntries(
    Object.entries(parts).map(([unit, value]) => [unit, -(value as number)]),
  ) as DurationParts;
}

/** Rails' `-` with a bare number on the right. */
export function minusWithCoercion(left: DurationParts, value: number): DurationParts {
  return minusWithDuration(left, coerce(value));
}

/**
 * The seconds a duration is worth. Rails' `to_i`.
 *
 * Refuses a calendar duration by default, because the answer would be an
 * average nobody asked for — the caller almost always wants
 * `advanceByDuration` instead, which knows *when* the month is.
 */
export function toSeconds(parts: DurationParts, { allowAverage = false } = {}): number {
  if (isCalendarDuration(parts) && !allowAverage) {
    throw new CalendarDurationInSeconds(parts);
  }

  return Object.entries(parts).reduce(
    (total, [unit, value]) =>
      total + (FIXED_SECONDS[unit] ?? AVERAGE_SECONDS[unit] ?? 0) * (value as number),
    0,
  );
}

/** The averages Rails uses when it has to. */
const AVERAGE_SECONDS: Record<string, number> = {
  months: 2_629_746,
  years: 31_556_952,
};

export class CalendarDurationInSeconds extends Error {
  constructor(parts: DurationParts) {
    super(
      `Cannot turn ${JSON.stringify(parts)} into a number of seconds: a month is 28 to 31 days ` +
        `and a year is 365 or 366, so the answer depends on when it is applied. Advance a date ` +
        `by it instead, or pass { allowAverage: true } if an average really is what you want.`,
    );
    this.name = "CalendarDurationInSeconds";
  }
}

// --- comparing -------------------------------------------------------------

/**
 * Rails' `<=>` with coercion.
 *
 * Compared as seconds using the averages, because a comparison has to answer
 * something — but a calendar duration compared against a fixed one is a
 * question with no exact answer, and callers should know that is what they
 * asked.
 */
export function compareWithCoercion(left: DurationParts, right: DurationParts | number): number {
  const other = typeof right === "number" ? coerce(right) : right;
  const difference =
    toSeconds(left, { allowAverage: true }) - toSeconds(other, { allowAverage: true });

  return Math.sign(difference);
}

/**
 * Rails' `eql?`.
 *
 * Stricter than `==`: two durations are `eql?` only when their *parts* match,
 * so `1.month` and `30.days` are equal in length and not `eql?`. That
 * distinction is what stops a cache keyed on a duration treating them as one.
 */
export function eqlWithCoercion(left: DurationParts, right: DurationParts): boolean {
  const units = new Set([...Object.keys(left), ...Object.keys(right)]);

  return [...units].every(
    (unit) =>
      (left[unit as keyof DurationParts] ?? 0) === (right[unit as keyof DurationParts] ?? 0),
  );
}

/** Rails' `multiple_of?`. */
export function multipleOf(parts: DurationParts, other: DurationParts): boolean {
  const divisor = toSeconds(other, { allowAverage: true });

  if (divisor === 0) return false;

  return toSeconds(parts, { allowAverage: true }) % divisor === 0;
}

// --- applying to a time ----------------------------------------------------

/**
 * Advances a moment by a duration. Rails' `since` / `advance`.
 *
 * Calendar units first and separately, because they are the ones that depend
 * on where they land: adding a month to 31 January has to resolve to 28
 * February *before* any remaining days are added, or the answer differs by a
 * day depending on the order of operations.
 */
export function atWithCoercion(moment: Date, parts: DurationParts): Date {
  let result = moment;

  const years = parts.years ?? 0;
  const months = parts.months ?? 0;

  if (years !== 0 || months !== 0) result = advanceMonths(result, years * 12 + months);

  const fixed = Object.entries(parts)
    .filter(([unit]) => FIXED_SECONDS[unit] !== undefined)
    .reduce(
      (total, [unit, value]) => total + (FIXED_SECONDS[unit] as number) * (value as number),
      0,
    );

  return fixed === 0 ? result : new Date(result.getTime() + fixed * 1000);
}

/** Rails' `ago`. */
export function beforeWithCoercion(moment: Date, parts: DurationParts): Date {
  return atWithCoercion(moment, negate(parts));
}

/** Rails' `future?`. */
export function future(moment: Date, now: Date = new Date()): boolean {
  return moment.getTime() > now.getTime();
}

/** Rails' `past?`. */
export function past(moment: Date, now: Date = new Date()): boolean {
  return moment.getTime() < now.getTime();
}

/**
 * Rails' `beginning_of_week`, with the week starting where the caller says.
 *
 * Configurable because the answer is cultural rather than technical: a weekly
 * report that starts on Sunday in one place and Monday in another is two
 * different reports, and hard-coding either produces the wrong one somewhere.
 */
export function findBeginningOfWeek(moment: Date, startsOn = 1): Date {
  const day = moment.getDay();
  const back = (day - startsOn + 7) % 7;
  const result = new Date(moment.getTime());
  result.setDate(result.getDate() - back);
  result.setHours(0, 0, 0, 0);

  return result;
}

/** Builds a `Duration` from parts, for a caller holding the plain shape. */
export function toDuration(parts: DurationParts): Duration {
  return new Duration(parts);
}
