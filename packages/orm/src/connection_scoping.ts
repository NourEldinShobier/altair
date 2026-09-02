/**
 * Which database is in force and who decided it, ported from
 * `ActiveRecord::Core.connected_to_stack`, `ActiveRecord::ConnectionHandling`
 * and `ActiveRecord::Middleware::DatabaseSelector`.
 *
 * `databases.ts` already runs a block against a role and shard, and holds that
 * choice in `AsyncLocalStorage` so one request cannot pull a concurrent one
 * onto a replica. Two things it does not have:
 *
 * - **The choice is one scope for everything.** Rails keeps a *stack* of
 *   entries, and each entry names the classes it applies to. That is what makes
 *   `connected_to_many(Dog, Cat, role: :reading)` mean those two models and not
 *   the whole application — an application mid-migration has one group of
 *   models on a new database and the rest where they were, and a single global
 *   scope cannot express that. It is also why `connecting_to` exists without a
 *   block: a middleware pushes at the start of a request and pops at the end,
 *   which is not a block shape.
 * - **Reads go to the replica immediately after a write.** `databaseSelector`
 *   routes by HTTP method, so a redirect after a create reads from a replica
 *   that has not caught up yet and renders the page as it was before. Nothing
 *   errors; the user simply does not see what they just did. Rails keeps that
 *   visitor on the primary for a delay after their own write, which is what the
 *   resolver here is for.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_SHARD, type Role } from "./databases.js";

// --- the stack -------------------------------------------------------------

/** The class every entry implicitly applies to — Rails' `ActiveRecord::Base`. */
export const BASE_CLASS = "Base";

export interface ConnectedToEntry {
  role?: Role;
  shard?: string;
  /**
   * Whether writes are refused under this entry.
   *
   * Its own field rather than "the role is reading", because the case worth
   * having is preventing writes on the *writer*: run that in production to find
   * which code paths would break under a read-only failover, before the
   * failover rather than during it.
   */
  preventWrites: boolean;
  /** The classes this entry applies to. */
  klasses: string[];
}

const stackStore = new AsyncLocalStorage<ConnectedToEntry[]>();
const processStack: ConnectedToEntry[] = [];

/**
 * Rails' `connected_to_stack`.
 *
 * The array is returned rather than copied — `connectingTo` has to push onto
 * the one the current request is reading.
 */
export function connectedToStack(): ConnectedToEntry[] {
  return stackStore.getStore() ?? processStack;
}

/**
 * A fresh stack for the duration of a body.
 *
 * A server establishes one per request. Without it every request shares the
 * process-level stack, and an entry one request pushed decides another
 * request's database — the exact confusion the stack exists to prevent.
 */
export async function withConnectionScope<T>(body: () => Promise<T> | T): Promise<T> {
  return await stackStore.run([], async () => await body());
}

export class ShardSwapProhibited extends Error {
  constructor() {
    super("cannot swap `shard` while shard swapping is prohibited.");
    this.name = "ShardSwapProhibited";
  }
}

export interface ConnectingToOptions {
  role?: Role;
  shard?: string;
  preventWrites?: boolean;
  klasses?: string[];
}

/**
 * Rails' `connecting_to` — push an entry and hand back the way to remove it.
 *
 * `prevent_writes` defaults to true under a reading role, and *cannot* be
 * turned off there: a write on a follower either fails somewhere far from its
 * cause or, on a writable follower, succeeds and is discarded at the next
 * replication event. Rails raises rather than allowing the combination, and so
 * does this.
 */
export function connectingTo(options: ConnectingToOptions = {}): () => void {
  const role = options.role;
  const preventWrites = options.preventWrites ?? role === "reading";

  if (role === "reading" && !preventWrites) {
    throw new TypeError("cannot set `preventWrites` to false when `role` is `reading`.");
  }

  const entry: ConnectedToEntry = {
    ...(role === undefined ? {} : { role }),
    ...(options.shard === undefined ? {} : { shard: options.shard }),
    preventWrites,
    klasses: options.klasses ?? [BASE_CLASS],
  };

  const stack = connectedToStack();
  stack.push(entry);

  // Removes this entry rather than the last one. A body that pushed its own
  // entry and failed to pop it would otherwise have that entry removed here and
  // its own left behind, which is worse than either mistake alone.
  return () => {
    const at = stack.lastIndexOf(entry);

    if (at !== -1) stack.splice(at, 1);
  };
}

function newest<T>(
  className: string,
  read: (entry: ConnectedToEntry) => T | undefined,
): T | undefined {
  const stack = connectedToStack();

  // Newest first: `connected_to` nests, and the inner block is the answer.
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (entry === undefined) continue;

    const applies = entry.klasses.includes(BASE_CLASS) || entry.klasses.includes(className);
    if (!applies) continue;

    const value = read(entry);
    if (value !== undefined) return value;
  }

  return undefined;
}

/** The role in force for one class, Rails' `current_role`. */
export function roleFor(className: string = BASE_CLASS): Role {
  return newest(className, (entry) => entry.role) ?? "writing";
}

