/**
 * One statement on its way to the database and back, ported from
 * `ActiveRecord::ConnectionAdapters::QueryIntent` and the `query_*` family in
 * `DatabaseStatements`.
 *
 * `connection.ts` owns the socket; `query_analysis.ts` decides what kind of
 * statement something is. This is the object in between — the *intent* — and
 * Rails introduced it for a reason that only shows up once queries can run
 * asynchronously.
 *
 * A synchronous query is a function call: text in, rows out. An asynchronous
 * one is three separate moments — the statement is built, the statement is
 * sent, the rows come back — and each of them needs different information. A
 * function call has nowhere to keep that, so every step ends up passing a
 * widening tuple to the next. The intent is that state made into a value:
 *
 * - **The result is fetched once and cast once.** Casting turns driver values
 *   into model values, and doing it twice is not just wasted work — a cast
 *   that is not idempotent (a string parsed to a date, then parsed again)
 *   produces different rows the second time.
 * - **Rows and the affected-row count are mutually exclusive.** A driver
 *   consumes the result to count updated rows, so asking for both means the
 *   second question gets an empty answer rather than an error. Both are
 *   refused after the other, loudly.
 * - **The intent knows where it came from.** A statement that turns up in a
 *   slow-query log is useless without the application line that built it, and
 *   by the time it reaches the log every frame between them is framework.
 */

import { writeQuery } from "./query_analysis.js";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export class QueryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryStateError";
  }
}

export interface QueryIntentOptions {
  sql: string;
  name?: string;
  binds?: readonly unknown[];
  /** Whether the adapter may replay this after a dropped connection. */
  allowRetry?: boolean;
  /** Where in the application this came from. */
  sourceLocation?: string;
}

/**
 * Rails' `QueryIntent`.
 *
 * Everything about one statement, from before it is sent to after the rows are
 * read. Rails made this a value rather than a chain of arguments because an
 * asynchronous query is three moments rather than one, and each of them needs
 * information the previous one had.
 */
export class QueryIntent {
  readonly sql: string;
  readonly name: string;
  readonly binds: readonly unknown[];
  readonly allowRetry: boolean;
  readonly sourceLocation: string | undefined;

  #processedSql: string | undefined;
  #rawResult: QueryResult | undefined;
  #rawResultAvailable = false;
  #executed = false;
  #castResult: Record<string, unknown>[] | undefined;
  #affectedRows: number | undefined;

  constructor({
    sql,
    name = "SQL",
    binds = [],
    allowRetry = false,
    sourceLocation,
  }: QueryIntentOptions) {
    this.sql = sql;
    this.name = name;
    this.binds = [...binds];
    this.allowRetry = allowRetry;
    this.sourceLocation = sourceLocation;
  }

  /**
   * Rails' `processed_sql` — the text actually sent, computed once.
   *
   * Once, because it is read by the logger, the query cache key, and the
   * adapter, and recomputing it in each would let them disagree — a cache key
   * built from text that is not what ran is a cache that answers with another
   * statement's rows.
   */
  get processedSql(): string {
    this.#processedSql ??= processedSql(this.sql, this.binds);

    return this.#processedSql;
  }

  get executed(): boolean {
    return this.#executed;
  }

  /** Rails' `raw_result_available?` — is the result here yet, without waiting. */
  get rawResultAvailable(): boolean {
    return this.#rawResultAvailable;
  }

  /** What the driver returned. Waiting for it is the caller's problem. */
  get rawResult(): QueryResult {
    if (!this.#rawResultAvailable || this.#rawResult === undefined) {
      throw new QueryStateError(
        `The result of ${JSON.stringify(this.name)} is not here yet. An asynchronous query has to ` +
          `be awaited before its rows are read; reading early would return an empty set that ` +
          `looks exactly like a query that matched nothing.`,
      );
    }

    return this.#rawResult;
  }

  set rawResult(value: QueryResult) {
    this.#rawResult = value;
    this.#rawResultAvailable = true;
    this.#executed = true;
  }

