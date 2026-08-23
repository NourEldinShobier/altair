/**
 * ActiveModel, ported from the `ActiveModel` gem.
 *
 * Rails' ActiveModel is the part of a model that has nothing to do with a
 * database: validations, errors, naming, dirty tracking, serialization. It
 * exists so that a signup form, a search filter or a contact message can be
 * validated and rendered by the same machinery as a row, without inventing a
 * table for something that is never stored.
 *
 *     class Signup extends ActiveModel {
 *       declare email: string
 *       declare terms: boolean
 *
 *       static {
 *         this.validates("email", { presence: true, format: { with: /@/ } })
 *         this.validates("terms", { acceptance: true })
 *       }
 *     }
 *
 *     const signup = new Signup({ email: "", terms: false })
 *     await signup.validate()          // false
 *     signup.errors.fullMessages()     // ["Email can't be blank", …]
 *
 * Fields are declared, not initialized. A field with an initializer runs after
 * the base constructor and would overwrite what the constructor assigned —
 * `Signup.build({ ... })` is right either way, and is what to reach for if a
 * field needs a default.
 *
 * `Model` gets the same naming, serialization and dirty API, because a view
 * that renders one should not have to know which it was given.
 */

import { camelize, humanize, pluralize, tableize, underscore } from "@altair/support";
import { ValidationErrors } from "./model.js";
import {
  runValidation,
  type ValidationDeclaration,
  type ValidationOptions,
} from "./validations.js";

/**
 * The names one model answers to. Rails' `ActiveModel::Name`.
 *
 * Rails derives route helpers, partial paths, form parameter names and error
 * headings from this one object, which is why they all agree with each other
 * without anyone configuring anything.
 */
export class ModelName {
  /** `BlogPost` */
  readonly name: string;
  /** `blog_post` — the singular, underscored form. */
  readonly singular: string;
  /** `blog_posts` */
  readonly plural: string;
  /** `blog_post`, without any namespace. Rails uses it for partial names. */
  readonly element: string;
  /** `blog_posts`, without any namespace. */
  readonly collection: string;
  /** The key a form nests its fields under: `blog_post[title]`. */
  readonly paramKey: string;
  /** What the route helpers are named after: `blogPostsPath`. */
  readonly routeKey: string;
  readonly singularRouteKey: string;
  /** `Blog post` — for a heading nobody has translated yet. */
  readonly human: string;

  constructor(name: string) {
    this.name = name;
    this.singular = underscore(name);
    this.plural = tableize(name);
    this.element = this.singular;
    this.collection = this.plural;
    this.paramKey = this.singular;
    this.routeKey = camelize(this.plural, false);
    this.singularRouteKey = camelize(this.singular, false);
    this.human = humanize(this.singular);
  }

  /** `blog_posts/blog_post`, the partial Rails renders a record with. */
  get partialPath(): string {
    return `${this.collection}/${this.element}`;
  }

  toString(): string {
    return this.name;
  }
}

const names = new Map<unknown, ModelName>();

/** The `ModelName` for a class, computed once. */
export function modelNameFor(klass: { name: string }): ModelName {
  let name = names.get(klass);
  if (!name) {
    name = new ModelName(klass.name);
    names.set(klass, name);
  }
  return name;
}

export interface SerializationOptions {
  /** Only these attributes. */
  only?: readonly string[];
  /** Everything but these. Ignored when `only` is given, as in Rails. */
  except?: readonly string[];
  /** Methods to call and include under their own names. */
  methods?: readonly string[];
}

/**
 * Rails' `serializable_hash`.
 *
 * Shared by `ActiveModel` and `Model` so `only`/`except`/`methods` mean the
 * same thing wherever they are written.
 */
export function serializableHash(
  record: object,
  attributes: Record<string, unknown>,
  options: SerializationOptions = {},
): Record<string, unknown> {
  const keys = options.only
    ? Object.keys(attributes).filter((key) => options.only?.includes(key))
    : Object.keys(attributes).filter((key) => !options.except?.includes(key));

  const hash: Record<string, unknown> = {};
  for (const key of keys) hash[key] = attributes[key];

  for (const method of options.methods ?? []) {
    const value = (record as Record<string, unknown>)[method];
    hash[method] = typeof value === "function" ? (value as () => unknown).call(record) : value;
  }

  return hash;
}

/** Anything with a `constructor.name`, which is every object. */
interface HasConstructor {
  constructor: { name: string };
}

/** Rails' `to_partial_path`: which partial renders this record. */
export function partialPathFor(record: HasConstructor): string {
  return modelNameFor(record.constructor).partialPath;
}

const ORIGINAL = Symbol("altair.activeModel.original");

/**
 * A model with no table. Rails' `ActiveModel::Model`.
 *
 * Attributes are ordinary properties, not a bag: a form object with three
 * fields should be three fields, typed, and not a `Record<string, unknown>`
 * that the compiler cannot help with.
 */
export abstract class ActiveModel {
  /** Rails' `errors`. Not enumerable, so it is not one of the attributes. */
  readonly errors!: ValidationErrors;

  declare private [ORIGINAL]: Record<string, unknown>;

