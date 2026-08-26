/**
 * Form builders, ported from `ActionView::Helpers::FormBuilder`.
 *
 * Rails spends 3,000 lines on form helpers because ERB has no way to compose.
 * TSX does, so what is left is the part that is genuinely conventional: how a
 * field is named after its model, where its value comes from, how its errors
 * are found, and the hidden inputs a form needs to be accepted at all.
 *
 *     <FormWith model={post} scope="post" url={postPath(post)} method="patch">
 *       {(f) => (
 *         <>
 *           {f.label("title")}
 *           {f.textField("title")}
 *           {f.errors("title")}
 *           {f.submit("Save")}
 *         </>
 *       )}
 *     </FormWith>
 *
 * The builder is a plain object, so a partial that takes one is just a
 * function that takes an argument.
 */

import { humanize, underscore } from "@altair/support";
import type { Attributes, Node } from "./render.js";

/** What a builder needs from a record. Structural, so any model qualifies. */
export interface FormRecord {
  attributes?: () => Record<string, unknown>;
  errors?: { on(attribute: string): string[] };
  isNewRecord?: boolean;
}

export interface FormOptions {
  /** The record the fields read from and are named after. */
  model?: FormRecord;
  /** Overrides the name fields are nested under. Rails' `scope:`. */
  scope?: string;
  url?: string;
  method?: "get" | "post" | "patch" | "put" | "delete";
  /** Rendered as a hidden input, which is how Rails ships CSRF tokens. */
  authenticityToken?: string;
  id?: string;
  class?: string;
  /** Anything else lands on the form element. */
  attributes?: Attributes;
}

/** The name an input gets: `post[title]`, and `post[tags][]` for many. */
export function fieldName(scope: string | undefined, attribute: string, many = false): string {
  const suffix = many ? "[]" : "";
  return scope ? `${scope}[${attribute}]${suffix}` : `${attribute}${suffix}`;
}

/** The id an input gets, which is what a label points at: `post_title`. */
export function fieldId(scope: string | undefined, attribute: string): string {
  return scope ? `${scope}_${attribute}` : attribute;
}

/**
 * The scope a record's fields are nested under.
 *
 * Rails takes it from the model name: a Post's fields are `post[...]`, which
 * is what makes `params.require("post")` work on the other side.
 */
export function scopeFor(record: FormRecord | undefined, given?: string): string | undefined {
  if (given) return given;
  if (!record) return undefined;

  return underscore(record.constructor.name);
}

/**
 * A form builder. Rails yields one from `form_with`.
 *
 * Every method returns a node, so a caller composes them with anything else
 * TSX can express rather than reaching for a helper that wraps a helper.
 */
export type SelectOption = string | { value: string; label?: string };

export interface SelectSettings {
  /**
   * An empty first option, so a select does not silently answer for the person
   * looking at it. Rails' `include_blank`.
   */
  includeBlank?: boolean;
  /** The same, with something written in it. Rails' `prompt`. */
  prompt?: string;
}

export class FormBuilder {
  constructor(
    readonly scope: string | undefined,
    readonly record: FormRecord | undefined,
  ) {}

  /** The current value of an attribute, as the browser should see it. */
  value(attribute: string): string {
    const raw = this.record?.attributes?.()[attribute];
    if (raw === null || raw === undefined) return "";
    return String(raw);
  }

  /** The validation messages on an attribute, if the record has any. */
  errorsOn(attribute: string): string[] {
    return this.record?.errors?.on(attribute) ?? [];
  }

  name(attribute: string, many = false): string {
    return fieldName(this.scope, attribute, many);
  }

  id(attribute: string): string {
    return fieldId(this.scope, attribute);
  }

  label(attribute: string, text?: string, attributes: Attributes = {}): Node {
    return (
      <label for={this.id(attribute)} {...attributes}>
        {text ?? humanize(attribute)}
      </label>
    );
  }

  /** The generic input. The typed ones below are Rails' named helpers. */
  input(type: string, attribute: string, attributes: Attributes = {}): Node {
    return (
      <input
        type={type}
        name={this.name(attribute)}
        id={this.id(attribute)}
        value={this.value(attribute)}
        {...attributes}
      />
    );
  }

  textField(attribute: string, attributes: Attributes = {}): Node {
    return this.input("text", attribute, attributes);
  }

  emailField(attribute: string, attributes: Attributes = {}): Node {
    return this.input("email", attribute, attributes);
  }

  /**
   * A password field never carries a value back to the browser.
   *
   * Rails does the same. Echoing a stored password into HTML puts it in every
   * cache, proxy log and "view source" between here and the person.
   */
  passwordField(attribute: string, attributes: Attributes = {}): Node {
    return (
      <input
        type="password"
        name={this.name(attribute)}
        id={this.id(attribute)}
        value=""
        {...attributes}
      />
    );
  }