/** The shard in force for one class, Rails' `current_shard`. */
export function shardFor(className: string = BASE_CLASS): string {
  return newest(className, (entry) => entry.shard) ?? DEFAULT_SHARD;
}

/**
 * Rails' `preventing_writes?` — by class name.
 *
 * By name because the caller is a connection pool, which is looked up by
 * descriptor and holds no class.
 */
export function preventingWrites(className: string = BASE_CLASS): boolean {
  return newest(className, (entry) => entry.preventWrites) ?? false;
}

/**
 * Rails' `connected_to_all_shards`.
 *
 * Every shard in turn rather than in parallel. Shard-wide work is usually a
 * migration or a backfill, and running those against every tenant at once turns
 * one slow query into an outage for all of them.
 */
export async function connectedToAllShards<T>(
  shards: readonly string[],
  body: (shard: string) => Promise<T> | T,
  options: { role?: Role; preventWrites?: boolean; klasses?: string[] } = {},
): Promise<T[]> {
  if (shards.length === 0) {
    throw new TypeError(
      "`connectedToAllShards` cannot be called on a model that is not connected to any shards.",
    );
  }

  const results: T[] = [];

  for (const shard of shards) {
    const done = connectingTo({ ...options, shard });

    try {
      results.push(await body(shard));
    } finally {
      done();
    }
  }

  return results;
}

// --- deciding per request --------------------------------------------------

/** The default in Rails: two seconds. */
export const SEND_TO_REPLICA_DELAY = 2000;

/**
 * Rails' `reading_request?`.
 *
 * The safe, idempotent methods: GET, HEAD, and QUERY (RFC 10008), which is a
 * read with a body. A POST is treated as a write even when it happens not to
 * write anything — guessing the other way sends a real write to a replica.
 */
export function readingRequest(request: { method: string }): boolean {
  const method = request.method.toUpperCase();

  return method === "GET" || method === "HEAD" || method === "QUERY";
}

/**
 * Where the last write is remembered. Rails' resolver context.
 *
 * Per visitor, not per process: the question is "has *this* visitor written
 * recently", and a process-wide answer would put every visitor on the primary
 * because somebody wrote, which is the replica doing no work at all.
 */
export interface WriteContext {
  lastWriteTimestamp: () => number;
  updateLastWriteTimestamp: () => void;
}

/**
 * Rails' `Resolver::Session` — the last write kept in the visitor's session.
 *
 * The session and not a cookie the client can edit: a visitor who could clear
 * it would be sent to a replica right after their own write, which is the bug
 * this exists to prevent.
 */
export function sessionContext(
  session: Record<string, unknown>,
  now: () => number = Date.now,
): WriteContext {
  return {
    lastWriteTimestamp: () => {
      const stored = session["lastWrite"];

      return typeof stored === "number" ? stored : 0;
    },
    updateLastWriteTimestamp: () => {
      session["lastWrite"] = now();
    },
  };
}

export interface ResolverOptions {
  delay?: number;
  now?: () => number;
}

/**
 * Rails' `DatabaseSelector::Resolver`.
 *
 * `read` goes to the replica only when the visitor's last write is further back
 * than the delay. Inside the window it reads from the *primary with writes
 * prevented* rather than simply from the primary: the request is still a read,
 * and letting it write would hide a bug that appears the moment the delay
 * elapses.
 */
export function databaseResolver(context: WriteContext, options: ResolverOptions = {}) {
  const delay = options.delay ?? SEND_TO_REPLICA_DELAY;
  const now = options.now ?? Date.now;

  const sendToReplica = (): boolean => now() - context.lastWriteTimestamp() >= delay;

  const scoped = async <T>(entry: ConnectingToOptions, body: () => Promise<T> | T): Promise<T> => {
    const done = connectingTo(entry);

    try {
      return await body();
    } finally {
      done();
    }
  };

  return {
    delay,
    sendToReplica,
    read: async <T>(body: () => Promise<T> | T): Promise<T> =>
      await scoped(
        sendToReplica()
          ? { role: "reading", preventWrites: true }
          : { role: "writing", preventWrites: true },
        body,
      ),
    write: async <T>(body: () => Promise<T> | T): Promise<T> =>
      await scoped({ role: "writing", preventWrites: false }, async () => {
        try {
          return await body();
        } finally {
          // In a `finally`: a write that raised may still have committed, and a
          // visitor whose failed request wrote something must not then be sent
          // to a replica that has not seen it.
          context.updateLastWriteTimestamp();
        }
      }),
  };
}

/**
 * The middleware, Rails' `DatabaseSelector#call`.
 *
 * Reads and writes are routed by method, and the resolver decides primary or
 * replica for the reads.
 */
export function selectDatabase<R extends { method: string }>(
  contextFor: (request: R) => WriteContext,
  options: ResolverOptions = {},
) {
  return async <T>(request: R, next: () => Promise<T> | T): Promise<T> => {
    const resolver = databaseResolver(contextFor(request), options);

    return await withConnectionScope(async () =>
      readingRequest(request) ? await resolver.read(next) : await resolver.write(next),
    );
  };
}
