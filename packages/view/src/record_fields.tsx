/**
 * Form fields bound to a record, ported from
 * `ActionView::Helpers::FormHelper`.
 *
 *     textField("post", "title", post)
 *     // <input type="text" name="post[title]" id="post_title" value="Hello">
 *
 * [tags.tsx](./tags.tsx) has the tag-level helpers, which take a name and a
 * value and render them. These are Rails' other half — the ones that take an
 * object and an attribute and work the rest out:
 *
 *   - the name, as `post[title]`, so the parameters nest under the model
 *   - the id, as `post_title`, so a label can point at it
 *   - the current value, read off the record, so the form shows what is stored
 *   - for a checkbox, whether it is checked, from that same value
 *
 * Each of those is small and each is wrong in a recognisable way when it is
 * done by hand: a name without the brackets posts a flat parameter the model
 * cannot assign, an id that does not match the label leaves the label pointing
 * at nothing, and a value nobody read means an edit form that silently blanks
 * every field the user did not retype.
 */

import { fieldId, fieldName } from "./form.js";
import type { Node } from "./render.js";
import {
  CheckboxTag,
  RadioButtonTag,
  TextareaTag,
  type CheckableProps,
  type FieldProps,
  type TextareaProps,
} from "./tags.js";
import * as tags from "./tags.js";

/** Anything a value can be read off. */
type Recordish = Record<string, unknown> | undefined;

/**
 * The value an attribute currently holds.
 *
 * Undefined for a record that does not have it, rather than an empty string,
 * so `value=""` is only rendered when the record really holds one — the two
 * are different to a browser restoring a form and to anything comparing what
 * was submitted against what was shown.
 */
export function valueFor(record: Recordish, attribute: string): string | undefined {
  const value = record?.[attribute];

  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();

  return String(value);
}

/** What the options common to every record-bound field look like. */
export interface RecordFieldOptions extends Omit<FieldProps, "name" | "value"> {
  /** Override the value read off the record. */
  value?: string | number | null;
}

function boundField(
  tag: (props: FieldProps) => Node,
  scope: string | undefined,
  attribute: string,
  record: Recordish,
  options: RecordFieldOptions,
): Node {
  const { value, id: _id, ...rest } = options;
  // Narrowed by hand: TagAttributes is an index signature, so destructuring
  // widens id to every attribute type a tag can carry.
  const id = _id as string | undefined;

  return tag({
    ...rest,
    name: fieldName(scope, attribute),
    id: id ?? fieldId(scope, attribute),
    value: value ?? valueFor(record, attribute) ?? null,
  });
}

/** Builds one record-bound helper from a tag-level one. */
function bind(tag: (props: FieldProps) => Node) {
  return (
    scope: string | undefined,
    attribute: string,
    record?: Recordish,
    options: RecordFieldOptions = {},
  ): Node => boundField(tag, scope, attribute, record, options);
}

/** Rails' `text_field`. */
export const textField = bind(tags.TextFieldTag);

/**
 * Rails' `password_field`.
 *
 * The value is not read off the record, and that is deliberate rather than an
 * oversight: rendering a password back into a form puts it in the page source,
 * in the browser's cache, and in any proxy log along the way. Rails does the
 * same, and a caller who genuinely wants it has to pass it explicitly.
 */
export function passwordField(
  scope: string | undefined,
  attribute: string,
  _record?: Recordish,
  options: RecordFieldOptions = {},
): Node {
  return boundField(tags.PasswordFieldTag, scope, attribute, undefined, options);
}

/** Rails' `hidden_field`. */
export const hiddenField = bind(tags.HiddenFieldTag);
/** Rails' `email_field`. */
export const emailField = bind(tags.EmailFieldTag);
/** Rails' `number_field`. */
export const numberField = bind(tags.NumberFieldTag);
/** Rails' `search_field`. */
export const searchField = bind(tags.SearchFieldTag);
/** Rails' `telephone_field`. */
export const telephoneField = bind(tags.TelephoneFieldTag);
/** Rails' `url_field`. */
export const urlField = bind(tags.UrlFieldTag);
/** Rails' `color_field`. */
export const colorField = bind(tags.ColorFieldTag);
/** Rails' `range_field`. */
export const rangeField = bind(tags.RangeFieldTag);
/** Rails' `week_field`. */
export const weekField = bind(tags.WeekFieldTag);

/**
 * Rails' `file_field`.
 *
 * No value is ever rendered. A browser refuses to have one set on a file input
 * — it would let a page read a file off the disk without the user choosing it
 * — so passing one is silently ignored, and reading one off the record would
 * only mislead whoever wrote it.
 */
export function fileField(
  scope: string | undefined,
  attribute: string,
  _record?: Recordish,
  options: Omit<RecordFieldOptions, "value"> = {},
): Node {
  return tags.FileFieldTag({
    ...options,
    name: fieldName(scope, attribute),
    id: (options.id as string | undefined) ?? fieldId(scope, attribute),
  });
}

/**
 * The date and time fields, whose value has to be trimmed to what the input
 * type accepts.
 *
 * A browser ignores a `datetime-local` value carrying a timezone or
 * milliseconds and renders the field empty, which looks exactly like a record
 * with no value — so a stored timestamp appears to vanish on the edit form.
 */
