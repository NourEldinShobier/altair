/**
 * Telling one kind of statement from another, ported from
 * `ActiveRecord::ConnectionAdapters::DatabaseStatements`' `write_query?`,
 * `Explain`, and the query-cache invalidation in `QueryCache`.
 *
 * Three things depend on knowing whether a statement writes, and all three are
 * wrong in the same direction when the answer is wrong:
 *
 * - **The query cache** has to be emptied by a write. A cache that survived one
 *   returns the pre-write rows to everything later in the request, so a record
 *   the request just created is not there when it looks.
 * - **A reading role** has to refuse one. A write sent to a replica either
 *   fails far from its cause or, on a writable follower, succeeds and is thrown
 *   away at the next replication event.
 * - **`EXPLAIN`** must not be run on one. `EXPLAIN INSERT` executes the insert
 *   on MySQL, so explaining a slow write in production would perform it a
 *   second time.
 *
 * So the classification errs toward "this writes". A read misclassified as a
 * write costs a cleared cache; a write misclassified as a read costs
 * correctness in all three places at once.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Statements that only read. Everything else is treated as a write. */
const READ_STATEMENTS = ["SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "PRAGMA"];

/**
 * Rails' `build_read_query_regexp`.
 *
 * An allowlist of leading keywords, not a denylist of writing ones. A denylist
 * cannot know about a keyword it has not heard of, and the failure of *not*
 * recognising a write is much worse than the failure of not recognising a
 * read.
 */
export function buildReadQueryRegexp(extra: readonly string[] = []): RegExp {
  const keywords = [...READ_STATEMENTS, ...extra].join("|");

  return new RegExp(`^\\s*(?:\\/\\*.*?\\*\\/\\s*)*(?:${keywords})\\b`, "i");
}

const READ_QUERY = buildReadQueryRegexp();

/**
 * Rails' `write_query?`.
 *
 * A leading comment is skipped before the keyword is read, because query
 * annotation puts one there — a leading `/*application:Foo*` comment — and a naive
 * check would call every annotated read a write and clear the cache on all of
 * them.
 *
 * A `WITH` is a read *unless* its body writes: Postgres allows
 * `WITH x AS (DELETE ...) SELECT ...`, which begins like a query and deletes
 * rows.
 */
export function writeQuery(sql: string): boolean {
  if (!READ_QUERY.test(sql)) return true;

  if (/^\s*(?:\/\*.*?\*\/\s*)*WITH\b/i.test(sql)) {
    return /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql);
  }

  return false;
}

/** Rails' `preventable_query?` — a write that a reading role must refuse. */
export function preventableQuery(sql: string): boolean {
  return writeQuery(sql);
}

/**
 * Whether a statement invalidates the query cache. Rails' `dirties_query_cache`.
 *
 * Any write, and any DDL. A migration that added a column while a cache held
 * the old column list would otherwise leave every later query building rows
 * from a schema that no longer exists.
 */
export function dirtiesQueryCache(sql: string): boolean {
  return writeQuery(sql);
}

/**
 * Whether a statement may be cached at all. Rails' `cacheable_query?`.
 *
 * Reads only, and not a read whose result cannot be replayed:
 * `SELECT nextval(...)` reads, and returns something different every time, so
 * caching it hands two records the same id.
 */
