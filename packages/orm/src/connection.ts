/**
 * The database connection.
 *
 * Rails needs 21,714 lines of connection adapters. `Bun.sql` ships PostgreSQL,
 * MySQL/MariaDB and SQLite in the runtime with one interface, pooling,
 * transactions and prepared statements, so what is left here is the part that
 * actually differs between databases: how identifiers are quoted, how
 * placeholders are numbered, and how an inserted row's id comes back.
 */

import { Mutex, componentLogger, setComponentLogger, type Logger } from "@altair/support";
import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import { notifications } from "@altair/support";
import { collectingCommitCallbacks, runBeforeCommitCallbacks } from "./after-commit.js";
import { cachingQuery, clearQueryCache } from "./query-cache.js";
import { withQueryLog } from "./query-logs.js";

import {
  capabilitiesFor,
  maxIdentifierLength,
  nativeDatabaseTypes,
  type Capabilities,
} from "./capabilities.js";

export type Adapter = "sqlite" | "postgres" | "mysql";

/**
 * A connection held out of the pool for the life of a manual transaction.
 *
 * Bun types `reserve()` loosely, so the shape this code depends on is stated
 * here rather than asserted at every call.
 */
interface ReservedConnection {
  unsafe(sql: string, bindings?: unknown[]): Promise<unknown>;
  release?(): Promise<void> | void;
}

interface PoolWithReserve {
  reserve(): Promise<ReservedConnection>;
}

export type Row = Record<string, unknown>;

/** Detects the adapter from a connection URL, as Rails does from `adapter:`. */
export function adapterFor(url: string): Adapter {
  if (url.startsWith("sqlite:") || url === ":memory:") return "sqlite";
  if (url.startsWith("mysql:") || url.startsWith("mysql2:")) return "mysql";
  return "postgres";
}

/**
 * Rails' `DEFAULT_PRAGMAS`, in the order it applies them, plus the busy
 * timeout it takes from `timeout:` in `database.yml`.
 *
 * `mmap_size` is 128 MB and `journal_size_limit` 64 MB, as there. `cache_size`
 * is 2000 pages. `busy_timeout` is milliseconds, and 5000 is what the
 * generated `database.yml` says — the value nearly every Rails application
 * runs with without knowing it.
 */
const SQLITE_DEFAULT_PRAGMAS: readonly (readonly [string, string])[] = [
  ["foreign_keys", "ON"],
  ["journal_mode", "WAL"],
  ["synchronous", "NORMAL"],
  ["mmap_size", "134217728"],
  ["journal_size_limit", "67108864"],
  ["cache_size", "2000"],
  ["busy_timeout", "5000"],
];

/**
 * The pragmas a SQLite URL asks for: Rails' defaults, overridden by the
 * query string. `sqlite://app.db?journal_mode=delete` is Rails'
 * `pragmas: { journal_mode: :delete }`.
 *
 * A pragma is interpolated into a statement, so an override is accepted only
 * if it looks like a pragma value — a word, a number, a negative number.
 * Anything else in a URL is somebody's attempt to write SQL through it.
 */
export function sqlitePragmas(url: string): (readonly [string, string])[] {
  const query = url.includes("?") ? (url.split("?")[1] ?? "") : "";
  const overrides = new Map<string, string>();

  for (const [name, value] of new URLSearchParams(query)) {
    if (!/^[a-z_]+$/.test(name) || !/^-?[A-Za-z0-9_]+$/.test(value)) {
      throw new Error(
        `"${name}=${value}" in the SQLite URL is not a pragma this will pass through.`,
      );
    }

    overrides.set(name, value);
  }

  const merged = new Map<string, string>(SQLITE_DEFAULT_PRAGMAS);

  for (const [name, value] of overrides) merged.set(name, value);

  return [...merged];
}

/** PostgreSQL's complaint that a prepared statement outlived its table's shape. */
function isStalePlan(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("cached plan must not change result type")
  );
}

