/**
 * Getting a connection and giving it back, ported from
 * `ActiveRecord::ConnectionAdapters::ConnectionPool` and the version-gated
 * capability checks in each adapter.
 *
 * `connection_pool.ts` owns the pool itself and `pool_lifecycle.ts` owns
 * retirement and verification. This is the part in between — who holds a
 * connection, for how long, and what that connection can actually do.
 *
 * Two things here are less mechanical than they look.
 *
 * **A lease has an owner, and the owner is not always the caller.** An
 * ordinary checkout belongs to the task that asked for it and goes back when
 * that task ends. A *pinned* connection belongs to something outside the
 * request — a test wrapping everything in a transaction, a manual transaction
 * spanning several statements — and must not be returned when the request that
 * happened to use it finishes. Returning it early is how a test's rollback
 * unwinds a transaction some other test is inside.
 *
 * **Some capabilities are facts about the server version, not the adapter.**
 * `capabilities.ts` answers the adapter-level question — what Postgres can do
 * — and that is the right answer for anything true of every version. The
 * predicates here are the ones where it is not: `RETURNING` is true on Postgres
 * always, on SQLite only from 3.35, and on MySQL never, so an application
 * trusting the adapter name alone gets a syntax error from whichever server in
 * the fleet has not been upgraded.
 *
 * A missing version is answered conservatively rather than optimistically:
 * refusing a feature the server has costs a slower path, and using one it
 * lacks costs an error in production.
 */

// --- versions --------------------------------------------------------------------------

export interface ServerVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Rails' `get_database_version` / `server_version` — parsed once.
 *
 * Compared as numbers rather than as a string: `"3.9"` sorts after `"3.35"`
 * lexically, so a string comparison decides that SQLite 3.35 is older than 3.9
 * and turns off exactly the features 3.35 added.
 */
