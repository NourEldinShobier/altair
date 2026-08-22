/**
 * The database connection.
 *
 * Rails needs 21,714 lines of connection adapters. `Bun.sql` ships PostgreSQL,
 * MySQL/MariaDB and SQLite in the runtime with one interface, pooling,
 * transactions and prepared statements, so what is left here is the part that
 * actually differs between databases: how identifiers are quoted, how
 * placeholders are numbered, and how an inserted row's id comes back.
 */

import { SQL } from "bun";
import { notifications } from "@altair/support";

export type Adapter = "sqlite" | "postgres" | "mysql";

export type Row = Record<string, unknown>;

/** Detects the adapter from a connection URL, as Rails does from `adapter:`. */
export function adapterFor(url: string): Adapter {
  if (url.startsWith("sqlite:") || url === ":memory:") return "sqlite";
  if (url.startsWith("mysql:") || url.startsWith("mysql2:")) return "mysql";
  return "postgres";
}

export class Connection {
  readonly adapter: Adapter;
  readonly url: string;
  readonly sql: SQL;

  #closed = false;

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
    return await notifications.instrument("sql.altair", { sql, bindings }, async () => {
      const result = await this.sql.unsafe(sql, bindings as unknown[]);
      return (Array.isArray(result) ? result : []) as T[];
    });
  }

  /** Runs a statement for its effect. */
  async execute(sql: string, bindings: readonly unknown[] = []): Promise<void> {
    await notifications.instrument("sql.altair", { sql, bindings }, async () => {
      await this.sql.unsafe(sql, bindings as unknown[]);
    });
  }

  /**
   * Runs a block inside a transaction, rolling back if it throws.
   *
   * The callback receives a Connection bound to the transaction, so anything
   * it touches joins the same transaction rather than the pool.
   */
  async transaction<T>(body: (connection: Connection) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx: SQL) => {
      const scoped = new Connection(this.url, tx);
      return await body(scoped);
    })) as T;
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
    await this.sql.close?.();
  }
}

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

export function connection(): Connection {
  if (!current) {
    throw new Error("No database connection. Call connect(url) before using models.");
  }
  return current;
}
