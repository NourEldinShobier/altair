/**
 * Models, ported from `ActiveRecord::Base`.
 *
 * A model is declared by extending the base class a factory returns, which is
 * what lets the attributes be typed:
 *
 *     interface PostAttributes { id: number; title: string; body: string | null }
 *
 *     class Post extends Model<PostAttributes>("posts") {
 *       @beforeSave
 *       slugify() { this.slug ??= slugify(this.title) }
 *     }
 *
 *     const post = await Post.find(1)
 *     post.title  // string, not unknown
 *
 * Rails learns a model's columns by asking the database at boot and defining
 * methods on the fly. That is invisible to a type checker, so the shape is
 * stated once as an interface instead and the accessors follow from it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { didYouMean, secureToken } from "@altair/support";
import { errors } from "@altair/support";
import { lookupType, typeNames, typeRegistered, type Type, type TypeOptions } from "./types.js";
import {
  camelize,
  humanize,
  isBlank,
  pluralize,
  singularize,
  t,
  tableize,
  underscore,
} from "@altair/support";
import { Callbacks, callbackDecorators, runCallbacks } from "@altair/support";
import { connection as defaultConnection, type Connection, type Row } from "./connection.js";
import {
  Relation,
  RecordNotFound,
  type Conditions,
  type JoinSpec,
  type WithExpressions,
} from "./relation.js";
import { columnTypeFor } from "./dump.js";
import { SQLITE_VISIBLE } from "./introspect.js";
import { schemaReflection } from "./schema_cache.js";
import { columnSchemas, type ColumnSchema } from "./introspect.js";
import {
  decryptValue,
  encryptValue,
  originalAttributeName,
  type EncryptedAttributeOptions,
} from "./encryption.js";
import { checkWritable, currentScope, database, hasDatabases, type Role } from "./databases.js";
import {
  defineEnum,
  labelFor,
  memberName,
  storedValueFor,
  type EnumDefinition,
  type EnumMapping,
  type EnumOptions,
} from "./enum.js";
import {
  defineNormalizer,
  normalizeConditions,
  normalizeValue,
  type NormalizeDefinition,
  type Normalizer,
  type NormalizeOptions,
} from "./normalizes.js";
import type { ColumnType } from "./schema.js";
import { runBulk, type BulkContext, type BulkOptions, type BulkResult } from "./bulk.js";
import {
  afterCommit,
  afterRollback,
  type CommitAction,
  type CommitCallback,
} from "./after_commit.js";
import {
  humanAttributeName,
  modelNameFor,
  serializableHash,
  type ModelName,
  type SerializationOptions,
} from "./active_model.js";
import {
  MESSAGES,
  declarationApplies,
  runValidation,
  runCustomValidation,
  type CustomValidation,
  type Validator,
  type ValidationDeclaration,
  type ComparisonOptions,
  type LengthOptions,
  type NumericalityOptions,
  type ValidationOptions,
  type ValidationTarget,
  type UniquenessComparison,
} from "./validations.js";
import { uniquenessConditions } from "./predicate_builder.js";
import { fingerprintMatches, generateToken, readToken, type TokenDefinition } from "./token_for.js";
import {
  PRELOAD_PREFIX,
  cacheKey,
  defaultForeignKey,
  preloadAssociation,
  relationFor,
  type AssociationKind,
  type AssociationDefinition,
  type AssociationOptions,
  type InstanceLike,
  type ModelLike,
} from "./associations.js";

import {
  existingId,
  extractNested,
  marksForDestruction,
  normalizeCollection,
  withoutControlKeys,
  NestedAttributesLimitExceeded,
  NestedRecordNotFound,
  type NestedAttributesOptions,
} from "./nested.js";

export { RecordNotFound } from "./relation.js";

/** The part of a model class nested attributes reach for. */
interface NestedModel {
  primaryKey: string;
  build(values: Record<string, unknown>): NestedRecord;
  where(conditions: Conditions): { first(): Promise<NestedRecord | null> };
}

interface NestedRecord {
  assign(values: Record<string, unknown>): void;
  saveOrFail(): Promise<void>;
  destroy(): Promise<boolean>;
  attributes(): Record<string, unknown>;
}

/** Thrown to unwind the nested-save transaction when the owner is invalid. */
const NESTED_ROLLBACK = Symbol("altair.model.nestedRollback");

/** Any model class, for constraining a declaration to the class it is on. */
type AnyModel = abstract new (...args: never[]) => object;

/**
 * An association's name, checked against the properties the model declares.
 *
 * Rails matches `belongs_to :author` to `post.author` at run time and never
 * tells you when they disagree — a typo produces an association nobody can
 * reach. Requiring the name to be a declared property is why AdonisJS and
 * TypeORM reach for decorators, which carry the property name for free. That
 * is not available here: a standard decorator on a `declare` field
 * materializes a real field, which shadows the prototype accessor the
 * association installs and throws on construction. A type is enough, and it
 * keeps the declaration in Rails' shape.
 */
type AssociationName<M extends AnyModel> = keyof InstanceType<M> & string;

const { before: beforeSave, around: aroundSave, after: afterSave } = callbackDecorators("save");
const { before: beforeCreate, after: afterCreate } = callbackDecorators("create");
const { before: beforeUpdate, after: afterUpdate } = callbackDecorators("update");
const { before: beforeDestroy, after: afterDestroy } = callbackDecorators("destroy");
const { before: beforeValidation, after: afterValidation } = callbackDecorators("validation");

export {
  beforeSave,
  aroundSave,
  afterSave,
  beforeCreate,
  afterCreate,
  beforeUpdate,
  afterUpdate,
  beforeDestroy,
  afterDestroy,
  beforeValidation,
  afterValidation,
};

/**
 * Raised when a record was saved by someone else since it was read.
 *
 * Rails' `ActiveRecord::StaleObjectError`. The update is refused rather than
 * silently overwriting the other save, which is the entire point of the
 * `lock_version` column.
 */
/**
 * Rails' `StaleObjectError` — somebody else saved this row first.
 *
 * Says so explicitly, because zero rows updated has two readings and they need
 * opposite responses: a stale record should be reloaded and the change
 * reapplied, a missing one should stop. Reporting staleness as "not found"
 * sends the reader looking for a deletion that never happened.
 */
export class StaleObjectError extends Error {
  constructor(
    readonly model: string,
    readonly id: unknown,
    readonly action = "update",
  ) {
    super(
      `Attempted to ${action} a stale ${model} (id ${String(id)}): the row's version is not the ` +
        `one this record was loaded with, so somebody else saved it first. This is not a missing ` +
        `record — reload and reapply the change.`,
    );
    this.name = "StaleObjectError";
  }
}

/**
 * Raised when a record still has children an association refuses to orphan.
 *
 * Rails' `dependent: :restrict_with_error`. The point is to fail loudly rather
 * than quietly removing records someone still needs.
 */
export class DeleteRestricted extends Error {
  constructor(
    readonly model: string,
    readonly association: string,
    readonly count: number,
  ) {
    super(`Cannot delete this ${model}: it still has ${count} ${association}.`);
    this.name = "DeleteRestricted";
  }
}

/** Raised when `save` is called on a record that fails validation. */
export class RecordInvalid extends Error {
  constructor(readonly errors: ValidationErrors) {
    super(`Validation failed: ${errors.fullMessages().join(", ")}`);
    this.name = "RecordInvalid";
  }
}

/**
 * The same validation declared across several attributes at once.
 *
 * Backs the `validates_*_of` family, where Rails' older
 * `validates_presence_of :title, :body` reads better than three separate
 * `validates` calls — the rule is fixed and the attributes are the variable,
 * which for presence is most of the time. Each becomes a `validates`
 * underneath; nothing new happens here, and the options are merged in so
 * `{ on: "create" }` works as it does everywhere else.
 *
 * A free function rather than a static private method: a static `#name` is
 * reachable only on the exact class that declares it, and every model here is
 * a subclass of the one the mixin builds.
 */
function eachOf(
  model: { validates(attribute: string, options: ValidationOptions): void },
  names: string | readonly string[],
  options: ValidationOptions,
): void {
  for (const name of typeof names === "string" ? [names] : names) {
    model.validates(name, options);
  }
}

/**
 * One thing that went wrong, as an object rather than a string.
 *
 * Rails made this change for a reason worth keeping: a string cannot be asked
 * what *kind* of error it is. `"is too long (maximum is 25 characters)"` is
 * translated, so a caller matching on it breaks in every locale but one, and a
 * form that wants to style length errors differently from blank ones has
 * nothing to branch on. The type survives translation; the message does not.
 */
export class ValidationError {
  constructor(
    readonly attribute: string,
    readonly message: string,
    /** Rails' error `type` — `blank`, `too_long`, `taken`. */
    readonly type: string = "invalid",
    /** What the rule was given, so a message can be regenerated or inspected. */
    readonly options: Record<string, unknown> = {},
  ) {}

  /**
   * Whether this error is the one being asked about.
   *
   * A missing type matches any type, and each named option must match, so
   * `match("title", "too_long", { count: 25 })` is as narrow as the caller
   * makes it and no narrower.
   */
  match(attribute: string, type?: string, options: Record<string, unknown> = {}): boolean {
    if (this.attribute !== attribute) return false;
    if (type !== undefined && this.type !== type) return false;

    return Object.entries(options).every(([key, value]) => this.options[key] === value);
  }

  /** Rails' `details`: the type and whatever the rule was given. */
  get details(): Record<string, unknown> {
    return { error: this.type, ...this.options };
  }
}

/** Rails' `errors` object, in the shape apps actually use. */
export class ValidationErrors {
  #list: ValidationError[] = [];

  /**
   * Records an error.
   *
   * The type and options are optional so that every existing
   * `add(attribute, message)` call keeps working and reads the same; passing a
   * type is what makes the error inspectable later.
   */
  add(
    attribute: string,
    message: string,
    type = "invalid",
    options: Record<string, unknown> = {},
  ): void {
    this.#list.push(new ValidationError(attribute, message, type, options));
  }

  /** Every error object, in the order they were added. */
  get objects(): ValidationError[] {
    return [...this.#list];
  }

  /**
   * The errors matching an attribute, and optionally a type and options.
   * Rails' `where`.
   */
  where(
    attribute: string,
    type?: string,
    options: Record<string, unknown> = {},
  ): ValidationError[] {
    return this.#list.filter((one) => one.match(attribute, type, options));
  }

  /** The error objects for one attribute. Rails' `objects_for`. */
  objectsFor(attribute: string): ValidationError[] {
    return this.where(attribute);
  }

  /** The messages for one attribute, optionally narrowed by type. Rails' `messages_for`. */
  messagesFor(attribute: string, type?: string): string[] {
    return this.where(attribute, type).map((one) => one.message);
  }

  /** Every error object, grouped by attribute. Rails' `group_by_attribute`. */
  groupByAttribute(): Record<string, ValidationError[]> {
    const grouped: Record<string, ValidationError[]> = {};

    for (const error of this.#list) {
      (grouped[error.attribute] ??= []).push(error);
    }

    return grouped;
  }

  /**
   * What went wrong, by attribute, in machine-readable form. Rails' `details`.
   *
   * This is what an API renders instead of prose: a client deciding which field
   * to highlight, or whether to offer a "reset password" link because the error
   * was `taken` rather than `invalid`, cannot read a translated sentence.
   */
  details(): Record<string, Record<string, unknown>[]> {
    return Object.fromEntries(
      Object.entries(this.groupByAttribute()).map(([attribute, errors]) => [
        attribute,
        errors.map((one) => one.details),
      ]),
    );
  }

  /**
   * Whether an error of this kind is present. Rails' `of_kind?`.
   *
   * Takes a type or a whole message, because both are things a caller
   * legitimately has in hand — but the type is the one that survives a
   * translation.
   */
  ofKind(attribute: string, type = "invalid"): boolean {
    if (this.messagesFor(attribute).includes(type)) return true;

    return this.where(attribute, type).length > 0;
  }

  /** Takes another object's errors as its own. Rails' `import`. */
  importErrors(other: ValidationErrors, prefix?: string): void {
    for (const error of other.objects) {
      this.#list.push(
        new ValidationError(
          prefix ? `${prefix}.${error.attribute}` : error.attribute,
          error.message,
          error.type,
          error.options,
        ),
      );
    }
  }

  /** Replaces these errors with another object's. Rails' `copy!`. */
  copy(other: ValidationErrors): void {
    this.#list = other.objects;
  }

  get isEmpty(): boolean {
    return this.#list.length === 0;
  }

  get count(): number {
    return this.#list.length;
  }

  /** Rails calls it `size`. Both are here, because both get typed. */
  get size(): number {
    return this.count;
  }

  on(attribute: string): string[] {
    return this.messagesFor(attribute);
  }

