/**
 * Keeping a connection pool healthy over days, ported from
 * `ActiveRecord::ConnectionAdapters::ConnectionPool` — the reaper, the
 * retirement policy, and the advisory locks migrations take.
 *
 * `connection-pool.ts` hands connections out and takes them back, which is all
 * a pool needs to do for the length of a test run. Over a week of uptime it is
 * not enough, and every function here exists for a failure that only appears
 * after the process has been up for a while:
 *
 * **Connections die while nobody is holding them.** A database restarts, a load
 * balancer times out an idle socket, a firewall drops a connection it has not
 * seen traffic on for an hour. The pool still has the handle and hands it to
 * the next request, which fails — and the request that fails is not the one
 * that did anything wrong.
 *
 * **Connections leak.** A request that throws between checkout and checkin
 * leaks one. That is invisible until the pool is empty, at which point every
 * request times out waiting and the cause is hours in the past.
 *
 * **Two servers migrate at once.** A deploy that starts three processes starts
 * three migrations, and two of them run the same `ALTER TABLE`. An advisory
 * lock is how one wins and the others wait.
 */

/** What the pool needs to know about a connection to manage it. */
export interface ManagedConnection {
  /** When it was opened. */
  createdAt: number;
  /** When it was last handed out or returned. */
  lastActivityAt: number;
  /** Whether the handle is still usable. */
  alive: boolean;
  /** Who holds it, if anyone. Rails calls this the owner thread. */
  owner?: string;
}

export interface RetirementPolicy {
  /** Close a connection older than this, however healthy. Rails' `max_age`. */
  maxAgeMs?: number;
  /** Close one that has been idle longer than this. Rails' `idle_timeout`. */
  idleTimeoutMs?: number;
  /** Re-check a connection not used for this long before handing it out. */
  verifyTimeoutMs?: number;
}

/** Rails' `connection_age` — how long a connection has been open. */
export function connectionAge(connection: ManagedConnection, now = Date.now()): number {
  return now - connection.createdAt;
}

/** Rails' `seconds_idle`. */
export function secondsIdle(connection: ManagedConnection, now = Date.now()): number {
  return (now - connection.lastActivityAt) / 1000;
}

/** Rails' `seconds_since_last_activity`. */
export function secondsSinceLastActivity(connection: ManagedConnection, now = Date.now()): number {
  return secondsIdle(connection, now);
}

/**
 * Whether a connection should be checked before use. Rails' `verify_timeout`.
 *
 * A connection idle longer than the window may have been closed by something
 * on the other end — a database restart, a load balancer, a firewall — without
 * anything telling this process. Verifying costs a round trip; not verifying
 * costs the *next request* an error it did not cause.
 */
export function needsVerification(
  connection: ManagedConnection,
  policy: RetirementPolicy,
  now = Date.now(),
): boolean {
  if (policy.verifyTimeoutMs === undefined) return false;

  return now - connection.lastActivityAt >= policy.verifyTimeoutMs;
}

/** Rails' `needs_reconnect?`. */
export function needsReconnect(connection: ManagedConnection): boolean {
  return !connection.alive;
}

/**
 * Whether a connection has outlived its welcome. Rails' `retire_old_connections`.
 *
 * Age *and* idleness, because they catch different things. A connection idle
 * for an hour is probably dead; a connection in constant use for a week is
 * alive but has accumulated whatever the server accumulates per session, and
 * on some deployments is pinned to a database node that is being drained.
 */
export function shouldRetire(
  connection: ManagedConnection,
  policy: RetirementPolicy,
  now = Date.now(),
): boolean {
  if (!connection.alive) return true;

  // Never a connection somebody is using. Closing it under its holder turns a
  // slow query into a lost one, which is worse than the leak this prevents.
  if (connection.owner !== undefined) return false;

  if (policy.maxAgeMs !== undefined && connectionAge(connection, now) >= policy.maxAgeMs) {
    return true;
  }

  return (
    policy.idleTimeoutMs !== undefined && now - connection.lastActivityAt >= policy.idleTimeoutMs
  );
}

/** Rails' `retire_old_connections` — which of a set to close. */
export function retireOldConnections<T extends ManagedConnection>(
  connections: readonly T[],
  policy: RetirementPolicy,
  now = Date.now(),
): { retire: T[]; keep: T[] } {
  const retire: T[] = [];
  const keep: T[] = [];

  for (const connection of connections) {
    (shouldRetire(connection, policy, now) ? retire : keep).push(connection);
  }

  return { retire, keep };
}

// --- who holds what --------------------------------------------------------

