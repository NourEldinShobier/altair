/**
 * Collecting rendered markup, and the form helpers that need to. Ported from
 * `ActionView::Helpers::CaptureHelper`, `TextHelper` and the remaining
 * `FormOptionsHelper` methods.
 *
 * Capturing is the awkward one, and it is awkward for a reason worth stating.
 * A helper that takes a block and renders it somewhere else — a layout, a
 * sidebar, a modal — has to collect what the block produced without writing it
 * where the block was called. In ERB that means swapping the buffer the
 * template appends to. Here a component returns its markup, so the swap is not
 * needed — but the *safety* problem it exists to solve is:
 *
 * Concatenating rendered output and raw text with `+` loses the distinction
 * between them. Markup that was escaped once gets escaped again and a user's
 * name renders as `O&amp;#39;Brien`; or worse, text that was never escaped is
 * appended to something marked safe and the whole thing is trusted. Every
 * concatenation here therefore says which of the two it is dealing with.
 *
 * The form helpers are here because they are the ones that build markup from
 * values rather than from a component tree, so they are where the same
 * question keeps arising.
 */

import { RawHtml, escapeHtml, raw, renderToString } from "./render.js";
import type { Node } from "./render.js";

/** Whether a value is already known to be markup. Rails' `html_safe?`. */
export function htmlSafe(value: unknown): value is RawHtml {
  return value instanceof RawHtml;
}

/** The same question, named as Rails' view helper spells it. */
export function xssSafe(value: unknown): boolean {
  return htmlSafe(value);
}

/**
 * Joins two pieces of output, escaping whichever is not already markup.
 * Rails' `safe_concat`.
 *
 * The escaping decision is per operand rather than for the result, which is
 * the only way to get it right: one side is usually rendered markup and the
 * other usually a value somebody typed.
 */
export function safeConcat(...parts: readonly unknown[]): RawHtml {
  return raw(
    parts.map((part) => (htmlSafe(part) ? part.value : escapeHtml(String(part)))).join(""),
  );
}

/**
 * Joins them without escaping anything. Rails' `concat` on a safe buffer.
 *
 * Every part is asserted to be markup already; a plain string here is a
 * mistake the caller can see rather than an escape that silently did not
 * happen.
 */
export class UnsafeConcat extends Error {
  constructor(value: unknown) {
    super(
      `concat was given a plain string (${JSON.stringify(String(value).slice(0, 40))}). ` +
        `Use safeConcat, which escapes it, or mark it with raw() if it really is markup.`,
    );
    this.name = "UnsafeConcat";
  }
}

export function concat(...parts: readonly unknown[]): RawHtml {
  for (const part of parts) {
    if (!htmlSafe(part)) throw new UnsafeConcat(part);
  }

  return raw(parts.map((part) => (part as RawHtml).value).join(""));
}

/** Appends one expression's output to a buffer. Rails' `safe_expr_append=`. */
export function safeExprAppend(buffer: RawHtml, value: unknown): RawHtml {
  return safeConcat(buffer, value);
}

/**
 * Renders something and hands back its markup rather than writing it out.
 * Rails' `capture`.
 */
export async function capture(node: Node): Promise<RawHtml> {
  return raw(await renderToString(node));
}

/**
 * Collects everything rendered inside a block. Rails' `with_output_buffer`.
 *
 * Kept as an explicit collector rather than a swapped global, because a global
 * that a component forgets to restore silently sends the next component's
 * output somewhere else — and that failure appears as missing markup on an
 * unrelated page.
 */
export class OutputBuffer {
  #parts: string[] = [];

  append(value: unknown): this {
    this.#parts.push(htmlSafe(value) ? value.value : escapeHtml(String(value)));

    return this;
  }

  /** Appends markup that is already known to be safe. */
  appendRaw(markup: string): this {
    this.#parts.push(markup);

    return this;
  }

  get length(): number {
    return this.#parts.length;
  }

  toHtml(): RawHtml {
    return raw(this.#parts.join(""));
  }
}

export async function withOutputBuffer(
  body: (buffer: OutputBuffer) => Promise<void> | void,
): Promise<RawHtml> {
  const buffer = new OutputBuffer();

  await body(buffer);

  return buffer.toHtml();
}

/**
 * Drops the newlines a template leaves at its end. Rails'
 * `strip_trailing_newlines`.
 *
 * Only trailing ones, and only newlines. Trimming whitespace generally would
 * change `<pre>` and would remove the single space between two inline elements
 * that a designer put there on purpose.
 */
export function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, "");
}

/**
 * A number to a fixed number of decimal places. Rails' `number_with_precision`.
 *
 * Rounds rather than truncates, and keeps trailing zeros unless told not to: a
 * price shown as `10.5` where every other row shows `10.50` reads as a
 * different kind of number.
 */
export function numberWithPrecision(
  value: number,
  options: { precision?: number; stripInsignificantZeros?: boolean; separator?: string } = {},
): string {
  const precision = options.precision ?? 3;
  const fixed = value.toFixed(precision);
  const separator = options.separator ?? ".";

  const stripped =
    options.stripInsignificantZeros === true && fixed.includes(".")
      ? fixed.replace(/0+$/, "").replace(/\.$/, "")
      : fixed;

  return separator === "." ? stripped : stripped.replace(".", separator);
}

/**
 * One or many, so a duration does not read as "about 1 years".
 *
 * Only the exact count matters — this is a rounded number of whole units, so
 * there is no fractional case to think about.
 */
function plural(count: number, unit: string): string {
  return count === 1 ? unit : `${unit}s`;
}