  get attributes(): string[] {
    return [...new Set(this.#list.map((one) => one.attribute))];
  }

  /** Every message, by attribute. Rails' `messages`. */
  get messages(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(this.groupByAttribute()).map(([attribute, errors]) => [
        attribute,
        errors.map((one) => one.message),
      ]),
    );
  }

  /** Whether anything went wrong with this attribute. Rails' `include?`. */
  has(attribute: string): boolean {
    return this.#list.some((one) => one.attribute === attribute);
  }

  /** Whether this exact message was added. Rails' `added?`. */
  added(attribute: string, message: string): boolean {
    return this.on(attribute).includes(message);
  }

  /** Drops an attribute's errors and returns them. Rails' `delete`. */
  delete(attribute: string): string[] {
    const messages = this.on(attribute);
    this.#list = this.#list.filter((one) => one.attribute !== attribute);
    return messages;
  }

  /**
   * One message with its attribute in front of it. Rails' `full_message`.
   *
   * The attribute is humanized — `Title can't be blank`, not `title can't be
   * blank` — because these go straight into a page, and Rails' scaffolds,
   * translations and every screenshot of a Rails form show the humanized form.
   *
   * The joining is a translation too, under Rails' `errors.format` key: a
   * language that puts the attribute somewhere other than the front cannot be
   * served by string concatenation.
   */
  fullMessage(attribute: string, message: string): string {
    return t("errors.format", {
      default: "%{attribute} %{message}",
      attribute: humanAttributeName(attribute),
      message,
    });
  }

  fullMessages(): string[] {
    return this.#list.map((one) => this.fullMessage(one.attribute, one.message));
  }

  /** The full messages for one attribute. Rails' `full_messages_for`. */
  fullMessagesFor(attribute: string): string[] {
    return this.on(attribute).map((message) => this.fullMessage(attribute, message));
  }

  /** So `for (const { attribute, message } of errors)` works. */
  *[Symbol.iterator](): Iterator<{ attribute: string; message: string }> {
    for (const { attribute, message } of this.#list) yield { attribute, message };
  }

  toJSON(): Record<string, string[]> {
    return this.messages;
  }

  clear(): void {
    this.#list = [];
  }
}

/**
 * The records being validated right now, for the cycle guard.
 *
 * Scoped to the call rather than kept on the record, so two requests
 * validating the same rows at once cannot see each other's progress.
 */
const validating = new AsyncLocalStorage<Set<object>>();

const ATTRIBUTES = Symbol("altair.model.attributes");
const ORIGINAL = Symbol("altair.model.original");
// Instance state is symbol-keyed rather than `#private`. A private field is
// bound to the real object, and every access here goes through a Proxy, so
// `this.#field` inside a getter would throw "invalid private field".
const PERSISTED = Symbol("altair.model.persisted");
/**
 * What the last save changed.
 *
 * Kept because `changed()` is empty by the time an after-save callback runs —
 * the record is clean, which is the point. Rails added `saved_changes` for
 * exactly this: "the email changed, so send a confirmation" is an after-save
 * question and nothing else could answer it.
 */
const SAVED_CHANGES = Symbol("altair.model.savedChanges");
/** What was assigned, before any cast, for a form that has to show it back. */
const BEFORE_TYPE_CAST = Symbol("altair.model.beforeTypeCast");
const STRICT_LOADING = Symbol("altair.model.strictLoading");
/** Whether `destroy` has run, which "not persisted" alone cannot say. */
const DESTROYED = Symbol("altair.model.destroyed");
const NESTED = Symbol("altair.model.nested");
// Whether the last save was an insert. Read by the commit callbacks, which
// run after both kinds and have no other way to tell them apart.
const WAS_NEW = Symbol("altair.model.wasNew");

export interface ModelOptions {
  primaryKey?: string;
  /**
   * The columns that identify one row, when the primary key alone does not.
   * Rails' `query_constraints`.
   */
  queryConstraints?: string[];
  connection?: Connection;
}

/** The shape every model instance has, whatever its attributes. */
export interface BaseModelInstance<A> {
  readonly isNewRecord: boolean;
  readonly isPersisted: boolean;
  readonly errors: ValidationErrors;
  attributes(): A;
  /** Rails' `association_cached?`: whether reading it would cost a query. */
  associationCached(name: string): boolean;
  /** Rails' `proxy_association`: the definition behind an accessor. */
  proxyAssociation(name: string): AssociationDefinition | undefined;
  /** Rails' `foreign_key_present?`: whether there is anything to load. */
  foreignKeyPresent(name: string): boolean;
  /** Rails' `records_for`: what an association already holds. */
  recordsFor(name: string): unknown;
  /** Rails' `load_target`: loads it now and remembers it. */
  loadTarget(name: string): Promise<unknown>;

  /** Rails' `read_attribute`: a column's value, past any accessor. */
  readAttribute(name: string): unknown;
  /** Rails' `write_attribute`: sets it, past any accessor. */
  writeAttribute(name: string, value: unknown): void;
  /** Rails' `read_attribute_before_type_cast`: what was assigned. */
  readAttributeBeforeTypeCast(name: string): unknown;
  attributesBeforeTypeCast(): Record<string, unknown>;
  /** Rails' `read_attribute_for_database`: the value as it would be written. */
  readAttributeForDatabase(name: string): unknown;
  attributesForDatabase(): Record<string, unknown>;
  /** Rails' `attributes_for_inspect`: a short view, for a log line. */
  attributesForInspect(limit?: number): Record<string, unknown>;
  allAttributesForInspect(): Record<string, unknown>;
  changedAttributes(): Partial<A>;
  savedChanges(): Record<string, [unknown, unknown]>;
  hasAttribute(name: string): boolean;
  attributeNames(): string[];
  attributeInDatabase(name: string): unknown;
  attributesInDatabase(): Record<string, unknown>;
  attributeChangeToBeSaved(name: string): [unknown, unknown] | undefined;
  willSaveChangeToAttribute(name: string): boolean;
  hasChangesToSave(): boolean;
  changesToSave(): Record<string, [unknown, unknown]>;
  changedAttributeNamesToSave(): string[];
  readonly idInDatabase: unknown;
  readonly isDestroyed: boolean;
  updateColumns(values: Partial<A>): Promise<boolean>;
  updateColumn(column: keyof A & string, value: unknown): Promise<boolean>;
  increment(column: keyof A & string, by?: number): Promise<unknown>;
  decrement(column: keyof A & string, by?: number): Promise<unknown>;
  toggle(column: keyof A & string): Promise<unknown>;
  hasSavedChange(attribute?: keyof A & string): boolean;
  isAssociationLoaded(name: string): boolean;
  reloadAssociation(name: string): this;
  loadedAssociations(): string[];
  readonly isPreviouslyNewRecord: boolean;
  strictLoading(on?: boolean): this;
  readonly isStrictLoading: boolean;
  previousChanges(): Record<string, [unknown, unknown]>;
  attributePreviouslyChanged(attribute: keyof A & string): boolean;
  attributePreviouslyWas(attribute: keyof A & string): unknown;
  attributeChanged(attribute: keyof A & string): boolean;
  queryAttribute(attribute: keyof A & string): boolean;
  clearChangesInformation(): void;
  attributeBeforeLastSave(attribute: keyof A & string): unknown;
  changes(): Record<string, [unknown, unknown]>;
  changeToAttribute(attribute: keyof A & string): [unknown, unknown] | undefined;
  savedChangeToAttribute(attribute: keyof A & string): [unknown, unknown] | undefined;
  willSaveChangeTo(attribute: keyof A & string): boolean;
  restoreAttribute(attribute: keyof A & string): void;
  clearAttributeChanges(...attributes: (keyof A & string)[]): void;
  changed(): (keyof A & string)[];
  hasChanged(attribute?: keyof A & string): boolean;
  attributeWas(attribute: keyof A & string): unknown;
  restoreAttributes(attributes?: readonly (keyof A & string)[]): void;
  assign(values: Partial<A>): void;
  save(): Promise<boolean>;
  saveOrFail(): Promise<void>;
  update(values: Partial<A>): Promise<boolean>;
  destroy(): Promise<boolean>;
  reload(): Promise<void>;
  /** Runs the validations, optionally in a named context. Rails' `valid?`. */
  validate(context?: string): Promise<boolean>;
  /** Override to add validations. Push onto `this.errors` to fail. */
  runValidations(context?: string): Promise<void>;
  toJSON(): A;
  toParam(): string;
  cacheKey(): string;
  cacheVersion(): string | undefined;
  cacheKeyWithVersion(): string;
  /** Signs a token for one purpose. Rails' `generate_token_for`. */
  generateTokenFor(purpose: string): string;
  touch(...columns: string[]): Promise<void>;
  withLock<R>(body: () => Promise<R>): Promise<R>;
  serializableHash(options?: SerializationOptions): Record<string, unknown>;
  toPartialPath(): string;
  readonly modelName: ModelName;
}

/**
 * Builds a model base class for a table.
 *
 * The table name is inferred from the class name when it is omitted, following
 * Rails' convention — `class Post` reads and writes `posts`.
 */
/**
 * Raised when a record marked strict-loading is asked for an association that
 * was not preloaded.
 *
 * The N+1 guard. A list page reads `post.author` inside a loop, one query per
 * post, and nothing about the code says so — it looks exactly like reading an
 * attribute. Marking the query strict turns that into a failure at the moment
 * it happens rather than a graph in a dashboard three weeks later.
 */
/**
 * What a strict-loading violation does. Rails'
 * `config.active_record.action_on_strict_loading_violation`.
 *
 * `raise` by default, and `log` is what makes the feature adoptable: turning
 * strict loading on across an application that already has N+1s breaks every
 * page at once, so there is no way in from a standing start. In `log` mode the
 * violations are reported and the association still loads, which turns "we
 * cannot turn this on" into a list of things to fix.
 */
export type StrictLoadingAction = "raise" | "log";

let strictLoadingAction: StrictLoadingAction = "raise";

/** Sets what a violation does. */
export function configureStrictLoading(options: { onViolation: StrictLoadingAction }): void {
  strictLoadingAction = options.onViolation;
}

export function strictLoadingActionFor(): StrictLoadingAction {
  return strictLoadingAction;
}

export class StrictLoadingViolation extends Error {
  constructor(
    readonly model: string,
    readonly association: string,
  ) {
    super(
      `${model} is marked strict-loading, so "${association}" cannot be loaded here: ` +
        `it would be one query per record. Preload it with .includes("${association}").`,
    );
    this.name = "StrictLoadingViolation";
  }
}

/**
 * Whether an error is a unique-constraint violation.
 *
 * Matched on the codes the three databases use rather than on the message: a
 * message is localised, changes between versions, and differs per driver.
 * SQLite says SQLITE_CONSTRAINT_UNIQUE, PostgreSQL says 23505, MySQL says 1062.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  // Both fields, as strings. The drivers do not agree on which one carries the
  // database's own code: Bun's PostgreSQL driver puts the SQLSTATE in `errno`
  // and a generic `ERR_POSTGRES_SERVER_ERROR` in `code`, while SQLite puts its
  // code in `code` and MySQL puts a number in `errno`. Reading only `code`
  // meant this never recognised a PostgreSQL duplicate — which CI found the
  // first time these tests ran against one.
  const code = String((error as { code?: unknown }).code ?? "");
  const errno = String((error as { errno?: unknown }).errno ?? "");

  // SQLite.
  if (code.includes("SQLITE_CONSTRAINT_UNIQUE") || code.includes("SQLITE_CONSTRAINT_PRIMARYKEY")) {
    return true;
  }

  // PostgreSQL's unique_violation, and MySQL's ER_DUP_ENTRY.
  if (code === "23505" || errno === "23505") return true;
  if (code === "1062" || errno === "1062") return true;

  // Bun's SQLite driver reports the generic constraint code and puts the kind
  // in the message, so this is the one place a message is consulted — and only
  // after the codes have had their chance.
  const message = String((error as { message?: unknown }).message ?? "");

  return code === "SQLITE_CONSTRAINT" && /UNIQUE constraint failed/i.test(message);
}

/**
 * What a persisted model's `attribute` takes.
 *
 * Distinct from `AttributeOptions` in attributes.ts, which is the same idea for
 * a model with no table behind it: that one casts with a plain function, this
 * one with a `Type` from the registry, because a column has a precision and a
 * limit and a virtual attribute does not.
 */
export interface ModelAttributeOptions extends TypeOptions {
  /**
   * The value a new record starts with.
   *
   * A function for anything mutable — an array, an object, a timestamp —
   * since a value shared by every record built from this class is a bug that
   * shows up as one record's change appearing on another.
   */
  default?: unknown;
}

/** One attribute a model declared for itself. */
export interface DeclaredAttribute {
  type: Type;
  /** The name it was declared with, for a caller reporting on the schema. */
  typeName: string;
  default?: unknown;
}

/**
 * Records what a caller assigned, before the model changed it.
 *
 * Only where the model actually transforms on assignment — an enum turning a
 * word into an integer, a normaliser trimming a string. A plain column keeps
 * what was assigned as it was, so recording it would be storing the same value
 * twice under two names.
 */
function rememberBeforeCast(record: object, attribute: string, value: unknown): void {
  const holder = record as { [BEFORE_TYPE_CAST]?: Record<string, unknown> };
  const held = holder[BEFORE_TYPE_CAST];

  if (held) held[attribute] = value;
  else holder[BEFORE_TYPE_CAST] = { [attribute]: value };
}

/** Cuts a value down to something a log line can carry. */
function truncateForInspect(value: unknown, limit: number): unknown {
  if (typeof value !== "string" || value.length <= limit) return value;

  return `${value.slice(0, limit)}...`;
}

export function Model<A extends object>(tableName?: string, options: ModelOptions = {}) {
  class BaseModel extends Callbacks {
    static tableName = tableName ?? "";
    static primaryKey = options.primaryKey ?? "id";

    /**
     * The columns that identify one row. Rails' `query_constraints`.
     *
     * Undefined means the primary key alone, which is nearly always right.
     * Naming more is for a table where it is not: a legacy schema keyed on a
     * pair, or a sharded one where `(tenant_id, id)` identifies a row and `id`
     * alone identifies one per tenant.
     *
     * The consequence of getting this wrong is not a failed save. An UPDATE
     * whose WHERE names too few columns matches the wrong row, or several, and
     * writes to all of them — so a save against such a table without this
     * silently edits somebody else's record and reports success.
     */
    static queryConstraints: string[] | undefined = options.queryConstraints;
    static connectionOverride: Connection | undefined = options.connection;
    static columnCache: string[] | undefined;
    static columnTypeCache: Record<string, ColumnType> | undefined;
    static associations: Record<string, AssociationDefinition> = {};
    static validations: ValidationDeclaration[] = [];
    /** Rules the application wrote itself. Rails' `validates_with`. */
    static customValidations: CustomValidation[] = [];

    /** The column optimistic locking uses, when the table has one. */
    static lockingColumn = "lock_version";

    /** Rails' `model_name`, on the class as well as the record. */
    static get modelName(): ModelName {
      return modelNameFor(this);
    }

    /** The column single-table inheritance stores the class name in. */
    static inheritanceColumn = "type";

    /** Subclasses that share this table, keyed by the name in `type`. */
    static descendants: Record<string, typeof BaseModel> = {};

    /** The class at the top of an STI hierarchy, on every subclass of it. */
    static stiRoot: typeof BaseModel | undefined;

    /**
     * Joins the parent's table as a single-table-inheritance subclass.
     *
     *     class Car extends Vehicle {
     *       static { this.inherit() }
     *     }
     *
     * Rails discovers subclasses through Ruby's `inherited` hook. JavaScript
     * has no equivalent, so this is the one line that cannot be inferred: a
     * class that is never mentioned cannot be found by name when a row's
     * `type` column says to build one.
     */
    static inherit(): void {
      const parent = Object.getPrototypeOf(this) as typeof BaseModel;
      const root = parent.stiRoot ?? parent;

      this.stiRoot = root;
      // The subclass reads and writes the root's table, which is what makes
      // this single-table inheritance rather than two tables.
      this.tableName = root.table;
      this.columnCache = undefined;
      this.columnTypeCache = undefined;

      // Copy on write, so a hierarchy under one root cannot see another's.
      if (!Object.hasOwn(root, "descendants")) root.descendants = { ...root.descendants };
      root.descendants[this.name] = this;
    }

    /** This class and every subclass of it, as they appear in `type`. */
    static stiNames(): string[] {
      const root = this.stiRoot ?? this;
      const names = [this.name];

      for (const [name, klass] of Object.entries(root.descendants)) {
        if (klass !== this && klass.prototype instanceof this) names.push(name);
      }

      return names;
    }

    /** Whether this table stores a `type` column that STI should honour. */
    static async usesInheritance(): Promise<boolean> {
      return (await this.columnNames()).includes(this.inheritanceColumn);
    }

    static async lockingEnabled(): Promise<boolean> {
      return (await this.columnNames()).includes(this.lockingColumn);
    }

    /** Columns held as ciphertext. Rails' `encrypts`. */
    static encryptedAttributes: Record<string, EncryptedAttributeOptions> = {};
    /**
     * Attributes whose setter writes a second column from the first.
     *
     * A row already holds both, so hydrating through the setter would derive
     * the second one again from a value that is already derived.
     */
    static derivedAttributes: Record<string, boolean> = {};

    /** Whether this attribute's setter derives another column. */
    static derivedOnWrite(name: string): boolean {
      return this.derivedAttributes[name] === true;
    }
    static enums: Record<string, EnumDefinition> = {};
    static normalizers: Record<string, NormalizeDefinition> = {};

    /**
     * Encrypts a column. Rails' `encrypts :ssn`.
     *
     * The application still reads and writes the plain value; the column holds
     * the ciphertext. A deterministic column can be queried, at the cost of
     * revealing which rows share a value.
     */
    /**
     * Maps a column of integers onto words. Rails' `enum`.
     *
     *     static { this.enum("status", { draft: 0, published: 1 }) }
     *
     * The column keeps the integer, so the index stays small; everything that
     * reads the record sees the word, so nothing else has to keep its own copy
     * of what 1 meant.
     */
    static enum(attribute: string, mapping: EnumMapping, options: EnumOptions = {}): void {
      if (!Object.hasOwn(this, "enums")) this.enums = { ...this.enums };

      const definition = defineEnum(attribute, mapping, options);
      this.enums[attribute] = definition;

      // An accessor on the prototype, so the Proxy resolves it rather than
      // reaching for the raw attribute — the same way a secure password does.
      Object.defineProperty(this.prototype, attribute, {
        configurable: true,
        get(this: BaseModel) {
          return labelFor(definition, this[ATTRIBUTES][attribute]);
        },
        set(this: BaseModel, value: unknown) {
          rememberBeforeCast(this, attribute, value);
          this[ATTRIBUTES][attribute] = storedValueFor(definition, value);
        },
      });

      for (const label of Object.keys(mapping)) {
        const member = memberName(definition, label);

        // `post.isPublished`
        Object.defineProperty(this.prototype, `is${member[0]?.toUpperCase()}${member.slice(1)}`, {
          configurable: true,
          get(this: BaseModel) {
            return this[ATTRIBUTES][attribute] === mapping[label];
          },
        });

        // `await post.published()` — Rails' `published!`, which saves.
        Object.defineProperty(this.prototype, member, {
          configurable: true,
          value: async function (this: BaseModel & { save(): Promise<boolean> }) {
            this[ATTRIBUTES][attribute] = mapping[label];
            return await this.save();
          },
        });

        // `Post.published()` — the scope.
        Object.defineProperty(this, member, {
          configurable: true,
          value: function (this: typeof BaseModel) {
            return this.where({ [attribute]: mapping[label] });
          },
        });
      }
    }

    /**
     * Tidies a value on the way in, and in the lookups. Rails' `normalizes`.
     *
     *     static { this.normalizes("email", (value) => value.trim().toLowerCase()) }
     *
     * Both halves matter. Normalizing only on write leaves a table of tidy
     * values that a signup form can still duplicate, because the uniqueness
     * check went looking for the untidy version and found nothing.
     */
    static normalizes<V = string>(
      attribute: string,
      normalize: (value: V) => unknown,
      options: NormalizeOptions = {},
    ): void {
      if (!Object.hasOwn(this, "normalizers")) this.normalizers = { ...this.normalizers };

      const definition = defineNormalizer(attribute, normalize as Normalizer, options);
      this.normalizers[attribute] = definition;

      // An accessor on the prototype, so an assignment is normalized wherever
      // it comes from — the constructor, `assign`, or a bare `record.email =`.
      Object.defineProperty(this.prototype, attribute, {
        configurable: true,
        get(this: BaseModel) {
          return this[ATTRIBUTES][attribute];
        },
        set(this: BaseModel, value: unknown) {
          rememberBeforeCast(this, attribute, value);
          this[ATTRIBUTES][attribute] = normalizeValue(definition, value);
        },
      });
    }

    /** Columns holding a serialized structure. */
    static serializedColumns: Record<string, { parse: (raw: string) => unknown }> = {};

    /**
     * A column that holds a structure rather than a value. Rails' `serialize`.
     *
     *     static { this.serialize("preferences") }
     *
     *     user.preferences.theme      // read as an object
     *     user.preferences = { … }    // written as JSON
     *
     * A text column comes back from every driver as a string, so without this
     * the application gets `'{"theme":"dark"}'` and reaches for `.theme` on
     * it. Writing already worked — a value the database cannot store is
     * serialized on the way in — so this is mostly the other half.
     */
    static serialize(column: string, coder: { parse: (raw: string) => unknown } = JSON): void {
      // Copy on write, so a subclass adding one leaves its parent alone.
      if (!Object.hasOwn(this, "serializedColumns")) {
        this.serializedColumns = { ...this.serializedColumns };
      }

      this.serializedColumns[column] = coder;

      Object.defineProperty(this.prototype, column, {
        configurable: true,
        get(this: BaseModel) {
          const raw = this[ATTRIBUTES][column];
          if (typeof raw !== "string") return raw;

          try {
            const parsed = coder.parse(raw);
            // Kept, so reading twice gives the same object and a change made
            // through the first read is visible through the second.
            this[ATTRIBUTES][column] = parsed;
            return parsed;
          } catch {
            // A row someone edited by hand should not take down a page.
            return null;
          }
        },
        set(this: BaseModel, value: unknown) {
          this[ATTRIBUTES][column] = value;
        },
      });
    }

    /**
     * A serialized column with named accessors. Rails' `store`.
     *
     *     static { this.store("settings", ["theme", "locale"]) }
     *     user.theme = "dark"
     */
    static store(column: string, accessors: string[] = []): void {
      this.serialize(column);

      for (const key of accessors) {
        Object.defineProperty(this.prototype, key, {
          configurable: true,
          get(this: Record<string, Record<string, unknown> | null>) {
            return this[column]?.[key] ?? null;
          },
          set(this: Record<string, Record<string, unknown> | null>, value: unknown) {
            const held = this[column] ?? {};
            held[key] = value;
            this[column] = held;
          },
        });
      }
    }

    /** Runs a value through this model's normalizer for a column, if it has one. */
    static normalizeValueFor(attribute: string, value: unknown): unknown {
      const definition = this.normalizers[attribute];
      return definition ? normalizeValue(definition, value) : value;
    }

    /** Rewrites `{ status: "draft" }` into what the column holds. */
    static enumConditions(conditions: Conditions): Conditions {
      if (Object.keys(this.enums).length === 0) return conditions;

      const prepared: Record<string, unknown> = {};

      for (const [column, value] of Object.entries(conditions)) {
        const definition = this.enums[column];

        if (!definition) {
          prepared[column] = value;
          continue;
        }

        // An array is an IN, so every member maps.
        prepared[column] = Array.isArray(value)
          ? value.map((one) => storedValueFor(definition, one))
          : storedValueFor(definition, value);
      }

      return prepared;
    }

    static encrypts(name: string, options: EncryptedAttributeOptions = {}): void {
      if (!Object.hasOwn(this, "encryptedAttributes")) {
        this.encryptedAttributes = { ...this.encryptedAttributes };
      }
      this.encryptedAttributes[name] = options;

      if (options.ignoreCase !== true) return;

      // Named so the constructor can leave a hydrated row alone; see there.
      this.derivedAttributes = { ...this.derivedAttributes, [name]: true };

      const original = originalAttributeName(name);

      // Encrypted too, and not deterministically: it is the same secret, and
      // storing the original in the clear beside the ciphertext would hand
      // back everything the encryption was for.
      this.encryptedAttributes[original] = {};

      // An accessor on the prototype, so both halves are kept wherever the
      // assignment came from — the constructor, `assign`, or a bare
      // `record.email = …`. Doing it at persist time instead would mean three
      // write paths to change and one of them forgotten.
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        get(this: BaseModel) {
          const kept = this[ATTRIBUTES][original];

          // The folded column is the fallback, not the answer: a row written
          // before the option was added has no original to show.
          return kept === undefined || kept === null ? this[ATTRIBUTES][name] : kept;
        },
        set(this: BaseModel, value: unknown) {
          // Both hold the value as it was typed. The folding happens once, in
          // `encryptValue`, on the column whose scheme asks for it — doing it
          // here as well would be a second place to get it wrong, and would
          // make the in-memory record disagree with what it reads back.
          this[ATTRIBUTES][original] = value;
          this[ATTRIBUTES][name] = value;
        },
      });
    }

    /** Encrypts the values in a condition that name a deterministic column. */
    /**
     * How to reach an association's table from this one.
     *
     * The relation asks rather than guessing: only the model knows which
     * column points where, and a query that invented a foreign key would join
     * the wrong rows rather than failing.
     */
    static joinFor(name: string): JoinSpec {
      const definition = this.associationFor(name);

      if (definition.through) {
        throw new Error(
          `"${name}" reaches its target through "${definition.through}", so joining it means joining both. Join them by name.`,
        );
      }

      if (definition.polymorphic) {
        throw new Error(
          `"${name}" is polymorphic, so there is no one table to join. Query the target model instead.`,
        );
      }

      const target = definition.target();

      if (definition.kind === "belongsTo") {
        return {
          table: target.table,
          from: definition.foreignKey ?? defaultForeignKey(target.name),
          to: definition.primaryKey ?? target.primaryKey,
        };
      }

      // hasMany and hasOne: the key is on the other table, pointing back here.
      const spec: JoinSpec = {
        table: target.table,
        from: definition.primaryKey ?? this.primaryKey,
        to: definition.as
          ? `${definition.as}_id`
          : (definition.foreignKey ?? defaultForeignKey(this.name)),
      };

      // The type column belongs in the ON clause: on a left join, a WHERE on
      // it would drop the rows the left join exists to keep.
      if (definition.as) {
        spec.where = [{ column: `${definition.as}_type`, value: this.name }];
      }

      return spec;
    }

    /** One value, encrypted if its column is. */
    static encryptFor(attribute: string, value: unknown): unknown {
      const options = this.encryptedAttributes[attribute];
      return options ? encryptValue(value, options) : value;
    }

    static encryptConditions(conditions: Conditions): Conditions {
      const encrypted = Object.keys(this.encryptedAttributes);
      if (encrypted.length === 0) return conditions;

      const prepared: Record<string, unknown> = {};

      for (const [column, value] of Object.entries(conditions)) {
        const options = this.encryptedAttributes[column];

        // Only a deterministic column can be matched: a random nonce means the
        // same value encrypts differently every time, so there is nothing to
        // compare against.
        if (!options?.deterministic || value === null || value === undefined) {
          prepared[column] = value;
          continue;
        }

        prepared[column] = Array.isArray(value)
          ? value.map((one) => encryptValue(one, options))
          : encryptValue(value, options);
      }

      return prepared as Conditions;
    }

    /** Associations that may be written through this model's own attributes. */
    static nestedAttributes: Record<string, NestedAttributesOptions> = {};

    /**
     * Lets a form write an association through this model.
     *
     *     Post.acceptsNestedAttributesFor("comments", { allowDestroy: true })
     *
     * Rails' `accepts_nested_attributes_for`. Nothing is writable this way
     * unless it is named here, which is what keeps a submitted hash from
     * reaching arbitrary tables.
     */
    static acceptsNestedAttributesFor(name: string, options: NestedAttributesOptions = {}): void {
      // Fails here rather than at save time, when the error would be about a
      // column that does not exist.
      this.associationFor(name);

      if (!Object.hasOwn(this, "nestedAttributes")) {
        this.nestedAttributes = { ...this.nestedAttributes };
      }
      this.nestedAttributes[name] = options;
    }

    /** Associations whose records are validated with this one. */
    static associatedValidations: string[] = [];

    /**
     * Validates the records an association holds. Rails'
     * `validates_associated`.
     *
     *     static { this.validatesAssociated("comments") }
     *
     * For the case where saving the parent is meant to save the children with
     * it — nested attributes, most often. Without it a form builds three
     * comments, one of them blank, and the save reports success while the
     * blank one is silently dropped or written empty.
     *
     * Only what is already loaded is checked. Reaching for the association
     * would turn every validation of every record into a query, and the
     * records a form just built are in memory anyway — which is the case this
     * exists for.
     */
    static validatesAssociated(...names: string[]): void {
      // Copy on write, so a subclass adding one leaves its parent alone.
      if (!Object.hasOwn(this, "associatedValidations")) {
        this.associatedValidations = [...this.associatedValidations];
      }

      this.associatedValidations.push(...names);
    }

    /**
     * Declares validations for an attribute. Rails' `validates`.
     *
     *     this.validates("title", { presence: true, length: { minimum: 3 } })
     */
    static validates(attribute: string, options: ValidationOptions): void {
      // Copy on write, so a subclass adding validations leaves the parent alone.
      if (!Object.hasOwn(this, "validations")) this.validations = [...this.validations];
      this.validations.push({ attribute, options });
    }

    /**
     * Adds a rule the application wrote itself. Rails' `validates_with`.
     *
     *     this.validatesWith(new NotOverlapping({ column: "period" }))
     *
     * An object rather than a class, because a validator that takes options
     * is configured when it is declared and there is nothing for the framework
     * to do with a constructor it would have to guess the arguments of.
     */
    static validatesWith(validator: Validator, options: ValidationOptions = {}): void {
      // Refused here rather than at run time, so a rule configured wrongly
      // says so on the first request rather than the first time a record
      // happens to reach it — months, for a rare branch.
      validator.checkValidity?.();

      if (!Object.hasOwn(this, "customValidations")) {
        this.customValidations = [...this.customValidations];
      }

      this.customValidations.push({ validator, options });
    }

    /**
     * Runs a rule against each of several attributes. Rails' `validates_each`.
     *
     *     this.validatesEach(["title", "body"], (record, attribute, value) => {
     *       if (typeof value === "string" && value.includes("	")) {
     *         record.errors.add(attribute, "cannot contain tabs")
     *       }
     *     })
     *
     * The shape for a check that is the same for several columns and worth
     * writing once, where a whole validator class would be more ceremony than
     * the rule deserves.
     */
    static validatesEach(
      attributes: string | readonly string[],
      body: (record: ValidationTarget, attribute: string, value: unknown) => void | Promise<void>,
      options: ValidationOptions = {},
    ): void {
      const names = typeof attributes === "string" ? [attributes] : [...attributes];

      if (names.length === 0) {
        throw new Error("validatesEach needs at least one attribute to check.");
      }

      if (!Object.hasOwn(this, "customValidations")) {
        this.customValidations = [...this.customValidations];
      }

      this.customValidations.push({
        validator: { validateEach: body } as unknown as Validator,
        attributes: names,
        options,
      });
    }

    /** Rails' `validates_presence_of`. */
    static validatesPresenceOf(
      names: string | readonly string[],
      options: Omit<ValidationOptions, "presence" | "absence" | "confirmation" | "acceptance"> = {},
    ): void {
      eachOf(this, names, { ...options, presence: true });
    }

    /** Rails' `validates_absence_of`. */
    static validatesAbsenceOf(
      names: string | readonly string[],
      options: Omit<ValidationOptions, "presence" | "absence" | "confirmation" | "acceptance"> = {},
    ): void {
      eachOf(this, names, { ...options, absence: true });
    }

    /** Rails' `validates_confirmation_of`. */
    static validatesConfirmationOf(
      names: string | readonly string[],
      options: Omit<ValidationOptions, "presence" | "absence" | "confirmation" | "acceptance"> = {},
    ): void {
      eachOf(this, names, { ...options, confirmation: true });
    }

    /** Rails' `validates_acceptance_of`. */
    static validatesAcceptanceOf(
      names: string | readonly string[],
      options: Omit<ValidationOptions, "presence" | "absence" | "confirmation" | "acceptance"> = {},
    ): void {
      eachOf(this, names, { ...options, acceptance: true });
    }

    /** Rails' `validates_length_of`. */
    static validatesLengthOf(
      names: string | readonly string[],
      rule: LengthOptions = {} as LengthOptions,
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, length: rule });
    }

    /** Rails' `validates_format_of`. */
    static validatesFormatOf(
      names: string | readonly string[],
      rule: { with?: RegExp; without?: RegExp } = {} as { with?: RegExp; without?: RegExp },
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, format: rule });
    }

    /** Rails' `validates_inclusion_of`. */
    static validatesInclusionOf(
      names: string | readonly string[],
      rule: { in: readonly unknown[] } = {} as { in: readonly unknown[] },
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, inclusion: rule });
    }

    /** Rails' `validates_exclusion_of`. */
    static validatesExclusionOf(
      names: string | readonly string[],
      rule: { in: readonly unknown[] } = {} as { in: readonly unknown[] },
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, exclusion: rule });
    }

    /** Rails' `validates_comparison_of`. */
    static validatesComparisonOf(
      names: string | readonly string[],
      rule: ComparisonOptions = {} as ComparisonOptions,
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, comparison: rule });
    }

    /** Rails' `validates_numericality_of`. */
    static validatesNumericalityOf(
      names: string | readonly string[],
      rule: NumericalityOptions = {} as NumericalityOptions,
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, numericality: rule });
    }

    /** Rails' `validates_uniqueness_of`. */
    static validatesUniquenessOf(
      names: string | readonly string[],
      rule: { scope?: string | string[] } = {} as { scope?: string | string[] },
      options: ValidationOptions = {},
    ): void {
      eachOf(this, names, { ...options, uniqueness: rule });
    }

    /**
     * The validations declared for one attribute. Rails' `validators_on`.
     *
     * For a form builder deciding whether to mark a field required, or a
     * serializer describing its own constraints — anything that would
     * otherwise be handed a list that then drifts from the model.
     */
    static validatorsOn(attribute: string): ValidationOptions[] {
      return this.validations
        .filter((one) => one.attribute === attribute)
        .map((one) => one.options);
    }

    /** Every validation declared, whatever the attribute. Rails' `validators`. */
    static validators(): ValidationDeclaration[] {
      return [...this.validations];
    }

    /**
     * Drops every validation on this class. Rails' `clear_validators!`.
     *
     * For tests that need a model to save something the rules forbid. Copy on
     * write like the declarations themselves, so clearing on a subclass leaves
     * the parent's rules intact rather than silently disarming every sibling.
     */
    static clearValidators(): void {
      this.validations = [];
    }

    static {
      this.defineCallbacks(["save", "create", "update", "destroy", "validation"]);
    }

    declare [ATTRIBUTES]: Record<string, unknown>;
    declare [ORIGINAL]: Record<string, unknown>;
    declare [SAVED_CHANGES]: Record<string, [unknown, unknown]> | undefined;
    /**
     * What was assigned before any cast, keyed by column.
     *
     * Only populated for values a caller assigned: what came out of the
     * database has no earlier form, and recording one would be recording the
     * cast value twice under two names.
     */
    declare [BEFORE_TYPE_CAST]: Record<string, unknown> | undefined;
    declare [STRICT_LOADING]: boolean | undefined;
    declare [DESTROYED]: boolean | undefined;

    declare [PERSISTED]: boolean;
    declare [NESTED]: Record<string, unknown>;
    /** Whether the save that just ran was an insert. Read by commit callbacks. */
    declare [WAS_NEW]: boolean;
    readonly errors = new ValidationErrors();

    constructor(values: Partial<A> = {}, persisted = false) {
      super();
      const klass = this.constructor as typeof BaseModel;

      // `comments_attributes` is not a column, so it has to come out before
      // anything treats these values as a row.
      const { attributes, nested } =
        Object.keys(klass.nestedAttributes).length > 0
          ? extractNested(values as Record<string, unknown>, klass.nestedAttributes)
          : { attributes: values as Record<string, unknown>, nested: {} };

      // A value naming a property the class defines — a password, say — goes
      // through that property rather than into the attributes, or it would be
      // written to the table as a column of its own.
      const declared: Record<string, unknown> = {};
      const columns: Record<string, unknown> = {};

      // Declared defaults go in first, so anything the caller passed overrides
      // them. A new record therefore carries its defaults before it is saved —
      // which is the point: a database default only exists after an INSERT, so
      // a form rendered from `Model.build()` would show an empty field for a
      // value that is about to become 0.
      if (!persisted) {
        for (const [name, definition] of Object.entries(klass.declaredAttributes)) {
          if (definition.default === undefined) continue;

          columns[name] =
            typeof definition.default === "function"
              ? (definition.default as () => unknown)()
              : definition.default;
        }
      }

      for (const [key, value] of Object.entries(attributes)) {
        // Through the alias here too: the constructor writes columns directly
        // rather than through the proxy, so an alias resolved only there would
        // work for `record.email = x` and not for `new User({ email: x })`.
        //
        // A row is the exception. A hydrated record already carries every
        // column the setter would have derived, and running it would derive
        // them again from a value that is itself already derived — for an
        // `ignoreCase` attribute that means overwriting the original spelling
        // with the folded one it was stored beside precisely to preserve.
        if (hasSetter(this, key) && !(persisted && klass.derivedOnWrite(key)))
          declared[key] = value;
        else columns[klass.resolveAttributeName(key)] = value;
      }

      this[ATTRIBUTES] = columns;
      this[ORIGINAL] = persisted ? { ...columns } : {};
      this[PERSISTED] = persisted;
      this[NESTED] = nested;

      // ponytail: a Proxy gives attribute access without knowing the columns
      // up front. Generating accessors from the schema at codegen time would be
      // faster; swap it in when the CLI can emit them.
      const record = new Proxy(this, PROXY_HANDLER) as this;

      // Through the proxy, so the setter the class defined actually runs.
      for (const [key, value] of Object.entries(declared)) {
        (record as unknown as Record<string, unknown>)[key] = value;
      }

      return record;
    }

    static get table(): string {
      if (this.tableName) return this.tableName;
      // Rails' convention: Post -> posts, LineItem -> line_items.
      this.tableName = tableize(this.name);
      return this.tableName;
    }

    /** The database this model reads and writes, when it is not the primary. */
    static databaseName: string | undefined;

    /**
     * Points this model at a named database. Rails' `connects_to`.
     *
     *     class Event extends Model<EventRow>("events") {
     *       static { this.connectsTo({ database: "analytics" }) }
     *     }
     */
    static connectsTo(options: { database: string }): void {
      this.databaseName = options.database;
    }

    static get connection(): Connection {
      if (this.connectionOverride) return this.connectionOverride;

      // A model pinned to a named database still follows the role in force, so
      // a `connected_to({ role: "reading" })` block reaches its replica too.
      if (this.databaseName && hasDatabases()) {
        return database(this.databaseName, currentScope()?.role ?? ("writing" as Role));
      }

      return defaultConnection();
    }

    /**
     * Whether records of this class refuse to load associations lazily.
     *
     * Rails' `strict_loading_by_default`. Off, because turning it on for an
     * existing application breaks every page at once; a new one should turn it
     * on in development and leave it on.
     */
    static strictLoadingByDefault = false;

    /** Second names for columns, by alias. Rails' `attribute_aliases`. */
    static attributeAliases: Record<string, string> = {};

    /** Attributes the model declared for itself. Rails' `attribute`. */
    static declaredAttributes: Record<string, DeclaredAttribute> = {};

    /**
     * A second name for a column. Rails' `alias_attribute`.
     *
     *     class User extends Model<UserRow>("users") {
     *       static { this.aliasAttribute("email", "email_address_txt") }
     *     }
     *
     * For the schema you did not choose and cannot change — a legacy table, a
     * column named by an import, a name a vendor owns. The alternative is the
     * bad name spreading through every view and controller that touches it,
     * which is how a rename stops being possible.
     *
     * Reading, writing and `where` all follow the alias. Ordering, `pluck` and
     * raw SQL do not: those take a column name straight through to the
     * database, and rewriting strings that might be expressions is how a query
     * builder starts guessing.
     */
    /**
     * Declares an attribute's type, and optionally a default. Rails'
     * `attribute`.
     *
     *     static { this.attribute("price", "integer", { default: 0 }) }
     *     static { this.attribute("published", "boolean") }
     *
     * Three things it does, and each is a real need:
     *
     *   - **Overrides a column's type.** A legacy table storing a number in a
     *     varchar, a boolean kept as `"Y"`/`"N"`. Without this the application
     *     compares strings everywhere and one comparison eventually forgets.
     *   - **Declares an attribute with no column.** A value assembled from
     *     others that still has to be assigned, validated and read back the
     *     same way a column is.
     *   - **Gives a default that exists before the insert.** A database
     *     default only applies once the row is written, so a form rendered
     *     from an unsaved record shows an empty field for a value that is
     *     about to become 0.
     *
     * The default may be a function, which is how a mutable one — an array, an
     * object, a timestamp — avoids being shared by every record built from
     * this class.
     */
    static attribute(name: string, type: string, options: ModelAttributeOptions = {}): void {
      // Copy on write, like the aliases and the validations, so declaring on a
      // subclass leaves the parent alone.
      if (!Object.hasOwn(this, "declaredAttributes")) {
        this.declaredAttributes = { ...this.declaredAttributes };
      }

      // Refused rather than left to fall back. `lookupType` deliberately gives
      // the base type for a name it does not know, which is right for a column
      // whose database type nobody taught the ORM — but this name was typed by
      // hand on purpose, so an unrecognised one is a typo, and silently
      // reading the column uncast is exactly the bug declaring a type was
      // meant to prevent.
      if (!typeRegistered(type)) {
        throw new Error(
          `Unknown attribute type "${type}" for ${this.name}.${name}. ` +
            `Known types: ${typeNames().join(", ")}.`,
        );
      }

      const built = lookupType(type, options);

      this.declaredAttributes[name] = { type: built, typeName: type, default: options.default };
    }

    /** The `Type` a declared attribute casts with, or undefined. */
    static declaredTypeFor(name: string): Type | undefined {
      return this.declaredAttributes[name]?.type;
    }

    /** The names this model declared, in the order they were declared. */
    static declaredAttributeNames(): string[] {
      return Object.keys(this.declaredAttributes);
    }

    static aliasAttribute(alias: string, column: string): void {
      // Copy on write, so declaring on a subclass leaves the parent alone —
      // the same rule the callbacks and associations follow.
      if (!Object.hasOwn(this, "attributeAliases")) {
        this.attributeAliases = { ...this.attributeAliases };
      }

      if (alias === column) {
        throw new Error(
          `"${alias}" cannot be an alias for itself: reading it would look itself up forever.`,
        );
      }

      this.attributeAliases[alias] = column;
    }

    /** The column a name means here, following an alias if there is one. */
    /**
     * The columns a statement must name to reach exactly this row. Rails'
     * `query_constraints_list`.
     *
     * The primary key when nothing else was declared, so every existing model
     * behaves as it did and only a model that says otherwise pays for it.
     */
    static queryConstraintsList(): string[] {
      return this.queryConstraints ?? [this.primaryKey];
    }

    static resolveAttributeName(name: string): string {
      return this.attributeAliases[name] ?? name;
    }

    /** Conditions with any aliased key replaced by the column it stands for. */
    static aliasConditions(conditions: Conditions): Conditions {
      if (Object.keys(this.attributeAliases).length === 0) return conditions;
      if (typeof conditions !== "object" || conditions === null) return conditions;

      return Object.fromEntries(
        Object.entries(conditions as Record<string, unknown>).map(([key, value]) => [
          this.resolveAttributeName(key),
          value,
        ]),
      ) as Conditions;
    }

    static all<M extends typeof BaseModel>(this: M): Relation<InstanceType<M>> {
      let relation = this.unscoped();

      // A subclass sees only its own rows and its subclasses'. The root sees
      // everything, which is what makes `Vehicle.all()` return cars and trucks.
      if (this.stiRoot !== undefined) {
        relation = relation.where({ [this.inheritanceColumn]: this.stiNames() });
      }

      for (const scope of this.defaultScopes) {
        relation = scope(relation as unknown as Relation<unknown>) as unknown as Relation<
          InstanceType<M>
        >;
      }

      return relation;
    }

    /** Conditions every query on this model starts with. */
    static defaultScopes: ((relation: Relation<unknown>) => Relation<unknown>)[] = [];

    /**
     * Narrows every query on this model. Rails' `default_scope`.
     *
     *     static { this.defaultScope((posts) => posts.whereNot({ deleted_at: null })) }
     *
     * The usual reason is a soft delete: a deleted row is still there, and
     * every query that forgot to say so would find it. Declaring it once is
     * the only way that stays true as queries are added.
     *
     * A default scope also fills in what `create` writes, as Rails' does, and
     * only from equality conditions — `where({ archived: true })` seeds
     * `archived`, while a range, a list or raw SQL seeds nothing, since there
     * is no one value those mean.
     *
     * This used to narrow reads and nothing else, on the reasoning that Rails'
     * seeding is the most complained-about behaviour in ActiveRecord. That
     * reasoning does not survive looking at what the alternative does:
     * `Draft.create(...)` made a record `Draft` could not then find. A record
     * you cannot see is a worse surprise than an attribute you declared, and
     * it reads as a persistence bug rather than as a scope doing its job.
     *
     * The complaints are about using a default scope to filter rather than to
     * define — `where(archived: true)` on a model that is not "the archived
     * ones". That is a misuse, and Rails' own guides warn about it. For the
     * correct use, seeding is what makes the feature coherent: the scope says
     * what one of these is, so creating one should make one.
     *
     * `unscoped` escapes both halves.
     */
    /**
     * The relation `all` builds, named. Rails' `default_scoped`.
     *
     * The same thing `all` returns, but saying so at the call site: code that
     * means "with the default scopes applied" reads better than code that
     * means "everything" and happens to be right for the same reason.
     */
    static defaultScoped<M extends typeof BaseModel>(this: M): Relation<InstanceType<M>> {
      return this.all();
    }

    /**
     * A relation matching nothing, without asking the database. Rails'
     * `none` / `null_relation`.
     *
     * For a guard clause that has decided there is nothing to show. Returning
     * an empty array instead would give the caller something that is not a
     * relation, so every `.order(...)` after the guard would have to be
     * conditional too.
     */
    static nullRelation<M extends typeof BaseModel>(this: M): Relation<InstanceType<M>> {
      return this.all().none();
    }

    /** Rails calls it `empty_scope`. Same relation. */
    static emptyScope<M extends typeof BaseModel>(this: M): Relation<InstanceType<M>> {
      return this.nullRelation();
    }

    /**
     * The attributes a record built from the current scope starts with. Rails'
     * `scope_for_create`.
     *
     * What makes `author.books.create(title)` set the author without being
     * told: every equality condition on the relation becomes a default.
     */
    static scopeForCreate<M extends typeof BaseModel>(this: M): Record<string, unknown> {
      return this.all().whereValues();
    }

    /**
     * Runs a block with the default scopes off. Rails' `unscoped { }`.
     *
     * The block form matters for the same reason `silence` takes one: a flag
     * set and unset by hand stays set when something in between throws, and a
     * process that has quietly lost its default scope starts returning soft-
     * deleted rows to everybody.
     */
    static async withUnscoped<M extends typeof BaseModel, T>(
      this: M,
      body: (relation: Relation<InstanceType<M>>) => T | Promise<T>,
    ): Promise<T> {
      return await body(this.unscoped());
    }

    static defaultScope(body: (relation: Relation<unknown>) => Relation<unknown>): void {
      // Copy on write, so a subclass adding one leaves its parent alone.
      if (!Object.hasOwn(this, "defaultScopes")) this.defaultScopes = [...this.defaultScopes];
      this.defaultScopes.push(body);
    }

    /**
     * Fills a column with a random token before the row is written. Rails'
     * `has_secure_token`.
     *
     *     static { this.hasSecureToken("invite_token") }
     *
     * The length is in bytes of entropy rather than characters of output,
     * because the second is what people count and the first is what matters. A
     * token that guards anything is guessable at 8 bytes and is not at 24.
     */
    static hasSecureToken(column: string, options: { length?: number } = {}): void {
      const bytes = options.length ?? 24;

      this.setCallback("create", "before", function (this: BaseModel) {
        // Only when it is empty, so a token given explicitly — reissuing one,
        // or a fixture — is kept.
        this[ATTRIBUTES][column] ??= secureToken(bytes);
      });
    }

    /** Every row in the table, ignoring the inheritance column. */
    static unscoped<M extends typeof BaseModel>(this: M): Relation<InstanceType<M>> {
      return new Relation<InstanceType<M>>({
        connection: this.connection,
        tableName: this.table,
        primaryKey: this.primaryKey,
        instantiate: (row: Row) => this.instantiate(row) as InstanceType<M>,
        build: (values: Record<string, unknown>) =>
          new (this as unknown as { new (values?: object): InstanceType<M> })(values),
        // Column types have to be known before a row can be cast, and reading
        // them is asynchronous while instantiate is not.
        prepare: async () => {
          await this.columnTypes();
        },
        prepareConditions: (conditions) =>
          this.encryptConditions(
            this.enumConditions(
              normalizeConditions(this.normalizers, this.aliasConditions(conditions)),
            ),
          ),
        resolveColumn: (name) => this.resolveAttributeName(name),
        castRow: (row) => this.castRow(row),
        joinFor: (name) => this.joinFor(name),
        preload: async (records, names) => {
          for (const name of names) {
            const definition = this.associationFor(name);
            await preloadAssociation(
              records as unknown as InstanceLike[],
              definition,
              resolveAssociation,
            );
          }
        },
      });
    }

    /**
     * Declares a to-one association owned by this model's foreign key.
     *
     * Rails' `belongs_to :author`.
     */
    static belongsTo(name: string, target: () => unknown, options: AssociationOptions = {}): void {
      this.defineAssociation({
        name,
        kind: "belongsTo",
        target: target as () => ModelLike,
        ...options,
      });

      if (options.counterCache) this.defineCounterCache(name, options.counterCache);
      if (options.touch) this.defineTouch(name, options.touch);

      // Required unless it says otherwise, which is Rails' default since 5.0.
      // A polymorphic one is skipped: its foreign key alone does not say
      // whether a parent was named, and the type column carries half the
      // answer.
      if (!options.optional && !options.polymorphic) {
        this.requiresParent(name, options.foreignKey ?? defaultForeignKey(name));
      }
    }

    /** Foreign keys that must be filled in, by association name. */
    static requiredParents: { name: string; foreignKey: string }[] = [];

    /** Records that this association's foreign key may not be empty. */
    protected static requiresParent(name: string, foreignKey: string): void {
      if (!Object.hasOwn(this, "requiredParents")) {
        this.requiredParents = [...this.requiredParents];
      }

      this.requiredParents.push({ name, foreignKey });
    }

    /**
     * Moves the parent's clock whenever a child changes. Rails'
     * `belongs_to :post, touch: true`.
     *
     * This is what makes caching a parent by its `cacheKey` safe: a page
     * cached under `posts/1-...` would otherwise keep showing yesterday's
     * comment count, because adding a comment does not change the post's own
     * `updated_at`.
     *
     * On destroy as well as save, since a removed comment changes the rendered
     * post exactly as much as an added one.
     */
    private static defineTouch(name: string, option: true | string): void {
      const columns = typeof option === "string" ? [option] : [];

      const run = async function (this: BaseModel) {
        // Checked here rather than only recorded, so `noTouching` actually
        // stops the touch — a flag nothing consults is the shape this
        // codebase has spent a day removing.
        if ((this.constructor as typeof BaseModel).touchingDisabled) return;

        await touchParent(this, name, columns);
      };

      this.setCallback("save", "after", run);
      this.setCallback("destroy", "after", run);
    }

    /**
     * Keeps a column on the parent equal to how many children it has.
     *
     * Rails' `belongs_to :post, counter_cache: true`, which exists so that
     * rendering a list of posts with comment counts is one query rather than
     * one per post.
     */
    private static defineCounterCache(name: string, option: true | string): void {
      // Comment belongs_to Post -> posts.comments_count.
      const column = typeof option === "string" ? option : `${this.table}_count`;

      // ponytail: adjusted on create and destroy only. Rails also moves the
      // count when the foreign key changes on update; add that when someone
      // reparents records often enough to notice.
      this.setCallback("create", "after", async function (this: BaseModel) {
        await adjustCounter(this, name, column, 1);
      });
      this.setCallback("destroy", "after", async function (this: BaseModel) {
        await adjustCounter(this, name, column, -1);
      });
    }

    /**
     * Work deferred until the transaction commits. Rails' `after_commit`.
     *
     *     static { this.afterCommit(async function () {
     *       await SendWelcome.later(this.id)
     *     }, { on: "create" }) }
     *
     * Use this and not `after_create` for anything the outside world can see —
     * a job, an email, a webhook. A job enqueued inside the transaction is
     * enqueued whether or not it commits, so a rollback leaves a worker
     * holding the id of a row that never existed; and it can be picked up
     * before the commit lands, when the row genuinely is not there yet.
     *
     * Outside a transaction the callback runs at once, so the same code is
     * right either way — a model cannot know whether its caller opened one.
     */
    static afterCommit(callback: CommitCallback, options: { on?: CommitAction } = {}): void {
      const phases: CommitAction[] = options.on ? [options.on] : ["create", "update", "destroy"];

      for (const phase of phases) {
        // `create` and `update` both finish through save; the callback checks
        // which happened, since only the record knows.
        const event = phase === "destroy" ? "destroy" : "save";

        this.setCallback(event, "after", async function (this: BaseModel) {
          if (phase === "create" && !this[WAS_NEW]) return;
          if (phase === "update" && this[WAS_NEW]) return;

          await afterCommit(async () => {
            await (callback as (this: unknown) => unknown | Promise<unknown>).call(this);
          });
        });
      }
    }

    /** Rails' `after_rollback`. Never runs when there is no transaction. */
    static afterRollback(callback: CommitCallback): void {
      for (const event of ["save", "destroy"] as const) {
        this.setCallback(event, "after", function (this: BaseModel) {
          afterRollback(async () => {
            await (callback as (this: unknown) => unknown | Promise<unknown>).call(this);
          });
        });
      }
    }

    /** Rails' `has_many :comments`. */
    static hasMany(name: string, target: () => unknown, options: AssociationOptions = {}): void {
      this.defineAssociation({
        name,
        kind: "hasMany",
        target: target as () => ModelLike,
        ...options,
      });
    }

    /**
     * Rails' `has_many :comments, through: :posts`.
     *
     * Reaches the target through another association rather than a column on
     * either table.
     */
    static hasManyThrough(
      name: string,
      through: string,
      options: AssociationOptions & { source?: string } = {},
    ): void {
      this.defineAssociation({
        name,
        kind: "hasMany",
        // A through association never queries the target directly, so the
        // target resolver is only reached if something misuses it.
        target: () => {
          throw new Error(`"${name}" is a through association; it loads via "${through}".`);
        },
        through,
        ...options,
      });
    }

    /**
     * Rails' `has_and_belongs_to_many :tags`.
     *
     *     Post.hasAndBelongsToMany("tags", () => Tag)
     *
     *     await post.tags();            // Tag[]
     *     await post.tagIds();          // the ids, for a form
     *     await post.setTagIds([1, 3]); // rewrites the join rows
     *
     * Two tables joined by a third that has no model of its own — the shape
     * for a plain many-to-many with nothing to say about the pairing itself.
     * The moment the pairing has something to say (when it was made, by whom,
     * whether it is approved) it wants a model, and this is the wrong tool:
     * reach for `hasManyThrough` and a real join model instead.
     *
     * Built on `hasManyThrough` over a join model made here, which is what
     * Rails does too. Reads, preloading and `includes` therefore behave
     * exactly as they do for any other through association, because they are
     * the same code.
     */
    static hasAndBelongsToMany(
      name: string,
      target: () => unknown,
      options: {
        /** Defaults to both table names sorted and joined, as Rails does. */
        joinTable?: string;
        /** This model's column in the join table. Defaults to `<singular>_id`. */
        foreignKey?: string;
        /** The target's column in the join table. Defaults to `<singular>_id`. */
        associationForeignKey?: string;
      } = {},
    ): void {
      const singular = singularize(name);
      const joins = `${name}$joins`;

      // Everything about the join is resolved on first use rather than now:
      // `target()` is a thunk precisely because the two models usually import
      // each other, and calling it at declaration time gets `undefined` for
      // whichever file loaded second.
      interface Join {
        model: ModelClass<Record<string, unknown>>;
        table: string;
        ownerKey: string;
        targetKey: string;
      }

      let resolved: Join | undefined;

      const join = (): Join => {
        if (resolved) return resolved;

        const other = target() as typeof BaseModel;
        const table = options.joinTable ?? [this.table, other.table].sort().join("_");
        const ownerKey = options.foreignKey ?? defaultForeignKey(this.name);
        const targetKey = options.associationForeignKey ?? defaultForeignKey(other.name);

        // The owner's column stands in for a primary key. A HABTM join table
        // has none in Rails, and asking a model to read back an `id` that the
        // table does not have fails on the first insert.
        const model = Model<Record<string, unknown>>(table, { primaryKey: ownerKey });
        model.belongsTo(singular, target, { foreignKey: targetKey });

        // The join model's own column types, so the ids these statements read
        // back are cast the way a record's are. PostgreSQL returns a BIGINT as
        // a string, so without this `post.tagIds()` answered `["1"]` where
        // `tag.id` was `1` — and a form comparing the two matched nothing.
        model.columnTypeCache = { [ownerKey]: "bigint", [targetKey]: "bigint" };

        return (resolved = { model, table, ownerKey, targetKey });
      };

      this.hasMany(joins, () => join().model, { foreignKey: options.foreignKey });
      this.hasManyThrough(name, joins, { source: singular });

      /** Rails' `collection_singular_ids`. What a form needs, without the rows. */
      Object.defineProperty(this.prototype, `${singular}Ids`, {
        configurable: true,
        writable: true,
        value: async function ids(this: InstanceLike): Promise<unknown[]> {
          const { table, ownerKey, targetKey } = join();
          const owner = this.constructor as typeof BaseModel;
          const connection = owner.connection;

          const rows = await connection.query<Record<string, unknown>>(
            `SELECT ${connection.quote(targetKey)} FROM ${connection.quote(table)} WHERE ${connection.quote(ownerKey)} = ${connection.placeholder(0)}`,
            [this[owner.primaryKey]],
          );

          return rows.map((row) => join().model.castRow(row)[targetKey]);
        },
      });

      /**
       * Rails' `collection_singular_ids=`.
       *
       * A diff rather than delete-then-insert: rewriting every row would churn
       * the table on a form submission that changed nothing, and on a database
       * with a foreign key onto the join row it would break anything pointing
       * at it.
       */
      Object.defineProperty(
        this.prototype,
        `set${name.charAt(0).toUpperCase()}${name.slice(1, -1)}Ids`,
        {
          configurable: true,
          writable: true,
          value: async function setIds(this: InstanceLike, ids: readonly unknown[]): Promise<void> {
            const { table, ownerKey, targetKey } = join();
            const owner = this.constructor as typeof BaseModel;
            const connection = owner.connection;
            const id = this[owner.primaryKey];

            if (id === undefined || id === null) {
              throw new Error(
                `${owner.name} must be saved before its ${name} can be set: a join row needs an id to point at.`,
              );
            }

            const current = new Set(
              (
                await connection.query<Record<string, unknown>>(
                  `SELECT ${connection.quote(targetKey)} FROM ${connection.quote(table)} WHERE ${connection.quote(ownerKey)} = ${connection.placeholder(0)}`,
                  [id],
                )
              )
                // Cast, or the diff below compares a string against a number
                // and decides every link is both new and gone.
                .map((row) => join().model.castRow(row)[targetKey]),
            );

            const wanted = new Set(ids);

            for (const gone of current) {
              if (wanted.has(gone)) continue;

              await connection.execute(
                `DELETE FROM ${connection.quote(table)} WHERE ${connection.quote(ownerKey)} = ${connection.placeholder(0)} AND ${connection.quote(targetKey)} = ${connection.placeholder(1)}`,
                [id, gone],
              );
            }

            for (const added of wanted) {
              if (current.has(added)) continue;

              await connection.execute(
                `INSERT INTO ${connection.quote(table)} (${connection.quote(ownerKey)}, ${connection.quote(targetKey)}) VALUES (${connection.placeholder(0)}, ${connection.placeholder(1)})`,
                [id, added],
              );
            }

            // The loaded copies are now wrong, and a stale association is worse
            // than an unloaded one — it looks like an answer.
            delete this[cacheKey(name)];
            delete this[cacheKey(joins)];
          },
        },
      );
    }

    /**
     * Rails' `has_one :account, through: :subscription`.
     *
     * The same two hops as `hasManyThrough`, keeping the first record it
     * reaches rather than all of them — for the case where the chain happens
     * to be one-to-one, like a user's address through their profile.
     */
    static hasOneThrough(
      name: string,
      through: string,
      options: AssociationOptions & { source?: string } = {},
    ): void {
      this.defineAssociation({
        name,
        kind: "hasOne",
        // A through association never queries the target directly, so the
        // target resolver is only reached if something misuses it.
        target: () => {
          throw new Error(`"${name}" is a through association; it loads via "${through}".`);
        },
        through,
        ...options,
      });
    }

    /** Token shapes this class can sign, by purpose. */
    static tokenDefinitions: Record<string, TokenDefinition> = {};

    /**
     * Rails' `generates_token_for`.
     *
     *     this.generatesTokenFor("passwordReset", { expiresIn: 900 }, (user) =>
     *       String(user.password_digest ?? "").slice(-10),
     *     )
     *
     * No column and no row: the token carries the id and is signed. The third
     * argument is what earns it — whatever it returns is signed in and checked
     * again on use, so a reset link stops working the moment the password
     * changes. Without it a link keeps working after the reset, and whoever
     * read the email once still has a way in.
     */
    static generatesTokenFor(
      purpose: string,
      options: { expiresIn?: number } = {},
      fingerprint?: (record: never) => unknown,
    ): void {
      // Copied before writing, so a subclass declaring a token does not add it
      // to its parent and every sibling.
      if (!Object.hasOwn(this, "tokenDefinitions")) {
        this.tokenDefinitions = { ...this.tokenDefinitions };
      }

      this.tokenDefinitions[purpose] = { expiresIn: options.expiresIn, fingerprint };
    }

    /**
     * Finds the record a token names, or null.
     *
     * Null for every way it can fail — a bad signature, the wrong purpose, an
     * expired token, a record that has gone, a fingerprint that no longer
     * matches. One thing for the caller to check, and no answer that tells an
     * attacker which of those it was.
     */
    static async findByTokenFor<T extends BaseModel>(
      this: (new (...args: never[]) => T) & typeof BaseModel,
      purpose: string,
      token: string,
    ): Promise<T | null> {
      const definition = this.tokenDefinitions[purpose];

      if (!definition) {
        throw new Error(
          `${this.name} has no token defined for "${purpose}". Declare one with generatesTokenFor("${purpose}").`,
        );
      }

      const read = readToken(this.name, purpose, token);
      if (!read) return null;

      const record = await (
        this as unknown as { findBy(conditions: object): Promise<T | null> }
      ).findBy({ [this.primaryKey]: read.id });

      if (!record) return null;

      return fingerprintMatches(definition, record, read.fingerprint) ? record : null;
    }

    /**
     * A polymorphic belongsTo, whose target class is named by a companion
     * `<name>_type` column. Rails' `belongs_to :commentable, polymorphic: true`.
     */
    static belongsToPolymorphic(
      name: string,
      types: Record<string, () => unknown>,
      options: AssociationOptions = {},
    ): void {
      this.defineAssociation({
        name,
        kind: "belongsTo",
        target: () => {
          throw new Error(`"${name}" is polymorphic; its class comes from ${name}_type.`);
        },
        polymorphic: true,
        types: types as Record<string, () => ModelLike>,
        ...options,
      });
    }

    /**
     * Rails' `delegated_type`.
     *
     *     class Entry extends Model<EntryRow>("entries") {
     *       static {
     *         this.delegatedType("entryable", { Message: () => Message, Comment: () => Comment })
     *       }
     *     }
     *
     * A polymorphic `belongsTo` says "this points at one of several things"
     * and leaves the caller to ask which. Rails' delegated type adds the three
     * questions everybody then writes by hand: which one is it, give me it if
     * it is that one, and give me every entry that is.
     *
     *     entry.isMessage        // a message, or not
     *     await entry.message()  // the message, or null if it is a comment
     *     await Entry.messages() // every entry that is a message
     *
     * The difference from a plain polymorphic association is that the set of
     * types is closed and written down. That is what makes the predicates and
     * the scopes possible, and it is the trade: a type not in the list cannot
     * be stored, which is the point rather than a limitation.
     */
    static delegatedType(
      name: string,
      types: Record<string, () => unknown>,
      options: AssociationOptions = {},
    ): void {
      this.belongsToPolymorphic(name, types, options);

      const typeKey = `${name}_type`;

      // The type as it stands, so a caller can switch on it without knowing
      // the column's name. Rails' `entryable_name`.
      Object.defineProperty(this.prototype, `${camelize(name, false)}Name`, {
        configurable: true,
        get(this: InstanceLike): string | null {
          return (this[typeKey] as string | null) ?? null;
        },
      });

      for (const [typeName, target] of Object.entries(types)) {
        const singular = camelize(typeName, false);

        // `entry.isMessage`. A getter rather than a method, because it reads a
        // column this record already has and asking it should not look like a
        // query.
        Object.defineProperty(this.prototype, `is${typeName}`, {
          configurable: true,
          get(this: InstanceLike): boolean {
            return this[typeKey] === typeName;
          },
        });

        // `await entry.message()` — the record when it is one, and null when
        // it is not. Null rather than throwing: asking a comment for its
        // message is how you find out it is a comment.
        Object.defineProperty(this.prototype, singular, {
          configurable: true,
          writable: true,
          value: async function delegatedAccessor(this: InstanceLike): Promise<unknown> {
            if (this[typeKey] !== typeName) return null;

            return await (this as unknown as Record<string, () => Promise<unknown>>)[name]!();
          },
        });

        // `await Entry.messages()` — every entry of that type, as a relation
        // so it stays chainable.
        Object.defineProperty(this, pluralize(singular), {
          configurable: true,
          writable: true,
          value: function delegatedScope(this: { where(conditions: Conditions): unknown }) {
            return this.where({ [typeKey]: typeName });
          },
        });

        // `types` already holds the class; `delegatedClassFor` is how a caller
        // reaches it without going through the association definition.
        void target;
      }
    }

    /**
     * Rails' `composed_of`.
     *
     *     class Customer extends Model<CustomerRow>("customers") {
     *       static {
     *         this.composedOf("address", {
     *           mapping: { address_street: "street", address_city: "city" },
     *           from: (parts) => new Address(parts.street, parts.city),
     *           to: (address) => ({ street: address.street, city: address.city }),
     *         })
     *       }
     *     }
     *
     * Two columns that only mean something together stop being two columns.
     * `customer.address` is an Address, assigning one writes both columns, and
     * the arithmetic or formatting that belongs to an address lives on the
     * Address rather than being repeated wherever a customer is.
     *
     * The value is rebuilt when the columns change and held while they do not,
     * so reading it twice gives the same object — a value object that changed
     * identity on every read would make `===` useless and quietly break any
     * memo keyed on it.
     */
    /**
     * The value objects this model composes, by name. Rails'
     * `aggregate_reflections`.
     *
     * Recorded so a serializer or a form builder can ask which columns belong
     * to one value object — otherwise `street`, `city` and `postcode` look
     * like three independent fields, and a form renders them as such.
     */
    static aggregations: Record<string, AggregateReflection> = {};

    /** Every aggregation declared. Rails' `reflect_on_all_aggregations`. */
    static reflectOnAllAggregations(): AggregateReflection[] {
      return Object.values(this.aggregations);
    }

    /** One aggregation, or undefined. Rails' `reflect_on_aggregation`. */
    static reflectOnAggregation(name: string): AggregateReflection | undefined {
      return this.aggregations[name];
    }

    /** Every aggregation name, in declaration order. */
    static aggregationNames(): string[] {
      return Object.keys(this.aggregations);
    }

    static composedOf<V, P extends Record<string, unknown>>(
      name: string,
      options: ComposedOfOptions<V, P>,
    ): void {
      const columns = Object.keys(options.mapping);

      // Copy on write, so a subclass composing its own leaves its parent alone.
      if (!Object.hasOwn(this, "aggregations")) this.aggregations = { ...this.aggregations };
      this.aggregations[name] = {
        name,
        columns,
        mapping: { ...(options.mapping as Record<string, string>) },
        allowNil: options.allowNil ?? true,
      };

      const cache = `__composed_${name}`;
      const stamp = `__composed_stamp_${name}`;

      Object.defineProperty(this.prototype, name, {
        configurable: true,
        enumerable: false,

        get(this: InstanceLike): V | null {
          const values = columns.map((column) => this[column]);

          // Every mapped column empty means there is nothing to build from.
          // Rails' `allow_nil`, and the default here: a customer with no
          // address should answer null rather than an Address of nulls.
          if ((options.allowNil ?? true) && values.every((value) => value == null)) return null;

          // Held while the columns are unchanged. Compared by value rather
          // than by a dirty flag, so a write through any path invalidates it.
          const current = JSON.stringify(values);
          if (this[stamp] === current) return this[cache] as V;

          const parts = Object.fromEntries(
            columns.map((column, index) => [
              options.mapping[column] as string,
              values[index] as unknown,
            ]),
          ) as P;

          const built = options.from(parts);

          Object.defineProperty(this, cache, { value: built, configurable: true, writable: true });
          Object.defineProperty(this, stamp, {
            value: current,
            configurable: true,
            writable: true,
          });

          return built;
        },

        set(this: InstanceLike, value: V | null) {
          // Null clears every column it maps, rather than leaving half an
          // address behind for the next read to build something from.
          const parts = value == null ? null : options.to(value);

          for (const column of columns) {
            const key = options.mapping[column] as string;
            this[column] = parts == null ? null : (parts as Record<string, unknown>)[key];
          }

          Object.defineProperty(this, stamp, {
            value: undefined,
            configurable: true,
            writable: true,
          });
        },
      });
    }

    /**
     * `afterCommit(..., { on: "create" })`, spelled the way Rails usually is.
     *
     * The named forms are what appears in real applications, and reading
     * `afterCreateCommit` at a glance is the point — an options hash three
     * lines down from the callback body is a thing to go and check.
     */
    static afterCreateCommit(callback: CommitCallback): void {
      this.afterCommit(callback, { on: "create" });
    }

    static afterUpdateCommit(callback: CommitCallback): void {
      this.afterCommit(callback, { on: "update" });
    }

    static afterDestroyCommit(callback: CommitCallback): void {
      this.afterCommit(callback, { on: "destroy" });
    }

    /** Both halves of a save, and not a destroy. Rails' `after_save_commit`. */
    static afterSaveCommit(callback: CommitCallback): void {
      this.afterCommit(callback, { on: "create" });
      this.afterCommit(callback, { on: "update" });
    }

    /**
     * Columns that may be set once and never changed. Rails' `attr_readonly`.
     *
     * Enforced on update rather than refused: the value is simply not written,
     * which is what Rails does. An audit column or a slug that something else
     * already points at is the case — a rule the application holds even where
     * a validation would not, because it applies to every write path.
     */
    static attrReadonly(...names: string[]): void {
      if (!Object.hasOwn(this, "readonlyAttributes")) {
        this.readonlyAttributes = [...this.readonlyAttributes];
      }

      this.readonlyAttributes.push(...names);
    }

    static readonlyAttributes: string[] = [];

    /**
     * Columns the model should pretend are not there. Rails' `ignored_columns`.
     *
     * What makes dropping a column safe: name it here, deploy, then drop it.
     * Without that the running application selects a column the migration has
     * just removed, and every query fails until the deploy catches up.
     */
    static ignoreColumns(...names: string[]): void {
      if (!Object.hasOwn(this, "ignoredColumns")) this.ignoredColumns = [...this.ignoredColumns];

      this.ignoredColumns.push(...names);
      this.columnCache = undefined;
      this.columnTypeCache = undefined;
    }

    static ignoredColumns: string[] = [];

    /** The name a person sees. Rails' `model_name.human`. */
    static humanName(): string {
      return humanize(underscore(this.name));
    }

    /** Where this model's translations live. Rails' `i18n_scope`. */
    static get i18nScope(): string {
      return "activerecord";
    }

    /** The class at the top of an STI hierarchy, or this one. Rails' `base_class`. */
    static get baseClass(): typeof BaseModel {
      return this.stiRoot ?? this;
    }

    /** Adds to a column on a row that is not in hand. Rails' `increment_counter`. */
    static async incrementCounter(column: string, id: unknown, by = 1): Promise<void> {
      const connection = this.connection;
      const columns = await this.columnNames();

      if (!columns.includes(column)) {
        throw new Error(`Invalid column name: ${column}.${didYouMean(column, columns)}`);
      }

      const quoted = connection.quote(column);

      await connection.execute(
        `UPDATE ${connection.quote(this.table)} SET ${quoted} = COALESCE(${quoted}, 0) + ${connection.placeholder(0)} WHERE ${connection.quote(this.primaryKey)} = ${connection.placeholder(1)}`,
        [by, id],
      );
    }

    static async decrementCounter(column: string, id: unknown, by = 1): Promise<void> {
      await this.incrementCounter(column, id, -by);
    }

    /**
     * Several counters on one row, in one statement. Rails' `update_counters`.
     *
     *     await Post.updateCounters(1, { comments_count: 1, views: 12 })
     *
     * One statement rather than a call each, which matters for more than
     * speed: two separate updates are two chances for another writer to
     * interleave, and the row is read and written twice instead of once.
     *
     * COALESCE, as in `incrementCounter`, because a counter column that is
     * still null would otherwise stay null forever — `null + 1` is null, and
     * nothing reports it.
     */
    static async updateCounters(id: unknown, counters: Record<string, number>): Promise<void> {
      const entries = Object.entries(counters);
      if (entries.length === 0) return;

      const connection = this.connection;
      const columns = await this.columnNames();

      for (const [column] of entries) {
        if (!columns.includes(column)) {
          throw new Error(`Invalid column name: ${column}.${didYouMean(column, columns)}`);
        }
      }

      const assignments = entries.map(([column], index) => {
        const quoted = connection.quote(column);
        return `${quoted} = COALESCE(${quoted}, 0) + ${connection.placeholder(index)}`;
      });

      await connection.execute(
        `UPDATE ${connection.quote(this.table)} SET ${assignments.join(", ")} ` +
          `WHERE ${connection.quote(this.primaryKey)} = ${connection.placeholder(entries.length)}`,
        [...entries.map(([, by]) => by), id],
      );
    }

    /**
     * Recounts a cached counter from the rows it counts. Rails' `reset_counters`.
     *
     * A counter cache drifts — a row deleted straight from SQL, a bulk insert
     * that skipped callbacks, a bug since fixed — and once it has, nothing
     * notices, because the whole point of the column is that nobody counts.
     * This is the repair.
     */
    static async resetCounters(id: unknown, ...associations: string[]): Promise<void> {
      const connection = this.connection;

      for (const name of associations) {
        const association = this.associationFor(name);
        const column = this.counterCacheColumn(name);
        const target = association.target() as unknown as { table: string };
        // Undeclared foreign keys fall back to the same default the loader
        // uses, so a plain `hasMany("comments")` recounts without being told
        // the column name it never had to state in the first place.
        const foreignKey = association.foreignKey ?? defaultForeignKey(this.name);

        const [row] = await connection.query<{ count: number | string }>(
          `SELECT COUNT(*) AS count FROM ${connection.quote(target.table)} ` +
            `WHERE ${connection.quote(foreignKey)} = ${connection.placeholder(0)}`,
          [id],
        );

        await connection.execute(
          `UPDATE ${connection.quote(this.table)} SET ${connection.quote(column)} = ${connection.placeholder(0)} ` +
            `WHERE ${connection.quote(this.primaryKey)} = ${connection.placeholder(1)}`,
          [Number(row?.count ?? 0), id],
        );
      }
    }

    /**
     * The column a `counterCache: true` association keeps its count in.
     * Rails' `counter_cache_column`.
     *
     * `comments` counts into `comments_count`, unless the association named
     * the column itself.
     */
    static counterCacheColumn(name: string): string {
      const association = this.associationFor(name);
      const cache = association.counterCache;

      return typeof cache === "string" ? cache : `${underscore(name)}_count`;
    }

    /**
     * Every column's schema, by name. Rails' `columns_hash`.
     *
     * More than `columnTypes` reports: nullability, the database's own type
     * name, and whether it is the primary key. A form builder marking a field
     * required, a serializer describing its constraints, and a scaffold
     * choosing an input all want this rather than the type alone.
     */
    static async columnsHash(): Promise<Record<string, ColumnSchema>> {
      const schemas = await columnSchemas(this.connection, this.table);

      return Object.fromEntries(schemas.map((one: ColumnSchema) => [one.name, one]));
    }

    /** One column's schema, or undefined. Rails' `column_for_attribute`. */
    static async columnForAttribute(name: string): Promise<ColumnSchema | undefined> {
      return (await this.columnsHash())[name];
    }

    /**
     * One attribute's logical type, or undefined. Rails' `type_for_attribute`.
     *
     * A declaration wins over the column, since that is what the application
     * actually reads and writes — answering with the column's type after
     * `attribute("price", "integer")` overrode it would be reporting the
     * storage rather than the model.
     */
    static async typeForAttribute(name: string): Promise<ColumnType | undefined> {
      const declared = this.declaredAttributes[name];

      if (declared) return declared.typeName as ColumnType;

      return (await this.columnTypes())[name];
    }

    /**
     * What a new record starts with. Rails' `column_defaults`.
     *
     * Read from the schema rather than guessed, so a column with a database
     * default is reflected before the row is written — which is what makes a
     * form show the default the row will actually get.
     */
    static async columnDefaults(): Promise<Record<string, string | null>> {
      const schemas = await columnSchemas(this.connection, this.table);

      return Object.fromEntries(schemas.map((one: ColumnSchema) => [one.name, one.default]));
    }

    /**
     * The columns that hold what the record is about. Rails' `content_columns`.
     *
     * Everything except the primary key, the timestamps, the inheritance
     * column and the foreign keys — which is exactly the set a scaffold puts
     * on a form, since none of the excluded ones is a person's to type.
     */
    static async contentColumns(): Promise<string[]> {
      const names = await this.columnNames();
      const skip = new Set([this.primaryKey, "created_at", "updated_at", this.inheritanceColumn]);

      return names.filter((name) => !skip.has(name) && !name.endsWith("_id"));
    }

    /**
     * Runs a block with `touch` turned off. Rails' `no_touching`.
     *
     * For a bulk import, where every row touching its parent means one update
     * per row on the same handful of parents — which is both slow and a
     * deadlock waiting to happen.
     */
    static async noTouching<T>(body: () => T | Promise<T>): Promise<T> {
      const before = this.touchingDisabled;
      this.touchingDisabled = true;

      try {
        return await body();
      } finally {
        // In a finally, or an import that throws leaves touching off for the
        // rest of the process and every cache key stops moving.
        this.touchingDisabled = before;
      }
    }

    /**
     * Whether saves of this model write timestamps. Rails' `record_timestamps`.
     *
     * A join table, an append-only log, a table whose times come from
     * somewhere else: all of them have a reason not to want created_at and
     * updated_at maintained, and turning it off per model is cheaper than
     * excluding the columns everywhere they are written.
     */
    static recordTimestamps = true;

    /**
     * Runs a block with timestamps off. Rails' `without_timestamps`.
     *
     * For a data migration that must not disturb updated_at — the column
     * usually means "when a person last changed this", and a backfill touching
     * every row makes it mean "when we ran the backfill", which is a fact
     * nobody wanted recorded and cannot be undone.
     */
    static async withoutTimestamps<T>(body: () => T | Promise<T>): Promise<T> {
      const before = this.recordTimestamps;
      this.recordTimestamps = false;

      try {
        return await body();
      } finally {
        this.recordTimestamps = before;
      }
    }

    /** @internal Whether saves of this model are being suppressed right now. */
    static suppressed = false;

    /**
     * Runs a block in which saving this model does nothing. Rails' `suppress`.
     *
     * The case it was written for: importing a hundred thousand rows where a
     * callback creates a notification per record. Suppressing the notification
     * is the difference between an import and an import plus a hundred
     * thousand emails.
     *
     * `save` answers true, as Rails does, because the caller asked for the
     * record to be persisted and the application has decided that means
     * nothing here — reporting failure would send it down an error path for a
     * situation that is not an error.
     */
    static async suppress<T>(body: () => T | Promise<T>): Promise<T> {
      const before = this.suppressed;
      this.suppressed = true;

      try {
        return await body();
      } finally {
        // In a finally, or one throwing import leaves the model unable to save
        // for the rest of the process — a failure that looks like data loss.
        this.suppressed = before;
      }
    }

    static touchingDisabled = false;

    /** The column an STI hierarchy reads its type from. */
    static get inheritanceColumnName(): string {
      return this.inheritanceColumn;
    }

    /**
     * A token no two records share. Rails' `generate_unique_secure_token`.
     *
     * The length is bytes of entropy rather than characters of output, because
     * the question a token has to answer is how hard it is to guess.
     */
    static generateUniqueSecureToken(length = 24): string {
      return secureToken(length);
    }

    /** The model class a delegated type name stands for. */
    static delegatedClassFor(name: string, type: string): ModelLike | undefined {
      return this.associations[name]?.types?.[type]?.();
    }

    /** Rails' `has_one :profile`. */
    static hasOne(name: string, target: () => unknown, options: AssociationOptions = {}): void {
      this.defineAssociation({
        name,
        kind: "hasOne",
        target: target as () => ModelLike,
        ...options,
      });
    }

    static defineAssociation(definition: AssociationDefinition): void {
      // Copy on write, so declaring on a subclass leaves the parent alone —
      // the same rule the callback chains follow.
      if (!Object.hasOwn(this, "associations")) {
        this.associations = { ...this.associations };
      }
      this.associations[definition.name] = definition;

      // A to-many association is a relation so it stays chainable; a to-one is
      // a promise. Either way a preloaded value short-circuits the query.
      Object.defineProperty(this.prototype, definition.name, {
        configurable: true,
        writable: true,
        value: function associationAccessor(this: InstanceLike) {
          const cached = this[cacheKey(definition.name)];

          // Checked before anything is built, so the failure names the read
          // that would have run the query rather than something downstream of
          // it. A preloaded association is always allowed: strict loading is
          // about the query, not about the association.
          if (cached === undefined && (this as Record<symbol, unknown>)[STRICT_LOADING] === true) {
            const violation = new StrictLoadingViolation(this.constructor.name, definition.name);

            // Raised, or reported and allowed through. The second is what lets
            // an application already full of N+1s turn this on at all: it
            // turns "we cannot switch it on" into a list of things to fix.
            if (strictLoadingActionFor() === "raise") throw violation;

            errors.report(violation, {
              handled: true,
              severity: "warning",
              source: "altair",
              context: { model: this.constructor.name, association: definition.name },
            });
          }

          // A to-many association is always a Relation so the declared type is
          // honest. When it was preloaded the relation already holds the
          // records and runs no query.
          // A polymorphic target is decided per record: no type means no
          // target, and an unknown type is an error the caller awaits rather
          // than one thrown while building the accessor.
          if (definition.polymorphic) {
            if (cached !== undefined) return Promise.resolve(cached);

            const typeKey = `${definition.name}_type`;
            const foreignKey = definition.foreignKey ?? `${definition.name}_id`;

            if (this[typeKey] == null || this[foreignKey] == null) return Promise.resolve(null);

            return (async () => relationFor(this, definition).first())();
          }

          // A through association has no single relation to hand back, so it
          // is loaded on demand and returned as an already-resolved one.
          if (definition.through) {
            const singular = definition.kind === "hasOne";

            // A loaded singular association can legitimately be null, so
            // "already loaded" is `!== undefined` rather than "is an array" —
            // otherwise a chain that reaches nothing is looked up again on
            // every read.
            if (singular ? cached !== undefined : Array.isArray(cached)) {
              return Promise.resolve(cached);
            }

            return (async () => {
              await preloadAssociation([this], definition, resolveAssociation);
              const loaded = this[cacheKey(definition.name)];

              return singular ? (loaded ?? null) : ((loaded as InstanceLike[]) ?? []);
            })();
          }

          if (definition.kind === "hasMany") {
            const relation = relationFor(this, definition);
            return Array.isArray(cached)
              ? relation.resolvedWith(cached as InstanceLike[])
              : relation;
          }

          if (cached !== undefined) return Promise.resolve(cached);
          return relationFor(this, definition).first();
        },
      });
    }

    /**
     * What this model's associations are, without knowing their names first.
     * Rails' `reflect_on_all_associations`.
     *
     *     for (const one of Post.reflectOnAllAssociations("hasMany")) { ... }
     *
     * The question anything generic asks: a serializer deciding what to
     * include, a fixture loader working out what to build first, a generator
     * writing a form. Without it each of those has to be handed a list that
     * then drifts from the model.
     *
     * Inherited associations are included, because a subclass has them.
     */
    static reflectOnAllAssociations(kind?: AssociationKind): AssociationDefinition[] {
      const all = Object.values(this.associations);

      return kind ? all.filter((one) => one.kind === kind) : all;
    }

    /**
     * One association's definition, or undefined. Rails'
     * `reflect_on_association`.
     *
     * Undefined rather than thrown, unlike `associationFor`. The two answer
     * different questions: this one asks whether there is an association, and
     * a caller asking that is prepared for no. `associationFor` is used where
     * the association is required and a missing one is a mistake worth
     * stopping on.
     */
    static reflectOnAssociation(name: string): AssociationDefinition | undefined {
      return this.associations[name];
    }

    /** Every association name, in declaration order. */
    static associationNames(): string[] {
      return Object.keys(this.associations);
    }

    static associationFor(name: string): AssociationDefinition {
      const definition = this.associations[name];
      if (!definition) {
        throw new Error(`${this.name} has no association named "${name}"`);
      }
      return definition;
    }

    /**
     * Rails' `where`, in both of its forms.
     *
     * The string form takes its bindings, and used not to: the class-level
     * `where` accepted only an object, so `Post.where("views > ?", 35)`
     * silently dropped the 35 and produced a statement with a placeholder and
     * nothing to fill it. The relation had always supported it; only the way
     * in from a model did not.
     */
    static where<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Relation<InstanceType<M>>;
    static where<M extends typeof BaseModel>(
      this: M,
      sql: string,
      ...bindings: unknown[]
    ): Relation<InstanceType<M>>;
    static where<M extends typeof BaseModel>(
      this: M,
      conditionsOrSql: Conditions | string,
      ...bindings: unknown[]
    ): Relation<InstanceType<M>> {
      if (typeof conditionsOrSql === "string") {
        return this.all().where(conditionsOrSql, ...bindings);
      }

      return this.all().where(conditionsOrSql);
    }

    /** Rails' `with`: a named subquery this query can select from. */
    static with<M extends typeof BaseModel>(
      this: M,
      expressions: Parameters<Relation<InstanceType<M>>["with"]>[0],
    ): Relation<InstanceType<M>> {
      return this.all().with(expressions);
    }

    /** Rails' `with_recursive`: the same, for a query that refers to itself. */
    static withRecursive<M extends typeof BaseModel>(
      this: M,
      expressions: Parameters<Relation<InstanceType<M>>["withRecursive"]>[0],
    ): Relation<InstanceType<M>> {
      return this.all().withRecursive(expressions);
    }

    /** Rails' `from`: select from something other than this model's table. */
    static from<M extends typeof BaseModel>(this: M, source: string): Relation<InstanceType<M>> {
      return this.all().from(source);
    }

    static order<M extends typeof BaseModel>(
      this: M,
      column: string,
      direction: "asc" | "desc" = "asc",
    ): Relation<InstanceType<M>> {
      return this.all().order(column, direction);
    }

    static limit<M extends typeof BaseModel>(this: M, count: number): Relation<InstanceType<M>> {
      return this.all().limit(count);
    }

    /**
     * Rails' `find`: by primary key, or a thrown RecordNotFound.
     *
     * Several ids answer with several records, in the order they were asked
     * for. This used to hand back one record for `find([1, 3])`, because the
     * ids became an `IN` and `first()` took whatever came out of it — so a
     * caller expecting two got one, and `find([1, 999])` for a row that does
     * not exist answered with the row that does.
     */
    static async find<M extends typeof BaseModel>(this: M, id: unknown): Promise<InstanceType<M>>;
    static async find<M extends typeof BaseModel>(
      this: M,
      ids: readonly unknown[],
    ): Promise<InstanceType<M>[]>;
    static async find<M extends typeof BaseModel>(
      this: M,
      id: unknown,
    ): Promise<InstanceType<M> | InstanceType<M>[]> {
      if (!Array.isArray(id)) {
        const record = await this.all()
          .where({ [this.primaryKey]: id })
          .first();

        if (!record) {
          throw new RecordNotFound(
            `Could not find ${this.name} with ${this.primaryKey} = ${String(id)}`,
          );
        }

        return record as InstanceType<M>;
      }

      // Asking for none of them is not an error, and does not need a query.
      if (id.length === 0) return [];

      const found = await this.all()
        .where({ [this.primaryKey]: id })
        .toArray();

      const byId = new Map(
        found.map((record) => [
          // Compared as strings: an id off the database is a number and one
          // out of a URL is not, and `find(["4"])` is the ordinary case.
          String((record as unknown as Record<string, unknown>)[this.primaryKey]),
          record,
        ]),
      );

      // Rails answers in the order the ids were given rather than the order
      // the database returns them, which is what makes `find(ids)` usable for
      // rebuilding a list somebody has already sorted.
      const ordered = id.map((one) => byId.get(String(one))).filter(Boolean);

      if (ordered.length !== id.length) {
        throw new RecordNotFound(
          `Could not find all ${this.name} records with ${this.primaryKey}: ` +
            `(${id.map((one) => String(one)).join(", ")}) ` +
            `(found ${ordered.length} results, but was looking for ${id.length}).`,
        );
      }

      return ordered as InstanceType<M>[];
    }

    /** Rails' `find_by`: the first match, or null. */
    static async findBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Promise<InstanceType<M> | null> {
      return await this.all().where(conditions).first();
    }

    /**
     * Exactly one record matching, or an error. Rails' `find_sole_by`.
     *
     * For a lookup that is meant to be unique — a user by email, a setting by
     * key. `findBy` answers the same thing when one row matches and quietly
     * picks a winner when two do, so a uniqueness assumption that has stopped
     * being true reads as normal behaviour.
     */
    static async findSoleBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Promise<InstanceType<M>> {
      return await this.all().where(conditions).sole();
    }

    static async first<M extends typeof BaseModel>(this: M): Promise<InstanceType<M> | null> {
      return await this.all().first();
    }

    static async last<M extends typeof BaseModel>(this: M): Promise<InstanceType<M> | null> {
      return await this.all().last();
    }

    static async count(): Promise<number> {
      return await this.all().count();
    }

    static async exists(conditions: Conditions = {}): Promise<boolean> {
      return await this.all().where(conditions).exists();
    }

    /**
     * Rails' `find_or_create_by`.
     *
     * Not atomic: two requests can both miss the lookup and both insert. Rails
     * has the same gap and says so — a unique index is what actually prevents
     * the duplicate, and this reports the resulting error.
     */
    /**
     * Rails' `insert_all`: many rows in one statement, collisions skipped.
     *
     * No callbacks, no validations, nothing instantiated — the name is the
     * warning. What it buys is one round trip instead of thousands, and
     * atomicity that saving one at a time cannot offer.
     */
    static async insertAll(
      rows: readonly Record<string, unknown>[],
      options: BulkOptions = {},
    ): Promise<BulkResult> {
      return await runBulk(this.bulkContext(), rows, "skip", options);
    }

    /** Rails' `insert_all!`: a collision is an error rather than a skip. */
    static async insertAllOrFail(
      rows: readonly Record<string, unknown>[],
      options: BulkOptions = {},
    ): Promise<BulkResult> {
      return await runBulk(this.bulkContext(), rows, "raise", options);
    }

    /** Rails' `upsert_all`: a collision overwrites. */
    static async upsertAll(
      rows: readonly Record<string, unknown>[],
      options: BulkOptions = {},
    ): Promise<BulkResult> {
      return await runBulk(this.bulkContext(), rows, "update", options);
    }

    /** @internal What the bulk writer needs from a model. */
    static bulkContext(): BulkContext {
      return {
        connection: this.connection,
        table: this.table,
        primaryKey: this.primaryKey,
        columnNames: () => this.columnNames(),
      };
    }

    static async findOrCreateBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
      extra: Partial<A> = {},
    ): Promise<InstanceType<M>> {
      const existing = await this.findBy(conditions);
      if (existing) return existing as InstanceType<M>;

      return await this.create({ ...(conditions as Partial<A>), ...extra });
    }

    /**
     * Rails' `create_or_find_by`: insert first, and fall back to the row that
     * was already there.
     *
     * `findOrCreateBy` has a race and cannot not have one: two requests both
     * find nothing, both insert, and one gets a duplicate-key error — or worse,
     * two rows exist where the schema meant one. The window is small and the
     * traffic is not.
     *
     * This turns the race around. The insert is attempted first, and a unique
     * violation means somebody else won, so the row is read instead. The
     * database arbitrates rather than the application, which is the only place
     * the question can be settled.
     *
     * It needs a unique index on the columns being matched. Without one there
     * is no violation to catch and this is `create` with extra steps — so a
     * failure that is not a duplicate is re-raised rather than swallowed.
     */
    static async createOrFindBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
      extra: Partial<A> = {},
    ): Promise<InstanceType<M>> {
      try {
        return await this.create({ ...(conditions as Partial<A>), ...extra });
      } catch (error) {
        // Two checks, and the second is the one that guarantees correctness.
        // This first one avoids a pointless SELECT after an error that was
        // never a duplicate, and says in one line what this catch is for.
        if (!isUniqueViolation(error)) throw error;

        const existing = await this.findBy(conditions);

        // Nothing there after a unique violation means the constraint that
        // fired was a different one — a NOT NULL, another index — and
        // returning null would turn that into a mystery somewhere else. This
        // is what makes a misjudged error safe rather than silent.
        if (!existing) throw error;

        return existing as InstanceType<M>;
      }
    }

    /**
     * Destroys everything matching, one at a time. Rails' `destroy_by`.
     *
     * One at a time because each record's callbacks are the difference between
     * this and `deleteBy` — a destroyed post should still take its comments
     * and its attachments with it.
     */
    static async destroyBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Promise<number> {
      const records = await this.where(conditions);

      for (const record of records) {
        await (record as unknown as { destroy(): Promise<unknown> }).destroy();
      }

      return records.length;
    }

    /**
     * Deletes everything matching in one statement. Rails' `delete_by`.
     *
     * No callbacks, no validations, no associations followed. For rows nothing
     * else points at — a session table, an expired token — where running a
     * callback chain per row is the difference between a second and an hour.
     */
    static async deleteBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Promise<number> {
      return await this.where(conditions).deleteAll();
    }

    /** Rails' `find_or_initialize_by`: the same lookup, without saving. */
    static async findOrInitializeBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
      extra: Partial<A> = {},
    ): Promise<InstanceType<M>> {
      const existing = await this.findBy(conditions);
      if (existing) return existing as InstanceType<M>;

      return this.build({ ...(conditions as Partial<A>), ...extra });
    }

    /**
     * Runs a block inside a database transaction.
     *
     * Everything the block touches joins the transaction, because the
     * connection is swapped for the duration.
     */
    static async transaction<R>(body: () => Promise<R>): Promise<R> {
      // No swapping of `connectionOverride`: that is a static, so two requests
      // in a transaction at once would overwrite each other's. The connection
      // is scoped to the async call chain instead, which is per-request by
      // construction and reaches every model the block touches, not just this
      // one.
      return await this.connection.transaction(async () => await body());
    }

    /** Deletes every matching row, running callbacks for each. Rails' `destroy_all`. */
    static async destroyAll(conditions: Conditions = {}): Promise<number> {
      const records = await this.all().where(conditions);
      for (const record of records) await (record as BaseModel).destroy();
      return records.length;
    }

    /**
     * Declares a named scope. Rails' `scope :published, -> { where(...) }`.
     *
     * The scope becomes a static returning a Relation, so it composes with
     * every other query method.
     */
    static scope(name: string, body: (relation: Relation<unknown>) => Relation<unknown>): void {
      Object.defineProperty(this, name, {
        configurable: true,
        writable: true,
        value: function scopedQuery(this: typeof BaseModel) {
          return body(this.all() as Relation<unknown>);
        },
      });
    }

    /** Builds an unsaved record. */
    static build<M extends typeof BaseModel>(this: M, values: Partial<A> = {}): InstanceType<M> {
      this.checkInherited();

      // Through the default-scoped relation, so a record built from a scope is
      // one that scope can find. `Draft.all().build()` already seeded from the
      // scope's equality conditions and `Draft.build()` did not, so the same
      // record came out differently depending on which was called — and the
      // shorter one produced a Draft that `Draft` could not see.
      //
      // Only single-value equality conditions seed anything: a range, a list or
      // raw SQL leaves the value unset, because there is no one value those
      // mean. That is exactly Rails' rule, which seeds from a Hash condition
      // and not from a string or an array.
      return this.all().build(values as Partial<InstanceType<M>>);
    }

    /**
     * Refuses a model subclass that never called `inherit()`.
     *
     * Rails works out a hierarchy from the class definition; JavaScript gives
     * no hook for that, so a subclass has to say so. Forgetting is silent and
     * looks entirely fine: `Car.create()` writes no type, `Car.all()` hands
     * back every vehicle, and each row comes back as the base class. Nothing
     * fails, and the type column simply stays empty.
     *
     * Cheap to check — a prototype lookup on a class that is almost always the
     * root — and it turns that into a sentence naming the missing line.
     */
    protected static checkInherited(): void {
      const parent = Object.getPrototypeOf(this) as typeof BaseModel;

      // The root itself, or something that is not a model subclass at all.
      if (!parent?.tableName || parent === BaseModel) return;
      // Already declared, whether by this class or by one above it.
      if (this.stiRoot !== undefined) return;

      throw new Error(
        `${this.name} extends ${parent.name} but never called \`this.inherit()\`. ` +
          `Without it the type column is not written and ${this.name}.all() returns every ${parent.name}.`,
      );
    }

    /** Builds and saves. Rails' `create`. */
    static async create<M extends typeof BaseModel>(
      this: M,
      values: Partial<A> = {},
    ): Promise<InstanceType<M>> {
      const record = this.build(values);
      await record.saveOrFail();
      return record;
    }

    /**
     * @internal Turns a row into a persisted instance.
     *
     * A row whose `type` names a registered subclass is built as that
     * subclass, so `Vehicle.all()` hands back Cars — the behaviour that makes
     * STI worth having rather than a column people check by hand.
     */
    static instantiate<M extends typeof BaseModel>(this: M, row: Row): InstanceType<M> {
      row = this.castRow(row);
      const declared = row[this.inheritanceColumn];

      if (typeof declared === "string" && declared !== this.name) {
        const subclass = (this.stiRoot ?? this).descendants[declared];

        if (subclass) {
          const record = new subclass(row as Partial<A>, true) as InstanceType<M>;
          if (this.strictLoadingByDefault) record.strictLoading();

          return record;
        }
      }

      const record = new this(row as Partial<A>, true) as InstanceType<M>;
      if (this.strictLoadingByDefault) record.strictLoading();

      return record;
    }

    /**
     * Refuses to load this record's associations lazily. Rails' `strict_loading!`.
     *
     * Set on one record rather than on the class, for the query that builds a
     * page — the one place an N+1 costs something — while a background job
     * walking one record at a time carries on as it was.
     */
    strictLoading(on = true): this {
      this[STRICT_LOADING] = on;
      return this;
    }

    /** Whether this record refuses lazy association loads. */
    get isStrictLoading(): boolean {
      return this[STRICT_LOADING] === true;
    }

    /**
     * Whether an association is already in memory. Rails'
     * `association(:comments).loaded?`.
     *
     * The question `strictLoading` makes worth asking: a helper that reads
     * `post.author` is safe on a preloaded record and a violation on any other,
     * and this is how it can tell without provoking one.
     */
    isAssociationLoaded(name: string): boolean {
      (this.constructor as typeof BaseModel).associationFor(name);

      return (this as unknown as Record<string, unknown>)[cacheKey(name)] !== undefined;
    }

    /**
     * Forgets a loaded association so the next read fetches it again. Rails'
     * `association(:comments).reload`.
     *
     * For after a write that the association cannot have seen — a job inserted
     * a comment, a counter moved — where the record is otherwise still good and
     * reloading the whole thing would throw away everything else it holds.
     */
    reloadAssociation(name: string): this {
      (this.constructor as typeof BaseModel).associationFor(name);
      delete (this as unknown as Record<string, unknown>)[cacheKey(name)];

      return this;
    }

    /** Every association currently in memory, by name. */
    loadedAssociations(): string[] {
      const klass = this.constructor as typeof BaseModel;

      return Object.keys(klass.associations).filter((name) => this.isAssociationLoaded(name));
    }

    /**
     * Whether the save that just ran was the one that created this record.
     * Rails' `previously_new_record?`.
     *
     * What an `afterSave` callback asks to tell a create from an update. By the
     * time it runs the record is persisted either way, so `isNewRecord` is
     * false for both and the callback has no way to know which happened.
     */
    get isPreviouslyNewRecord(): boolean {
      return this[WAS_NEW] === true;
    }

    get isNewRecord(): boolean {
      return !this[PERSISTED];
    }

    get isPersisted(): boolean {
      return this[PERSISTED];
    }

    /**
     * Reads a column's value directly. Rails' `read_attribute`.
     *
     * The way past an accessor the class defined. A model that overrides a
     * column — `get name() { return super.name.trim() }` — has no `super` to
     * reach through here, because the value lives in the attribute store
     * rather than on a prototype. Without this, such an accessor calls itself
     * and the process stops with a stack overflow rather than a message about
     * the model.
     *
     * Follows an alias, so it reads the same column the accessor would.
     */
    readAttribute(name: string): unknown {
      const klass = this.constructor as typeof BaseModel;

      return this[ATTRIBUTES][klass.resolveAttributeName(name)];
    }

    /**
     * Writes a column's value directly. Rails' `write_attribute`.
     *
     * The counterpart, and the one a custom setter needs for the same reason.
     * Bypasses the accessor, so a normaliser or a cast declared on the class
     * does not run — which is the point when the caller has already done that
     * work and would otherwise do it twice.
     */
    writeAttribute(name: string, value: unknown): void {
      const klass = this.constructor as typeof BaseModel;

      this[ATTRIBUTES][klass.resolveAttributeName(name)] = value;
    }

    /**
     * The value as it was assigned. Rails'
     * `read_attribute_before_type_cast`.
     *
     * What a form re-render needs. Somebody picks a status the model stores as
     * an integer, or types a name a normaliser trims; the validation fails,
     * the field is rendered from the record, and it comes back holding the
     * transformed value rather than what they entered — so they are told
     * something is wrong about a box that now looks different from what they
     * typed.
     *
     * Captures the transforms the model performs on assignment — an enum, a
     * normaliser. A plain column keeps what was assigned as it was, so there
     * is nothing earlier to remember, and this answers with the stored value.
     * What came out of the database likewise has no earlier form.
     */
    readAttributeBeforeTypeCast(name: string): unknown {
      const klass = this.constructor as typeof BaseModel;
      const resolved = klass.resolveAttributeName(name);
      const raw = this[BEFORE_TYPE_CAST];

      return raw && resolved in raw ? raw[resolved] : this[ATTRIBUTES][resolved];
    }

    /** Everything as it was assigned, before casting. Rails' `attributes_before_type_cast`. */
    attributesBeforeTypeCast(): Record<string, unknown> {
      return { ...this[ATTRIBUTES], ...this[BEFORE_TYPE_CAST] };
    }

    /**
     * One value as it would be written. Rails' `read_attribute_for_database`.
     *
     * Different from the cast value wherever the model stores something other
     * than what it hands out — an enum kept as an integer, a serialized column
     * kept as JSON. What a caller building its own statement needs, and what
     * makes a hand-written query agree with what the ORM writes.
     */
    readAttributeForDatabase(name: string): unknown {
      const klass = this.constructor as typeof BaseModel;

      return this[ATTRIBUTES][klass.resolveAttributeName(name)];
    }

    /** Everything as it would be written. Rails' `attributes_for_database`. */
    attributesForDatabase(): Record<string, unknown> {
      return { ...this[ATTRIBUTES] };
    }

    /**
     * A short view of the record, for a log line. Rails'
     * `attributes_for_inspect`.
     *
     * Rails added this because logging a record with a large text column or a
     * blob puts kilobytes into the log for every line that mentions it, and a
     * log nobody can scroll is a log nobody reads. The default is the primary
     * key alone; a model says what else is worth seeing.
     */
    static attributesForInspect: string[] | "all" = [];

    /** Everything, for a console where the whole record is the point. */
    allAttributesForInspect(): Record<string, unknown> {
      return { ...this[ATTRIBUTES] };
    }

    /**
     * What `inspect` shows, honouring the class's choice.
     *
     * A value longer than the limit is cut with an ellipsis rather than left
     * whole: the point is a line somebody can read, and one very long value
     * defeats that as thoroughly as ten short ones.
     */
    attributesForInspect(limit = 50): Record<string, unknown> {
      const klass = this.constructor as typeof BaseModel;
      const wanted =
        klass.attributesForInspect === "all"
          ? Object.keys(this[ATTRIBUTES])
          : [klass.primaryKey, ...klass.attributesForInspect];

      const shown: Record<string, unknown> = {};

      for (const name of wanted) {
        if (!(name in this[ATTRIBUTES])) continue;

        shown[name] = truncateForInspect(this[ATTRIBUTES][name], limit);
      }

      return shown;
    }

    /**
     * Whether an association is already in hand. Rails' `association_cached?`.
     *
     * What a view should ask before reading one. `post.author()` on a record
     * that was preloaded costs nothing and on one that was not costs a query —
     * and the two read identically at the call site, which is precisely why
     * N+1s survive code review. This is the question that tells them apart.
     */
    associationCached(name: string): boolean {
      return (this as unknown as Record<string, unknown>)[cacheKey(name)] !== undefined;
    }

    /**
     * The association's definition. Rails' `proxy_association`.
     *
     * For code that has to work across associations it was not written for —
     * a serializer, an audit log, a form builder — and needs to know whether
     * this one is to-many, what it points at, and which key joins it.
     */
    proxyAssociation(name: string): AssociationDefinition | undefined {
      return (this.constructor as typeof BaseModel).associations[name];
    }

    /**
     * Whether the key this association reads through is set. Rails'
     * `foreign_key_present?`.
     *
     * A `belongsTo` whose foreign key is null has nothing to load, and asking
     * the database is a query guaranteed to return nothing. Checked before a
     * preload rather than after, since a page of a hundred records with
     * ninety nulls should issue one query for the ten, not for all hundred.
     */
    foreignKeyPresent(name: string): boolean {
      const definition = this.proxyAssociation(name);

      if (definition === undefined) return false;

      // Only meaningful in the direction that holds the key. A hasMany reads
      // through the *other* table's column, so this record holding nothing
      // says nothing about whether there is anything to find.
      if (definition.kind !== "belongsTo") return true;

      const key = definition.foreignKey ?? `${definition.name}_id`;

      return (this as unknown as Record<string, unknown>)[key] != null;
    }

    /** The records an association already holds, or undefined. Rails' `records_for`. */
    recordsFor(name: string): unknown {
      return (this as unknown as Record<string, unknown>)[cacheKey(name)];
    }

    /**
     * Loads an association and remembers it. Rails' `load_target`.
     *
     * The explicit form of what reading one does, for a caller that wants the
     * query to happen now — priming a record before handing it to a template
     * that must not issue queries of its own.
     */
    async loadTarget(name: string): Promise<unknown> {
      const held = this.recordsFor(name);

      if (held !== undefined) return held;

      const accessor = (this as unknown as Record<string, unknown>)[name];

      if (typeof accessor !== "function") return undefined;

      const loaded: unknown = await (accessor as () => unknown).call(this);

      (this as unknown as Record<string, unknown>)[cacheKey(name)] = loaded;

      return loaded;
    }

    attributes(): A {
      const klass = this.constructor as typeof BaseModel;
      const enums = Object.keys(klass.enums);

      if (enums.length === 0) return { ...this[ATTRIBUTES] } as A;

      // Enums come back as their word here too, not just through the accessor.
      // Otherwise `toJSON` and `serializableHash` — which is to say every JSON
      // response — would hand out the integer, and the caller would need its
      // own copy of the mapping to read it. The raw value is still what the
      // insert and the update write, since those read the attribute bag
      // directly.
      const mapped: Record<string, unknown> = { ...this[ATTRIBUTES] };

      for (const attribute of enums) {
        if (attribute in mapped) {
          mapped[attribute] = labelFor(klass.enums[attribute] as EnumDefinition, mapped[attribute]);
        }
      }

      return mapped as A;
    }

    toJSON(): A {
      return this.attributes();
    }

    /** Rails' `to_param`, which the router uses when building a path. */
    toParam(): string {
      const klass = this.constructor as typeof BaseModel;
      return String(this[ATTRIBUTES][klass.primaryKey] ?? "");
    }

    /**
     * Reloads this record with a lock held, then runs the block. Rails'
     * `with_lock`.
     *
     *     await account.withLock(async () => {
     *       await account.update({ balance: Number(account.balance) - 10 })
     *     })
     *
     * The reload is the part that matters and the part people leave out. A
     * lock taken on a row you read a moment ago protects nothing: the value in
     * memory is already stale, and subtracting from a stale balance is exactly
     * the bug the lock was for. Reloading inside the lock is what makes the
     * read-modify-write atomic.
     *
     * Opens a transaction if there is not one, because a lock released
     * immediately is the same as no lock.
     */
    async withLock<R>(body: () => Promise<R>): Promise<R> {
      const klass = this.constructor as typeof BaseModel;

      return await klass.connection.transaction(async () => {
        const id = this[ATTRIBUTES][klass.primaryKey];

        const locked = await (
          klass as unknown as {
            where(conditions: Record<string, unknown>): {
              lock(): { first(): Promise<{ attributes(): Record<string, unknown> } | null> };
            };
          }
        )
          .where({ [klass.primaryKey]: id })
          .lock()
          .first();

        if (!locked) {
          throw new RecordNotFound(`Cannot lock ${klass.name} ${String(id)}: it is gone.`);
        }

        // The record in hand becomes the locked one, so the block reads what
        // the database holds rather than what was read before the lock.
        this[ATTRIBUTES] = locked.attributes();
        this[ORIGINAL] = { ...this[ATTRIBUTES] };

        return await body();
      });
    }

    /**
     * Sets `updated_at` to now and writes it. Rails' `touch`.
     *
     *     await post.touch()
     *     await post.touch("published_at")
     *
     * No validations, and only the timestamp columns are written — the point
     * is to move the clock on a row without saving whatever else is half-
     * edited in memory. It pairs with `cacheKey`: touching a record changes
     * its key, so anything cached under that key becomes unreachable.
     *
     * A record that was never saved has nothing to touch, and says so rather
     * than quietly doing nothing.
     */
    async touch(...columns: string[]): Promise<void> {
      const klass = this.constructor as typeof BaseModel;

      if (!this[PERSISTED]) {
        throw new Error(`Cannot touch ${klass.name}: it has not been saved yet.`);
      }

      checkWritable("update");

      const present = await klass.columnNames();
      const now = new Date();

      const touched = [...(present.includes("updated_at") ? ["updated_at"] : []), ...columns];
      if (touched.length === 0) return;

      for (const column of touched) {
        if (!present.includes(column)) {
          throw new Error(`Cannot touch ${klass.table}.${column}: there is no such column.`);
        }
      }

      const connection = klass.connection;
      const assignments = touched
        .map((column, index) => `${connection.quote(column)} = ${connection.placeholder(index)}`)
        .join(", ");

      await connection.execute(
        `UPDATE ${connection.quote(klass.table)} SET ${assignments} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(touched.length)}`,
        [...touched.map(() => serialize(now, connection)), this[ATTRIBUTES][klass.primaryKey]],
      );

      // The record in memory follows the row, or its own cache key would still
      // be the old one.
      for (const column of touched) this[ATTRIBUTES][column] = now;
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    /**
     * Rails' `cache_key_with_version`: `posts/1-20260815120000123`.
     *
     * The timestamp is the version, which is what makes this usable as an
     * etag: the key changes the moment the record does, so a cached copy
     * expires by being unreachable rather than by being swept. A record with
     * no `updated_at` gets a key with no version, and the caller should know
     * that such a key cannot detect a change.
     */
    /** Signs a token for one purpose. Rails' `generate_token_for`. */
    generateTokenFor(purpose: string): string {
      const klass = this.constructor as typeof BaseModel;
      const definition = klass.tokenDefinitions[purpose];

      if (!definition) {
        throw new Error(
          `${klass.name} has no token defined for "${purpose}". Declare one with generatesTokenFor("${purpose}").`,
        );
      }

      if (this.isNewRecord) {
        throw new Error(
          `Cannot build a token for an unsaved ${klass.name}: it has no id, so nothing could find it again.`,
        );
      }

      return generateToken(
        klass.name,
        purpose,
        definition,
        this,
        this[ATTRIBUTES][klass.primaryKey],
      );
    }

    /**
     * The part of a cache key that changes when the record does. Rails'
     * `cache_version`.
     *
     * Kept apart from the key so a store that understands versions can hold
     * one entry per record rather than one per version — the difference
     * between a cache that reuses its space and one that fills up with
     * yesterday's copies of the same page.
     */
    cacheVersion(): string | undefined {
      const stamp = this[ATTRIBUTES].updated_at;
      if (stamp === undefined || stamp === null) return undefined;

      const at = stamp instanceof Date ? stamp : new Date(String(stamp));

      return String(at.getTime());
    }

    /** Both halves together, which is what a plain store needs. */
    cacheKeyWithVersion(): string {
      const version = this.cacheVersion();
      const klass = this.constructor as typeof BaseModel;
      const id = String(this[ATTRIBUTES][klass.primaryKey] ?? "new");

      return version ? `${klass.table}/${id}-${version}` : `${klass.table}/${id}`;
    }

    cacheKey(): string {
      const klass = this.constructor as typeof BaseModel;
      const id = String(this[ATTRIBUTES][klass.primaryKey] ?? "new");
      const stamp = this[ATTRIBUTES].updated_at;

      if (stamp === undefined || stamp === null) return `${klass.table}/${id}`;

      const at = stamp instanceof Date ? stamp : new Date(String(stamp));

      // Milliseconds, not seconds. Rails carries microseconds here for a
      // reason that took an integration test to see: a record touched twice
      // in the same second produced the same key both times, so a cached
      // fragment and a conditional GET both went on serving the old content.
      // Two comments arriving together is not an unusual thing to happen.
      //
      // Milliseconds is where it stops: JS timestamps carry nothing finer, so
      // two writes inside one millisecond still share a key. That is a
      // thousand times narrower than a second and is the limit of what can be
      // read off a Date.
      //
      // A column with no sub-second precision — MySQL's DATETIME without one —
      // gives whole seconds back on reload, and the wider collision returns.
      // Declare such a column with a precision if its records change that
      // fast.
      const version = Number.isNaN(at.getTime())
        ? String(stamp)
        : at
            .toISOString()
            .replaceAll(/[-:TZ.]/g, "")
            .slice(0, 17);

      return `${klass.table}/${id}-${version}`;
    }

    assign(values: Partial<A>): void {
      const klass = this.constructor as typeof BaseModel;

      if (Object.keys(klass.nestedAttributes).length === 0) {
        assignThrough(this, values as Record<string, unknown>);
        return;
      }

      const { attributes, nested } = extractNested(
        values as Record<string, unknown>,
        klass.nestedAttributes,
      );

      assignThrough(this, attributes);
      Object.assign(this[NESTED], nested);
    }

    /** The attributes whose values differ from the last load or save. */
    changedAttributes(): Partial<A> {
      const klass = this.constructor as typeof BaseModel;
      const serialized = klass.serializedColumns;
      const changes: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(this[ATTRIBUTES])) {
        const before = this[ORIGINAL][key];

        // A serialized column is compared by its contents. `preferences.theme
        // = "dark"` mutates the object in place, so both sides are the same
        // reference and `Object.is` says nothing changed — the save would then
        // write nothing and the edit would vanish without an error.
        if (key in serialized) {
          if (stableJson(value) !== stableJson(before)) changes[key] = value;
          continue;
        }

        if (!Object.is(value, before)) changes[key] = value;
      }

      return changes as Partial<A>;
    }

    changed(): (keyof A & string)[] {
      return Object.keys(this.changedAttributes()) as (keyof A & string)[];
    }

    /** Every change as `[was, is]`. Rails' `changes`. */
    changes(): Record<string, [unknown, unknown]> {
      const changes: Record<string, [unknown, unknown]> = {};

      for (const key of Object.keys(this.changedAttributes())) {
        changes[key] = [this[ORIGINAL][key], this[ATTRIBUTES][key]];
      }

      return changes;
    }

    hasChanged(attribute?: keyof A & string): boolean {
      return attribute ? this.changed().includes(attribute) : this.changed().length > 0;
    }

    /**
     * One attribute's change, as `[was, is]`. Rails' `attribute_change`.
     *
     * Undefined when it did not change, which is what separates "was set to
     * null" from "was not touched" — `changes()[name]` cannot tell those apart
     * without the caller checking the key is present, and that check is the one
     * people leave out.
     */
    changeToAttribute(attribute: keyof A & string): [unknown, unknown] | undefined {
      return this.changes()[attribute];
    }

    /**
     * The same, for the save that has already happened. Rails'
     * `saved_change_to_attribute`.
     *
     * The one an `afterSave` callback wants. `changeToAttribute` is empty by
     * then — the record has been written and has no pending changes — so a
     * callback asking that question gets nothing and quietly does not run.
     */
    savedChangeToAttribute(attribute: keyof A & string): [unknown, unknown] | undefined {
      return this[SAVED_CHANGES]?.[attribute];
    }

    /**
     * Whether saving now would write this attribute. Rails'
     * `will_save_change_to_attribute?`.
     *
     * For a `beforeSave` callback deciding whether to do work — regenerating a
     * slug, re-encrypting a field — where the answer has to be about what is
     * about to be written rather than what already was.
     */
    willSaveChangeTo(attribute: keyof A & string): boolean {
      return attribute in this.changedAttributes();
    }

    /**
     * Puts one attribute back. Rails' `restore_attribute!`.
     *
     * The narrow form of `restoreAttributes`, for undoing a single assignment
     * without discarding everything else the caller has set on the record.
     */
    restoreAttribute(attribute: keyof A & string): void {
      if (!(attribute in this.changedAttributes())) return;

      this[ATTRIBUTES][attribute] = this[ORIGINAL][attribute];
    }

    /**
     * Forgets that an attribute changed, without putting the value back.
     * Rails' `clear_attribute_change`.
     *
     * For code that has written a column itself and does not want the next
     * save to write it again — a counter updated in one statement, say. The
     * value stays; only the record's memory of having changed it goes.
     */
    clearAttributeChanges(...attributes: (keyof A & string)[]): void {
      const names = attributes.length > 0 ? attributes : Object.keys(this.changedAttributes());

      for (const name of names) {
        this[ORIGINAL][name as string] = this[ATTRIBUTES][name as string];
      }
    }

    /** What it held when the record was last loaded or saved. */
    attributeWas(attribute: keyof A & string): unknown {
      return this[ORIGINAL][attribute];
    }

    /**
     * Puts the changed attributes back. Rails' `restore_attributes`.
     *
     * What a form does when the person cancels: the record in memory goes back
     * to the row on disk without another query.
     */
    restoreAttributes(attributes: readonly (keyof A & string)[] = this.changed()): void {
      for (const attribute of attributes) {
        this[ATTRIBUTES][attribute] = this[ORIGINAL][attribute];
      }
    }

    /**
     * What the save that just happened changed, as `[was, is]`.
     *
     * Rails' `saved_changes`. The question an after-save callback asks, and the
     * one it could not ask before this existed: by then the record is clean, so
     * `changes()` is empty and "did the email change?" has no answer.
     */
    savedChanges(): Record<string, [unknown, unknown]> {
      return { ...this[SAVED_CHANGES] };
    }

    /** Whether the last save touched this attribute, or anything at all. */
    hasSavedChange(attribute?: keyof A & string): boolean {
      const saved = this[SAVED_CHANGES] ?? {};

      return attribute ? attribute in saved : Object.keys(saved).length > 0;
    }

    /** What an attribute held before the save that just happened. */
    attributeBeforeLastSave(attribute: keyof A & string): unknown {
      return this[SAVED_CHANGES]?.[attribute]?.[0];
    }

    /**
     * Rails' `previous_changes`: what the last save changed.
     *
     * The same answer as `savedChanges`, under the name Rails also gives it.
     * Both spellings are in the wild and in the guides.
     */
    previousChanges(): Record<string, [unknown, unknown]> {
      return this.savedChanges();
    }

    /** Rails' `attribute_previously_changed?`. */
    attributePreviouslyChanged(attribute: keyof A & string): boolean {
      return this.hasSavedChange(attribute);
    }

    /** Rails' `attribute_previously_was`. */
    attributePreviouslyWas(attribute: keyof A & string): unknown {
      return this.attributeBeforeLastSave(attribute);
    }

    /** Whether this attribute differs from the last load or save. */
    attributeChanged(attribute: keyof A & string): boolean {
      return attribute in this.changedAttributes();
    }

    /**
     * Rails' `title?`: whether the attribute holds something worth having.
     *
     * Not `!= null`. Rails treats `0`, `""` and `false` as absent here, which
     * is what makes `if user.name?` read the way it does — and is exactly the
     * behaviour a hand-written truthiness check gets wrong for `0`.
     */
    queryAttribute(attribute: keyof A & string): boolean {
      const value =
        this[ATTRIBUTES][(this.constructor as typeof BaseModel).resolveAttributeName(attribute)];

      if (typeof value === "number") return value !== 0;

      return !isBlank(value);
    }

    /**
     * Forgets every recorded change. Rails' `clear_changes_information`.
     *
     * For a record synced by hand — written by a raw statement, reloaded from
     * elsewhere — where the tracked "before" is no longer what the row holds
     * and a later save would write stale values back over it.
     */
    clearChangesInformation(): void {
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
      this[SAVED_CHANGES] = undefined;
    }

    /** Whether the model has this column at all. Rails' `has_attribute?`. */
    hasAttribute(name: string): boolean {
      return name in this[ATTRIBUTES];
    }

    /** Every attribute this record carries. Rails' `attribute_names`. */
    attributeNames(): string[] {
      return Object.keys(this[ATTRIBUTES]);
    }

    /**
     * What the row holds, as far as this record knows. Rails'
     * `attribute_in_database`.
     *
     * The value before any unsaved change — which is what a callback comparing
     * against the database needs, and what `attributeWas` answers for one
     * attribute.
     */
    attributeInDatabase(name: string): unknown {
      return this[ORIGINAL][name];
    }

    attributesInDatabase(): Record<string, unknown> {
      return { ...this[ORIGINAL] };
    }

    /** The pending change to one attribute, as `[was, is]`. */
    attributeChangeToBeSaved(name: string): [unknown, unknown] | undefined {
      return this.changes()[name];
    }

    /** Whether saving would write this attribute. Rails' `will_save_change_to_attribute?`. */
    willSaveChangeToAttribute(name: string): boolean {
      return name in this.changedAttributes();
    }

    /** Whether saving would write anything at all. */
    hasChangesToSave(): boolean {
      return this.changed().length > 0;
    }

    /** Everything a save would write. Rails' `changes_to_save`. */
    changesToSave(): Record<string, [unknown, unknown]> {
      return this.changes();
    }

    changedAttributeNamesToSave(): string[] {
      return this.changed();
    }

    /** The primary key as the row holds it, before any unsaved change. */
    get idInDatabase(): unknown {
      const klass = this.constructor as typeof BaseModel;

      return this[ORIGINAL][klass.primaryKey];
    }

    /**
     * Whether this record was destroyed. Rails' `destroyed?`.
     *
     * Not the same question as `isPersisted`, which a record that was never
     * saved also answers no to. A caller cleaning up after a failed request
     * needs to tell "this was never written" from "this is gone".
     */
    get isDestroyed(): boolean {
      return this[DESTROYED] === true;
    }

    /**
     * Writes columns straight to the row. Rails' `update_column(s)`.
     *
     * No validations, no callbacks, and no `updated_at` — which is the whole
     * point and the whole danger. It is for the columns that are bookkeeping
     * rather than content: marking a row processed, storing a job id. Using it
     * for anything a person typed skips every check that was put there for
     * them.
     */
    async updateColumns(values: Partial<A>): Promise<boolean> {
      checkWritable("updateColumns");

      if (this.isNewRecord) {
        throw new Error("updateColumns needs a row to update. Save the record first.");
      }

      const klass = this.constructor as typeof BaseModel;
      const connection = klass.connection;
      const entries = Object.entries(values as Record<string, unknown>);

      if (entries.length === 0) return true;

      const columns = await klass.columnNames();
      for (const [column] of entries) {
        // Checked rather than escaped, as everywhere else a column name
        // reaches SQL: an unknown name is a mistake, and a crafted one is
        // worse.
        if (!columns.includes(column)) {
          throw new Error(`Invalid column name: ${column}.${didYouMean(column, columns)}`);
        }
      }

      const assignments = entries
        .map(([column], index) => `${connection.quote(column)} = ${connection.placeholder(index)}`)
        .join(", ");

      // Every column that identifies the row, not just the primary key. Naming
      // too few matches the wrong row — or several — and writes to all of
      // them, which reports success and edits somebody else's record.
      const identifying = klass.queryConstraintsList();
      const where = identifying
        .map(
          (column, at) =>
            `${connection.quote(column)} = ${connection.placeholder(entries.length + at)}`,
        )
        .join(" AND ");

      await connection.execute(
        `UPDATE ${connection.quote(klass.table)} SET ${assignments} WHERE ${where}`,
        [
          ...entries.map(([column, value]) => klass.encryptFor(column, value)),
          ...identifying.map((column) => this[ATTRIBUTES][column]),
        ],
      );

      // The record follows the row, and stays clean: nothing here is a pending
      // change any more.
      for (const [column, value] of entries) {
        this[ATTRIBUTES][column] = value;
        this[ORIGINAL][column] = value;
      }

      return true;
    }

    /** One column, the same way. Rails' `update_column`. */
    async updateColumn(column: keyof A & string, value: unknown): Promise<boolean> {
      return await this.updateColumns({ [column]: value } as Partial<A>);
    }

    /**
     * Adds to a column in the database rather than in memory. Rails'
     * `increment!`.
     *
     * `SET views = views + 1` rather than reading, adding and writing back:
     * two requests incrementing at once both read 5, both write 6, and one
     * view is gone. The whole reason to have this rather than `post.views +=
     * 1; save()`.
     */
    async increment(column: keyof A & string, by = 1): Promise<this> {
      checkWritable("increment");

      if (this.isNewRecord) {
        throw new Error("increment needs a row to update. Save the record first.");
      }

      const klass = this.constructor as typeof BaseModel;
      const connection = klass.connection;
      const columns = await klass.columnNames();

      if (!columns.includes(column)) {
        throw new Error(`Invalid column name: ${column}.${didYouMean(column, columns)}`);
      }

      const quoted = connection.quote(column);

      await connection.execute(
        `UPDATE ${connection.quote(klass.table)} SET ${quoted} = COALESCE(${quoted}, 0) + ${connection.placeholder(0)} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(1)}`,
        [by, this[ATTRIBUTES][klass.primaryKey]],
      );

      // Read back rather than added to in memory: another request may have
      // incremented it too, and the point of doing this in the database is
      // that both count.
      const rows = await connection.query<Row>(
        `SELECT ${quoted} FROM ${connection.quote(klass.table)} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(0)}`,
        [this[ATTRIBUTES][klass.primaryKey]],
      );

      const now = rows[0]?.[column];
      this[ATTRIBUTES][column] = now;
      this[ORIGINAL][column] = now;

      return this;
    }

    /** The other direction. Rails' `decrement!`. */
    async decrement(column: keyof A & string, by = 1): Promise<this> {
      return await this.increment(column, -by);
    }

    /**
     * Flips a flag in the database. Rails' `toggle!`.
     *
     * Read and written rather than `NOT column` in SQL, because a flag is null
     * before anybody sets it and `NOT NULL` is null — a toggle that left it
     * null would do nothing and say it had.
     */
    async toggle(column: keyof A & string): Promise<this> {
      const current = this[ATTRIBUTES][column];

      await this.updateColumns({ [column]: current ? 0 : 1 } as Partial<A>);

      return this;
    }

    /** Rails' `serializable_hash`, with `only`, `except` and `methods`. */
    serializableHash(options: SerializationOptions = {}): Record<string, unknown> {
      return serializableHash(this, this.attributes() as Record<string, unknown>, options);
    }

    /** Which partial renders this record. Rails' `to_partial_path`. */
    toPartialPath(): string {
      return modelNameFor(this.constructor).partialPath;
    }

    /** Rails' `model_name`: every name derived from the class's. */
    get modelName(): ModelName {
      return modelNameFor(this.constructor);
    }

    /**
     * Runs the declared validations. Override to add rules in code, calling
     * `super.runValidations()` to keep the declared ones.
     */
    async runValidations(context?: string): Promise<void> {
      const klass = this.constructor as typeof BaseModel;

      // What `on:` is matched against. A record that has never been saved is
      // being created however it got here.
      const running = context ?? (this.isPersisted ? "update" : "create");

      // Not an early return on `validations` alone. A model whose only rule is
      // `validatesAssociated` has no attribute validations, and returning here
      // skipped the one thing it declared — and then a required `belongsTo`
      // was added and skipped the same way, silently, because every model in
      // the tests happened to declare something else as well. The probe that
      // caught it declared nothing.
      if (klass.validations.length === 0) {
        // The custom ones still run. A model whose only rule is a validator
        // object has no attribute declarations, and returning without them
        // would skip the single thing it declared — the same shape of bug the
        // association checks below were added for.
        await this.runCustomValidations(klass, running);
        this.validateRequiredParents(klass);
        await this.validateAssociated(klass);
        return;
      }

      const probe = {
        isPersisted: this.isPersisted,
        id: this[ATTRIBUTES][klass.primaryKey],
        exists: async (
          conditions: Conditions,
          excludeId?: unknown,
          comparison?: UniquenessComparison,
        ) => {
          const { plain, fragments } = uniquenessConditions(conditions, comparison, {
            adapter: klass.connection.adapter,
            quote: (name) => klass.connection.quote(name),
          });

          let relation = klass.all();

          for (const fragment of fragments) relation = relation.where(fragment.sql, fragment.value);

          relation = relation.where(plain as Conditions);

          if (excludeId !== undefined)
            relation = relation.whereNot({ [klass.primaryKey]: excludeId });
          return await relation.exists();
        },
      };

      for (const declaration of klass.validations) {
        if (!(await declarationApplies(declaration.options, this, running))) continue;

        await runValidation(this as unknown as ValidationTarget, declaration, probe);
      }

      await this.runCustomValidations(klass, running);

      this.validateRequiredParents(klass);

      await this.validateAssociated(klass);
    }

    /** Runs the rules declared with `validatesWith` and `validatesEach`. */
    private async runCustomValidations(klass: typeof BaseModel, running: string): Promise<void> {
      for (const declaration of klass.customValidations) {
        // The same `on:`, `if:` and `unless:` a declared rule honours, so a
        // custom rule is not the one that runs where nothing else does.
        if (!(await declarationApplies(declaration.options, this, running))) continue;

        await runCustomValidation(this as unknown as ValidationTarget, declaration);
      }
    }

    /**
     * Checks that every required `belongsTo` names something.
     *
     * The foreign key is what is checked, not the parent — reading the parent
     * would be a query per association on every save, to learn something the
     * column already says. A key pointing at a row that has since gone is a
     * job for a foreign key constraint, which the database does better.
     */
    protected validateRequiredParents(klass: typeof BaseModel): void {
      for (const { name, foreignKey } of klass.requiredParents) {
        if (this[ATTRIBUTES][foreignKey] == null) {
          this.errors.add(name, MESSAGES.required);
        }
      }
    }

    /**
     * Validates the loaded records of every association declared associated.
     *
     * Guarded against cycles. Two models that validate each other — a post its
     * comments and a comment its post — would otherwise recurse until the
     * stack ran out, and a stack overflow during a save is a much worse way to
     * learn about a typo in a model than a validation error.
     */
    protected async validateAssociated(klass: typeof BaseModel): Promise<void> {
      if (klass.associatedValidations.length === 0) return;

      const visiting = validating.getStore();
      if (visiting?.has(this)) return;

      const seen = visiting ?? new Set<object>();
      seen.add(this);

      await validating.run(seen, async () => {
        for (const name of klass.associatedValidations) {
          const loaded = (this as unknown as Record<string, unknown>)[name];
          const records = Array.isArray(loaded) ? loaded : loaded === undefined ? [] : [loaded];

          for (const record of records) {
            const associated = record as { validate?: () => Promise<boolean> } | null;
            if (!associated || typeof associated.validate !== "function") continue;

            if (!(await associated.validate())) {
              this.errors.add(name, "is invalid");
              break;
            }
          }
        }
      });
    }

    /**
     * Runs the validations, in a context.
     *
     * Rails' `valid?(:context)`. Without one the context is `create` or
     * `update`, decided by whether the record has been saved.
     */
    async validate(context?: string): Promise<boolean> {
      this.errors.clear();
      await runCallbacks(this, "validation", async () => {
        await this.runValidations(context);
      });
      return this.errors.isEmpty;
    }

    /**
     * Saves the record, returning false when validation fails.
     *
     * The callback order is Rails': validation, then save wrapping either
     * create or update.
     */
    async save(): Promise<boolean> {
      checkWritable("save");

      const klass = this.constructor as typeof BaseModel;
      const autosaving = this.loadedAutosaves(klass);

      if (Object.keys(this[NESTED]).length === 0 && autosaving.length === 0) {
        return await this.saveRecord();
      }

      // ponytail: the children run on the class's connection, which is the
      // same one on SQLite and on any adapter handing out a single connection.
      // Pooled adapters need the transaction pinned first — the same gap the
      // transactional test helper documents.
      try {
        return await klass.connection.transaction(async () => {
          // Before the owner, because the owner holds the key and cannot
          // point at a row that does not exist yet.
          for (const { definition, records } of autosaving) {
            if (definition.kind !== "belongsTo") continue;

            await this.saveAutosaved(definition, records);
          }

          if (!(await this.saveWithNested(klass))) throw NESTED_ROLLBACK;

          // After it, because these are the side holding the key and it is
          // the owner's id they need.
          for (const { definition, records } of autosaving) {
            if (definition.kind === "belongsTo") continue;

            await this.saveAutosaved(definition, records);
          }

          return true;
        });
      } catch (error) {
        // A form that half-saves is not a state an application can reach.
        if (error === NESTED_ROLLBACK) return false;
        throw error;
      }
    }

    /**
     * The autosaving associations that have something loaded.
     *
     * Only what is in memory. Fetching an association in order to save it
     * would turn every save into a query per association, and nothing that
     * was never read can have been changed.
     */
    private loadedAutosaves(
      klass: typeof BaseModel,
    ): { definition: AssociationDefinition; records: InstanceLike[] }[] {
      const found: { definition: AssociationDefinition; records: InstanceLike[] }[] = [];

      for (const definition of Object.values(klass.associations)) {
        if (!definition.autosave) continue;

        const loaded = (this as unknown as Record<string, unknown>)[cacheKey(definition.name)];
        if (loaded === undefined || loaded === null) continue;

        const records = (Array.isArray(loaded) ? loaded : [loaded]) as InstanceLike[];
        if (records.length > 0) found.push({ definition, records });
      }

      return found;
    }

    /** Saves the loaded records of one autosaving association. */
    private async saveAutosaved(
      definition: AssociationDefinition,
      records: InstanceLike[],
    ): Promise<void> {
      const klass = this.constructor as typeof BaseModel;

      for (const record of records) {
        const child = record as unknown as {
          isNewRecord: boolean;
          changed(): string[];
          save(): Promise<boolean>;
        };

        // Untouched records are skipped rather than saved and found clean:
        // a loaded collection of a hundred comments should not be a hundred
        // statements because one of them changed.
        if (!child.isNewRecord && child.changed().length === 0) continue;

        // A child of a to-many association needs the key pointing back, which
        // it will not have if it was built rather than loaded.
        if (definition.kind !== "belongsTo") {
          const foreignKey = definition.foreignKey ?? defaultForeignKey(klass.name);
          const owner = this[ATTRIBUTES][definition.primaryKey ?? klass.primaryKey];

          (record as Record<string, unknown>)[foreignKey] ??= owner;
        }

        if (!(await child.save())) throw NESTED_ROLLBACK;
      }
    }

    private async saveWithNested(klass: typeof BaseModel): Promise<boolean> {
      const pending = Object.entries(this[NESTED]);

      // A belongs_to child has to exist before its owner, because the owner is
      // the side holding the key.
      for (const [name, payload] of pending) {
        const definition = klass.associationFor(name);
        if (definition.kind === "belongsTo")
          await this.applyNestedParent(klass, definition, payload);
      }

      if (!(await this.saveRecord())) return false;

      for (const [name, payload] of pending) {
        const definition = klass.associationFor(name);
        if (definition.kind === "belongsTo") continue;

        if (definition.kind === "hasMany") await this.applyNestedMany(klass, definition, payload);
        else await this.applyNestedChild(klass, definition, payload);
      }

      this[NESTED] = {};
      return true;
    }

    /** A collection the owner's key points back to: has_many. */
    private async applyNestedMany(
      klass: typeof BaseModel,
      definition: AssociationDefinition,
      payload: unknown,
    ): Promise<void> {
      const options = klass.nestedAttributes[definition.name] ?? {};
      const target = definition.target() as unknown as NestedModel;
      const records = normalizeCollection(payload);

      if (options.limit !== undefined && records.length > options.limit) {
        throw new NestedAttributesLimitExceeded(definition.name, options.limit, records.length);
      }

      const foreignKey = definition.foreignKey ?? defaultForeignKey(klass.name);
      const ownerId = this[ATTRIBUTES][klass.primaryKey];

      for (const attributes of records) {
        const id = existingId(attributes, target.primaryKey);
        const values = withoutControlKeys(attributes, target.primaryKey);

        if (id === undefined) {
          // Rails ignores a destroy flag on a record that does not exist yet.
          if (marksForDestruction(attributes)) continue;
          if (options.rejectIf?.(attributes)) continue;

          await target.build({ ...values, [foreignKey]: ownerId }).saveOrFail();
          continue;
        }

        // Scoped to the owner, so an id typed into a form cannot reach a
        // record belonging to someone else.
        const child = await target
          .where({ [target.primaryKey]: id, [foreignKey]: ownerId })
          .first();
        if (!child) throw new NestedRecordNotFound(definition.name, id);

        if (marksForDestruction(attributes)) {
          if (options.allowDestroy) await child.destroy();
          continue;
        }
        if (options.rejectIf?.(attributes)) continue;

        child.assign(values);
        await child.saveOrFail();
      }
    }

    /** A single record the owner's key points back to: has_one. */
    private async applyNestedChild(
      klass: typeof BaseModel,
      definition: AssociationDefinition,
      payload: unknown,
    ): Promise<void> {
      const options = klass.nestedAttributes[definition.name] ?? {};
      const target = definition.target() as unknown as NestedModel;
      if (payload === null || typeof payload !== "object") return;

      const attributes = payload as Record<string, unknown>;
      const values = withoutControlKeys(attributes, target.primaryKey);
      const foreignKey = definition.foreignKey ?? defaultForeignKey(klass.name);
      const ownerId = this[ATTRIBUTES][klass.primaryKey];

      const existing = await target.where({ [foreignKey]: ownerId }).first();

      if (existing) {
        if (marksForDestruction(attributes)) {
          if (options.allowDestroy) await existing.destroy();
          return;
        }
        if (options.rejectIf?.(attributes)) return;

        existing.assign(values);
        await existing.saveOrFail();
        return;
      }

      if (marksForDestruction(attributes)) return;
      if (options.rejectIf?.(attributes)) return;

      await target.build({ ...values, [foreignKey]: ownerId }).saveOrFail();
    }

    /** A record this one's key points at: belongs_to. */
    private async applyNestedParent(
      klass: typeof BaseModel,
      definition: AssociationDefinition,
      payload: unknown,
    ): Promise<void> {
      const options = klass.nestedAttributes[definition.name] ?? {};
      const target = definition.target() as unknown as NestedModel;
      if (payload === null || typeof payload !== "object") return;

      const attributes = payload as Record<string, unknown>;
      const values = withoutControlKeys(attributes, target.primaryKey);
      const foreignKey = definition.foreignKey ?? defaultForeignKey(definition.target().name);
      const id = existingId(attributes, target.primaryKey) ?? this[ATTRIBUTES][foreignKey];

      if (id === undefined || id === null) {
        if (marksForDestruction(attributes)) return;
        if (options.rejectIf?.(attributes)) return;

        const parent = target.build(values);
        await parent.saveOrFail();
        this[ATTRIBUTES][foreignKey] = parent.attributes()[target.primaryKey];
        return;
      }

      const parent = await target.where({ [target.primaryKey]: id }).first();
      if (!parent) throw new NestedRecordNotFound(definition.name, id);

      if (marksForDestruction(attributes)) {
        if (options.allowDestroy) {
          await parent.destroy();
          this[ATTRIBUTES][foreignKey] = null;
        }
        return;
      }
      if (options.rejectIf?.(attributes)) return;

      parent.assign(values);
      await parent.saveOrFail();
      this[ATTRIBUTES][foreignKey] = parent.attributes()[target.primaryKey];
    }

    private async saveRecord(): Promise<boolean> {
      // Checked before validation: a suppressed save does nothing at all, and
      // running validations first would let a callback on them fire.
      if ((this.constructor as typeof BaseModel).suppressed) return true;

      if (!(await this.validate())) return false;

      const klass = this.constructor as typeof BaseModel;
      const creating = this.isNewRecord;

      const result = await runCallbacks(this, "save", async () => {
        await runCallbacks(this, creating ? "create" : "update", async () => {
          // Remembered for the commit callbacks, which run after the save and
          // cannot otherwise tell an insert from an update.
          this[WAS_NEW] = creating;

          if (creating) await this.insertRecord(klass);
          else await this.updateRecord(klass);
        });
        return true;
      });

      return result !== false;
    }

    /** Rails' `save!`. */
    async saveOrFail(): Promise<void> {
      if (!(await this.save())) throw new RecordInvalid(this.errors);
    }

    async update(values: Partial<A>): Promise<boolean> {
      this.assign(values);
      return await this.save();
    }

    protected async insertRecord(klass: typeof BaseModel): Promise<void> {
      const connection = klass.connection;
      await klass.columnTypes();
      const now = new Date();

      // Rails maintains each of these only if that column exists. A table with
      // one of the pair and not the other is ordinary — ActiveStorage's blobs
      // are only ever created — and naming a column that is not there fails
      // the insert outright.
      const present = await klass.columnNames();

      if (klass.recordTimestamps) {
        if (present.includes("created_at")) this[ATTRIBUTES].created_at ??= now;
        if (present.includes("updated_at")) this[ATTRIBUTES].updated_at = now;
      }

      // A hierarchy's rows record which class wrote them, root included.
      if (klass.stiRoot !== undefined || Object.keys(klass.descendants).length > 0) {
        this[ATTRIBUTES][klass.inheritanceColumn] ??= klass.name;
      }

      if (await klass.lockingEnabled()) this[ATTRIBUTES][klass.lockingColumn] ??= 0;

      const entries = Object.entries(this[ATTRIBUTES])
        .filter(([key, value]) => value !== undefined && key !== klass.primaryKey)
        // Ciphertext goes into the statement; the attribute in memory stays
        // plain, so the record reads back the way it was written.
        .map(([key, value]) => [key, klass.encryptFor(key, value)] as [string, unknown]);

      const table = connection.quote(klass.table);
      const columns = entries.map(([key]) => connection.quote(key)).join(", ");
      const placeholders = entries.map((_, index) => connection.placeholder(index)).join(", ");
      const bindings = entries.map(([, value]) => serialize(value, connection));

      if (entries.length === 0) {
        // MySQL has no DEFAULT VALUES; an empty column list means the same.
        const empty =
          connection.adapter === "mysql"
            ? `INSERT INTO ${table} () VALUES ()`
            : `INSERT INTO ${table} DEFAULT VALUES`;
        await connection.execute(empty);
      } else if (connection.supportsReturning) {
        const rows = await connection.query<Row>(
          `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`,
          bindings,
        );
        if (rows[0]) this[ATTRIBUTES] = klass.castRow(rows[0]);
      } else {
        // LAST_INSERT_ID() answers for the connection that ran the INSERT, and
        // a pool is free to hand the follow-up read a different one. The
        // transaction pins both to the same connection; inside an open
        // transaction it costs only a savepoint.
        await connection.transaction(async (scoped) => {
          await scoped.execute(
            `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`,
            bindings,
          );
          const rows = await scoped.query<Row>(
            `SELECT * FROM ${table} WHERE ${connection.quote(klass.primaryKey)} = LAST_INSERT_ID()`,
          );
          if (rows[0]) this[ATTRIBUTES] = klass.castRow(rows[0]);
        });
      }

      this[PERSISTED] = true;
      this[SAVED_CHANGES] = this.changes();
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    protected async updateRecord(klass: typeof BaseModel): Promise<void> {
      const connection = klass.connection;
      const changes = this.changedAttributes() as Record<string, unknown>;

      // Set once and never changed. Dropped from the update rather than
      // refused, which is what Rails does — a save that touched one is not an
      // error, it simply does not write that column.
      for (const column of klass.readonlyAttributes) delete changes[column];

      if (klass.recordTimestamps && (await klass.columnNames()).includes("updated_at")) {
        changes.updated_at = new Date();
      }

      // A save that writes nothing still happened, and what it changed is
      // nothing. Left alone, the record would keep answering with whatever the
      // save before it changed — so an after-save callback asking "did the
      // email change?" would say yes twice.
      if (Object.keys(changes).length === 0) {
        this[SAVED_CHANGES] = {};
        return;
      }

      // Optimistic locking: the version the record was read at goes in the
      // WHERE clause, and the new one in the SET. If someone else saved in
      // between, the row no longer matches and nothing is written.
      const locking = await klass.lockingEnabled();
      const readVersion = this[ORIGINAL][klass.lockingColumn];
      if (locking) changes[klass.lockingColumn] = Number(readVersion ?? 0) + 1;

      const entries = Object.entries(changes).map(
        ([key, value]) => [key, klass.encryptFor(key, value)] as [string, unknown],
      );
      const assignments = entries
        .map(([key], index) => `${connection.quote(key)} = ${connection.placeholder(index)}`)
        .join(", ");
      const bindings = entries.map(([, value]) => serialize(value, connection));

      // Every column that identifies the row, not just the primary key. On a
      // table whose key is unique only within a tenant, naming one column
      // matches every tenant's row and writes to all of them — a save that
      // reports success having edited somebody else's record.
      const identifying = klass.queryConstraintsList();

      for (const column of identifying) bindings.push(this[ATTRIBUTES][column]);

      let where = identifying
        .map(
          (column, at) =>
            `${connection.quote(column)} = ${connection.placeholder(entries.length + at)}`,
        )
        .join(" AND ");

      if (locking) {
        where += ` AND ${connection.quote(klass.lockingColumn)} = ${connection.placeholder(entries.length + identifying.length)}`;
        bindings.push(Number(readVersion ?? 0));
      }

      const sql = `UPDATE ${connection.quote(klass.table)} SET ${assignments} WHERE ${where}`;

      if (locking) {
        const affected = await connection.executeCount(sql, bindings);
        if (affected === 0) {
          throw new StaleObjectError(klass.name, this[ATTRIBUTES][klass.primaryKey]);
        }
      } else {
        await connection.execute(sql, bindings);
      }

      // Cast on the way back in: the binding went out in the adapter's own
      // spelling, and an attribute has to hold what its type promises. A raw
      // MySQL timestamp left in memory would not even sort against an ISO one.
      // `changes` is still the plain values; only the bindings were encrypted.
      Object.assign(this[ATTRIBUTES], klass.castRow(changes as Row, { encrypted: false }));
      this[SAVED_CHANGES] = this.changes();
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    async destroy(): Promise<boolean> {
      checkWritable("destroy");
      if (this.isNewRecord) return false;
      await this.handleDependents();
      const klass = this.constructor as typeof BaseModel;
      const connection = klass.connection;

      // Optimistic locking applies to a delete as much as to an update, and
      // for the same reason: somebody opened this record, somebody else
      // changed it, and the first is now acting on a version they never saw.
      // Without the version in the WHERE clause the row goes regardless.
      const locking = await klass.lockingEnabled();
      const readVersion = Number(this[ORIGINAL][klass.lockingColumn] ?? 0);

      const result = await runCallbacks(this, "destroy", async () => {
        const identifying = klass.queryConstraintsList();
        const bindings: unknown[] = identifying.map((column) => this[ATTRIBUTES][column]);
        let where = identifying
          .map((column, at) => `${connection.quote(column)} = ${connection.placeholder(at)}`)
          .join(" AND ");

        if (locking) {
          where += ` AND ${connection.quote(klass.lockingColumn)} = ${connection.placeholder(bindings.length)}`;
          bindings.push(readVersion);
        }

        const sql = `DELETE FROM ${connection.quote(klass.table)} WHERE ${where}`;

        if (locking) {
          const affected = await connection.executeCount(sql, bindings);

          if (affected === 0) {
            throw new StaleObjectError(klass.name, this[ATTRIBUTES][klass.primaryKey]);
          }
        } else {
          await connection.execute(sql, bindings);
        }

        this[PERSISTED] = false;
        this[DESTROYED] = true;
        return true;
      });

      return result !== false;
    }

    /**
     * Deals with the children before the owner goes.
     *
     * Before, not after: a foreign key constraint refuses to delete a row
     * something still points at, and an application that deletes the parent
     * first only works while nothing is enforcing the relationship.
     */
    protected async handleDependents(): Promise<void> {
      const klass = this.constructor as typeof BaseModel;

      for (const definition of Object.values(klass.associations)) {
        if (!definition.dependent || definition.kind === "belongsTo") continue;

        const children = await relationFor(this as unknown as InstanceLike, definition);

        if (definition.dependent === "restrict") {
          if (children.length > 0) {
            throw new DeleteRestricted(klass.name, definition.name, children.length);
          }
          continue;
        }

        if (definition.dependent === "destroy") {
          // One at a time, because destroying is what runs the child's own
          // callbacks and its own dependents. A bulk delete would skip both.
          for (const child of children) await (child as unknown as BaseModel).destroy();
          continue;
        }

        const target = definition.target();
        const foreignKey = definition.as
          ? `${definition.as}_id`
          : (definition.foreignKey ?? defaultForeignKey(klass.name));

        await target.where({ [foreignKey]: this[ATTRIBUTES][klass.primaryKey] }).updateAll({
          [foreignKey]: null,
        });
      }
    }

    async reload(): Promise<void> {
      const klass = this.constructor as typeof BaseModel;
      const connection = klass.connection;
      await klass.columnTypes();
      const rows = await connection.query<Row>(
        `SELECT * FROM ${connection.quote(klass.table)} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(0)}`,
        [this[ATTRIBUTES][klass.primaryKey]],
      );
      if (!rows[0]) throw new RecordNotFound(`${klass.name} no longer exists`);

      const row = klass.castRow(rows[0]);
      this[ATTRIBUTES] = row;
      this[ORIGINAL] = { ...row };
      this[PERSISTED] = true;
    }

    /**
     * The table's column names, read once per class.
     *
     * Rails asks the database at boot; asking lazily keeps model definition
     * free of I/O while still knowing whether timestamps exist.
     */
    static async columnNames(): Promise<string[]> {
      if (this.columnCache) return this.columnCache;

      const columns = await this.readColumns();

      // What makes dropping a column safe: named here, the running
      // application stops selecting it, and only then does the migration
      // remove it. Without the gap the deploy and the migration race.
      this.columnCache = this.ignoredColumns.length
        ? columns.filter((column) => !this.ignoredColumns.includes(column))
        : columns;

      return this.columnCache;
    }

    static async readColumns(): Promise<string[]> {
      return Object.keys(await this.columnTypes());
    }

    /**
     * Each column's logical type, read once per class.
     *
     * Needed because a driver's idea of a value is not the same on every
     * database: PostgreSQL hands back a bigint as a string, because one can be
     * larger than a JavaScript number holds, and a timestamp as a Date.
     */
    static async columnTypes(): Promise<Record<string, ColumnType>> {
      if (this.columnTypeCache) return this.columnTypeCache;

      const connection = this.connection;
      const reflection = schemaReflection();

      // A loaded schema cache is the whole point of dumping one: a boot that
      // asks the database for every model's columns pays a round trip per
      // model before it can serve anything. Nothing changes for an application
      // that never loaded one, which is why this is a check rather than a
      // replacement for the query below.
      if (reflection.schemaLoaded) {
        const schemas = await reflection.schemaCache.columns(connection, this.table);

        this.columnTypeCache = Object.fromEntries(
          schemas.map((column) => [column.name, columnTypeFor(column.type)]),
        );

        return this.columnTypeCache;
      }

      const rows =
        connection.adapter === "sqlite"
          ? // `table_xinfo`, not `table_info`: the plain one omits generated
            // columns, so a model would not know it has one — every read
            // would leave it out and every write would think it could set it.
            // `introspect.ts` reads them the same way, and the two agreeing is
            // the point of sharing the rule rather than repeating it.
            (
              await connection.query<Row>(`PRAGMA table_xinfo(${connection.quote(this.table)})`)
            ).filter((row) => SQLITE_VISIBLE.has(Number(row.hidden ?? 0)))
          : await connection.query<Row>(
              `SELECT column_name AS name, data_type AS type
               FROM information_schema.columns
               WHERE table_name = ${connection.placeholder(0)}
               ORDER BY ordinal_position`,
              [this.table],
            );

      const types: Record<string, ColumnType> = {};
      for (const row of rows) types[String(row.name)] = columnTypeFor(String(row.type));

      this.columnTypeCache = types;
      return types;
    }

    /**
     * Turns a driver's row into the shape the attribute types promise.
     *
     * The generated types say a bigint column is a number and a timestamp is a
     * string. Without this that is true on SQLite and false on PostgreSQL,
     * which is the kind of difference that only shows up in production.
     */
    static castRow(row: Row, options: { encrypted?: boolean } = {}): Row {
      const types = this.columnTypeCache;
      if (!types) return row;

      const decrypting = options.encrypted !== false;

      const cast: Row = {};

      for (const [key, value] of Object.entries(row)) {
        const options = this.encryptedAttributes[key];
        // Decrypt before casting: the column's type describes the plain value,
        // and the ciphertext is a string whatever the column says.
        // A declared type wins over the column's, which is the whole point of
        // declaring one: the column says varchar and the application says this
        // is a number.
        const declared = this.declaredAttributes[key];

        cast[key] =
          options && decrypting
            ? decryptValue(value, key, options)
            : declared
              ? declared.type.cast(value)
              : castValue(value, types[key]);
      }

      return cast;
    }

    static async hasTimestamps(): Promise<boolean> {
      const columns = await this.columnNames();
      return columns.includes("created_at") || columns.includes("updated_at");
    }
  }

  return BaseModel as unknown as ModelClass<A>;
}

