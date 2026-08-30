/**
 * A zone as a thing you can hold, ported from `ActiveSupport::TimeZone`.
 *
 *     const zone = TimeZone.find("Europe/London")
 *     zone.now()
 *     zone.parse("2026-06-01 09:00")
 *     zone.at(1_750_000_000)
 *
 * `time.ts` has instants: a `TimeWithZone` is a moment plus the zone it should
 * be read in. This is the other half — the zone itself, before there is a
 * moment. It matters because most of the questions an application asks come in
 * that order: a user picks a zone in a form, a report is run "for the Berlin
 * office", a job schedules "9am wherever the account is". Each of those has a
 * zone first and a time second, and without something to hold the zone by, the
 * string gets carried around and re-validated at every step — or, more often,
 * not validated at all until a date lands a day out.
 *
 * Rails' TimeZone also carries its own names for zones ("London", "Pacific
 * Time (US & Canada)"). Those are not reproduced: they are a fixed table that
 * ages, the platform already ships the real IANA list, and inventing a second
 * naming scheme means every stored value has to be translated at both ends.
 * The identifiers here are the ones the database and the browser use.
 */

import {
  TimeWithZone,
  defaultZone,
  isTimeZone,
  partsInZone,
  timeZones,
  zoneOffset,
  type ZonedParts,
} from "./time.js";
import { days } from "./duration.js";

/**
 * A named zone.
 *
 * Constructed through `find` or `create` rather than directly, so an
 * identifier is checked once — at the point somebody typed it — rather than at
 * every use, or never.
 */
export class TimeZone {
  private constructor(readonly name: string) {}

  /**
   * The zone with this identifier, or null. Rails' `TimeZone[]`.
   *
   * Null rather than a throw, because the caller is normally holding a value
   * out of a form or a database column and "that is not a zone" is an ordinary
   * answer to give a user.
   */
  static find(name: string): TimeZone | null {
    return isTimeZone(name) ? new TimeZone(name) : null;
  }

  /** The same, for a caller that would rather be told. Rails' `create`. */
  static create(name: string): TimeZone {
    const zone = TimeZone.find(name);

    if (zone === null) {
      throw new Error(`Unknown time zone: ${name}. Use an IANA identifier such as Europe/London.`);
    }

    return zone;
  }

  /** Every zone the platform knows. Rails' `TimeZone.all`. */
  static all(): TimeZone[] {
    return timeZones().map((name) => new TimeZone(name));
  }

  /**
   * The zones under one region prefix. Rails' `country_zones`, by area.
   *
   * IANA identifiers are `Area/Location`, so "Europe" gives the European ones.
   * Matched on the whole first segment rather than as a prefix, so "America"
   * does not also return nothing sensible for "Americas".
   */
  static zonesIn(area: string): TimeZone[] {
    const wanted = `${area}/`;

    return TimeZone.all().filter((zone) => zone.name.startsWith(wanted));
  }

  /** The zone the application uses when nothing says otherwise. */
  static current(): TimeZone {
    return new TimeZone(defaultZone());
  }

  /** Whether an identifier names a zone, without building one. */
  static isValid(name: string): boolean {
    return isTimeZone(name);
  }

  /** Now, read in this zone. */
  now(): TimeWithZone {
    return TimeWithZone.now(this.name);
  }

  /** The instant a unix timestamp names, read in this zone. Rails' `at`. */
  at(seconds: number): TimeWithZone {
    return new TimeWithZone(new Date(seconds * 1000), this.name);
  }

  /** A wall-clock time in this zone. Rails' `local`. */
  local(parts: Partial<ZonedParts>): TimeWithZone {
    return TimeWithZone.local(parts, this.name);
  }

  /** Midnight today, in this zone. Rails' `today` as a time. */
  today(): TimeWithZone {
    return this.now().startOfDay();
  }

  /** Midnight tomorrow. */
  tomorrow(): TimeWithZone {
    return this.today().plus(days(1));
  }

  /** Midnight yesterday. */
  yesterday(): TimeWithZone {
    return this.today().minus(days(1));
  }

  /**
   * Reads a time written without a zone as one in this zone. Rails' `parse`.
   *
   *     TimeZone.create("Europe/London").parse("2026-06-01 09:00")
   *
   * This is the one worth having. `new Date("2026-06-01 09:00")` reads the
   * string in whatever zone the machine happens to be set to, which is a
   * developer's laptop in one place and a server in UTC in another — so the
   * same input produces different instants and the difference only shows up
   * as an appointment an hour out.
   *
   * A string that already carries an offset or a `Z` is respected: it names an
   * instant, and re-reading it in this zone would move it.
   */
  parse(value: string): TimeWithZone | null {
    const trimmed = value.trim();

    if (trimmed === "") return null;

    if (hasExplicitOffset(trimmed)) {
      const moment = new Date(trimmed);

      return Number.isNaN(moment.getTime()) ? null : new TimeWithZone(moment, this.name);
    }

    const parts = parseWallClock(trimmed);

    return parts === null ? null : this.local(parts);
  }

  /** How far ahead of UTC this zone is right now, in minutes. */
  utcOffset(at: Date = new Date()): number {
    return zoneOffset(at, this.name);
  }

  /** The offset as `+01:00`, which is how it is written down. */
  formattedOffset(at: Date = new Date()): string {
    const minutes = this.utcOffset(at);
    const sign = minutes < 0 ? "-" : "+";
    const absolute = Math.abs(minutes);

    return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  }

  /**
   * Whether this zone is on summer time at a moment. Rails' `dst?`.
   *
   * Decided by comparing the offset now with the smallest offset this zone
   * uses across the year, rather than by a table of rules: the rules change,
   * governments move the dates, and the platform's own database is the thing
   * that gets updated when they do.
   */
  isDst(at: Date = new Date()): boolean {
    return this.utcOffset(at) > this.#standardOffset(at);
  }

  /** The offset this zone keeps when it is not on summer time. */
  #standardOffset(at: Date): number {
    const year = partsInZone(at, this.name).year;
    let smallest = Number.POSITIVE_INFINITY;

    // Month by month rather than day by day: a zone's offset changes at most
    // a couple of times a year, and twelve samples find the lower of the two
    // wherever in the year the change falls. The southern hemisphere is why
    // this cannot just look at January.
    for (let month = 0; month < 12; month += 1) {
      smallest = Math.min(smallest, zoneOffset(new Date(Date.UTC(year, month, 15)), this.name));
    }

    return smallest;
  }

  /** The zone reads as its identifier, which is what gets stored. */
  toString(): string {
    return this.name;
  }

  toJSON(): string {
    return this.name;
  }

  equals(other: TimeZone): boolean {
    return this.name === other.name;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `Z`, `+01:00`, `-0500` — anything that already pins the string to an instant. */
function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

/** `2026-06-01`, `2026-06-01 09:00`, `2026-06-01T09:00:00`. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

function parseWallClock(value: string): ZonedParts | null {
  const match = WALL_CLOCK.exec(value);

  if (match === null) return null;

  const [, year, month, day, hour, minute, second] = match;
  const parts: ZonedParts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
  };

  // Checked rather than left to roll over: `Date.UTC` turns 31 February into
  // 3 March without complaint, so a typo becomes a real date three days off
  // instead of an error somebody can see.
  if (parts.month < 1 || parts.month > 12) return null;
  if (parts.day < 1 || parts.day > 31) return null;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;

  const rolled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

  if (rolled.getUTCMonth() !== parts.month - 1 || rolled.getUTCDate() !== parts.day) return null;

  return parts;
}