/**
 * The connections checked out right now, by holder. Rails'
 * `active_connections`.
 *
 * Keyed by holder rather than a plain count, because the useful question when
 * a pool is exhausted is *who has them* — a count says the pool is full and
 * nothing more, which is the least actionable form of that information.
 */
export class ConnectionLeases<T extends ManagedConnection> {
  readonly #held = new Map<string, T>();

  /** Rails' `lease`. */
  lease(owner: string, connection: T, now = Date.now()): T {
    const existing = this.#held.get(owner);

    if (existing && existing !== connection) throw new AlreadyLeased(owner);

    connection.owner = owner;
    connection.lastActivityAt = now;
    this.#held.set(owner, connection);

    return connection;
  }

  /** Rails' `active_connection?`. */
  activeConnection(owner: string): T | undefined {
    return this.#held.get(owner);
  }

  /** Rails' `active_connections`. */
  activeConnections(): T[] {
    return [...this.#held.values()];
  }

  get size(): number {
    return this.#held.size;
  }

  /** Rails' `release_connection`. */
  releaseConnection(owner: string, now = Date.now()): T | undefined {
    const held = this.#held.get(owner);

    if (!held) return undefined;

    held.owner = undefined;
    held.lastActivityAt = now;
    this.#held.delete(owner);

    return held;
  }

  /**
   * Rails' `clear_active_connections!`.
   *
   * What a web server calls between requests. A request that threw between
   * checkout and checkin leaked one, and without this sweep the pool is empty
   * some hours later with nothing to point at.
   */
  clearActiveConnections(now = Date.now()): T[] {
    const released = this.activeConnections();

    // Deleting the entry a Map iterator is currently on is defined behaviour,
    // so this does not need a copy of the keys first.
    for (const owner of this.#held.keys()) this.releaseConnection(owner, now);

    return released;
  }

  /** Rails' `steal!` — takes a connection from a holder that is gone. */
  steal(owner: string, now = Date.now()): T | undefined {
    return this.releaseConnection(owner, now);
  }
}

export class AlreadyLeased extends Error {
  constructor(owner: string) {
    super(
      `${owner} already holds a connection from this pool. Leasing a second one under the same ` +
        `owner loses the first: nothing would ever return it, and the pool shrinks by one for ` +
        `the life of the process.`,
    );
    this.name = "AlreadyLeased";
  }
}

/**
 * Runs a body with a connection, returning it whatever happens. Rails'
 * `with_connection`.
 *
 * The `finally` is the whole function. Every connection leak this file exists
 * to clean up after is a caller that returned early or threw.
 */
export async function withTemporaryConnection<T extends ManagedConnection, R>(
  leases: ConnectionLeases<T>,
  owner: string,
  connection: T,
  body: (connection: T) => Promise<R>,
): Promise<R> {
  const held = leases.activeConnection(owner);

  // Reentrant: a caller already holding one gets the same connection rather
  // than a second, so a transaction opened outside the body is still the one
  // the body runs in.
  if (held) return body(held);

  leases.lease(owner, connection);

  try {
    return await body(connection);
  } finally {
    leases.releaseConnection(owner);
  }
}

// --- retrying a connect ----------------------------------------------------

export interface RetryPolicy {
  /** Rails' `connection_retries`. */
  attempts: number;
  /** Rails' `retry_deadline` — stop retrying past this, however many are left. */
  deadlineMs?: number;
  baseDelayMs?: number;
  /** Rails' `max_jitter` as a fraction of the delay. */
  maxJitter?: number;
}

/**
 * How long to wait before attempt `n`. Rails' backoff in `with_raw_connection`.
 *
 * Jittered, and that is not a refinement. A database restart drops every
 * connection in every process at the same instant; without jitter they all
 * retry at the same instant too, and the first thing the database sees on
 * coming back is the same thundering herd that would knock it over again.
 */
export function retryDelay(
  attempt: number,
  { baseDelayMs = 100, maxJitter = 0.5 }: RetryPolicy = { attempts: 3 },
  random = Math.random,
): number {
  const backoff = baseDelayMs * 2 ** Math.max(0, attempt - 1);

  return Math.round(backoff * (1 + random() * maxJitter));
}

/** Whether another attempt is allowed. Rails' `retry_deadline` check. */
export function mayRetry(attempt: number, policy: RetryPolicy, elapsedMs: number): boolean {
  if (attempt >= policy.attempts) return false;

  return policy.deadlineMs === undefined || elapsedMs < policy.deadlineMs;
}

/**
 * Whether a failure is worth retrying. Rails' `translate_connect_error`.
 *
 * Only a connection failure. Retrying a constraint violation or a syntax error
 * re-runs work that will fail identically, and for a statement that got as far
 * as the server it can apply the *same write twice* — which is how a retry
 * turns one duplicate-key error into two rows.
 */
export function retryableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return [
    "econnrefused",
    "econnreset",
    "epipe",
    "etimedout",
    "connection refused",
    "connection reset",
    "server closed the connection",
    "lost connection",
    "gone away",
  ].some((signature) => message.includes(signature));
}

// --- advisory locks --------------------------------------------------------

export class AdvisoryLockUnavailable extends Error {
  constructor(name: string) {
    super(
      `Could not take the advisory lock "${name}": another process holds it. A deploy that ` +
        `starts several processes starts several migrations, and this is what stops two of ` +
        `them running the same ALTER TABLE.`,
    );
    this.name = "AdvisoryLockUnavailable";
  }
}

/**
 * A lock held across processes, keyed by name. Rails'
 * `get_advisory_lock`/`release_advisory_lock`.
 *
 * The in-process registry here is the seam an adapter fills with
 * `pg_try_advisory_lock` or `GET_LOCK`. It is honest about what it is: within
 * one process it is a real lock, and across processes it is only a lock once a
 * database backs it — which is the case that matters, and the one an adapter
 * must implement rather than inherit.
 */
export class AdvisoryLocks {
  readonly #held = new Set<string>();

