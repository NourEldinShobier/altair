/**
 * Query building, ported from `ActiveRecord::Relation`.
 *
 * A relation is lazy and chainable, and only touches the database when it is
 * awaited or asked for a result — the property that makes `Post.where(...)`
 * composable in Rails. Making it a thenable is what gives us the same feel:
 *
 *     const posts = await Post.where({ published: true }).order("title").limit(10)
 *
 * Every value reaching SQL is bound, never interpolated. Column and table names
 * are quoted through the adapter, and anything used as an identifier is checked
 * against the model's known columns.
 */

import type { Connection, Row } from "./connection.js";
import { checkWritable } from "./databases.js";
// Used inside a method, long after both modules have finished loading.
import { serialize } from "./model.js";

export type Direction = "asc" | "desc";

export type WhereValue = unknown;
export type Conditions = Record<string, WhereValue>;

/** One table joined to another, and the columns that connect them. */
export interface JoinSpec {
  /** The table being joined in. */
  table: string;
  /** The column on this side. */
  from: string;
  /** The column on the joined table. */
  to: string;
  /** Extra conditions, as a polymorphic association needs on its type column. */
  where?: { column: string; value: unknown }[];
}

interface JoinClause extends JoinSpec {
  kind: "inner" | "left";
}

interface WhereClause {
  sql: string;
  bindings: unknown[];
}

export interface RelationSource<T> {
  connection: Connection;
  tableName: string;
  primaryKey: string;
  /** Turns a database row into a model instance. */
  instantiate: (row: Row) => T;
  /**
   * Work the source needs done before it can build records.
   *
   * A model has to know its column types to cast a row faithfully, and asking
   * the database for them is asynchronous while `instantiate` is not.
   */
  prepare?: () => Promise<void>;
  /**
   * Rewrites conditions before they become SQL.
   *
   * A deterministically encrypted column stores ciphertext, so matching it
   * means encrypting the value being looked for — wherever in a chain the
   * condition was added.
   */
  prepareConditions?: (conditions: Conditions) => Conditions;
  /**
   * How to reach an association's table from this one.
   *
   * Supplied by the model, because only it knows the associations. A relation
   * that had to guess would be inventing foreign keys.
   */
  joinFor?: (name: string) => JoinSpec;
  /** Loads named associations for a batch of records, one query each. */
  preload?: (records: T[], names: string[]) => Promise<void>;
}

/**
 * One batch of a walk.
 *
 * Not the relation itself: a relation is a thenable, and an async generator
 * awaits what it yields, so `yield relation` would deliver a loaded array.
 */
export interface Batch<T> {
  /** The primary keys this batch covers, in order. */
  keys: unknown[];
  /** A relation over exactly those rows, ready for `updateAll` or `includes`. */
  relation: Relation<T>;
}

export interface BatchOptions {
  /** How many rows a query reads at a time. Rails' 1000. */
  batchSize?: number;
  /** The primary key to begin at, inclusive. Rails' `start`. */
  start?: unknown;
  /** The primary key to stop at, inclusive. Rails' `finish`. */
  finish?: unknown;
  /** Which way to walk the key. */
  order?: Direction;
}

/** Raised by `find` and `first!` when nothing matches. Rails' RecordNotFound. */
export class RecordNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordNotFound";
  }
}

export class Relation<T> implements PromiseLike<T[]> {
  #source: RelationSource<T>;
  #wheres: WhereClause[] = [];
  #orders: { column: string; direction: Direction }[] = [];
  #limit: number | undefined;
  #offset: number | undefined;
  #selects: string[] | undefined;
  #includes: string[] = [];
  #groups: string[] = [];
  #havings: WhereClause[] = [];
  #distinct = false;
  #joins: JoinClause[] = [];
  /**
   * Records handed over by `includes`. Chaining clears this — `#clone` does not
   * copy it — so adding a condition re-queries rather than filtering a stale
   * array, which is how Rails behaves too.
   */
  #preloaded: T[] | undefined;

