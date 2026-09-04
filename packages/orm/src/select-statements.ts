/**
 * The query shapes an adapter answers in, ported from
 * `ActiveRecord::ConnectionAdapters::DatabaseStatements`.
 *
 * `connection.query` returns rows as objects, which is right for reading
 * records and wasteful for everything else. Rails names four narrower shapes
 * because callers genuinely want them:
 *
 *   - `selectValue` — one scalar, for a COUNT or a MAX
 *   - `selectValues` — one column, for a list of ids
 *   - `selectRows` — arrays, for a report that does not need column names
 *   - `selectOne` — one row, for a lookup that expects at most one
 *
 * The saving is not only in typing. A `selectValues` over a million ids builds
 * one array rather than a million single-key objects, and the difference shows
 * up as memory rather than as time.
 */

import type { Connection, Row } from "./connection.js";

/** Every row, as objects. Rails' `select_all`. */
export async function selectAll(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<Row[]> {
  return await connection.query<Row>(sql, bindings);
}

/**
 * The first row, or null. Rails' `select_one`.
 *
 * Null rather than undefined, so it matches what a column holding nothing
 * gives back and a caller has one absence to check rather than two.
 */
export async function selectOne(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<Row | null> {
  return (await connection.query<Row>(sql, bindings))[0] ?? null;
}

/**
 * Every row as an array of its values. Rails' `select_rows`.
 *
 * Column order follows the SELECT, which is the point — a caller writing a CSV
 * or a fixed-width report has already decided the order in the query and
 * should not have to restate it as a list of keys.
 */
export async function selectRows(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<unknown[][]> {
  return (await connection.query<Row>(sql, bindings)).map((row) => Object.values(row));
}

/**
 * The first column of the first row, or null. Rails' `select_value`.
 *
 * For a COUNT, a MAX, an EXISTS — the queries whose whole answer is one
 * number, where going through an object costs a key lookup and a name the
 * caller invented.
 */
export async function selectValue(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<unknown> {
  const row = (await connection.query<Row>(sql, bindings))[0];

  return row === undefined ? null : (Object.values(row)[0] ?? null);
}

/**
 * The first column of every row. Rails' `select_values`.
 *
 * The shape a list of ids wants. Over a large result this builds one array
 * rather than one object per row, which is the difference between a list of
 * ids and a list of objects each holding one id.
 */
export async function selectValues(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<unknown[]> {
  return (await connection.query<Row>(sql, bindings)).map((row) => Object.values(row)[0] ?? null);
}

/**
 * One row keyed by its first two columns. Rails' `select_all` fed into a hash.
 *
 * For a lookup table read once and consulted many times — a settings table, a
 * translations table — where the alternative is a find per key.
 */
export async function selectPairs(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<Map<unknown, unknown>> {
  const rows = await connection.query<Row>(sql, bindings);

  return new Map(
    rows.map((row) => {
      const values = Object.values(row);

      return [values[0] ?? null, values[1] ?? null];
    }),
  );
}

/**
 * Runs a statement and reports how many rows it changed. Rails'
 * `exec_update` and `exec_delete`.
 *
 * The count is what tells an optimistic update whether it won: a lock-version
 * UPDATE that matched no rows changed nothing, and that is a conflict rather
 * than a success.
 */
export async function execUpdate(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<number> {
  return await connection.executeCount(sql, bindings);
}

/** The same, under the name a delete reads better as. */
export async function execDelete(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<number> {
  return await connection.executeCount(sql, bindings);
}

/** Runs a statement whose rows are wanted. Rails' `exec_query`. */
export async function execQuery(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<Row[]> {
  return await connection.query<Row>(sql, bindings);
}

/**
 * Inserts and reports the new row's primary key. Rails' `exec_insert`.
 *
 * RETURNING where the adapter has it, and a follow-up read where it does not —
 * which is the one place the three databases genuinely cannot be papered over,
 * since MySQL's last-insert-id is per connection and means nothing if the
 * insert and the read land on different ones.
 */
export async function execInsert(
  connection: Connection,
  sql: string,
  bindings: readonly unknown[] = [],
  primaryKey = "id",
): Promise<unknown> {
  if (connection.supportsReturning) {
    const row = (
      await connection.query<Row>(`${sql} RETURNING ${connection.quote(primaryKey)}`, bindings)
    )[0];

    return row === undefined ? null : (Object.values(row)[0] ?? null);
  }

  await connection.execute(sql, bindings);

  return await selectValue(connection, "SELECT LAST_INSERT_ID()");
}

/**
 * Whether a statement would read rather than write. Rails' `write_query?`,
 * inverted.
 *
 * Used to route a query to a replica. Conservative on purpose: anything not
 * recognisably a plain SELECT is treated as a write, because sending a write
 * to a replica fails loudly while sending a read to the primary merely costs
 * a little — the asymmetry decides which way to guess.
 */
export function isReadQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/^\(+/, "").toUpperCase();

  if (!/^(SELECT|WITH|SHOW|EXPLAIN|PRAGMA)\b/.test(trimmed)) return false;

  // A CTE can carry a write, and does whenever somebody writes
  // `WITH moved AS (DELETE ... RETURNING *) SELECT ...`.
  return !/\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(trimmed);
}

/** The other way round, under Rails' name. */
export function isWriteQuery(sql: string): boolean {
  return !isReadQuery(sql);
}