export class Connection {
  readonly adapter: Adapter;
  readonly url: string;
  readonly sql: SQL;

  #closed = false;
  #inTransaction = false;
  #savepoints = 0;
  #reserved: ReservedConnection | undefined;
  #prepared = false;
  /**
   * SQLite's one-writer-at-a-time, enforced here. Bun's `begin` does not
   * queue on the shared handle, so without this a second concurrent
   * transaction is "cannot start a transaction within a transaction". Held
   * for the whole of `transaction()`, and from `beginTransaction` to the
   * matching commit or rollback on the manual path.
   */
  readonly #writers = new Mutex();
  /** Releases the writer lock a manual `beginTransaction` took. */
  #releaseWriter: (() => void) | undefined;

  /**
   * The handle statements run on.
   *
   * A manual transaction reserves one connection out of the pool and runs
   * everything on it, because BEGIN on a pool pins nothing: the next statement
   * is free to land on a different connection, outside the transaction.
   */
  get #handle(): SQL {
    return (this.#reserved ?? this.sql) as SQL;
  }

  constructor(url: string, sql?: SQL) {
    this.url = url;
    this.adapter = adapterFor(url);
    this.sql = sql ?? new SQL(url);
  }

  /** Quotes a table or column name for this adapter. */
  quote(identifier: string): string {
    if (this.adapter === "mysql") return `\`${identifier.replaceAll("`", "``")}\``;
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  /**
   * The placeholder for the nth bind value, counting from zero.
   *
   * PostgreSQL numbers its placeholders; SQLite and MySQL do not.
   */
  placeholder(index: number): string {
    return this.adapter === "postgres" ? `$${index + 1}` : "?";
  }

  /**
   * Runs a statement built by the query builder and returns its rows.
   *
   * Every statement is reported on the instrumentation bus, which is how an
   * application sees its own slow queries without the ORM knowing what a log
   * is.
   */
  async query<T = Row>(sql: string, bindings: readonly unknown[] = []): Promise<T[]> {
    // The cache wraps the instrumentation rather than the other way round, so
    // a statement answered from memory reports nothing on the bus. A hit is
    // not a query, and counting it as one would make the request log say four
    // queries where the database saw one.
    // Tagged inside the cache rather than outside it: the cache is keyed on the
    // statement, and a comment naming the current action would make the same
    // query a different key on every request — a cache that never hits.
    //
    // One variable, used for both the driver and the notification, so what is
    // reported is what ran. Reporting the untagged statement would be a log
    // that disagrees with the database's own, and would leave nothing able to
    // observe whether the tag was applied at all.
    return await cachingQuery(sql, bindings, async () => {
      const tagged = withQueryLog(sql);

      return await notifications.instrument("sql.altair", { sql: tagged, bindings }, async () => {
        const result = await this.#run(tagged, bindings);
        return (Array.isArray(result) ? result : []) as T[];
      });
    });
  }

  /** Runs a statement for its effect. */
  async execute(sql: string, bindings: readonly unknown[] = []): Promise<void> {
    // Every write empties the cache. A read after a write has to see the
    // write, and an entry that survived an INSERT would answer with the rows
    // from before it — worse than having no cache at all.
    clearQueryCache();

    const tagged = withQueryLog(sql);

    await notifications.instrument("sql.altair", { sql: tagged, bindings }, async () => {
      await this.#run(tagged, bindings);
    });
  }

  /**
   * Sends a statement, retrying once if a cached plan went stale.
   *
   * PostgreSQL caches the plan for a prepared statement and refuses to run it
   * when the table's shape has changed underneath — which is what a migration
   * does to a process that is already serving. The retry re-prepares against
   * the new shape, which is what the PostgreSQL documentation recommends and
   * what saves an application from having to restart after every migration.
   */
  async #run(sql: string, bindings: readonly unknown[]): Promise<unknown> {
    await this.#prepareSession();

    try {
      return await this.#handle.unsafe(sql, bindings as unknown[]);
    } catch (error) {
      if (!isStalePlan(error)) throw error;
      return await this.#handle.unsafe(sql, bindings as unknown[]);
    }
  }

