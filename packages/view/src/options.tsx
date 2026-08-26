/**
 * Building the inside of a `<select>`, ported from
 * `ActionView::Helpers::FormOptionsHelper`.
 *
 * The everyday view code Rails has and this did not: a list of options from a
 * collection, grouped options, a select bound to a record, and the checkbox
 * and radio equivalents. Written by hand it is a `map` and a ternary for the
 * selected one, in every form, slightly differently each time.
 *
 *     <Select name="post[state]" options={optionsForSelect(STATES, post.state)} />
 *     <CollectionSelect name="post[author_id]" collection={authors}
 *       value={(a) => a.id} label={(a) => a.name} selected={post.author_id} />
 */

import { escapeHtml as escape, RawHtml, type Node } from "./render.js";

/** A value and the words shown for it, or just the words. */
export type OptionLike = string | number | readonly [label: string, value: unknown];

/** Options grouped under a heading, as `<optgroup>` renders them. */
export type OptionGroups = Record<string, readonly OptionLike[]>;

function labelAndValue(option: OptionLike): [string, unknown] {
  return Array.isArray(option)
    ? [String(option[0]), option[1]]
    : [String(option), option as unknown];
}

/**
 * Whether an option is the chosen one.
 *
 * Compared as strings, because a selected value usually arrives from a form or
 * a URL and the options usually come from the database — `"3"` and `3` are the
 * same choice, and a strict comparison silently selects nothing.
 */
function isChosen(value: unknown, selected: unknown): boolean {
  if (selected === null || selected === undefined) return false;
  if (Array.isArray(selected)) return selected.some((one) => String(one) === String(value));

  return String(selected) === String(value);
}

/** Rails' `options_for_select`. */
export function optionsForSelect(
  options: readonly OptionLike[],
  selected?: unknown,
  disabled?: unknown,
): Node {
  const html = options
    .map((option) => {
      const [label, value] = labelAndValue(option);

      const attributes = [
        ` value="${escape(String(value))}"`,
        isChosen(value, selected) ? " selected" : "",
        disabled !== undefined && isChosen(value, disabled) ? " disabled" : "",
      ].join("");

      return `<option${attributes}>${escape(label)}</option>`;
    })
    .join("");

  return new RawHtml(html);
}

/** Rails' `options_from_collection_for_select`. */
export function optionsFromCollectionForSelect<T>(
  collection: readonly T[],
  value: (one: T) => unknown,
  label: (one: T) => string,
  selected?: unknown,
): Node {
  return optionsForSelect(
    collection.map((one) => [label(one), value(one)] as const),
    selected,
  );
}

/** Rails' `grouped_options_for_select`. */
export function groupedOptionsForSelect(groups: OptionGroups, selected?: unknown): Node {
  const html = Object.entries(groups)
    .map(([heading, options]) => {
      const inside = (optionsForSelect(options, selected) as RawHtml).value;

      return `<optgroup label="${escape(heading)}">${inside}</optgroup>`;
    })
    .join("");

  return new RawHtml(html);
}

/** Rails' `option_groups_from_collection_for_select`. */
export function optionGroupsFromCollectionForSelect<G, T>(
  groups: readonly G[],
  members: (group: G) => readonly T[],
  groupLabel: (group: G) => string,
  value: (one: T) => unknown,
  label: (one: T) => string,
  selected?: unknown,
): Node {
  const shaped: OptionGroups = Object.fromEntries(
    groups.map((group) => [
      groupLabel(group),
      members(group).map((one) => [label(one), value(one)] as const),
    ]),
  );

  return groupedOptionsForSelect(shaped, selected);
}