/**
 * Casts one value to what its column's type promises.
 *
 * Only the differences a driver introduces are corrected. A column whose type
 * is unknown is left exactly as it arrived.
 */
function castValue(value: unknown, type: ColumnType | undefined): unknown {
  if (value === null || value === undefined || type === undefined) return value;

  switch (type) {
    case "integer":
    case "bigint":
    case "float":
    case "decimal": {
      // PostgreSQL returns a bigint as a string, because one can be larger
      // than a JavaScript number holds. Anything that would lose precision
      // keeps the string it arrived as rather than being quietly rounded.
      if (typeof value !== "string") return value;
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) || (type === "float" && Number.isFinite(numeric))
        ? numeric
        : value;
    }

    case "datetime":
    case "date":
      return value instanceof Date ? value.toISOString() : value;

    default:
      return value;
  }
}

/** Moves a parent's counter cache by one when a child is created or destroyed. */
/**
 * Touches the record a `belongs_to` points at.
 *
 * Loaded and touched rather than updated in place, so the parent's own
 * `touch: true` runs too — a comment on a post in a thread should move the
 * thread's clock as well, which is the whole reason the option chains.
 */
async function touchParent(record: object, name: string, columns: string[]): Promise<void> {
  const klass = (record as { constructor: unknown }).constructor as {
    associationFor(name: string): AssociationDefinition;
  };

  const definition = klass.associationFor(name);
  const target = definition.target() as ModelLike & {
    where(conditions: Record<string, unknown>): { first(): Promise<{ touch?: Function } | null> };
  };

  const foreignKey = definition.foreignKey ?? defaultForeignKey(target.name);
  const id = (record as { [ATTRIBUTES]: Record<string, unknown> })[ATTRIBUTES][foreignKey];

  // A child with no parent has no clock to move.
  if (id === null || id === undefined) return;

  const parent = await target.where({ [target.primaryKey]: id }).first();
  if (parent?.touch) await (parent.touch as (...args: string[]) => Promise<void>)(...columns);
}

