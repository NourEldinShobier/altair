/**
 * View helpers, ported from `ActionView::Helpers`.
 *
 * Rails needs 13,926 lines of these because ERB has no imports: every helper
 * has to be a method mixed into one enormous object, and a name collision
 * between two of them is a real hazard. TSX has imports, so what survives is
 * the small set that is genuinely about formatting, and each one is a function
 * you can import, rename, or ignore.
 *
 * The formatting goes through `Intl`, which the runtime already carries, so
 * there is no locale data to ship and no table of currency symbols to keep up
 * to date.
 */

import { pluralize as pluralizeWord, t } from "@altair/support";

export interface NumberOptions {
  locale?: string;
  precision?: number;
}

/** Rails' `number_to_currency`. */
export function numberToCurrency(
  value: number | string,
  options: NumberOptions & { currency?: string } = {},
): string {
  return new Intl.NumberFormat(options.locale, {
    style: "currency",
    currency: options.currency ?? "USD",
    ...(options.precision === undefined
      ? {}
      : { minimumFractionDigits: options.precision, maximumFractionDigits: options.precision }),
  }).format(Number(value));
}

/** Rails' `number_with_delimiter`: 1234567 becomes 1,234,567. */
export function numberWithDelimiter(value: number | string, options: NumberOptions = {}): string {
  const precision = options.precision;

  return new Intl.NumberFormat(
    options.locale,
    precision === undefined
      ? undefined
      : { minimumFractionDigits: precision, maximumFractionDigits: precision },
  ).format(Number(value));
}

/** Rails' `number_to_percentage`. */
export function numberToPercentage(value: number | string, options: NumberOptions = {}): string {
  const precision = options.precision ?? 3;

  return new Intl.NumberFormat(options.locale, {
    style: "percent",
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
    // Rails takes 65.4 to mean 65.4%, where Intl takes a fraction.
  }).format(Number(value) / 100);
}