/** How long ago something was, in words. Rails' `time_ago_in_words`. */
export function relativeTimeInWords(from: Date, to: Date = new Date()): string {
  const seconds = Math.round(Math.abs(to.getTime() - from.getTime()) / 1000);
  const minutes = Math.round(seconds / 60);

  if (seconds < 45) return "less than a minute";
  if (seconds < 90) return "1 minute";
  if (minutes < 45) return `${String(minutes)} ${plural(minutes, "minute")}`;
  if (minutes < 90) return "about 1 hour";

  const hours = Math.round(minutes / 60);

  if (minutes < 1440) return `about ${String(hours)} ${plural(hours, "hour")}`;
  if (minutes < 2520) return "1 day";

  const days = Math.round(minutes / 1440);

  if (minutes < 43_200) return `${String(days)} ${plural(days, "day")}`;
  if (minutes < 86_400) return "about 1 month";

  const months = Math.round(minutes / 43_200);

  if (minutes < 525_600) return `${String(months)} ${plural(months, "month")}`;

  const years = Math.round(minutes / 525_600);

  return `about ${String(years)} ${plural(years, "year")}`;
}

/** What kind of input a select should be. Rails' `select_type`. */
export function selectType(multiple: boolean, size?: number): "select-one" | "select-multiple" {
  return multiple || (size !== undefined && size > 1) ? "select-multiple" : "select-one";
}

/**
 * Whether an option is the chosen one. Rails' `input_checked?`.
 *
 * Compared as strings, because a form posts strings: a select whose values are
 * database ids sends `"7"` and the record holds `7`, and comparing them
 * strictly means nothing is ever selected on a re-render.
 */
export function inputChecked(value: unknown, selected: unknown): boolean {
  if (selected === undefined || selected === null) return false;

  if (Array.isArray(selected)) return selected.some((each) => String(each) === String(value));

  return String(selected) === String(value);
}

/** The current value of a field, from a record or from what was submitted. */
export function currentValue(
  record: Record<string, unknown> | undefined,
  attribute: string,
  submitted?: unknown,
): unknown {
  return submitted ?? record?.[attribute];
}

/**
 * The hidden field a multiple-select needs. Rails' `emitted_hidden_id?`.
 *
 * A multiple select that has nothing selected posts *nothing at all* — the
 * parameter is simply absent — so a form that clears every checkbox looks
 * identical to one that never had the field. The empty hidden value is what
 * makes "none" distinguishable from "not submitted".
 */
export function emittedHiddenId(name: string, multiple: boolean): Node {
  if (!multiple) return null;

  return <input type="hidden" name={name} value="" />;
}

/** Whether a form has to be multipart. Rails' `multipart`. */
export function multipart(fields: readonly { type?: string }[]): boolean {
  return fields.some((field) => field.type === "file");
}

/**
 * The options a `form_for` implies. Rails' `apply_form_for_options!`.
 *
 * A persisted record posts a PATCH to its own URL and a new one a POST to the
 * collection. Getting this from the record rather than from the caller is what
 * makes one partial serve both — and a form that posts a create to an update
 * route is a 404 the user sees.
 */
export function applyFormForOptions(
  record: { isNewRecord?: boolean; id?: unknown },
  collectionPath: string,
  options: { url?: string; method?: string } = {},
): { url: string; method: string } {
  const isNew = record.isNewRecord !== false;

  return {
    url: options.url ?? (isNew ? collectionPath : `${collectionPath}/${String(record.id)}`),
    method: options.method ?? (isNew ? "post" : "patch"),
  };
}

/** A datalist of suggestions for a text field. */
export function datalist(id: string, values: readonly (string | number)[]): Node {
  return (
    <datalist id={id}>
      {values.map((value) => (
        <option value={String(value)} />
      ))}
    </datalist>
  );
}

/** Options built from records, each labelled and valued by name. Rails' `from_collection`. */
export function fromCollection<T extends Record<string, unknown>>(
  records: readonly T[],
  valueAttribute: string,
  labelAttribute: string,
): [label: string, value: unknown][] {
  return records.map((record) => [String(record[labelAttribute]), record[valueAttribute]]);
}

/** A select of weekdays. Rails' `weekday_select`. */
export const WEEKDAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function weekdaySelect(
  name: string,
  options: { selected?: unknown; beginningOfWeek?: number } = {},
): Node {
  const start = options.beginningOfWeek ?? 1;
  const ordered = [...WEEKDAYS.slice(start), ...WEEKDAYS.slice(0, start)];

  return (
    <select name={name}>
      {ordered.map((day) => (
        <option
          value={String(WEEKDAYS.indexOf(day))}
          {...(inputChecked(WEEKDAYS.indexOf(day), options.selected) ? { selected: true } : {})}
        >
          {day}
        </option>
      ))}
    </select>
  );
}

/** A select whose options are grouped by a parent record. Rails' `grouped_collection_select`. */
export function groupedCollectionSelect<G extends Record<string, unknown>>(
  name: string,
  groups: readonly G[],
  groupLabel: string,
  childrenOf: (group: G) => readonly Record<string, unknown>[],
  valueAttribute: string,
  labelAttribute: string,
  selected?: unknown,
): Node {
  return (
    <select name={name}>
      {groups.map((group) => (
        <optgroup label={String(group[groupLabel])}>
          {childrenOf(group).map((child) => (
            <option
              value={String(child[valueAttribute])}
              {...(inputChecked(child[valueAttribute], selected) ? { selected: true } : {})}
            >
              {String(child[labelAttribute])}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