  constructor(source: RelationSource<T>) {
    this.#source = source;
  }

  #clone(): Relation<T> {
    const next = new Relation<T>(this.#source);
    next.#wheres = [...this.#wheres];
    next.#orders = [...this.#orders];
    next.#limit = this.#limit;
    next.#offset = this.#offset;
    next.#selects = this.#selects ? [...this.#selects] : undefined;
    next.#includes = [...this.#includes];
    next.#groups = [...this.#groups];
    next.#havings = [...this.#havings];
    next.#distinct = this.#distinct;
    next.#joins = [...this.#joins];
    return next;
  }

  get connection(): Connection {
    return this.#source.connection;
  }

  /**
   * Adds a condition.
   *
   * An object is a set of equality checks, with null becoming IS NULL and an
   * array becoming IN, exactly as Rails does. A string form takes bindings so
   * values are never interpolated.
   */
  where(conditions: Conditions): Relation<T>;
  where(sql: string, ...bindings: unknown[]): Relation<T>;
  where(conditionsOrSql: Conditions | string, ...bindings: unknown[]): Relation<T> {
    const next = this.#clone();

    if (typeof conditionsOrSql === "string") {
      next.#wheres.push({ sql: conditionsOrSql, bindings });
      return next;
    }

    const prepared = this.#source.prepareConditions?.(conditionsOrSql) ?? conditionsOrSql;

    for (const [column, value] of Object.entries(prepared)) {
      const quoted = this.#quoteColumn(column);

      if (value === null) {
        next.#wheres.push({ sql: `${quoted} IS NULL`, bindings: [] });
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          // Rails: an empty IN matches nothing rather than erroring.
          next.#wheres.push({ sql: "1 = 0", bindings: [] });
        } else {
          next.#wheres.push({
            sql: `${quoted} IN (${value.map(() => "?").join(", ")})`,
            bindings: value,
          });
        }
      } else {
        next.#wheres.push({ sql: `${quoted} = ?`, bindings: [value] });
      }
    }
    return next;
  }

  /** Rails' `where.not`, in its common single-condition form. */
  whereNot(conditions: Conditions): Relation<T> {
    const next = this.#clone();
    for (const [column, value] of Object.entries(conditions)) {
      const quoted = this.#quoteColumn(column);
      if (value === null) {
        next.#wheres.push({ sql: `${quoted} IS NOT NULL`, bindings: [] });
      } else if (Array.isArray(value)) {
        next.#wheres.push({
          sql: `${quoted} NOT IN (${value.map(() => "?").join(", ")})`,
          bindings: value,
        });
      } else {
        next.#wheres.push({ sql: `${quoted} != ?`, bindings: [value] });
      }
    }
    return next;
  }

  order(column: string, direction: Direction = "asc"): Relation<T> {
    const next = this.#clone();
    next.#orders.push({ column, direction });
    return next;
  }

  limit(count: number): Relation<T> {
    const next = this.#clone();
    next.#limit = count;
    return next;
  }

  offset(count: number): Relation<T> {
    const next = this.#clone();
    next.#offset = count;
    return next;
  }

  /**
   * Rails' `includes`: preload these associations for the whole result set.
   *
   * One extra query per association instead of one per row, which is the
   * difference between a list page that scales and an N+1.
   */
  /**
   * Joins an association's table. Rails' `joins`.
   *
   * An inner join, so a record with none of the association drops out — which
   * is what makes `Post.joins("comments")` mean "posts that have comments".
   */
  joins(...names: string[]): Relation<T> {
    return this.#addJoins("inner", names);
  }

  /**
   * Joins and keeps records that have none. Rails' `left_joins`.
   *
   * The one to use for counting: an inner join answers "how many posts have
   * comments" when the question was "how many comments has each post".
   */
  leftJoins(...names: string[]): Relation<T> {
    return this.#addJoins("left", names);
  }

  #addJoins(kind: "inner" | "left", names: string[]): Relation<T> {
    if (!this.#source.joinFor) {
      throw new Error("This relation cannot join: its source does not know the associations.");
    }

    const next = this.#clone();

    for (const name of names) {
      const spec = this.#source.joinFor(name);

      // Joining the same table twice produces a cross product, so a relation
      // that was told to join it twice joins it once.
      if (next.#joins.some((join) => join.table === spec.table)) continue;
      next.#joins.push({ ...spec, kind });
    }

    return next;
  }

  includes(...names: string[]): Relation<T> {
    const next = this.#clone();
    next.#includes.push(...names);
    return next;
  }

  /** Rails' `group`. */
  group(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#groups.push(...columns);
    return next;
  }

  /** Rails' `having`, which filters groups rather than rows. */
  having(sql: string, ...bindings: unknown[]): Relation<T> {
    const next = this.#clone();
    next.#havings.push({ sql, bindings });
    return next;
  }

  /** Rails' `distinct`. */
  distinct(value = true): Relation<T> {
    const next = this.#clone();
    next.#distinct = value;
    return next;
  }

  select(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#selects = columns;
    return next;
  }

  #quoteColumn(column: string): string {
    // A condition on a joined table names it: `comments.approved`.
    const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(column);

    if (dotted) {
      const [, table, name] = dotted;
      // Only a table this relation actually joined, so a condition cannot
      // reach a table the query does not mention.
      if (table !== this.#source.tableName && !this.#joins.some((join) => join.table === table)) {
        throw new Error(
          `Cannot filter on "${column}": this relation does not join "${table}". Add .joins("...") first.`,
        );
      }
      return `${this.connection.quote(table!)}.${this.connection.quote(name!)}`;
    }

    // Identifiers cannot be bound, so they are validated rather than escaped.
    // Anything that is not a plain column name is rejected outright.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new Error(`Invalid column name: ${column}`);
    }
    return `${this.connection.quote(this.#source.tableName)}.${this.connection.quote(column)}`;
  }

  /** The SQL and bindings this relation would run. Useful in tests and logs. */
  toSql(): { sql: string; bindings: unknown[] } {
    const connection = this.connection;
    const table = connection.quote(this.#source.tableName);
    const bindings: unknown[] = [];

    const columns = this.#selects
      ? this.#selects.map((column) => this.#quoteColumn(column)).join(", ")
      : `${table}.*`;

    let sql = `SELECT ${this.#distinct ? "DISTINCT " : ""}${columns} FROM ${table}`;

    for (const join of this.#joins) {
      const joined = connection.quote(join.table);
      const keyword = join.kind === "left" ? "LEFT OUTER JOIN" : "INNER JOIN";

      let on = `${table}.${connection.quote(join.from)} = ${joined}.${connection.quote(join.to)}`;

      // A polymorphic association needs its type column in the ON clause, not
      // the WHERE: on a left join, putting it in WHERE would drop the rows the
      // left join exists to keep.
      for (const condition of join.where ?? []) {
        bindings.push(condition.value);
        on += ` AND ${joined}.${connection.quote(condition.column)} = ?`;
      }

      sql += ` ${keyword} ${joined} ON ${on}`;
    }

    if (this.#wheres.length > 0) {
      const clauses = this.#wheres.map((clause) => {
        bindings.push(...clause.bindings);
        return clause.sql;
      });
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    if (this.#groups.length > 0) {
      sql += ` GROUP BY ${this.#groups.map((column) => this.#quoteColumn(column)).join(", ")}`;
    }

    if (this.#havings.length > 0) {
      const clauses = this.#havings.map((clause) => {
        bindings.push(...clause.bindings);
        return clause.sql;
      });
      sql += ` HAVING ${clauses.join(" AND ")}`;
    }

    if (this.#orders.length > 0) {
      const clauses = this.#orders.map(
        (order) =>
          `${this.#quoteColumn(order.column)} ${order.direction === "desc" ? "DESC" : "ASC"}`,
      );
      sql += ` ORDER BY ${clauses.join(", ")}`;
    }

    if (this.#limit !== undefined) sql += ` LIMIT ${Number(this.#limit)}`;
    if (this.#offset !== undefined) sql += ` OFFSET ${Number(this.#offset)}`;

    return { sql: this.#renumber(sql), bindings };
  }

  /**
   * PostgreSQL numbers its placeholders, so the `?` used while building is
   * rewritten once the final order is known.
   */
  #renumber(sql: string): string {
    if (this.connection.adapter !== "postgres") return sql;
    let index = 0;
    return sql.replaceAll("?", () => `$${++index}`);
  }

  /**
   * A copy of this relation that already holds its records.
   *
   * Used by `includes`, so a preloaded association is still a Relation and
   * runs no query when awaited.
   */
  resolvedWith(records: T[]): Relation<T> {
    const relation = new Relation<T>(this.#source);
    relation.#preloaded = records;
    return relation;
  }

  /** Runs the query and returns model instances, preloading any includes. */
  async toArray(): Promise<T[]> {
    if (this.#preloaded) return this.#preloaded;

    await this.#source.prepare?.();

    const { sql, bindings } = this.toSql();
    const rows = await this.connection.query<Row>(sql, bindings);
    const records = rows.map((row) => this.#source.instantiate(row));

    if (this.#includes.length > 0 && this.#source.preload) {
      await this.#source.preload(records, this.#includes);
    }
    return records;
  }

  /**
   * Makes the relation awaitable, which is what keeps chains lazy.
   *
   * The linter warns against a thenable class because one can be awaited by
   * accident. Here that is the whole design: a relation must be composable
   * until it is awaited, which is what makes `Post.where(...).order(...)` work
   * the way it does in Rails.
   */
  // oxlint-disable-next-line unicorn/no-thenable
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.toArray().then(onfulfilled, onrejected);
  }

  async first(): Promise<T | null> {
    const rows = await this.#firstOrdered().limit(1).toArray();
    return rows[0] ?? null;
  }

  /** Rails' `first!`. */
  async firstOrFail(): Promise<T> {
    const record = await this.first();
    if (!record) {
      throw new RecordNotFound(`Could not find ${this.#source.tableName} matching the conditions`);
    }
    return record;
  }

  async last(): Promise<T | null> {
    const relation = this.#clone();
    // Rails orders by the primary key when nothing else is specified.
    if (relation.#orders.length === 0) {
      relation.#orders.push({ column: this.#source.primaryKey, direction: "desc" });
    } else {
      relation.#orders = relation.#orders.map((order) => ({
        ...order,
        direction: order.direction === "asc" ? "desc" : "asc",
      }));
    }
    const rows = await relation.limit(1).toArray();
    return rows[0] ?? null;
  }

  #firstOrdered(): Relation<T> {
    if (this.#orders.length > 0) return this;
    return this.order(this.#source.primaryKey);
  }

  async count(): Promise<number> {
    const relation = this.#clone();
    relation.#orders = [];
    relation.#limit = undefined;
    relation.#offset = undefined;

    const { sql, bindings } = relation.toSql();
    const counted = sql.replace(
      /^SELECT .*? FROM/,
      `SELECT COUNT(*) AS ${this.connection.quote("count")} FROM`,
    );
    const rows = await this.connection.query<Row>(counted, bindings);
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Runs an aggregate over the current conditions.
   *
   * Rails spells these sum/average/minimum/maximum. They ignore order, limit
   * and offset, which would otherwise change the answer rather than the rows.
   */
  async #aggregate(fn: string, column: string): Promise<number | null> {
    const relation = this.#clone();
    relation.#orders = [];
    relation.#limit = undefined;
    relation.#offset = undefined;

    const { sql, bindings } = relation.toSql();
    const aggregated = sql.replace(
      /^SELECT .*? FROM/,
      `SELECT ${fn}(${relation.#quoteColumn(column)}) AS ${this.connection.quote("value")} FROM`,
    );

    const rows = await this.connection.query<Row>(aggregated, bindings);
    const value = rows[0]?.value;
    return value === null || value === undefined ? null : Number(value);
  }

  async sum(column: string): Promise<number> {
    return (await this.#aggregate("SUM", column)) ?? 0;
  }

  async average(column: string): Promise<number | null> {
    return await this.#aggregate("AVG", column);
  }

  async minimum(column: string): Promise<number | null> {
    return await this.#aggregate("MIN", column);
  }

  async maximum(column: string): Promise<number | null> {
    return await this.#aggregate("MAX", column);
  }

  async exists(): Promise<boolean> {
    return (await this.limit(1).toArray()).length > 0;
  }

  /** One column's values. Rails' `pluck`. */
  async pluck(column: string): Promise<unknown[]>;
  /** Several columns, as a row of values each. */
  async pluck(...columns: string[]): Promise<unknown[][]>;
  async pluck(...columns: string[]): Promise<unknown[] | unknown[][]> {
    const { sql, bindings } = this.select(...columns).toSql();
    const rows = await this.connection.query<Row>(sql, bindings);

    if (columns.length === 1) return rows.map((row) => row[columns[0] as string]);
    return rows.map((row) => columns.map((column) => row[column]));
  }

  /**
   * Iterates in batches, a record at a time. Rails' `find_each`.
   *
   *     for await (const post of Post.where({ draft: true }).findEach()) { … }
   *
   * The point is not to hold a million rows in memory at once. The other
   * point, less obvious and more important, is the cursor: batches walk
   * `WHERE id > last_seen` rather than counting with OFFSET.
   *
   * OFFSET is wrong twice over. The database scans and discards every row it
   * skips, so walking a large table is quadratic; and if the block deletes or
   * inserts anything, the offsets shift underneath the walk and records are
   * silently skipped. A queue drained with `destroy` inside the loop misses
   * half its rows — which is exactly what a batching helper is for.
   */
  async *findEach(options: BatchOptions = {}): AsyncGenerator<T> {
    for await (const batch of this.findInBatches(options)) {
      for (const record of batch) yield record;
    }
  }

  /** Rails' `find_in_batches`: an array at a time. */
  async *findInBatches(options: BatchOptions = {}): AsyncGenerator<T[]> {
    for await (const batch of this.inBatches(options)) {
      const records = await batch.relation.toArray();
      if (records.length > 0) yield records;
    }
  }

  /**
   * Rails' `in_batches`: a relation at a time.
   *
   * What makes bulk work possible without instantiating anything —
   * `batch.relation.updateAll(...)` keeps a long update off one lock.
   *
   * A `Batch` rather than the relation itself, because a relation is a
   * thenable and an async generator awaits whatever it yields: yielding one
   * directly would hand the caller a loaded array and quietly undo the point
   * of the method.
   */
  async *inBatches(options: BatchOptions = {}): AsyncGenerator<Batch<T>> {
    const size = options.batchSize ?? 1000;
    const direction = options.order ?? "asc";
    const key = this.#source.primaryKey;

    if (size < 1) throw new Error(`batchSize must be at least 1, got ${size}.`);

    // Rails ignores an order here and logs a warning. Ignoring the order
    // somebody wrote is a worse outcome than saying so: the walk has to be
    // ordered by the key it pages on, and a relation that quietly came back in
    // a different order than asked for is a bug found much later.
    if (this.#orders.length > 0) {
      throw new Error(
        `Cannot batch an ordered relation: batching walks the ${key} to page with a cursor. ` +
          `Drop the order, or load the records with toArray().`,
      );
    }

    if (this.#selects && !this.#selects.includes(key)) {
      throw new Error(`Batching needs ${key} in the select, since it is what the cursor reads.`);
    }

    const after = direction === "asc" ? ">" : "<";
    const before = direction === "asc" ? "<=" : ">=";

    let scope = this.order(key, direction);
    if (options.start !== undefined) {
      scope = scope.where(
        `${this.#quoteColumn(key)} ${direction === "asc" ? ">=" : "<="} ?`,
        options.start,
      );
    }
    if (options.finish !== undefined) {
      scope = scope.where(`${this.#quoteColumn(key)} ${before} ?`, options.finish);
    }

    // A limit on the relation is a limit on the whole walk, not on each batch.
    let remaining = this.#limit;
    let cursor: unknown;

    for (;;) {
      const take = remaining === undefined ? size : Math.min(size, remaining);
      if (take <= 0) return;

      let batch = scope.limit(take);
      if (cursor !== undefined) {
        batch = batch.where(`${this.#quoteColumn(key)} ${after} ?`, cursor);
      }

      const keys = (await batch.pluck(key)) as unknown[];
      if (keys.length === 0) return;

      cursor = keys.at(-1);
      if (remaining !== undefined) remaining -= keys.length;

      // Yielded as a relation over the keys just read, so the caller can add
      // `includes` or run `updateAll` against exactly this batch.
      // Ordered the same way the walk is: without this the batch comes back in
      // whatever order the database felt like, so a descending walk delivered
      // its batches backwards but each batch's contents forwards.
      yield {
        keys,
        relation: this.unordered()
          .where({ [key]: keys })
          .order(key, direction),
      };

      if (keys.length < take) return;
    }
  }

  /** @internal A copy with no order, limit or offset. */
  unordered(): Relation<T> {
    const next = this.#clone();
    next.#orders = [];
    next.#limit = undefined;
    next.#offset = undefined;
    return next;
  }

  /** Rails' `find_each`, under the name this had before batching was fixed. */
  each(batchSize = 1000): AsyncGenerator<T> {
    return this.findEach({ batchSize });
  }

  /** The WHERE clause and its bindings, shared by update and delete. */
  #whereClause(): { sql: string; bindings: unknown[] } {
    const bindings: unknown[] = [];
    if (this.#wheres.length === 0) return { sql: "", bindings };

    const clauses = this.#wheres.map((clause) => {
      bindings.push(...clause.bindings);
      return clause.sql;
    });
    return { sql: ` WHERE ${clauses.join(" AND ")}`, bindings };
  }

  #assertColumn(column: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      throw new Error(`Invalid column name: ${column}`);
    }
    return column;
  }

  /**
   * Updates every matching row in one statement.
   *
   * Rails' `update_all`: no callbacks, no validations, no instantiation. Fast,
   * and deliberately blunt — the name is the warning.
   */
  async updateAll(values: Record<string, unknown>): Promise<void> {
    checkWritable("update");
    const entries = Object.entries(values);
    if (entries.length === 0) return;

    const where = this.#whereClause();
    const assignments = entries
      .map(([column]) => `${this.connection.quote(this.#assertColumn(column))} = ?`)
      .join(", ");

    const statement = `UPDATE ${this.connection.quote(this.#source.tableName)} SET ${assignments}${where.sql}`;

    // Serialized the same way a single save serializes. Without this a Date
    // reaches the driver as an object and is refused outright — so
    // `updateAll({ published_at: new Date() })`, which is the obvious use for
    // a bulk update, threw.
    await this.connection.execute(this.#renumber(statement), [
      ...entries.map(([, value]) => serialize(value, this.connection)),
      ...where.bindings,
    ]);
  }

  /** Deletes every matching row without instantiating or running callbacks. */
  async deleteAll(): Promise<void> {
    checkWritable("delete");
    const where = this.#whereClause();
    const statement = `DELETE FROM ${this.connection.quote(this.#source.tableName)}${where.sql}`;
    await this.connection.execute(this.#renumber(statement), where.bindings);
  }
}