  /** Rails' `get_advisory_lock` — returns false rather than waiting. */
  getAdvisoryLock(name: string): boolean {
    if (this.#held.has(name)) return false;

    this.#held.add(name);

    return true;
  }

  /** Rails' `release_advisory_lock`. */
  releaseAdvisoryLock(name: string): boolean {
    return this.#held.delete(name);
  }

  holds(name: string): boolean {
    return this.#held.has(name);
  }

  /**
   * Rails' `with_advisory_lock`.
   *
   * Released in a `finally`. A migration that throws while holding the lock
   * and does not release it blocks every later deploy until someone finds the
   * session and kills it by hand.
   */
  async withAdvisoryLock<T>(name: string, body: () => Promise<T>): Promise<T> {
    if (!this.getAdvisoryLock(name)) throw new AdvisoryLockUnavailable(name);

    try {
      return await body();
    } finally {
      this.releaseAdvisoryLock(name);
    }
  }
}

/**
 * A stable numeric key for a lock name. Rails' `lock_id` for the migration lock.
 *
 * Postgres advisory locks take integers, not strings, so the name has to hash
 * — and it has to hash the *same way in every process*, or two deploys take
 * two different locks and both proceed.
 */
export function advisoryLockId(name: string): number {
  let hash = 0;

  for (let index = 0; index < name.length; index += 1) {
    hash = (Math.imul(hash, 31) + name.charCodeAt(index)) | 0;
  }

  // Postgres' advisory lock space is signed 64-bit but the two-int form is
  // signed 32-bit; keeping it positive avoids the sign confusion entirely.
  return Math.abs(hash);
}

// --- what the pool reports -------------------------------------------------

export interface PoolLimits {
  /** Rails' `max_connections` / `pool:`. */
  max: number;
  /** How many to open before any request arrives. Rails' `min_threads`. */
  min?: number;
  /** How many callers may queue. Rails' `checkout_timeout` guards this. */
  maxQueue?: number;
}

/** Rails' `any_waiting?`. */
export function anyWaiting(waiting: number): boolean {
  return waiting > 0;
}

/**
 * Whether the pool may open a connection before it is asked for one. Rails'
 * `allow_preconnect`.
 *
 * Off during boot in a forking server: connections opened before the fork are
 * shared file descriptors afterwards, and two processes writing to one socket
 * corrupt each other's results in a way that reads as random query failures.
 */
export function allowPreconnect(forking: boolean, booted: boolean): boolean {
  return !forking || booted;
}

/** Rails' `flush` — connections that can be closed without disturbing anyone. */
export function flushable<T extends ManagedConnection>(
  connections: readonly T[],
  limits: PoolLimits,
): T[] {
  const idle = connections.filter((each) => each.owner === undefined);
  const keep = Math.max(0, limits.min ?? 0);

  // Oldest first, so what survives a flush is the set most recently proven to
  // work.
  return [...idle]
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
    .slice(0, Math.max(0, idle.length - keep));
}

/** Rails' `throw_away!` — a connection that must not go back in the pool. */
export function throwAway(connection: ManagedConnection): ManagedConnection {
  return { ...connection, alive: false, owner: undefined };
}