  /**
   * Runs a statement and reports how many rows it changed.
   *
   * Optimistic locking is built on this: an UPDATE guarded by a version that
   * matches nothing changes no rows, and that count is the only signal that
   * someone else saved first.
   */
  async executeCount(sql: string, bindings: readonly unknown[] = []): Promise<number> {
    clearQueryCache();

    return await notifications.instrument("sql.altair", { sql, bindings }, async () => {
      const result = await this.#run(sql, bindings);
      // Drivers disagree, and not only in naming: MySQL sets `count` to 0 and
      // reports the real number in `affectedRows`, so preferring one field
      // over another reads a legitimate update as having changed nothing.
      const reported = result as { count?: number; affectedRows?: number; rowsAffected?: number };
      return Math.max(
        Number(reported.count ?? 0),
        Number(reported.affectedRows ?? 0),
        Number(reported.rowsAffected ?? 0),
      );
    });
  }

  /**
   * Runs a block inside a transaction, rolling back if it throws.
   *
   * The callback receives a Connection bound to the transaction, so anything
   * it touches joins the same transaction rather than the pool.
   *
   * Nesting is a savepoint: an inner block that throws undoes only its own
   * work, and the outer transaction carries on. A database has no nested
   * BEGIN — Bun says as much — so without this a model method that opens a
   * transaction could not be called from another one.
   *
   * This is a deliberate divergence, and the comment here used to claim the
   * opposite. Rails *flattens* a nested block by default: the inner one joins
   * the outer, `requires_new: true` is what asks for a savepoint, and the
   * famous consequence is that `raise ActiveRecord::Rollback` inside a nested
   * block does nothing at all. Rails' own guides warn about it.
   *
   * A savepoint every time is the behaviour the surprising one is a footgun
   * against, so there is nothing to opt into and no `requiresNew` option.
   */
  async transaction<T>(body: (connection: Connection) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return await this.#withSavepoint(body);

    // Deferred work is collected around the whole transaction, not inside the
    // driver's block: `after_commit` has to run once the COMMIT has landed,
    // and the block returns before that.
    const run = async (tx: SQL): Promise<T> => {
      const scoped = new Connection(this.url, tx);
      scoped.#inTransaction = true;
      // The handle underneath is this connection's, already prepared. A fresh
      // object would run the session pragmas again on its first statement —
      // inside the transaction, where SQLite refuses to change `synchronous`.
      scoped.#prepared = true;

      // Everything the block reaches, not just the caller, has to run on the
      // transaction's connection. On SQLite the pool is one connection so it
      // happened anyway; on a pooled adapter the second model in a block would
      // quietly write outside the transaction, and its writes would survive a
      // rollback. The scope follows the async call chain, so concurrent
      // requests each see their own.
      return await inTransaction.run(scoped, async () => {
        const value = await body(scoped);

        // Inside the block, so a callback that throws leaves through
        // `begin` and the driver rolls back. Outside it, this would run
        // after the COMMIT and could only report a problem it was supposed
        // to prevent.
        await runBeforeCommitCallbacks();

        return value;
      });
    };

    // IMMEDIATE on SQLite, as Rails' `begin_db_transaction` does. A deferred
    // BEGIN takes a read snapshot and no lock; if another writer commits
    // before this transaction's first write, that write fails with a stale
    // snapshot and cannot be retried inside the transaction. IMMEDIATE takes
    // the write lock at BEGIN — waiting its turn under the busy timeout — so
    // the snapshot it reads is the one it writes against.
    //
    // And one at a time on SQLite. Bun's `begin` does not queue: a second
    // transaction opened on the shared handle while the first is open is
    // "cannot start a transaction within a transaction", not a wait. Rails
    // gets its queue from a pool of one connection that threads block on;
    // this is that queue. Sixty-four concurrent single-row writes went from
    // sixteen a second to the hundreds with this and the session pragmas.
    //
    // Not `sql.begin` on SQLite. Bun accepts a mode there and ignores it —
    // `begin("IMMEDIATE", fn)` opens a deferred transaction, which a probe
    // showed by letting another process take the write lock 41 ms into one.
    // The statements are sent by hand instead, on the one handle SQLite has,
    // which is what the manual `beginTransaction` path was already doing.
    const sqlite = async (): Promise<T> => {
      await this.execute("BEGIN IMMEDIATE");

      try {
        const value = await run(this.sql);

        await this.execute("COMMIT");

        return value;
      } catch (error) {
        await this.execute("ROLLBACK");
        throw error;
      }
    };

    return await collectingCommitCallbacks(
      async () =>
        (await (this.adapter === "sqlite"
          ? this.#writers.synchronize(sqlite)
          : this.sql.begin(run))) as T,
    );
  }