  /**
   * Rails' `cast_result` — driver values turned into model values.
   *
   * Memoised, and refused after `affectedRows`. A driver consumes the result
   * to count updated rows, so asking for rows afterwards would hand back an
   * empty set rather than an error — and an empty set is a normal answer.
   */
  castResult(
    cast: (result: QueryResult) => Record<string, unknown>[] = defaultCast,
  ): Record<string, unknown>[] {
    if (!this.#executed) throw new QueryStateError("This query has not run yet.");

    if (this.#affectedRows !== undefined) {
      throw new QueryStateError(
        `Cannot read rows from ${JSON.stringify(this.name)} after asking how many were affected: ` +
          `the driver consumed the result to count them, so the rows would come back empty — ` +
          `which is indistinguishable from a query that matched nothing.`,
      );
    }

    this.#castResult ??= cast(this.rawResult);

    return this.#castResult;
  }

  /** Rails' `affected_rows` — and the mirror of the rule above. */
  affectedRows(count: () => number): number {
    if (!this.#executed) throw new QueryStateError("This query has not run yet.");

    if (this.#castResult !== undefined) {
      throw new QueryStateError(
        `Cannot ask how many rows ${JSON.stringify(this.name)} affected after reading its rows: ` +
          `the result has been consumed, so the count would be zero — which is a normal answer.`,
      );
    }

    this.#affectedRows ??= count();

    return this.#affectedRows;
  }
}

/**
 * Rails' `preprocess_query` — the text that is actually sent.
 *
 * Binds are left as placeholders rather than interpolated. That is the whole
 * point of them: a value substituted into the text is a value the database
 * parses as SQL, and the parameter form is the only way a string containing a
 * quote is a string rather than a syntax error or worse.
 */
export function processedSql(sql: string, binds: readonly unknown[] = []): string {
  if (binds.length === 0) return sql;

  const placeholders = sql.match(/\?|\$\d+/g)?.length ?? 0;

  if (placeholders !== binds.length) {
    throw new QueryStateError(
      `This statement has ${placeholders} placeholders and ${binds.length} bound values. A ` +
        `mismatch either shifts every value one column left or leaves one unbound, and both ` +
        `produce rows rather than an error on most adapters.`,
    );
  }

  return sql;
}

/** Rails' `raw_sql` — the text with values in, for a log or an error. */
export function rawSql(sql: string, binds: readonly unknown[] = []): string {
  let index = 0;

  // For display only. Deliberately not the text that is sent: this quoting is
  // good enough to read and not good enough to trust, and building the two
  // from one function is how the display version ends up on the wire.
  return sql.replaceAll(/\?|\$\d+/g, () => showBind(binds[index++]));
}

function showBind(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return `'${String(value).replaceAll("'", "''")}'`;
}

function defaultCast(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
  );
}

// --- the query_* family --------------------------------------------------------

/**
 * Whatever actually sends the statement. Named for the role rather than
 * `Adapter`, which `connection.ts` already uses for the adapter *name*.
 */
export interface QueryRunner {
  run(intent: QueryIntent): Promise<QueryResult>;
}

/** Rails' `query_all` — every row, as objects. */
export async function queryAll(
  runner: QueryRunner,
  sql: string,
  options: Omit<QueryIntentOptions, "sql"> = {},
): Promise<Record<string, unknown>[]> {
  const intent = new QueryIntent({ sql, ...options });
  intent.rawResult = await runner.run(intent);

  return intent.castResult();
}

/** Rails' `query_rows` — every row, as arrays. */
export async function queryRows(
  runner: QueryRunner,
  sql: string,
  options: Omit<QueryIntentOptions, "sql"> = {},
): Promise<unknown[][]> {
  const intent = new QueryIntent({ sql, ...options });
  intent.rawResult = await runner.run(intent);

  return intent.rawResult.rows;
}

/** Rails' `query_one` — the first row, or nothing. */
export async function queryOne(
  runner: QueryRunner,
  sql: string,
  options: Omit<QueryIntentOptions, "sql"> = {},
): Promise<Record<string, unknown> | undefined> {
  return (await queryAll(runner, sql, options))[0];
}

/** Rails' `query_values` — the first column of every row. */
export async function queryValues(
  runner: QueryRunner,
  sql: string,
  options: Omit<QueryIntentOptions, "sql"> = {},
): Promise<unknown[]> {
  return (await queryRows(runner, sql, options)).map((row) => row[0]);
}

/**
 * Rails' `query_value` — one value, or nothing.
 *
 * `undefined` for no rows rather than raising, because "no rows" is the answer
 * to most of the questions this is used for — does this table exist, what is
 * the current schema version.
 */
export async function queryValue(
  runner: QueryRunner,
  sql: string,
  options: Omit<QueryIntentOptions, "sql"> = {},
): Promise<unknown> {
  return (await queryValues(runner, sql, options))[0];
}

/**
 * Rails' `query_command` — a statement run for its effect.
 *
 * Never retried. `query_all` may be replayed after a dropped connection
 * because reading twice costs time; replaying a write can apply it twice, and
 * the adapter cannot tell whether the first attempt landed before the
 * connection went.
 */
export async function queryCommand(
  runner: QueryRunner,
  sql: string,
  options: Omit<QueryIntentOptions, "sql" | "allowRetry"> = {},
): Promise<QueryIntent> {
  const intent = new QueryIntent({ sql, allowRetry: false, ...options });
  intent.rawResult = await runner.run(intent);

  return intent;
}

/** Rails' `raw_update_sql` — a write, reporting how many rows it touched. */
export async function rawUpdateSql(
  runner: QueryRunner,
  sql: string,
  countRows: (result: QueryResult) => number = (result) => result.rows.length,
): Promise<number> {
  const intent = await queryCommand(runner, sql);

  return intent.affectedRows(() => countRows(intent.rawResult));
}

/**
 * Rails' `execute_batch` — several statements as one unit.
 *
 * Sequential rather than concatenated, so a failure names the statement that
 * failed. A migration sending five changes as one string fails with a syntax
 * error at a character offset, and working out which of the five that is takes
 * longer than the migration did.
 */
export async function executeBatch(
  runner: QueryRunner,
  statements: readonly string[],
  options: Omit<QueryIntentOptions, "sql"> = {},
): Promise<number> {
  for (const [index, sql] of statements.entries()) {
    try {
      await queryCommand(runner, sql, options);
    } catch (error) {
      throw new QueryStateError(
        `Statement ${index + 1} of ${statements.length} failed: ${JSON.stringify(sql)}. ` +
          `${(error as Error).message}`,
      );
    }
  }

  return statements.length;
}

/**
 * Rails' `exec_insert_all` — one statement for many rows.
 *
 * Refused for an empty list rather than sending `INSERT INTO t () VALUES ()`,
 * which is a syntax error on some adapters and inserts one blank row on
 * others — and the second is worse, because it succeeds.
 */
export function execInsertAll(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): { sql: string; binds: unknown[] } {
  if (rows.length === 0) {
    throw new QueryStateError(
      `Nothing to insert into ${JSON.stringify(table)}. Sending an insert with no rows is a ` +
        `syntax error on some adapters and inserts one blank row on others, and the second is ` +
        `worse because it succeeds.`,
    );
  }

  const tuples = rows.map(() => `(${columns.map(() => "?").join(", ")})`);

  return {
    sql: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES ${tuples.join(", ")}`,
    binds: rows.flatMap((row) => [...row]),
  };
}

/** Rails' `execute_intent` — run one already-built intent. */
export async function executeIntent(
  runner: QueryRunner,
  intent: QueryIntent,
): Promise<QueryIntent> {
  intent.rawResult = await runner.run(intent);

  return intent;
}

// --- how a statement is sent ---------------------------------------------------

/**
 * Rails' `prepared_statements` — whether the adapter may prepare this.
 *
 * Off for a statement whose text changes every time. A prepared statement is
 * cached by its text on the server, so a statement built with values
 * interpolated fills that cache with entries used exactly once — and the
 * server evicts the ones that would have been reused.
 */
export function preparedStatements(sql: string, enabled = true): boolean {
  if (!enabled) return false;

  return /[?$:]\d*/.test(sql);
}

const disabledCache = new Set<string>();

/**
 * Rails' `prepared_statements_disabled_cache`.
 *
 * A statement that failed to prepare is remembered, so the adapter stops
 * trying. Some statements cannot be prepared on some servers — a `SET`, or
 * anything behind a pooler in transaction mode — and retrying the preparation
 * on every execution turns one failure into two round trips forever.
 */
export function preparedStatementsDisabledCache(): Set<string> {
  return disabledCache;
}

export function disablePreparedStatement(sql: string): void {
  disabledCache.add(sql);
}

export function resetPreparedStatementCache(): void {
  disabledCache.clear();
}

/**
 * Rails' `process_arguments` — bind values ready for the driver.
 *
 * `undefined` becomes `null`, because a driver given `undefined` for a
 * parameter either sends nothing — shifting every later value one column left
 * — or refuses. Shifting is worse: it writes real values into the wrong
 * columns and reports success.
 */
export function processArguments(binds: readonly unknown[]): unknown[] {
  return binds.map((value) => (value === undefined ? null : value));
}

/**
 * Rails' `query_source_location` — the application line a statement came from.
 *
 * The first frame outside the framework. A statement in a slow-query log is
 * useless without it, and by the time the statement reaches the log every
 * frame between the two is framework — so the search skips them rather than
 * taking the caller, which is always the adapter.
 */
export function querySourceLocation(
  stack: readonly string[],
  isFramework: (frame: string) => boolean = (frame) => /[/\\]packages[/\\]orm[/\\]/.test(frame),
): string | undefined {
  return stack.find((frame) => !isFramework(frame));
}

/** Rails' `raw_connection` — the driver handle, for the rare thing that needs it. */
export function rawConnection<T>(pooled: { raw?: T }): T {
  if (pooled.raw === undefined) {
    throw new QueryStateError(
      "This connection has no driver handle — it has been returned to the pool or closed. Using " +
        "one held past its checkout is how a statement lands on a connection another request is " +
        "using.",
    );
  }

  return pooled.raw;
}

/** Whether an intent may be replayed after a dropped connection. */
export function retryable(intent: QueryIntent): boolean {
  // A write is never replayed: the adapter cannot tell whether the first
  // attempt landed before the connection went, so replaying can apply it twice.
  return intent.allowRetry && !writeQuery(intent.sql);
}