export function serverVersion(reported: string): ServerVersion {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(reported);

  if (match === null) {
    throw new Error(
      `Could not read a version out of ${JSON.stringify(reported)}. Guessing would enable or ` +
        `disable features on a server nobody checked.`,
    );
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

/** Whether a version is at least another. */
export function atLeast(version: ServerVersion, major: number, minor = 0, patch = 0): boolean {
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;

  return version.patch >= patch;
}

const versions = new Map<string, ServerVersion>();

/**
 * Rails' `get_database_version` memoisation.
 *
 * Once per connection pool, not once per query: the version is a round trip,
 * and asking on every statement that wants a capability check would double the
 * query count of anything that inserts.
 */
export function getDatabaseVersion(poolKey: string, ask: () => string): ServerVersion {
  const held = versions.get(poolKey);

  if (held !== undefined) return held;

  const parsed = serverVersion(ask());
  versions.set(poolKey, parsed);

  return parsed;
}

export function resetDatabaseVersions(): void {
  versions.clear();
}

// --- what a server can do ------------------------------------------------------------------

export interface ServerCapabilities {
  adapter: string;
  version?: ServerVersion;
}

/**
 * Rails' `supports_insert_returning?`.
 *
 * Postgres always, SQLite from 3.35, MySQL never. With no version the answer
 * is no — refusing a feature the server has costs a slower path, and using one
 * it lacks costs a syntax error in production, on whichever server in the
 * fleet was not upgraded.
 */
export function supportsInsertReturning({ adapter, version }: ServerCapabilities): boolean {
  if (adapter === "postgres") return true;
  if (adapter !== "sqlite") return false;

  return version !== undefined && atLeast(version, 3, 35);
}

/** Rails' `supports_insert_on_duplicate_skip?` — `ON CONFLICT DO NOTHING`. */
export function supportsInsertOnDuplicateSkip({ adapter, version }: ServerCapabilities): boolean {
  if (adapter === "mysql") return true;
  if (adapter === "postgres") return version === undefined ? false : atLeast(version, 9, 5);

  return adapter === "sqlite" && version !== undefined && atLeast(version, 3, 24);
}

/** Rails' `supports_insert_on_duplicate_update?` — `ON CONFLICT DO UPDATE`. */
export function supportsInsertOnDuplicateUpdate(capabilities: ServerCapabilities): boolean {
  return supportsInsertOnDuplicateSkip(capabilities);
}

/** Rails' `supports_partitioned_indexes?` — Postgres 11 and up. */
export function supportsPartitionedIndexes({ adapter, version }: ServerCapabilities): boolean {
  return adapter === "postgres" && version !== undefined && atLeast(version, 11);
}

/**
 * Rails' `supports_disabling_indexes?`.
 *
 * MySQL only, and only from 8.0. Disabling an index elsewhere means dropping
 * it, and a bulk load that "disabled" indexes by dropping them leaves the
 * table without them if it fails partway — which is slower forever rather than
 * slower once.
 */
export function supportsDisablingIndexes({ adapter, version }: ServerCapabilities): boolean {
  return adapter === "mysql" && version !== undefined && atLeast(version, 8);
}

/**
 * Rails' `supports_enforced_foreign_keys?`.
 *
 * SQLite has foreign keys and does not enforce them unless asked, per
 * connection. A fixture load that assumes enforcement gets no error and a
 * table full of rows pointing at nothing.
 */
export function supportsEnforcedForeignKeys({ adapter }: ServerCapabilities): boolean {
  return adapter !== "sqlite";
}

/** Rails' `supports_concurrent_connections?` — SQLite serialises writers. */
export function supportsConcurrentConnections({ adapter }: ServerCapabilities): boolean {
  return adapter !== "sqlite";
}

/** Rails' `supports_close_prepared?` — releasing one statement, not all of them. */
export function supportsClosePrepared({ adapter }: ServerCapabilities): boolean {
  return adapter === "postgres";
}

/**
 * Rails' `support_sha1_for_non_deterministic_encryption?`.
 *
 * A compatibility switch, not a choice: SHA-1 is here only to read data
 * written by an older Rails. New data never uses it, so the flag is off unless
 * an application says it has old data — turning it on for new records would
 * mean writing with a digest nobody would choose today.
 */
export function supportSha1ForNonDeterministicEncryption(configured?: boolean): boolean {
  return configured === true;
}

/**
 * Rails' `client_min_messages` — how noisy Postgres is on a connection.
 *
 * `warning` rather than `notice`, because Postgres emits a notice for every
 * implicitly created index and sequence — so a migration that creates twenty
 * tables produces sixty lines nobody reads, which is how the one line that
 * mattered gets missed.
 */
export function clientMinMessages(configured?: string): string {
  return configured ?? "warning";
}

/** Rails' `type_aliases_for_version` — types a server version does not have. */
export function typeAliasesForVersion({
  adapter,
  version,
}: ServerCapabilities): Record<string, string> {
  if (adapter === "postgres" && version !== undefined && !atLeast(version, 13)) {
    // `gen_random_uuid()` moved into core in 13; before that it needs an
    // extension, so a schema using it loads on a new server and fails on an
    // old one with a message about a missing function.
    return { uuid: "uuid /* needs pgcrypto before 13 */" };
  }

  return {};
}

// --- leasing a connection ---------------------------------------------------------------

export interface Lease {
  connection: unknown;
  /** What holds it — a task id, a test, a manual transaction. */
  owner: string;
  /** A pinned lease is not returned when its request ends. */
  pinned: boolean;
}

export interface LeaseBook {
  leases: Map<string, Lease>;
  min: number;
  max: number;
}

export function newLeaseBook({ min = 0, max = 5 }: { min?: number; max?: number } = {}): LeaseBook {
  if (min > max) {
    throw new Error(
      `A pool cannot keep ${min} connections open with a ceiling of ${max}. The two are usually ` +
        `set in different places, and the version that "works" quietly ignores one of them.`,
    );
  }

  return { leases: new Map(), min, max };
}

export function minConnections(book: LeaseBook): number {
  return book.min;
}

export function maxConnections(book: LeaseBook): number {
  return book.max;
}

export class PoolExhausted extends Error {
  constructor(max: number, holders: readonly string[]) {
    super(
      `All ${max} connections are checked out. Held by: ${holders.join(", ")}. A pool this size ` +
        `is usually not the problem — something is holding a connection across an await it did ` +
        `not need to.`,
    );
    this.name = "PoolExhausted";
  }
}

/**
 * Rails' `lease_connection` — take one for this task.
 *
 * Names the holders when the pool is empty. "Could not obtain a connection" on
 * its own sends people to raise the pool size, which hides the actual cause —
 * something holding a connection across an await it did not need to.
 */
export function leaseConnection(book: LeaseBook, owner: string, connect: () => unknown): Lease {
  const held = book.leases.get(owner);

  if (held !== undefined) return held;

  if (book.leases.size >= book.max) {
    throw new PoolExhausted(book.max, [...book.leases.keys()]);
  }

  const lease: Lease = { connection: connect(), owner, pinned: false };
  book.leases.set(owner, lease);

  return lease;
}

/** Rails' `retrieve_connection` — the one this task already has, or nothing. */
export function retrieveConnection(book: LeaseBook, owner: string): Lease | undefined {
  return book.leases.get(owner);
}

/**
 * Rails' `pin_connection!` — hold this one past the end of the request.
 *
 * For a test wrapping everything in a transaction, and for a manual
 * transaction spanning several statements. A pinned connection returned early
 * is how a test's rollback unwinds a transaction another test is inside.
 */
export function pinConnection(book: LeaseBook, owner: string): Lease {
  const lease = book.leases.get(owner);

  if (lease === undefined) {
    throw new Error(
      `Nothing is holding a connection for ${JSON.stringify(owner)}, so there is none to pin. ` +
        `Pinning creates the expectation that a specific connection is kept, and creating a new ` +
        `one here would satisfy the call and not the expectation.`,
    );
  }

  lease.pinned = true;

  return lease;
}

/** Rails' `unpin_connection!`. */
export function unpinConnection(book: LeaseBook, owner: string): boolean {
  const lease = book.leases.get(owner);

  if (lease === undefined || !lease.pinned) return false;

  lease.pinned = false;

  return true;
}

/** Rails' `permanent_lease?` — a connection nothing will reclaim automatically. */
export function permanentLease(lease: Lease): boolean {
  return lease.pinned;
}

/**
 * Returns a connection unless it is pinned.
 *
 * Reports whether it actually released, because a caller that assumed it did
 * would go on to reuse the connection for something else — while a test still
 * holds a transaction open on it.
 */
export function releaseConnection(book: LeaseBook, owner: string): boolean {
  const lease = book.leases.get(owner);

  if (lease === undefined || lease.pinned) return false;

  book.leases.delete(owner);

  return true;
}

/**
 * Rails' `clear_all_connections!`.
 *
 * Pinned connections are left alone. This runs on reload and at the end of a
 * test run, and taking a pinned one would unwind a transaction its owner still
 * believes it is inside — which surfaces as data appearing in a later test.
 */
export function clearAllConnections(book: LeaseBook): { released: string[]; kept: string[] } {
  const released: string[] = [];
  const kept: string[] = [];

  for (const [owner, lease] of book.leases) {
    if (lease.pinned) {
      kept.push(owner);
      continue;
    }

    book.leases.delete(owner);
    released.push(owner);
  }

  return { released, kept };
}

/**
 * Rails' `clear_reloadable_connections!` — the same, for a code reload.
 *
 * Identical to clearing all, and named separately because Rails calls it at a
 * different moment for a different reason: this one runs while the application
 * is still serving, so a connection it releases is one a request may be about
 * to ask for again.
 */
export function clearReloadableConnections(book: LeaseBook): {
  released: string[];
  kept: string[];
} {
  return clearAllConnections(book);
}

/**
 * Rails' `preconnect` — open the minimum before serving.
 *
 * Otherwise the first requests after a deploy each pay for a connection
 * handshake, which is when a service is least able to afford it: everything
 * arrives at once and every one of them is slow.
 */
export function preconnect(book: LeaseBook, connect: () => unknown): number {
  let opened = 0;

  for (let index = book.leases.size; index < book.min; index += 1) {
    const owner = `preconnect-${index}`;
    book.leases.set(owner, { connection: connect(), owner, pinned: false });
    opened += 1;
  }

  return opened;
}

// --- errors ----------------------------------------------------------------------------------

/**
 * Rails' `translate_exception` for a failed connect.
 *
 * The driver's message is kept. Replacing it with a generic one loses the only
 * information there is — whether this was a bad password, a wrong host, or a
 * server that is not running — and those need three different responses.
 */
export function translateConnectError(
  error: Error,
  config: { host?: string; database?: string },
): Error {
  const where = [config.host, config.database].filter(Boolean).join("/");

  const translated = new Error(
    `Could not connect to ${where || "the database"}: ${error.message}`,
    { cause: error },
  );
  translated.name = "ConnectionNotEstablished";

  return translated;
}

/**
 * Rails' `connection_retries` — how many times a dropped connection is retried.
 *
 * Small and bounded. A connection failure is usually the server being
 * restarted or a network blip, both of which resolve in seconds — and retrying
 * many times turns one restart into a request that hangs for a minute and then
 * fails anyway.
 */
export function connectionRetries(configured?: number): number {
  if (configured === undefined) return 1;

  if (configured < 0) {
    throw new Error("A negative retry count is not fewer retries than zero; it is a typo.");
  }

  return Math.min(configured, 3);
}