/** Rails' `number_to_human`: 1234 becomes 1.23 thousand. */
export function numberToHuman(value: number | string, options: NumberOptions = {}): string {
  return new Intl.NumberFormat(options.locale, {
    notation: "compact",
    compactDisplay: "long",
    maximumFractionDigits: options.precision ?? 2,
  }).format(Number(value));
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Rails' `number_to_human_size`: 1536 becomes 1.5 KB. */
export function numberToHumanSize(bytes: number, options: NumberOptions = {}): string {
  let size = Math.abs(Number(bytes));
  let unit = 0;

  // Rails counts in 1024s, so a "KB" here is a kibibyte, as it is on disk.
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const precision = options.precision ?? (unit === 0 ? 0 : 1);
  const rendered = new Intl.NumberFormat(options.locale, {
    maximumFractionDigits: precision,
  }).format(size);

  return `${bytes < 0 ? "-" : ""}${rendered} ${UNITS[unit]}`;
}

export interface TruncateOptions {
  length?: number;
  omission?: string;
  /** Cuts at the last word boundary before the limit, as Rails' `separator`. */
  separator?: string;
}

/**
 * Rails' `truncate`.
 *
 * The omission counts toward the length, so the result is never longer than
 * asked for — which is the whole reason to truncate.
 */
export function truncate(text: string, options: TruncateOptions = {}): string {
  const length = options.length ?? 30;
  const omission = options.omission ?? "...";

  if (text.length <= length) return text;

  const room = Math.max(0, length - omission.length);
  let cut = text.slice(0, room);

  if (options.separator) {
    const boundary = cut.lastIndexOf(options.separator);
    if (boundary > 0) cut = cut.slice(0, boundary);
  }

  return `${cut}${omission}`;
}

/**
 * Rails' view `pluralize`: "1 post", "2 posts".
 *
 * The count is part of the output, which is the difference between this and
 * the inflector's `pluralize`.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? pluralizeWord(singular));
  return `${count} ${word}`;
}

export interface DateOptions {
  locale?: string;
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
  timeZone?: string;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Rails' `l(date)`, through Intl rather than a table of formats. */
export function formatDate(value: Date | string | number, options: DateOptions = {}): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: options.dateStyle ?? "medium",
    ...(options.timeStyle ? { timeStyle: options.timeStyle } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

const DIVISIONS = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
] as const;

/**
 * Rails' `time_ago_in_words`, as "3 days ago".
 *
 * `Intl.RelativeTimeFormat` does the wording, so every language the runtime
 * knows is covered without a translation file.
 */
export function timeAgo(
  value: Date | string | number,
  options: { locale?: string; now?: Date } = {},
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const formatter = new Intl.RelativeTimeFormat(options.locale, { numeric: "auto" });
  let delta = (date.getTime() - (options.now ?? new Date()).getTime()) / 1000;

  for (const division of DIVISIONS) {
    if (Math.abs(delta) < division.amount) {
      return formatter.format(Math.round(delta), division.unit);
    }
    delta /= division.amount;
  }

  return formatter.format(Math.round(delta), "year");
}

const MINUTES_IN_YEAR = 525_600;
const MINUTES_IN_QUARTER_YEAR = 131_400;
const MINUTES_IN_THREE_QUARTERS_YEAR = 394_200;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export interface DistanceOptions {
  /**
   * Words the first minute, rather than calling all of it "less than a
   * minute". Rails' `include_seconds`.
   */
  includeSeconds?: boolean;
  locale?: string;
}

/**
 * Rails' `distance_of_time_in_words`, thresholds and all.
 *
 * How long something took, rather than how long ago it was — which is why it
 * says "about 1 hour" and not "an hour ago", and why it is not `timeAgo`.
 *
 * The thresholds are deliberately Rails' own and deliberately fuzzy: 45 minutes
 * is "about 1 hour", and the year branch subtracts a day per leap year so that
 * two dates a calendar year apart do not word as "over 1 year". Reproducing
 * them exactly is the point — the wording is a Rails convention and an
 * application that has one of these in a template has it in a test too.
 */
export function distanceOfTimeInWords(
  from: Date | string | number,
  to: Date | string | number = new Date(),
  options: DistanceOptions = {},
): string {
  const first = toDate(from);
  const second = toDate(to);

  // Rails raises on a nil, and so does this on anything that is not a date.
  // Without it a bad value falls past every threshold — `NaN < 45` is false —
  // and comes out of the year branch as "about NaN years".
  for (const [name, date] of [
    ["from", first],
    ["to", second],
  ] as const) {
    if (Number.isNaN(date.getTime())) {
      throw new TypeError(`distanceOfTimeInWords was given a \`${name}\` that is not a date`);
    }
  }

  // Rails sorts the pair, so the distance is a length rather than a direction.
  const [earlier, later] = first <= second ? [first, second] : [second, first];

  const distanceInSeconds = Math.round((later.getTime() - earlier.getTime()) / 1000);
  const minutes = Math.round(distanceInSeconds / 60);

  const say = (key: string, count?: number): string =>
    t(key, { scope: "datetime.distance_in_words", count, locale: options.locale });

  if (minutes <= 1) {
    if (!options.includeSeconds) {
      return minutes === 0 ? say("less_than_x_minutes", 1) : say("x_minutes", 1);
    }

    if (distanceInSeconds < 5) return say("less_than_x_seconds", 5);
    if (distanceInSeconds < 10) return say("less_than_x_seconds", 10);
    if (distanceInSeconds < 20) return say("less_than_x_seconds", 20);
    if (distanceInSeconds < 40) return say("half_a_minute");
    if (distanceInSeconds < 60) return say("less_than_x_minutes", 1);

    return say("x_minutes", 1);
  }

  if (minutes < 45) return say("x_minutes", minutes);
  if (minutes < 90) return say("about_x_hours", 1);
  if (minutes < 1440) return say("about_x_hours", Math.round(minutes / 60));
  if (minutes < 2520) return say("x_days", 1);
  if (minutes < 43_200) return say("x_days", Math.round(minutes / 1440));
  if (minutes < 86_400) return say("about_x_months", Math.round(minutes / 43_200));
  if (minutes < MINUTES_IN_YEAR) return say("x_months", Math.round(minutes / 43_200));

  // A year is 525,600 minutes only when it has 365 days. Without this, any
  // span crossing a leap day words as one notch longer than a person would
  // call it — "over 1 year" for two birthdays in a row.
  let fromYear = earlier.getFullYear();
  if (earlier.getMonth() >= 2) fromYear += 1;

  let toYear = later.getFullYear();
  if (later.getMonth() < 2) toYear -= 1;

  let leapYears = 0;
  for (let year = fromYear; year <= toYear; year += 1) {
    if (isLeapYear(year)) leapYears += 1;
  }

  const offsetMinutes = minutes - leapYears * 1440;
  const remainder = offsetMinutes % MINUTES_IN_YEAR;
  const years = Math.floor(offsetMinutes / MINUTES_IN_YEAR);

  if (remainder < MINUTES_IN_QUARTER_YEAR) return say("about_x_years", years);
  if (remainder < MINUTES_IN_THREE_QUARTERS_YEAR) return say("over_x_years", years);

  return say("almost_x_years", years + 1);
}

/**
 * Rails' `time_ago_in_words` — the distance from then until now, with no "ago".
 *
 * `timeAgo` is the other one, and says "3 days ago" through `Intl`. This says
 * "3 days", in Rails' wording, from the translation catalogue. Both are here
 * because they answer different questions and Rails ships both spellings.
 */
export function timeAgoInWords(
  from: Date | string | number,
  options: DistanceOptions = {},
): string {
  return distanceOfTimeInWords(from, new Date(), options);
}
