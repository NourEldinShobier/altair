/**
 * Bulk writes, ported from `ActiveRecord::Persistence::ClassMethods`
 * (`insert_all`, `insert_all!`, `upsert_all`).
 *
 *     await Post.insertAll(rows)                       // skip what collides
 *     await Post.upsertAll(rows, { uniqueBy: "slug" }) // overwrite it
 *
 * One statement for ten thousand rows instead of ten thousand statements. A
 * seed script or an import that saves records one at a time spends nearly all
 * its time on round trips, and the difference is minutes against seconds.
 *
 * Deliberately blunt, as in Rails: no callbacks, no validations, nothing
 * instantiated. The name is the warning. What it does buy is atomicity — the
 * whole batch lands or none of it does, which one-at-a-time saving cannot
 * offer without a transaction the caller has to remember to open.
 *
 * The three adapters disagree about conflicts more than about anything else,
 * so this is where most of the file goes:
 *
 *     postgres/sqlite   INSERT … ON CONFLICT (cols) DO UPDATE SET … / DO NOTHING
 *     mysql             INSERT … ON DUPLICATE KEY UPDATE … / INSERT IGNORE
 */

import type { Connection, Row } from "./connection.js";
// Imported for its use inside a function, long after both modules have loaded.
import { serialize } from "./model.js";

export interface BulkOptions {
  /**
   * The columns a conflict is judged on. Postgres and SQLite need them named;
   * MySQL works them out from its own unique indexes and ignores this.
   */
  uniqueBy?: string | readonly string[];
  /** Columns to overwrite on a conflict. Defaults to everything given. */
  updateOnly?: readonly string[];
  /** How many rows go in one statement. */
  batchSize?: number;
  /** Sets `created_at`/`updated_at` when the table has them. */
  recordTimestamps?: boolean;
}

export type ConflictBehaviour = "raise" | "skip" | "update";

/** Raised when a batch is asked to do something an adapter cannot. */
export class UnsupportedBulkWrite extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBulkWrite";
  }
}

/**
 * Every column mentioned by any row, in first-seen order.
 *
 * A batch has to be one statement with one column list, so a row that omits a
 * column gets NULL for it rather than a shorter tuple. Rails does the same,
 * and the alternative — a statement per distinct shape — quietly turns one
 * round trip back into many.
 */
export function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const columns: string[] = [];

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (row[key] !== undefined && !columns.includes(key)) columns.push(key);
    }
  }

  return columns;
}

function conflictTarget(uniqueBy: BulkOptions["uniqueBy"]): string[] {
  if (uniqueBy === undefined) return [];
  return Array.isArray(uniqueBy) ? [...uniqueBy] : [uniqueBy as string];
}

export interface BulkStatement {
  sql: string;
  bindings: unknown[];
}

/**
 * Builds one statement for one batch.
 *
 * Exported so a caller can see what would run, and so the adapter differences
 * can be tested without three databases.
 */
