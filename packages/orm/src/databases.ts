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
import { Connection, adapterFor, setConnectionResolver } from "./connection.js";

/** Rails' roles. A reading role is a replica; everything else writes. */
export type Role = "writing" | "reading";

export interface DatabaseConfig {
  writing: string;
  /** Defaults to `writing`, so a single database needs no replica configured. */
  reading?: string;
  /**
   * The same schema on more than one server, split by some key.
   *
   * Rails calls this horizontal sharding. Nothing picks a shard for you: a
   * query has to say which one it means, because the framework cannot know
   * whether a record lives with its customer, its region, or its tenant.
   */
  shards?: Record<string, { writing: string; reading?: string }>;
}

export interface ConnectedTo {
  database?: string;
  role?: Role;
  /** Which shard, when the database has them. */
  shard?: string;
}

/** The shard used when none is named, as in Rails. */
export const DEFAULT_SHARD = "default";

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
/**
 * Which URL a name, role and shard resolve to.
 *
 * Extracted so `database` and `resolveDatabaseConfig` cannot disagree about
 * where a model is pointed. Two copies of "reading falls back to writing, and
 * the default shard is the database itself" is one copy too many: the answer
 * to "which database is this talking to" would then be produced by different
 * code from the connection that talks to it, and the two would drift on the
 * day somebody needs them not to.
 */
function resolveUrl(name: string, role: Role, shard: string): string {
  const config = configured.get(name);
  if (!config) {
    const known = [...configured.keys()];
    throw new Error(
      known.length > 0
        ? `No database named "${name}". Configured: ${known.join(", ")}.`
        : `No database named "${name}". Call configureDatabases() first.`,
    );
  }

  // The default shard is the database itself, so an application without
  // shards never notices they exist.
  let target: { writing: string; reading?: string } = config;

  if (shard !== DEFAULT_SHARD) {
    const found = config.shards?.[shard];
    if (!found) {
      const known = Object.keys(config.shards ?? {});
      throw new Error(
        known.length > 0
          ? `No shard named "${shard}" on "${name}". Shards: ${known.join(", ")}.`
          : `No shard named "${shard}" on "${name}", which has none configured.`,
      );
    }
    target = found;
  }

  return role === "reading" ? (target.reading ?? target.writing) : target.writing;
}

/**
 * A URL with its password removed.
 *
 * This is a diagnostic: it goes in a health endpoint, a log line, an error
 * page. All three are places a password must not be, and a value that is safe
 * only as long as nobody prints it is not safe.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z0-9+.-]+:\/\/[^:@/]+):[^@/]*@/i, "$1:***@");
}

/** Where a model's connection actually points. Rails' `db_config`. */
export interface ResolvedDatabaseConfig {
  /** The configured name, or `primary` for a connection opened directly. */
  name: string;
  role: Role;
  shard: string;
  /** What this connection speaks: `sqlite`, `postgres` or `mysql`. */
  adapter: string;
  /** The URL, with any password replaced. */
  url: string;
}

/**
 * What a name, role and shard resolve to, without opening a connection.
 *
 * The question this answers is the first one asked during an incident: with
 * replicas, shards and a `connectedTo` block somewhere up the stack, "which
 * database is this model reading from right now" has no other answer than
 * reading the code and hoping.
 */
export function resolveDatabaseConfig(
  name: string = PRIMARY,
  role: Role = "writing",
  shard: string = DEFAULT_SHARD,
): ResolvedDatabaseConfig {
  const url = resolveUrl(name, role, shard);

  return { name, role, shard, adapter: adapterFor(url), url: redactUrl(url) };
}

export function database(
  name: string = PRIMARY,
  role: Role = "writing",
  shard: string = DEFAULT_SHARD,
): Connection {
  const url = resolveUrl(name, role, shard);
  const key = `${name}/${shard}/${url}`;

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
      shard: options.shard ?? outer?.shard ?? DEFAULT_SHARD,
    },
    body,
  );
}

/** Runs a block against every shard of a database, in turn. */
export async function eachShard<T>(
  body: (shard: string) => Promise<T>,
  options: { database?: string } = {},
): Promise<T[]> {
  const name = options.database ?? PRIMARY;
  const results: T[] = [];

  for (const shard of shardNames(name)) {
    results.push(await connectedTo({ database: name, shard }, async () => await body(shard)));
  }

  return results;
}

/** Every shard a database has, the default one included. */
export function shardNames(name: string = PRIMARY): string[] {
  const config = configured.get(name);
  if (!config) return [];

  return [DEFAULT_SHARD, ...Object.keys(config.shards ?? {})];
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
  return database(active.database, active.role, active.shard);
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
 * Routes by HTTP method alone, which is enough when reads may be stale. A
 * replica lags, so the redirect after a create can render the page as it was
 * before — `selectDatabase` in `connection_scoping.ts` keeps a visitor on the
 * primary for a delay after their own write, which is what that costs.
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
