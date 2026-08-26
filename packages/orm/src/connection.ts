/**
 * The database connection.
 *
 * Rails needs 21,714 lines of connection adapters. `Bun.sql` ships PostgreSQL,
 * MySQL/MariaDB and SQLite in the runtime with one interface, pooling,
 * transactions and prepared statements, so what is left here is the part that
 * actually differs between databases: how identifiers are quoted, how
 * placeholders are numbered, and how an inserted row's id comes back.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import { notifications } from "@altair/support";
import { collectingCommitCallbacks } from "./after_commit.js";
import { cachingQuery, clearQueryCache } from "./query_cache.js";

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
    return await cachingQuery(sql, bindings, async () =>
      notifications.instrument("sql.altair", { sql, bindings }, async () => {
        const result = await this.#run(sql, bindings);
        return (Array.isArray(result) ? result : []) as T[];
      }),
    );
  }

  /** Runs a statement for its effect. */
  async execute(sql: string, bindings: readonly unknown[] = []): Promise<void> {
    // Every write empties the cache. A read after a write has to see the
    // write, and an entry that survived an INSERT would answer with the rows
    // from before it — worse than having no cache at all.
    clearQueryCache();

    await notifications.instrument("sql.altair", { sql, bindings }, async () => {
      await this.#run(sql, bindings);
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
    return await collectingCommitCallbacks(
      async () =>
        (await this.sql.begin(async (tx: SQL) => {
          const scoped = new Connection(this.url, tx);
          scoped.#inTransaction = true;

          // Everything the block reaches, not just the caller, has to run on the
          // transaction's connection. On SQLite the pool is one connection so it
          // happened anyway; on a pooled adapter the second model in a block would
          // quietly write outside the transaction, and its writes would survive a
          // rollback. The scope follows the async call chain, so concurrent
          // requests each see their own.
          return await inTransaction.run(scoped, async () => await body(scoped));
        })) as T,
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
    }

    await this.execute("BEGIN");
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
    }
  }

  /**
   * Settings a connection needs before its first statement.
   *
   * SQLite enforces foreign keys only when a connection asks it to, and the
   * default is off — a declared constraint that is never enforced is worse
   * than no constraint, because it reads as protection.
   */
  async #prepareSession(): Promise<void> {
    if (this.#prepared) return;
    this.#prepared = true;

    if (this.adapter === "sqlite") await this.sql.unsafe("PRAGMA foreign_keys = ON");
  }

  get isInTransaction(): boolean {
    return this.#inTransaction;
  }

  /**
   * The clause that makes an insert return the new row.
   *
   * PostgreSQL and SQLite support RETURNING; MySQL does not, and needs a
   * follow-up read instead.
   */
  get supportsReturning(): boolean {
    return this.adapter !== "mysql";
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