  async #withSavepoint<T>(body: (connection: Connection) => Promise<T>): Promise<T> {
    this.#savepoints += 1;
    const name = `altair_savepoint_${this.#savepoints}`;

    await this.execute(`SAVEPOINT ${name}`);
    try {
      const result = await body(this);
      await this.execute(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.execute(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  /**
   * Opens a transaction that outlives this call.
   *
   * `transaction()` covers everything an application needs, because a block
   * has an end. A test does not: the transaction has to open in one hook and
   * roll back in another, with the test body in between.
   */
  async beginTransaction(): Promise<void> {
    // SQLite hands out a single connection, so it is pinned already and has
    // nothing to reserve. Every pooled adapter does.
    if (this.adapter !== "sqlite") {
      this.#reserved = await (this.sql as unknown as PoolWithReserve).reserve();
    } else {
      // Take the writer lock and keep it until `#finishTransaction`. The lock
      // only knows `synchronize`, so the acquisition is a body that stays
      // open until the release it hands back is called.
      await new Promise<void>((acquired) => {
        void this.#writers.synchronize(
          () =>
            new Promise<void>((release) => {
              this.#releaseWriter = release;
              acquired();
            }),
        );
      });
    }

    // IMMEDIATE on SQLite, as Rails' `begin_db_transaction` does
    // (`internal_begin_transaction(:immediate)`). A deferred BEGIN takes no
    // lock until the first write, and SQLite cannot upgrade a read lock to a
    // write lock while another writer holds it — it answers `SQLITE_BUSY` at
    // once, and the busy timeout does not apply to that upgrade. IMMEDIATE
    // takes the write lock at BEGIN, where the timeout does apply, so a
    // second writer waits its turn instead of failing.
    await this.execute(this.adapter === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN");
    this.#inTransaction = true;
  }

  /** Discards everything since `beginTransaction`. */
  async rollbackTransaction(): Promise<void> {
    await this.#finishTransaction("ROLLBACK");
  }

  /** Keeps everything since `beginTransaction`. */
  async commitTransaction(): Promise<void> {
    await this.#finishTransaction("COMMIT");
  }

  /**
   * Opens a savepoint that outlives this call. Rails' `create_savepoint`.
   *
   * The same argument as `beginTransaction`: `transaction()` nests savepoints
   * for a block, and a block has an end. A test harness that wants a savepoint
   * per example opens it in one hook and rolls back in another, with the
   * example in between — and there is no block that spans those.
   *
   * The name is returned rather than remembered by the caller, so two
   * savepoints opened in the same scope cannot be released in the wrong order
   * by getting the name wrong.
   */
  async createSavepoint(name?: string): Promise<string> {
    this.#savepoints += 1;
    const chosen = name ?? `altair_savepoint_${String(this.#savepoints)}`;

    await this.execute(`SAVEPOINT ${this.quote(chosen)}`);

    return chosen;
  }

  /**
   * Keeps everything since a savepoint. Rails' `release_savepoint`.
   *
   * Releasing is not committing: the work stays inside the enclosing
   * transaction and is still undone if that rolls back. The name is what
   * catches people out — a release reads like a commit and is not one.
   */
  async releaseSavepoint(name: string): Promise<void> {
    await this.execute(`RELEASE SAVEPOINT ${this.quote(name)}`);
    this.#savepoints = Math.max(0, this.#savepoints - 1);
  }

  /** Discards everything since a savepoint. Rails' `rollback_to_savepoint`. */
  async rollbackToSavepoint(name: string): Promise<void> {
    await this.execute(`ROLLBACK TO SAVEPOINT ${this.quote(name)}`);
    this.#savepoints = Math.max(0, this.#savepoints - 1);
  }

  /**
   * How deep the nesting goes. Rails' `open_transactions`.
   *
   * One for the transaction and one per savepoint inside it, which is what a
   * caller needs to decide whether it is already inside one — the question
   * `isInTransaction` answers only as a boolean.
   */
  get openTransactions(): number {
    return (this.#inTransaction ? 1 : 0) + this.#savepoints;
  }

  /** The name the next savepoint would take. Rails' `current_savepoint_name`. */
  get currentSavepointName(): string {
    return `altair_savepoint_${String(this.#savepoints)}`;
  }

  /** Whether a transaction is open at all. Rails' `transaction_open?`. */
  get transactionOpen(): boolean {
    return this.#inTransaction;
  }

  async #finishTransaction(statement: string): Promise<void> {
    try {
      await this.execute(statement);
    } finally {
      // The connection goes back to the pool even if the statement failed;
      // holding it would leak one connection per failed transaction.
      this.#inTransaction = false;
      this.#savepoints = 0;

      const reserved = this.#reserved;
      this.#reserved = undefined;
      await reserved?.release?.();

      // The SQLite writer lock, whether the statement succeeded or not — a
      // failed COMMIT that kept the lock would stall every later transaction.
      const release = this.#releaseWriter;
      this.#releaseWriter = undefined;
      release?.();
    }
  }

  /**
   * Settings a connection needs before its first statement.
   *
   * For SQLite these are Rails' `DEFAULT_PRAGMAS` from
   * `activerecord/lib/active_record/connection_adapters/sqlite3_adapter.rb`,
   * applied the way its `configure_connection` applies them, plus the busy
   * timeout Rails takes from `timeout:` in `database.yml` — 5000 in the file
   * every new application is generated with.
   *
   * Only `foreign_keys` was set here before, and the other six are what make
   * SQLite usable under more than one writer at a time. Without a busy timeout
   * a second transaction gets `SQLITE_BUSY` at once rather than waiting; with
   * the default rollback journal and `synchronous=FULL`, every commit syncs
   * the disk twice. Measured: sixty-four concurrent single-row writes took
   * five to seven seconds *each* — sixteen a second, against four hundred for
   * Rails on the same file — and the whole difference was this method.
   *
   * Overridable through the URL, which is where the rest of this adapter's
   * configuration lives: `sqlite://app.db?busy_timeout=1000&journal_mode=delete`.
   * `:memory:` databases report `journal_mode = memory` whatever is asked, as
   * SQLite documents, and the setting is harmless there.
   */
  async #prepareSession(): Promise<void> {
    if (this.#prepared) return;
    this.#prepared = true;

    if (this.adapter !== "sqlite") return;

    for (const [pragma, value] of sqlitePragmas(this.url)) {
      await this.sql.unsafe(`PRAGMA ${pragma} = ${value}`);
    }
  }

  get isInTransaction(): boolean {
    return this.#inTransaction;
  }

  /**
   * What this database can do, asked by name.
   *
   * Rails asks `supports_check_constraints?` rather than which adapter it is,
   * and that is the point: the question survives the answer changing, and it
   * says what the caller actually wanted to know. The answers live in one
   * table in [capabilities.ts](./capabilities.ts).
   */
  get capabilities(): Capabilities {
    return capabilitiesFor(this.adapter);
  }

  /** The longest identifier this server accepts before it truncates. */
  get maxIdentifierLength(): number {
    return maxIdentifierLength(this.adapter);
  }

  /** The column types this adapter spells its own way. */
  get nativeDatabaseTypes(): Record<string, string> {
    return nativeDatabaseTypes(this.adapter);
  }

  /** Which database this is, under Rails' name for it. */
  get adapterName(): string {
    return this.adapter;
  }

  /** The clause that makes an insert return the new row. MySQL has none, and
   * needs a follow-up read instead. */
  get supportsReturning(): boolean {
    return this.capabilities.returning;
  }

  /** UPDATE ... RETURNING, which SQLite gained later than the INSERT form. */
  get supportsUpdateReturning(): boolean {
    return this.capabilities.updateReturning;
  }

  /** Nested transactions. */
  get supportsSavepoints(): boolean {
    return this.capabilities.savepoints;
  }

  /** Whether a failed migration rolls its DDL back rather than leaving the
   * table half-changed. */
  get supportsDdlTransactions(): boolean {
    return this.capabilities.ddlTransactions;
  }

  /** SET TRANSACTION ISOLATION LEVEL. */
  get supportsTransactionIsolation(): boolean {
    return this.capabilities.transactionIsolation;
  }

  /** Advisory locks, which is what keeps two processes from migrating at once. */
  get supportsAdvisoryLocks(): boolean {
    return this.capabilities.advisoryLocks;
  }

  /** CHECK constraints as named, droppable objects. */
  get supportsCheckConstraints(): boolean {
    return this.capabilities.checkConstraints;
  }

  /** UNIQUE as a named constraint rather than only a unique index. */
  get supportsUniqueConstraints(): boolean {
    return this.capabilities.uniqueConstraints;
  }

  /** EXCLUDE constraints. */
  get supportsExclusionConstraints(): boolean {
    return this.capabilities.exclusionConstraints;
  }

  /** DEFERRABLE INITIALLY DEFERRED. */
  get supportsDeferrableConstraints(): boolean {
    return this.capabilities.deferrableConstraints;
  }

  /** Foreign keys that are actually enforced. */
  get supportsForeignKeys(): boolean {
    return this.capabilities.foreignKeys;
  }

  /** VALIDATE CONSTRAINT, for adding a foreign key without a full-table lock. */
  get supportsValidateConstraints(): boolean {
    return this.capabilities.validateConstraints;
  }

  /** CREATE INDEX ... WHERE. */
  get supportsPartialIndex(): boolean {
    return this.capabilities.partialIndex;
  }

  /** An index on an expression rather than a bare column. */
  get supportsExpressionIndex(): boolean {
    return this.capabilities.expressionIndex;
  }

  /** ASC and DESC per column within one index. */
  get supportsIndexSortOrder(): boolean {
    return this.capabilities.indexSortOrder;
  }

  /** INCLUDE columns on an index. */
  get supportsIndexInclude(): boolean {
    return this.capabilities.indexInclude;
  }

  /** Indexes declared inside CREATE TABLE. */
  get supportsIndexesInCreate(): boolean {
    return this.capabilities.indexesInCreate;
  }

  /** NULLS NOT DISTINCT on a unique index. */
  get supportsNullsNotDistinct(): boolean {
    return this.capabilities.nullsNotDistinct;
  }

  /** Views. */
  get supportsViews(): boolean {
    return this.capabilities.views;
  }

  /** Materialized views. */
  get supportsMaterializedViews(): boolean {
    return this.capabilities.materializedViews;
  }

  /** COMMENT ON, for documenting the schema in the schema. */
  get supportsComments(): boolean {
    return this.capabilities.comments;
  }

  /** Comments inline in CREATE TABLE rather than as separate statements. */
  get supportsCommentsInCreate(): boolean {
    return this.capabilities.commentsInCreate;
  }

  /** WITH ... AS. */
  get supportsCommonTableExpressions(): boolean {
    return this.capabilities.commonTableExpressions;
  }

  /** A native JSON column type. */
  get supportsJson(): boolean {
    return this.capabilities.json;
  }

  /** Generated columns. */
  get supportsVirtualColumns(): boolean {
    return this.capabilities.virtualColumns;
  }

  /** GENERATED ... AS IDENTITY. */
  get supportsIdentityColumns(): boolean {
    return this.capabilities.identityColumns;
  }

  /** ON CONFLICT or ON DUPLICATE KEY, in whichever spelling. */
  get supportsInsertOnConflict(): boolean {
    return this.capabilities.insertOnConflict;
  }

  /** A named conflict target rather than only a bare any-conflict clause. */
  get supportsInsertConflictTarget(): boolean {
    return this.capabilities.insertConflictTarget;
  }

  /** Several ALTER TABLE changes in one statement. */
  get supportsBulkAlter(): boolean {
    return this.capabilities.bulkAlter;
  }

  /** Query planner hints. */
  get supportsOptimizerHints(): boolean {
    return this.capabilities.optimizerHints;
  }

  /** Server extensions, as PostgreSQL means the word. */
  get supportsExtensions(): boolean {
    return this.capabilities.extensions;
  }

  /** Foreign tables. */
  get supportsForeignTables(): boolean {
    return this.capabilities.foreignTables;
  }

  /** Native table partitioning. */
  get supportsNativePartitioning(): boolean {
    return this.capabilities.nativePartitioning;
  }

  /** Sub-second precision on datetime columns. */
  get supportsDatetimeWithPrecision(): boolean {
    return this.capabilities.datetimeWithPrecision;
  }

  /** EXPLAIN. */
  get supportsExplain(): boolean {
    return this.capabilities.explain;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const reserved = this.#reserved;
    this.#reserved = undefined;
    await reserved?.release?.();

    await this.sql.close?.();
  }
}

/**
 * The transaction a piece of work is running inside, if any.
 *
 * Rails hands each unit of work its own connection and puts the transaction on
 * that; `AsyncLocalStorage` is the same idea, following the async call chain
 * rather than a thread.
 */
const inTransaction = new AsyncLocalStorage<Connection>();

/**
 * The connection the models use when none is given.
 *
 * Rails keeps this on ActiveRecord::Base and hands it down the class hierarchy;
 * a single module-level connection is the same idea with less machinery.
 */
let current: Connection | undefined;

export function connect(url: string): Connection {
  current = new Connection(url);
  return current;
}

export function setConnection(connection: Connection | undefined): void {
  current = connection;
}

/**
 * How a configured set of databases makes itself known here.
 *
 * Registered rather than imported, so this file stays the bottom of the
 * dependency graph — multiple databases are built on connections, not the
 * other way around.
 */
let resolver: (() => Connection | undefined) | undefined;

export function setConnectionResolver(resolve: (() => Connection | undefined) | undefined): void {
  resolver = resolve;
}

export function connection(): Connection {
  // A transaction in progress wins, so a model reached from inside a
  // transaction block joins it rather than taking a fresh connection from the
  // pool and writing outside it.
  const scoped = inTransaction.getStore();
  if (scoped) return scoped;

  const selected = resolver?.();
  if (selected) return selected;

  if (!current) {
    throw new Error("No database connection. Call connect(url) before using models.");
  }
  return current;
}

/**
 * The logger this package writes through. Rails' `logger` on each base class.
 *
 * Its own rather than the shared one so an application can quieten the database
 * without quietening itself — which with a single logger means turning
 * everything down and then not being able to see its own lines either.
 */
export function defaultLogger(): Logger {
  return componentLogger("orm");
}

/** Gives this package a logger of its own. Undefined puts the shared one back. */
export function setDefaultLogger(logger: Logger | undefined): void {
  setComponentLogger("orm", logger);
}
