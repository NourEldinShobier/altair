/**
 * Raw SQL that comes back as records, ported from `ActiveRecord::Querying`'s
 * `find_by_sql`, `count_by_sql` and their async forms.
 *
 * `relation.ts` builds queries. Some queries it will never build — a recursive
 * CTE, a window function, a query tuned by hand against one server's planner —
 * and the alternative to this is a raw query returning plain rows, which
 * leaves the caller reading `row.created_at` as whatever the driver handed
 * back rather than as a date, and with no association, no dirty tracking and
 * no callbacks.
 *
 * Two things make that safe rather than a hole in the wall:
 *
 * - **Values are bound, never interpolated.** The whole point of dropping to
 *   SQL is that the statement is written by hand, and a statement written by
 *   hand with a value in it is the oldest vulnerability there is. The value
 *   goes in the bind list or it does not go.
 * - **A count is one number, checked.** `count_by_sql` reads the first column
 *   of the first row, which is only meaningful if the query returns one of
 *   each. A query that returns a row per group silently counts the first
 *   group, and the number that comes back is plausible.
 */

import { type AsyncExecutor, BoundedExecutor } from "./batch-loader.js";
import { FutureResult } from "./future-result.js";

/** A row exactly as the driver returned it. */
export type RawRow = Record<string, unknown>;

/** What turns a row into a record. The model, as much of it as this needs. */
export interface Instantiating<R> {
  name: string;
  instantiate: (row: RawRow) => R;
}

export class RawSqlBindingError extends TypeError {
  constructor(sql: string) {
    super(
      `The SQL passed to findBySql has ${String(
        (sql.match(/\?/g) ?? []).length,
      )} placeholders and a different number of bind values. A placeholder with no value is ` +
        `sent to the server as a literal question mark, and a value with no placeholder is ` +
        `dropped — neither raises, and both change what the query means.`,
    );
    this.name = "RawSqlBindingError";
  }
}

/**
 * Checks the statement against its binds before anything is sent.
 *
 * Rails leaves this to the driver, which reports it as a syntax error naming a
 * position rather than a mistake naming a query. Checked here it is the line
 * that wrote the SQL.
 */
export function checkBinds(sql: string, binds: readonly unknown[]): void {
  if ((sql.match(/\?/g) ?? []).length !== binds.length) throw new RawSqlBindingError(sql);
}

/**
 * Rails' `find_by_sql` — raw SQL, as records.
 *
 * Every row goes through the model, so a `created_at` is a date and a boolean
 * from SQLite is a boolean. Rows the model has no column for are kept: the
 * point of hand-written SQL is often the extra column, and dropping it would
 * make `SELECT posts.*, COUNT(*) AS comment_count` return posts with no count.
 */
export async function findBySql<R>(
  model: Instantiating<R>,
  sql: string,
  binds: readonly unknown[] = [],
  select: (sql: string, binds: readonly unknown[]) => Promise<RawRow[]> | RawRow[],
): Promise<R[]> {
  checkBinds(sql, binds);

  const rows = await select(sql, binds);

  return rows.map((row) => model.instantiate(row));
}

export class NotACount extends TypeError {
  constructor(columns: readonly string[]) {
    super(
      `countBySql expects one column, got ${columns.length === 0 ? "none" : columns.join(", ")}. ` +
        `Reading the first column of a query that returns several counts whichever happened to ` +
        `be first, and the number that comes back is plausible.`,
    );
    this.name = "NotACount";
  }
}

/**
 * Rails' `count_by_sql` — raw SQL, as one number.
 *
 * Zero for no rows, because a count that found nothing is a count of nothing —
 * `undefined` would make every caller write `?? 0`, and the one that forgets
 * renders "undefined items".
 *
 * The shape is checked: a query returning more than one column, or more than
 * one row, is not a count however much it looks like one.
 */
export async function countBySql(
  sql: string,
  binds: readonly unknown[] = [],
  select: (sql: string, binds: readonly unknown[]) => Promise<RawRow[]> | RawRow[],
): Promise<number> {
  checkBinds(sql, binds);

  const rows = await select(sql, binds);

  if (rows.length === 0) return 0;

  const columns = Object.keys(rows[0] as RawRow);

  if (columns.length !== 1 || rows.length > 1) throw new NotACount(columns);

  return Number(rows[0]?.[columns[0] as string] ?? 0);
}

// --- running one ahead of time ---------------------------------------------

/**
 * The executor deferred queries run on. Rails' `async_query_executor`.
 *
 * `batch-loader.ts` already owns the bounded executor and the reason for it —
 * every in-flight async query holds a connection, so an unbounded one takes
 * the whole pool and the synchronous queries actually rendering the page wait
 * for connections its own optimisation is holding. What is added here is the
 * *shared* one, so two call sites cannot each bound themselves to four and
 * between them run eight.
 */
let executor: AsyncExecutor = new BoundedExecutor();

export function asyncExecutor(): AsyncExecutor {
  return executor;
}

export function setAsyncExecutor(replacement: AsyncExecutor): void {
  executor = replacement;
}

export function resetAsyncExecutor(): void {
  executor = new BoundedExecutor();
}

/**
 * Posts work to the executor and hands back its result.
 *
 * The executor swallows failures, because the work it runs reports its own.
 * Here the caller is the one waiting, so the rejection has to reach them —
 * dropped, a failed query would leave a future pending for ever.
 */
function onExecutor<T>(body: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    executor.post(async () => {
      try {
        resolve(await body());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/**
 * Rails' `async_find_by_sql` — started now, collected later.
 *
 * Through the executor rather than started directly, so the bound applies. A
 * future started outside it is exactly the case the bound exists to prevent.
 */
export function asyncFindBySql<R>(
  model: Instantiating<R>,
  sql: string,
  binds: readonly unknown[] = [],
  select: (sql: string, binds: readonly unknown[]) => Promise<RawRow[]> | RawRow[],
): FutureResult<R[]> {
  checkBinds(sql, binds);

  return new FutureResult(async () => await onExecutor(() => findBySql(model, sql, binds, select)));
}

/** Rails' `async_count_by_sql`. */
export function asyncCountBySql(
  sql: string,
  binds: readonly unknown[] = [],
  select: (sql: string, binds: readonly unknown[]) => Promise<RawRow[]> | RawRow[],
): FutureResult<number> {
  checkBinds(sql, binds);

  return new FutureResult(async () => await onExecutor(() => countBySql(sql, binds, select)));
}