async function adjustCounter(
  record: object,
  name: string,
  column: string,
  delta: 1 | -1,
): Promise<void> {
  const klass = (record as { constructor: unknown }).constructor as {
    associationFor(name: string): AssociationDefinition;
    connection: Connection;
  };

  const definition = klass.associationFor(name);
  const target = definition.target();
  const foreignKey = definition.foreignKey ?? defaultForeignKey(target.name);
  const id = (record as { [ATTRIBUTES]: Record<string, unknown> })[ATTRIBUTES][foreignKey];

  // A child with no parent has no counter to move.
  if (id === null || id === undefined) return;

  const connection = klass.connection;
  const counter = connection.quote(column);

  // COALESCE, because a parent created before the column existed has null in
  // it, and null + 1 is null — a counter that silently stops counting.
  await connection.execute(
    `UPDATE ${connection.quote(target.table)} SET ${counter} = COALESCE(${counter}, 0) ${delta > 0 ? "+" : "-"} 1 WHERE ${connection.quote(target.primaryKey)} = ${connection.placeholder(0)}`,
    [id],
  );
}

/**
 * A timestamp in the adapter's own spelling.
 *
 * MySQL rejects ISO 8601 outright: it wants `2026-01-01 12:00:00`, not the
 * same instant with a T and a Z in it.
 */
