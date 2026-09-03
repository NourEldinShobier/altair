/**
 * Form fields that are not bound to a record, ported from
 * `ActionView::Helpers::FormTagHelper`.
 *
 * Rails' `*_tag` family: a search box, a filter, a sign-in form — anything
 * whose fields are not attributes of a model. `FormWith` covers the bound
 * case; this covers the rest, which is otherwise raw JSX repeated per form.
 *
 *     <TextFieldTag name="q" value={query} placeholder="Search" />
 *     <SubmitTag value="Search" />
 */

import { escapeHtml as escape, RawHtml, type Node } from "./render.js";
import { xmlNameEscape } from "./escaping.js";

/** Anything else that should land on the element. */
export type TagAttributes = Record<string, string | number | boolean | null | undefined>;

/**
 * Attributes as HTML.
 *
 * `false`, `null` and `undefined` drop the attribute entirely rather than
 * writing `="false"` — which the browser reads as true, being a non-empty
 * string, and is how `disabled={false}` disables a field.
 */
export function tagOptions(attributes: TagAttributes): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([key, value]) => {
      // The name as well as the value. A name is written outside the quotes,
      // so escaping only the value leaves `{ "x><script>alert(1)</script": 1 }`
      // closing the tag and everything after it reading as markup. Rails
      // escapes names here for the same reason.
      const name = xmlNameEscape(key);

      return value === true ? ` ${name}` : ` ${name}="${escape(String(value))}"`;
    })
    .join("");
}

/** An element with children. Rails' `content_tag`. */
export function contentTag(name: string, content: string, attributes: TagAttributes = {}): Node {
  const tag = xmlNameEscape(name);

  return new RawHtml(`<${tag}${tagOptions(attributes)}>${escape(content)}</${tag}>`);
}

/** An element with nothing inside it. */
export function voidTag(name: string, attributes: TagAttributes = {}): Node {
  return new RawHtml(`<${xmlNameEscape(name)}${tagOptions(attributes)}>`);
}

/**
 * An element with nothing inside it, closed. Rails' `tag` in XHTML mode.
 *
 * For SVG and for anything else parsed as XML, where `<circle>` without a
 * closing slash is an unclosed element rather than an empty one — and an
 * unclosed element swallows everything after it into itself, so one missing
 * slash silently empties the rest of the drawing.
 */
export function selfClosingTag(name: string, attributes: TagAttributes = {}): Node {
  return new RawHtml(`<${xmlNameEscape(name)}${tagOptions(attributes)} />`);
}

/**
 * The markup for an element, as a string. Rails' `content_tag_string`.
 *
 * Exposed because a caller sometimes needs the string rather than a node — to
 * put it in an attribute, to measure it, to hand it to something that is not
 * the renderer — and the alternative is that caller doing its own escaping,
 * which is where escaping stops happening.
 */
export function contentTagString(
  name: string,
  content: string,
  attributes: TagAttributes = {},
  escapeContent = true,
): string {
  const inner = escapeContent ? escape(content) : content;
  // Rails leaves the tag name alone, because its builder takes one from a
  // method call and cannot be handed a string. This takes a string.
  const tag = xmlNameEscape(name);

  return `<${tag}${tagOptions(attributes)}>${inner}</${tag}>`;
}

/**
 * Makes a helper for one element. Rails' `define_element`.
 *
 *     const Widget = defineElement("my-widget")
 *     Widget("Hello", { theme: "dark" })
 *
 * The point is that the element's name is fixed at definition rather than
 * passed at every call: a custom element or an SVG shape used in twenty places
 * is twenty chances to mistype the tag, and a mistyped tag renders as nothing
 * rather than as an error.
 */
export function defineElement(
  name: string,
): (content?: string, attributes?: TagAttributes) => Node {
  return (content = "", attributes = {}) => contentTag(name, content, attributes);
}

/** The same for an element that has no content. Rails' `define_void_element`. */
export function defineVoidElement(name: string): (attributes?: TagAttributes) => Node {
  return (attributes = {}) => voidTag(name, attributes);
}

/** The same for one that closes itself. Rails' `define_self_closing_element`. */
export function defineSelfClosingElement(name: string): (attributes?: TagAttributes) => Node {
  return (attributes = {}) => selfClosingTag(name, attributes);
}

/** The id Rails gives a field, derived from its name. */
function idFor(name: string): string {
  return name
    .replace(/\[]$/, "")
    .replace(/[[\]]+/g, "_")
    .replace(/_+$/, "");
}

