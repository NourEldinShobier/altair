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

import { tableize, underscore } from "@altair/support";
import { Callbacks, callbackDecorators, runCallbacks } from "@altair/support";
import { connection as defaultConnection, type Connection, type Row } from "./connection.js";
import { Relation, RecordNotFound, type Conditions } from "./relation.js";
import { columnTypeFor } from "./dump.js";
import { checkWritable, currentScope, database, hasDatabases, type Role } from "./databases.js";
import type { ColumnType } from "./schema.js";
import {
  runValidation,
  type ValidationDeclaration,
  type ValidationOptions,
  type ValidationTarget,
} from "./validations.js";
import {
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

  on(attribute: string): string[] {
    return this.#errors.get(attribute) ?? [];
  }

  get attributes(): string[] {
    return [...this.#errors.keys()];
  }

  fullMessages(): string[] {
    return [...this.#errors.entries()].flatMap(([attribute, messages]) =>
      messages.map((message) => `${attribute} ${message}`),
    );
  }

  clear(): void {
    this.#errors.clear();
  }
}

const ATTRIBUTES = Symbol("altair.model.attributes");
const ORIGINAL = Symbol("altair.model.original");
// Instance state is symbol-keyed rather than `#private`. A private field is
// bound to the real object, and every access here goes through a Proxy, so
// `this.#field` inside a getter would throw "invalid private field".
const PERSISTED = Symbol("altair.model.persisted");
const NESTED = Symbol("altair.model.nested");

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
  changed(): (keyof A & string)[];
  hasChanged(attribute?: keyof A & string): boolean;
  assign(values: Partial<A>): void;
  save(): Promise<boolean>;
  saveOrFail(): Promise<void>;
  update(values: Partial<A>): Promise<boolean>;
  destroy(): Promise<boolean>;
  reload(): Promise<void>;
  validate(): Promise<boolean>;
  /** Override to add validations. Push onto `this.errors` to fail. */
  runValidations(): Promise<void>;
  toJSON(): A;
  toParam(): string;
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

      this[ATTRIBUTES] = { ...attributes };
      this[ORIGINAL] = persisted ? { ...attributes } : {};
      this[PERSISTED] = persisted;
      this[NESTED] = nested;

      // ponytail: a Proxy gives attribute access without knowing the columns
      // up front. Generating accessors from the schema at codegen time would be
      // faster; swap it in when the CLI can emit them.
      return new Proxy(this, PROXY_HANDLER) as this;
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
      const relation = this.unscoped();

      // A subclass sees only its own rows and its subclasses'. The root sees
      // everything, which is what makes `Vehicle.all()` return cars and trucks.
      if (this.stiRoot === undefined) return relation;
      return relation.where({ [this.inheritanceColumn]: this.stiNames() });
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
            if (Array.isArray(cached)) {
              return Promise.resolve(cached);
            }
            return (async () => {
              await preloadAssociation([this], definition, resolveAssociation);
              return (this[cacheKey(definition.name)] as InstanceLike[]) ?? [];
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

    static where<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Relation<InstanceType<M>> {
      return this.all().where(conditions);
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

    /** Rails' `find`: by primary key, or a thrown RecordNotFound. */
    static async find<M extends typeof BaseModel>(this: M, id: unknown): Promise<InstanceType<M>> {
      const record = await this.all()
        .where({ [this.primaryKey]: id })
        .first();
      if (!record) {
        throw new RecordNotFound(
          `Could not find ${this.name} with ${this.primaryKey} = ${String(id)}`,
        );
      }
      return record;
    }

    /** Rails' `find_by`: the first match, or null. */
    static async findBy<M extends typeof BaseModel>(
      this: M,
      conditions: Conditions,
    ): Promise<InstanceType<M> | null> {
      return await this.all().where(conditions).first();
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
      return { ...this[ATTRIBUTES] } as A;
    }

    toJSON(): A {
      return this.attributes();
    }

    /** Rails' `to_param`, which the router uses when building a path. */
    toParam(): string {
      const klass = this.constructor as typeof BaseModel;
      return String(this[ATTRIBUTES][klass.primaryKey] ?? "");
    }

    assign(values: Partial<A>): void {
      const klass = this.constructor as typeof BaseModel;

      if (Object.keys(klass.nestedAttributes).length === 0) {
        Object.assign(this[ATTRIBUTES], values);
        return;
      }

      const { attributes, nested } = extractNested(
        values as Record<string, unknown>,
        klass.nestedAttributes,
      );

      Object.assign(this[ATTRIBUTES], attributes);
      Object.assign(this[NESTED], nested);
    }

    /** The attributes whose values differ from the last load or save. */
    changedAttributes(): Partial<A> {
      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(this[ATTRIBUTES])) {
        if (!Object.is(value, this[ORIGINAL][key])) changes[key] = value;
      }
      return changes as Partial<A>;
    }

    changed(): (keyof A & string)[] {
      return Object.keys(this.changedAttributes()) as (keyof A & string)[];
    }

    hasChanged(attribute?: keyof A & string): boolean {
      return attribute ? this.changed().includes(attribute) : this.changed().length > 0;
    }

    /**
     * Runs the declared validations. Override to add rules in code, calling
     * `super.runValidations()` to keep the declared ones.
     */
    async runValidations(): Promise<void> {
      const klass = this.constructor as typeof BaseModel;
      if (klass.validations.length === 0) return;

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
        await runValidation(this as unknown as ValidationTarget, declaration, probe);
      }
    }

    async validate(): Promise<boolean> {
      this.errors.clear();
      await runCallbacks(this, "validation", async () => {
        await this.runValidations();
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
      if (Object.keys(this[NESTED]).length === 0) return await this.saveRecord();

      const klass = this.constructor as typeof BaseModel;

      // ponytail: the children run on the class's connection, which is the
      // same one on SQLite and on any adapter handing out a single connection.
      // Pooled adapters need the transaction pinned first — the same gap the
      // transactional test helper documents.
      try {
        return await klass.connection.transaction(async () => {
          if (!(await this.saveWithNested(klass))) throw NESTED_ROLLBACK;
          return true;
        });
      } catch (error) {
        // A form that half-saves is not a state an application can reach.
        if (error === NESTED_ROLLBACK) return false;
        throw error;
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

      // Rails maintains these automatically when the columns exist.
      if (await klass.hasTimestamps()) {
        this[ATTRIBUTES].created_at ??= now;
        this[ATTRIBUTES].updated_at = now;
      }

      // A hierarchy's rows record which class wrote them, root included.
      if (klass.stiRoot !== undefined || Object.keys(klass.descendants).length > 0) {
        this[ATTRIBUTES][klass.inheritanceColumn] ??= klass.name;
      }

      if (await klass.lockingEnabled()) this[ATTRIBUTES][klass.lockingColumn] ??= 0;

      const entries = Object.entries(this[ATTRIBUTES]).filter(
        ([key, value]) => value !== undefined && key !== klass.primaryKey,
      );

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

      if (await klass.hasTimestamps()) changes.updated_at = new Date();
      if (Object.keys(changes).length === 0) return;

      // Optimistic locking: the version the record was read at goes in the
      // WHERE clause, and the new one in the SET. If someone else saved in
      // between, the row no longer matches and nothing is written.
      const locking = await klass.lockingEnabled();
      const readVersion = this[ORIGINAL][klass.lockingColumn];
      if (locking) changes[klass.lockingColumn] = Number(readVersion ?? 0) + 1;

      const entries = Object.entries(changes);
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
      Object.assign(this[ATTRIBUTES], klass.castRow(changes as Row));
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    async destroy(): Promise<boolean> {
      checkWritable("destroy");
      if (this.isNewRecord) return false;
      const klass = this.constructor as typeof BaseModel;
      const connection = klass.connection;

      const result = await runCallbacks(this, "destroy", async () => {
        await connection.execute(
          `DELETE FROM ${connection.quote(klass.table)} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(0)}`,
          [this[ATTRIBUTES][klass.primaryKey]],
        );
        this[PERSISTED] = false;
        return true;
      });

      return result !== false;
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
    static castRow(row: Row): Row {
      const types = this.columnTypeCache;
      if (!types) return row;

      const cast: Row = {};

      for (const [key, value] of Object.entries(row)) {
        cast[key] = castValue(value, types[key]);
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

/** Values the database cannot store directly are serialized on the way in. */
function serialize(value: unknown, connection?: Connection): unknown {
  if (value instanceof Date) {
    return connection ? formatTimestamp(connection, value) : value.toISOString();
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

const PROXY_HANDLER: ProxyHandler<{ [ATTRIBUTES]: Record<string, unknown> }> = {
  get(target, property, receiver) {
    if (typeof property === "string" && !Reflect.has(target, property)) {
      return target[ATTRIBUTES][property];
    }
    return Reflect.get(target, property, receiver) as unknown;
  },

  set(target, property, value, receiver) {
    if (typeof property === "string" && !Reflect.has(target, property)) {
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
  castRow(row: Row): Row;
  associations: Record<string, AssociationDefinition>;
  readonly table: string;
  readonly connection: Connection;

  lockingColumn: string;
  lockingEnabled(): Promise<boolean>;

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
  unscoped<T>(this: ModelConstructor<A, T>): Relation<T>;
  where<T>(this: ModelConstructor<A, T>, conditions: Conditions): Relation<T>;
  order<T>(this: ModelConstructor<A, T>, column: string, direction?: "asc" | "desc"): Relation<T>;
  limit<T>(this: ModelConstructor<A, T>, count: number): Relation<T>;
  find<T>(this: ModelConstructor<A, T>, id: unknown): Promise<T>;
  findBy<T>(this: ModelConstructor<A, T>, conditions: Conditions): Promise<T | null>;
  first<T>(this: ModelConstructor<A, T>): Promise<T | null>;
  last<T>(this: ModelConstructor<A, T>): Promise<T | null>;
  build<T>(this: ModelConstructor<A, T>, values?: Partial<A>): T;
  create<T>(this: ModelConstructor<A, T>, values?: Partial<A>): Promise<T>;
  instantiate<T>(this: ModelConstructor<A, T>, row: Row): T;

  count(): Promise<number>;
  exists(conditions?: Conditions): Promise<boolean>;
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
  belongsToPolymorphic<M extends AnyModel>(
    this: M,
    name: AssociationName<M>,
    types: Record<string, () => unknown>,
    options?: AssociationOptions,
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