function formatTimestamp(connection: Connection, date: Date): string {
  const iso = date.toISOString();
  return connection.adapter === "mysql" ? iso.slice(0, 23).replace("T", " ") : iso;
}

/**
 * Whether a property is one the class defines a setter for.
 *
 * A method is not: only a real accessor should take a value away from the
 * attributes, and `attributes` or `save` arriving as a column name should
 * still be treated as a column.
 */
/**
 * Assigns values, routing anything the class defines a setter for through it.
 *
 * `Object.assign` onto the attribute bag writes past every accessor a model
 * declared — a normalized column would keep its untidy value, an enum would
 * store the word where the column wants an integer, and a plain password would
 * be written as a column of its own beside its hash. The constructor already
 * had this; `assign` did not, so `record.assign(...)` and `record.update(...)`
 * quietly behaved differently from `Model.create(...)`.
 */
function assignThrough(record: object, values: Record<string, unknown>): void {
  const bag = (record as { [ATTRIBUTES]: Record<string, unknown> })[ATTRIBUTES];

  for (const [key, value] of Object.entries(values)) {
    if (hasSetter(record, key)) (record as Record<string, unknown>)[key] = value;
    else bag[key] = value;
  }
}

function hasSetter(object: object, key: string): boolean {
  for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return typeof descriptor.set === "function";
  }
  return false;
}

