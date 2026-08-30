/**
 * The date format HTTP headers use, ported from `Time#httpdate` and
 * `Time.httpdate`.
 *
 * There is one format a server may send and three it must accept, and that
 * asymmetry is the whole reason this file exists. `Last-Modified`, `Expires`
 * and `Date` go out as RFC 1123 — `Thu, 01 Jan 2026 12:00:00 GMT` — and
 * `new Date().toUTCString()` happens to produce exactly that.
 *
 * Reading is where it stops being free. `If-Modified-Since` may arrive in any
 * of three formats, two of them obsolete since 1999 and both still emitted by
 * proxies and by things pretending to be browsers:
 *
 *   - RFC 1123: `Thu, 01 Jan 2026 12:00:00 GMT`
 *   - RFC 850:  `Thursday, 01-Jan-26 12:00:00 GMT`
 *   - asctime:  `Thu Jan  1 12:00:00 2026`
 *
 * `new Date(header)` reads the first, is inconsistent across runtimes on the
 * second, and the failure is silent: an unparseable header reads as "no date",
 * the response is served in full, and the only symptom is a cache that never
 * hits for one class of client. Nobody finds that by looking.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * A date as a header should carry it. Rails' `httpdate`.
 *
 * Built rather than delegated to `toUTCString`, which is specified to produce
 * this but has produced `GMT+0000` and a two-digit year in runtimes people
 * still run — and a header a cache cannot parse is a cache that does not work,
 * reported by nobody.
 */
export function httpdate(moment: Date = new Date()): string {
  const day = DAYS[moment.getUTCDay()] as string;
  const month = MONTHS[moment.getUTCMonth()] as string;

  return (
    // The year padded to four, which the format requires: a three-digit year
    // written bare produces a header no parser here or anywhere else accepts.
    `${day}, ${pad(moment.getUTCDate())} ${month} ${pad(moment.getUTCFullYear(), 4)} ` +
    `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())} GMT`
  );
}

const RFC_1123 =
  /^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/;

const RFC_850 = /^[A-Za-z]+day,\s+(\d{2})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/;

const ASCTIME = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

function monthIndex(name: string): number {
  return MONTHS.indexOf(name as (typeof MONTHS)[number]);
}

/**
 * Reads any of the three formats. Rails' `Time.httpdate`, widened.
 *
 * Null rather than an invalid Date, so a caller cannot accidentally compare
 * against `NaN` and get `false` for every question it asks — which is how an
 * unparseable header turns into "not modified" instead of "I do not know".
 */
export function parseHttpDate(header: string | null | undefined): Date | null {
  if (header === null || header === undefined) return null;

  const value = header.trim();

  const modern = RFC_1123.exec(value);

  if (modern) {
    return utc(
      Number(modern[3]),
      monthIndex(modern[2] as string),
      Number(modern[1]),
      modern.slice(4),
    );
  }

  const obsolete = RFC_850.exec(value);

  if (obsolete) {
    // A two-digit year, which is why this format was obsoleted. The window is
    // the one every implementation uses: a year more than fifty ahead is read
    // as the previous century, since a cache validator dated in the future is
    // meaningless and one dated in the past is ordinary.
    const short = Number(obsolete[3]);
    const now = new Date().getUTCFullYear();
    const century = Math.floor(now / 100) * 100;
    const candidate = century + short;
    const year = candidate > now + 50 ? candidate - 100 : candidate;

    return utc(year, monthIndex(obsolete[2] as string), Number(obsolete[1]), obsolete.slice(4));
  }

  const ancient = ASCTIME.exec(value);

  if (ancient) {
    return utc(
      Number(ancient[6]),
      monthIndex(ancient[1] as string),
      Number(ancient[2]),
      ancient.slice(3, 6),
    );
  }

  return null;
}

function utc(year: number, month: number, day: number, time: (string | undefined)[]): Date | null {
  if (month === -1) return null;

  const [hour, minute, second] = time.map((one) => Number(one ?? 0));
  const moment = new Date(Date.UTC(year, month, day, hour ?? 0, minute ?? 0, second ?? 0));

  // Checked rather than trusted: `Date.UTC` turns 31 February into 3 March, so
  // a header with an impossible date would otherwise validate against a moment
  // three days from the one it named.
  if (moment.getUTCMonth() !== month || moment.getUTCDate() !== day) return null;

  return Number.isNaN(moment.getTime()) ? null : moment;
}

/**
 * Whether something modified at `lastModified` counts as unchanged since the
 * header's date.
 *
 * Compared at whole seconds, because that is all the format carries: a
 * resource modified 300 milliseconds after the header's second is not
 * modified as far as the wire is concerned, and comparing milliseconds makes
 * every such response a spurious 200.
 */
export function notModifiedSince(header: string | null | undefined, lastModified: Date): boolean {
  const since = parseHttpDate(header);

  if (since === null) return false;

  return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since.getTime() / 1000);
}
