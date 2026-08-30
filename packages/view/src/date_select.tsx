/**
 * Multi-part date and time selects, ported from
 * `ActionView::Helpers::DateHelper`.
 *
 *     dateSelect("post", "published_on", { startYear: 2020 })
 *     // three selects posting published_on(1i), (2i) and (3i)
 *
 * A single `<input type="date">` is better wherever it works, and this is not
 * trying to replace it. What it is for is the cases the native control cannot
 * express: a year on its own, a month and year with no day, a birthday whose
 * range runs a century back, a form that has to look identical in every
 * browser. Rails still ships these for the same reason.
 *
 * The interesting half is on the server. Three selects cannot post one value,
 * so each posts its own part under Rails' `(1i)` suffix convention and the
 * parts are reassembled on the way in — which is what
 * [multiparameter.ts](./multiparameter.ts) does.
 */

import { escapeHtml as escape, RawHtml, type Node } from "./render.js";
import { fieldId, fieldName } from "./form.js";

/** Which part of a date a select stands for, in Rails' order. */
export type DatePart = "year" | "month" | "day" | "hour" | "minute" | "second";

/** Rails numbers the parts from one, largest first. */
const PART_INDEX: Record<DatePart, number> = {
  year: 1,
  month: 2,
  day: 3,
  hour: 4,
  minute: 5,
  second: 6,
};