/**
 * A stable string for comparing two structures.
 *
 * Keys are sorted, so a structure rebuilt in a different order is not read as
 * a change — which would make every save of an untouched record write.
 */
function stableJson(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, (_key, held: unknown) => {
      if (held === null || typeof held !== "object" || Array.isArray(held)) return held;

      return Object.fromEntries(
        Object.entries(held as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    });
  } catch {
    return String(value);
  }
}

/** Values the database cannot store directly are serialized on the way in. */
export function serialize(value: unknown, connection?: Connection): unknown {
  if (value instanceof Date) {
    return connection ? formatTimestamp(connection, value) : value.toISOString();
  }
  // Only SQLite, which has no boolean type and stores one as 0 or 1.
  // PostgreSQL has a real BOOLEAN and refuses an integer for it outright —
  // `column "active" is of type boolean but expression is of type integer` —
  // so converting unconditionally made every boolean write fail there. MySQL
  // accepts either, which is why this went unnoticed on two adapters out of
  // three until a test wrote a boolean on the third.
  if (typeof value === "boolean") {
    return connection && connection.adapter !== "sqlite" ? value : value ? 1 : 0;
  }
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Whether a name is the record's own bookkeeping rather than a column.
 *
 * Anything the proxy does not recognise becomes an attribute, which is what
 * makes `post.title = "x"` work without declaring a column — and it caught the
 * preload cache too. Preloading an association wrote `__preloaded_comments`
 * into the attributes, `changed()` then listed it, and the next save built an
 * UPDATE naming a column that does not exist:
 *
 *     Post.all().includes("comments")  ->  edit  ->  save
 *     SQLiteError: no such column: __preloaded_comments
 *
 * Which is an ordinary thing to do, and it threw.
 */
function isInternal(property: string): boolean {
  return property.startsWith(PRELOAD_PREFIX);
}

/**
 * The column a name means on this record, following an alias if there is one.
 *
 * Read from the constructor rather than closed over, so a subclass that
 * declares its own alias is honoured by the record it built.
 */
function columnFor(target: object, property: string): string {
  const aliases = (target.constructor as { attributeAliases?: Record<string, string> })
    .attributeAliases;

  return aliases?.[property] ?? property;
}

const PROXY_HANDLER: ProxyHandler<{ [ATTRIBUTES]: Record<string, unknown> }> = {
  get(target, property, receiver) {
    if (typeof property === "string" && !isInternal(property) && !Reflect.has(target, property)) {
      return target[ATTRIBUTES][columnFor(target, property)];
    }
    return Reflect.get(target, property, receiver) as unknown;
  },

  set(target, property, value, receiver) {
    if (typeof property === "string" && !isInternal(property) && !Reflect.has(target, property)) {
      target[ATTRIBUTES][columnFor(target, property)] = value;
      return true;
    }
    return Reflect.set(target, property, value, receiver);
  },

  has(target, property) {
    if (typeof property === "string" && columnFor(target, property) in target[ATTRIBUTES]) {
      return true;
    }
    return Reflect.has(target, property);
  },
};

/**
 * The static side of a model class.
 *
 * The finders take a polymorphic `this`, so `Post.find(1)` is typed as `Post`
 * rather than the base shape — which is what lets a subclass declare its own
 * association accessors and have them survive a query.
 */
/** What a model recorded about one `composedOf` declaration. */
export interface AggregateReflection {
  name: string;
  /** The columns the value object is built from. */
  columns: string[];
  /** Which column feeds which part of the value object. */
  mapping: Record<string, string>;
  /** Whether an all-null set of columns answers null rather than a value. */
  allowNil: boolean;
}

/**
 * How a value object maps onto columns. Rails' `composed_of` options.
 *
 * `from` and `to` rather than Rails' `constructor` and `converter`: the pair
 * is a conversion in each direction, and naming them for the direction says
 * which is which without having to remember the Rails word.
 */
export interface ComposedOfOptions<V, P extends Record<string, unknown>> {
  /** Column name to the name it takes on the value object. */
  mapping: Record<string, keyof P & string>;
  /** Builds the value object from the columns. */
  from: (parts: P) => V;
  /** Takes it apart again. */
  to: (value: V) => P;
  /**
   * Answers null when every mapped column is empty, rather than building a
   * value object out of nulls. On by default, as Rails' `allow_nil` is not —
   * because the alternative is an Address whose every field is null, which is
   * a thing that has to be checked for anyway and is worse at saying so.
   */
  allowNil?: boolean;
}

export interface ModelClass<A extends object> {
  new (values?: Partial<A>, persisted?: boolean): BaseModelInstance<A> & A;

  tableName: string;
  primaryKey: string;
  /** Rails' `query_constraints`: the columns that identify one row. */
  queryConstraints: string[] | undefined;
  queryConstraintsList(): string[];
  connectionOverride: Connection | undefined;
  columnCache: string[] | undefined;
  databaseName: string | undefined;
  connectsTo(options: { database: string }): void;
  columnTypeCache: Record<string, ColumnType> | undefined;
  columnTypes(): Promise<Record<string, ColumnType>>;
  castRow(row: Row, options?: { encrypted?: boolean }): Row;
  encryptedAttributes: Record<string, EncryptedAttributeOptions>;
  encrypts(name: string, options?: EncryptedAttributeOptions): void;
  /** Rails' `enum`: a column of integers the application reads as words. */
  enum(attribute: string, mapping: EnumMapping, options?: EnumOptions): void;
  enums: Record<string, EnumDefinition>;
  /** Rails' `normalizes`: tidied on the way in and in the lookups. */
  normalizes<V = string>(
    attribute: string,
    normalize: (value: V) => unknown,
    options?: NormalizeOptions,
  ): void;
  normalizeValueFor(attribute: string, value: unknown): unknown;
  normalizers: Record<string, NormalizeDefinition>;
  /** Rails' `serialize`: a column holding a structure. */
  serialize(column: string, coder?: { parse: (raw: string) => unknown }): void;
  /** Rails' `store`: a serialized column with named accessors. */
  store(column: string, accessors?: string[]): void;
  serializedColumns: Record<string, { parse: (raw: string) => unknown }>;
  associations: Record<string, AssociationDefinition>;
  readonly table: string;
  readonly connection: Connection;

  lockingColumn: string;
  lockingEnabled(): Promise<boolean>;

  /** Rails' `model_name`: every name derived from the class's. */
  readonly modelName: ModelName;

  inheritanceColumn: string;
  /** Subclasses sharing this table, keyed by the name stored in `type`. */
  descendants: Record<string, unknown>;
  stiRoot: unknown;
  inherit(): void;
  stiNames(): string[];
  usesInheritance(): Promise<boolean>;

  nestedAttributes: Record<string, NestedAttributesOptions>;
  acceptsNestedAttributesFor<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    options?: NestedAttributesOptions,
  ): void;

  all<T>(this: ModelConstructor<A, T>): Relation<T>;
  joinFor(name: string): JoinSpec;
  unscoped<T>(this: ModelConstructor<A, T>): Relation<T>;
  /** Rails' `default_scope`. Applies to writes as well as reads. */
  defaultScope(body: (relation: Relation<unknown>) => Relation<unknown>): void;
  defaultScoped<T>(this: ModelConstructor<A, T>): Relation<T>;
  nullRelation<T>(this: ModelConstructor<A, T>): Relation<T>;
  emptyScope<T>(this: ModelConstructor<A, T>): Relation<T>;
  scopeForCreate(): Record<string, unknown>;
  withUnscoped<T, R>(
    this: ModelConstructor<A, T>,
    body: (relation: Relation<T>) => R | Promise<R>,
  ): Promise<R>;
  defaultScopes: ((relation: Relation<unknown>) => Relation<unknown>)[];
  /** Rails' `has_secure_token`. */
  hasSecureToken(column: string, options?: { length?: number }): void;
  where<T>(this: ModelConstructor<A, T>, conditions: Conditions): Relation<T>;
  where<T>(this: ModelConstructor<A, T>, sql: string, ...bindings: unknown[]): Relation<T>;
  order<T>(this: ModelConstructor<A, T>, column: string, direction?: "asc" | "desc"): Relation<T>;
  /** Rails' `with`: a named subquery this query can select from. */
  with<T>(this: ModelConstructor<A, T>, expressions: WithExpressions): Relation<T>;
  /** Rails' `with_recursive`: the same, for a query that refers to itself. */
  withRecursive<T>(this: ModelConstructor<A, T>, expressions: WithExpressions): Relation<T>;
  /** Rails' `from`: select from something other than this model's table. */
  from<T>(this: ModelConstructor<A, T>, source: string): Relation<T>;
  limit<T>(this: ModelConstructor<A, T>, count: number): Relation<T>;
  find<T>(this: ModelConstructor<A, T>, ids: readonly unknown[]): Promise<T[]>;
  find<T>(this: ModelConstructor<A, T>, id: unknown): Promise<T>;
  findBy<T>(this: ModelConstructor<A, T>, conditions: Conditions): Promise<T | null>;
  first<T>(this: ModelConstructor<A, T>): Promise<T | null>;
  last<T>(this: ModelConstructor<A, T>): Promise<T | null>;
  build<T>(this: ModelConstructor<A, T>, values?: Partial<A>): T;
  create<T>(this: ModelConstructor<A, T>, values?: Partial<A>): Promise<T>;
  instantiate<T>(this: ModelConstructor<A, T>, row: Row): T;

  count(): Promise<number>;
  exists(conditions?: Conditions): Promise<boolean>;
  /** Rails' `after_commit`: deferred until the transaction actually commits. */
  afterCommit(callback: CommitCallback, options?: { on?: CommitAction }): void;
  /** Rails' `after_rollback`. */
  afterRollback(callback: CommitCallback): void;

  insertAll(rows: readonly Record<string, unknown>[], options?: BulkOptions): Promise<BulkResult>;
  insertAllOrFail(
    rows: readonly Record<string, unknown>[],
    options?: BulkOptions,
  ): Promise<BulkResult>;
  upsertAll(rows: readonly Record<string, unknown>[], options?: BulkOptions): Promise<BulkResult>;
  bulkContext(): BulkContext;

  findOrCreateBy<T>(
    this: ModelConstructor<A, T>,
    conditions: Conditions,
    extra?: Partial<A>,
  ): Promise<T>;
  findOrInitializeBy<T>(
    this: ModelConstructor<A, T>,
    conditions: Conditions,
    extra?: Partial<A>,
  ): Promise<T>;
  createOrFindBy<T>(
    this: ModelConstructor<A, T>,
    conditions: Conditions,
    extra?: Partial<A>,
  ): Promise<T>;
  transaction<R>(body: () => Promise<R>): Promise<R>;
  destroyAll(conditions?: Conditions): Promise<number>;
  scope(name: string, body: (relation: Relation<unknown>) => Relation<unknown>): void;
  columnNames(): Promise<string[]>;
  hasTimestamps(): Promise<boolean>;
  recordTimestamps: boolean;
  withoutTimestamps<T>(body: () => T | Promise<T>): Promise<T>;
  suppressed: boolean;
  suppress<T>(body: () => T | Promise<T>): Promise<T>;

  validations: ValidationDeclaration[];
  customValidations: CustomValidation[];
  /** Rails' `validates_with`: a rule the application wrote itself. */
  validatesWith(validator: Validator, options?: ValidationOptions): void;
  /** Rails' `validates_each`: one rule across several attributes. */
  validatesEach(
    attributes: string | readonly string[],
    body: (record: ValidationTarget, attribute: string, value: unknown) => void | Promise<void>,
    options?: ValidationOptions,
  ): void;
  validates(attribute: string, options: ValidationOptions): void;
  validatesPresenceOf(names: string | readonly string[], options?: ValidationOptions): void;
  validatesAbsenceOf(names: string | readonly string[], options?: ValidationOptions): void;
  validatesConfirmationOf(names: string | readonly string[], options?: ValidationOptions): void;
  validatesAcceptanceOf(names: string | readonly string[], options?: ValidationOptions): void;
  validatesLengthOf(
    names: string | readonly string[],
    rule?: LengthOptions,
    options?: ValidationOptions,
  ): void;
  validatesFormatOf(
    names: string | readonly string[],
    rule?: { with?: RegExp; without?: RegExp },
    options?: ValidationOptions,
  ): void;
  validatesInclusionOf(
    names: string | readonly string[],
    rule?: { in: readonly unknown[] },
    options?: ValidationOptions,
  ): void;
  validatesExclusionOf(
    names: string | readonly string[],
    rule?: { in: readonly unknown[] },
    options?: ValidationOptions,
  ): void;
  validatesComparisonOf(
    names: string | readonly string[],
    rule?: ComparisonOptions,
    options?: ValidationOptions,
  ): void;
  validatesNumericalityOf(
    names: string | readonly string[],
    rule?: NumericalityOptions,
    options?: ValidationOptions,
  ): void;
  validatesUniquenessOf(
    names: string | readonly string[],
    rule?: { scope?: string | string[] },
    options?: ValidationOptions,
  ): void;
  validatorsOn(attribute: string): ValidationOptions[];
  validators(): ValidationDeclaration[];
  clearValidators(): void;
  /** Rails' `validates_associated`. */
  validatesAssociated(...names: string[]): void;
  associatedValidations: string[];

  belongsTo<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    target: () => unknown,
    options?: AssociationOptions,
  ): void;
  hasMany<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    target: () => unknown,
    options?: AssociationOptions,
  ): void;
  hasOne<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    target: () => unknown,
    options?: AssociationOptions,
  ): void;
  hasManyThrough<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    through: string,
    options?: AssociationOptions & { source?: string },
  ): void;
  hasOneThrough<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    through: string,
    options?: AssociationOptions & { source?: string },
  ): void;
  destroyBy(conditions: Conditions): Promise<number>;
  deleteBy(conditions: Conditions): Promise<number>;
  strictLoadingByDefault: boolean;
  reflectOnAllAssociations(kind?: AssociationKind): AssociationDefinition[];
  reflectOnAssociation(name: string): AssociationDefinition | undefined;
  associationNames(): string[];
  attributeAliases: Record<string, string>;
  declaredAttributes: Record<string, DeclaredAttribute>;
  /** What `inspect` shows beyond the primary key. Rails' `attributes_for_inspect`. */
  attributesForInspect: string[] | "all";
  /** Rails' `attribute`: a type, and optionally a default, for one attribute. */
  attribute(name: string, type: string, options?: ModelAttributeOptions): void;
  declaredTypeFor(name: string): Type | undefined;
  declaredAttributeNames(): string[];
  aliasAttribute(alias: string, column: string): void;
  resolveAttributeName(name: string): string;
  aliasConditions(conditions: Conditions): Conditions;
  hasAndBelongsToMany<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    target: () => unknown,
    options?: { joinTable?: string; foreignKey?: string; associationForeignKey?: string },
  ): void;
  tokenDefinitions: Record<string, TokenDefinition>;
  generatesTokenFor(
    purpose: string,
    options?: { expiresIn?: number },
    fingerprint?: (record: never) => unknown,
  ): void;
  findSoleBy<M extends AnyModel>(this: M, conditions: Conditions): Promise<InstanceType<M>>;
  findByTokenFor<M extends AnyModel>(
    this: M,
    purpose: string,
    token: string,
  ): Promise<InstanceType<M> | null>;
  belongsToPolymorphic<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    types: Record<string, () => unknown>,
    options?: AssociationOptions,
  ): void;
  delegatedType<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    types: Record<string, () => unknown>,
    options?: AssociationOptions,
  ): void;
  delegatedClassFor(name: string, type: string): unknown;
  noTouching<T>(body: () => T | Promise<T>): Promise<T>;
  touchingDisabled: boolean;
  readonly inheritanceColumnName: string;
  generateUniqueSecureToken(length?: number): string;
  attrReadonly(...names: string[]): void;
  readonlyAttributes: string[];
  ignoreColumns(...names: string[]): void;
  ignoredColumns: string[];
  humanName(): string;
  readonly baseClass: unknown;
  readonly i18nScope: string;
  incrementCounter(column: string, id: unknown, by?: number): Promise<void>;
  decrementCounter(column: string, id: unknown, by?: number): Promise<void>;
  updateCounters(id: unknown, counters: Record<string, number>): Promise<void>;
  resetCounters(id: unknown, ...associations: string[]): Promise<void>;
  counterCacheColumn(name: string): string;
  columnsHash(): Promise<Record<string, ColumnSchema>>;
  columnForAttribute(name: string): Promise<ColumnSchema | undefined>;
  typeForAttribute(name: string): Promise<ColumnType | undefined>;
  columnDefaults(): Promise<Record<string, string | null>>;
  contentColumns(): Promise<string[]>;
  decrementCounter(column: string, id: unknown, by?: number): Promise<void>;
  afterCreateCommit(callback: unknown): void;
  afterUpdateCommit(callback: unknown): void;
  afterDestroyCommit(callback: unknown): void;
  afterSaveCommit(callback: unknown): void;
  aggregations: Record<string, AggregateReflection>;
  reflectOnAllAggregations(): AggregateReflection[];
  reflectOnAggregation(name: string): AggregateReflection | undefined;
  aggregationNames(): string[];
  composedOf<V, P extends Record<string, unknown>>(
    name: string,
    options: ComposedOfOptions<V, P>,
  ): void;
  associationFor(name: string): AssociationDefinition;

  defineCallbacks(names: string | string[], config?: unknown): void;
  setCallback(name: string, kind: string, filter: unknown, options?: unknown): void;
  skipCallback(name: string, kind: string, filter: unknown, options?: unknown): void;
}

