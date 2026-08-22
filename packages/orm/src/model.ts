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

export { RecordNotFound } from "./relation.js";

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

    static {
      this.defineCallbacks(["save", "create", "update", "destroy", "validation"]);
    }

    declare [ATTRIBUTES]: Record<string, unknown>;
    declare [ORIGINAL]: Record<string, unknown>;

    declare [PERSISTED]: boolean;
    readonly errors = new ValidationErrors();

    constructor(values: Partial<A> = {}, persisted = false) {
      super();
      this[ATTRIBUTES] = { ...(values as Record<string, unknown>) };
      this[ORIGINAL] = persisted ? { ...(values as Record<string, unknown>) } : {};
      this[PERSISTED] = persisted;

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

    static get connection(): Connection {
      return this.connectionOverride ?? defaultConnection();
    }

    static all<M extends typeof BaseModel>(this: M): Relation<InstanceType<M>> {
      return new Relation<InstanceType<M>>({
        connection: this.connection,
        tableName: this.table,
        primaryKey: this.primaryKey,
        instantiate: (row: Row) => this.instantiate(row) as InstanceType<M>,
      });
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

    /** @internal Turns a row into a persisted instance. */
    static instantiate<M extends typeof BaseModel>(this: M, row: Row): InstanceType<M> {
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
      Object.assign(this[ATTRIBUTES], values);
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

    /** Override to add validations. Push onto `this.errors` to fail. */
    async runValidations(): Promise<void> {}

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
      const now = new Date().toISOString();

      // Rails maintains these automatically when the columns exist.
      if (await klass.hasTimestamps()) {
        this[ATTRIBUTES].created_at ??= now;
        this[ATTRIBUTES].updated_at = now;
      }

      const entries = Object.entries(this[ATTRIBUTES]).filter(
        ([key, value]) => value !== undefined && key !== klass.primaryKey,
      );

      const table = connection.quote(klass.table);
      const columns = entries.map(([key]) => connection.quote(key)).join(", ");
      const placeholders = entries.map((_, index) => connection.placeholder(index)).join(", ");
      const bindings = entries.map(([, value]) => serialize(value));

      if (entries.length === 0) {
        await connection.execute(`INSERT INTO ${table} DEFAULT VALUES`);
      } else if (connection.supportsReturning) {
        const rows = await connection.query<Row>(
          `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`,
          bindings,
        );
        if (rows[0]) this[ATTRIBUTES] = { ...rows[0] };
      } else {
        await connection.execute(
          `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`,
          bindings,
        );
        const rows = await connection.query<Row>(
          `SELECT * FROM ${table} WHERE ${connection.quote(klass.primaryKey)} = LAST_INSERT_ID()`,
        );
        if (rows[0]) this[ATTRIBUTES] = { ...rows[0] };
      }

      this[PERSISTED] = true;
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    protected async updateRecord(klass: typeof BaseModel): Promise<void> {
      const connection = klass.connection;
      const changes = this.changedAttributes() as Record<string, unknown>;

      if (await klass.hasTimestamps()) changes.updated_at = new Date().toISOString();
      if (Object.keys(changes).length === 0) return;

      const entries = Object.entries(changes);
      const assignments = entries
        .map(([key], index) => `${connection.quote(key)} = ${connection.placeholder(index)}`)
        .join(", ");
      const bindings = entries.map(([, value]) => serialize(value));
      bindings.push(this[ATTRIBUTES][klass.primaryKey]);

      await connection.execute(
        `UPDATE ${connection.quote(klass.table)} SET ${assignments} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(entries.length)}`,
        bindings,
      );

      Object.assign(this[ATTRIBUTES], changes);
      this[ORIGINAL] = { ...this[ATTRIBUTES] };
    }

    async destroy(): Promise<boolean> {
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
      const rows = await connection.query<Row>(
        `SELECT * FROM ${connection.quote(klass.table)} WHERE ${connection.quote(klass.primaryKey)} = ${connection.placeholder(0)}`,
        [this[ATTRIBUTES][klass.primaryKey]],
      );
      if (!rows[0]) throw new RecordNotFound(`${klass.name} no longer exists`);

      this[ATTRIBUTES] = { ...rows[0] };
      this[ORIGINAL] = { ...rows[0] };
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
      const connection = this.connection;
      const probe = await connection.query<Row>(
        `SELECT * FROM ${connection.quote(this.table)} LIMIT 0`,
      );
      void probe;
      this.columnCache = await this.readColumns();
      return this.columnCache;
    }

    static async readColumns(): Promise<string[]> {
      const connection = this.connection;
      switch (connection.adapter) {
        case "sqlite": {
          const rows = await connection.query<Row>(`PRAGMA table_info(${this.table})`);
          return rows.map((row) => String(row.name));
        }
        default: {
          const rows = await connection.query<Row>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1",
            [this.table],
          );
          return rows.map((row) => String(row.name));
        }
      }
    }

    static async hasTimestamps(): Promise<boolean> {
      const columns = await this.columnNames();
      return columns.includes("created_at") || columns.includes("updated_at");
    }
  }

  return BaseModel as unknown as ModelClass<A>;
}

/** Values the database cannot store directly are serialized on the way in. */
function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
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

/** The static side of a model class, kept separate so the factory can be typed. */
export interface ModelClass<A extends object> {
  new (values?: Partial<A>, persisted?: boolean): BaseModelInstance<A> & A;

  tableName: string;
  primaryKey: string;
  connectionOverride: Connection | undefined;
  readonly table: string;
  readonly connection: Connection;

  all(): Relation<BaseModelInstance<A> & A>;
  where(conditions: Conditions): Relation<BaseModelInstance<A> & A>;
  order(column: string, direction?: "asc" | "desc"): Relation<BaseModelInstance<A> & A>;
  limit(count: number): Relation<BaseModelInstance<A> & A>;
  find(id: unknown): Promise<BaseModelInstance<A> & A>;
  findBy(conditions: Conditions): Promise<(BaseModelInstance<A> & A) | null>;
  first(): Promise<(BaseModelInstance<A> & A) | null>;
  last(): Promise<(BaseModelInstance<A> & A) | null>;
  count(): Promise<number>;
  exists(conditions?: Conditions): Promise<boolean>;
  build(values?: Partial<A>): BaseModelInstance<A> & A;
  create(values?: Partial<A>): Promise<BaseModelInstance<A> & A>;
  instantiate(row: Row): BaseModelInstance<A> & A;

  defineCallbacks(names: string | string[], config?: unknown): void;
  setCallback(name: string, kind: string, filter: unknown, options?: unknown): void;
  skipCallback(name: string, kind: string, filter: unknown, options?: unknown): void;
}

/** Rails' `underscore`d model name, used for error messages and params. */
export function modelName(klass: { name: string }): string {
  return underscore(klass.name);
}