export function cacheableStatement(sql: string): boolean {
  if (writeQuery(sql)) return false;

  return !/\b(?:nextval|random|rand|uuid_generate|gen_random_uuid|now|current_timestamp)\s*\(/i.test(
    sql,
  );
}

// --- the cache itself -------------------------------------------------------

let cacheEnabled = false;

/**
 * Whether the current work is inside `uncached`.
 *
 * Scoped, because `uncached` is a block and a module-level counter made it one
 * request's decision for every request running beside it. Only performance is
 * at stake here — the wrong answer is a query that was not cached — but it is
 * the same shape as the two in `connection_switching.ts` that were not only
 * performance.
 */
const skipping = new AsyncLocalStorage<boolean>();

/** Rails' `enable_query_cache!`. */
export function enableQueryCache(): void {
  cacheEnabled = true;
}

/** Rails' `disable_query_cache!`. */
export function disableQueryCache(): void {
  cacheEnabled = false;
}

export function queryCacheEnabled(): boolean {
  return cacheEnabled && skipping.getStore() !== true;
}

/**
 * Rails' `uncached` — runs a body with the cache off.
 *
 * Scoped, so nesting works and there is nothing to restore: a body that throws
 * cannot leave the cache off for the rest of the request, which would turn one
 * error into a silent performance regression nobody connects to it.
 */
export async function uncached<T>(body: () => Promise<T> | T): Promise<T> {
  return await skipping.run(true, async () => await body());
}

/** Rails' `skip_query_cache!` for a single statement. */
export function skipQueryCache(sql: string): boolean {
  return !queryCacheEnabled() || !cacheableStatement(sql);
}

const entries = new Map<string, unknown>();

/** Rails' `clear_query_cache`. */
export function deleteAllEntries(): number {
  const count = entries.size;
  entries.clear();

  return count;
}

/** Rails' `clear_query_caches_for_current_thread`. */
export function clearQueryCachesForCurrentThread(): number {
  return deleteAllEntries();
}

export function cacheEntry(key: string, value: unknown): void {
  if (queryCacheEnabled()) entries.set(key, value);
}

export function cachedEntry(key: string): unknown {
  return queryCacheEnabled() ? entries.get(key) : undefined;
}

export function resetQueryCache(): void {
  entries.clear();
  cacheEnabled = false;
  // Nothing for `uncached` to reset: its scope ends when its body does.
}

// --- annotating a statement -------------------------------------------------

/**
 * Rails' `add_sql_comment`.
 *
 * The comment goes at the *end*. Leading comments are what a `write_query?`
 * check has to skip, and more importantly a leading comment breaks statement
 * matching in some proxies and poolers — which is exactly the software reading
 * these annotations.
 *
 * A comment terminator is stripped from the text, because a value containing one would end the
 * comment early and turn the rest of it into SQL.
 */
export function addSqlComment(sql: string, comment: string): string {
  const safe = comment.replaceAll("*/", "").trim();

  if (safe === "") return sql;

  return `${sql} /*${safe}*/`;
}

/** Rails' `unprepared_statement` — a statement that must not be prepared. */
export function unpreparedStatement(sql: string): boolean {
  // A statement built with values interpolated has a different text every time,
  // so preparing it fills the server's statement cache with entries used once.
  return !/[?$:]\d*/.test(sql) && writeQuery(sql);
}

// --- explain ----------------------------------------------------------------

export class CannotExplainWrite extends Error {
  constructor(sql: string) {
    super(
      `Refusing to EXPLAIN ${JSON.stringify(sql.slice(0, 60))}: it writes. On MySQL ` +
        `EXPLAIN executes an INSERT, so explaining a slow write would perform it a second time.`,
    );
    this.name = "CannotExplainWrite";
  }
}

/**
 * Rails' `build_explain_clause`.
 *
 * Refuses a write. `EXPLAIN INSERT` runs the insert on MySQL, so explaining a
 * slow statement in production would apply it twice — which is the situation
 * somebody is in when they reach for `explain` at all.
 */
export function buildExplainClause(
  sql: string,
  { analyze = false, adapter = "postgres" }: { analyze?: boolean; adapter?: string } = {},
): string {
  if (writeQuery(sql)) throw new CannotExplainWrite(sql);

  if (!analyze) return `EXPLAIN ${sql}`;

  // ANALYZE actually runs the statement, which is the point — and the reason
  // it is opt-in rather than the default.
  return adapter === "mysql" ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN (ANALYZE, BUFFERS) ${sql}`;
}

/**
 * Statements collected while a block runs, for one combined explain.
 *
 * The list is per-block, not per-process. Shared, it collected every
 * concurrent request's statements and handed them back as the queries this
 * block ran — an explain of somebody else's work, in an output whose whole
 * purpose is to say what *this* code did.
 */
const collecting = new AsyncLocalStorage<string[]>();

/** Rails' `collecting_queries_for_explain`. */
export async function collectingQueriesForExplain<T>(
  body: () => Promise<T> | T,
): Promise<{ result: T; queries: string[] }> {
  const collected: string[] = [];

  const result = await collecting.run(collected, async () => await body());

  return { result, queries: [...collected] };
}

/** Records a statement, if anything is collecting. */
export function recordForExplain(sql: string): void {
  // Reads only. A write cannot be explained, so collecting one would produce a
  // list whose entries cannot all be used.
  if (writeQuery(sql)) return;

  collecting.getStore()?.push(sql);
}

/** Rails' `exec_explain` — the explains for everything collected. */
export function execExplain(
  queries: readonly string[],
  options: { analyze?: boolean; adapter?: string } = {},
): string[] {
  return queries.map((sql) => buildExplainClause(sql, options));
}

// --- sequences ---------------------------------------------------------------

/** Rails' `default_sequence_name`. */
export function defaultSequenceName(table: string, primaryKey = "id"): string {
  return `${table}_${primaryKey}_seq`;
}

/** Rails' `serial_sequence`. */
export function serialSequence(table: string, column: string): string {
  return defaultSequenceName(table, column);
}

/** Rails' `reset_sequence_name`. */
export function resetSequenceName(table: string, primaryKey = "id"): string {
  return defaultSequenceName(table, primaryKey);
}

/**
 * Rails' `auto_incremented_by_db?`.
 *
 * Which decides whether the id has to be read back after an insert — and
 * getting it wrong one way leaves a new record with no id, the other way costs
 * every insert a returning clause it does not need.
 */
export function autoIncrementedByDb(column: {
  autoIncrement?: boolean;
  default?: unknown;
  sqlType?: string;
}): boolean {
  if (column.autoIncrement === true) return true;

  return typeof column.default === "string" && /nextval\(/i.test(column.default);
}

/** Rails' `high_precision_current_timestamp`. */
export function highPrecisionCurrentTimestamp(adapter: string): string {
  // MySQL truncates to whole seconds unless told otherwise, and a timestamp
  // rounded to a second makes two rows written in one request compare equal —
  // which breaks any ordering that relies on them.
  return adapter === "mysql" ? "CURRENT_TIMESTAMP(6)" : "CURRENT_TIMESTAMP";
}

/** Rails' `compatible_timestamp_type`. */
export function compatibleTimestampType(adapter: string, precision?: number): string {
  if (adapter === "mysql") return `datetime(${precision ?? 6})`;
  if (adapter === "postgres")
    return precision === undefined ? "timestamp" : `timestamp(${precision})`;

  return "datetime";
}
