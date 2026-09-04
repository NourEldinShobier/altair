/**
 * The registry of pools: one per database, role and shard. Ported from
 * `ActiveRecord::ConnectionAdapters::ConnectionHandler`, `PoolConfig` and
 * `PoolManager`.
 *
 * `connection-pool.ts` is one pool. An application with a primary and a
 * replica, or with shards, has several, and something has to answer "which
 * pool does this model, in this role, on this shard, use" — for every query.
 *
 * Keeping them in a registry rather than in the models buys the operations
 * that only make sense over all of them at once:
 *
 *   - **Discarding after a fork.** A forked process inherits its parent's open
 *     sockets. Both processes then write to the same socket, and the server
 *     sees one interleaved conversation — which is not a connection error but
 *     a protocol corruption: a result set answering somebody else's query. The
 *     child has to throw the handles away without closing them, because
 *     closing them would close the parent's.
 *   - **Reaping.** An idle connection still occupies a slot on the database
 *     server, and a server has a global limit. One process holding twenty idle
 *     connections across four pools is twenty of somebody else's.
 *   - **Draining on shutdown.** Every pool, not the one the last query used.
 */

import type { Connection } from "./connection.js";
import { ConnectionPool } from "./connection-pool.js";
import type { PoolOptions } from "./connection-pool.js";

/** Which database, in which capacity, on which shard. */
export interface PoolKey {
  /** The database's name in the configuration — `primary`, `analytics`. */
  name: string;
  /** `writing` or `reading`. */
  role: string;
  shard: string;
}

export const DEFAULT_ROLE = "writing";
export const DEFAULT_SHARD_NAME = "default";

/** How one pool is built, and how big. Rails' `PoolConfig`. */
export interface PoolConfig extends PoolKey {
  build: () => Connection;
  /** How many connections at most. Rails' `pool`. */
  maxThreads?: number;
  /** How many to keep even when idle. */
  minThreads?: number;
  /** How often to look for connections to drop, in milliseconds. */
  reapingFrequency?: number;
  /** How long a caller waits for one, in milliseconds. */
  checkoutTimeout?: number;
  idleTimeout?: number;
}

/**
 * The three parts joined by a character no identifier can hold.
 *
 * Not a space or a slash: a database name is whatever the configuration file
 * says, and one containing the separator would make two different keys the
 * same string — `{name: "a b", role: "c"}` and `{name: "a", role: "b c"}`
 * would collide, and the second would silently get the first's pool.
 */
const KEY_SEPARATOR = "";

function keyOf(key: PoolKey): string {
  return [key.name, key.role, key.shard].join(KEY_SEPARATOR);
}

/** Fills in the defaults, so a caller can name only what it cares about. */
export function poolKey(
  name: string,
  role: string = DEFAULT_ROLE,
  shard: string = DEFAULT_SHARD_NAME,
): PoolKey {
  return { name, role, shard };
}

/** How many connections a config allows. Rails' `max_threads`. */
export function maxThreads(config: PoolConfig): number {
  return config.maxThreads ?? 5;
}

/** How many it keeps. Rails' `min_threads`. */
export function minThreads(config: PoolConfig): number {
  return Math.min(config.minThreads ?? 0, maxThreads(config));
}

/** How often it looks for connections to drop. Rails' `reaping_frequency`. */
export function reapingFrequency(config: PoolConfig): number {
  return config.reapingFrequency ?? 60_000;
}

/**
 * A random fraction of the reaping interval, so pools do not all reap at once.
 * Rails' jitter on the reaper.
 *
 * Without it every pool in every process wakes on the same tick, and a fleet
 * that all started together sends a synchronised burst of disconnects at the
 * database — a load spike with a period, which looks like a mystery until
 * somebody plots it.
 */
export function poolJitter(frequency: number): number {
  return Math.floor(Math.random() * frequency);
}

/**
 * Every pool an application has.
 *
 * One object rather than a module-level map, so a test can hold its own and a
 * multi-tenant process could in principle hold one per tenant.
 */
export class ConnectionHandler {
  #pools = new Map<string, ConnectionPool>();
  #configs = new Map<string, PoolConfig>();

  /** Records how a pool would be built, without building it. Rails' `set_pool_config`. */
  setPoolConfig(config: PoolConfig): void {
    this.#configs.set(keyOf(config), config);
  }

  getPoolConfig(key: PoolKey): PoolConfig | undefined {
    return this.#configs.get(keyOf(key));
  }

  removePoolConfig(key: PoolKey): boolean {
    return this.#configs.delete(keyOf(key));
  }