  static validations: ValidationDeclaration[] = [];

  /** Declares a validation. Rails' `validates`. */
  static validates(attribute: string, options: ValidationOptions): void {
    // Copy on write, so a subclass adding validations leaves the parent alone.
    if (!Object.hasOwn(this, "validations")) this.validations = [...this.validations];
    this.validations.push({ attribute, options });
  }

  /** Rails' `model_name`. */
  static get modelName(): ModelName {
    return modelNameFor(this);
  }

  /**
   * Builds a record and assigns its attributes. Prefer this to `new`.
   *
   * A class field with an initializer — `email = ""` rather than
   * `declare email: string` — runs *after* the base constructor, so anything
   * the constructor assigned is overwritten by the initializer and silently
   * lost. `build` assigns after the object is fully constructed, so it is
   * right either way; the constructor is right only for `declare`d fields.
   */
  static build<T extends ActiveModel>(
    this: new (attributes?: Record<string, unknown>) => T,
    attributes: Record<string, unknown> = {},
  ): T {
    const record = new this();
    Object.assign(record, attributes);
    record.changesApplied();
    return record;
  }

  constructor(attributes: Record<string, unknown> = {}) {
    // Both are hidden from enumeration, so `attributes()` and `{...record}`
    // see the fields and nothing else.
    Object.defineProperty(this, "errors", { value: new ValidationErrors(), enumerable: false });
    Object.defineProperty(this, ORIGINAL, { value: {}, writable: true, enumerable: false });

    Object.assign(this, attributes);
    this.changesApplied();
  }

  get modelName(): ModelName {
    return modelNameFor(this.constructor);
  }

  /** Every own enumerable property. Rails' `attributes`. */
  attributes(): Record<string, unknown> {
    return { ...this } as Record<string, unknown>;
  }

  assign(values: Record<string, unknown>): void {
    Object.assign(this, values);
  }

  /**
   * Runs the declared validations, then any written in code.
   *
   * Returns whether the record is valid, as Rails' `valid?` does, and fills
   * `errors` either way — a caller that only looks at the boolean has nothing
   * to show the person who filled the form in.
   */
  async validate(): Promise<boolean> {
    this.errors.clear();

    const klass = this.constructor as typeof ActiveModel;
    for (const declaration of klass.validations) {
      await runValidation(this as never, declaration);
    }

    await this.runValidations();

    return this.errors.isEmpty;
  }

  /** Override to add rules in code. Add to `this.errors` to fail. */
  async runValidations(): Promise<void> {}

  /** Rails' `invalid?`. */
  async isInvalid(): Promise<boolean> {
    return !(await this.validate());
  }

  // Conversion. A form builder and a router ask these of anything they are
  // handed, so a tableless model has to answer them too.

  /** Never, for something with nowhere to be stored. */
  get persisted(): boolean {
    return false;
  }

  toKey(): unknown[] | null {
    return null;
  }

  toParam(): string | null {
    return null;
  }

  toPartialPath(): string {
    return this.modelName.partialPath;
  }

  // Serialization.

  serializableHash(options: SerializationOptions = {}): Record<string, unknown> {
    return serializableHash(this, this.attributes(), options);
  }

  toJSON(): Record<string, unknown> {
    return this.attributes();
  }

  // Dirty tracking. Rails snapshots on save; there is nothing to save here, so
  // the snapshot is taken when the record is built and whenever asked for.

  /** The attributes that differ from the last snapshot, as `[was, is]`. */
  changes(): Record<string, [unknown, unknown]> {
    const changes: Record<string, [unknown, unknown]> = {};

    for (const [key, value] of Object.entries(this.attributes())) {
      const was = this[ORIGINAL][key];
      if (!Object.is(value, was)) changes[key] = [was, value];
    }

    return changes;
  }

  changed(): string[] {
    return Object.keys(this.changes());
  }

  hasChanged(attribute?: string): boolean {
    return attribute ? attribute in this.changes() : this.changed().length > 0;
  }

  /** What the attribute held at the last snapshot. Rails' `attribute_was`. */
  attributeWas(attribute: string): unknown {
    return this[ORIGINAL][attribute];
  }

  /** Puts the changed attributes back. Rails' `restore_attributes`. */
  restoreAttributes(attributes: readonly string[] = this.changed()): void {
    for (const attribute of attributes) {
      (this as Record<string, unknown>)[attribute] = this[ORIGINAL][attribute];
    }
  }

  /** Takes a fresh snapshot. Rails calls this after a successful save. */
  changesApplied(): void {
    this[ORIGINAL] = { ...this.attributes() };
  }
}

/**
 * Rails' `human_attribute_name`: `first_name` becomes `First name`.
 *
 * Kept separate from the errors object so a view can use it for a label and
 * get the same words that appear in the message beneath it.
 */
export function humanAttributeName(attribute: string): string {
  return humanize(underscore(attribute));
}

/** The heading Rails' scaffold puts above a form that failed to save. */
export function errorHeading(count: number): string {
  return `${count} ${count === 1 ? "error" : pluralize("error")} prohibited this record from being saved`;
}
