/**
 * The parts of connection switching that `databases.ts` does not already own,
 * ported from `ActiveRecord::ConnectionHandling`.
 *
 * `databases.ts` has `connectedTo`, `currentScope` and `checkWritable`, and it
 * holds the scope in `AsyncLocalStorage` — which is the right mechanism and not
 * a detail: a module-level variable would let one request's `connected_to`
 * block move a *concurrent* request onto a replica, which is the failure this
 * whole area exists to avoid. Nothing here re-implements that.
 *
 * What is added is the layer above it:
 *
 * - **Preventing writes as its own state.** `databases.ts` refuses writes when
 *   the role is `reading`, which covers the common case. It does not cover
 *   `while_preventing_writes` on the *writer* — the thing an application runs
 *   in production to find out which code paths would break under a read-only
 *   failover, before the failover rather than during it.
 * - **Prohibiting shard swaps.** A shard is usually a tenant, so code that
 *   swaps mid-request is code that can hand one tenant another's rows. Rails
 *   lets an application forbid it outright.
 * - **The descriptor**, which is the key a pool is found by, and has to name
 *   all three of class, role and shard.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_SHARD, type Role, connectedTo, currentScope, isReadOnly } from "./databases.js";

export const READING_ROLE: Role = "reading";
export const WRITING_ROLE: Role = "writing";

/** Rails' `current_role`. */
export function currentRole(): Role {
  return currentScope()?.role ?? WRITING_ROLE;
}

/** Rails' `current_shard`. */
export function currentShard(): string {
  return currentScope()?.shard ?? DEFAULT_SHARD;
}

/** Rails' `connection_class_for_self` — the database a scope named. */
export function connectionClassForSelf(): string | undefined {
  return currentScope()?.database;
}

/**
 * The key a pool is found by. Rails' `connection_descriptor`.
 *
 * All three parts. One missing the role sends a write to a replica; one
 * missing the shard sends a query for one tenant to another tenant's database.
 */
export function connectionDescriptor({
  database = connectionClassForSelf() ?? "primary",
  role = currentRole(),
  shard = currentShard(),
}: { database?: string; role?: Role; shard?: string } = {}): string {
  return `${database}/${role}/${shard}`;
}

// --- preventing writes on a writer -----------------------------------------

/**
 * Whether the current work is inside `whilePreventingWrites`.
 *
 * In `AsyncLocalStorage` for the reason this file's header gives about
 * `connected_to`, and it applies here word for word: a module-level counter
 * let one request's block prevent writes in a *concurrent* request, which
 * failed with `PreventedWrite` on a write that was never in question. The
 * argument was written down two functions above the variable that ignored it.
 *
 * A flag, where the counter it replaces needed a depth. Leaving a scope
 * restores whatever surrounded it, so an inner block that finishes cannot
 * lift an outer one and nothing has to be decremented — which also means a
 * body that throws cannot leave the process refusing writes.
 */
const preventing = new AsyncLocalStorage<boolean>();

/**
 * Rails' `current_preventing_writes`.
 *
 * True under a reading role — which `databases.ts` already decides — *or*
 * inside an explicit `whilePreventingWrites` block.
 */
export function currentPreventingWrites(): boolean {
  return (preventing.getStore() ?? false) || isReadOnly();
}

/**
 * Rails' `while_preventing_writes`.
 *
 * The point is running it against the *writer*, in production, to find which
 * code paths would break under a read-only failover — before the failover
 * rather than during it. A block that only worked by pointing at a replica
 * could not answer that, because the replica has different data and different
 * latency.
 *
 * Nesting works without counting: the scope an inner block opens is unwound
 * when it ends, and what it unwinds to is the outer block's.
 */
export async function whilePreventingWrites<T>(
  prevent: boolean,
  body: () => Promise<T> | T,
): Promise<T> {
  if (!prevent) return body();

  return await preventing.run(true, async () => await body());
}

export class PreventedWrite extends Error {
  constructor(operation: string) {
    super(
      `Cannot ${operation}: writes are prevented here. A write that reaches a follower either ` +
        `fails somewhere far from its cause or, on a writable follower, succeeds and is thrown ` +
        `away at the next replication event.`,
    );
    this.name = "PreventedWrite";
  }
}

/** Rails' `check_write` — enforced, which is what makes replica reads safe. */
export function checkWriteAllowed(operation: string): void {
  if (currentPreventingWrites()) throw new PreventedWrite(operation);
}

// --- shards ----------------------------------------------------------------

/** The same, for shard swapping, and scoped for the same reason. */
const prohibited = new AsyncLocalStorage<boolean>();

export class ShardSwappingProhibited extends Error {
  constructor(from: string, to: string) {
    super(
      `Refusing to swap from shard ${JSON.stringify(from)} to ${JSON.stringify(to)}: shard ` +
        `swapping is prohibited here. A shard is usually a tenant, and code that swaps ` +
        `mid-request is code that can hand one tenant another's rows.`,
    );
    this.name = "ShardSwappingProhibited";
  }
}

/** Rails' `shard_swapping_prohibited?`. */
export function shardSwappingProhibited(): boolean {
  return prohibited.getStore() ?? false;
}

/** Rails' `prohibit_shard_swapping`. */
export async function prohibitShardSwapping<T>(
  prohibit: boolean,
  body: () => Promise<T> | T,
): Promise<T> {
  if (!prohibit) return body();

  return await prohibited.run(true, async () => await body());
}

/** Refuses a swap where one is prohibited. */
export function checkShardSwap(to: string): void {
  const from = currentShard();

  if (to !== from && shardSwappingProhibited()) throw new ShardSwappingProhibited(from, to);
}

/**
 * Rails' `connected_to` for a shard, with the prohibition honoured.
 *
 * A thin wrapper rather than a second implementation: `databases.ts` still
 * opens the scope, this only refuses first.
 */
export async function switchShard<T>(shard: string, body: () => Promise<T>): Promise<T> {
  checkShardSwap(shard);

  return connectedTo({ shard }, body);
}

/**
 * Rails' `connected_to_many` — one scope covering several databases.
 *
 * Sequential rather than concurrent. The bodies usually write, and running a
 * migration or a backfill against every database at once multiplies its load
 * on what may be one server behind several logical databases.
 */
export async function connectedToMany<T>(
  databases: readonly string[],
  options: { role?: Role; shard?: string },
  body: (database: string) => Promise<T>,
): Promise<T[]> {
  if (databases.length === 0) {
    throw new Error("connectedToMany needs at least one database to connect to.");
  }

  const results: T[] = [];

  for (const database of databases) {
    results.push(await connectedTo({ ...options, database }, () => body(database)));
  }

  return results;
}

/**
 * Rails' `with_a_bias_for` — prefer a shard, but do not require it.
 *
 * For a read that *may* go anywhere: a bias picks a replica without failing
 * when that one is out of rotation, which is the difference between a
 * preference and a requirement.
 */
export function withABiasFor(shard: string, available: readonly string[]): string {
  return available.includes(shard) ? shard : (available[0] ?? DEFAULT_SHARD);
}

/**
 * Nothing to clear, kept because callers ask.
 *
 * Both depths live in `AsyncLocalStorage` now, and a scope ends when its body
 * does — including when the body throws. A test that ran a block and then
 * reset was working around the leak this used to have; there is no state left
 * to escape a block, and none for a worker to inherit from the last job.
 */
export function resetSwitchingState(): void {
  // Deliberately empty.
}
