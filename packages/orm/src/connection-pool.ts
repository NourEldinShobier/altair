/**
 * A bounded pool over reserved connections, ported from
 * `ActiveRecord::ConnectionAdapters::ConnectionPool`.
 *
 * What this is and is not, because the distinction matters: the driver keeps
 * its own sockets and this does not replace them. What it adds is the part an
 * application needs and the driver does not provide — a limit it chose, a
 * queue with a timeout rather than an unbounded wait, and numbers it can put
 * on a dashboard.
 *
 * Every figure reported here is one this pool tracked itself. None is guessed
 * at or read out of the driver, because a statistic that is invented is worse
 * than no statistic: somebody will size a deployment from it.
 *
 * The limit is the reason to have this at all. A process with no bound opens
 * connections until the database refuses, and a database at its connection
 * limit refuses *everyone* — including the queries already running and the
 * operator trying to log in and find out why.
 */

import type { Connection } from "./connection.js";

/** A connection handed out by the pool, and how to give it back. */
export interface PooledConnection {
  connection: Connection;
  /** Returns it to the pool. Safe to call twice; the second does nothing. */
  release(): void;
}

export interface PoolOptions {
  /** How many may be checked out at once. Rails' `pool`. */
  size?: number;
  /** How long a caller waits before giving up, in milliseconds. */
  checkoutTimeout?: number;
  /** How long an idle connection is kept before being dropped. */
  idleTimeout?: number;
}

/** What a pool is doing right now. Rails' `stat`. */
export interface PoolStat {
  size: number;
  busy: number;
  idle: number;
  waiting: number;
  checkoutTimeout: number;
}

/** Raised when a caller waited its whole timeout for a connection. */
export class ConnectionTimeoutError extends Error {
  constructor(
    readonly waitedMs: number,
    readonly size: number,
  ) {
    super(
      `Could not obtain a connection within ${String(waitedMs)}ms. ` +
        `All ${String(size)} are in use — either something is holding one too long, ` +
        `or the pool is smaller than the concurrency reaching it.`,
    );
    this.name = "ConnectionTimeoutError";
  }
}

interface Waiter {
  resolve: (connection: Connection) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Idle {
  connection: Connection;
  since: number;
}

export class ConnectionPool {
  readonly size: number;
  readonly checkoutTimeout: number;
  readonly idleTimeout: number;

  #busy = new Set<Connection>();
  #idle: Idle[] = [];
  #waiting: Waiter[] = [];

  constructor(
    private readonly build: () => Connection,
    options: PoolOptions = {},
  ) {
    this.size = options.size ?? 5;
    this.checkoutTimeout = options.checkoutTimeout ?? 5000;
    this.idleTimeout = options.idleTimeout ?? 300_000;
  }

  /**
   * Takes a connection, waiting if they are all busy. Rails' `checkout`.
   *
   * An idle one is preferred over a new one even when the pool is not full,
   * because a connection that has already run a statement has its session set
   * up — and on SQLite that means the foreign-key pragma, which a fresh one
   * would have to be told again.
   */
  async checkout(): Promise<Connection> {
    const idle = this.#idle.pop();

    if (idle) {
      this.#busy.add(idle.connection);
      return idle.connection;
    }

    if (this.#busy.size < this.size) {
      const connection = this.build();
      this.#busy.add(connection);

      return connection;
    }

    return await this.#wait();
  }

  #wait(): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // Removed from the queue before rejecting, or a connection returned
          // a moment later would be handed to a caller that has already given
          // up — and then never returned, because nobody is holding it.
          const at = this.#waiting.indexOf(waiter);
          if (at !== -1) this.#waiting.splice(at, 1);

          reject(new ConnectionTimeoutError(this.checkoutTimeout, this.size));
        }, this.checkoutTimeout),
      };

      this.#waiting.push(waiter);
    });
  }

  /**
   * Gives one back. Rails' `checkin`.
   *
   * A waiter is served directly rather than through the idle list, so a
   * connection freed under load goes straight to whoever is queued instead of
   * being parked and immediately taken again.
   */
  checkin(connection: Connection): void {
    if (!this.#busy.delete(connection)) return;

    const waiter = this.#waiting.shift();

    if (waiter) {
      clearTimeout(waiter.timer);
      this.#busy.add(connection);
      waiter.resolve(connection);

      return;
    }

    this.#idle.push({ connection, since: Date.now() });
  }

  /**
   * Runs the block with a connection and gives it back afterwards. Rails'
   * `with_connection`.
   *
   * The form to reach for. A checkout returned by hand is one a `throw` skips,
   * and a pool that loses a connection per error empties itself under exactly
   * the conditions that produce errors.
   */
  async withConnection<T>(body: (connection: Connection) => T | Promise<T>): Promise<T> {
    const connection = await this.checkout();

    try {
      return await body(connection);
    } finally {
      this.checkin(connection);
    }
  }

  /** How many are checked out. Rails' `active_connection_count`. */
  get activeConnectionCount(): number {
    return this.#busy.size;
  }

  /** How many are parked and available. */
  get idleCount(): number {
    return this.#idle.length;
  }

  /** How many callers are queued. Rails' `num_waiting_in_queue`. */
  get numWaiting(): number {
    return this.#waiting.length;
  }

  /** Every connection the pool holds, busy or idle. Rails' `connections`. */
  get connections(): Connection[] {
    return [...this.#busy, ...this.#idle.map((one) => one.connection)];
  }

  /**
   * What the pool is doing. Rails' `stat`.
   *
   * `waiting` is the number worth watching. Busy sitting at the size is
   * normal for a saturated process; waiting above zero means requests are
   * queueing for a connection, which is the point at which the pool — not the
   * database — is the bottleneck.
   */
  stat(): PoolStat {
    return {
      size: this.size,
      busy: this.#busy.size,
      idle: this.#idle.length,
      waiting: this.#waiting.length,
      checkoutTimeout: this.checkoutTimeout,
    };
  }

  /**
   * Drops connections idle for longer than the timeout. Rails' `reap`.
   *
   * Returns how many went. An idle connection is not free: the database holds
   * a backend process for it, and a fleet that scaled up at noon is still
   * holding its connections at midnight unless something lets them go.
   */
  async reap(now = Date.now()): Promise<number> {
    const stale = this.#idle.filter((one) => now - one.since >= this.idleTimeout);

    this.#idle = this.#idle.filter((one) => now - one.since < this.idleTimeout);

    for (const one of stale) await one.connection.close().catch(() => undefined);

    return stale.length;
  }

  /** Drops every idle connection whatever its age. Rails' `flush`. */
  async flushIdleConnections(): Promise<number> {
    const dropped = this.#idle;
    this.#idle = [];

    for (const one of dropped) await one.connection.close().catch(() => undefined);

    return dropped.length;
  }

  /**
   * Closes everything and refuses the queue. Rails' `disconnect!`.
   *
   * Waiters are rejected rather than left hanging: a shutdown that resolved
   * nothing would keep the process alive on promises that can never settle,
   * which is how a graceful stop becomes a `kill -9`.
   */
  async disconnect(): Promise<void> {
    for (const waiter of this.#waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("The connection pool was shut down while this request waited."));
    }

    const all = this.connections;

    this.#busy.clear();
    this.#idle = [];

    for (const connection of all) await connection.close().catch(() => undefined);
  }
}