export interface FieldProps extends TagAttributes {
  name: string;
  value?: string | number | null;
  id?: string;
}

/** Every `<input type=...>` Rails has a helper for, from one implementation. */
function inputTag(type: string) {
  return (props: FieldProps): Node => {
    const { name, value, id, ...rest } = props;

    return voidTag("input", {
      type,
      name,
      id: id ?? idFor(name),
      value: value ?? undefined,
      ...rest,
    });
  };
}

export const TextFieldTag = inputTag("text");
export const PasswordFieldTag = inputTag("password");
export const HiddenFieldTag = inputTag("hidden");
export const EmailFieldTag = inputTag("email");
export const NumberFieldTag = inputTag("number");
export const SearchFieldTag = inputTag("search");
export const TelephoneFieldTag = inputTag("tel");
export const UrlFieldTag = inputTag("url");
export const DateFieldTag = inputTag("date");
export const TimeFieldTag = inputTag("time");
export const DatetimeFieldTag = inputTag("datetime-local");
export const MonthFieldTag = inputTag("month");
export const WeekFieldTag = inputTag("week");
export const ColorFieldTag = inputTag("color");
export const RangeFieldTag = inputTag("range");
export const FileFieldTag = inputTag("file");

export interface CheckableProps extends FieldProps {
  checked?: boolean;
}

/**
 * A checkbox, with the hidden field that makes "off" different from "absent".
 *
 * An unchecked box sends nothing at all, so without this a form that unticks
 * one is indistinguishable from a form that never had it — which is how a
 * setting turns itself back on.
 */
export function CheckboxTag(props: CheckableProps): Node {
  const { name, value, id, checked, ...rest } = props;
  const resolved = id ?? idFor(name);

  return new RawHtml(
    `<input type="hidden" name="${escape(name)}" value="0">` +
      (
        voidTag("input", {
          type: "checkbox",
          name,
          id: resolved,
          value: value ?? "1",
          checked,
          ...rest,
        }) as RawHtml
      ).value,
  );
}

/** A radio button. No hidden field: a radio group is never empty by accident. */
export function RadioButtonTag(props: CheckableProps): Node {
  const { name, value, id, checked, ...rest } = props;

  return voidTag("input", {
    type: "radio",
    name,
    id: id ?? `${idFor(name)}_${String(value ?? "")}`,
    value: value ?? undefined,
    checked,
    ...rest,
  });
}

export interface TextareaProps extends FieldProps {
  rows?: number;
  cols?: number;
}

export function TextareaTag(props: TextareaProps): Node {
  const { name, value, id, ...rest } = props;

  return new RawHtml(
    `<textarea${tagOptions({ name, id: id ?? idFor(name), ...rest })}>${escape(
      String(value ?? ""),
    )}</textarea>`,
  );
}

export interface LabelProps extends TagAttributes {
  for: string;
  text: string;
}

export function LabelTag(props: LabelProps): Node {
  const { text, ...rest } = props;

  return contentTag("label", text, rest);
}

export interface SubmitProps extends TagAttributes {
  value?: string;
  /** Words shown while the form is being sent, as Rails' `data-disable-with`. */
  disableWith?: string;
}

export function SubmitTag(props: SubmitProps = {}): Node {
  const { value, disableWith, ...rest } = props;

  return voidTag("input", {
    type: "submit",
    value: value ?? "Save changes",
    "data-disable-with": disableWith,
    ...rest,
  });
}

export interface ButtonProps extends TagAttributes {
  text: string;
  type?: "submit" | "button" | "reset";
}

export function ButtonTag(props: ButtonProps): Node {
  const { text, type, ...rest } = props;

  return contentTag("button", text, { type: type ?? "submit", ...rest });
}

export interface FieldSetProps extends TagAttributes {
  legend?: string;
  children: string;
}

export function FieldSetTag(props: FieldSetProps): Node {
  const { legend, children, ...rest } = props;
  const inside = legend ? `<legend>${escape(legend)}</legend>${children}` : children;

  return new RawHtml(`<fieldset${tagOptions(rest)}>${inside}</fieldset>`);
}

/**
 * A `<datalist>` of suggestions for a field.
 *
 * Rails' `datalist_tag`. The suggestions are values rather than labels: a
 * datalist fills the field with whatever the person picks.
 */
export function DatalistTag(props: { id: string; options: readonly string[] }): Node {
  const options = props.options.map((one) => `<option value="${escape(one)}">`).join("");

  return new RawHtml(`<datalist id="${escape(props.id)}">${options}</datalist>`);
}
