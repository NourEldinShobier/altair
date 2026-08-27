/**
 * Writing a time down, ported from ActiveSupport's `Time` and `DateTime`
 * conversions.
 *
 * Each of these is a wire format somebody else defined, and each has a reason
 * to exist that the others do not cover: a cookie needs `httpdate`, an Atom
 * feed needs `xmlschema`, an email needs `rfc2822`, and a log wants something
 * a person can read.
 *
 * `toISOString` covers one of the five. The rest are why this file exists.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/**
 * The format an HTTP header uses. Rails' `httpdate`.
 *
 * Always GMT and always this spelling — a `Set-Cookie` expiry in any other
 * format is ignored by some browsers and honoured by others, which is a bug
 * that reproduces on one machine in four.
 */
export function httpDate(date: Date): string {
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`
  );
}

/** The format an email header uses. Rails' `rfc2822`. */
export function rfc2822(date: Date): string {
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** What XML and Atom call a timestamp. Rails' `xmlschema`, and ISO 8601. */
export function xmlschema(date: Date, fractionDigits = 0): string {
  return fractionDigits > 0
    ? date
        .toISOString()
        .replace(/\.\d{3}Z$/, `.${pad(date.getUTCMilliseconds(), 3).slice(0, fractionDigits)}Z`)
    : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Rails' `rfc3339`, which is `xmlschema` under the name the RFC uses. */
export const rfc3339 = xmlschema;

/** Rails' `iso8601`, the same again. */
export const iso8601 = xmlschema;

/**
 * A time written the way a person reads one. Rails' `to_fs(:db)` and friends.
 *
 * The database format specifically, because that is the one people paste into
 * a query and the one a log line should match.
 */
export function toDbFormat(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** Seconds since the epoch, which is what most other systems want. */
export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * An offset written as `+01:00`. Rails' `formatted_offset`.
 *
 * The sign is taken from the offset rather than from `getTimezoneOffset`,
 * which counts backwards — it answers -60 for UTC+1, and copying that number
 * straight into a string is how a timestamp ends up an hour and a half wrong
 * in the other direction.
 */
export function formattedOffset(minutesBehindUtc: number, colon = true): string {
  const ahead = -minutesBehindUtc;
  const sign = ahead < 0 ? "-" : "+";
  const total = Math.abs(ahead);

  return `${sign}${pad(Math.floor(total / 60))}${colon ? ":" : ""}${pad(total % 60)}`;
}

/**
 * The subset of `strftime` worth having.
 *
 * Not all of it: the rest is a compatibility surface nobody in TypeScript
 * asked for, and `Intl.DateTimeFormat` does the locale-aware work far better.
 * These are the directives a log line and a filename need.
 */
export function strftime(date: Date, format: string): string {
  const parts: Record<string, string> = {
    Y: String(date.getUTCFullYear()),
    m: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    H: pad(date.getUTCHours()),
    M: pad(date.getUTCMinutes()),
    S: pad(date.getUTCSeconds()),
    L: pad(date.getUTCMilliseconds(), 3),
    a: DAYS[date.getUTCDay()] as string,
    b: MONTHS[date.getUTCMonth()] as string,
    j: pad(dayOfYear(date), 3),
    s: String(toEpochSeconds(date)),
    "%": "%",
  };

  return format.replace(/%(.)/g, (whole, directive: string) => parts[directive] ?? whole);
}

/** Which day of the year it is, 1 through 366. */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const here = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  return Math.floor((here - start) / 86_400_000) + 1;
}
