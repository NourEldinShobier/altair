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

export type Direction = "asc" | "desc";

export type WhereValue = unknown;
export type Conditions = Record<string, WhereValue>;

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
  /** Loads named associations for a batch of records, one query each. */
  preload?: (records: T[], names: string[]) => Promise<void>;
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

    for (const [column, value] of Object.entries(conditionsOrSql)) {
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
  includes(...names: string[]): Relation<T> {
    const next = this.#clone();
    next.#includes.push(...names);
    return next;
  }

  select(...columns: string[]): Relation<T> {
    const next = this.#clone();
    next.#selects = columns;
    return next;
  }

  #quoteColumn(column: string): string {
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

    let sql = `SELECT ${columns} FROM ${table}`;

    if (this.#wheres.length > 0) {
      const clauses = this.#wheres.map((clause) => {
        bindings.push(...clause.bindings);
        return clause.sql;
      });
      sql += ` WHERE ${clauses.join(" AND ")}`;
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

  async exists(): Promise<boolean> {
    return (await this.limit(1).toArray()).length > 0;
  }

  async pluck(column: string): Promise<unknown[]> {
    const { sql, bindings } = this.select(column).toSql();
    const rows = await this.connection.query<Row>(sql, bindings);
    return rows.map((row) => row[column]);
  }

  /** Rails' `find_each`, for iterating without loading everything at once. */
  async *each(batchSize = 1000): AsyncGenerator<T> {
    let offset = 0;
    for (;;) {
      const batch = await this.#firstOrdered().limit(batchSize).offset(offset).toArray();
      if (batch.length === 0) return;
      for (const record of batch) yield record;
      if (batch.length < batchSize) return;
      offset += batchSize;
    }
  }

  /** Deletes every matching row without instantiating or running callbacks. */
  async deleteAll(): Promise<void> {
    const { sql, bindings } = this.toSql();
    const deleted = sql.replace(/^SELECT .*? FROM/, "DELETE FROM");
    await this.connection.execute(deleted, bindings);
  }
}