function boundTemporal(tag: (props: FieldProps) => Node, slice: number) {
  return (
    scope: string | undefined,
    attribute: string,
    record?: Recordish,
    options: RecordFieldOptions = {},
  ): Node => {
    const raw = options.value ?? valueFor(record, attribute);
    const trimmed = typeof raw === "string" ? raw.slice(0, slice) : (raw ?? null);

    return boundField(tag, scope, attribute, undefined, { ...options, value: trimmed });
  };
}

/** Rails' `date_field`: `2026-03-09`. */
export const dateField = boundTemporal(tags.DateFieldTag, 10);
/** Rails' `time_field`: `14:30`. */
export function timeField(
  scope: string | undefined,
  attribute: string,
  record?: Recordish,
  options: RecordFieldOptions = {},
): Node {
  const raw = options.value ?? valueFor(record, attribute);
  const value = typeof raw === "string" && raw.includes("T") ? raw.slice(11, 16) : (raw ?? null);

  return boundField(tags.TimeFieldTag, scope, attribute, undefined, { ...options, value });
}

/** Rails' `datetime_field`: `2026-03-09T14:30`. */
export const datetimeField = boundTemporal(tags.DatetimeFieldTag, 16);
/** Rails' `month_field`: `2026-03`. */
export const monthField = boundTemporal(tags.MonthFieldTag, 7);

/**
 * Rails' `check_box`.
 *
 * Checked from the record's own value rather than from a flag the caller has
 * to work out, which is the whole reason to prefer this over the tag: an edit
 * form that forgot to compute `checked` silently shows every box unticked, and
 * submitting it turns every setting off.
 *
 * The tag underneath emits the hidden field, so unchecking posts something.
 */
export function checkbox(
  scope: string | undefined,
  attribute: string,
  record?: Recordish,
  options: Omit<CheckableProps, "name"> & { checkedValue?: string; uncheckedValue?: string } = {},
): Node {
  const { checkedValue = "1", checked: _checked, id: _id, ...rest } = options;
  const current = valueFor(record, attribute);

  // Narrowed by hand: TagAttributes is an index signature, so destructuring
  // widens these to every attribute type a tag can carry.
  const id = _id as string | undefined;
  const checked = _checked as boolean | undefined;

  return CheckboxTag({
    ...rest,
    name: fieldName(scope, attribute),
    id: id ?? fieldId(scope, attribute),
    value: checkedValue,
    checked: checked ?? isChecked(current, checkedValue),
  });
}

/**
 * Whether a stored value means checked.
 *
 * A boolean column comes back as a boolean from one adapter, as 1 or 0 from
 * another, and as "t" or "f" from a third. Comparing against the checked value
 * alone would leave the box unticked on two of the three.
 */
function isChecked(current: string | undefined, checkedValue: string): boolean {
  if (current === undefined) return false;

  return current === checkedValue || current === "true" || current === "1" || current === "t";
}

/**
 * Rails' `radio_button`.
 *
 * Checked when the record's value equals this button's, which is what makes a
 * group of them show the current choice without the caller comparing each.
 */
export function radioButton(
  scope: string | undefined,
  attribute: string,
  value: string,
  record?: Recordish,
  options: Omit<CheckableProps, "name" | "value"> = {},
): Node {
  const { checked: _checked, id: _id, ...rest } = options;
  const id = _id as string | undefined;
  const checked = _checked as boolean | undefined;

  return RadioButtonTag({
    ...rest,
    name: fieldName(scope, attribute),
    id: id ?? `${fieldId(scope, attribute)}_${value}`,
    value,
    checked: checked ?? valueFor(record, attribute) === value,
  });
}

/** Rails' `text_area`. */
export function textarea(
  scope: string | undefined,
  attribute: string,
  record?: Recordish,
  options: Omit<TextareaProps, "name"> = {},
): Node {
  const { value: _value, id: _id, ...rest } = options;

  // Narrowed by hand: TagAttributes is an index signature, so destructuring
  // widens id and value to every attribute type a tag can carry.
  const id = _id as string | undefined;
  const value = _value as string | number | null | undefined;

  return TextareaTag({
    ...rest,
    name: fieldName(scope, attribute),
    id: id ?? fieldId(scope, attribute),
    value: value ?? valueFor(record, attribute) ?? null,
  });
}

/**
 * The input type an attribute's value suggests. Rails' `field_type`.
 *
 * A guess, and named as one — it is for a scaffold generator choosing a
 * starting point, not for deciding at render time. A column called
 * `password_digest` wants a password field and a column called `email` wants
 * an email one, and neither is knowable from the value alone.
 */
export function fieldType(attribute: string, value?: unknown): string {
  if (/password/i.test(attribute)) return "password";
  if (/email/i.test(attribute)) return "email";
  if (/(^|_)url$/i.test(attribute)) return "url";
  if (/(phone|telephone)/i.test(attribute)) return "tel";
  if (/(^|_)colou?r$/i.test(attribute)) return "color";

  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return /(_on|_date)$/i.test(attribute) ? "date" : "datetime-local";

  return "text";
}