export function bulkStatement(
  connection: Connection,
  table: string,
  rows: readonly Record<string, unknown>[],
  behaviour: ConflictBehaviour,
  options: BulkOptions = {},
): BulkStatement {
  const columns = columnsOf(rows);
  if (columns.length === 0) {
    throw new UnsupportedBulkWrite("Every row is empty; there is nothing to insert.");
  }

  const bindings: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      // Serialized the same way a single save serializes: a Date has to become
      // the adapter's own timestamp format, and a boolean an integer, or the
      // driver refuses the binding outright.
      bindings.push(serialize(row[column] ?? null, connection));
      return connection.placeholder(bindings.length - 1);
    });

    return `(${placeholders.join(", ")})`;
  });

  const quoted = columns.map((column) => connection.quote(column)).join(", ");
  const head = `INSERT INTO ${connection.quote(table)} (${quoted}) VALUES ${tuples.join(", ")}`;

  if (behaviour === "raise") return { sql: head, bindings };

  const target = conflictTarget(options.uniqueBy);
  const updatable = (options.updateOnly ?? columns).filter(
    (column) => !target.includes(column) && columns.includes(column),
  );

  if (connection.adapter === "mysql") {
    if (behaviour === "skip") {
      // MySQL has no DO NOTHING. `INSERT IGNORE` is the equivalent, with the
      // caveat that it also swallows other recoverable errors — a truncated
      // value becomes a warning rather than a failure. Assigning a column to
      // itself is the narrower trick, and means only "on a duplicate key,
      // change nothing".
      const first = connection.quote(columns[0] as string);
      return { sql: `${head} ON DUPLICATE KEY UPDATE ${first} = ${first}`, bindings };
    }

    const assignments = updatable
      .map((column) => `${connection.quote(column)} = VALUES(${connection.quote(column)})`)
      .join(", ");

    return { sql: `${head} ON DUPLICATE KEY UPDATE ${assignments}`, bindings };
  }

  // Postgres and SQLite need the conflict target named. Without one, `DO
  // UPDATE` is a syntax error outright, and `DO NOTHING` widens to every
  // unique and exclusion constraint on the table — so a row colliding on an
  // index nobody was thinking about is skipped in silence rather than
  // reported. (A foreign key violation still raises: `ON CONFLICT` covers
  // conflicts, not every constraint.)
  if (behaviour === "update" && target.length === 0) {
    throw new UnsupportedBulkWrite(
      "upsertAll needs `uniqueBy` on this adapter: the conflict target has to be named.",
    );
  }

  const on = target.length > 0 ? ` (${target.map((c) => connection.quote(c)).join(", ")})` : "";

  if (behaviour === "skip") return { sql: `${head} ON CONFLICT${on} DO NOTHING`, bindings };

  if (updatable.length === 0) {
    throw new UnsupportedBulkWrite(
      "upsertAll has nothing to update: every column given is part of `uniqueBy`.",
    );
  }

  const assignments = updatable
    .map((column) => `${connection.quote(column)} = excluded.${connection.quote(column)}`)
    .join(", ");

  return { sql: `${head} ON CONFLICT${on} DO UPDATE SET ${assignments}`, bindings };
}

/** What the caller gets back. */
export interface BulkResult {
  /** How many rows were handed over, not how many landed. */
  attempted: number;
  /** The primary keys the database returned, where it returns them. */
  ids: unknown[];
}

export interface BulkContext {
  connection: Connection;
  table: string;
  primaryKey: string;
  /** Columns the table actually has, for the timestamp handling. */
  columnNames: () => Promise<string[]>;
}

function stamp(
  rows: readonly Record<string, unknown>[],
  present: string[],
  behaviour: ConflictBehaviour,
): Record<string, unknown>[] {
  const now = new Date();

  return rows.map((row) => {
    const stamped = { ...row };

    // `created_at` only on the way in. An upsert that overwrote it would make
    // every updated row look as though it had just been created.
    if (present.includes("created_at") && behaviour !== "update") stamped.created_at ??= now;
    if (present.includes("updated_at")) stamped.updated_at ??= now;

    return stamped;
  });
}

/**
 * Runs the batches.
 *
 * Every batch goes in one transaction, so a partial import is not a thing that
 * can happen: the point of the method is that ten thousand rows either arrive
 * or do not.
 */
export async function runBulk(
  context: BulkContext,
  rows: readonly Record<string, unknown>[],
  behaviour: ConflictBehaviour,
  options: BulkOptions = {},
): Promise<BulkResult> {
  if (rows.length === 0) return { attempted: 0, ids: [] };

  const { connection, table, primaryKey } = context;
  const size = options.batchSize ?? 1000;
  if (size < 1) throw new UnsupportedBulkWrite(`batchSize must be at least 1, got ${size}.`);

  const present = (options.recordTimestamps ?? true) ? await context.columnNames() : [];
  const prepared = stamp(rows, present, behaviour);

  const ids: unknown[] = [];

  await connection.transaction(async (scoped) => {
    for (let start = 0; start < prepared.length; start += size) {
      const batch = prepared.slice(start, start + size);
      const { sql, bindings } = bulkStatement(scoped, table, batch, behaviour, options);

      if (scoped.supportsReturning) {
        const returned = await scoped.query<Row>(
          `${sql} RETURNING ${scoped.quote(primaryKey)}`,
          bindings,
        );
        for (const row of returned) ids.push(row[primaryKey]);
      } else {
        await scoped.execute(sql, bindings);
      }
    }
  });

  return { attempted: prepared.length, ids };
}