  poolConfigs(): PoolConfig[] {
    return Array.from(this.#configs.values());
  }

  *eachPoolConfig(): Generator<PoolConfig> {
    yield* this.#configs.values();
  }

  /**
   * Builds and records a pool. Rails' `establish_connection`.
   *
   * The pool is created here rather than on first use, so a misconfigured
   * database is a boot-time failure rather than a failure on whichever request
   * first touched that model.
   */
  registerPool(config: PoolConfig): ConnectionPool {
    this.setPoolConfig(config);

    const options: PoolOptions = {
      size: maxThreads(config),
      ...(config.checkoutTimeout === undefined ? {} : { checkoutTimeout: config.checkoutTimeout }),
      ...(config.idleTimeout === undefined ? {} : { idleTimeout: config.idleTimeout }),
    };

    const pool = new ConnectionPool(config.build, options);
    this.#pools.set(keyOf(config), pool);

    return pool;
  }

  /** Puts an already-built pool under a key, for a test or a wrapper. Rails' `set_pool`. */
  setPool(key: PoolKey, pool: ConnectionPool): void {
    this.#pools.set(keyOf(key), pool);
  }

  /**
   * The pool for a key, or nothing. Rails' `retrieve_connection_pool`.
   *
   * Nothing rather than built on demand, because the key that has no pool is
   * almost always a typo in a role or shard name, and building one would give
   * that typo its own empty database connection rather than an error.
   */
  retrieveConnectionPool(key: PoolKey): ConnectionPool | undefined {
    return this.#pools.get(keyOf(key));
  }

  /** The same, insisting. Rails' `connection_pool`. */
  connectionPool(key: PoolKey): ConnectionPool {
    const pool = this.retrieveConnectionPool(key);

    if (!pool) {
      throw new Error(
        `No connection pool for ${key.name} (role ${key.role}, shard ${key.shard}). ` +
          `Known: ${this.connectionPoolNames().join(", ") || "none"}.`,
      );
    }

    return pool;
  }

  /** Rails' `connection_pool_list`. */
  connectionPoolList(): ConnectionPool[] {
    return Array.from(this.#pools.values());
  }

  /** The keys, for an error message or a status page. */
  connectionPoolNames(): string[] {
    return Array.from(this.#pools.keys(), (key) => key.replaceAll(KEY_SEPARATOR, "/"));
  }

  *eachConnectionPool(): Generator<ConnectionPool> {
    yield* this.#pools.values();
  }

  /** Closes a pool's connections and forgets it. */
  async removeConnectionPool(key: PoolKey): Promise<boolean> {
    const pool = this.#pools.get(keyOf(key));

    if (!pool) return false;

    await pool.disconnect();
    this.#pools.delete(keyOf(key));

    return true;
  }

  /**
   * Throws a pool's connections away without closing them. Rails' `discard_pool!`.
   *
   * The difference from disconnecting is the whole point. After a fork the
   * child holds the parent's sockets; closing them closes the parent's too,
   * and then the parent's next query fails. Discarding drops the handles and
   * lets the operating system clean up the child's copy when it exits.
   */
  discardPool(key: PoolKey): boolean {
    return this.#pools.delete(keyOf(key));
  }

  /** The same for every pool — what a forked child does first. */
  discardPools(): number {
    const discarded = this.#pools.size;

    this.#pools.clear();

    return discarded;
  }

  /** Closes everything, for shutdown. */
  async disconnectAll(): Promise<void> {
    for (const pool of this.#pools.values()) await pool.disconnect();

    this.#pools.clear();
  }

  /**
   * Drops idle connections in every pool. Rails' `Reaper`.
   *
   * Across all pools rather than one, because the limit being protected is the
   * database server's, and it counts connections from every pool the same.
   */
  async reapAll(now = Date.now()): Promise<number> {
    let reaped = 0;

    for (const pool of this.#pools.values()) reaped += await pool.reap(now);

    return reaped;
  }

  /**
   * Takes a connection, uses it, gives it back. Rails' `checkout_and_verify`.
   *
   * Returned in a `finally`, because a pool that leaks one connection per
   * failed request runs out during the incident that is causing the failures —
   * turning a handled error into an outage.
   */
  async checkoutAndVerify<T>(
    key: PoolKey,
    body: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    return this.connectionPool(key).withConnection(body);
  }

  /**
   * Runs something against a pool put in place for the duration. Rails'
   * `with_temporary_pool`.
   *
   * For a migration or a task that has to reach a database the application
   * does not normally hold open. Restored in a `finally`, or a failing
   * migration leaves the process pointing at the wrong database.
   */
  async withTemporaryPool<T>(
    config: PoolConfig,
    body: (pool: ConnectionPool) => Promise<T>,
  ): Promise<T> {
    const previous = this.#pools.get(keyOf(config));
    const pool = this.registerPool(config);

    try {
      return await body(pool);
    } finally {
      await pool.disconnect();

      if (previous) this.#pools.set(keyOf(config), previous);
      else this.#pools.delete(keyOf(config));
    }
  }

  /** The same across several, for a task that has to touch every shard. */
  async withTemporaryPoolForEach<T>(
    configs: readonly PoolConfig[],
    body: (pool: ConnectionPool, config: PoolConfig) => Promise<T>,
  ): Promise<T[]> {
    const results: T[] = [];

    for (const config of configs) {
      results.push(await this.withTemporaryPool(config, (pool) => body(pool, config)));
    }

    return results;
  }
}

let handler = new ConnectionHandler();

export function connectionHandler(): ConnectionHandler {
  return handler;
}

export function resetConnectionHandler(): void {
  handler = new ConnectionHandler();
}
