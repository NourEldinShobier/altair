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

import { pluralize as pluralizeWord } from "@altair/support";

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