/** A model constructor that produces `T`, used to infer the subclass type. */
export type ModelConstructor<A extends object, T> = new (
  values?: Partial<A>,
  persisted?: boolean,
) => T;

/**
 * Declared association types.
 *
 * Rails defines these methods when the class loads, which a type checker
 * cannot see. Declaring them keeps the accessors typed with no codegen:
 *
 *     class Post extends Model<PostAttributes>("posts") {
 *       declare user: BelongsTo<User>
 *       declare comments: HasMany<Comment>
 *
 *       static {
 *         this.belongsTo("user", () => User)
 *         this.hasMany("comments", () => Comment)
 *       }
 *     }
 *
 * The declaration is not optional: an association's name has to be a property
 * the model declares, so a typo is a type error rather than an association
 * nobody can reach.
 */
export type BelongsTo<T> = () => Promise<T | null>;
export type HasOne<T> = () => Promise<T | null>;
export type HasMany<T> = () => Relation<T>;

/**
 * Finds an association definition on a record's own class.
 *
 * Through associations hop between models, so preloading needs to ask the
 * intermediate record's class what its associations are.
 */
function resolveAssociation(owner: InstanceLike, name: string): AssociationDefinition {
  const klass = (
    owner as { constructor: { associationFor?: (n: string) => AssociationDefinition } }
  ).constructor;

  if (typeof klass.associationFor !== "function") {
    throw new Error(`Cannot resolve association "${name}": the record is not a model.`);
  }
  return klass.associationFor(name);
}

/** Rails' `underscore`d model name, used for error messages and params. */
export function modelName(klass: { name: string }): string {
  return underscore(klass.name);
}