/** Every time zone, as options. Rails' `time_zone_options_for_select`. */
export function timeZoneOptionsForSelect(zones: readonly string[], selected?: unknown): Node {
  return optionsForSelect(zones, selected);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The days of the week, as options. Rails' `weekday_options_for_select`.
 *
 * The value is the day's number rather than its name, because a name is a
 * translation waiting to break the value it was carrying.
 */
export function weekdayOptionsForSelect(selected?: unknown, beginningOfWeek = 1): Node {
  const ordered = [...DAYS.slice(beginningOfWeek), ...DAYS.slice(0, beginningOfWeek)];

  return optionsForSelect(
    ordered.map((day) => [day, DAYS.indexOf(day)] as const),
    selected,
  );
}

export interface SelectProps {
  name: string;
  options: Node;
  id?: string;
  /** Adds an empty option at the top, for "no choice yet". */
  includeBlank?: boolean | string;
  multiple?: boolean;
  required?: boolean;
  disabled?: boolean;
  class?: string;
}

/** A `<select>` around options that were built separately. Rails' `select_tag`. */
export function Select(props: SelectProps): Node {
  const blank =
    props.includeBlank === undefined || props.includeBlank === false
      ? ""
      : `<option value="">${
          typeof props.includeBlank === "string" ? escape(props.includeBlank) : ""
        }</option>`;

  const attributes = [
    ` name="${escape(props.name)}"`,
    ` id="${escape(props.id ?? props.name)}"`,
    props.class ? ` class="${escape(props.class)}"` : "",
    props.multiple ? " multiple" : "",
    props.required ? " required" : "",
    props.disabled ? " disabled" : "",
  ].join("");

  const inside = (props.options as RawHtml).value ?? "";

  return new RawHtml(`<select${attributes}>${blank}${inside}</select>`);
}

export interface CollectionSelectProps<T> extends Omit<SelectProps, "options"> {
  collection: readonly T[];
  value: (one: T) => unknown;
  label: (one: T) => string;
  selected?: unknown;
}

/** A select built straight from a collection. Rails' `collection_select`. */
export function CollectionSelect<T>(props: CollectionSelectProps<T>): Node {
  const { collection, value, label, selected, ...rest } = props;

  return Select({
    ...rest,
    options: optionsFromCollectionForSelect(collection, value, label, selected),
  });
}

export interface CollectionInputsProps<T> {
  name: string;
  collection: readonly T[];
  value: (one: T) => unknown;
  label: (one: T) => string;
  checked?: unknown;
}

/**
 * A checkbox per member. Rails' `collection_check_boxes`.
 *
 * The hidden empty field goes first, so unchecking everything sends something
 * rather than nothing — without it the parameter disappears and the server
 * reads "unchanged" where the person meant "none".
 */
export function CollectionCheckboxes<T>(props: CollectionInputsProps<T>): Node {
  const boxes = props.collection
    .map((one) => {
      const value = String(props.value(one));
      const id = `${props.name.replace(/[[\]]+/g, "_")}${value}`.replace(/_+$/, "_");
      const checked = isChosen(value, props.checked) ? " checked" : "";

      return (
        `<label for="${escape(id)}">` +
        `<input type="checkbox" name="${escape(props.name)}" id="${escape(id)}" value="${escape(value)}"${checked}>` +
        `${escape(props.label(one))}</label>`
      );
    })
    .join("");

  return new RawHtml(`<input type="hidden" name="${escape(props.name)}" value="">${boxes}`);
}

/** A radio button per member. Rails' `collection_radio_buttons`. */
export function CollectionRadioButtons<T>(props: CollectionInputsProps<T>): Node {
  const buttons = props.collection
    .map((one) => {
      const value = String(props.value(one));
      const id = `${props.name.replace(/[[\]]+/g, "_")}${value}`.replace(/_+$/, "_");
      const checked = isChosen(value, props.checked) ? " checked" : "";

      return (
        `<label for="${escape(id)}">` +
        `<input type="radio" name="${escape(props.name)}" id="${escape(id)}" value="${escape(value)}"${checked}>` +
        `${escape(props.label(one))}</label>`
      );
    })
    .join("");

  return new RawHtml(buttons);
}
