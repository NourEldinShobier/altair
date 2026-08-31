/**
 * Reusing a query's shape across calls, ported from
 * `ActiveRecord::StatementCache` and the `cached_find_by` half of
 * `ActiveRecord::Core`.
 *
 * `Post.find(id)` runs the same query a few thousand times a minute with one
 * value changing. Building the SQL from scratch each time is real work — and it
 * is work whose *result* is identical, so the shape is built once and only the
 * values are substituted.
 *
 * The values are what make this dangerous, and the whole design is about that.
 * A cache keyed on the query *text* would be a cache keyed on user input: a
 * finder called with a thousand different ids would store a thousand entries,
 * which is an unbounded map an attacker fills at their leisure. So the key is
 * the query's *shape* — the columns, not the values — and the values travel as
 * binds. That is also why interpolating a value into the cached SQL is refused
 * rather than escaped: a cached statement is built once and reused forever, so
 * a single unquoted interpolation is not one injection, it is a permanent one.
 *
 * The second rule is about what may be bound at all. A `null`, an array, or a
 * range does not fit the shape the statement was built for — `WHERE id = ?`
 * with `null` matches nothing, silently, where `IS NULL` was meant — so those
 * values are refused rather than cached under a shape that cannot express them.
 */

/** A hole in a cached statement. Rails' `StatementCache::Substitute`. */
export class Substitute {
  constructor(readonly name?: string) {}
}

/** The object a builder block is handed. Rails' `StatementCache::Params`. */
export class Params {
  bind(name?: string): Substitute {
    return new Substitute(name);
  }
}

/** A piece of a cached statement: fixed text, or a hole. */
export type QueryPart = string | Substitute;

/**
 * Values a statement cannot be built for. Rails' `unsupported_value?`.
 *
 * Each of these changes the *shape* of the query rather than a value in it:
 * `null` needs `IS NULL`, an array needs `IN (?, ?, ?)` with as many holes as
 * it has elements, a range needs `BETWEEN`. Caching one of them under the
 * shape built for a scalar produces SQL that runs and matches the wrong rows,
 * which is the failure mode worth spending a check on.
 */
export function unsupportedValue(value: unknown): boolean {
  // Arrays, ranges and records are all `typeof "object"`, so one check covers
  // them; a separate `Array.isArray` branch was dead code that a mutation
  // control could not distinguish from its absence.
  return value === null || value === undefined || typeof value === "object";
}

export class UnsupportedBindValue extends Error {
  constructor(value: unknown) {
    super(
      `${describe(value)} cannot be bound into a cached statement: it needs a different query ` +
        `shape, not a different value. Caching it under the shape built for a scalar produces ` +
        `SQL that runs and matches the wrong rows.`,
    );
    this.name = "UnsupportedBindValue";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "An array";

  return `A ${typeof value}`;
}

/**
 * A statement with no holes. Rails' `StatementCache::Query`.
 *
 * `retryable` says whether the caller may re-run it after a dropped
 * connection. Only for a statement the database has not been told to change
 * anything by: retrying a `SELECT` costs a round trip, retrying an `INSERT`
 * after a connection died mid-write can produce the row twice.
 */
export class Query {
  constructor(
    readonly sql: string,
    readonly retryable = false,
  ) {}

  sqlFor(): string {
    return this.sql;
  }

  get holes(): number {
    return 0;
  }
}

/**
 * A statement with holes in it. Rails' `StatementCache::PartialQuery`.
 *
 * The holes are found once, at construction, and their positions kept —
 * because finding them per execution would be the work this exists to avoid.
 */
export class PartialQuery {
  readonly #indexes: number[];

  constructor(
    readonly parts: readonly QueryPart[],
    readonly retryable = false,
  ) {
    this.#indexes = parts
      .map((part, index) => (part instanceof Substitute ? index : -1))
      .filter((index) => index !== -1);
  }

  get holes(): number {
    return this.#indexes.length;
  }

  /**
   * Fills the holes with placeholders and hands back the binds in order.
   *
   * Placeholders, not values. Rails quotes into the SQL here; we do not,
   * because a cached statement is built once and reused for the life of the
   * process — one unquoted interpolation is a permanent injection rather than
   * a single bad query.
   */
  sqlFor(
    values: readonly unknown[],
    placeholder: (index: number) => string = () => "?",
  ): {
    sql: string;
    binds: unknown[];
  } {
    if (values.length !== this.#indexes.length) {
      throw new BindArityError(this.#indexes.length, values.length);
    }

    for (const value of values) {
      if (unsupportedValue(value)) throw new UnsupportedBindValue(value);
    }

    const filled = [...this.parts];
    const binds: unknown[] = [];

    this.#indexes.forEach((position, order) => {
      filled[position] = placeholder(order);
      binds.push(values[order]);
    });

    return { sql: filled.join(""), binds };
  }
}

export class BindArityError extends Error {
  constructor(expected: number, given: number) {
    super(
      `This statement has ${expected} bind${expected === 1 ? "" : "s"} and was given ${given}. ` +
        `A mismatch shifts every later value into the wrong column, which produces a query ` +
        `that runs and answers a question nobody asked.`,
    );
    this.name = "BindArityError";
  }
}

