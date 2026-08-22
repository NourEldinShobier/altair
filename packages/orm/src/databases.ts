/**
 * Multiple databases and roles, ported from `ActiveRecord::Base.connects_to`
 * and `connected_to`.
 *
 * Rails' version exists for one shape above all: a primary that takes writes
 * and a replica that takes reads. That is worth having only if it is safe, so
 * a write attempted while reading is refused rather than sent to a replica
 * that will reject it later, or worse, accept it.
 *
 *     configureDatabases({
 *       primary: { writing: process.env.DATABASE_URL!, reading: process.env.REPLICA_URL },
 *       analytics: process.env.ANALYTICS_URL!,
 *     })
 *
 *     await connectedTo({ role: "reading" }, async () => {
 *       await Post.all()
 *     })
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Connection, setConnectionResolver } from "./connection.js";

/** Rails' roles. A reading role is a replica; everything else writes. */
export type Role = "writing" | "reading";

export interface DatabaseConfig {
  writing: string;
  /** Defaults to `writing`, so a single database needs no replica configured. */
  reading?: string;
}

export interface ConnectedTo {
  database?: string;
  role?: Role;
}

/** Raised when a write is attempted while connected to a reading role. */
export class ReadOnlyError extends Error {
  constructor(operation: string) {
    super(`Cannot ${operation} while connected to a reading role.`);
    this.name = "ReadOnlyError";
  }
}

export const PRIMARY = "primary";

const configured = new Map<string, DatabaseConfig>();
const pools = new Map<string, Connection>();
const scope = new AsyncLocalStorage<Required<ConnectedTo>>();

/**
 * Declares the databases an application talks to.
 *
 * A bare string is the writing connection, which is what an application with
 * one database has.
 */
export function configureDatabases(config: Record<string, string | DatabaseConfig>): void {
  reset();

  for (const [name, entry] of Object.entries(config)) {
    configured.set(name, typeof entry === "string" ? { writing: entry } : entry);
  }
}

/** Closes every open pool and forgets the configuration. */
export async function disconnectDatabases(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  configured.clear();

  await Promise.all(open.map((connection) => connection.close()));
}

function reset(): void {
  // Pools are dropped rather than closed: closing is asynchronous and this is
  // called from configuration, which runs at boot before anything is open.
  pools.clear();
  configured.clear();
}

/**
 * The connection for a database and role, opened on first use.
 *
 * A role with no connection of its own falls back to the writing one, so an
 * application without a replica behaves exactly as it did before roles
 * existed.
 */
export function database(name: string = PRIMARY, role: Role = "writing"): Connection {
  const config = configured.get(name);
  if (!config) {
    const known = [...configured.keys()];
    throw new Error(
      known.length > 0
        ? `No database named "${name}". Configured: ${known.join(", ")}.`
        : `No database named "${name}". Call configureDatabases() first.`,
    );
  }

  const url = role === "reading" ? (config.reading ?? config.writing) : config.writing;
  const key = `${name}/${url}`;

  let pool = pools.get(key);
  if (!pool) {
    pool = new Connection(url);
    pools.set(key, pool);
  }

  return pool;
}

/**
 * Runs a block against a database and role. Rails' `connected_to`.
 *
 * The scope follows the async call chain, so a request reading from a replica
 * cannot pull a concurrent request onto it.
 */
export async function connectedTo<T>(options: ConnectedTo, body: () => Promise<T>): Promise<T> {
  const outer = scope.getStore();

  return await scope.run(
    {
      database: options.database ?? outer?.database ?? PRIMARY,
      role: options.role ?? outer?.role ?? "writing",
    },
    body,
  );
}

/** The database and role in force, if a block set one. */
export function currentScope(): Required<ConnectedTo> | undefined {
  return scope.getStore();
}

/** Whether writes are currently refused. */
export function isReadOnly(): boolean {
  return scope.getStore()?.role === "reading";
}

/** Refuses a write while a reading role is in force. */
export function checkWritable(operation: string): void {
  if (isReadOnly()) throw new ReadOnlyError(operation);
}

/** The connection a `connected_to` block selected, if any. */
export function scopedConnection(): Connection | undefined {
  const active = scope.getStore();
  if (!active) return undefined;
  return database(active.database, active.role);
}

/** Whether any database has been configured, for callers that can fall back. */
export function hasDatabases(): boolean {
  return configured.size > 0;
}

// A `connected_to` block wins; otherwise a configured primary is the default,
// so configuring databases is all an application has to do.
setConnectionResolver(() => scopedConnection() ?? (hasDatabases() ? database() : undefined));

/** What a middleware is handed to continue the chain. */
type Next = (request: Request) => Response | Promise<Response>;

export interface DatabaseSelectorOptions {
  /** Chooses a role per request. Defaults to reading for GET and HEAD. */
  role?: (request: Request) => Role;
  /** The database to select. Defaults to the primary. */
  database?: string;
}

/**
 * Sends read requests to a replica. Rails'
 * `ActiveRecord::Middleware::DatabaseSelector`.
 *
 * ponytail: routes by HTTP method alone. Rails also keeps a visitor on the
 * primary for a couple of seconds after their own write, because a replica
 * lags — without that, the redirect after a create can render the page as it
 * was before. Pass `role` to decide per request when that matters.
 */
export function databaseSelector(options: DatabaseSelectorOptions = {}) {
  const chooseRole =
    options.role ??
    ((request: Request): Role =>
      request.method === "GET" || request.method === "HEAD" ? "reading" : "writing");

  return async (request: Request, next: Next): Promise<Response> =>
    await connectedTo({ role: chooseRole(request), database: options.database }, async () =>
      next(request),
    );
}
