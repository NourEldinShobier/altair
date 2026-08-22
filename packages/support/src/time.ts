/**
 * Time zones, ported from `ActiveSupport::TimeWithZone`.
 *
 * A `Date` is an instant with no opinion about where it is being read. Rails'
 * TimeWithZone pairs the instant with a zone, so "what day is it" has an
 * answer. `Temporal` would be the natural home for this and does not exist in
 * Bun 1.4 — checked, not assumed — so it is built on `Intl`, which knows all
 * 455 zones and can be asked what the wall clock reads in any of them.
 */

import { Duration, advanceMonths } from "./duration.js";

/** The components of a moment as read in one zone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(zone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PART_FORMATTERS.set(zone, formatter);
  }

  return formatter;
}

/** What the wall clock reads in a zone at a given instant. */
export function partsInZone(moment: Date, zone: string): ZonedParts {
  const parts = formatterFor(zone).formatToParts(moment);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Midnight comes back as hour 24 in this format, not hour 0.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * A zone's offset from UTC at an instant, in minutes.
 *
 * Computed from the wall clock rather than a table, so daylight saving is
 * accounted for by asking what the zone actually reads that day.
 */
export function zoneOffset(moment: Date, zone: string): number {
  const parts = partsInZone(moment, zone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // The instant's own seconds, since the parts carry no milliseconds.
  const instant = Math.floor(moment.getTime() / 1000) * 1000;
  return (asIfUtc - instant) / 60_000;
}

/** Every zone the runtime knows. Rails ships a list; Intl already has one. */
export function timeZones(): string[] {
  return Intl.supportedValuesOf("timeZone");
}

/** Whether a zone name is one the runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

let configuredZone = "UTC";

/** Rails' `Time.zone = "Tokyo"`, by IANA name. */
export function setDefaultZone(zone: string): void {
  if (!isTimeZone(zone)) throw new Error(`"${zone}" is not a time zone this runtime knows.`);
  configuredZone = zone;
}

export function defaultZone(): string {
  return configuredZone;
}

function offsetLabel(minutes: number): string {
  // Local mean time before the zones were standardised was not a whole number
  // of minutes — Paris was +00:09:21 in 1890 — and ISO 8601 has no way to say
  // so. Rounding produces a valid offset instead of `+00:9.35`.
  const whole = Math.round(minutes);
  const sign = whole < 0 ? "-" : "+";
  const total = Math.abs(whole);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * An instant, read in a zone. Rails' `ActiveSupport::TimeWithZone`.
 *
 * The instant is what it is; the zone decides what it reads as. Two of these
 * for the same instant in different zones are equal as moments and differ in
 * every component.
 */
export class TimeWithZone {
  readonly moment: Date;
  readonly zone: string;

  constructor(moment: Date, zone: string = defaultZone()) {
    this.moment = moment;
    this.zone = zone;
  }

  static now(zone: string = defaultZone()): TimeWithZone {
    return new TimeWithZone(new Date(), zone);
  }

  /** Reads a wall-clock time *in a zone* and returns the instant it names. */
  static local(parts: Partial<ZonedParts>, zone: string = defaultZone()): TimeWithZone {
    const wanted: ZonedParts = {
      year: parts.year ?? 1970,
      month: parts.month ?? 1,
      day: parts.day ?? 1,
      hour: parts.hour ?? 0,
      minute: parts.minute ?? 0,
      second: parts.second ?? 0,
    };

    const guess = Date.UTC(
      wanted.year,
      wanted.month - 1,
      wanted.day,
      wanted.hour,
      wanted.minute,
      wanted.second,
    );

    // The offset depends on the instant, and the instant depends on the
    // offset. One correction settles it everywhere except the hour a zone
    // skips forward over, which no instant corresponds to: there, this lands
    // on the moment before the jump rather than refusing, so a stored
    // appointment on that hour still names a time.
    const first = new Date(guess - zoneOffset(new Date(guess), zone) * 60_000);
    const second = new Date(guess - zoneOffset(first, zone) * 60_000);

    return new TimeWithZone(second, zone);
  }

  get parts(): ZonedParts {
    return partsInZone(this.moment, this.zone);
  }

  get year(): number {
    return this.parts.year;
  }
  get month(): number {
    return this.parts.month;
  }
  get day(): number {
    return this.parts.day;
  }
  get hour(): number {
    return this.parts.hour;
  }
  get minute(): number {
    return this.parts.minute;
  }
  get second(): number {
    return this.parts.second;
  }

  /** Minutes ahead of UTC, negative behind. */
  get utcOffset(): number {
    return zoneOffset(this.moment, this.zone);
  }

  /** The same instant, read somewhere else. */
  inZone(zone: string): TimeWithZone {
    return new TimeWithZone(this.moment, zone);
  }

  /**
   * This moment plus a duration, in this zone's calendar.
   *
   * Years, months, weeks and days move the local calendar and keep the wall
   * clock; hours, minutes and seconds are a fixed span. That is Rails'
   * distinction and it is not decoration: a day after noon on the Saturday
   * before a spring-forward is noon on Sunday, while twenty-four hours after
   * it is one o'clock.
   */
  plus(amount: Duration): TimeWithZone {
    const { years, months, weeks, days } = amount.parts;
    const calendarDays = weeks * 7 + days;
    let result = this.moment;

    if (years !== 0 || months !== 0 || calendarDays !== 0) {
      let shifted = new Date(this.asIfUtc());

      if (years !== 0 || months !== 0) shifted = advanceMonths(shifted, years * 12 + months);
      if (calendarDays !== 0) shifted = new Date(shifted.getTime() + calendarDays * 86_400_000);

      result = TimeWithZone.local(partsFromUtc(shifted), this.zone).moment;
    }

    const fixed = amount.parts.hours * 3600 + amount.parts.minutes * 60 + amount.parts.seconds;

    return new TimeWithZone(
      fixed === 0 ? result : new Date(result.getTime() + fixed * 1000),
      this.zone,
    );
  }

  minus(amount: Duration): TimeWithZone {
    return this.plus(amount.negated());
  }

  /** Midnight, as this zone reckons it. */
  startOfDay(): TimeWithZone {
    const { year, month, day } = this.parts;
    return TimeWithZone.local({ year, month, day }, this.zone);
  }

  /** The last second of the day here. */
  endOfDay(): TimeWithZone {
    const { year, month, day } = this.parts;
    return TimeWithZone.local({ year, month, day, hour: 23, minute: 59, second: 59 }, this.zone);
  }

  /** The wall clock here, as an ISO 8601 string with this zone's offset. */
  toISO(): string {
    const { year, month, day, hour, minute, second } = this.parts;
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");

    return (
      `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}` +
      offsetLabel(this.utcOffset)
    );
  }

  /** Rails' `l(time)`, in this zone. */
  format(options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "medium",
      ...options,
      timeZone: this.zone,
    }).format(this.moment);
  }

  toDate(): Date {
    return new Date(this.moment.getTime());
  }

  /** Two of these are the same moment if their instants match, zone aside. */
  equals(other: TimeWithZone): boolean {
    return this.moment.getTime() === other.moment.getTime();
  }

  valueOf(): number {
    return this.moment.getTime();
  }

  toString(): string {
    return this.toISO();
  }

  toJSON(): string {
    return this.moment.toISOString();
  }

  /** @internal The wall clock here, as if it were a UTC instant. */
  private asIfUtc(): number {
    const { year, month, day, hour, minute, second } = this.parts;
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }
}

function partsFromUtc(moment: Date): ZonedParts {
  return {
    year: moment.getUTCFullYear(),
    month: moment.getUTCMonth() + 1,
    day: moment.getUTCDate(),
    hour: moment.getUTCHours(),
    minute: moment.getUTCMinutes(),
    second: moment.getUTCSeconds(),
  };
}

/** Rails' `Time.zone.now`. */
export function zoneNow(zone: string = defaultZone()): TimeWithZone {
  return TimeWithZone.now(zone);
}

/** Reads an instant in a zone. Rails' `time.in_time_zone("Tokyo")`. */
export function inTimeZone(moment: Date, zone: string = defaultZone()): TimeWithZone {
  return new TimeWithZone(moment, zone);
}