export interface DateSelectOptions {
  /** Earliest year offered. Defaults to five years back. */
  startYear?: number;
  /** Latest year offered. Defaults to five years on. */
  endYear?: number;
  /** An empty first option, for "not chosen yet". */
  includeBlank?: boolean;
  /** Month names rather than numbers. */
  useMonthNames?: readonly string[];
  /** Two-digit numbers rather than bare ones — 01 rather than 1. */
  padded?: boolean;
  /** Which parts to render, and in which order. */
  order?: readonly DatePart[];
  disabled?: boolean;
  /** What the field is called on the record, when it differs from the scope. */
  prefix?: string;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The name one part posts under. Rails' `(1i)` convention.
 *
 * The suffix is what lets three inputs describe one attribute: without it the
 * three would each claim `published_on` and the last one posted would win,
 * which is a form that silently records the day as the whole date.
 */
export function multiparameterName(
  scope: string | undefined,
  attribute: string,
  part: DatePart,
): string {
  return `${fieldName(scope, attribute)}(${PART_INDEX[part]}i)`;
}

function options(
  values: readonly (readonly [value: number, label: string])[],
  selected: number | undefined,
  includeBlank: boolean,
): string {
  const blank = includeBlank ? `<option value=""></option>` : "";

  return (
    blank +
    values
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === selected ? " selected" : ""}>${escape(label)}</option>`,
      )
      .join("")
  );
}

function selectTag(
  name: string,
  id: string,
  inner: string,
  disabled: boolean | undefined,
): RawHtml {
  return new RawHtml(
    `<select name="${escape(name)}" id="${escape(id)}"${disabled ? " disabled" : ""}>${inner}</select>`,
  );
}

function range(from: number, to: number, padded: boolean): (readonly [number, string])[] {
  const step = from <= to ? 1 : -1;
  const values: (readonly [number, string])[] = [];

  for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
    values.push([value, padded ? String(value).padStart(2, "0") : String(value)]);
  }

  return values;
}

function partSelect(
  scope: string | undefined,
  attribute: string,
  part: DatePart,
  values: (readonly [number, string])[],
  selected: number | undefined,
  config: DateSelectOptions,
): RawHtml {
  return selectTag(
    multiparameterName(scope, attribute, part),
    `${fieldId(scope, attribute)}_${PART_INDEX[part]}i`,
    options(values, selected, config.includeBlank ?? false),
    config.disabled,
  );
}

/**
 * A year select. Rails' `select_year`.
 *
 * The range runs backwards when the start is later than the end, which is not
 * a quirk — a birthday form wants the current year first and 1920 last, and
 * reversing the list at the call site is how the selected value ends up
 * compared against the wrong end.
 */
export function selectYear(
  scope: string | undefined,
  attribute: string,
  selected?: number,
  config: DateSelectOptions = {},
): Node {
  const thisYear = new Date().getUTCFullYear();
  const from = config.startYear ?? thisYear - 5;
  const to = config.endYear ?? thisYear + 5;

  return partSelect(scope, attribute, "year", range(from, to, false), selected, config);
}

/** A month select, by name or by number. Rails' `select_month`. */
export function selectMonth(
  scope: string | undefined,
  attribute: string,
  selected?: number,
  config: DateSelectOptions = {},
): Node {
  const names = config.useMonthNames ?? MONTH_NAMES;
  const values = names.map((name, index) => [index + 1, name] as const);

  return partSelect(
    scope,
    attribute,
    "month",
    config.useMonthNames === undefined && config.padded ? range(1, 12, true) : values,
    selected,
    config,
  );
}

/** A day select. Rails' `select_day`. */
export function selectDay(
  scope: string | undefined,
  attribute: string,
  selected?: number,
  config: DateSelectOptions = {},
): Node {
  return partSelect(
    scope,
    attribute,
    "day",
    range(1, 31, config.padded ?? false),
    selected,
    config,
  );
}

/** An hour select, 00 to 23. Rails' `select_hour`. */
export function selectHour(
  scope: string | undefined,
  attribute: string,
  selected?: number,
  config: DateSelectOptions = {},
): Node {
  return partSelect(
    scope,
    attribute,
    "hour",
    range(0, 23, config.padded ?? true),
    selected,
    config,
  );
}

/** A minute select. Rails' `select_minute`. */
export function selectMinute(
  scope: string | undefined,
  attribute: string,
  selected?: number,
  config: DateSelectOptions = {},
): Node {
  return partSelect(
    scope,
    attribute,
    "minute",
    range(0, 59, config.padded ?? true),
    selected,
    config,
  );
}

/** A second select. Rails' `select_second`. */
export function selectSecond(
  scope: string | undefined,
  attribute: string,
  selected?: number,
  config: DateSelectOptions = {},
): Node {
  return partSelect(
    scope,
    attribute,
    "second",
    range(0, 59, config.padded ?? true),
    selected,
    config,
  );
}

function joined(parts: readonly Node[]): Node {
  return new RawHtml(parts.map((one) => (one as RawHtml).value).join("\n"));
}

/** The parts of a date, in the order they should be rendered. */
const DATE_ORDER: readonly DatePart[] = ["year", "month", "day"];
const TIME_ORDER: readonly DatePart[] = ["hour", "minute"];

function partsOf(value: Date | undefined): Record<DatePart, number | undefined> {
  if (!value) {
    return {
      year: undefined,
      month: undefined,
      day: undefined,
      hour: undefined,
      minute: undefined,
      second: undefined,
    };
  }

  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
    second: value.getUTCSeconds(),
  };
}

const BUILDERS: Record<
  DatePart,
  (
    scope: string | undefined,
    attribute: string,
    selected: number | undefined,
    config: DateSelectOptions,
  ) => Node
> = {
  year: selectYear,
  month: selectMonth,
  day: selectDay,
  hour: selectHour,
  minute: selectMinute,
  second: selectSecond,
};

function build(
  order: readonly DatePart[],
  scope: string | undefined,
  attribute: string,
  value: Date | undefined,
  config: DateSelectOptions,
): Node {
  const parts = partsOf(value);

  return joined(
    (config.order ?? order).map((part) => BUILDERS[part](scope, attribute, parts[part], config)),
  );
}

/** Year, month and day. Rails' `date_select`. */
export function dateSelect(
  scope: string | undefined,
  attribute: string,
  value?: Date,
  config: DateSelectOptions = {},
): Node {
  return build(DATE_ORDER, scope, attribute, value, config);
}

/** Hour and minute. Rails' `time_select`. */
export function timeSelect(
  scope: string | undefined,
  attribute: string,
  value?: Date,
  config: DateSelectOptions = {},
): Node {
  return build(TIME_ORDER, scope, attribute, value, config);
}

/** All five. Rails' `datetime_select`. */
export function datetimeSelect(
  scope: string | undefined,
  attribute: string,
  value?: Date,
  config: DateSelectOptions = {},
): Node {
  return build([...DATE_ORDER, ...TIME_ORDER], scope, attribute, value, config);
}

/** The same three, without a record behind them. Rails' `select_date`. */
export function selectDate(name: string, value?: Date, config: DateSelectOptions = {}): Node {
  return build(DATE_ORDER, undefined, name, value, config);
}

/** Rails' `select_time`. */
export function selectTime(name: string, value?: Date, config: DateSelectOptions = {}): Node {
  return build(TIME_ORDER, undefined, name, value, config);
}

/** Rails' `select_datetime`. */
export function selectDatetime(name: string, value?: Date, config: DateSelectOptions = {}): Node {
  return build([...DATE_ORDER, ...TIME_ORDER], undefined, name, value, config);
}

/**
 * A select of time zone names. Rails' `time_zone_select`.
 *
 * One select rather than a multi-part one, since a zone is a single value —
 * it is here because it belongs with the date helpers, not because it shares
 * their mechanism.
 */
export function timeZoneSelect(
  scope: string | undefined,
  attribute: string,
  zones: readonly string[],
  selected?: string,
  config: { includeBlank?: boolean; disabled?: boolean } = {},
): Node {
  const inner =
    (config.includeBlank ? `<option value=""></option>` : "") +
    zones
      .map(
        (zone) =>
          `<option value="${escape(zone)}"${zone === selected ? " selected" : ""}>${escape(zone)}</option>`,
      )
      .join("");

  return selectTag(fieldName(scope, attribute), fieldId(scope, attribute), inner, config.disabled);
}