/**
 * Collects a query as it is built. Rails' `PartialQueryCollector`.
 *
 * `preparable` starts true and only ever goes false: any one fragment that
 * cannot be prepared makes the whole statement unpreparable, and a collector
 * that let a later fragment set it back would cache a statement built partly
 * from something that was never safe to cache.
 */
export class PartialQueryCollector {
  #parts: QueryPart[] = [];
  #binds: unknown[] = [];
  #preparable = true;
  retryable = true;

  append(text: string): this {
    this.#parts.push(text);

    return this;
  }

  addBind(value: unknown): this {
    this.#binds.push(value);
    this.#parts.push(new Substitute());

    return this;
  }

  addBinds(values: readonly unknown[]): this {
    values.forEach((value, index) => {
      if (index > 0) this.#parts.push(", ");

      this.#binds.push(value);
      this.#parts.push(new Substitute());
    });

    return this;
  }

  get preparable(): boolean {
    return this.#preparable;
  }

  /** One-way: anything unpreparable makes the whole statement so. */
  markUnpreparable(): void {
    this.#preparable = false;
  }

  value(): { parts: QueryPart[]; binds: unknown[] } {
    return { parts: [...this.#parts], binds: [...this.#binds] };
  }
}

/** Rails' `StatementCache.query` / `partial_query` / `partial_query_collector`. */
export function query(sql: string, retryable = false): Query {
  return new Query(sql, retryable);
}

export function partialQuery(parts: readonly QueryPart[], retryable = false): PartialQuery {
  return new PartialQuery(parts, retryable);
}

export function partialQueryCollector(): PartialQueryCollector {
  return new PartialQueryCollector();
}

/**
 * A built statement, ready to run with different values. Rails'
 * `StatementCache`.
 */
export class StatementCache {
  constructor(
    readonly builder: Query | PartialQuery,
    readonly retryable = builder.retryable,
  ) {}

  /** Rails' `StatementCache.create`. */
  static create(
    build: (params: Params) => readonly QueryPart[],
    retryable = false,
  ): StatementCache {
    return new StatementCache(new PartialQuery(build(new Params()), retryable), retryable);
  }

  /** Rails' `execute` — the SQL and the binds, for the connection to run. */
  execute(
    values: readonly unknown[] = [],
    placeholder?: (index: number) => string,
  ): { sql: string; binds: unknown[] } {
    if (this.builder instanceof Query) {
      if (values.length > 0) throw new BindArityError(0, values.length);

      return { sql: this.builder.sqlFor(), binds: [] };
    }

    return this.builder.sqlFor(values, placeholder);
  }
}

// --- the per-model cache ---------------------------------------------------

/**
 * The key a statement is cached under. Rails' `find_by_statement_cache_key`.
 *
 * The model and the *columns* — never the values. Keying on values would make
 * this an unbounded map filled by whatever ids arrive, which is a memory leak
 * anyone can trigger by iterating.
 */
export function findByStatementCacheKey(model: string, columns: readonly string[]): string {
  return `${model}(${[...columns].sort().join(",")})`;
}

const statements = new Map<string, StatementCache>();

/** Rails' `cached_find_by_statement`. */
export function cachedFindByStatement(
  model: string,
  columns: readonly string[],
  build: (params: Params) => readonly QueryPart[],
): StatementCache {
  const key = findByStatementCacheKey(model, columns);
  const held = statements.get(key);

  if (held) return held;

  const built = StatementCache.create(build, true);
  statements.set(key, built);

  return built;
}

/** Rails' `initialize_find_by_cache`. */
export function initializeFindByCache(): void {
  statements.clear();
}

export function findByStatementCache(): ReadonlyMap<string, StatementCache> {
  return statements;
}

/**
 * The statement a `find_by(column: value)` uses. Rails' `cached_find_by`.
 *
 * Refuses a value the shape cannot express rather than caching under it — see
 * `unsupportedValue`. The caller falls back to building a query normally,
 * which is what Rails' `find_by` does when it returns `super`.
 */
export function cachedFindBy(
  model: string,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
  quote: (name: string) => string = (name) => `"${name}"`,
  placeholder: (index: number) => string = () => "?",
): { sql: string; binds: unknown[] } {
  if (columns.length !== values.length) throw new BindArityError(columns.length, values.length);

  const statement = cachedFindByStatement(model, columns, (params) => {
    const parts: QueryPart[] = [`SELECT * FROM ${quote(table)} WHERE `];

    columns.forEach((column, index) => {
      if (index > 0) parts.push(" AND ");

      parts.push(`${quote(column)} = `, params.bind(column));
    });

    parts.push(" LIMIT 1");

    return parts;
  });

  return statement.execute(values, placeholder);
}

/**
 * Whether a query may be cached at all. Rails' `cacheable_query`.
 *
 * A query with no holes is cacheable but pointless to cache; one built from a
 * collector that went unpreparable is not cacheable at all.
 */
export function cacheableQuery(collector: PartialQueryCollector): boolean {
  return collector.preparable;
}
