/**
 * Durations, ported from `ActiveSupport::Duration`.
 *
 * Rails writes `2.days.ago` by opening Integer. JavaScript has no business
 * doing that to Number, so the same idea arrives as functions: `days(2).ago()`.
 *
 * The part worth porting carefully is that **a month is not thirty days**. A
 * duration keeps its parts rather than collapsing to a count of seconds, so
 * adding a month to the 31st lands on the last day of the next month the way a
 * calendar does, and adding a year to the 29th of February lands on the 28th.
 * A duration that collapsed to seconds would quietly answer "March 3rd".
 */

/** The parts a duration is made of, largest first. */
export interface DurationParts {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

/** Seconds in each part that has a fixed length. Months and years do not. */
const FIXED_SECONDS = {
  weeks: 604_800,
  days: 86_400,
  hours: 3600,
  minutes: 60,
  seconds: 1,
} as const;

/** What Rails uses when a duration in months has to become a number. */
const SECONDS_PER_MONTH = 2_629_746;
const SECONDS_PER_YEAR = 31_556_952;

const ORDER = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"] as const;

export class Duration {
  readonly parts: Readonly<Required<DurationParts>>;

  constructor(parts: DurationParts) {
    this.parts = {
      years: parts.years ?? 0,
      months: parts.months ?? 0,
      weeks: parts.weeks ?? 0,
      days: parts.days ?? 0,
      hours: parts.hours ?? 0,
      minutes: parts.minutes ?? 0,
      seconds: parts.seconds ?? 0,
    };
  }

  /**
   * The duration as a number of seconds.
   *
   * Months and years use Rails' averages, because there is no honest exact
   * answer without knowing which month. Use `after` when the answer matters.
   */
  get inSeconds(): number {
    const { years, months, ...fixed } = this.parts;
    let total = years * SECONDS_PER_YEAR + months * SECONDS_PER_MONTH;

    for (const [part, seconds] of Object.entries(FIXED_SECONDS)) {
      total += (fixed as Record<string, number>)[part]! * seconds;
    }

    return total;
  }

  get inMilliseconds(): number {
    return this.inSeconds * 1000;
  }

  plus(other: Duration): Duration {
    const sum: DurationParts = {};
    for (const part of ORDER) sum[part] = this.parts[part] + other.parts[part];
    return new Duration(sum);
  }

  minus(other: Duration): Duration {
    return this.plus(other.negated());
  }

  negated(): Duration {
    const negated: DurationParts = {};
    for (const part of ORDER) negated[part] = -this.parts[part];
    return new Duration(negated);
  }

  /**
   * This duration after a moment. Rails' `since`.
   *
   * Years and months move the calendar; everything else is a fixed span. That
   * split is the whole point of keeping the parts.
   */
  after(moment: Date = new Date()): Date {
    const { years, months } = this.parts;
    let result = moment;

    if (years !== 0 || months !== 0) {
      result = advanceMonths(result, years * 12 + months);
    }

    const fixed =
      this.parts.weeks * FIXED_SECONDS.weeks +
      this.parts.days * FIXED_SECONDS.days +
      this.parts.hours * FIXED_SECONDS.hours +
      this.parts.minutes * FIXED_SECONDS.minutes +
      this.parts.seconds;

    return fixed === 0 ? result : new Date(result.getTime() + fixed * 1000);
  }

  /** This duration before a moment. Rails' `until`. */
  before(moment: Date = new Date()): Date {
    return this.negated().after(moment);
  }

  /** Rails' `2.days.ago`. */
  ago(now: Date = new Date()): Date {
    return this.before(now);
  }

  /** Rails' `2.days.from_now`. */
  fromNow(now: Date = new Date()): Date {
    return this.after(now);
  }

  /** Rails' `inspect`: "2 days", "1 hour and 30 minutes". */
  toString(): string {
    const spoken = ORDER.filter((part) => this.parts[part] !== 0).map((part) => {
      const value = this.parts[part];
      const word = Math.abs(value) === 1 ? part.slice(0, -1) : part;
      return `${value} ${word}`;
    });

    if (spoken.length === 0) return "0 seconds";
    if (spoken.length === 1) return spoken[0]!;

    return `${spoken.slice(0, -1).join(", ")} and ${spoken.at(-1)}`;
  }

  /** Comparing durations compares their length. */
  valueOf(): number {
    return this.inSeconds;
  }
}

/**
 * Moves a date by whole months, keeping the day where the calendar allows.
 *
 * The last day of a long month has no counterpart in a short one. Rails lands
 * on the last day of the target month; `setMonth` alone would roll forward
 * into the month after, so January 31st plus one month would answer March 3rd.
 */
export function advanceMonths(moment: Date, months: number): Date {
  const day = moment.getUTCDate();
  const result = new Date(moment.getTime());

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDay = daysInMonth(result.getUTCFullYear(), result.getUTCMonth());
  result.setUTCDate(Math.min(day, lastDay));

  return result;
}

/**
 * How many days a month has, leap years included.
 *
 * The month is zero-based, as `Date#getMonth` counts them — January is 0. The
 * name does not say so, and passing a human month number is off by one in a
 * way the answer looks fine for: August asked as 8 gives September's 30.
 */
export function daysInMonth(year: number, month: number): number {
  // Day zero of the next month is the last day of this one.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

const factory =
  (part: keyof DurationParts) =>
  (value = 1): Duration =>
    new Duration({ [part]: value });

export const seconds = factory("seconds");
export const minutes = factory("minutes");
export const hours = factory("hours");
export const days = factory("days");
export const weeks = factory("weeks");
export const months = factory("months");
export const years = factory("years");

/** A single unit, as Rails' `1.day` reads. */
export const second = () => seconds(1);
export const minute = () => minutes(1);
export const hour = () => hours(1);
export const day = () => days(1);
export const week = () => weeks(1);
export const month = () => months(1);
export const year = () => years(1);

/** Builds a duration from several parts at once. */
export function duration(parts: DurationParts): Duration {
  return new Duration(parts);
}
