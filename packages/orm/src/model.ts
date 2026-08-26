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
import { secureToken } from "@altair/support";
import { camelize, pluralize, t, tableize, underscore } from "@altair/support";
import { Callbacks, callbackDecorators, runCallbacks } from "@altair/support";
import { connection as defaultConnection, type Connection, type Row } from "./connection.js";
import { Relation, RecordNotFound, type Conditions, type JoinSpec } from "./relation.js";
import { columnTypeFor } from "./dump.js";
import { decryptValue, encryptValue, type EncryptedAttributeOptions } from "./encryption.js";
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
  type ValidationDeclaration,
  type ValidationOptions,
  type ValidationTarget,
} from "./validations.js";
import { fingerprintMatches, generateToken, readToken, type TokenDefinition } from "./token_for.js";
import {
  PRELOAD_PREFIX,
  cacheKey,
  defaultForeignKey,
  preloadAssociation,
  relationFor,
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
export class StaleObjectError extends Error {
  constructor(
    readonly model: string,
    readonly id: unknown,
  ) {
    super(`Attempted to update a stale ${model} (id ${String(id)}).`);
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

/** Rails' `errors` object, in the shape apps actually use. */
export class ValidationErrors {
  #errors = new Map<string, string[]>();

  add(attribute: string, message: string): void {
    const existing = this.#errors.get(attribute) ?? [];
    existing.push(message);
    this.#errors.set(attribute, existing);
  }

  get isEmpty(): boolean {
    return this.#errors.size === 0;
  }

  get count(): number {
    return [...this.#errors.values()].reduce((total, messages) => total + messages.length, 0);
  }

  /** Rails calls it `size`. Both are here, because both get typed. */
  get size(): number {
    return this.count;
  }

  on(attribute: string): string[] {
    return this.#errors.get(attribute) ?? [];
  }

  get attributes(): string[] {
    return [...this.#errors.keys()];
  }

  /** Every message, by attribute. Rails' `messages`. */
  get messages(): Record<string, string[]> {
    return Object.fromEntries(this.#errors);
  }

  /** Whether anything went wrong with this attribute. Rails' `include?`. */
  has(attribute: string): boolean {
    return (this.#errors.get(attribute)?.length ?? 0) > 0;
  }

  /** Whether this exact message was added. Rails' `added?`. */
  added(attribute: string, message: string): boolean {
    return this.on(attribute).includes(message);
  }

  /** Drops an attribute's errors and returns them. Rails' `delete`. */
  delete(attribute: string): string[] {
    const messages = this.on(attribute);
    this.#errors.delete(attribute);
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
    return [...this.#errors.entries()].flatMap(([attribute, messages]) =>
      messages.map((message) => this.fullMessage(attribute, message)),
    );
  }

  /** The full messages for one attribute. Rails' `full_messages_for`. */
  fullMessagesFor(attribute: string): string[] {
    return this.on(attribute).map((message) => this.fullMessage(attribute, message));
  }

  /** So `for (const { attribute, message } of errors)` works. */
  *[Symbol.iterator](): Iterator<{ attribute: string; message: string }> {
    for (const [attribute, messages] of this.#errors) {
      for (const message of messages) yield { attribute, message };
    }
  }

  toJSON(): Record<string, string[]> {
    return this.messages;
  }

  clear(): void {
    this.#errors.clear();
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
const NESTED = Symbol("altair.model.nested");
// Whether the last save was an insert. Read by the commit callbacks, which
// run after both kinds and have no other way to tell them apart.
const WAS_NEW = Symbol("altair.model.wasNew");

export interface ModelOptions {
  primaryKey?: string;
  connection?: Connection;
}

/** The shape every model instance has, whatever its attributes. */
export interface BaseModelInstance<A> {
  readonly isNewRecord: boolean;
  readonly isPersisted: boolean;
  readonly errors: ValidationErrors;
  attributes(): A;
  changedAttributes(): Partial<A>;
  changes(): Record<string, [unknown, unknown]>;
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
export function Model<A extends object>(tableName?: string, options: ModelOptions = {}) {
  class BaseModel extends Callbacks {
    static tableName = tableName ?? "";
    static primaryKey = options.primaryKey ?? "id";
    static connectionOverride: Connection | undefined = options.connection;
    static columnCache: string[] | undefined;
    static columnTypeCache: Record<string, ColumnType> | undefined;
    static associations: Record<string, AssociationDefinition> = {};
    static validations: ValidationDeclaration[] = [];

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

    static {
      this.defineCallbacks(["save", "create", "update", "destroy", "validation"]);
    }

    declare [ATTRIBUTES]: Record<string, unknown>;
    declare [ORIGINAL]: Record<string, unknown>;

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

      for (const [key, value] of Object.entries(attributes)) {
        if (hasSetter(this, key)) declared[key] = value;
        else columns[key] = value;
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
     * One deliberate difference from Rails. There, a default scope also fills
     * in what `create` writes, so `default_scope { where(archived: true) }`
     * quietly makes every new record archived — it is the most complained
     * about behaviour in ActiveRecord, and the reason people are told to
     * avoid default scopes altogether.
     *
     * Here it narrows reads and nothing else. A scope is a statement about
     * which rows you want to see, and reading that as a statement about what
     * to write is a second meaning nobody asked for. `create` fills in what it
     * was given; `unscoped` escapes the reading.
     */
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
        // Column types have to be known before a row can be cast, and reading
        // them is asynchronous while instantiate is not.
        prepare: async () => {
          await this.columnTypes();
        },
        prepareConditions: (conditions) =>
          this.encryptConditions(
            this.enumConditions(normalizeConditions(this.normalizers, conditions)),
          ),
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
    static composedOf<V, P extends Record<string, unknown>>(
      name: string,
      options: ComposedOfOptions<V, P>,
    ): void {
      const columns = Object.keys(options.mapping);
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
      return new this(values) as InstanceType<M>;
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
        if (subclass) return new subclass(row as Partial<A>, true) as InstanceType<M>;
      }

      return new this(row as Partial<A>, true) as InstanceType<M>;
    }

    get isNewRecord(): boolean {
      return !this[PERSISTED];
    }

    get isPersisted(): boolean {
      return this[PERSISTED];
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
        this.validateRequiredParents(klass);
        await this.validateAssociated(klass);
        return;
      }

      const probe = {
        isPersisted: this.isPersisted,
        id: this[ATTRIBUTES][klass.primaryKey],
        exists: async (conditions: Conditions, excludeId?: unknown) => {
          let relation = klass.all().where(conditions);
          if (excludeId !== undefined)
            relation = relation.whereNot({ [klass.primaryKey]: excludeId });
          return await relation.exists();
        },
      };

      for (const declaration of klass.validations) {
        if (!(await declarationApplies(declaration.options, this, running))) continue;

        await runValidation(this as unknown as ValidationTarget, declaration, probe);
      }

      this.validateRequiredParents(klass);

      await this.validateAssociated(klass);
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
      if (present.includes("created_at")) this[ATTRIBUTES].created_at ??= now;
      if (present.includes("updated_at")) this[ATTRIBUTES].updated_at = now;

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
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    protected async updateRecord(klass: typeof BaseModel): Promise<void> {
      const connection = klass.connection;
      const changes = this.changedAttributes() as Record<string, unknown>;

      if ((await klass.columnNames()).includes("updated_at")) changes.updated_at = new Date();
      if (Object.keys(changes).length === 0) return;

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
      bindings.push(this[ATTRIBUTES][klass.primaryKey]);

      let where = `${connection.quote(klass.primaryKey)} = ${connection.placeholder(entries.length)}`;
      if (locking) {
        where += ` AND ${connection.quote(klass.lockingColumn)} = ${connection.placeholder(entries.length + 1)}`;
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
        const bindings: unknown[] = [this[ATTRIBUTES][klass.primaryKey]];
        let where = `${connection.quote(klass.primaryKey)} = ${connection.placeholder(0)}`;

        if (locking) {
          where += ` AND ${connection.quote(klass.lockingColumn)} = ${connection.placeholder(1)}`;
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
      this.columnCache = await this.readColumns();
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
      const rows =
        connection.adapter === "sqlite"
          ? await connection.query<Row>(`PRAGMA table_info(${connection.quote(this.table)})`)
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
        cast[key] =
          options && decrypting ? decryptValue(value, key, options) : castValue(value, types[key]);
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
  if (typeof value === "boolean") return value ? 1 : 0;
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

const PROXY_HANDLER: ProxyHandler<{ [ATTRIBUTES]: Record<string, unknown> }> = {
  get(target, property, receiver) {
    if (typeof property === "string" && !isInternal(property) && !Reflect.has(target, property)) {
      return target[ATTRIBUTES][property];
    }
    return Reflect.get(target, property, receiver) as unknown;
  },

  set(target, property, value, receiver) {
    if (typeof property === "string" && !isInternal(property) && !Reflect.has(target, property)) {
      target[ATTRIBUTES][property] = value;
      return true;
    }
    return Reflect.set(target, property, value, receiver);
  },

  has(target, property) {
    if (typeof property === "string" && property in target[ATTRIBUTES]) return true;
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
  defaultScopes: ((relation: Relation<unknown>) => Relation<unknown>)[];
  /** Rails' `has_secure_token`. */
  hasSecureToken(column: string, options?: { length?: number }): void;
  where<T>(this: ModelConstructor<A, T>, conditions: Conditions): Relation<T>;
  where<T>(this: ModelConstructor<A, T>, sql: string, ...bindings: unknown[]): Relation<T>;
  order<T>(this: ModelConstructor<A, T>, column: string, direction?: "asc" | "desc"): Relation<T>;
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
  transaction<R>(body: () => Promise<R>): Promise<R>;
  destroyAll(conditions?: Conditions): Promise<number>;
  scope(name: string, body: (relation: Relation<unknown>) => Relation<unknown>): void;
  columnNames(): Promise<string[]>;
  hasTimestamps(): Promise<boolean>;

  validations: ValidationDeclaration[];
  validates(attribute: string, options: ValidationOptions): void;
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
