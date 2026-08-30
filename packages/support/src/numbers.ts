/**
 * The number formatters ActiveSupport ships that the view helpers do not
 * already cover, ported from `ActiveSupport::NumberHelper`.
 *
 * These live here rather than in the view package because a number is
 * formatted in more places than a page — a CSV export, a log line, a plain
 * text email — and a helper reachable only from a template ends up
 * reimplemented in each of them, slightly differently.
 */

export interface DelimitedOptions {
  /** Between groups of three. */
  delimiter?: string;
  /** Before the fraction. */
  separator?: string;
  /**
   * Which digits to group.
   *
   * Rails takes a pattern because grouping is not universal: the Indian system
   * groups the first three then twos — 1,00,00,000 — so a formatter that
   * assumed threes is wrong for a fifth of the world.
   */
  pattern?: RegExp;
}

const THREES = /(\d)(?=(\d{3})+(?!\d))/g;

/**
 * Groups the digits. Rails' `number_to_delimited`.
 *
 *     numberToDelimited(1234567.89)   // "1,234,567.89"
 *
 * Only the whole part is grouped. Grouping the fraction as well produces
 * "1,234.567,89", which is a real format in some locales and never the one
 * anybody meant here.
 */
export function numberToDelimited(
  value: number | string,
  { delimiter = ",", separator = ".", pattern = THREES }: DelimitedOptions = {},
): string {
  const text = String(value);
  const negative = text.startsWith("-");
  const [whole = "", fraction] = text.replace("-", "").split(".");

  const grouped = whole.replace(pattern, `$1${delimiter}`);
  const sign = negative ? "-" : "";

  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}${separator}${fraction}`;
}

export interface RoundedOptions {
  /** How many digits after the point, or of significance. */
  precision?: number;
  /** Count significant digits rather than decimal places. */
  significant?: boolean;
  /** Keep trailing zeros. Rails' `strip_insignificant_zeros` inverted. */
  stripInsignificantZeros?: boolean;
  separator?: string;
  delimiter?: string;
}

/**
 * Rounds to a fixed number of digits. Rails' `number_to_rounded`.
 *
 * Trailing zeros are kept by default, and that is deliberate: `2.50` and `2.5`
 * are the same number and different claims about precision. A price list
 * showing one row as 2.5 and the next as 2.50 looks like a bug in the data
 * rather than a formatter being clever.
 *
 * `significant` counts from the first non-zero digit instead, which is what a
 * measurement wants — three significant digits of 0.00123 is 0.00123, not 0.001.
 */
export function numberToRounded(
  value: number | string,
  {
    precision = 3,
    significant = false,
    stripInsignificantZeros = false,
    separator = ".",
    delimiter = "",
  }: RoundedOptions = {},
): string {
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);

  let text: string;

  if (significant) {
    text = precision > 0 ? number.toPrecision(precision) : String(number);
    // toPrecision reaches for exponential notation on large and small numbers,
    // which is never what a formatted figure wants on a page.
    if (text.includes("e")) text = String(Number(text));
  } else {
    text = number.toFixed(precision);
  }

  if (stripInsignificantZeros && text.includes(".")) {
    text = text.replace(/\.?0+$/, "");
  }

  const [whole = "", fraction] = text.split(".");
  const grouped = delimiter ? whole.replace(THREES, `$1${delimiter}`) : whole;

  return fraction === undefined ? grouped : `${grouped}${separator}${fraction}`;
}

/**
 * Whether a number divides evenly. Rails' `multiple_of?`.
 *
 * Uses a remainder against a tolerance rather than `%` alone, because `0.3 % 0.1`
 * is 0.09999999999999998 in binary floating point and the obvious check says
 * no for a number that plainly is a multiple.
 */
export function isMultipleOf(value: number, factor: number, tolerance = 1e-9): boolean {
  if (factor === 0) return value === 0;

  const remainder = Math.abs(value % factor);

  return remainder < tolerance || Math.abs(remainder - Math.abs(factor)) < tolerance;
}

/** How many digits a whole number has. Rails' `digit_count`. */
export function digitCount(value: number): number {
  const absolute = Math.abs(Math.trunc(value));

  return absolute === 0 ? 1 : Math.floor(Math.log10(absolute)) + 1;
}

/** Clamps a number into a range, which is the guard every slider needs. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