  numberField(attribute: string, attributes: Attributes = {}): Node {
    return this.input("number", attribute, attributes);
  }

  dateField(attribute: string, attributes: Attributes = {}): Node {
    return this.input("date", attribute, attributes);
  }

  hiddenField(attribute: string, value?: string, attributes: Attributes = {}): Node {
    return (
      <input
        type="hidden"
        name={this.name(attribute)}
        id={this.id(attribute)}
        value={value ?? this.value(attribute)}
        {...attributes}
      />
    );
  }

  textArea(attribute: string, attributes: Attributes = {}): Node {
    return (
      <textarea name={this.name(attribute)} id={this.id(attribute)} {...attributes}>
        {this.value(attribute)}
      </textarea>
    );
  }

  /**
   * A checkbox, with the hidden input Rails pairs it with.
   *
   * An unchecked box sends nothing at all, so without the hidden field ahead
   * of it there is no way to tell "unchecked" from "not on the form" — and a
   * box could be ticked but never unticked.
   */
  checkBox(attribute: string, attributes: Attributes = {}): Node {
    const checked = isTruthy(this.record?.attributes?.()[attribute]);

    return (
      <>
        <input type="hidden" name={this.name(attribute)} value="0" />
        <input
          type="checkbox"
          name={this.name(attribute)}
          id={this.id(attribute)}
          value="1"
          {...(checked ? { checked: true } : {})}
          {...attributes}
        />
      </>
    );
  }

  radioButton(attribute: string, value: string, attributes: Attributes = {}): Node {
    const selected = this.value(attribute) === value;

    return (
      <input
        type="radio"
        name={this.name(attribute)}
        id={`${this.id(attribute)}_${underscore(value)}`}
        value={value}
        {...(selected ? { checked: true } : {})}
        {...attributes}
      />
    );
  }

  select(
    attribute: string,
    options: readonly SelectOption[],
    settings: SelectSettings = {},
    attributes: Attributes = {},
  ): Node {
    const current = this.value(attribute);

    // A select with nothing blank in it has already answered the question:
    // whatever is first is submitted by anyone who does not touch it, which
    // is how a "required" field comes back filled in with the first option.
    const blank =
      settings.prompt !== undefined || settings.includeBlank
        ? [{ value: "", label: settings.prompt ?? "" }]
        : [];

    return (
      <select name={this.name(attribute)} id={this.id(attribute)} {...attributes}>
        {[...blank, ...options].map((option) => {
          const value = typeof option === "string" ? option : option.value;
          const label = typeof option === "string" ? option : (option.label ?? option.value);

          return (
            <option value={value} {...(value === current ? { selected: true } : {})}>
              {label}
            </option>
          );
        })}
      </select>
    );
  }

  /** The validation messages on an attribute, rendered. Nothing when valid. */
  errors(attribute: string, attributes: Attributes = {}): Node {
    const messages = this.errorsOn(attribute);
    if (messages.length === 0) return null;

    return (
      <ul class="field-errors" {...attributes}>
        {messages.map((message) => (
          <li>{`${humanize(attribute)} ${message}`}</li>
        ))}
      </ul>
    );
  }

  submit(text?: string, attributes: Attributes = {}): Node {
    const label = text ?? (this.record?.isNewRecord === false ? "Update" : "Create");
    return (
      <button type="submit" {...attributes}>
        {label}
      </button>
    );
  }

  /** Fields for a nested record. Rails' `fields_for`. */
  fieldsFor(attribute: string, index?: number): FormBuilder {
    const nested =
      index === undefined
        ? `${this.scope ?? ""}[${attribute}_attributes]`
        : `${this.scope ?? ""}[${attribute}_attributes][${index}]`;

    return new FormBuilder(nested, undefined);
  }
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Verbs a browser form can actually send. */
const NATIVE_METHODS = new Set(["get", "post"]);

/**
 * Rails' `form_with`.
 *
 * A form for a record that already exists defaults to PATCH; a new one to
 * POST. A browser can only send GET and POST, so anything else goes as POST
 * with a `_method` field, which is the convention the router already reads.
 */
export function FormWith(props: FormOptions & { children: (f: FormBuilder) => Node }): Node {
  const scope = scopeFor(props.model, props.scope);
  const builder = new FormBuilder(scope, props.model);

  const intended = props.method ?? (props.model?.isNewRecord === false ? "patch" : "post");
  const sent = NATIVE_METHODS.has(intended) ? intended : "post";

  return (
    <form
      action={props.url}
      method={sent}
      {...(props.id ? { id: props.id } : {})}
      {...(props.class ? { class: props.class } : {})}
      {...(props.attributes ?? {})}
    >
      {intended === sent ? null : <input type="hidden" name="_method" value={intended} />}
      {props.authenticityToken ? (
        <input type="hidden" name="authenticity_token" value={props.authenticityToken} />
      ) : null}
      {props.children(builder)}
    </form>
  );
}
